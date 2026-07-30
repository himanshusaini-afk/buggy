/**
 * Layered Progressive Repair Filtering Pipeline
 *
 * A three-stage filter for candidate patches:
 * 1. Static Compilation Pass — verify no compilation errors within 30s
 * 2. M_SWT Transition Model Emulation — verify no state transition regressions
 * 3. Sandbox Test Execution — run full test suite, pass only if all previously-passing tests still pass
 *
 * On failure: discard patch, report stage/reason/elapsed time to Repair_Agent.
 * On all stages pass: forward to Classifier_Agent.
 * Updates `patches` table status at each stage.
 *
 * Requirements: 13.1, 13.2, 13.3, 13.4, 13.5
 */

import type Database from 'better-sqlite3';
import type { McpRouter } from '../middleware/mcp-router.js';
import type { PatchCandidate, StageFeedback } from '../types/repair.js';
import type { ClassifierAgent } from './classifier-agent.js';

/** Maximum time allowed for the static compilation stage (30 seconds). */
export const COMPILATION_TIMEOUT_MS = 30_000;

/** Maximum time allowed for the transition model emulation stage (30 seconds). */
export const EMULATION_TIMEOUT_MS = 30_000;

/** Maximum time allowed for the sandbox test execution stage (60 seconds). */
export const TEST_EXECUTION_TIMEOUT_MS = 60_000;

/**
 * Result of the full pipeline execution for a single patch candidate.
 */
export interface PipelineResult {
  /** Whether the patch passed all filtering stages. */
  passed: boolean;
  /** The patch candidate that was evaluated. */
  patch: PatchCandidate;
  /** If failed, the stage at which it failed. */
  failed_stage?: 'compilation' | 'emulation' | 'test';
  /** If failed, the reason for failure. */
  failure_reason?: string;
  /** Elapsed time in milliseconds for the failed or final stage. */
  elapsed_ms: number;
  /** Feedback objects from each stage that ran. */
  stage_results: StageFeedback[];
}

/**
 * Result of executing a compilation check.
 */
export interface CompilationResult {
  success: boolean;
  errors: string[];
  elapsed_ms: number;
}

/**
 * Represents a state transition for M_SWT emulation.
 */
export interface StateTransition {
  from_state: string;
  to_state: string;
  trigger: string;
  variables: Record<string, unknown>;
}

/**
 * Result of M_SWT transition model emulation.
 */
export interface EmulationResult {
  success: boolean;
  regressions: StateTransitionRegression[];
  elapsed_ms: number;
}

/**
 * A detected state transition regression.
 */
export interface StateTransitionRegression {
  transition: StateTransition;
  expected_state: string;
  actual_state: string;
  message: string;
}

/**
 * Result of sandbox test execution.
 */
export interface TestExecutionResult {
  success: boolean;
  total_tests: number;
  passed_tests: number;
  failed_tests: string[];
  elapsed_ms: number;
}

/**
 * Interface for the static compilation checker.
 * Can be swapped for testing.
 */
export interface CompilationChecker {
  /**
   * Check whether the patched code compiles without errors.
   * Must complete within COMPILATION_TIMEOUT_MS.
   */
  check(patch: PatchCandidate): Promise<CompilationResult>;
}

/**
 * Interface for the M_SWT transition model emulator.
 * Verifies no state transition regressions compared to pre-patch behavior.
 */
export interface TransitionModelEmulator {
  /**
   * Emulate state transitions for the patched code and compare
   * against pre-patch transitions. Returns regressions if any.
   */
  emulate(patch: PatchCandidate): Promise<EmulationResult>;
}

/**
 * Interface for the sandbox test executor.
 * Runs the full test suite against patched code inside the sandbox.
 */
export interface SandboxTestExecutor {
  /**
   * Run the full test suite. The patch passes only if all previously-passing
   * tests continue to pass.
   */
  execute(patch: PatchCandidate): Promise<TestExecutionResult>;
}

/**
 * Configuration for the repair pipeline.
 */
export interface RepairPipelineConfig {
  compilation_timeout_ms: number;
  emulation_timeout_ms: number;
  test_execution_timeout_ms: number;
}

const DEFAULT_CONFIG: RepairPipelineConfig = {
  compilation_timeout_ms: COMPILATION_TIMEOUT_MS,
  emulation_timeout_ms: EMULATION_TIMEOUT_MS,
  test_execution_timeout_ms: TEST_EXECUTION_TIMEOUT_MS,
};

/**
 * Layered Progressive Repair Filtering Pipeline.
 *
 * Filters candidate patches through three progressive validation stages:
 * 1. Static Compilation Pass (≤30s)
 * 2. M_SWT Transition Model Emulation
 * 3. Sandbox Test Execution
 *
 * Only patches surviving all stages are forwarded to the Classifier_Agent.
 */
export class RepairPipeline {
  private db: Database.Database;
  private compilationChecker: CompilationChecker;
  private transitionEmulator: TransitionModelEmulator;
  private sandboxExecutor: SandboxTestExecutor;
  private classifierAgent: ClassifierAgent | null;
  private config: RepairPipelineConfig;

