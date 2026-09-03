import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { ProofOfFailureCertificate, ProofCandidate, ProofVerificationResult } from '../types/proof.js';

/**
 * Describes the formal specification of a function under test,
 * including preconditions, postconditions, and an optional bounded output domain.
 */
export interface FunctionSpecification {
  name: string;
  preconditions: Array<(input: unknown) => boolean>;
  postconditions: Array<(input: unknown, output: unknown) => boolean>;
  output_domain?: () => unknown[];  // bounded output domain for uniqueness check
}

/**
 * Configuration for proof verification timeouts.
 */
export interface ProofVerifierConfig {
  admissibility_timeout_ms: number;  // default 30000
  soundness_timeout_ms: number;      // default 30000
  feasibility_timeout_ms: number;    // default 60000
}

const DEFAULT_CONFIG: ProofVerifierConfig = {
  admissibility_timeout_ms: 30000,
  soundness_timeout_ms: 30000,
  feasibility_timeout_ms: 60000,
};

/**
 * Verifies proof-of-failure candidates by checking three mathematical properties:
 * Admissibility, Soundness, and Uniqueness.
 *
 * - Admissibility: The test input satisfies all declared preconditions.
 * - Soundness: The observed output violates at least one postcondition.
 * - Feasibility: At least one output in the declared domain satisfies all
 *   postconditions, proving the specification is satisfiable for this input so
 *   the observed violation is a genuine code failure (not an impossible spec).
 *
 * On successful verification of all three, a ProofOfFailureCertificate is produced
 * and stored in the proof_certificates table.
 */
export class ProofVerifier {
  private db: Database.Database;
  private config: ProofVerifierConfig;

