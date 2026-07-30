import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { initializeDatabase } from '../../src/database/graph-db.js';
import {
  RepairPipeline,
  COMPILATION_TIMEOUT_MS,
  EMULATION_TIMEOUT_MS,
  TEST_EXECUTION_TIMEOUT_MS,
  type CompilationChecker,
  type CompilationResult,
  type TransitionModelEmulator,
  type EmulationResult,
  type SandboxTestExecutor,
  type TestExecutionResult,
} from '../../src/agents/repair-pipeline.js';
import type { PatchCandidate } from '../../src/types/repair.js';

function createTestPatch(overrides?: Partial<PatchCandidate>): PatchCandidate {
  return {
    id: 'patch-001',
    diff: '- old line\n+ new line',
    edit_operations: [
      {
        type: 'replace',
        node_type: 'binary_expression',
        location: {
          file_path: 'src/example.ts',
          start_line: 10,
          start_column: 0,
          end_line: 10,
          end_column: 30,
        },
      },
    ],
    target_file: 'src/example.ts',
    target_range: { start_line: 10, end_line: 10 },
    refinement_attempt: 0,
    ...overrides,
  };
}

function createPassingCompilationChecker(): CompilationChecker {
  return {
    check: async (_patch: PatchCandidate): Promise<CompilationResult> => ({
      success: true,
      errors: [],
      elapsed_ms: 50,
    }),
  };
}

function createFailingCompilationChecker(errors: string[]): CompilationChecker {
  return {
    check: async (_patch: PatchCandidate): Promise<CompilationResult> => ({
      success: false,
      errors,
      elapsed_ms: 100,
    }),
  };
}

function createPassingEmulator(): TransitionModelEmulator {
  return {
    emulate: async (_patch: PatchCandidate): Promise<EmulationResult> => ({
      success: true,
      regressions: [],
      elapsed_ms: 80,
    }),
  };
}

function createFailingEmulator(message: string): TransitionModelEmulator {
  return {
    emulate: async (_patch: PatchCandidate): Promise<EmulationResult> => ({
      success: false,
      regressions: [
        {
          transition: {
            from_state: 'stateA',
            to_state: 'stateB',
            trigger: 'event_x',
            variables: { count: 5 },
          },
          expected_state: 'stateB',
          actual_state: 'stateC',
          message,
        },
      ],
      elapsed_ms: 120,
    }),
  };
}

function createPassingTestExecutor(): SandboxTestExecutor {
  return {
    execute: async (_patch: PatchCandidate): Promise<TestExecutionResult> => ({
      success: true,
      total_tests: 42,
      passed_tests: 42,
      failed_tests: [],
      elapsed_ms: 200,
    }),
  };
}

function createFailingTestExecutor(failedTests: string[]): SandboxTestExecutor {
  return {
    execute: async (_patch: PatchCandidate): Promise<TestExecutionResult> => ({
      success: false,
      total_tests: 42,
      passed_tests: 42 - failedTests.length,
      failed_tests: failedTests,
      elapsed_ms: 300,
    }),
  };
}

function setupDbWithPatch(db: Database.Database, patchId: string): void {
  // Insert a proof certificate so we can satisfy the foreign key
  db.prepare(`
    INSERT INTO proof_certificates (id, investigation_id, test_input, observed_output, violated_postcondition, admissibility_verified_at, soundness_verified_at, uniqueness_verified_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run('proof-001', 'inv-001', '{}', '{}', 'x > 0', '2024-01-01', '2024-01-01', '2024-01-01');

  // Insert the patch record
  db.prepare(`
    INSERT INTO patches (id, proof_certificate_id, diff, edit_operations, target_file, target_range, status)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    patchId,
    'proof-001',
    '- old\n+ new',
    '[]',
    'src/example.ts',
    '{"start_line":10,"end_line":10}',
    'generated'
  );
}

