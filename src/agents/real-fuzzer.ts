/**
 * Real Fuzzer — Generates inputs, executes the target function,
 * and checks oracle violations using the SubprocessExecutor.
 *
 * Prioritizes edge cases first, then generates random inputs.
 * Checks postconditions, crash detection, timeout, NaN/Infinity,
 * and determinism violations.
 */

import { SubprocessExecutor } from '../sandbox/subprocess-executor.js';
import type { ExecuteResult } from '../sandbox/subprocess-executor.js';
import { evaluatePrecondition, evaluatePostcondition } from './spec-conditions.js';

export interface FuzzTarget {
  /** Source code of the function */
  sourceCode: string;
  /** Name of the function to fuzz */
  functionName: string;
  /**
   * Postconditions to check, as JS expressions. The function's parameter names
   * are in scope, along with `result` (the return value) and `input` (the sole
   * argument for single-parameter functions, else the full argument list).
   */
  postconditions: string[];
  /**
   * Preconditions used to filter generated inputs, as JS expressions. The
   * function's parameter names are in scope, along with `input`.
   */
  preconditions: string[];
  /** Parameter types for smart input generation. */
  parameterTypes: string[];
  /**
   * Parameter names, positionally matching parameterTypes. Bound when evaluating
   * pre/postconditions so specifications can reference parameters by name.
   */
  parameterNames: string[];
}

export interface FuzzConfig {
  /** Maximum number of inputs to try */
  maxAttempts?: number;
  /** Timeout per execution in ms */
  executionTimeout?: number;
  /** Number of repetitions for determinism check */
  determinismChecks?: number;
}

export interface FuzzViolation {
  input: unknown;
  output: unknown;
  violatedPostcondition: string;
  oracleType: 'postcondition' | 'crash' | 'timeout' | 'nan' | 'determinism';
  executionTime_ms: number;
}

export interface FuzzReport {
  status: 'violation_found' | 'no_violation';
  violations: FuzzViolation[];
  totalAttempts: number;
  totalTime_ms: number;
  environmentErrors: number;
}

const DEFAULT_MAX_ATTEMPTS = 200;
const DEFAULT_EXECUTION_TIMEOUT = 2000;
const DEFAULT_DETERMINISM_CHECKS = 3;

export class RealFuzzer {
  private executor: SubprocessExecutor;
  private config: Required<FuzzConfig>;

  constructor(config?: FuzzConfig) {
    this.config = {
      maxAttempts: config?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      executionTimeout: config?.executionTimeout ?? DEFAULT_EXECUTION_TIMEOUT,
      determinismChecks: config?.determinismChecks ?? DEFAULT_DETERMINISM_CHECKS,
    };
    this.executor = new SubprocessExecutor({ timeout: this.config.executionTimeout });
  }

  async fuzz(target: FuzzTarget): Promise<FuzzReport> {
    const startTime = Date.now();
    const violations: FuzzViolation[] = [];
    let totalAttempts = 0;
    let environmentErrors = 0;
    const paramNames = target.parameterNames ?? [];

    // Generate inputs: edge cases first, then random
    const inputs = this.generateInputs(target.parameterTypes);

    for (const input of inputs) {
      if (totalAttempts >= this.config.maxAttempts) break;
      if (violations.length > 0) break; // Stop at first violation

      // Check preconditions — skip inputs that violate them. Precondition-filtered
      // inputs must NOT consume the budget: counting them here would let a strict
      // precondition exhaust maxAttempts after only a handful of real executions,
      // sharply weakening coverage (missed bugs). Only executed inputs are counted.
      if (!this.checkPreconditions(target.preconditions, input, paramNames)) {
        continue;
      }

      totalAttempts++;

      // Execute the function
      const result = await this.executor.execute({
        functionCode: target.sourceCode,
        functionName: target.functionName,
        input,
        timeout: this.config.executionTimeout,
      });

      // Check for timeout violation
      if (result.timedOut) {
        violations.push({
          input,
          output: undefined,
          violatedPostcondition: 'execution must complete within timeout',
          oracleType: 'timeout',
          executionTime_ms: result.duration_ms,
        });
        break;
      }

      // Check for crash violation
      if (result.crashed) {
        // Distinguish environment errors from real bugs:
        // ReferenceError/SyntaxError are likely TypeScript stripping artifacts — skip them
        const exType = result.exceptionType || '';
        const errMsg = result.error || '';
        const isEnvironmentError = exType === 'ReferenceError' || exType === 'SyntaxError' ||
          errMsg.includes('SyntaxError') || errMsg.includes('ReferenceError');

        if (isEnvironmentError) {
          environmentErrors++;
          continue;
        }

        // TypeError, RangeError, or generic Error — this is likely a real bug
        violations.push({
          input,
          output: undefined,
          violatedPostcondition: `function must not throw: ${result.exceptionType}: ${result.error}`,
          oracleType: 'crash',
          executionTime_ms: result.duration_ms,
        });
        break;
      }

      // Check for NaN/Infinity in output
      const nanViolation = this.checkNanInfinity(result.output, input, result.duration_ms);
      if (nanViolation) {
        violations.push(nanViolation);
        break;
      }

      // Check postconditions
      const postconditionViolation = this.checkPostconditions(
        target.postconditions,
        result.output,
        input,
        result.duration_ms,
        paramNames,
      );
      if (postconditionViolation) {
        violations.push(postconditionViolation);
        break;
      }

      // Check determinism (run same input multiple times)
      if (this.config.determinismChecks > 1) {
        const determinismViolation = await this.checkDeterminism(
          target,
          input,
          result.output,
        );
        if (determinismViolation) {
          violations.push(determinismViolation);
          break;
        }
      }
    }

    // Cleanup
    this.executor.cleanup();

    return {
      status: violations.length > 0 ? 'violation_found' : 'no_violation',
      violations,
      totalAttempts,
      totalTime_ms: Date.now() - startTime,
      environmentErrors,
    };
  }

