import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import Database from 'better-sqlite3';
import { initializeDatabase } from '../../src/database/graph-db.js';
import { ProofVerifier, type FunctionSpecification } from '../../src/agents/proof-verifier.js';
import type { ProofCandidate } from '../../src/types/proof.js';

/**
 * Property Tests for Proof Verification (Properties 17–20)
 *
 * Tests mathematical proof-of-failure verification logic:
 * - Property 17: Admissibility Verification
 * - Property 18: Soundness Verification
 * - Property 19: Uniqueness Verification
 * - Property 20: Proof Certification Decision
 *
 * **Validates: Requirements 11.1, 11.2, 11.3, 11.4, 11.5**
 */

// --- Helpers ---

function createTestDb(): Database.Database {
  return initializeDatabase(':memory:');
}

/**
 * Generate an array of precondition functions from boolean outcomes.
 * Each boolean in the array determines whether that precondition returns true or false
 * for any given input.
 */
function createPreconditions(outcomes: boolean[]): Array<(input: unknown) => boolean> {
  return outcomes.map((outcome) => (_input: unknown) => outcome);
}

/**
 * Generate an array of postcondition functions from boolean outcomes.
 * Each boolean in the array determines whether that postcondition returns true or false
 * for any given input/output pair.
 */
function createPostconditions(outcomes: boolean[]): Array<(input: unknown, output: unknown) => boolean> {
  return outcomes.map((outcome) => (_input: unknown, _output: unknown) => outcome);
}

// --- Arbitraries ---

/** Generate a non-empty array of booleans representing precondition results. */
const arbPreconditionOutcomes = fc.array(fc.boolean(), { minLength: 1, maxLength: 10 });

/** Generate a non-empty array of booleans representing postcondition results. */
const arbPostconditionOutcomes = fc.array(fc.boolean(), { minLength: 1, maxLength: 10 });

/** Generate a random input value. */
const arbInput = fc.oneof(
  fc.integer(),
  fc.string(),
  fc.constant(null),
  fc.array(fc.integer(), { maxLength: 5 })
);

/** Generate a random output value. */
const arbOutput = fc.oneof(
  fc.integer(),
  fc.string(),
  fc.constant(null),
  fc.array(fc.integer(), { maxLength: 5 })
);

// --- Property 17: Admissibility Verification ---

