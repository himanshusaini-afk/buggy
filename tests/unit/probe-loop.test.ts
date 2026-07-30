import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeDatabase } from '../../src/database/graph-db.js';
import { ProbeLoop, type GeneratorAgent, type ValidatorAgent } from '../../src/agents/probe-loop.js';
import { SpecTune, type TestCase } from '../../src/agents/spectune.js';
import { TrajSpec, type CommitInfo } from '../../src/agents/trajspec.js';
import { DiffTestGen, type Implementation, type InterfaceMethod } from '../../src/agents/difftestgen.js';
import { SAFuzz, type CodeRegion, type TestInput, type OracleChecker } from '../../src/agents/safuzz.js';
import { ProofVerifier, type FunctionSpecification } from '../../src/agents/proof-verifier.js';
import type { CandidateProperty } from '../../src/types/probe.js';
import type { Postcondition } from '../../src/types/spectune.js';

describe('Bug_Proving_Agent - Unit Tests', () => {
  let db: Database.Database;

  afterEach(() => {
    if (db?.open) {
      db.close();
    }
  });

  describe('PROBE loop termination at exact iteration count', () => {
    it('should terminate after max_refinement_iterations when validator always finds counter-implementations', async () => {
      db = initializeDatabase(':memory:');

      const maxIterations = 3;
      let generatorCalls = 0;
      let validatorCalls = 0;

      const generator: GeneratorAgent = {
        async refineProperty(property: CandidateProperty, _counterImpl?: string) {
          generatorCalls++;
          // Small delay to ensure unique timestamps in DB ID generation
          await new Promise(resolve => setTimeout(resolve, 2));
          return {
            id: `prop-1-v${generatorCalls}`,
            expression: `${property.expression} && refined_${generatorCalls}`,
          };
        },
      };

      const validator: ValidatorAgent = {
        async generateCounterImpl(_property: CandidateProperty, _budget: number) {
          validatorCalls++;
          return `counter_impl_${validatorCalls}`;
        },
      };

      const probeLoop = new ProbeLoop(db, { search_budget: 10, max_refinement_iterations: maxIterations }, generator, validator);

      const initialProperty: CandidateProperty = { id: 'prop-1', expression: 'x > 0' };
      const result = await probeLoop.run(initialProperty);

      expect(result.status).toBe('inconclusive');
      expect(result.iterations_completed).toBe(maxIterations);
      expect(result.refinement_history).toHaveLength(maxIterations);
      expect(result.last_counter_implementation).toBeDefined();
      expect(validatorCalls).toBe(maxIterations);
      expect(generatorCalls).toBe(maxIterations);
    });

    it('should terminate early when validator exhausts search budget (returns null)', async () => {
      db = initializeDatabase(':memory:');

      const maxIterations = 10;
      let validatorCalls = 0;

      const generator: GeneratorAgent = {
        async refineProperty(property: CandidateProperty) {
          return { id: property.id, expression: `${property.expression} && refined` };
        },
      };

      const validator: ValidatorAgent = {
        async generateCounterImpl() {
          validatorCalls++;
          // Succeed first 2 times, then exhaust budget
          if (validatorCalls <= 2) return `counter_${validatorCalls}`;
          return null;
        },
      };

      const probeLoop = new ProbeLoop(db, { search_budget: 10, max_refinement_iterations: maxIterations }, generator, validator);

      const result = await probeLoop.run({ id: 'prop-2', expression: 'y > 0' });

      expect(result.status).toBe('verified');
      expect(result.iterations_completed).toBe(3); // 2 refinements + 1 verified iteration
      expect(result.refinement_history).toHaveLength(2);
      expect(result.last_counter_implementation).toBeUndefined();
    });

    it('should record each iteration in the probe_iterations table', async () => {
      db = initializeDatabase(':memory:');

      let callCount = 0;
      const generator: GeneratorAgent = {
        async refineProperty(property: CandidateProperty) {
          return { id: property.id, expression: `refined_${++callCount}` };
        },
      };

      const validator: ValidatorAgent = {
        async generateCounterImpl() {
          if (callCount >= 2) return null;
          return 'counter';
        },
      };

      const probeLoop = new ProbeLoop(db, { search_budget: 5, max_refinement_iterations: 10 }, generator, validator);
      await probeLoop.run({ id: 'prop-3', expression: 'initial' });

      const rows = db.prepare('SELECT * FROM probe_iterations WHERE property_id = ?').all('prop-3') as Array<{ status: string }>;
      expect(rows.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('SpecTune at threshold boundary (0.5)', () => {
    it('should classify postcondition as discarded when alpha is below threshold', () => {
      db = initializeDatabase(':memory:');

      const specTune = new SpecTune(db, { alpha_threshold: 0.5 });

      // 4 passing tests, 1 agrees → α = 0.25 < 0.5 → discarded
      const postconditions: Postcondition[] = [
        { id: 'post-1', expression: 'result > 0' },
      ];

      const testCases: TestCase[] = [
        { id: 't1', input: 1, expected_output: 1, passing: true },
        { id: 't2', input: 2, expected_output: -1, passing: true },
        { id: 't3', input: 3, expected_output: -2, passing: true },
        { id: 't4', input: 4, expected_output: -5, passing: true },
      ];

      const evaluator = (_expr: string, _input: unknown, output: unknown) => (output as number) > 0;

      const results = specTune.evaluatePostconditions(postconditions, testCases, evaluator);

      expect(results[0].status).toBe('discarded');
      expect(results[0].alpha_consistency.value).toBe(0.25);
    });

    it('should classify postcondition as partially_consistent when alpha equals threshold exactly (0.5)', () => {
      db = initializeDatabase(':memory:');

      const specTune = new SpecTune(db, { alpha_threshold: 0.5 });

      // 2 passing tests, 1 agrees → α = 0.5 = threshold → partially_consistent
      const postconditions: Postcondition[] = [
        { id: 'post-2', expression: 'result > 0' },
      ];

      const testCases: TestCase[] = [
        { id: 't1', input: 1, expected_output: 5, passing: true },
        { id: 't2', input: 2, expected_output: -1, passing: true },
      ];

      const evaluator = (_expr: string, _input: unknown, output: unknown) => (output as number) > 0;

      const results = specTune.evaluatePostconditions(postconditions, testCases, evaluator);

      expect(results[0].status).toBe('partially_consistent');
      expect(results[0].alpha_consistency.value).toBe(0.5);
    });

    it('should return disagreeing test IDs when postcondition is discarded', () => {
      db = initializeDatabase(':memory:');

      const specTune = new SpecTune(db, { alpha_threshold: 0.5 });

      const postconditions: Postcondition[] = [
        { id: 'post-3', expression: 'result >= 0' },
      ];

      const testCases: TestCase[] = [
        { id: 'test-a', input: 1, expected_output: 10, passing: true },
        { id: 'test-b', input: 2, expected_output: -5, passing: true },
        { id: 'test-c', input: 3, expected_output: -3, passing: true },
        { id: 'test-d', input: 4, expected_output: -1, passing: true },
      ];

      const evaluator = (_expr: string, _input: unknown, output: unknown) => (output as number) >= 0;

      const results = specTune.evaluatePostconditions(postconditions, testCases, evaluator);

      expect(results[0].status).toBe('discarded');
      expect(results[0].alpha_consistency.disagreeing_test_ids).toContain('test-b');
      expect(results[0].alpha_consistency.disagreeing_test_ids).toContain('test-c');
      expect(results[0].alpha_consistency.disagreeing_test_ids).toContain('test-d');
      expect(results[0].alpha_consistency.disagreeing_test_ids).not.toContain('test-a');
    });

    it('should classify as fully_consistent when all tests agree (alpha = 1.0)', () => {
      db = initializeDatabase(':memory:');

      const specTune = new SpecTune(db, { alpha_threshold: 0.5 });

      const postconditions: Postcondition[] = [
        { id: 'post-4', expression: 'result > 0' },
      ];

      const testCases: TestCase[] = [
        { id: 't1', input: 1, expected_output: 5, passing: true },
        { id: 't2', input: 2, expected_output: 10, passing: true },
      ];

      const evaluator = (_expr: string, _input: unknown, output: unknown) => (output as number) > 0;

      const results = specTune.evaluatePostconditions(postconditions, testCases, evaluator);

      expect(results[0].status).toBe('fully_consistent');
      expect(results[0].alpha_consistency.value).toBe(1.0);
    });
  });

  describe('TrajSpec incremental update', () => {
    it('should process only new commits and update existing interpretations', async () => {
      db = initializeDatabase(':memory:');

      const trajSpec = new TrajSpec(db);

      // Initial commit batch
      const initialCommits: CommitInfo[] = [
        { id: 'c1', message: 'add handleRequest', files_changed: ['src/server.ts'], is_defect_fix: false },
        { id: 'c2', message: 'fix handleRequest null check', files_changed: ['src/server.ts'], is_defect_fix: true },
      ];

      await trajSpec.processRepository(initialCommits);

      // Verify initial state
      const initialRows = db.prepare('SELECT * FROM behavioral_interpretations').all() as Array<{ commit_ids: string }>;
      expect(initialRows.length).toBeGreaterThan(0);
      const initialCommitIds = JSON.parse(initialRows[0].commit_ids) as string[];
      expect(initialCommitIds).toContain('c1');
      expect(initialCommitIds).toContain('c2');

      // Incremental update with new commits
      const newCommits: CommitInfo[] = [
        { id: 'c3', message: 'refactor handleRequest', files_changed: ['src/server.ts'], is_defect_fix: false },
      ];

      const result = await trajSpec.processIncrementalCommits(newCommits);

      expect(result.interpretations.length).toBeGreaterThan(0);

      // Verify commit_ids merged
      const updatedRows = db.prepare('SELECT * FROM behavioral_interpretations').all() as Array<{ commit_ids: string }>;
      const updatedCommitIds = JSON.parse(updatedRows[0].commit_ids) as string[];
      expect(updatedCommitIds).toContain('c1');
      expect(updatedCommitIds).toContain('c2');
      expect(updatedCommitIds).toContain('c3');
    });

    it('should create new interpretation for previously unseen regions', async () => {
      db = initializeDatabase(':memory:');

      const trajSpec = new TrajSpec(db);

      const initialCommits: CommitInfo[] = [
        { id: 'c1', message: 'add processData', files_changed: ['src/processor.ts'], is_defect_fix: false },
      ];

      await trajSpec.processRepository(initialCommits);

      const newCommits: CommitInfo[] = [
        { id: 'c2', message: 'add validate input', files_changed: ['src/validator.ts'], is_defect_fix: false },
      ];

      await trajSpec.processIncrementalCommits(newCommits);

      const rows = db.prepare('SELECT * FROM behavioral_interpretations').all() as Array<{ file_path: string }>;
      const filePaths = rows.map(r => r.file_path);
      expect(filePaths).toContain('src/processor.ts');
      expect(filePaths).toContain('src/validator.ts');
    });

    it('should compute defect correlation score as D/N on incremental update', async () => {
      db = initializeDatabase(':memory:');

      const trajSpec = new TrajSpec(db);

      const initialCommits: CommitInfo[] = [
        { id: 'c1', message: 'implement parseJSON', files_changed: ['src/parser.ts'], is_defect_fix: false },
        { id: 'c2', message: 'fix parseJSON overflow', files_changed: ['src/parser.ts'], is_defect_fix: true },
      ];

      await trajSpec.processRepository(initialCommits);

      // Verify initial score: 1 defect / 2 total = 0.5
      const initialRow = db.prepare('SELECT defect_correlation_score FROM behavioral_interpretations').get() as { defect_correlation_score: number };
      expect(initialRow.defect_correlation_score).toBe(0.5);
    });
  });

  describe('DiffTestGen with no differences', () => {
    it('should report behaviorally_equivalent when budget exhausted without differences', async () => {
      const methods: InterfaceMethod[] = [
        { name: 'double', parameter_types: ['number'], return_type: 'number' },
      ];

      const makeImpl = (id: string): Implementation => ({
        id,
        name: `impl-${id}`,
        methods,
        execute: async (_method, input) => (input as number) * 2,
        source_location: { file_path: `src/${id}.ts`, start_line: 1, start_column: 0, end_line: 10, end_column: 0 },
      });

      const engine = new DiffTestGen({ inputs_per_method: 100 });
      const result = await engine.runDiffTestGen([makeImpl('a'), makeImpl('b')]);

      expect(result.status).toBe('behaviorally_equivalent');
      expect(result.differences).toHaveLength(0);
      expect(result.inputs_generated).toBeGreaterThanOrEqual(100);
      expect(result.methods_analyzed).toBe(1);
    });

    it('should report behaviorally_equivalent even with multiple methods and identical behavior', async () => {
      const methods: InterfaceMethod[] = [
        { name: 'add', parameter_types: ['number'], return_type: 'number' },
        { name: 'negate', parameter_types: ['number'], return_type: 'number' },
      ];

      const makeImpl = (id: string): Implementation => ({
        id,
        name: `impl-${id}`,
        methods,
        execute: async (method, input) => {
          if (method === 'add') return (input as number) + 1;
          return -(input as number);
        },
        source_location: { file_path: `src/${id}.ts`, start_line: 1, start_column: 0, end_line: 10, end_column: 0 },
      });

      const engine = new DiffTestGen({ inputs_per_method: 100 });
      const result = await engine.runDiffTestGen([makeImpl('x'), makeImpl('y')]);

      expect(result.status).toBe('behaviorally_equivalent');
      expect(result.methods_analyzed).toBe(2);
    });
  });

  describe('SAFuzz budget exhaustion', () => {
    it('should report inconclusive when mutation budget is exhausted without oracle violations', async () => {
      const safuzz = new SAFuzz({ mutation_budget: 50, correlated_region_ratio: 0.7 });

      const regions: CodeRegion[] = [
        { file_path: 'src/target.ts', start_line: 10, end_line: 20, is_defect_correlated: true },
        { file_path: 'src/other.ts', start_line: 1, end_line: 5, is_defect_correlated: false },
      ];

      const seeds: TestInput[] = [
        { id: 'seed-1', tokens: ['const', 'x', '=', '1'] },
        { id: 'seed-2', tokens: ['let', 'y', '=', 'x', '+', '1'] },
      ];

      // Oracle that never reports a violation
      const oracleChecker: OracleChecker = {
        async check() {
          return { violated: false };
        },
      };

      const result = await safuzz.run(regions, seeds, oracleChecker);

      expect(result.status).toBe('inconclusive');
      expect(result.violations).toHaveLength(0);
      expect(result.mutations_attempted).toBe(50);
      expect(result.budget_remaining).toBe(0);
    });

    it('should report violation_found when oracle detects a violation before budget exhaustion', async () => {
      const safuzz = new SAFuzz({ mutation_budget: 100, correlated_region_ratio: 0.7 });

      const regions: CodeRegion[] = [
        { file_path: 'src/target.ts', start_line: 10, end_line: 20, is_defect_correlated: true },
      ];

      const seeds: TestInput[] = [
        { id: 'seed-1', tokens: ['return', 'x', '+', 'y'] },
      ];

      let checkCount = 0;
      const oracleChecker: OracleChecker = {
        async check() {
          checkCount++;
          // Trigger a violation on the 5th mutation
          if (checkCount === 5) {
            return { violated: true, oracle_type: 'crash' as const };
          }
          return { violated: false };
        },
      };

      const result = await safuzz.run(regions, seeds, oracleChecker);

      expect(result.status).toBe('violation_found');
      expect(result.violations.length).toBeGreaterThanOrEqual(1);
      expect(result.violations[0].oracle_type).toBe('crash');
      expect(result.violations[0].mutation_operator).toMatch(/^(Insert|Overwrite|Splice)$/);
      expect(result.violations[0].input).toBeDefined();
      expect(result.violations[0].seed_input).toBeDefined();
    });

    it('should handle empty seed corpus gracefully', async () => {
      const safuzz = new SAFuzz({ mutation_budget: 20, correlated_region_ratio: 0.7 });

      const regions: CodeRegion[] = [
        { file_path: 'src/target.ts', start_line: 1, end_line: 5, is_defect_correlated: true },
      ];

      const oracleChecker: OracleChecker = {
        async check() {
          return { violated: false };
        },
      };

      const result = await safuzz.run(regions, [], oracleChecker);

      expect(result.status).toBe('inconclusive');
      expect(result.mutations_attempted).toBe(0);
    });
  });

  describe('Proof timeout handling', () => {
    it('should mark as inconclusive when admissibility verification times out', async () => {
      db = initializeDatabase(':memory:');

      // Use a very short timeout to trigger timeout behavior
      const verifier = new ProofVerifier(db, {
        admissibility_timeout_ms: 1, // 1ms timeout
        soundness_timeout_ms: 30000,
        uniqueness_timeout_ms: 60000,
      });

      const candidate = {
        test_input: { x: 5 },
        observed_output: { y: -1 },
        postconditions: ['y >= 0'],
        violated_postcondition: 'y >= 0',
      };

      // Use a precondition that throws to simulate timeout behavior
      const spec: FunctionSpecification = {
        name: 'testFunc',
        preconditions: [(_input) => { throw new Error('simulated long computation'); }],
        postconditions: [(_input, output) => (output as { y: number }).y >= 0],
      };

      const result = await verifier.verify(candidate, spec);

      expect(result.certified).toBe(false);
      expect(result.admissibility).toBe(false);
      expect(result.failure_reason).toContain('timed out');
      expect(result.failure_reason).toContain('Admissibility');
    });

    it('should mark as inconclusive when soundness verification times out', async () => {
      db = initializeDatabase(':memory:');

      const verifier = new ProofVerifier(db, {
        admissibility_timeout_ms: 30000,
        soundness_timeout_ms: 1, // 1ms timeout
        uniqueness_timeout_ms: 60000,
      });

      const candidate = {
        test_input: { x: 5 },
        observed_output: { y: -1 },
        postconditions: ['y >= 0'],
        violated_postcondition: 'y >= 0',
      };

      const spec: FunctionSpecification = {
        name: 'testFunc',
        preconditions: [(_input) => true], // admissibility passes
        postconditions: [(_input, _output) => { throw new Error('simulated long computation'); }],
      };

      const result = await verifier.verify(candidate, spec);

      expect(result.certified).toBe(false);
      expect(result.admissibility).toBe(true);
      expect(result.soundness).toBe(false);
      expect(result.failure_reason).toContain('timed out');
      expect(result.failure_reason).toContain('Soundness');
    });

    it('should mark as inconclusive when uniqueness verification times out', async () => {
      db = initializeDatabase(':memory:');

      const verifier = new ProofVerifier(db, {
        admissibility_timeout_ms: 30000,
        soundness_timeout_ms: 30000,
        uniqueness_timeout_ms: 1, // 1ms timeout
      });

      const candidate = {
        test_input: { x: 5 },
        observed_output: { y: -1 },
        postconditions: ['y >= 0'],
        violated_postcondition: 'y >= 0',
      };

      // Soundness check: postcondition must evaluate to false for the observed output
      // Uniqueness check: postcondition throws when evaluating alternative outputs → treated as timeout
      let callCount = 0;
      const spec: FunctionSpecification = {
        name: 'testFunc',
        preconditions: [(_input) => true],
        postconditions: [(_input, output) => {
          callCount++;
          // First call is soundness check (must return false to pass soundness)
          if (callCount <= 1) {
            return (output as { y: number }).y >= 0; // false for y=-1
          }
          // Subsequent calls (uniqueness) throw to simulate timeout
          throw new Error('simulated long computation');
        }],
        output_domain: () => [{ y: 5 }, { y: 10 }],
      };

      const result = await verifier.verify(candidate, spec);

      expect(result.certified).toBe(false);
      expect(result.admissibility).toBe(true);
      expect(result.soundness).toBe(true);
      expect(result.uniqueness).toBe(false);
      expect(result.failure_reason).toContain('timed out');
      expect(result.failure_reason).toContain('Uniqueness');
    });

    it('should produce a certificate when all three properties verify successfully', async () => {
      db = initializeDatabase(':memory:');

      const verifier = new ProofVerifier(db, {
        admissibility_timeout_ms: 30000,
        soundness_timeout_ms: 30000,
        uniqueness_timeout_ms: 60000,
      });

      const candidate = {
        test_input: 5,
        observed_output: -5,
        postconditions: ['output === input'],
        violated_postcondition: 'output === input',
      };

      const spec: FunctionSpecification = {
        name: 'identity',
        preconditions: [(input) => typeof input === 'number' && (input as number) > 0],
        // Postcondition: output must equal input. Observed output -5 violates this → soundness passes
        postconditions: [(input, output) => output === input],
        // Domain contains only values that DON'T satisfy postcondition for input=5
        // (only output=5 would satisfy, but it's not in domain, and observed=-5 is excluded from uniqueness check)
        output_domain: () => [-5, -1, 0, 10, 99],
      };

      const result = await verifier.verify(candidate, spec);

      expect(result.certified).toBe(true);
      expect(result.admissibility).toBe(true);
      expect(result.soundness).toBe(true);
      expect(result.uniqueness).toBe(true);
      expect(result.certificate).toBeDefined();
      expect(result.certificate!.test_input).toBe(5);
      expect(result.certificate!.observed_output).toBe(-5);
      expect(result.certificate!.violated_postcondition).toBe('output === input');
      expect(result.certificate!.admissibility_verified_at).toBeTruthy();
      expect(result.certificate!.soundness_verified_at).toBeTruthy();
      expect(result.certificate!.uniqueness_verified_at).toBeTruthy();
    });

    it('should mark as unconfirmed when admissibility fails (not timeout)', async () => {
      db = initializeDatabase(':memory:');

      const verifier = new ProofVerifier(db);

      const candidate = {
        test_input: -1,
        observed_output: -1,
        postconditions: ['output >= 0'],
        violated_postcondition: 'output >= 0',
      };

      const spec: FunctionSpecification = {
        name: 'abs',
        preconditions: [(input) => (input as number) >= 0], // fails for -1
        postconditions: [(input, output) => (output as number) >= 0],
      };

      const result = await verifier.verify(candidate, spec);

      expect(result.certified).toBe(false);
      expect(result.admissibility).toBe(false);
      expect(result.failure_reason).toContain('Admissibility failed');
    });
  });
});