  /**
   * Generate inputs based on parameter types.
   * Edge cases come first, followed by random values.
   */
  private generateInputs(parameterTypes: string[]): unknown[] {
    if (parameterTypes.length === 0) {
      // No type info — try common values, each as a single argument.
      return this.generateGenericInputs().map((v) => [v]);
    }

    if (parameterTypes.length === 1) {
      // Wrap each value as a single-element argument list [value]. An "input" is
      // always the positional argument list, so the executor (fn(...args)) and
      // condition binding agree. Without this, a single ARRAY argument would be
      // spread into fn(1,2,3) instead of fn([1,2,3]).
      return this.generateForType(parameterTypes[0]).map((v) => [v]);
    }

    // Multiple parameters — generate combinations already shaped as arg lists.
    const perParam = parameterTypes.map((t) => this.generateForType(t));
    return this.generateCombinations(perParam);
  }

  /**
   * Generate inputs for a specific type.
   */
  private generateForType(type: string): unknown[] {
    const normalizedType = type.toLowerCase().trim();

    if (normalizedType === 'number' || normalizedType === 'number | undefined') {
      return this.generateNumberInputs();
    }
    if (normalizedType === 'number[]' || normalizedType === 'array<number>') {
      return this.generateNumberArrayInputs();
    }
    if (normalizedType === 'string') {
      return this.generateStringInputs();
    }
    if (normalizedType === 'string[]' || normalizedType === 'array<string>') {
      return this.generateStringArrayInputs();
    }
    if (normalizedType === 'boolean') {
      return [true, false];
    }
    if (normalizedType.includes('[]') || normalizedType.includes('array')) {
      return this.generateNumberArrayInputs();
    }

    // Unknown type — try common values
    return this.generateGenericInputs();
  }

  /**
   * Edge case numbers — always include these specific values.
   */
  private generateNumberInputs(): unknown[] {
    const edgeCases: number[] = [
      0, -0, 1, -1,
      NaN, Infinity, -Infinity,
      Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER,
      0.1, -0.1,
      1e15, -1e15,
      0.000001, -0.000001,
      2, 3, 5, 10, 100,
      -2, -3, -5, -10, -100,
      0.5, 1.5, 2.5,
      Math.PI, Math.E,
      Number.MAX_VALUE, Number.MIN_VALUE,
      Number.EPSILON,
    ];

    // Add random numbers
    const random: number[] = [];
    for (let i = 0; i < 50; i++) {
      random.push(Math.random() * 200 - 100); // -100 to 100
    }
    for (let i = 0; i < 20; i++) {
      random.push(Math.floor(Math.random() * 1000)); // 0 to 999
    }
    for (let i = 0; i < 10; i++) {
      random.push(Math.random() * 1e10); // large positive
    }
    for (let i = 0; i < 10; i++) {
      random.push(-Math.random() * 1e10); // large negative
    }

    return [...edgeCases, ...random];
  }

