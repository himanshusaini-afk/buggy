import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import Database from 'better-sqlite3';
import { initializeDatabase } from '../../src/database/graph-db.js';
import {
  ClassifierAgent,
  AST_PROPERTY_COUNT,
  FEATURE_VECTOR_DIMENSIONS,
  type PrismApccModel,
} from '../../src/agents/classifier-agent.js';
import type { PatchCandidate } from '../../src/types/repair.js';
import type { CstNode } from '../../src/types/cst.js';

/**
 * Property 25: Overfitting Classification Decision
 *
 * For any classification score S and configurable threshold T:
 *   - If S > T the patch shall be rejected with at least the top 3 contributing
 *     AST properties reported
 *   - If S ≤ T the patch shall be approved with the score included in the output
 *
 * **Validates: Requirements 14.4, 14.5**
 */

// --- Helpers ---

/**
 * Create a mock Prism APCC model that returns a fixed score.
 * This allows us to directly control the classification decision.
 */
function createFixedScoreModel(score: number): PrismApccModel {
  return {
    evaluate(_featureVector: number[]): number {
      return score;
    },
  };
}

/**
 * Create a minimal in-memory DB for the classifier.
 */
function createTestDb(): Database.Database {
  return initializeDatabase(':memory:');
}

/**
 * Create a minimal valid CstNode for testing.
 * Includes enough varied node types so that the feature vector produces
 * non-trivial property contributions.
 */
function createTestCstNode(): CstNode {
  return {
    id: 'root-node',
    type: 'program',
    start_byte: 0,
    end_byte: 100,
    start_position: { row: 0, column: 0 },
    end_position: { row: 10, column: 0 },
    children: [
      {
        id: 'stmt-1',
        type: 'expression_statement',
        start_byte: 0,
        end_byte: 20,
        start_position: { row: 1, column: 0 },
        end_position: { row: 1, column: 20 },
        children: [],
        is_error: false,
      },
      {
        id: 'branch-1',
        type: 'if_statement',
        start_byte: 20,
        end_byte: 50,
        start_position: { row: 2, column: 0 },
        end_position: { row: 4, column: 0 },
        children: [
          {
            id: 'call-1',
            type: 'call_expression',
            start_byte: 25,
            end_byte: 40,
            start_position: { row: 3, column: 2 },
            end_position: { row: 3, column: 15 },
            children: [],
            is_error: false,
          },
        ],
        is_error: false,
      },
      {
        id: 'loop-1',
        type: 'for_statement',
        start_byte: 50,
        end_byte: 80,
        start_position: { row: 5, column: 0 },
        end_position: { row: 7, column: 0 },
        children: [
          {
            id: 'id-1',
            type: 'identifier',
            start_byte: 55,
            end_byte: 60,
            start_position: { row: 5, column: 5 },
            end_position: { row: 5, column: 10 },
            children: [],
            is_error: false,
          },
        ],
        is_error: false,
      },
      {
        id: 'ret-1',
        type: 'return_statement',
        start_byte: 80,
        end_byte: 100,
        start_position: { row: 8, column: 0 },
        end_position: { row: 8, column: 20 },
        children: [
          {
            id: 'lit-1',
            type: 'number',
            start_byte: 87,
            end_byte: 89,
            start_position: { row: 8, column: 7 },
            end_position: { row: 8, column: 9 },
            children: [],
            is_error: false,
          },
        ],
        is_error: false,
      },
    ],
    is_error: false,
  };
}

/**
 * Create a minimal patch candidate that triggers classification.
 */
function createTestPatch(): PatchCandidate {
  return {
    id: 'test-patch-1',
    diff: '- old\n+ new',
    edit_operations: [
      {
        type: 'insert',
        node_type: 'call_expression',
        location: {
          file_path: 'test.ts',
          start_line: 3,
          start_column: 0,
          end_line: 3,
          end_column: 20,
        },
      },
      {
        type: 'delete',
        node_type: 'expression_statement',
        location: {
          file_path: 'test.ts',
          start_line: 1,
          start_column: 0,
          end_line: 1,
          end_column: 20,
        },
      },
      {
        type: 'replace',
        node_type: 'identifier',
        location: {
          file_path: 'test.ts',
          start_line: 5,
          start_column: 5,
          end_line: 5,
          end_column: 10,
        },
      },
    ],
    target_file: 'test.ts',
    target_range: { start_line: 1, end_line: 10 },
    refinement_attempt: 0,
  };
}

