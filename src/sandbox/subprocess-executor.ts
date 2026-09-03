/**
 * Subprocess Executor — Runs target functions with specified inputs
 * in a child process with resource limits (timeout, memory).
 *
 * This replaces the Firecracker stub for local development,
 * enabling real code execution for bug proving and fuzzing.
 */

import { fork } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

export interface ExecuteOptions {
  /** The function source code to execute */
  functionCode: string;
  /** The function name to call */
  functionName: string;
  /** The input to pass to the function — array for multiple args, single value for one arg */
  input: unknown;
  /** Timeout in milliseconds (default: 5000) */
  timeout?: number;
  /** Max memory in MB (for reporting, not enforced at OS level without Firecracker) */
  maxMemoryMb?: number;
}

export interface ExecuteResult {
  /** Whether execution completed without error */
  success: boolean;
  /** The return value of the function (JSON-parsed) */
  output: unknown;
  /** Error message if execution failed */
  error?: string;
  /** Whether the function timed out */
  timedOut: boolean;
  /** Whether the function crashed (threw an exception) */
  crashed: boolean;
  /** Execution duration in milliseconds */
  duration_ms: number;
  /** The exception type if crashed */
  exceptionType?: string;
  /** Stack trace if crashed */
  stackTrace?: string;
}

/**
 * Shape of the payload the generated runner script sends back (over the IPC
 * channel, or stdout as a fallback). Kept separate from ExecuteResult, which is
 * the richer result the executor returns to its callers.
 */
interface RunnerResult {
  success: boolean;
  output?: unknown;
  error?: string;
  exceptionType?: string;
  stackTrace?: string;
}

export class SubprocessExecutor {
  private timeout: number;
  private tempDir: string;

  constructor(options?: { timeout?: number }) {
    this.timeout = options?.timeout ?? 5000;
    this.tempDir = join(tmpdir(), 'buggy-exec');
    mkdirSync(this.tempDir, { recursive: true });
  }

