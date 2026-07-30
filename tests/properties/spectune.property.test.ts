import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import Database from 'better-sqlite3';
import { initializeDatabase } from '../../src/database/graph-db.js';
import { SpecTune, type TestCase, type SpecTuneConfig } from '../../src/agents/spectune.js';
import type { Postcondition, AlphaConsistency } from '../../src/types/spectune.js';

/**
 * Property 9: Alpha-Consistency Computation and Classification
 *
 * For any candidate postcondition evaluated against T total passing test cases
 * where A test cases agree with the postcondition:
 *   (a) the Alpha_Consistency value shall equal A/T
 *   (b) if A/T = 1.0 the postcondition is marked 'fully_consistent'
 *   (c) if A/T < configurable threshold it is marked 'discarded' with disagreeing test IDs returned
 *   (d) if threshold ≤ A/T < 1.0 it is marked 'partially_consistent'
 *
 * **Validates: Requirements 5.2, 5.3, 5.4, 5.5**
 */

// --- Arbitraries ---

/**
 * Generate random boolean arrays representing agreement of each test case.
 * true = test case agrees with postcondition, false = disagrees.
 */
const arbAgreementArray = fc.array(fc.boolean(), { minLength: 1, maxLength: 50 });

/**
 * Generate a configurable threshold in the valid range (0.0 to 1.0 exclusive).
 */
const arbThreshold = fc.double({ min: 0.01, max: 0.99, noNaN: true });

/**
 * Helper: create a minimal in-memory DB with the spec_refinements table.
 */
function createTestDb(): Database.Database {
  return initializeDatabase(':memory:');
}

/**
 * Helper: create test cases from a boolean agreement array.
 * All test cases are marked as passing. The agreement boolean determines
 * whether the evaluator will report the postcondition holds for that test case.
 */
function createTestCasesFromAgreement(agreements: boolean[]): TestCase[] {
  return agreements.map((agrees, idx) => ({
    id: `test-${idx}`,
    input: { value: idx },
    expected_output: { result: agrees ? 'agree' : 'disagree' },
    passing: true,
  }));
}

/**
 * Helper: create a simple evaluator that uses the expected_output to determine
 * whether the postcondition holds. This allows us to control agreement via
 * the test case data.
 */
function createAgreementEvaluator(): (expression: string, input: unknown, output: unknown) => boolean {
  return (_expression: string, _input: unknown, output: unknown) => {
    return (output as { result: string }).result === 'agree';
  };
}