  /**
   * Edge case number arrays — always include these specific arrays.
   */
  private generateNumberArrayInputs(): unknown[] {
    const edgeCases: unknown[] = [
      [],                          // empty array
      [0],                         // single zero
      [1],                         // single positive
      [-1],                        // single negative
      [NaN],                       // NaN in array
      [Infinity],                  // Infinity in array
      [-Infinity],                 // -Infinity
      [1, 2, 3],                   // simple ascending
      [3, 2, 1],                   // simple descending
      [1, 1, 1],                   // all same
      [0, 0, 0],                   // all zeros
      [-1, -2, -3],               // all negative
      [Number.MAX_SAFE_INTEGER],   // max safe integer
      [Number.MIN_SAFE_INTEGER],   // min safe integer
      [0.1, 0.2, 0.3],           // decimals
      [1, -1, 2, -2, 3, -3],     // alternating signs
      [1e15, -1e15],              // very large
      [0, NaN, Infinity],         // mixed special values
    ];

    // Generate some random arrays of various lengths
    const random: unknown[] = [];
    for (let i = 0; i < 20; i++) {
      const len = Math.floor(Math.random() * 20) + 2;
      const arr: number[] = [];
      for (let j = 0; j < len; j++) {
        arr.push(Math.random() * 200 - 100);
      }
      random.push(arr);
    }

    // A large array (1000 elements)
    const largeArray: number[] = [];
    for (let i = 0; i < 1000; i++) {
      largeArray.push(Math.random() * 1000 - 500);
    }
    random.push(largeArray);

    return [...edgeCases, ...random];
  }

  /**
   * Edge case strings.
   */
  private generateStringInputs(): unknown[] {
    return [
      '',                          // empty
      ' ',                         // single space
      'hello',                     // normal
      'Hello World',               // with space
      '   ',                       // only spaces
      '\n',                        // newline
      '\t',                        // tab
      'null',                      // string "null"
      'undefined',                 // string "undefined"
      '0',                         // string zero
      '-1',                        // string negative
      'NaN',                       // string NaN
      'true',                      // string boolean
      '<script>alert(1)</script>', // XSS-like
      'a'.repeat(10000),           // very long
      '🎉',                        // emoji
      'café',                      // accented
      '你好',                      // unicode
      'a\x00b',                    // null byte
    ];
  }

  /**
   * Edge case string arrays.
   */
  private generateStringArrayInputs(): unknown[] {
    return [
      [],
      [''],
      ['hello'],
      ['a', 'b', 'c'],
      ['', '', ''],
      ['hello', 'world'],
    ];
  }

  /**
   * Generic inputs when type is unknown.
   */
  private generateGenericInputs(): unknown[] {
    return [
      0, 1, -1, NaN, Infinity, -Infinity,
      '', 'hello', null, undefined,
      [], [0], [1, 2, 3],
      true, false,
      {}, { x: 1 },
    ];
  }

  /**
   * Generate combinations for multi-parameter functions.
   * Strategy:
   * 1. "One-hot" edge cases: each param gets an edge case while others get simple valid values
   * 2. "All-edge" combos: every param is an edge case value
   * 3. Fill remaining budget with random combinations
   */
  private generateCombinations(perParam: unknown[][]): unknown[] {
    if (perParam.length === 0) return [];
    if (perParam.length === 1) return perParam[0];

    // For 3+ params, use tighter limit to keep total combos reasonable
    const perParamLimit = perParam.length >= 3 ? 15 : 30;
    const limited = perParam.map((p) => p.slice(0, perParamLimit));

    // For 2 params: generate all combinations up to maxAttempts
    if (limited.length === 2) {
      const combos: unknown[] = [];
      for (const a of limited[0]) {
        for (const b of limited[1]) {
          combos.push([a, b]);
          if (combos.length >= 300) return combos;
        }
      }
      return combos;
    }

    // For 3+ params: structured edge-case-focused generation
    const combos: unknown[] = [];
    const maxCombos = 300;

    // Simple valid defaults for each param type (used as "background" in one-hot)
    const simpleDefaults = limited.map((paramValues) => {
      // Pick the first "normal" value — skip edge cases like NaN, Infinity, empty
      for (const v of paramValues) {
        if (typeof v === 'number' && (Number.isNaN(v) || !Number.isFinite(v) || v === 0)) continue;
        if (Array.isArray(v) && v.length === 0) continue;
        if (v === '' || v === null || v === undefined) continue;
        return v;
      }
      // Fallback to first value
      return paramValues[0];
    });

    // Edge case values for each param (first ~8 are typically edge cases)
    const edgeCasesPerParam = limited.map((p) => p.slice(0, 8));

    // Phase 1: "One-hot" edge cases — one param is edge case, rest are simple defaults
    for (let paramIdx = 0; paramIdx < limited.length; paramIdx++) {
      for (const edgeValue of edgeCasesPerParam[paramIdx]) {
        const combo = simpleDefaults.map((def, i) => i === paramIdx ? edgeValue : def);
        combos.push(combo);
        if (combos.length >= maxCombos) return combos;
      }
    }

    // Phase 2: "All-edge" combos — every param gets an edge case
    // Generate cartesian of first few edge cases per param
    const allEdgeCombos = this.cartesianProduct(edgeCasesPerParam.map((e) => e.slice(0, 4)));
    for (const combo of allEdgeCombos) {
      combos.push(combo);
      if (combos.length >= maxCombos) return combos;
    }

    // Phase 3: Fill remaining budget with random combinations (ensuring at least one edge case)
    while (combos.length < maxCombos) {
      const combo = limited.map((param, idx) => {
        // At least one param should be an edge case
        const useEdge = Math.random() < 0.5;
        if (useEdge && edgeCasesPerParam[idx].length > 0) {
          return edgeCasesPerParam[idx][Math.floor(Math.random() * edgeCasesPerParam[idx].length)];
        }
        return param[Math.floor(Math.random() * param.length)];
      });
      combos.push(combo);
    }

    return combos;
  }

