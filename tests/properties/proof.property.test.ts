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

// --- Property 19: Uniqueness Verification ---

describe('Property 19: Uniqueness Verification', () => {
  it('returns true if and only if no alternative output satisfies all postconditions', () => {
    fc.assert(
      fc.property(
        // Generate a domain of alternative outputs (small integers)
        fc.array(fc.integer({ min: -100, max: 100 }), { minLength: 0, maxLength: 10 }),
        // The observed output
        fc.integer({ min: -100, max: 100 }),
        // For each alternative, whether all postconditions hold (true = satisfies all)
        fc.array(fc.boolean(), { minLength: 0, maxLength: 10 }),
        (domain, observedOutput, satisfiesAllArray) => {
          const db = createTestDb();
          try {
            const verifier = new ProofVerifier(db);

            // Filter out the observed output from the domain to avoid collision
            const filteredDomain = domain.filter((v) => v !== observedOutput);

            // Align the satisfiesAll array to the filtered domain length
            const domainSize = filteredDomain.length;

            // Create postconditions that return true/false based on whether
            // the given output is one that "satisfies all"
            // We'll define a set of outputs that "satisfy all postconditions"
            const satisfyingSet = new Set<number>();
            for (let i = 0; i < domainSize; i++) {
              if (satisfiesAllArray[i % Math.max(satisfiesAllArray.length, 1)]) {
                satisfyingSet.add(filteredDomain[i]);
              }
            }

            // Build a single postcondition that checks membership in the satisfying set
            const postconditions: Array<(input: unknown, output: unknown) => boolean> = [
              (_input: unknown, output: unknown) => satisfyingSet.has(output as number),
            ];

            // Add observed output back to domain (verifier skips it)
            const fullDomain = [...filteredDomain, observedOutput];

            const result = verifier.verifyUniqueness(
              42, // input doesn't matter for this postcondition
              observedOutput,
              postconditions,
              fullDomain
            );

            // Uniqueness = true iff no alternative (not observedOutput) satisfies all postconditions
            const hasAlternativeSatisfying = filteredDomain.some((alt) => satisfyingSet.has(alt));

            expect(result).toBe(!hasAlternativeSatisfying);
          } finally {
            db.close();
          }
        }
      ),
      { numRuns: 200 }
    );
  });

  it('returns true when output domain is empty (no alternatives exist)', () => {
    fc.assert(
      fc.property(
        arbInput,
        arbOutput,
        (input, output) => {
          const db = createTestDb();
          try {
            const verifier = new ProofVerifier(db);
            const postconditions: Array<(input: unknown, output: unknown) => boolean> = [
              () => true,
            ];

            // Empty domain → no alternatives → uniqueness holds
            const result = verifier.verifyUniqueness(input, output, postconditions, []);

            expect(result).toBe(true);
          } finally {
            db.close();
          }
        }
      ),
      { numRuns: 50 }
    );
  });

  it('returns true when domain contains only the observed output', () => {
    fc.assert(
      fc.property(
        fc.integer(),
        (observedOutput) => {
          const db = createTestDb();
          try {
            const verifier = new ProofVerifier(db);
            const postconditions: Array<(input: unknown, output: unknown) => boolean> = [
              () => true, // Would satisfy all, but it's the observed output itself
            ];

            // Domain has only observed output → skipped → no alternatives → uniqueness holds
            const result = verifier.verifyUniqueness(0, observedOutput, postconditions, [observedOutput]);

            expect(result).toBe(true);
          } finally {
            db.close();
          }
        }
      ),
      { numRuns: 50 }
    );
  });

  it('returns false when an alternative output satisfies all postconditions', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100 }),
        fc.integer({ min: 101, max: 200 }),
        (observedOutput, alternativeOutput) => {
          const db = createTestDb();
          try {
            const verifier = new ProofVerifier(db);

            // Postcondition that passes for the alternative
            const postconditions: Array<(input: unknown, output: unknown) => boolean> = [
              (_input, output) => (output as number) === alternativeOutput,
            ];

            const domain = [observedOutput, alternativeOutput];

            const result = verifier.verifyUniqueness(0, observedOutput, postconditions, domain);

            // Alternative satisfies all postconditions → uniqueness fails
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
        // Whether at least one postcondition fails (soundness)
        fc.boolean(),
        // Whether uniqueness holds (no alternative satisfies all postconditions)
        fc.boolean(),
        arbInput,
        arbOutput,
        async (admissibilityPasses, soundnessPasses, uniquenessPasses, input, output) => {
          const db = createTestDb();
          try {
            const verifier = new ProofVerifier(db);

            // Build preconditions: all return admissibilityPasses
            const preconditions: Array<(input: unknown) => boolean> = [
              () => admissibilityPasses,
            ];

            // Build postconditions that control soundness:
            // soundness = true means at least one postcondition evaluates to false
            // So if soundnessPasses is true, we need at least one postcondition to return false
            // If soundnessPasses is false, all postconditions return true
            const postconditions: Array<(input: unknown, output: unknown) => boolean> = soundnessPasses
              ? [() => false] // At least one false → soundness passes
              : [() => true]; // All true → soundness fails

            // Build output domain that controls uniqueness:
            // uniqueness = true means no alternative satisfies all postconditions
            // If uniquenessPasses is true, domain has no satisfying alternatives
            // If uniquenessPasses is false, domain has at least one satisfying alternative
            //
            // Note: For uniqueness to matter, we only reach it if admissibility and soundness pass.
            // The output domain function returns alternatives.
            const alternativeOutput = { __alternative: true };
            const outputDomain = uniquenessPasses
              ? [] // No alternatives → uniqueness holds
              : [alternativeOutput]; // One alternative that satisfies all

            // For uniqueness check: postconditions checked against alternatives
            // If soundness passes, our postconditions return false for the observed output.
            // For uniqueness, we need postconditions that either do or don't accept alternatives.
            // We need separate postcondition logic for soundness vs uniqueness checks.
            //
            // Redesign: use input-aware postconditions
            const smartPostconditions: Array<(inp: unknown, out: unknown) => boolean> = [
              (_inp, out) => {
                if (out === output) {
                  // For the observed output: return false if soundness should pass
                  return !soundnessPasses;
                }
                // For alternative outputs: return true if uniqueness should fail
                return !uniquenessPasses;
              },
            ];

            const spec: FunctionSpecification = {
              name: 'test-function',
              preconditions,
              postconditions: smartPostconditions,
              output_domain: () => outputDomain,
            };

            const candidate: ProofCandidate = {
              test_input: input,
              observed_output: output,
              postconditions: ['test-postcondition'],
              violated_postcondition: 'test-postcondition',
            };

            const result = await verifier.verify(candidate, spec);

            const allPass = admissibilityPasses && soundnessPasses && uniquenessPasses;

            if (allPass) {
              // All 3 pass → certified with certificate
              expect(result.certified).toBe(true);
              expect(result.admissibility).toBe(true);
              expect(result.soundness).toBe(true);
              expect(result.uniqueness).toBe(true);
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
                // uniqueness failed
                expect(result.admissibility).toBe(true);
                expect(result.soundness).toBe(true);
                expect(result.uniqueness).toBe(false);
                expect(result.failure_reason).toContain('Uniqueness');
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

            // All preconditions pass
            const preconditions: Array<(input: unknown) => boolean> = [() => true];
            // At least one postcondition false for observed output (soundness)
            // No alternative satisfies all postconditions (uniqueness)
            const postconditions: Array<(inp: unknown, out: unknown) => boolean> = [
              (_inp, out) => out !== output, // false for observed output, true for alternatives... but we want uniqueness to pass
            ];

            // For uniqueness: alternatives that DON'T satisfy all postconditions
            // postcondition returns true for alternatives (out !== output is true for them)
            // So alternatives WOULD satisfy all postconditions → uniqueness fails
            // Instead, use empty domain
            const spec: FunctionSpecification = {
              name: 'test-function',
              preconditions,
              postconditions: [() => false], // Always false → soundness passes, uniqueness trivially passes (no alt satisfies all)
              output_domain: () => [],
            };

            const candidate: ProofCandidate = {
              test_input: input,
              observed_output: output,
              postconditions: ['output > 0'],
              violated_postcondition: 'output > 0',
            };

            const result = await verifier.verify(candidate, spec);

            expect(result.certified).toBe(true);
            expect(result.certificate).toBeDefined();

            const cert = result.certificate!;
            expect(cert.test_input).toEqual(input);
            expect(cert.observed_output).toEqual(output);
            expect(cert.violated_postcondition).toBe('output > 0');
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
