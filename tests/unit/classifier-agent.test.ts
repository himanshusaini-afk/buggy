import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  ClassifierAgent,
  AST_PROPERTY_COUNT,
  AST_PROPERTY_NAMES,
  FEATURE_VECTOR_DIMENSIONS,
  EDIT_STATE_COUNT,
  DefaultPrismApccModel,
  type PrismApccModel,
  type EditStateNodes,
  type ClassifierConfig,
} from '../../src/agents/classifier-agent.js';
import { initializeDatabase } from '../../src/database/graph-db.js';
import type { CstNode } from '../../src/types/cst.js';
import type { PatchCandidate } from '../../src/types/repair.js';

function createTestNode(overrides?: Partial<CstNode>): CstNode {
  return {
    id: 'node-1',
    type: 'expression_statement',
    start_byte: 0,
    end_byte: 10,
    start_position: { row: 0, column: 0 },
    end_position: { row: 0, column: 10 },
    children: [],
    is_error: false,
    ...overrides,
  };
}

function createTestPatch(overrides?: Partial<PatchCandidate>): PatchCandidate {
  return {
    id: 'patch-1',
    diff: '- old\n+ new',
    edit_operations: [
      {
        type: 'insert',
        node_type: 'call_expression',
        location: {
          file_path: 'test.ts',
          start_line: 5,
          start_column: 0,
          end_line: 5,
          end_column: 20,
        },
      },
    ],
    target_file: 'test.ts',
    target_range: { start_line: 1, end_line: 10 },
    refinement_attempt: 0,
    ...overrides,
  };
}

function setupDb(): Database.Database {
  const db = initializeDatabase(':memory:');
  // Insert a proof certificate so we can insert a patch referencing it
  db.prepare(`
    INSERT INTO proof_certificates (id, investigation_id, test_input, observed_output, violated_postcondition, admissibility_verified_at, soundness_verified_at, uniqueness_verified_at)
    VALUES ('cert-1', 'inv-1', '{}', '{}', 'post', '2024-01-01', '2024-01-01', '2024-01-01')
  `).run();
  // Insert a patch record for the classifier to update
  db.prepare(`
    INSERT INTO patches (id, proof_certificate_id, diff, edit_operations, target_file, target_range, status)
    VALUES ('patch-1', 'cert-1', '- old\n+ new', '[]', 'test.ts', '1-10', 'pending')
  `).run();
  return db;
}