describe('RepairPipeline', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initializeDatabase(':memory:');
  });

  describe('filterPatch — all stages pass', () => {
    it('should return passed=true when all stages succeed', async () => {
      const patch = createTestPatch();
      setupDbWithPatch(db, patch.id);

      const pipeline = new RepairPipeline(
        db,
        createPassingCompilationChecker(),
        createPassingEmulator(),
        createPassingTestExecutor()
      );

      const result = await pipeline.filterPatch(patch);

      expect(result.passed).toBe(true);
      expect(result.failed_stage).toBeUndefined();
      expect(result.failure_reason).toBeUndefined();
      expect(result.stage_results).toHaveLength(3);
      expect(result.stage_results[0].stage).toBe('compilation');
      expect(result.stage_results[0].passed).toBe(true);
      expect(result.stage_results[1].stage).toBe('emulation');
      expect(result.stage_results[1].passed).toBe(true);
      expect(result.stage_results[2].stage).toBe('test');
      expect(result.stage_results[2].passed).toBe(true);
    });

    it('should update patches table status to passed_filtering', async () => {
      const patch = createTestPatch();
      setupDbWithPatch(db, patch.id);

      const pipeline = new RepairPipeline(
        db,
        createPassingCompilationChecker(),
        createPassingEmulator(),
        createPassingTestExecutor()
      );

      await pipeline.filterPatch(patch);

      const row = db.prepare('SELECT status FROM patches WHERE id = ?').get(patch.id) as { status: string };
      expect(row.status).toBe('passed_filtering');
    });

    it('should report combined elapsed time from all stages', async () => {
      const patch = createTestPatch();
      setupDbWithPatch(db, patch.id);

      const pipeline = new RepairPipeline(
        db,
        createPassingCompilationChecker(),  // 50ms
        createPassingEmulator(),            // 80ms
        createPassingTestExecutor()         // 200ms
      );

      const result = await pipeline.filterPatch(patch);

      // elapsed_ms = 50 + 80 + 200 = 330
      expect(result.elapsed_ms).toBe(330);
    });
  });

  describe('filterPatch — Stage 1: Static Compilation failure', () => {
    it('should return failed_stage=compilation on compile error', async () => {
      const patch = createTestPatch();
      setupDbWithPatch(db, patch.id);

      const pipeline = new RepairPipeline(
        db,
        createFailingCompilationChecker(['TS2322: Type error at line 10']),
        createPassingEmulator(),
        createPassingTestExecutor()
      );

      const result = await pipeline.filterPatch(patch);

      expect(result.passed).toBe(false);
      expect(result.failed_stage).toBe('compilation');
      expect(result.failure_reason).toContain('TS2322');
      expect(result.elapsed_ms).toBe(100);
      // Only stage 1 should have run
      expect(result.stage_results).toHaveLength(1);
    });

    it('should update patches table with failed_compilation status', async () => {
      const patch = createTestPatch();
      setupDbWithPatch(db, patch.id);

      const pipeline = new RepairPipeline(
        db,
        createFailingCompilationChecker(['Syntax error']),
        createPassingEmulator(),
        createPassingTestExecutor()
      );

      await pipeline.filterPatch(patch);

      const row = db.prepare('SELECT status, failure_reason FROM patches WHERE id = ?').get(patch.id) as { status: string; failure_reason: string };
      expect(row.status).toBe('failed_compilation');
      expect(row.failure_reason).toContain('Syntax error');
    });

    it('should not run subsequent stages on compilation failure', async () => {
      const patch = createTestPatch();
      setupDbWithPatch(db, patch.id);

      const emulatorSpy = vi.fn().mockResolvedValue({ success: true, regressions: [], elapsed_ms: 0 });
      const testSpy = vi.fn().mockResolvedValue({ success: true, total_tests: 0, passed_tests: 0, failed_tests: [], elapsed_ms: 0 });

      const pipeline = new RepairPipeline(
        db,
        createFailingCompilationChecker(['Error']),
        { emulate: emulatorSpy },
        { execute: testSpy }
      );

      await pipeline.filterPatch(patch);

      expect(emulatorSpy).not.toHaveBeenCalled();
      expect(testSpy).not.toHaveBeenCalled();
    });
  });

  describe('filterPatch — Stage 2: M_SWT Emulation failure', () => {
    it('should return failed_stage=emulation on state transition regression', async () => {
      const patch = createTestPatch();
      setupDbWithPatch(db, patch.id);

      const pipeline = new RepairPipeline(
        db,
        createPassingCompilationChecker(),
        createFailingEmulator('State transition from stateA to stateB regressed'),
        createPassingTestExecutor()
      );

      const result = await pipeline.filterPatch(patch);

      expect(result.passed).toBe(false);
      expect(result.failed_stage).toBe('emulation');
      expect(result.failure_reason).toContain('regressed');
      expect(result.elapsed_ms).toBe(120);
      // Stages 1 and 2 should have run
      expect(result.stage_results).toHaveLength(2);
      expect(result.stage_results[0].passed).toBe(true);
      expect(result.stage_results[1].passed).toBe(false);
    });

    it('should update patches table with failed_emulation status', async () => {
      const patch = createTestPatch();
      setupDbWithPatch(db, patch.id);

      const pipeline = new RepairPipeline(
        db,
        createPassingCompilationChecker(),
        createFailingEmulator('Regression detected'),
        createPassingTestExecutor()
      );

      await pipeline.filterPatch(patch);

      const row = db.prepare('SELECT status, failure_reason FROM patches WHERE id = ?').get(patch.id) as { status: string; failure_reason: string };
      expect(row.status).toBe('failed_emulation');
      expect(row.failure_reason).toContain('Regression detected');
    });
  });

  describe('filterPatch — Stage 3: Sandbox Test Execution failure', () => {
    it('should return failed_stage=test when previously-passing tests fail', async () => {
      const patch = createTestPatch();
      setupDbWithPatch(db, patch.id);

      const pipeline = new RepairPipeline(
        db,
        createPassingCompilationChecker(),
        createPassingEmulator(),
        createFailingTestExecutor(['test_add_numbers', 'test_boundary_check'])
      );

      const result = await pipeline.filterPatch(patch);

      expect(result.passed).toBe(false);
      expect(result.failed_stage).toBe('test');
      expect(result.failure_reason).toContain('test_add_numbers');
      expect(result.failure_reason).toContain('test_boundary_check');
      expect(result.elapsed_ms).toBe(300);
      // All 3 stages should have run
      expect(result.stage_results).toHaveLength(3);
      expect(result.stage_results[2].failing_tests).toEqual(['test_add_numbers', 'test_boundary_check']);
    });

    it('should update patches table with failed_test status', async () => {
      const patch = createTestPatch();
      setupDbWithPatch(db, patch.id);

      const pipeline = new RepairPipeline(
        db,
        createPassingCompilationChecker(),
        createPassingEmulator(),
        createFailingTestExecutor(['test_foo'])
      );

      await pipeline.filterPatch(patch);

      const row = db.prepare('SELECT status FROM patches WHERE id = ?').get(patch.id) as { status: string };
      expect(row.status).toBe('failed_test');
    });
  });

  describe('filterPatch — timeout handling', () => {
    it('should timeout on compilation stage exceeding limit', async () => {
      const patch = createTestPatch();
      setupDbWithPatch(db, patch.id);

      const slowChecker: CompilationChecker = {
        check: async () => {
          // Simulate a check that takes too long
          await new Promise((resolve) => setTimeout(resolve, 200));
          return { success: true, errors: [], elapsed_ms: 200 };
        },
      };

      const pipeline = new RepairPipeline(
        db,
        slowChecker,
        createPassingEmulator(),
        createPassingTestExecutor(),
        null,
        { compilation_timeout_ms: 50, emulation_timeout_ms: EMULATION_TIMEOUT_MS, test_execution_timeout_ms: TEST_EXECUTION_TIMEOUT_MS }
      );

      const result = await pipeline.filterPatch(patch);

      expect(result.passed).toBe(false);
      expect(result.failed_stage).toBe('compilation');
      expect(result.failure_reason).toContain('timed out');
    });
  });

  describe('filterPatch — Classifier_Agent forwarding', () => {
    it('should update status to classifying when classifier is provided and all stages pass', async () => {
      const patch = createTestPatch();
      setupDbWithPatch(db, patch.id);

      // Create a mock classifier agent
      const mockClassifier = {} as any;

      const pipeline = new RepairPipeline(
        db,
        createPassingCompilationChecker(),
        createPassingEmulator(),
        createPassingTestExecutor(),
        mockClassifier
      );

      await pipeline.filterPatch(patch);

      const row = db.prepare('SELECT status FROM patches WHERE id = ?').get(patch.id) as { status: string };
      expect(row.status).toBe('classifying');
    });

    it('should update status to passed_filtering when no classifier is provided', async () => {
      const patch = createTestPatch();
      setupDbWithPatch(db, patch.id);

      const pipeline = new RepairPipeline(
        db,
        createPassingCompilationChecker(),
        createPassingEmulator(),
        createPassingTestExecutor(),
        null
      );

      await pipeline.filterPatch(patch);

      const row = db.prepare('SELECT status FROM patches WHERE id = ?').get(patch.id) as { status: string };
      // Without classifier, status remains at 'passed_filtering'
      expect(row.status).toBe('passed_filtering');
    });
  });

  describe('filterPatch — error handling', () => {
    it('should handle exceptions thrown by the compilation checker', async () => {
      const patch = createTestPatch();
      setupDbWithPatch(db, patch.id);

      const throwingChecker: CompilationChecker = {
        check: async () => {
          throw new Error('Process crashed unexpectedly');
        },
      };

      const pipeline = new RepairPipeline(
        db,
        throwingChecker,
        createPassingEmulator(),
        createPassingTestExecutor()
      );

      const result = await pipeline.filterPatch(patch);

      expect(result.passed).toBe(false);
      expect(result.failed_stage).toBe('compilation');
      expect(result.failure_reason).toContain('Process crashed unexpectedly');
    });
  });

  describe('timeout constants', () => {
    it('should define compilation timeout as 30 seconds', () => {
      expect(COMPILATION_TIMEOUT_MS).toBe(30_000);
    });

    it('should define emulation timeout as 30 seconds', () => {
      expect(EMULATION_TIMEOUT_MS).toBe(30_000);
    });

    it('should define test execution timeout as 60 seconds', () => {
      expect(TEST_EXECUTION_TIMEOUT_MS).toBe(60_000);
    });
  });
});
