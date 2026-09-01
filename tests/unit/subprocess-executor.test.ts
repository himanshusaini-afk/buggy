/**
 * Unit tests for SubprocessExecutor — the real code execution engine.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { SubprocessExecutor } from '../../src/sandbox/subprocess-executor.js';

describe('SubprocessExecutor', () => {
  const executor = new SubprocessExecutor({ timeout: 5000 });

  afterAll(() => {
    executor.cleanup();
  });

  it('should execute a simple addition function with multiple args', async () => {
    const result = await executor.execute({
      functionCode: 'function add(a, b) { return a + b; }',
      functionName: 'add',
      input: [2, 3],
      timeout: 5000,
    });

    expect(result.success).toBe(true);
    expect(result.output).toBe(5);
    expect(result.timedOut).toBe(false);
    expect(result.crashed).toBe(false);
    expect(result.duration_ms).toBeGreaterThan(0);
  });

  it('should detect a function that throws an exception', async () => {
    const result = await executor.execute({
      functionCode: `function explode() { throw new TypeError("boom"); }`,
      functionName: 'explode',
      input: [],
      timeout: 5000,
    });

    expect(result.success).toBe(false);
    expect(result.crashed).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.error).toContain('boom');
    expect(result.exceptionType).toBe('TypeError');
  });

  it('should detect a function that times out (infinite loop)', async () => {
    const result = await executor.execute({
      functionCode: 'function hang() { while (true) {} }',
      functionName: 'hang',
      input: [],
      timeout: 1000, // 1 second timeout
    });

    expect(result.success).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.crashed).toBe(false);
    expect(result.duration_ms).toBeGreaterThanOrEqual(900); // Should be close to timeout
  });

  it('should correctly return NaN for mean of empty array', async () => {
    const result = await executor.execute({
      functionCode: `function mean(arr) {
        let sum = 0;
        for (const x of arr) sum += x;
        return sum / arr.length;
      }`,
      functionName: 'mean',
      input: [[]],  // Pass empty array as first arg
      timeout: 5000,
    });

    expect(result.success).toBe(true);
    // NaN is preserved via the __NaN__ sentinel and restored to a real NaN
    expect(typeof result.output).toBe('number');
    expect(Number.isNaN(result.output)).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.crashed).toBe(false);
  });

  it('should handle single argument inputs', async () => {
    const result = await executor.execute({
      functionCode: 'function double(x) { return x * 2; }',
      functionName: 'double',
      input: [7],
      timeout: 5000,
    });

    expect(result.success).toBe(true);
    expect(result.output).toBe(14);
  });

  it('should handle async functions', async () => {
    const result = await executor.execute({
      functionCode: 'async function delayed(x) { return x + 1; }',
      functionName: 'delayed',
      input: [41],
      timeout: 5000,
    });

    expect(result.success).toBe(true);
    expect(result.output).toBe(42);
  });

  it('should executeMultiple for determinism checking', async () => {
    const results = await executor.executeMultiple(
      {
        functionCode: 'function identity(x) { return x; }',
        functionName: 'identity',
        input: [42],
        timeout: 5000,
      },
      3,
    );

    expect(results).toHaveLength(3);
    for (const r of results) {
      expect(r.success).toBe(true);
      expect(r.output).toBe(42);
    }
  });
});