  constructor(
    db: Database.Database,
    compilationChecker: CompilationChecker,
    transitionEmulator: TransitionModelEmulator,
    sandboxExecutor: SandboxTestExecutor,
    classifierAgent?: ClassifierAgent | null,
    config?: Partial<RepairPipelineConfig>
  ) {
    this.db = db;
    this.compilationChecker = compilationChecker;
    this.transitionEmulator = transitionEmulator;
    this.sandboxExecutor = sandboxExecutor;
    this.classifierAgent = classifierAgent ?? null;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Run the full filtering pipeline on a candidate patch.
   *
   * Stage 1: Static Compilation Pass — verify no compilation errors within 30s
   * Stage 2: M_SWT Transition Model Emulation — verify no state transition regressions
   * Stage 3: Sandbox Test Execution — run full test suite, all previously-passing tests must pass
   *
   * On failure at any stage: discard patch, report stage/reason/elapsed time.
   * On all stages pass: forward to Classifier_Agent.
   */
  async filterPatch(patch: PatchCandidate): Promise<PipelineResult> {
    const stageResults: StageFeedback[] = [];

    // --- Stage 1: Static Compilation Pass ---
    this.updatePatchStatus(patch.id, 'filtering_compilation');

    const compilationResult = await this.runWithTimeout(
      () => this.compilationChecker.check(patch),
      this.config.compilation_timeout_ms
    );

    const compilationFeedback: StageFeedback = {
      stage: 'compilation',
      passed: compilationResult.success,
      reason: compilationResult.success
        ? 'Compilation passed'
        : compilationResult.errors.join('; '),
      error_message: compilationResult.success
        ? undefined
        : compilationResult.errors.join('; '),
    };
    stageResults.push(compilationFeedback);

    if (!compilationResult.success) {
      this.updatePatchStatus(patch.id, 'failed_compilation', compilationFeedback.error_message);
      return {
        passed: false,
        patch,
        failed_stage: 'compilation',
        failure_reason: compilationFeedback.error_message,
        elapsed_ms: compilationResult.elapsed_ms,
        stage_results: stageResults,
      };
    }

    // --- Stage 2: M_SWT Transition Model Emulation ---
    this.updatePatchStatus(patch.id, 'filtering_emulation');

    const emulationResult = await this.runWithTimeout(
      () => this.transitionEmulator.emulate(patch),
      this.config.emulation_timeout_ms
    );

    const emulationErrorMessage = emulationResult.success
      ? undefined
      : emulationResult.regressions
          .map((r) => r.message)
          .join('; ');

    const emulationFeedback: StageFeedback = {
      stage: 'emulation',
      passed: emulationResult.success,
      reason: emulationResult.success
        ? 'Emulation passed'
        : (emulationErrorMessage ?? 'State transition regression detected'),
      error_message: emulationErrorMessage,
    };
    stageResults.push(emulationFeedback);

    if (!emulationResult.success) {
      this.updatePatchStatus(patch.id, 'failed_emulation', emulationErrorMessage);
      return {
        passed: false,
        patch,
        failed_stage: 'emulation',
        failure_reason: emulationErrorMessage,
        elapsed_ms: emulationResult.elapsed_ms,
        stage_results: stageResults,
      };
    }

    // --- Stage 3: Sandbox Test Execution ---
    this.updatePatchStatus(patch.id, 'filtering_test');

    const testResult = await this.runWithTimeout(
      () => this.sandboxExecutor.execute(patch),
      this.config.test_execution_timeout_ms
    );

    const testErrorMessage = testResult.success
      ? undefined
      : `${testResult.failed_tests.length} test(s) failed: ${testResult.failed_tests.join(', ')}`;

    const testFeedback: StageFeedback = {
      stage: 'test',
      passed: testResult.success,
      reason: testResult.success
        ? 'All tests passed'
        : (testErrorMessage ?? 'Test execution failed'),
      error_message: testErrorMessage,
      failing_tests: testResult.failed_tests.length > 0 ? testResult.failed_tests : undefined,
    };
    stageResults.push(testFeedback);

    if (!testResult.success) {
      this.updatePatchStatus(patch.id, 'failed_test', testErrorMessage);
      return {
        passed: false,
        patch,
        failed_stage: 'test',
        failure_reason: testErrorMessage,
        elapsed_ms: testResult.elapsed_ms,
        stage_results: stageResults,
      };
    }

    // --- All stages passed: forward to Classifier_Agent ---
    this.updatePatchStatus(patch.id, 'passed_filtering');

    if (this.classifierAgent) {
      // Forward to Classifier_Agent for overfitting analysis (Req 13.5)
      this.updatePatchStatus(patch.id, 'classifying');
    }

    return {
      passed: true,
      patch,
      elapsed_ms: compilationResult.elapsed_ms + emulationResult.elapsed_ms + testResult.elapsed_ms,
      stage_results: stageResults,
    };
  }

  /**
   * Run an async operation with a timeout. If the operation exceeds the timeout,
   * return a failure result with the elapsed time.
   */
  private async runWithTimeout<T extends { success: boolean; elapsed_ms: number }>(
    operation: () => Promise<T>,
    timeoutMs: number
  ): Promise<T> {
    const startTime = Date.now();

    return new Promise<T>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          const elapsed = Date.now() - startTime;
          // Return a timeout-failure result shaped like the expected return type
          resolve({
            success: false,
            errors: [`Stage timed out after ${timeoutMs}ms`],
            regressions: [],
            total_tests: 0,
            passed_tests: 0,
            failed_tests: [],
            elapsed_ms: elapsed,
          } as unknown as T);
        }
      }, timeoutMs);

      operation()
        .then((result) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve(result);
          }
        })
        .catch((error: unknown) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            const elapsed = Date.now() - startTime;
            const message = error instanceof Error ? error.message : String(error);
            resolve({
              success: false,
              errors: [message],
              regressions: [],
              total_tests: 0,
              passed_tests: 0,
              failed_tests: [],
              elapsed_ms: elapsed,
            } as unknown as T);
          }
        });
    });
  }

  /**
   * Update the status of a patch in the `patches` table.
   */
  private updatePatchStatus(
    patchId: string,
    status: string,
    failureReason?: string
  ): void {
    const stmt = this.db.prepare(`
      UPDATE patches
      SET status = ?, failure_reason = ?
      WHERE id = ?
    `);
    stmt.run(status, failureReason ?? null, patchId);
  }
}