  async execute(options: ExecuteOptions): Promise<ExecuteResult> {
    const timeout = options.timeout ?? this.timeout;
    const fileId = randomUUID();
    const filePath = join(this.tempDir, `runner-${fileId}.mjs`);

    // Build the runner script
    const script = this.buildRunnerScript(options);
    writeFileSync(filePath, script, 'utf-8');

    const startTime = Date.now();

    return new Promise<ExecuteResult>((resolve) => {
      let stdout = '';
      let stderr = '';
      let resolved = false;
      let timedOut = false;
      // Result delivered over the dedicated IPC channel. Reading it from IPC
      // instead of stdout means the target function's own console.log output
      // can never corrupt the result payload and make a correct run look like a
      // crash (JSON.parse of polluted stdout would throw).
      let ipcResult: RunnerResult | undefined;

      const child = fork(filePath, [], {
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
        timeout: 0, // We manage timeout ourselves
        env: { ...process.env, NODE_OPTIONS: '' },
      });

      const timer = setTimeout(() => {
        if (!resolved) {
          timedOut = true;
          child.kill('SIGKILL');
        }
      }, timeout);

      child.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      child.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      child.on('message', (msg) => {
        ipcResult = msg as RunnerResult;
      });

      child.on('close', (code) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);

        const duration_ms = Date.now() - startTime;

        // Clean up temp file
        try {
          rmSync(filePath, { force: true });
        } catch {
          // ignore cleanup errors
        }

        if (timedOut) {
          resolve({
            success: false,
            output: undefined,
            error: 'Execution timed out',
            timedOut: true,
            crashed: false,
            duration_ms,
          });
          return;
        }

        // Prefer the IPC-delivered result. Fall back to parsing stdout only for
        // backward compatibility (e.g. a runner with no IPC channel).
        let result = ipcResult;
        if (result === undefined) {
          try {
            result = JSON.parse(stdout.trim()) as RunnerResult;
          } catch {
            result = undefined;
          }
        }

        if (result === undefined) {
          // No parseable result on either channel — treat as a crash.
          resolve({
            success: false,
            output: undefined,
            error: stderr || stdout || `Process exited with code ${code}`,
            timedOut: false,
            crashed: true,
            duration_ms,
          });
          return;
        }

        if (result.success) {
          // Convert NaN/Infinity sentinels back to actual values
          let output = result.output;
          if (output === '__NaN__') output = NaN;
          else if (output === '__Infinity__') output = Infinity;
          else if (output === '__NegInfinity__') output = -Infinity;

          resolve({
            success: true,
            output,
            timedOut: false,
            crashed: false,
            duration_ms,
          });
        } else {
          resolve({
            success: false,
            output: undefined,
            error: result.error,
            timedOut: false,
            crashed: true,
            duration_ms,
            exceptionType: result.exceptionType,
            stackTrace: result.stackTrace,
          });
        }
      });

      child.on('error', (err) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);

        const duration_ms = Date.now() - startTime;

        try {
          rmSync(filePath, { force: true });
        } catch {
          // ignore
        }

        resolve({
          success: false,
          output: undefined,
          error: err.message,
          timedOut: false,
          crashed: true,
          duration_ms,
          exceptionType: err.constructor.name,
          stackTrace: err.stack,
        });
      });
    });
  }

  /**
   * Execute a function multiple times with the same input to check determinism.
   */
  async executeMultiple(options: ExecuteOptions, times: number): Promise<ExecuteResult[]> {
    const results: ExecuteResult[] = [];
    for (let i = 0; i < times; i++) {
      results.push(await this.execute(options));
    }
    return results;
  }

  cleanup(): void {
    try {
      if (existsSync(this.tempDir)) {
        rmSync(this.tempDir, { recursive: true, force: true });
      }
    } catch {
      // Ignore cleanup errors
    }
  }

  /**
   * Build the runner .mjs script content.
   *
   * Handles both single-argument and multi-argument functions.
   * The input is spread as arguments if it's an array.
   * Strips TypeScript syntax (type annotations, export keywords) for plain JS execution.
   */
  private buildRunnerScript(options: ExecuteOptions): string {
    const inputJson = JSON.stringify(options.input);
    const cleanCode = this.stripTypeScript(options.functionCode);

    return `// Auto-generated runner script
const fn = (() => {
  ${cleanCode}
  return ${options.functionName};
})();

const input = ${inputJson};

// Send the result back over the IPC channel so that anything the target
// function writes to stdout (console.log, etc.) cannot corrupt the payload.
// Falls back to stdout only if no IPC channel is present.
function emit(result) {
  try {
    if (typeof process.send === 'function') {
      process.send(result, () => process.exit(0));
      return;
    }
  } catch (e) {
    // IPC send failed (e.g. non-serializable payload) — fall through to stdout.
  }
  try {
    process.stdout.write(JSON.stringify(result));
  } catch (e) {
    process.stdout.write(JSON.stringify({ success: false, error: 'Result not serializable: ' + (e && e.message) }));
  }
  process.exit(0);
}

async function run() {
  try {
    // If input is an array, spread it as multiple arguments
    const args = Array.isArray(input) ? input : [input];
    const result = fn(...args);
    // Handle promises
    const resolved = result instanceof Promise ? await result : result;
    // Handle NaN/Infinity which can't be represented in JSON
    if (typeof resolved === 'number' && Number.isNaN(resolved)) {
      return { success: true, output: '__NaN__' };
    } else if (resolved === Infinity) {
      return { success: true, output: '__Infinity__' };
    } else if (resolved === -Infinity) {
      return { success: true, output: '__NegInfinity__' };
    } else {
      return { success: true, output: resolved };
    }
  } catch (err) {
    return {
      success: false,
      error: err.message || String(err),
      exceptionType: err.constructor?.name || 'Error',
      stackTrace: err.stack || '',
    };
  }
}

run().then(emit).catch((e) => emit({
  success: false,
  error: e.message || String(e),
  exceptionType: e.constructor?.name || 'Error',
  stackTrace: e.stack || '',
}));
`;
  }

  /**
   * Strip TypeScript syntax from source code so it can run as plain JavaScript.
   * Handles: import lines, export keywords, type annotations, interface/type declarations, generics.
   */
  private stripTypeScript(code: string): string {
    let result = code;

    // 1. Remove ALL import lines (import type, import { ... }, import ... from ...)
    result = result.replace(/^\s*import\s+.*$/gm, '');

    // 2. Remove export interface / interface blocks (multi-line with balanced braces)
    result = this.removeInterfaceBlocks(result);

    // 3. Remove export type declarations (single and multi-line)
    result = result.replace(/^(?:export\s+)?type\s+\w+[\s\S]*?;$/gm, '');

    // 4. Remove 'export ' keyword (after interface/type removal to avoid partial matches)
    result = result.replace(/\bexport\s+/g, '');

    // 5. Remove generic constraints from arrow functions: <T extends Foo> at start
    result = result.replace(/<[^>\n]*(?:extends|implements)[^>\n]*>\s*/g, '');
    // Remove generic type parameters on constructors/functions: new Map<K, V>() → new Map()
    // Must not cross newlines to avoid matching comparison operators like `rank < ...`
    result = result.replace(/(\w+)\s*<[^>\n]+>\s*\(/g, '$1(');

    // 6. Remove complex return type annotations with braces: ): { ... }[] { → ) {
    //    Must handle before simple return types
    result = this.stripReturnTypes(result);

    // 7. Strip type annotations from function signatures (parameter lists)
    result = this.stripFunctionSignatureTypes(result);

    // 8. Remove variable type annotations: const x: Type = → const x =
    //    Pattern: (const|let|var) name: Type = or (const|let|var) name: Type[] =
    result = result.replace(/((?:const|let|var)\s+\w+)\s*:\s*[^=\n]+?(?=\s*=)/g, '$1');

    // 9. Remove 'as const' assertions
    result = result.replace(/\s+as\s+const\b/g, '');

    // 10. Remove 'as Type' casts
    result = result.replace(/\s+as\s+\w+[\[\]<>]*/g, '');

    // 11. Remove non-null assertions (!) — but NOT the '!' in '!=' / '!==',
    //     which would otherwise corrupt inequality checks like `x!==y` → `x==y`.
    result = result.replace(/(\w)!(?!=)/g, '$1');

    // 12. Remove 'readonly' keyword
    result = result.replace(/\breadonly\s+/g, '');

    // 13. Remove 'declare' keyword lines
    result = result.replace(/^\s*declare\s+.*$/gm, '');

    return result;
  }

  /**
   * Remove return type annotations from function signatures.
   * Handles both simple types and complex types with braces like { index: number; score: number }[]
   */
  private stripReturnTypes(code: string): string {
    let result = code;

    // Handle return types with braces: ): { ... }[] { → ) {
    // and ): { ... }[] => → ) =>
    // and ): { ... }[] (end of line/string — dangling from extraction) → )
    result = result.replace(/\)\s*:\s*\{[^}]*\}[\[\]]*\s*\{/g, ') {');
    result = result.replace(/\)\s*:\s*\{[^}]*\}[\[\]]*\s*=>/g, ') =>');
    result = result.replace(/\)\s*:\s*\{[^}]*\}[\[\]]*\s*$/gm, ')');

    // Handle simple return types: ): Type { → ) {  and ): Type => → ) =>
    // Only match type-like tokens (capitalized words, primitives, generics, arrays)
    result = result.replace(/\)\s*:\s*(?:(?:number|string|boolean|void|any|unknown|never|null|undefined|object)\b[\[\]]*|[A-Z]\w*(?:<[^>]*>)?[\[\]]*(?:\s*\|\s*\w+[\[\]]*)*)\s*\{/g, ') {');
    result = result.replace(/\)\s*:\s*(?:(?:number|string|boolean|void|any|unknown|never|null|undefined|object)\b[\[\]]*|[A-Z]\w*(?:<[^>]*>)?[\[\]]*(?:\s*\|\s*\w+[\[\]]*)*)\s*=>/g, ') =>');
    // Handle simple return types at end of line (dangling from extraction)
    result = result.replace(/\)\s*:\s*(?:number|string|boolean|void|any|unknown|never|null|undefined|object)\b[\[\]]*\s*$/gm, ')');

    return result;
  }

  /**
   * Strip type annotations from function parameter lists only.
   * Processes line-by-line to distinguish function signatures from object literals.
   */
  private stripFunctionSignatureTypes(code: string): string {
    const lines = code.split('\n');
    const processed = lines.map((line) => {
      if (this.isFunctionSignatureLine(line)) {
        return this.stripParamTypes(line);
      }
      return line;
    });
    return processed.join('\n');
  }

  /**
   * Determine if a line contains a function signature (not an object literal or variable).
   */
  private isFunctionSignatureLine(line: string): boolean {
    const trimmed = line.trim();
    // function declarations
    if (/(?:async\s+)?function\s+\w*\s*\(/.test(trimmed)) return true;
    // arrow function assignments
    if (/(?:const|let|var)\s+\w+\s*=\s*(?:async\s+)?\(/.test(trimmed)) return true;
    // Line that's purely a parameter in a multi-line signature:
    // starts with identifier followed by colon and a TypeScript type keyword
    // (may or may not have trailing comma/paren — last param before ) on next line has neither)
    if (/^\w+\s*:\s*(?:number|string|boolean|any|unknown|void|never|object|null|undefined)\b/.test(trimmed)) return true;
    // Array/generic typed params: word: Type[], word: Type[][], word: Type<...>
    if (/^\w+\s*:\s*\w+(?:\[\])+/.test(trimmed)) return true;
    if (/^\w+\s*:\s*\w+<[^>]*>/.test(trimmed)) return true;
    // Line with typed params after opening paren
    if (/\(\s*\w+\s*:\s*(?:number|string|boolean|any|unknown|void|never|object|null|undefined)\b/.test(trimmed)) return true;
    if (/\(\s*\w+\s*:\s*\w+(?:\[\])+/.test(trimmed)) return true;
    if (/\(\s*\w+\s*:\s*\w+<[^>]*>/.test(trimmed)) return true;
    return false;
  }

  /**
   * Strip type annotations from parameter positions in a line.
   * Handles: (name: Type, name2: Type = default) → (name, name2 = default)
   */
  private stripParamTypes(line: string): string {
    let result = line;

    // Type pattern: matches type keywords with optional array suffixes, or generic types
    // IMPORTANT: array types (number[], string[][]) must come before bare types in alternation
    const typeAtom = '(?:\\w+(?:\\[\\])+|\\w+<[^>\\n]*>|number|string|boolean|any|unknown|void|never|object|null|undefined)';
    const typeUnion = `${typeAtom}(?:\\s*\\|\\s*${typeAtom})*`;

    // Handle params with defaults: `name: Type = value`
    const defaultParamRegex = new RegExp(`(\\w+)\\s*:\\s*${typeUnion}\\s*(?==\\s*[^=>])`, 'g');
    result = result.replace(defaultParamRegex, '$1 ');

    // Handle params without defaults: `name: Type` followed by , or ) or end of line
    const paramRegex = new RegExp(`(\\w+)\\s*:\\s*${typeUnion}(?=[,\\)\\s]*$|[,\\)])`, 'g');
    result = result.replace(paramRegex, '$1');

    return result;
  }

  /**
   * Remove interface blocks (including multi-line) using brace balancing.
   */
  private removeInterfaceBlocks(code: string): string {
    // Match the start of an interface declaration
    const interfacePattern = /^[ \t]*(?:export\s+)?interface\s+\w+[^{]*\{/gm;
    let result = code;
    let match: RegExpExecArray | null;

    // Process from last match to first to preserve indices
    const matches: { start: number; end: number }[] = [];
    while ((match = interfacePattern.exec(result)) !== null) {
      const startIdx = match.index;
      // Find balanced closing brace
      let braceCount = 0;
      let foundFirstBrace = false;
      let endIdx = startIdx;

      for (let i = startIdx; i < result.length; i++) {
        if (result[i] === '{') {
          braceCount++;
          foundFirstBrace = true;
        } else if (result[i] === '}') {
          braceCount--;
          if (foundFirstBrace && braceCount === 0) {
            endIdx = i + 1;
            break;
          }
        }
      }

      if (foundFirstBrace && braceCount === 0) {
        matches.push({ start: startIdx, end: endIdx });
      }
    }

    // Remove from end to start to preserve indices
    for (let i = matches.length - 1; i >= 0; i--) {
      result = result.slice(0, matches[i].start) + result.slice(matches[i].end);
    }

    return result;
  }
}