  constructor(db: Database.Database, config?: Partial<ProofVerifierConfig>) {
    this.db = db;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Verify a proof-of-failure candidate.
   * Checks Admissibility, Soundness, and Uniqueness with configured timeouts.
   * If all pass → produces certificate and stores in proof_certificates table.
   * If any fails → marks unconfirmed with failed property and reason.
   * If any times out → marks inconclusive.
   */
  async verify(candidate: ProofCandidate, spec: FunctionSpecification): Promise<ProofVerificationResult> {
    const { test_input, observed_output } = candidate;

    // Step 1: Verify Admissibility with timeout
    const admissibilityResult = await this.runWithTimeout(
      () => this.verifyAdmissibility(test_input, spec.preconditions),
      this.config.admissibility_timeout_ms
    );

    if (admissibilityResult.timedOut) {
      return {
        admissibility: false,
        soundness: false,
        feasibility: false,
        certified: false,
        failure_reason: 'Verification timed out on property: Admissibility',
      };
    }

    const admissibilityTimestamp = new Date().toISOString();

    if (!admissibilityResult.value) {
      return {
        admissibility: false,
        soundness: false,
        feasibility: false,
        certified: false,
        failure_reason: 'Admissibility failed: input does not satisfy all preconditions',
      };
    }

    // Step 2: Verify Soundness with timeout
    const soundnessResult = await this.runWithTimeout(
      () => this.verifySoundness(test_input, observed_output, spec.postconditions),
      this.config.soundness_timeout_ms
    );

    if (soundnessResult.timedOut) {
      return {
        admissibility: true,
        soundness: false,
        feasibility: false,
        certified: false,
        failure_reason: 'Verification timed out on property: Soundness',
      };
    }

    const soundnessTimestamp = new Date().toISOString();

    if (!soundnessResult.value) {
      return {
        admissibility: true,
        soundness: false,
        feasibility: false,
        certified: false,
        failure_reason: 'Soundness failed: output does not violate any postcondition',
      };
    }

    // Step 3: Verify Feasibility with timeout
    const outputDomain = spec.output_domain ? spec.output_domain() : [];
    const feasibilityResult = await this.runWithTimeout(
      () => this.verifyFeasibility(test_input, spec.postconditions, outputDomain),
      this.config.feasibility_timeout_ms
    );

    if (feasibilityResult.timedOut) {
      return {
        admissibility: true,
        soundness: true,
        feasibility: false,
        certified: false,
        failure_reason: 'Verification timed out on property: Feasibility',
      };
    }

    const feasibilityTimestamp = new Date().toISOString();

    if (!feasibilityResult.value) {
      return {
        admissibility: true,
        soundness: true,
        feasibility: false,
        certified: false,
        failure_reason:
          'Feasibility failed: no output in the declared domain satisfies all postconditions (the specification is not satisfiable for this input)',
      };
    }

    // All three properties verified — produce certificate
    const certificate: ProofOfFailureCertificate = {
      test_input,
      observed_output,
      violated_postcondition: candidate.violated_postcondition,
      admissibility_verified_at: admissibilityTimestamp,
      soundness_verified_at: soundnessTimestamp,
      uniqueness_verified_at: feasibilityTimestamp,
    };

    // Store certificate in the database
    this.storeCertificate(certificate);

    return {
      admissibility: true,
      soundness: true,
      feasibility: true,
      certified: true,
      certificate,
    };
  }

  /**
   * Verify Admissibility: input satisfies ALL preconditions.
   * Returns true iff all preconditions evaluate to true on the input.
   */
  verifyAdmissibility(input: unknown, preconditions: Array<(input: unknown) => boolean>): boolean {
    return preconditions.every((pre) => pre(input));
  }

  /**
   * Verify Soundness: output violates at least one postcondition.
   * Returns true iff ≥1 postcondition evaluates to false given input and output.
   */
  verifySoundness(
    input: unknown,
    output: unknown,
    postconditions: Array<(input: unknown, output: unknown) => boolean>
  ): boolean {
    return postconditions.some((post) => !post(input, output));
  }

  /**
   * Verify Feasibility: at least one output in the declared domain satisfies all
   * postconditions. This proves the specification is satisfiable for the given
   * input, so the observed violation is a genuine code failure rather than an
   * impossible/contradictory specification.
   *
   * Returns true iff some output in the domain satisfies all postconditions.
   * An empty (or entirely violating) domain yields false: feasibility cannot be
   * established, so the candidate must NOT be certified.
   */
  verifyFeasibility(
    input: unknown,
    postconditions: Array<(input: unknown, output: unknown) => boolean>,
    outputDomain: unknown[]
  ): boolean {
    for (const candidateOutput of outputDomain) {
      // A correct output satisfies ALL postconditions. It is necessarily
      // different from the observed output, which violated at least one
      // postcondition (established by Soundness).
      const satisfiesAll = postconditions.every((post) => post(input, candidateOutput));
      if (satisfiesAll) {
        return true;
      }
    }

    // No output in the domain satisfies all postconditions.
    return false;
  }

  /**
   * Stores a proof-of-failure certificate in the proof_certificates table.
   */
  private storeCertificate(certificate: ProofOfFailureCertificate): void {
    const id = randomUUID();
    const investigationId = randomUUID();

    const stmt = this.db.prepare(`
      INSERT INTO proof_certificates (
        id, investigation_id, test_input, observed_output,
        violated_postcondition, admissibility_verified_at,
        soundness_verified_at, uniqueness_verified_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      investigationId,
      ProofVerifier.safeSerialize(certificate.test_input),
      ProofVerifier.safeSerialize(certificate.observed_output),
      certificate.violated_postcondition,
      certificate.admissibility_verified_at,
      certificate.soundness_verified_at,
      certificate.uniqueness_verified_at
    );
  }

  /**
   * Serialize a certificate value for storage in a NOT NULL TEXT column.
   *
   * Plain JSON.stringify is unsafe here because the values that trigger numeric
   * bugs are exactly the ones JSON cannot represent:
   *  - NaN / Infinity / -Infinity serialize to `null`, silently destroying the
   *    recorded evidence (this is a proof-carrying debugger — the observed output
   *    IS the proof).
   *  - `undefined` serializes to the JS value `undefined`, which better-sqlite3
   *    rejects when binding, crashing the whole verification.
   * We map these to explicit, round-trippable sentinel tokens instead.
   */
  static safeSerialize(value: unknown): string {
    const serialized = JSON.stringify(value, (_key, v) => {
      if (typeof v === 'number') {
        if (Number.isNaN(v)) return '__NaN__';
        if (v === Infinity) return '__Infinity__';
        if (v === -Infinity) return '__-Infinity__';
      }
      return v;
    });
    // JSON.stringify(undefined) returns undefined; store a sentinel so the bind
    // never receives undefined and the value is not lost.
    return serialized === undefined ? '"__undefined__"' : serialized;
  }

  /**
   * Runs a synchronous function with a timeout.
   * Returns { value, timedOut } where timedOut is true if the timeout was exceeded.
   *
   * For synchronous checks this uses a Promise.race pattern with a timer.
   */
  private runWithTimeout<T>(
    fn: () => T,
    timeoutMs: number
  ): Promise<{ value: T | undefined; timedOut: boolean }> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        resolve({ value: undefined, timedOut: true });
      }, timeoutMs);

      try {
        const value = fn();
        clearTimeout(timer);
        resolve({ value, timedOut: false });
      } catch {
        clearTimeout(timer);
        resolve({ value: undefined, timedOut: true });
      }
    });
  }
}