describe('ClassifierAgent', () => {
  let db: Database.Database;
  let agent: ClassifierAgent;

  beforeEach(() => {
    db = setupDb();
    agent = new ClassifierAgent(db);
  });

  describe('extractEditStates', () => {
    it('should classify nodes into gen, del, and remain', () => {
      const original = createTestNode({
        id: 'root',
        type: 'program',
        children: [
          createTestNode({ id: 'n1', type: 'if_statement', start_position: { row: 2, column: 0 } }),
          createTestNode({ id: 'n2', type: 'expression_statement', start_position: { row: 5, column: 0 } }),
        ],
      });

      const patch = createTestPatch({
        edit_operations: [
          {
            type: 'delete',
            node_type: 'if_statement',
            location: { file_path: 'test.ts', start_line: 2, start_column: 0, end_line: 4, end_column: 1 },
          },
          {
            type: 'insert',
            node_type: 'call_expression',
            location: { file_path: 'test.ts', start_line: 2, start_column: 0, end_line: 2, end_column: 20 },
          },
        ],
      });

      const result = agent.extractEditStates(patch, original);

      // The if_statement at row 2 should be in del
      expect(result.del.length).toBeGreaterThan(0);
      expect(result.del.some(n => n.type === 'if_statement')).toBe(true);
      // The insert generates a gen node
      expect(result.gen.length).toBe(1);
      expect(result.gen[0].type).toBe('call_expression');
      // Remaining nodes should include the root and the expression_statement
      expect(result.remain.length).toBeGreaterThan(0);
    });
  });

  describe('computeAstDifferenceVector', () => {
    it('should produce an 11-element property vector', () => {
      const nodes: CstNode[] = [
        createTestNode({ type: 'if_statement' }),
        createTestNode({ type: 'for_statement' }),
        createTestNode({ type: 'call_expression' }),
        createTestNode({ type: 'identifier' }),
      ];

      const result = agent.computeAstDifferenceVector(nodes);

      expect(result.properties).toHaveLength(AST_PROPERTY_COUNT);
      // branch_count should be 1 (if_statement)
      expect(result.properties[1]).toBe(1);
      // loop_count should be 1 (for_statement)
      expect(result.properties[2]).toBe(1);
      // function_call_count should be 1
      expect(result.properties[3]).toBe(1);
      // identifier_count should be 1
      expect(result.properties[10]).toBe(1);
    });

    it('should handle empty node arrays', () => {
      const result = agent.computeAstDifferenceVector([]);
      expect(result.properties).toHaveLength(AST_PROPERTY_COUNT);
      expect(result.properties.every(v => v === 0)).toBe(true);
    });
  });

  describe('computeSemanticFeatureVector', () => {
    it('should produce a 66-dimensional combined vector', () => {
      const editStates: EditStateNodes = {
        gen: [createTestNode({ type: 'call_expression' })],
        del: [createTestNode({ type: 'if_statement' })],
        remain: [createTestNode({ type: 'identifier' })],
      };

      const result = agent.computeSemanticFeatureVector(editStates);

      expect(result.combined).toHaveLength(FEATURE_VECTOR_DIMENSIONS);
      expect(result.gen.properties).toHaveLength(AST_PROPERTY_COUNT);
      expect(result.del.properties).toHaveLength(AST_PROPERTY_COUNT);
      expect(result.remain.properties).toHaveLength(AST_PROPERTY_COUNT);
    });

    it('should have all finite values in the combined vector', () => {
      const editStates: EditStateNodes = {
        gen: [createTestNode({ type: 'for_statement' }), createTestNode({ type: 'number' })],
        del: [],
        remain: [createTestNode({ type: 'return_statement' })],
      };

      const result = agent.computeSemanticFeatureVector(editStates);

      for (const value of result.combined) {
        expect(Number.isFinite(value)).toBe(true);
      }
    });
  });

  describe('classify', () => {
    it('should approve a patch when overfitting probability is below threshold', async () => {
      // Use a model that returns low probability
      const lowModel: PrismApccModel = { evaluate: () => 0.2 };
      const classifierAgent = new ClassifierAgent(db, { overfitting_threshold: 0.5 }, lowModel);

      const patch = createTestPatch();
      const original = createTestNode({ type: 'program' });

      const result = await classifierAgent.classify(patch, original);

      expect(result.approved).toBe(true);
      expect(result.overfitting_probability).toBe(0.2);
      expect(result.patch_id).toBe('patch-1');
      expect(result.top_contributing_properties).toBeUndefined();
    });

    it('should reject a patch when overfitting probability exceeds threshold', async () => {
      // Use a model that returns high probability
      const highModel: PrismApccModel = { evaluate: () => 0.8 };
      const classifierAgent = new ClassifierAgent(db, { overfitting_threshold: 0.5 }, highModel);

      const patch = createTestPatch();
      const original = createTestNode({ type: 'program' });

      const result = await classifierAgent.classify(patch, original);

      expect(result.approved).toBe(false);
      expect(result.overfitting_probability).toBe(0.8);
      expect(result.top_contributing_properties).toBeDefined();
      expect(result.top_contributing_properties!.length).toBeLessThanOrEqual(3);
    });

    it('should reject as inconclusive when model throws an error', async () => {
      const failingModel: PrismApccModel = {
        evaluate: () => { throw new Error('Model unavailable'); },
      };
      const classifierAgent = new ClassifierAgent(db, undefined, failingModel);

      const patch = createTestPatch();
      const original = createTestNode({ type: 'program' });

      const result = await classifierAgent.classify(patch, original);

      expect(result.approved).toBe(false);
      expect(result.inconclusive).toBe(true);
      expect(result.overfitting_probability).toBe(-1);
    });

    it('should reject as inconclusive when model times out', async () => {
      const slowModel: PrismApccModel = {
        evaluate: () => new Promise((resolve) => setTimeout(() => resolve(0.3), 5000)),
      };
      // Use a very short timeout for test speed
      const classifierAgent = new ClassifierAgent(db, { overfitting_threshold: 0.5, model_timeout_ms: 50 }, slowModel);

      const patch = createTestPatch();
      const original = createTestNode({ type: 'program' });

      const result = await classifierAgent.classify(patch, original);

      expect(result.approved).toBe(false);
      expect(result.inconclusive).toBe(true);
    });

    it('should approve at exactly the threshold boundary', async () => {
      const boundaryModel: PrismApccModel = { evaluate: () => 0.5 };
      const classifierAgent = new ClassifierAgent(db, { overfitting_threshold: 0.5 }, boundaryModel);

      const patch = createTestPatch();
      const original = createTestNode({ type: 'program' });

      const result = await classifierAgent.classify(patch, original);

      // Score ≤ threshold → approved
      expect(result.approved).toBe(true);
      expect(result.overfitting_probability).toBe(0.5);
    });

    it('should store feature vector and probability in patches table', async () => {
      const model: PrismApccModel = { evaluate: () => 0.3 };
      const classifierAgent = new ClassifierAgent(db, undefined, model);

      const patch = createTestPatch();
      const original = createTestNode({ type: 'program' });

      await classifierAgent.classify(patch, original);

      const row = db.prepare('SELECT feature_vector, overfitting_probability, status FROM patches WHERE id = ?').get('patch-1') as any;
      expect(row.overfitting_probability).toBe(0.3);
      expect(row.status).toBe('approved');
      expect(row.feature_vector).toBeTruthy();
      const vector = JSON.parse(row.feature_vector);
      expect(vector).toHaveLength(FEATURE_VECTOR_DIMENSIONS);
    });
  });

  describe('getTopContributingProperties', () => {
    it('should return at most 3 properties sorted by contribution', () => {
      const editStates: EditStateNodes = {
        gen: [
          createTestNode({ type: 'call_expression' }),
          createTestNode({ type: 'call_expression' }),
          createTestNode({ type: 'call_expression' }),
        ],
        del: [createTestNode({ type: 'if_statement' })],
        remain: [createTestNode({ type: 'identifier' })],
      };

      const featureVector = agent.computeSemanticFeatureVector(editStates);
      const top = agent.getTopContributingProperties(featureVector, 3);

      expect(top).toHaveLength(3);
      // Each property should have name, edit_state, and contribution
      for (const prop of top) {
        expect(prop.name).toBeDefined();
        expect(['gen', 'del', 'remain']).toContain(prop.edit_state);
        expect(typeof prop.contribution).toBe('number');
      }
      // Should be sorted descending by contribution
      expect(top[0].contribution).toBeGreaterThanOrEqual(top[1].contribution);
      expect(top[1].contribution).toBeGreaterThanOrEqual(top[2].contribution);
    });
  });

  describe('66-dimensional feature vector shape validation (Req 14.1, 14.2)', () => {
    it('should produce exactly 66 dimensions in the combined feature vector', () => {
      const editStates: EditStateNodes = {
        gen: [createTestNode({ type: 'call_expression' }), createTestNode({ type: 'for_statement' })],
        del: [createTestNode({ type: 'if_statement' }), createTestNode({ type: 'number' })],
        remain: [createTestNode({ type: 'identifier' }), createTestNode({ type: 'return_statement' })],
      };

      const result = agent.computeSemanticFeatureVector(editStates);

      expect(result.combined).toHaveLength(66);
      expect(result.combined.length).toBe(FEATURE_VECTOR_DIMENSIONS);
      expect(FEATURE_VECTOR_DIMENSIONS).toBe(AST_PROPERTY_COUNT * EDIT_STATE_COUNT * 2);
    });

    it('should have all 66 values as finite numbers (no NaN, no Infinity)', () => {
      const editStates: EditStateNodes = {
        gen: [
          createTestNode({ type: 'call_expression' }),
          createTestNode({ type: 'binary_expression' }),
          createTestNode({ type: 'string' }),
        ],
        del: [createTestNode({ type: 'variable_declaration' })],
        remain: [
          createTestNode({ type: 'identifier' }),
          createTestNode({ type: 'assignment_expression' }),
        ],
      };

      const result = agent.computeSemanticFeatureVector(editStates);

      expect(result.combined).toHaveLength(66);
      for (let i = 0; i < result.combined.length; i++) {
        expect(typeof result.combined[i]).toBe('number');
        expect(Number.isFinite(result.combined[i])).toBe(true);
        expect(Number.isNaN(result.combined[i])).toBe(false);
      }
    });

    it('should have exactly 66 dimensions even with empty edit states', () => {
      const editStates: EditStateNodes = {
        gen: [],
        del: [],
        remain: [],
      };

      const result = agent.computeSemanticFeatureVector(editStates);

      expect(result.combined).toHaveLength(66);
      // All values should be 0 for empty input, and still finite
      for (const value of result.combined) {
        expect(Number.isFinite(value)).toBe(true);
      }
    });

    it('should compose as 11 properties × 3 states × 2 (raw + normalized)', () => {
      const editStates: EditStateNodes = {
        gen: [createTestNode({ type: 'call_expression' })],
        del: [createTestNode({ type: 'if_statement' })],
        remain: [createTestNode({ type: 'identifier' })],
      };

      const result = agent.computeSemanticFeatureVector(editStates);

      // First 33 values = raw (11 gen + 11 del + 11 remain)
      // Last 33 values = normalized
      expect(result.gen.properties).toHaveLength(11);
      expect(result.del.properties).toHaveLength(11);
      expect(result.remain.properties).toHaveLength(11);
      expect(result.combined).toHaveLength(66);
    });
  });

  describe('Threshold boundary classification (Req 14.4, 14.5)', () => {
    it('should approve when score equals exactly the threshold (score ≤ 0.5)', async () => {
      const boundaryModel: PrismApccModel = { evaluate: () => 0.5 };
      const classifierAgent = new ClassifierAgent(db, { overfitting_threshold: 0.5 }, boundaryModel);

      const patch = createTestPatch();
      const original = createTestNode({ type: 'program' });

      const result = await classifierAgent.classify(patch, original);

      expect(result.approved).toBe(true);
      expect(result.overfitting_probability).toBe(0.5);
    });

    it('should reject when score is just above threshold (score > 0.5)', async () => {
      const justAboveModel: PrismApccModel = { evaluate: () => 0.500001 };
      const classifierAgent = new ClassifierAgent(db, { overfitting_threshold: 0.5 }, justAboveModel);

      const patch = createTestPatch();
      const original = createTestNode({ type: 'program' });

      const result = await classifierAgent.classify(patch, original);

      expect(result.approved).toBe(false);
      expect(result.overfitting_probability).toBe(0.500001);
      expect(result.top_contributing_properties).toBeDefined();
    });

    it('should approve when score is just below threshold', async () => {
      const justBelowModel: PrismApccModel = { evaluate: () => 0.499999 };
      const classifierAgent = new ClassifierAgent(db, { overfitting_threshold: 0.5 }, justBelowModel);

      const patch = createTestPatch();
      const original = createTestNode({ type: 'program' });

      const result = await classifierAgent.classify(patch, original);

      expect(result.approved).toBe(true);
      expect(result.overfitting_probability).toBe(0.499999);
      expect(result.top_contributing_properties).toBeUndefined();
    });

    it('should respect custom threshold values', async () => {
      const model: PrismApccModel = { evaluate: () => 0.7 };
      // Score 0.7 is below custom threshold 0.8, so it should approve
      const classifierAgent = new ClassifierAgent(db, { overfitting_threshold: 0.8 }, model);

      const patch = createTestPatch();
      const original = createTestNode({ type: 'program' });

      const result = await classifierAgent.classify(patch, original);

      expect(result.approved).toBe(true);
      expect(result.overfitting_probability).toBe(0.7);
    });

    it('should reject with custom threshold when score exceeds it', async () => {
      const model: PrismApccModel = { evaluate: () => 0.35 };
      // Score 0.35 exceeds custom threshold 0.3
      const classifierAgent = new ClassifierAgent(db, { overfitting_threshold: 0.3 }, model);

      const patch = createTestPatch();
      const original = createTestNode({ type: 'program' });

      const result = await classifierAgent.classify(patch, original);

      expect(result.approved).toBe(false);
      expect(result.overfitting_probability).toBe(0.35);
    });
  });

  describe('Model timeout handling (Req 14.6)', () => {
    it('should reject as inconclusive when model exceeds the 30s default timeout', async () => {
      // Verify default timeout is 30000ms
      const slowModel: PrismApccModel = {
        evaluate: () => new Promise((resolve) => setTimeout(() => resolve(0.3), 200)),
      };
      // Use a short timeout to simulate the timeout behavior without waiting 30s
      const classifierAgent = new ClassifierAgent(
        db,
        { overfitting_threshold: 0.5, model_timeout_ms: 50 },
        slowModel
      );

      const patch = createTestPatch();
      const original = createTestNode({ type: 'program' });

      const result = await classifierAgent.classify(patch, original);

      expect(result.approved).toBe(false);
      expect(result.inconclusive).toBe(true);
      expect(result.overfitting_probability).toBe(-1);
      expect(result.patch_id).toBe('patch-1');
    });

    it('should reject as inconclusive when model throws an error', async () => {
      const failingModel: PrismApccModel = {
        evaluate: () => { throw new Error('Model service unavailable'); },
      };
      const classifierAgent = new ClassifierAgent(db, undefined, failingModel);

      const patch = createTestPatch();
      const original = createTestNode({ type: 'program' });

      const result = await classifierAgent.classify(patch, original);

      expect(result.approved).toBe(false);
      expect(result.inconclusive).toBe(true);
      expect(result.overfitting_probability).toBe(-1);
    });

    it('should reject as inconclusive when model returns a rejected promise', async () => {
      const rejectingModel: PrismApccModel = {
        evaluate: () => Promise.reject(new Error('Network timeout')),
      };
      const classifierAgent = new ClassifierAgent(db, undefined, rejectingModel);

      const patch = createTestPatch();
      const original = createTestNode({ type: 'program' });

      const result = await classifierAgent.classify(patch, original);

      expect(result.approved).toBe(false);
      expect(result.inconclusive).toBe(true);
      expect(result.overfitting_probability).toBe(-1);
    });

    it('should preserve patch for manual review by storing inconclusive status in DB', async () => {
      const failingModel: PrismApccModel = {
        evaluate: () => { throw new Error('Model crashed'); },
      };
      const classifierAgent = new ClassifierAgent(db, undefined, failingModel);

      const patch = createTestPatch();
      const original = createTestNode({ type: 'program' });

      await classifierAgent.classify(patch, original);

      // Verify the patch is preserved with inconclusive status for manual review
      const row = db.prepare('SELECT status, overfitting_probability FROM patches WHERE id = ?').get('patch-1') as any;
      expect(row.status).toBe('inconclusive');
      expect(row.overfitting_probability).toBeNull();
    });
  });

  describe('Top-3 contributing AST properties format (Req 14.4)', () => {
    it('should report exactly 3 contributing properties when patch is rejected', async () => {
      const highModel: PrismApccModel = { evaluate: () => 0.9 };
      const classifierAgent = new ClassifierAgent(db, { overfitting_threshold: 0.5 }, highModel);

      const patch = createTestPatch({
        edit_operations: [
          { type: 'insert', node_type: 'call_expression', location: { file_path: 'test.ts', start_line: 5, start_column: 0, end_line: 5, end_column: 20 } },
          { type: 'insert', node_type: 'if_statement', location: { file_path: 'test.ts', start_line: 6, start_column: 0, end_line: 8, end_column: 1 } },
          { type: 'insert', node_type: 'for_statement', location: { file_path: 'test.ts', start_line: 9, start_column: 0, end_line: 11, end_column: 1 } },
        ],
      });
      const original = createTestNode({
        type: 'program',
        children: [
          createTestNode({ type: 'expression_statement', start_position: { row: 1, column: 0 } }),
          createTestNode({ type: 'identifier', start_position: { row: 2, column: 0 } }),
        ],
      });

      const result = await classifierAgent.classify(patch, original);

      expect(result.approved).toBe(false);
      expect(result.top_contributing_properties).toBeDefined();
      expect(result.top_contributing_properties!).toHaveLength(3);
    });

    it('should report properties with valid name, edit_state, and numeric contribution', async () => {
      const highModel: PrismApccModel = { evaluate: () => 0.8 };
      const classifierAgent = new ClassifierAgent(db, { overfitting_threshold: 0.5 }, highModel);

      const patch = createTestPatch();
      const original = createTestNode({ type: 'program' });

      const result = await classifierAgent.classify(patch, original);

      expect(result.top_contributing_properties).toBeDefined();
      for (const prop of result.top_contributing_properties!) {
        // Property name must be one of the 11 known AST property names
        expect(AST_PROPERTY_NAMES).toContain(prop.name);
        // Edit state must be one of the valid states
        expect(['gen', 'del', 'remain']).toContain(prop.edit_state);
        // Contribution must be a non-negative finite number
        expect(typeof prop.contribution).toBe('number');
        expect(Number.isFinite(prop.contribution)).toBe(true);
        expect(prop.contribution).toBeGreaterThanOrEqual(0);
      }
    });

    it('should sort top-3 properties by contribution in descending order', async () => {
      const highModel: PrismApccModel = { evaluate: () => 0.75 };
      const classifierAgent = new ClassifierAgent(db, { overfitting_threshold: 0.5 }, highModel);

      const patch = createTestPatch({
        edit_operations: [
          { type: 'insert', node_type: 'call_expression', location: { file_path: 'test.ts', start_line: 5, start_column: 0, end_line: 5, end_column: 20 } },
          { type: 'insert', node_type: 'call_expression', location: { file_path: 'test.ts', start_line: 6, start_column: 0, end_line: 6, end_column: 20 } },
          { type: 'insert', node_type: 'identifier', location: { file_path: 'test.ts', start_line: 7, start_column: 0, end_line: 7, end_column: 10 } },
        ],
      });
      const original = createTestNode({
        type: 'program',
        children: [
          createTestNode({ type: 'if_statement', start_position: { row: 1, column: 0 } }),
          createTestNode({ type: 'for_statement', start_position: { row: 3, column: 0 } }),
        ],
      });

      const result = await classifierAgent.classify(patch, original);

      const props = result.top_contributing_properties!;
      expect(props.length).toBe(3);
      // Verify sorted descending by contribution
      for (let i = 0; i < props.length - 1; i++) {
        expect(props[i].contribution).toBeGreaterThanOrEqual(props[i + 1].contribution);
      }
    });

    it('should not include top_contributing_properties when patch is approved', async () => {
      const lowModel: PrismApccModel = { evaluate: () => 0.2 };
      const classifierAgent = new ClassifierAgent(db, { overfitting_threshold: 0.5 }, lowModel);

      const patch = createTestPatch();
      const original = createTestNode({ type: 'program' });

      const result = await classifierAgent.classify(patch, original);

      expect(result.approved).toBe(true);
      expect(result.top_contributing_properties).toBeUndefined();
    });
  });

  describe('Overfitting probability in approval output (Req 14.5)', () => {
    it('should include overfitting probability score when patch is approved', async () => {
      const model: PrismApccModel = { evaluate: () => 0.25 };
      const classifierAgent = new ClassifierAgent(db, { overfitting_threshold: 0.5 }, model);

      const patch = createTestPatch();
      const original = createTestNode({ type: 'program' });

      const result = await classifierAgent.classify(patch, original);

      expect(result.approved).toBe(true);
      expect(result.overfitting_probability).toBe(0.25);
      expect(typeof result.overfitting_probability).toBe('number');
      expect(result.overfitting_probability).toBeGreaterThanOrEqual(0.0);
      expect(result.overfitting_probability).toBeLessThanOrEqual(1.0);
    });

    it('should include patch_id in approval output', async () => {
      const model: PrismApccModel = { evaluate: () => 0.1 };
      const classifierAgent = new ClassifierAgent(db, { overfitting_threshold: 0.5 }, model);

      const patch = createTestPatch({ id: 'patch-1' });
      const original = createTestNode({ type: 'program' });

      const result = await classifierAgent.classify(patch, original);

      expect(result.approved).toBe(true);
      expect(result.patch_id).toBe('patch-1');
      expect(result.overfitting_probability).toBe(0.1);
    });

    it('should include overfitting probability in rejection output too', async () => {
      const model: PrismApccModel = { evaluate: () => 0.85 };
      const classifierAgent = new ClassifierAgent(db, { overfitting_threshold: 0.5 }, model);

      const patch = createTestPatch();
      const original = createTestNode({ type: 'program' });

      const result = await classifierAgent.classify(patch, original);

      expect(result.approved).toBe(false);
      expect(result.overfitting_probability).toBe(0.85);
      expect(typeof result.overfitting_probability).toBe('number');
    });
  });

  describe('DefaultPrismApccModel', () => {
    it('should produce output in [0.0, 1.0] range', () => {
      const model = new DefaultPrismApccModel();
      const vector = new Array(FEATURE_VECTOR_DIMENSIONS).fill(0.5);

      const result = model.evaluate(vector);

      expect(result).toBeGreaterThanOrEqual(0.0);
      expect(result).toBeLessThanOrEqual(1.0);
    });

    it('should throw on wrong vector dimensions', () => {
      const model = new DefaultPrismApccModel();
      const shortVector = new Array(10).fill(0);

      expect(() => model.evaluate(shortVector)).toThrow(/Expected 66-dimensional/);
    });

    it('should handle zero vector', () => {
      const model = new DefaultPrismApccModel();
      const zeroVector = new Array(FEATURE_VECTOR_DIMENSIONS).fill(0);

      const result = model.evaluate(zeroVector);

      expect(result).toBeGreaterThanOrEqual(0.0);
      expect(result).toBeLessThanOrEqual(1.0);
    });
  });
});