// --- Arbitraries ---

/**
 * Generate a score S in [0.0, 1.0].
 */
const arbScore = fc.double({ min: 0.0, max: 1.0, noNaN: true, noDefaultInfinity: true });

/**
 * Generate a threshold T in (0.0, 1.0) — open interval to avoid degenerate edge cases.
 */
const arbThreshold = fc.double({ min: 0.01, max: 0.99, noNaN: true, noDefaultInfinity: true });

// --- Property Tests ---

describe('Property 25: Overfitting Classification Decision', () => {
  it('S > T → patch is rejected with ≥3 top contributing properties', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbScore,
        arbThreshold,
        async (score, threshold) => {
          // Only test cases where S > T
          fc.pre(score > threshold);

          const db = createTestDb();
          try {
            const model = createFixedScoreModel(score);
            const classifier = new ClassifierAgent(
              db,
              { overfitting_threshold: threshold },
              model
            );

            const patch = createTestPatch();
            const original = createTestCstNode();

            // Execute classification
            const result = await classifier.classify(patch, original);

            // Patch should be rejected
            expect(result.approved).toBe(false);

            // Overfitting probability should match the score
            expect(result.overfitting_probability).toBeCloseTo(score, 10);

            // Must report at least top 3 contributing AST properties
            expect(result.top_contributing_properties).toBeDefined();
            expect(result.top_contributing_properties!.length).toBeGreaterThanOrEqual(3);

            // Each contributing property must have required fields
            for (const prop of result.top_contributing_properties!) {
              expect(prop.name).toBeTruthy();
              expect(['gen', 'del', 'remain']).toContain(prop.edit_state);
              expect(typeof prop.contribution).toBe('number');
              expect(prop.contribution).toBeGreaterThanOrEqual(0);
            }

            // Should not be marked as inconclusive
            expect(result.inconclusive).toBeUndefined();
          } finally {
            db.close();
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('S ≤ T → patch is approved with overfitting score included', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbScore,
        arbThreshold,
        async (score, threshold) => {
          // Only test cases where S ≤ T
          fc.pre(score <= threshold);

          const db = createTestDb();
          try {
            const model = createFixedScoreModel(score);
            const classifier = new ClassifierAgent(
              db,
              { overfitting_threshold: threshold },
              model
            );

            const patch = createTestPatch();
            const original = createTestCstNode();

            // Execute classification
            const result = await classifier.classify(patch, original);

            // Patch should be approved
            expect(result.approved).toBe(true);

            // Overfitting probability score should be included in output
            expect(result.overfitting_probability).toBeCloseTo(score, 10);

            // Approved patches should not have top contributing properties
            expect(result.top_contributing_properties).toBeUndefined();

            // Should not be marked as inconclusive
            expect(result.inconclusive).toBeUndefined();

            // Patch ID should be present
            expect(result.patch_id).toBeTruthy();
          } finally {
            db.close();
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('boundary: S exactly equal to T → patch is approved', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbThreshold,
        async (threshold) => {
          // Score exactly at threshold — should be approved per spec (S ≤ T)
          const score = threshold;

          const db = createTestDb();
          try {
            const model = createFixedScoreModel(score);
            const classifier = new ClassifierAgent(
              db,
              { overfitting_threshold: threshold },
              model
            );

            const patch = createTestPatch();
            const original = createTestCstNode();

            const result = await classifier.classify(patch, original);

            // At threshold exactly: S ≤ T → approved
            expect(result.approved).toBe(true);
            expect(result.overfitting_probability).toBeCloseTo(score, 10);
            expect(result.top_contributing_properties).toBeUndefined();
          } finally {
            db.close();
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});
