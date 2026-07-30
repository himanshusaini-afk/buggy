/**
 * Semantic Oracle Monitoring Framework
 *
 * Implements 4 runtime oracles that monitor execution steps for specific failure classes:
 * - TimeoutOracle: Detects execution exceeding configured time limits
 * - CrashOracle: Detects unhandled exceptions and process crashes
 * - DeterminismOracle: Detects non-deterministic behavior across repeated executions
 * - OverflowOracle: Detects integer/buffer overflow conditions
 *
 * Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6
 */

import type Database from 'better-sqlite3';
import type {
  OracleViolation,
  OracleType,
  TimeoutDetails,
  CrashDetails,
  DeterminismDetails,
  OverflowDetails,
} from '../types/sandbox.js';

/**
 * Source location for an execution step.
 */
export interface SourceLocation {
  file: string;
  line: number;
  column: number;
}

/**
 * Represents a single execution step monitored by the oracles.
 */
export interface ExecutionStep {
  statement_index: number;
  location: SourceLocation;
  variables: Map<string, unknown>;
  timestamp: string;
  elapsed_ms: number;
  output?: unknown;
  exception?: { type: string; message: string; stack_trace: string[] };
  numeric_values?: Array<{ name: string; value: number; min: number; max: number; operation: string }>;
}

/**
 * Configuration for the oracle monitoring system.
 */
export interface OracleConfig {
  timeout_threshold_seconds: number;
  crash_detection: boolean;
  overflow_detection: boolean;
  determinism_check_count: number;
}

/**
 * Internal oracle interface. Each oracle checks a single execution step
 * and returns a violation if one is detected, or null otherwise.
 */
interface Oracle {
  type: OracleType;
  enabled: boolean;
  check(step: ExecutionStep): OracleViolation | null;
  onFailure(): void;
}

/**
 * Persists oracle violations to the `oracle_violations` table in the graph database.
 * Generates unique IDs for each violation record and serializes details as JSON.
 */
export class OracleViolationStore {
  private readonly db: Database.Database;
  private idCounter = 0;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /**
   * Store a violation in the oracle_violations table.
   * @param executionId - The execution session ID this violation belongs to
   * @param violation - The violation to persist
   */
  storeViolation(executionId: string, violation: OracleViolation): void {
    const id = `ov_${executionId}_${Date.now()}_${this.idCounter++}`;
    this.db
      .prepare(
        `INSERT INTO oracle_violations (id, execution_id, oracle_type, timestamp, details, created_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'))`
      )
      .run(
        id,
        executionId,
        violation.oracle_id,
        violation.timestamp,
        JSON.stringify(violation.details)
      );
  }

  /**
   * Store multiple violations in a single transaction for efficiency.
   * @param executionId - The execution session ID these violations belong to
   * @param violations - The violations to persist
   */
  storeViolations(executionId: string, violations: OracleViolation[]): void {
    if (violations.length === 0) return;

    const insertStmt = this.db.prepare(
      `INSERT INTO oracle_violations (id, execution_id, oracle_type, timestamp, details, created_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))`
    );

    const insertMany = this.db.transaction((items: OracleViolation[]) => {
      for (const violation of items) {
        const id = `ov_${executionId}_${Date.now()}_${this.idCounter++}`;
        insertStmt.run(
          id,
          executionId,
          violation.oracle_id,
          violation.timestamp,
          JSON.stringify(violation.details)
        );
      }
    });

    insertMany(violations);
  }

  /**
   * Retrieve all violations for a given execution session.
   * @param executionId - The execution session ID to query
   */
  getViolationsByExecution(executionId: string): OracleViolation[] {
    const rows = this.db
      .prepare(
        `SELECT oracle_type, timestamp, details FROM oracle_violations WHERE execution_id = ? ORDER BY created_at`
      )
      .all(executionId) as Array<{ oracle_type: string; timestamp: string; details: string }>;

    return rows.map((row) => ({
      oracle_id: row.oracle_type as OracleType,
      timestamp: row.timestamp,
      details: JSON.parse(row.details),
    }));
  }
}