describe('Property 9: Alpha-Consistency Computation and Classification', () => {
  it('(a) α equals A/T where A is agreeing tests and T is total tests', () => {
    fc.assert(
      fc.property(
        arbAgreementArray,
        arbThreshold,
        (agreements, threshold) => {
          const db = createTestDb();
          try {
            const spectune = new SpecTune(db, { alpha_threshold: threshold });

            const testCases = createTestCasesFromAgreement(agreements);
            const postcondition: Postcondition = {
              id: 'pc-1',
              expression: 'x > 0',
            };

            const alpha = spectune.computeAlphaConsistency(
              postcondition,
              testCases,
              createAgreementEvaluator()
            );

            const totalTests = agreements.length;
            const agreeingTests = agreements.filter((a) => a).length;
            const expectedAlpha = agreeingTests / totalTests;

            // (a) α = A/T
            expect(alpha.value).toBeCloseTo(expectedAlpha, 10);
            expect(alpha.agreeing_tests).toBe(agreeingTests);
            expect(alpha.total_tests).toBe(totalTests);

            // α must be in [0.0, 1.0]
            expect(alpha.value).toBeGreaterThanOrEqual(0.0);
            expect(alpha.value).toBeLessThanOrEqual(1.0);
          } finally {
            db.close();
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('(b) α = 1.0 → fully_consistent classification', () => {
    fc.assert(
      fc.property(
        // Generate arrays with all true (all agree) of varying lengths
        fc.integer({ min: 1, max: 50 }),
        arbThreshold,
        (numTests, threshold) => {
          const db = createTestDb();
          try {
            const spectune = new SpecTune(db, { alpha_threshold: threshold });

            // All test cases agree
            const agreements = Array.from({ length: numTests }, () => true);
            const testCases = createTestCasesFromAgreement(agreements);
            const postcondition: Postcondition = {
              id: 'pc-full',
              expression: 'always_true',
            };

            const alpha = spectune.computeAlphaConsistency(
              postcondition,
              testCases,
              createAgreementEvaluator()
            );

            const status = spectune.classify(alpha);

            // (b) α = 1.0 → 'fully_consistent'
            expect(alpha.value).toBe(1.0);
            expect(status).toBe('fully_consistent');
            expect(alpha.disagreeing_test_ids).toHaveLength(0);
          } finally {
            db.close();
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('(c) α < threshold → discarded with disagreeing test IDs', () => {
    fc.assert(
      fc.property(
        // Generate total test count and agreeing count such that α < threshold
        fc.integer({ min: 2, max: 50 }),
        arbThreshold,
        (totalTests, threshold) => {
          // Compute max agreeing that keeps α strictly below threshold
          const maxAgreeing = Math.floor(threshold * totalTests) - 1;
          if (maxAgreeing < 0) return; // Skip if impossible (threshold too small)

          const agreeingCount = Math.max(0, maxAgreeing);
          const agreements = [
            ...Array.from({ length: agreeingCount }, () => true),
            ...Array.from({ length: totalTests - agreeingCount }, () => false),
          ];

          const db = createTestDb();
          try {
            const spectune = new SpecTune(db, { alpha_threshold: threshold });

            const testCases = createTestCasesFromAgreement(agreements);
            const postcondition: Postcondition = {
              id: 'pc-discard',
              expression: 'low_agreement',
            };

            const alpha = spectune.computeAlphaConsistency(
              postcondition,
              testCases,
              createAgreementEvaluator()
            );

            const status = spectune.classify(alpha);

            // (c) α < threshold → 'discarded'
            expect(alpha.value).toBeLessThan(threshold);
            expect(status).toBe('discarded');

            // Disagreeing test IDs should be returned
            const expectedDisagreeCount = totalTests - agreeingCount;
            expect(alpha.disagreeing_test_ids).toHaveLength(expectedDisagreeCount);

            // All disagreeing IDs should be valid test case IDs
            for (const id of alpha.disagreeing_test_ids) {
              expect(id).toMatch(/^test-\d+$/);
            }
          } finally {
            db.close();
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('(d) threshold ≤ α < 1.0 → partially_consistent', () => {
    fc.assert(
      fc.property(
        // Generate total test count and threshold, then compute agreeing count in range
        fc.integer({ min: 2, max: 50 }),
        arbThreshold,
        (totalTests, threshold) => {
          // Compute minimum agreeing that yields α ≥ threshold but < 1.0
          const minAgreeing = Math.ceil(threshold * totalTests);
          const maxAgreeing = totalTests - 1; // Must be < 1.0 so not all agree

          if (minAgreeing > maxAgreeing) return; // Skip impossible cases

          const agreeingCount = minAgreeing; // Use minimum to satisfy threshold ≤ α < 1.0
          const agreements = [
            ...Array.from({ length: agreeingCount }, () => true),
            ...Array.from({ length: totalTests - agreeingCount }, () => false),
          ];

          const db = createTestDb();
          try {
            const spectune = new SpecTune(db, { alpha_threshold: threshold });

            const testCases = createTestCasesFromAgreement(agreements);
            const postcondition: Postcondition = {
              id: 'pc-partial',
              expression: 'partial_agreement',
            };

            const alpha = spectune.computeAlphaConsistency(
              postcondition,
              testCases,
              createAgreementEvaluator()
            );

            const status = spectune.classify(alpha);

            // (d) threshold ≤ α < 1.0 → 'partially_consistent'
            expect(alpha.value).toBeGreaterThanOrEqual(threshold);
            expect(alpha.value).toBeLessThan(1.0);
            expect(status).toBe('partially_consistent');
          } finally {
            db.close();
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('evaluatePostconditions produces correct classification for random agreements', () => {
    fc.assert(
      fc.property(
        arbAgreementArray,
        arbThreshold,
        (agreements, threshold) => {
          const db = createTestDb();
          try {
            const spectune = new SpecTune(db, { alpha_threshold: threshold });

            const testCases = createTestCasesFromAgreement(agreements);
            const postcondition: Postcondition = {
              id: 'pc-eval',
              expression: 'test_expression',
            };

            const results = spectune.evaluatePostconditions(
              [postcondition],
              testCases,
              createAgreementEvaluator()
            );

            expect(results).toHaveLength(1);
            const result = results[0];

            const totalTests = agreements.length;
            const agreeingTests = agreements.filter((a) => a).length;
            const expectedAlpha = agreeingTests / totalTests;

            // Verify α computation
            expect(result.alpha_consistency.value).toBeCloseTo(expectedAlpha, 10);

            // Verify classification
            if (expectedAlpha === 1.0) {
              expect(result.status).toBe('fully_consistent');
            } else if (expectedAlpha < threshold) {
              expect(result.status).toBe('discarded');
              expect(result.alpha_consistency.disagreeing_test_ids.length).toBeGreaterThan(0);
            } else {
              expect(result.status).toBe('partially_consistent');
            }
          } finally {
            db.close();
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});