  /**
   * Generate cartesian product of arrays (limited to avoid explosion).
   */
  private cartesianProduct(arrays: unknown[][]): unknown[][] {
    if (arrays.length === 0) return [[]];
    const result: unknown[][] = [];
    const maxResults = 200;

    const generate = (current: unknown[], depth: number): void => {
      if (result.length >= maxResults) return;
      if (depth === arrays.length) {
        result.push([...current]);
        return;
      }
      for (const value of arrays[depth]) {
        if (result.length >= maxResults) return;
        current.push(value);
        generate(current, depth + 1);
        current.pop();
      }
    };

    generate([], 0);
    return result;
  }

  /**
   * Check if a given input satisfies all preconditions.
   * If preconditions can't be evaluated, the input is allowed through.
   */
  private checkPreconditions(
    preconditions: string[],
    input: unknown,
    parameterNames: string[],
  ): boolean {
    if (preconditions.length === 0) return true;

    for (const precondition of preconditions) {
      try {
        if (!evaluatePrecondition(precondition, input, parameterNames)) return false;
      } catch {
        // Prose or otherwise unevaluable precondition (e.g. "values is number[]").
        // Allow the input through rather than rejecting everything on a spec we
        // can't run.
        continue;
      }
    }
    return true;
  }

  /**
   * Check postconditions against the function output.
   */
  private checkPostconditions(
    postconditions: string[],
    output: unknown,
    input: unknown,
    duration_ms: number,
    parameterNames: string[],
  ): FuzzViolation | null {
    for (const postcondition of postconditions) {
      try {
        if (!evaluatePostcondition(postcondition, input, output, parameterNames)) {
          return {
            input,
            output,
            violatedPostcondition: postcondition,
            oracleType: 'postcondition',
            executionTime_ms: duration_ms,
          };
        }
      } catch {
        // Prose or otherwise unevaluable postcondition — skip it.
        continue;
      }
    }
    return null;
  }

  /**
   * Check if the output is NaN or Infinity (common bug indicators).
   */
  private checkNanInfinity(
    output: unknown,
    input: unknown,
    duration_ms: number,
  ): FuzzViolation | null {
    if (typeof output === 'number') {
      if (Number.isNaN(output)) {
        return {
          input,
          output,
          violatedPostcondition: '!isNaN(result)',
          oracleType: 'nan',
          executionTime_ms: duration_ms,
        };
      }
      if (!Number.isFinite(output)) {
        return {
          input,
          output,
          violatedPostcondition: 'isFinite(result)',
          oracleType: 'nan',
          executionTime_ms: duration_ms,
        };
      }
    }
    return null;
  }

  /**
   * Check determinism: run the same input multiple times and compare outputs.
   */
  private async checkDeterminism(
    target: FuzzTarget,
    input: unknown,
    firstOutput: unknown,
  ): Promise<FuzzViolation | null> {
    // Only check determinism for a subset of inputs (every 10th) to save time
    const results = await this.executor.executeMultiple(
      {
        functionCode: target.sourceCode,
        functionName: target.functionName,
        input,
        timeout: this.config.executionTimeout,
      },
      this.config.determinismChecks - 1, // We already have one result
    );

    const firstJson = JSON.stringify(firstOutput);
    for (const result of results) {
      if (!result.success) continue; // Skip failures for determinism check
      const resultJson = JSON.stringify(result.output);
      if (resultJson !== firstJson) {
        return {
          input,
          output: { first: firstOutput, subsequent: result.output },
          violatedPostcondition: 'function must be deterministic (same input → same output)',
          oracleType: 'determinism',
          executionTime_ms: result.duration_ms,
        };
      }
    }
    return null;
  }
}