describe('Property 17: Admissibility Verification', () => {
  it('returns true if and only if all preconditions evaluate to true on input', () => {
    fc.assert(
      fc.property(
        arbPreconditionOutcomes,
        arbInput,
        (preconditionOutcomes, input) => {
          const db = createTestDb();
          try {
            const verifier = new ProofVerifier(db);
            const preconditions = createPreconditions(preconditionOutcomes);

            const result = verifier.verifyAdmissibility(input, preconditions);

            const allTrue = preconditionOutcomes.every((o) => o === true);

            // Admissibility returns true iff ALL preconditions evaluate to true
            expect(result).toBe(allTrue);
          } finally {
            db.close();
          }
        }
      ),
      { numRuns: 200 }
    );
  });

  it('returns true when all preconditions pass', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10 }),
        arbInput,
        (numPreconditions, input) => {
          const db = createTestDb();
          try {
            const verifier = new ProofVerifier(db);
            const allTrueOutcomes = Array.from({ length: numPreconditions }, () => true);
            const preconditions = createPreconditions(allTrueOutcomes);

            const result = verifier.verifyAdmissibility(input, preconditions);

            expect(result).toBe(true);
          } finally {
            db.close();
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('returns false when at least one precondition fails', () => {
    fc.assert(
      fc.property(
        // Generate outcomes with at least one false
        fc.array(fc.boolean(), { minLength: 1, maxLength: 10 }).filter(
          (outcomes) => outcomes.some((o) => !o)
        ),
        arbInput,
        (preconditionOutcomes, input) => {
          const db = createTestDb();
          try {
            const verifier = new ProofVerifier(db);
            const preconditions = createPreconditions(preconditionOutcomes);

            const result = verifier.verifyAdmissibility(input, preconditions);

            expect(result).toBe(false);
          } finally {
            db.close();
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});

// --- Property 18: Soundness Verification ---

describe('Property 18: Soundness Verification', () => {
  it('returns true if and only if at least one postcondition evaluates to false', () => {
    fc.assert(
      fc.property(
        arbPostconditionOutcomes,
        arbInput,
        arbOutput,
        (postconditionOutcomes, input, output) => {
          const db = createTestDb();
          try {
            const verifier = new ProofVerifier(db);
            const postconditions = createPostconditions(postconditionOutcomes);

            const result = verifier.verifySoundness(input, output, postconditions);

            // Soundness = at least one postcondition evaluates to false
            const atLeastOneFalse = postconditionOutcomes.some((o) => o === false);

            expect(result).toBe(atLeastOneFalse);
          } finally {
            db.close();
          }
        }
      ),
      { numRuns: 200 }
    );
  });

  it('returns true when at least one postcondition fails (violation detected)', () => {
    fc.assert(
      fc.property(
        // Generate outcomes with at least one false
        fc.array(fc.boolean(), { minLength: 1, maxLength: 10 }).filter(
          (outcomes) => outcomes.some((o) => !o)
        ),
        arbInput,
        arbOutput,
        (postconditionOutcomes, input, output) => {
          const db = createTestDb();
          try {
            const verifier = new ProofVerifier(db);
            const postconditions = createPostconditions(postconditionOutcomes);

            const result = verifier.verifySoundness(input, output, postconditions);

            expect(result).toBe(true);
          } finally {
            db.close();
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('returns false when all postconditions pass (no violation)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10 }),
        arbInput,
        arbOutput,
        (numPostconditions, input, output) => {
          const db = createTestDb();
          try {
            const verifier = new ProofVerifier(db);
            const allTrueOutcomes = Array.from({ length: numPostconditions }, () => true);
            const postconditions = createPostconditions(allTrueOutcomes);

            const result = verifier.verifySoundness(input, output, postconditions);

            expect(result).toBe(false);
          } finally {
            db.close();
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});

// --- Property 19: Feasibility Verification ---

describe('Property 19: Feasibility Verification', () => {
  it('returns true if and only if at least one output in the domain satisfies all postconditions', () => {
    fc.assert(
      fc.property(
        // Domain of candidate outputs (small integers)
        fc.array(fc.integer({ min: -100, max: 100 }), { minLength: 0, maxLength: 10 }),
        // For each domain entry, whether it satisfies all postconditions
        fc.array(fc.boolean(), { minLength: 0, maxLength: 10 }),
        (domain, satisfiesFlags) => {
          const db = createTestDb();
          try {
            const verifier = new ProofVerifier(db);

            // Define the set of outputs that satisfy all postconditions.
            const satisfyingSet = new Set<number>();
            domain.forEach((v, i) => {
              if (satisfiesFlags[i % Math.max(satisfiesFlags.length, 1)]) {
                satisfyingSet.add(v);
              }
            });

            const postconditions: Array<(input: unknown, output: unknown) => boolean> = [
              (_input: unknown, output: unknown) => satisfyingSet.has(output as number),
            ];

            const result = verifier.verifyFeasibility(42, postconditions, domain);

            // Feasibility = true iff some output in the domain satisfies all postconditions
            const someSatisfies = domain.some((o) => satisfyingSet.has(o));

            expect(result).toBe(someSatisfies);
          } finally {
            db.close();
          }
        }
      ),
      { numRuns: 200 }
    );
  });

  it('returns false when the output domain is empty (feasibility cannot be established)', () => {
    fc.assert(
      fc.property(
        arbInput,
        (input) => {
          const db = createTestDb();
          try {
            const verifier = new ProofVerifier(db);
            const postconditions: Array<(input: unknown, output: unknown) => boolean> = [
              () => true,
            ];

            // Empty domain → no satisfying output can be exhibited → feasibility fails
            const result = verifier.verifyFeasibility(input, postconditions, []);

            expect(result).toBe(false);
          } finally {
            db.close();
          }
        }
      ),
      { numRuns: 50 }
    );
  });

  it('returns true when at least one domain output satisfies all postconditions', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100 }),
        fc.integer({ min: 101, max: 200 }),
        (badOutput, goodOutput) => {
          const db = createTestDb();
          try {
            const verifier = new ProofVerifier(db);

            // Only goodOutput satisfies the postcondition.
            const postconditions: Array<(input: unknown, output: unknown) => boolean> = [
              (_input, output) => (output as number) === goodOutput,
            ];

            const domain = [badOutput, goodOutput];

            const result = verifier.verifyFeasibility(0, postconditions, domain);

            // A satisfying output exists in the domain → feasibility holds
            expect(result).toBe(true);
          } finally {
            db.close();
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('returns false when no domain output satisfies all postconditions', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: -100, max: 100 }), { minLength: 1, maxLength: 10 }),
        (domain) => {
          const db = createTestDb();
          try {
            const verifier = new ProofVerifier(db);

            // No output can satisfy this postcondition.
            const postconditions: Array<(input: unknown, output: unknown) => boolean> = [
              () => false,
            ];

            const result = verifier.verifyFeasibility(0, postconditions, domain);

            expect(result).toBe(false);
          } finally {
            db.close();
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});

// --- Property 20: Proof Certification Decision ---

describe('Property 20: Proof Certification Decision', () => {
  it('certified iff all 3 properties pass; unconfirmed with failed property otherwise', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Whether all preconditions pass (admissibility)
        fc.boolean(),
        // Whether the observed output violates a postcondition (soundness)
        fc.boolean(),
        // Whether a spec-satisfying output exists in the domain (feasibility)
        fc.boolean(),
        arbInput,
        arbOutput,
        async (admissibilityPasses, soundnessPasses, feasibilityPasses, input, output) => {
          const db = createTestDb();
          try {
            const verifier = new ProofVerifier(db);

            const preconditions: Array<(input: unknown) => boolean> = [
              () => admissibilityPasses,
            ];

            // A distinct candidate output used as the feasibility witness. It is
            // never reference-equal to the arbitrary observed output.
            const candidateOutput = { __candidate: true };

            // Input-aware postconditions drive both checks:
            //  - observed output: violates (returns false) iff soundness should pass
            //  - candidate output: satisfies (returns true) iff feasibility should pass
            const smartPostconditions: Array<(inp: unknown, out: unknown) => boolean> = [
              (_inp, out) => {
                if (out === output) {
                  return !soundnessPasses;
                }
                return feasibilityPasses;
              },
            ];

            const spec: FunctionSpecification = {
              name: 'test-function',
              preconditions,
              postconditions: smartPostconditions,
              output_domain: () => [candidateOutput],
            };

            const candidate: ProofCandidate = {
              test_input: input,
              observed_output: output,
              postconditions: ['test-postcondition'],
              violated_postcondition: 'test-postcondition',
            };

            const result = await verifier.verify(candidate, spec);

            const allPass = admissibilityPasses && soundnessPasses && feasibilityPasses;

            if (allPass) {
              // All 3 pass → certified with certificate
              expect(result.certified).toBe(true);
              expect(result.admissibility).toBe(true);
              expect(result.soundness).toBe(true);
              expect(result.feasibility).toBe(true);
              expect(result.certificate).toBeDefined();
              expect(result.certificate!.test_input).toEqual(input);
              expect(result.certificate!.observed_output).toEqual(output);
              expect(result.certificate!.violated_postcondition).toBe('test-postcondition');
              expect(result.certificate!.admissibility_verified_at).toBeTruthy();
              expect(result.certificate!.soundness_verified_at).toBeTruthy();
              expect(result.certificate!.uniqueness_verified_at).toBeTruthy();
            } else {
              // At least one fails → not certified
              expect(result.certified).toBe(false);
              expect(result.failure_reason).toBeTruthy();

              // Verify which property failed (first failure in order)
              if (!admissibilityPasses) {
                expect(result.admissibility).toBe(false);
                expect(result.failure_reason).toContain('Admissibility');
              } else if (!soundnessPasses) {
                expect(result.admissibility).toBe(true);
                expect(result.soundness).toBe(false);
                expect(result.failure_reason).toContain('Soundness');
              } else {
                // feasibility failed
                expect(result.admissibility).toBe(true);
                expect(result.soundness).toBe(true);
                expect(result.feasibility).toBe(false);
                expect(result.failure_reason).toContain('Feasibility');
              }
            }
          } finally {
            db.close();
          }
        }
      ),
      { numRuns: 200 }
    );
  });

  it('produces certificate with all required fields when all properties pass', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbInput,
        arbOutput,
        async (input, output) => {
          const db = createTestDb();
          try {
            const verifier = new ProofVerifier(db);

            // A distinct correct output that satisfies the postcondition; the
            // arbitrary observed output does not.
            const correctOutput = { __correct: true };

            const spec: FunctionSpecification = {
              name: 'test-function',
              // Admissibility passes; the observed output violates the
              // postcondition (soundness); and the correct output in the domain
              // satisfies it (feasibility).
              preconditions: [() => true],
              postconditions: [(_inp, out) => out === correctOutput],
              output_domain: () => [correctOutput],
            };

            const candidate: ProofCandidate = {
              test_input: input,
              observed_output: output,
              postconditions: ['output === correct'],
              violated_postcondition: 'output === correct',
            };

            const result = await verifier.verify(candidate, spec);

            expect(result.certified).toBe(true);
            expect(result.certificate).toBeDefined();

            const cert = result.certificate!;
            expect(cert.test_input).toEqual(input);
            expect(cert.observed_output).toEqual(output);
            expect(cert.violated_postcondition).toBe('output === correct');
            // Timestamps should be ISO strings
            expect(new Date(cert.admissibility_verified_at).toISOString()).toBe(cert.admissibility_verified_at);
            expect(new Date(cert.soundness_verified_at).toISOString()).toBe(cert.soundness_verified_at);
            expect(new Date(cert.uniqueness_verified_at).toISOString()).toBe(cert.uniqueness_verified_at);
          } finally {
            db.close();
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('marks unconfirmed when admissibility fails', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbInput,
        arbOutput,
        async (input, output) => {
          const db = createTestDb();
          try {
            const verifier = new ProofVerifier(db);

            const spec: FunctionSpecification = {
              name: 'test-function',
              preconditions: [() => false], // Admissibility fails
              postconditions: [() => false],
              output_domain: () => [],
            };

            const candidate: ProofCandidate = {
              test_input: input,
              observed_output: output,
              postconditions: ['x > 0'],
              violated_postcondition: 'x > 0',
            };

            const result = await verifier.verify(candidate, spec);

            expect(result.certified).toBe(false);
            expect(result.admissibility).toBe(false);
            expect(result.failure_reason).toContain('Admissibility');
            expect(result.certificate).toBeUndefined();
          } finally {
            db.close();
          }
        }
      ),
      { numRuns: 50 }
    );
  });

  it('marks unconfirmed when soundness fails (no postcondition violated)', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbInput,
        arbOutput,
        async (input, output) => {
          const db = createTestDb();
          try {
            const verifier = new ProofVerifier(db);

            const spec: FunctionSpecification = {
              name: 'test-function',
              preconditions: [() => true], // Admissibility passes
              postconditions: [() => true], // All postconditions pass → soundness fails
              output_domain: () => [],
            };

            const candidate: ProofCandidate = {
              test_input: input,
              observed_output: output,
              postconditions: ['x > 0'],
              violated_postcondition: 'x > 0',
            };

            const result = await verifier.verify(candidate, spec);

            expect(result.certified).toBe(false);
            expect(result.admissibility).toBe(true);
            expect(result.soundness).toBe(false);
            expect(result.failure_reason).toContain('Soundness');
            expect(result.certificate).toBeUndefined();
          } finally {
            db.close();
          }
        }
      ),
      { numRuns: 50 }
    );
  });
});