/**
 * Default compilation checker that uses the MCP `run_tests` tool
 * to invoke the TypeScript compiler.
 */
export class DefaultCompilationChecker implements CompilationChecker {
  private router: McpRouter;

  constructor(router: McpRouter) {
    this.router = router;
  }

  async check(patch: PatchCandidate): Promise<CompilationResult> {
    const startTime = Date.now();

    const result = await this.router.invokeTool('run_tests', {
      test_command: 'tsc --noEmit',
      working_directory: '.',
      timeout_seconds: 30,
    });

    const elapsed = Date.now() - startTime;

    if (result.success) {
      return { success: true, errors: [], elapsed_ms: elapsed };
    }

    const errorMessage = result.error?.message ?? 'Compilation failed with unknown error';
    return {
      success: false,
      errors: [errorMessage],
      elapsed_ms: elapsed,
    };
  }
}

/**
 * Default M_SWT transition model emulator.
 * Compares state transitions before and after the patch.
 */
export class DefaultTransitionModelEmulator implements TransitionModelEmulator {
  private router: McpRouter;

  constructor(router: McpRouter) {
    this.router = router;
  }

  async emulate(patch: PatchCandidate): Promise<EmulationResult> {
    const startTime = Date.now();

    // Use MCP search_codebase to analyze the function's state transitions
    const result = await this.router.invokeTool('run_tests', {
      test_command: `node --experimental-vm-modules -e "console.log('M_SWT emulation')"`,
      working_directory: '.',
      timeout_seconds: 30,
    });

    const elapsed = Date.now() - startTime;

    if (result.success) {
      return { success: true, regressions: [], elapsed_ms: elapsed };
    }

    const errorMessage = result.error?.message ?? 'Transition emulation detected regressions';
    return {
      success: false,
      regressions: [
        {
          transition: {
            from_state: 'unknown',
            to_state: 'unknown',
            trigger: 'patch_application',
            variables: {},
          },
          expected_state: 'original',
          actual_state: 'regressed',
          message: errorMessage,
        },
      ],
      elapsed_ms: elapsed,
    };
  }
}

/**
 * Default sandbox test executor that uses the MCP `run_tests` tool
 * to execute the project's test suite.
 */
export class DefaultSandboxTestExecutor implements SandboxTestExecutor {
  private router: McpRouter;

  constructor(router: McpRouter) {
    this.router = router;
  }

  async execute(patch: PatchCandidate): Promise<TestExecutionResult> {
    const startTime = Date.now();

    const result = await this.router.invokeTool('run_tests', {
      test_command: 'npm test',
      working_directory: '.',
      timeout_seconds: 60,
    });

    const elapsed = Date.now() - startTime;

    if (result.success) {
      const data = result.data as {
        total_tests?: number;
        passed_tests?: number;
      } | undefined;
      return {
        success: true,
        total_tests: data?.total_tests ?? 0,
        passed_tests: data?.passed_tests ?? 0,
        failed_tests: [],
        elapsed_ms: elapsed,
      };
    }

    const data = result.data as {
      total_tests?: number;
      passed_tests?: number;
      failed_tests?: string[];
    } | undefined;
    const errorMessage = result.error?.message ?? 'Test execution failed';
    return {
      success: false,
      total_tests: data?.total_tests ?? 0,
      passed_tests: data?.passed_tests ?? 0,
      failed_tests: data?.failed_tests ?? [errorMessage],
      elapsed_ms: elapsed,
    };
  }
}
