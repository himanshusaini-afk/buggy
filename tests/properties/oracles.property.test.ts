import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  OracleMonitor,
  type ExecutionStep,
  type OracleConfig,
} from '../../src/agents/oracles.js';
import type {
  OracleViolation,
  TimeoutDetails,
  CrashDetails,
  DeterminismDetails,
  OverflowDetails,
} from '../../src/types/sandbox.js';

/**
 * Property 16: Oracle Violation Record Completeness
 *
 * For any oracle violation (timeout, crash, determinism, or overflow), the recorded violation
 * shall contain: oracle_id matching the oracle type, a timestamp, and type-specific details:
 * - Timeout: elapsed_duration (positive number)
 * - Crash: exception_type (string) + stack_trace (array ≤ 50 frames)
 * - Determinism: input + both differing outputs
 * - Overflow: offending_value + expected_bounds
 *
 * **Validates: Requirements 10.2, 10.3, 10.4, 10.5**
 */

// --- Helpers ---

function defaultConfig(): OracleConfig {
  return {
    timeout_threshold_seconds: 1, // 1s = 1000ms threshold
    crash_detection: true,
    overflow_detection: true,
    determinism_check_count: 2,
  };
}

function makeBaseStep(overrides: Partial<ExecutionStep> = {}): ExecutionStep {
  return {
    statement_index: 0,
    location: { file: 'test.ts', line: 1, column: 0 },
    variables: new Map(),
    timestamp: new Date().toISOString(),
    elapsed_ms: 100,
    ...overrides,
  };
}

// --- Arbitraries ---

const arbTimestamp = fc.date({
  min: new Date('2020-01-01'),
  max: new Date('2030-12-31'),
}).map(d => d.toISOString());

const arbPositiveElapsed = fc.integer({ min: 1001, max: 600_000 }); // always exceeds 1s threshold

const arbExceptionType = fc.constantFrom(
  'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError',
  'Error', 'EvalError', 'URIError', 'InternalError'
);

const arbStackFrame = fc.stringOf(
  fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.:/ '.split('')),
  { minLength: 5, maxLength: 80 }
);

// Stack trace with 0 to 100 frames (exceeding max to verify truncation)
const arbStackTrace = fc.array(arbStackFrame, { minLength: 0, maxLength: 100 });

const arbExceptionMessage = fc.string({ minLength: 1, maxLength: 200 });

const arbOutput = fc.oneof(
  fc.integer(),
  fc.string(),
  fc.boolean(),
  fc.constant(null),
  fc.record({ value: fc.integer(), label: fc.string() })
);

// Generate two outputs that are always different
const arbDifferentOutputs = fc.tuple(fc.integer(), fc.integer())
  .filter(([a, b]) => a !== b)
  .map(([a, b]) => ({ output1: a, output2: b }));

const arbNumericValue = fc.integer({ min: -1_000_000, max: 1_000_000 });
const arbBounds = fc.tuple(
  fc.integer({ min: -1_000_000, max: 0 }),
  fc.integer({ min: 1, max: 1_000_000 })
).map(([min, max]) => ({ min, max }));

const arbOperation = fc.constantFrom('add', 'subtract', 'multiply', 'shift_left', 'index');

