/**
 * Python Executor — runs a target Python function with generated inputs in a
 * `python` child process, mirroring the SubprocessExecutor (Node) contract so
 * it is a drop-in sibling for the fuzzer and bug-proving agent.
 *
 * Python has no Node IPC channel, so the runner communicates through temp
 * files: the parent writes the module source, a JSON payload (function name +
 * sentinel-encoded input), and expects a JSON result file back. This keeps the
 * target function's own stdout (print) from corrupting the result payload.
 *
 * Values JSON cannot represent are carried as sentinels in BOTH directions:
 *   __NaN__ / __Infinity__ / __NegInfinity__  <->  float('nan'|'inf'|'-inf')
 *   __undefined__                             <->  None
 *
 * @module sandbox/python-executor
 */

import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import type { ExecuteOptions, ExecuteResult } from './subprocess-executor.js';

/** Result payload the Python runner writes to the output file. */
interface RunnerResult {
  success: boolean;
  output?: unknown;
  error?: string;
  exceptionType?: string;
  stackTrace?: string;
}

/** Resolve the Python interpreter command (overridable via BUGGY_PYTHON). */
function pythonCommand(): string {
  return process.env.BUGGY_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
}

export class PythonExecutor {
  private timeout: number;
  private tempDir: string;

  constructor(options?: { timeout?: number }) {
    this.timeout = options?.timeout ?? 5000;
    this.tempDir = join(tmpdir(), 'buggy-pyexec');
    mkdirSync(this.tempDir, { recursive: true });
  }

  async execute(options: ExecuteOptions): Promise<ExecuteResult> {
    const timeout = options.timeout ?? this.timeout;
    const id = randomUUID();
    const codePath = join(this.tempDir, `mod-${id}.py`);
    const payloadPath = join(this.tempDir, `in-${id}.json`);
    const outPath = join(this.tempDir, `out-${id}.json`);
    const runnerPath = join(this.tempDir, `runner-${id}.py`);

    writeFileSync(codePath, options.functionCode, 'utf-8');
    writeFileSync(
      payloadPath,
      JSON.stringify({ functionName: options.functionName, input: encodeSentinels(options.input) }),
      'utf-8'
    );
    writeFileSync(runnerPath, RUNNER_SOURCE, 'utf-8');

    const startTime = Date.now();

    return new Promise<ExecuteResult>((resolve) => {
      let resolved = false;
      let timedOut = false;
      let stderr = '';

      const child = spawn(pythonCommand(), [runnerPath, codePath, payloadPath, outPath], {
        stdio: ['ignore', 'ignore', 'pipe'],
      });

      const timer = setTimeout(() => {
        if (!resolved) {
          timedOut = true;
          child.kill('SIGKILL');
        }
      }, timeout);

      child.stderr?.on('data', (d) => {
        stderr += d.toString();
      });

      const finish = (result: ExecuteResult) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        for (const p of [codePath, payloadPath, outPath, runnerPath]) {
          try {
            rmSync(p, { force: true });
          } catch {
            /* ignore cleanup errors */
          }
        }
        resolve(result);
      };

      child.on('error', (err) => {
        const duration_ms = Date.now() - startTime;
        // Spawn failure (e.g. python not on PATH) — surface as a crash so the
        // caller can distinguish it, not a false "no bug".
        finish({
          success: false,
          output: undefined,
          error: `Failed to launch Python (${pythonCommand()}): ${err.message}`,
          timedOut: false,
          crashed: true,
          duration_ms,
          exceptionType: 'SpawnError',
          stackTrace: err.stack,
        });
      });

      child.on('close', (code) => {
        const duration_ms = Date.now() - startTime;

        if (timedOut) {
          finish({
            success: false,
            output: undefined,
            error: 'Execution timed out',
            timedOut: true,
            crashed: false,
            duration_ms,
          });
          return;
        }

        let runner: RunnerResult | undefined;
        try {
          if (existsSync(outPath)) {
            runner = JSON.parse(readFileSync(outPath, 'utf-8')) as RunnerResult;
          }
        } catch {
          runner = undefined;
        }

        if (runner === undefined) {
          finish({
            success: false,
            output: undefined,
            error: stderr || `Python process exited with code ${code}`,
            timedOut: false,
            crashed: true,
            duration_ms,
          });
          return;
        }

        if (runner.success) {
          finish({
            success: true,
            output: decodeSentinels(runner.output),
            timedOut: false,
            crashed: false,
            duration_ms,
          });
        } else {
          finish({
            success: false,
            output: undefined,
            error: runner.error,
            timedOut: false,
            crashed: true,
            duration_ms,
            exceptionType: runner.exceptionType,
            stackTrace: runner.stackTrace,
          });
        }
      });
    });
  }

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
      /* ignore */
    }
  }
}

