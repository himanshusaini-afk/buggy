/**
 * Executor factory — picks the code executor for a language.
 *
 * Both executors implement the same {@link CodeExecutor} contract, so the
 * fuzzer and bug-proving agent are language-agnostic: they build
 * {@link ExecuteOptions} and read {@link ExecuteResult} without caring whether
 * the target ran in Node or Python.
 *
 * @module sandbox/executor-factory
 */

import type { ExecuteOptions, ExecuteResult } from './subprocess-executor.js';
import { SubprocessExecutor } from './subprocess-executor.js';
import { PythonExecutor } from './python-executor.js';

/** Common contract shared by the Node and Python executors. */
export interface CodeExecutor {
  execute(options: ExecuteOptions): Promise<ExecuteResult>;
  executeMultiple(options: ExecuteOptions, times: number): Promise<ExecuteResult[]>;
  cleanup(): void;
}

/**
 * Create the executor for a language/runtime.
 *
 * @param language - Project language (e.g. `typescript`, `javascript`, `python`).
 * @param options - Executor options (timeout).
 * @returns A PythonExecutor for Python, otherwise the Node SubprocessExecutor.
 */
export function createExecutor(
  language: string | undefined,
  options?: { timeout?: number }
): CodeExecutor {
  if ((language ?? '').toLowerCase() === 'python') {
    return new PythonExecutor(options);
  }
  return new SubprocessExecutor(options);
}