/**
 * The OracleMonitor manages a set of oracles, monitoring each execution step
 * and collecting violations. If an oracle encounters an internal failure,
 * it is disabled and monitoring continues with the remaining oracles.
 *
 * Optionally persists violations to the database via an OracleViolationStore.
 */
export class OracleMonitor {
  private oracles: Oracle[];
  private violations: OracleViolation[];
  private store: OracleViolationStore | null;
  private executionId: string | null;

  constructor(config: OracleConfig, store?: OracleViolationStore) {
    this.violations = [];
    this.store = store ?? null;
    this.executionId = null;

    const timeoutThresholdMs = config.timeout_threshold_seconds * 1000;

    this.oracles = [
      new TimeoutOracle(timeoutThresholdMs),
      ...(config.crash_detection ? [new CrashOracle()] : []),
      new DeterminismOracle(config.determinism_check_count),
      ...(config.overflow_detection ? [new OverflowOracle()] : []),
    ];
  }

  /**
   * Set the execution ID for the current monitoring session.
   * Violations will be persisted under this ID if a store is configured.
   */
  setExecutionId(executionId: string): void {
    this.executionId = executionId;
  }

  /**
   * Monitor a single execution step. Returns any violations detected at this step.
   * If an oracle throws internally, it is disabled and monitoring continues.
   * Violations are persisted to the database if a store and execution ID are configured.
   */
  monitorStep(step: ExecutionStep): OracleViolation[] {
    const stepViolations: OracleViolation[] = [];

    for (const oracle of this.oracles) {
      if (!oracle.enabled) {
        continue;
      }

      try {
        const violation = oracle.check(step);
        if (violation !== null) {
          stepViolations.push(violation);
        }
      } catch (error) {
        // Requirement 10.6: Log error, disable failing oracle, continue with remaining
        console.error(
          `[OracleMonitor] Internal failure in ${oracle.type} oracle:`,
          error instanceof Error ? error.message : String(error)
        );
        oracle.onFailure();
      }
    }

    this.violations.push(...stepViolations);

    // Persist violations to the database if store is configured
    if (this.store && this.executionId && stepViolations.length > 0) {
      try {
        this.store.storeViolations(this.executionId, stepViolations);
      } catch (error) {
        console.error(
          '[OracleMonitor] Failed to persist violations:',
          error instanceof Error ? error.message : String(error)
        );
      }
    }

    return stepViolations;
  }

  /**
   * Get all recorded violations across all monitored steps.
   */
  getViolations(): OracleViolation[] {
    return [...this.violations];
  }

  /**
   * Get the list of currently active (enabled) oracles.
   */
  getActiveOracles(): OracleType[] {
    return this.oracles.filter((o) => o.enabled).map((o) => o.type);
  }

  /**
   * Reset the monitor for a new execution. Re-enables all oracles and clears violations.
   */
  reset(): void {
    this.violations = [];
    this.executionId = null;
    for (const oracle of this.oracles) {
      oracle.enabled = true;
    }
    // Reset determinism oracle's output tracking
    const determinismOracle = this.oracles.find(
      (o) => o.type === 'determinism'
    ) as DeterminismOracle | undefined;
    if (determinismOracle) {
      determinismOracle.resetOutputs();
    }
  }
}

/**
 * TimeoutOracle: Detects execution steps where elapsed_ms exceeds the configured threshold.
 *
 * Records: oracle_id, timestamp, elapsed_duration_ms, configured_limit_ms.
 * Requirement 10.2
 */
class TimeoutOracle implements Oracle {
  readonly type: OracleType = 'timeout';
  enabled = true;
  private readonly thresholdMs: number;

  constructor(thresholdMs: number) {
    this.thresholdMs = thresholdMs;
  }

  check(step: ExecutionStep): OracleViolation | null {
    if (step.elapsed_ms > this.thresholdMs) {
      const details: TimeoutDetails = {
        elapsed_duration_ms: step.elapsed_ms,
        configured_limit_ms: this.thresholdMs,
      };
      return {
        oracle_id: this.type,
        timestamp: step.timestamp,
        details,
      };
    }
    return null;
  }

