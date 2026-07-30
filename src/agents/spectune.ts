import type Database from 'better-sqlite3';
import type { Postcondition, SpecTuneResult, AlphaConsistency } from '../types/spectune.js';
import { randomUUID } from 'node:crypto';

export interface TestCase {
  id: string;
  input: unknown;
  expected_output: unknown;
  passing: boolean;
}

export interface SpecTuneConfig {
  alpha_threshold: number; // default 0.5, valid range 0.0 to 1.0 exclusive
}

export class SpecTune {
  private db: Database.Database;
  private config: SpecTuneConfig;

  constructor(db: Database.Database, config?: Partial<SpecTuneConfig>) {
    this.db = db;
    this.config = { alpha_threshold: config?.alpha_threshold ?? 0.5 };
  }

  /**
   * Evaluate candidate postconditions against all passing test cases.
   * Computes Alpha_Consistency = agreeing / total for each postcondition.
   * Classification:
   *   α = 1.0 → 'fully_consistent'
   *   α < threshold → 'discarded' (returns disagreeing test IDs)
   *   threshold ≤ α < 1.0 → 'partially_consistent'
   */
  evaluatePostconditions(
    postconditions: Postcondition[],
    testCases: TestCase[],
    evaluator: (postcondition: string, input: unknown, output: unknown) => boolean
  ): SpecTuneResult[] {
    const passingTests = testCases.filter((tc) => tc.passing);

    const results: SpecTuneResult[] = [];

    for (const postcondition of postconditions) {
      const alphaConsistency = this.computeAlphaConsistency(
        postcondition,
        passingTests,
        evaluator
      );
      const status = this.classify(alphaConsistency);

      const result: SpecTuneResult = {
        postcondition,
        alpha_consistency: alphaConsistency,
        status,
      };

      results.push(result);

      // Store result in spec_refinements table
      this.storeResult(postcondition, alphaConsistency, status);
    }

    return results;
  }

  /**
   * Compute Alpha_Consistency signal for a single postcondition.
   * α = agreeing_tests / total_passing_tests
   */
  computeAlphaConsistency(
    postcondition: Postcondition,
    passingTests: TestCase[],
    evaluator: (expression: string, input: unknown, output: unknown) => boolean
  ): AlphaConsistency {
    const totalTests = passingTests.length;

    // Edge case: no passing tests → α = 0
    if (totalTests === 0) {
      return {
        value: 0,
        agreeing_tests: 0,
        total_tests: 0,
        disagreeing_test_ids: [],
      };
    }

    const disagreingTestIds: string[] = [];
    let agreeingCount = 0;

    for (const testCase of passingTests) {
      const holds = evaluator(
        postcondition.expression,
        testCase.input,
        testCase.expected_output
      );

      if (holds) {
        agreeingCount++;
      } else {
        disagreingTestIds.push(testCase.id);
      }
    }

    const value = agreeingCount / totalTests;

    return {
      value,
      agreeing_tests: agreeingCount,
      total_tests: totalTests,
      disagreeing_test_ids: disagreingTestIds,
    };
  }

  /**
   * Classify a postcondition based on its alpha-consistency value.
   */
  classify(
    alpha: AlphaConsistency
  ): 'fully_consistent' | 'partially_consistent' | 'discarded' {
    if (alpha.value === 1.0) {
      return 'fully_consistent';
    }
    if (alpha.value < this.config.alpha_threshold) {
      return 'discarded';
    }
    return 'partially_consistent';
  }

  /**
   * Store a spec refinement result in the database.
   */
  private storeResult(
    postcondition: Postcondition,
    alpha: AlphaConsistency,
    status: 'fully_consistent' | 'partially_consistent' | 'discarded'
  ): void {
    const stmt = this.db.prepare(`
      INSERT INTO spec_refinements (id, function_id, postcondition, alpha_consistency, status, disagreeing_tests)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      randomUUID(),
      postcondition.id,
      postcondition.expression,
      alpha.value,
      status,
      alpha.disagreeing_test_ids.length > 0
        ? JSON.stringify(alpha.disagreeing_test_ids)
        : null
    );
  }
}