describe('Property 16: Oracle Violation Record Completeness', () => {
  describe('Timeout violations contain oracle_id, timestamp, and elapsed_duration', () => {
    it('timeout violation has oracle_id="timeout", a timestamp, and positive elapsed_duration_ms', () => {
      fc.assert(
        fc.property(
          arbTimestamp,
          arbPositiveElapsed,
          (timestamp, elapsedMs) => {
            const config = defaultConfig();
            const monitor = new OracleMonitor(config);

            const step = makeBaseStep({
              timestamp,
              elapsed_ms: elapsedMs,
            });

            const violations = monitor.monitorStep(step);
            const timeoutViolations = violations.filter(v => v.oracle_id === 'timeout');

            // Must detect a timeout since elapsed exceeds threshold
            expect(timeoutViolations.length).toBeGreaterThanOrEqual(1);

            const violation = timeoutViolations[0];

            // oracle_id must match the type
            expect(violation.oracle_id).toBe('timeout');

            // timestamp must be present and match the step's timestamp
            expect(violation.timestamp).toBe(timestamp);
            expect(typeof violation.timestamp).toBe('string');
            expect(violation.timestamp.length).toBeGreaterThan(0);

            // Type-specific details: elapsed_duration_ms must be positive
            const details = violation.details as TimeoutDetails;
            expect(details.elapsed_duration_ms).toBe(elapsedMs);
            expect(details.elapsed_duration_ms).toBeGreaterThan(0);
            expect(details.configured_limit_ms).toBeGreaterThan(0);
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe('Crash violations contain oracle_id, timestamp, exception_type, and stack_trace ≤ 50 frames', () => {
    it('crash violation has oracle_id="crash", timestamp, exception_type string, and stack_trace ≤ 50 frames', () => {
      fc.assert(
        fc.property(
          arbTimestamp,
          arbExceptionType,
          arbExceptionMessage,
          arbStackTrace,
          (timestamp, exceptionType, message, stackTrace) => {
            const config = defaultConfig();
            const monitor = new OracleMonitor(config);

            const step = makeBaseStep({
              timestamp,
              elapsed_ms: 50, // below timeout threshold
              exception: {
                type: exceptionType,
                message,
                stack_trace: stackTrace,
              },
            });

            const violations = monitor.monitorStep(step);
            const crashViolations = violations.filter(v => v.oracle_id === 'crash');

            // Must detect a crash
            expect(crashViolations.length).toBe(1);

            const violation = crashViolations[0];

            // oracle_id must match the type
            expect(violation.oracle_id).toBe('crash');

            // timestamp must be present and match the step's timestamp
            expect(violation.timestamp).toBe(timestamp);
            expect(typeof violation.timestamp).toBe('string');
            expect(violation.timestamp.length).toBeGreaterThan(0);

            // Type-specific details
            const details = violation.details as CrashDetails;

            // exception_type must be a non-empty string
            expect(typeof details.exception_type).toBe('string');
            expect(details.exception_type).toBe(exceptionType);
            expect(details.exception_type.length).toBeGreaterThan(0);

            // stack_trace must be an array with ≤ 50 frames
            expect(Array.isArray(details.stack_trace)).toBe(true);
            expect(details.stack_trace.length).toBeLessThanOrEqual(50);

            // If input had more than 50 frames, it should be truncated to 50
            if (stackTrace.length > 50) {
              expect(details.stack_trace.length).toBe(50);
            } else {
              expect(details.stack_trace.length).toBe(stackTrace.length);
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe('Determinism violations contain oracle_id, timestamp, input, and both differing outputs', () => {
    it('determinism violation has oracle_id="determinism", timestamp, input, and two different outputs', () => {
      fc.assert(
        fc.property(
          arbTimestamp,
          fc.integer({ min: 0, max: 1000 }),
          arbDifferentOutputs,
          (timestamp, statementIndex, outputs) => {
            const config = defaultConfig();
            const monitor = new OracleMonitor(config);

            // First execution: provide one output
            const step1 = makeBaseStep({
              statement_index: statementIndex,
              timestamp,
              elapsed_ms: 50,
              output: outputs.output1,
            });
            monitor.monitorStep(step1);

            // Second execution: provide a different output at same statement_index
            const step2 = makeBaseStep({
              statement_index: statementIndex,
              timestamp,
              elapsed_ms: 50,
              output: outputs.output2,
            });
            const violations = monitor.monitorStep(step2);
            const detViolations = violations.filter(v => v.oracle_id === 'determinism');

            // Must detect a determinism violation
            expect(detViolations.length).toBe(1);

            const violation = detViolations[0];

            // oracle_id must match the type
            expect(violation.oracle_id).toBe('determinism');

            // timestamp must be present
            expect(violation.timestamp).toBe(timestamp);
            expect(typeof violation.timestamp).toBe('string');
            expect(violation.timestamp.length).toBeGreaterThan(0);

            // Type-specific details: input + both outputs
            const details = violation.details as DeterminismDetails;

            // input must be present (statement_index used as identifier)
            expect(details.input).toBe(statementIndex);

            // Both outputs must be present and different
            expect(details.output_1).toBe(outputs.output1);
            expect(details.output_2).toBe(outputs.output2);
            expect(details.output_1).not.toEqual(details.output_2);
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe('Overflow violations contain oracle_id, timestamp, offending_value, and expected_bounds', () => {
    it('overflow violation has oracle_id="overflow", timestamp, offending_value, and expected_bounds (min/max)', () => {
      fc.assert(
        fc.property(
          arbTimestamp,
          arbBounds,
          arbOperation,
          fc.boolean(),
          (timestamp, bounds, operation, exceedsMax) => {
            const config = defaultConfig();
            const monitor = new OracleMonitor(config);

            // Generate an offending value that is outside bounds
            const offendingValue = exceedsMax
              ? bounds.max + 1 + Math.floor(Math.random() * 100)
              : bounds.min - 1 - Math.floor(Math.random() * 100);

            const step = makeBaseStep({
              timestamp,
              elapsed_ms: 50,
              numeric_values: [
                {
                  name: 'val',
                  value: offendingValue,
                  min: bounds.min,
                  max: bounds.max,
                  operation,
                },
              ],
            });

            const violations = monitor.monitorStep(step);
            const overflowViolations = violations.filter(v => v.oracle_id === 'overflow');

            // Must detect an overflow violation
            expect(overflowViolations.length).toBe(1);

            const violation = overflowViolations[0];

            // oracle_id must match the type
            expect(violation.oracle_id).toBe('overflow');

            // timestamp must be present
            expect(violation.timestamp).toBe(timestamp);
            expect(typeof violation.timestamp).toBe('string');
            expect(violation.timestamp.length).toBeGreaterThan(0);

            // Type-specific details: offending_value + expected_bounds
            const details = violation.details as OverflowDetails;

            // offending_value must be present and outside bounds
            expect(details.offending_value).toBe(offendingValue);
            expect(
              details.offending_value < bounds.min || details.offending_value > bounds.max
            ).toBe(true);

            // expected_bounds must contain min and max
            expect(details.expected_bounds).toBeDefined();
            expect(typeof details.expected_bounds.min).toBe('number');
            expect(typeof details.expected_bounds.max).toBe('number');
            expect(details.expected_bounds.min).toBe(bounds.min);
            expect(details.expected_bounds.max).toBe(bounds.max);
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