  onFailure(): void {
    this.enabled = false;
  }
}

/**
 * CrashOracle: Detects execution steps with non-null exceptions.
 * Captures stack_trace limited to 50 frames maximum.
 *
 * Records: oracle_id, timestamp, exception_type, stack_trace, message.
 * Requirement 10.3
 */
class CrashOracle implements Oracle {
  readonly type: OracleType = 'crash';
  enabled = true;

  private static readonly MAX_STACK_FRAMES = 50;

  check(step: ExecutionStep): OracleViolation | null {
    if (step.exception != null) {
      const stackTrace = step.exception.stack_trace.slice(
        0,
        CrashOracle.MAX_STACK_FRAMES
      );

      const details: CrashDetails = {
        exception_type: step.exception.type,
        stack_trace: stackTrace,
        message: step.exception.message,
      };
      return {
        oracle_id: this.type,
        timestamp: step.timestamp,
        details,
      };
    }
    return null;
  }

  onFailure(): void {
    this.enabled = false;
  }
}

/**
 * DeterminismOracle: Detects differing outputs across repeated executions
 * with identical inputs. Tracks outputs per statement_index and flags
 * a violation when outputs differ across a minimum of 2 executions.
 *
 * Records: oracle_id, timestamp, input (statement_index used as identifier), both outputs.
 * Requirement 10.4
 */
class DeterminismOracle implements Oracle {
  readonly type: OracleType = 'determinism';
  enabled = true;

  private readonly checkCount: number;
  /** Map from statement_index to array of observed outputs */
  private outputHistory: Map<number, unknown[]>;

  constructor(checkCount: number) {
    this.checkCount = Math.max(2, checkCount);
    this.outputHistory = new Map();
  }

  check(step: ExecutionStep): OracleViolation | null {
    if (step.output === undefined) {
      return null;
    }

    const history = this.outputHistory.get(step.statement_index) ?? [];
    history.push(step.output);
    this.outputHistory.set(step.statement_index, history);

    // Only check for determinism violations when we have at least 2 executions
    if (history.length >= 2) {
      const firstOutput = history[0];
      const latestOutput = history[history.length - 1];

      if (!this.deepEqual(firstOutput, latestOutput)) {
        const details: DeterminismDetails = {
          input: step.statement_index,
          output_1: firstOutput,
          output_2: latestOutput,
        };
        return {
          oracle_id: this.type,
          timestamp: step.timestamp,
          details,
        };
      }
    }

    return null;
  }

  onFailure(): void {
    this.enabled = false;
  }

  /**
   * Reset the output history for a new execution session.
   */
  resetOutputs(): void {
    this.outputHistory = new Map();
  }

  /**
   * Simple deep equality check for comparing outputs.
   */
  private deepEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (a === null || b === null) return false;
    if (typeof a !== typeof b) return false;

    if (typeof a === 'object' && typeof b === 'object') {
      try {
        return JSON.stringify(a) === JSON.stringify(b);
      } catch {
        return false;
      }
    }

    return false;
  }
}

/**
 * OverflowOracle: Detects numeric values that fall outside their expected bounds
 * (value < min or value > max), indicating integer or buffer overflow conditions.
 *
 * Records: oracle_id, timestamp, offending_value, expected_bounds, operation.
 * Requirement 10.5
 */
class OverflowOracle implements Oracle {
  readonly type: OracleType = 'overflow';
  enabled = true;

  check(step: ExecutionStep): OracleViolation | null {
    if (!step.numeric_values || step.numeric_values.length === 0) {
      return null;
    }

    for (const numericValue of step.numeric_values) {
      if (numericValue.value < numericValue.min || numericValue.value > numericValue.max) {
        const details: OverflowDetails = {
          offending_value: numericValue.value,
          expected_bounds: { min: numericValue.min, max: numericValue.max },
          operation: numericValue.operation,
        };
        return {
          oracle_id: this.type,
          timestamp: step.timestamp,
          details,
        };
      }
    }

    return null;
  }

  onFailure(): void {
    this.enabled = false;
  }
}