/** Encode JS special values as sentinels the Python runner understands. */
function encodeSentinels(value: unknown): unknown {
  if (value === undefined) return '__undefined__';
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return '__NaN__';
    if (value === Infinity) return '__Infinity__';
    if (value === -Infinity) return '__NegInfinity__';
  }
  if (Array.isArray(value)) return value.map(encodeSentinels);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = encodeSentinels(v);
    return out;
  }
  return value;
}

/** Decode Python-side sentinels back into real JS values (deep). */
function decodeSentinels(value: unknown): unknown {
  if (value === '__NaN__') return NaN;
  if (value === '__Infinity__') return Infinity;
  if (value === '__NegInfinity__') return -Infinity;
  if (value === '__undefined__') return undefined;
  if (Array.isArray(value)) return value.map(decodeSentinels);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = decodeSentinels(v);
    return out;
  }
  return value;
}

/**
 * The Python runner. Reads argv: <code_file> <payload_file> <out_file>.
 * Execs the module source, resolves the target function, revives sentinel
 * inputs, calls it (spreading a list as positional args), and writes a JSON
 * result — mapping nan/inf/None back to sentinels so the parent can restore
 * real JS values.
 */
const RUNNER_SOURCE = `import sys, json, math, traceback

def revive(v):
    if v == '__NaN__': return float('nan')
    if v == '__Infinity__': return float('inf')
    if v == '__NegInfinity__': return float('-inf')
    if v == '__undefined__': return None
    if isinstance(v, list): return [revive(x) for x in v]
    if isinstance(v, dict): return {k: revive(x) for k, x in v.items()}
    return v

def encode(v):
    if isinstance(v, bool):
        return v
    if isinstance(v, float):
        if math.isnan(v): return '__NaN__'
        if v == float('inf'): return '__Infinity__'
        if v == float('-inf'): return '__NegInfinity__'
        return v
    if isinstance(v, list): return [encode(x) for x in v]
    if isinstance(v, tuple): return [encode(x) for x in v]
    if isinstance(v, dict): return {str(k): encode(x) for k, x in v.items()}
    return v

def main():
    code_file, payload_file, out_file = sys.argv[1], sys.argv[2], sys.argv[3]
    with open(code_file, encoding='utf-8') as f:
        code = f.read()
    with open(payload_file, encoding='utf-8') as f:
        payload = json.load(f)
    name = payload['functionName']
    args_in = revive(payload['input'])
    try:
        ns = {}
        exec(compile(code, '<target>', 'exec'), ns)
        fn = ns.get(name)
        if fn is None:
            result = {'success': False, 'error': 'Function not found: ' + name, 'exceptionType': 'FunctionNotFound'}
        else:
            args = args_in if isinstance(args_in, list) else [args_in]
            out = fn(*args)
            result = {'success': True, 'output': encode(out)}
    except Exception as e:
        result = {'success': False, 'error': str(e), 'exceptionType': type(e).__name__, 'stackTrace': traceback.format_exc()}
    with open(out_file, 'w', encoding='utf-8') as f:
        json.dump(result, f, allow_nan=False, default=lambda o: str(o))

main()
`;
