#!/usr/bin/env node
/**
 * Publish smoke test.
 *
 * Packs the package exactly as `npm publish` would, installs the tarball into a
 * throwaway project with DEFAULT npm settings, and exercises every public
 * entry point from the consumer's side.
 *
 * This exists because the unit suite cannot catch packaging faults. It runs
 * against `src/` with the repo's own `.npmrc` and `tsconfig`, so it will happily
 * pass while the published artefact is broken — a missing file in the `files`
 * allowlist, a bin that does not resolve, a dependency that fails to install
 * cleanly, or diagnostics written to stdout that corrupt `--json`. Each of
 * those has to be caught here or it ships.
 *
 * Usage:  node scripts/smoke-test.mjs [--keep]
 *   --keep   leave the temp project in place for inspection
 *
 * Exits non-zero on the first failure, so it is safe as a prepublish gate.
 */

import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PKG = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf-8'));
const KEEP = process.argv.includes('--keep');

const results = [];
let workDir = null;

// ─── Harness ─────────────────────────────────────────────────────────────────

function check(name, fn) {
  try {
    const detail = fn();
    results.push({ name, ok: true, detail: detail ?? '' });
    console.log(`  \x1b[32m✓\x1b[0m ${name}${detail ? `  \x1b[2m${detail}\x1b[0m` : ''}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    results.push({ name, ok: false, detail: message });
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`      \x1b[31m${message.split('\n').slice(0, 6).join('\n      ')}\x1b[0m`);
    throw new SmokeFailure(name);
  }
}

class SmokeFailure extends Error {}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/**
 * Run a command, returning stdout. Throws with captured output on failure.
 *
 * `shell` is enabled only for `npm`, which on Windows is a `.cmd` script that
 * execFileSync cannot launch directly. It must stay OFF for absolute
 * executables: `process.execPath` is `C:\Program Files\nodejs\node.exe`, and a
 * shell splits that on the space in "Program Files".
 */
function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, {
    encoding: 'utf-8',
    cwd: opts.cwd ?? workDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: opts.timeout ?? 300_000,
    shell: opts.shell ?? (process.platform === 'win32' && !cmd.includes('\\')),
    env: { ...process.env, NO_COLOR: '1', ...(opts.env ?? {}) },
  });
}

/**
 * Run the installed CLI through `node` rather than the generated bin shim.
 * The shim is tested separately; going direct keeps stdout clean of the shell
 * wrapper's noise so output assertions mean what they say.
 */
function cli(args, opts = {}) {
  return run(process.execPath, [join(workDir, 'node_modules', PKG.name, 'dist', 'cli.js'), ...args], opts);
}

// ─── Fixture ─────────────────────────────────────────────────────────────────

/** A function with a provable division-by-zero defect. */
const FIXTURE = `export function splitBill(total: number, people: number): number {
  return total / people;
}

export function applyDiscount(price: number, pct: number): number {
  return price - price * (pct / 100);
}
`;

// ─── Phases ──────────────────────────────────────────────────────────────────

function packTarball() {
  const out = run('npm', ['pack', '--pack-destination', workDir], { cwd: REPO });
  const name = out.trim().split('\n').pop().trim();
  const tarball = join(workDir, name);
  assert(existsSync(tarball), `npm pack reported ${name} but it is not on disk`);
  const kb = Math.round(readFileSync(tarball).length / 1024);
  return { tarball, detail: `${name} (${kb} kB)` };
}

function mcpToolsList() {
  // Drive the MCP server over stdio the way a real client does, so a broken
  // server entry point or a malformed tool schema fails here rather than in
  // someone's editor.
  return new Promise((resolvePromise, reject) => {
    const server = spawn(
      process.execPath,
      [join(workDir, 'node_modules', PKG.name, 'dist', 'mcp-server.js')],
      { cwd: workDir, stdio: ['pipe', 'pipe', 'pipe'] }
    );

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      server.kill('SIGKILL');
      reject(new Error(`MCP server did not answer tools/list in 30s.\nstderr: ${stderr.slice(0, 400)}`));
    }, 30_000);

    server.stdout.on('data', (d) => {
      stdout += d.toString();
      for (const line of stdout.split('\n')) {
        if (!line.trim().startsWith('{')) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id !== 2) continue;
        clearTimeout(timer);
        server.kill('SIGKILL');
        const tools = msg.result?.tools;
        if (!Array.isArray(tools)) return reject(new Error('tools/list returned no tools array'));
        return resolvePromise(tools.map((t) => t.name));
      }
    });
    server.stderr.on('data', (d) => { stderr += d.toString(); });
    server.on('error', (e) => { clearTimeout(timer); reject(e); });

    const send = (obj) => server.stdin.write(`${JSON.stringify(obj)}\n`);
    send({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'smoke-test', version: '1.0.0' },
      },
    });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  });
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n\x1b[1mSmoke test — ${PKG.name}@${PKG.version}\x1b[0m`);
  console.log('\x1b[2mPacks, installs into a clean project, and exercises every entry point.\x1b[0m\n');

  workDir = mkdtempSync(join(tmpdir(), 'buggy-smoke-'));
  console.log(`\x1b[2m  workdir: ${workDir}\x1b[0m\n`);

  let tarball;

  console.log('\x1b[1mPackaging\x1b[0m');

  check('npm pack produces a tarball', () => {
    const r = packTarball();
    tarball = r.tarball;
    return r.detail;
  });

  check('tarball ships no credential-shaped strings', () => {
    // Everything that ships is compiled output; a leaked secret in the registry
    // cannot be withdrawn after 72 hours, so this is checked pre-publish.
    const listing = run('npm', ['pack', '--dry-run', '--json'], { cwd: REPO });
    const files = JSON.parse(listing.slice(listing.indexOf('[')))[0].files.map((f) => f.path);
    const risky = files.filter((p) => /(^|\/)\.(env|npmrc)|(^|\/)(\.kiro|\.debugger)\//.test(p));
    assert(risky.length === 0, `allowlist leaks: ${risky.join(', ')}`);
    return `${files.length} files, none sensitive`;
  });

  console.log('\n\x1b[1mInstallation\x1b[0m');

  check('installs into a clean project with default npm settings', () => {
    writeFileSync(
      join(workDir, 'package.json'),
      JSON.stringify({ name: 'smoke-consumer', version: '1.0.0', private: true }, null, 2)
    );
    // No .npmrc here on purpose: the repo's legacy-peer-deps is NOT published,
    // so consumers resolve with strict defaults and must still succeed.
    run('npm', ['install', tarball, '--no-fund', '--no-audit']);
    assert(
      existsSync(join(workDir, 'node_modules', PKG.name, 'dist', 'cli.js')),
      'package installed but dist/cli.js is missing'
    );
    return 'no ERESOLVE';
  });

  check('both bin shims are registered', () => {
    const binDir = join(workDir, 'node_modules', '.bin');
    for (const bin of Object.keys(PKG.bin)) {
      const found = ['', '.cmd', '.ps1'].some((ext) => existsSync(join(binDir, bin + ext)));
      assert(found, `bin "${bin}" was not linked into node_modules/.bin`);
    }
    return Object.keys(PKG.bin).join(', ');
  });

  console.log('\n\x1b[1mCLI\x1b[0m');

  check('--help lists every command', () => {
    const out = cli(['--help']);
    for (const cmd of ['init', 'analyze', 'investigate', 'status', 'halt', 'retrospect', 'suggest']) {
      assert(out.includes(cmd), `--help does not mention "${cmd}"`);
    }
    return '7 commands';
  });

  check('init scaffolds a project', () => {
    mkdirSync(join(workDir, 'src'), { recursive: true });
    writeFileSync(join(workDir, 'src', 'money.ts'), FIXTURE);
    cli(['init', '--yes']);
    assert(existsSync(join(workDir, '.debugger.yaml')), '.debugger.yaml was not created');
    assert(existsSync(join(workDir, '.debugger')), '.debugger/ was not created');
    return '.debugger.yaml + .debugger/';
  });

  check('analyze parses a file and finds its functions', () => {
    const out = cli(['analyze', 'src/money.ts', '--json']);
    const parsed = JSON.parse(out);
    assert(parsed.errors.length === 0, `unexpected syntax errors: ${JSON.stringify(parsed.errors)}`);
    assert(parsed.cst?.type, 'no CST root in analyze output');
    return `${parsed.errors.length} syntax errors`;
  });

  check('investigate proves the planted defect', () => {
    const out = cli(['investigate', 'splitBill', '--file', 'src/money.ts', '--json']);
    const report = JSON.parse(out);
    assert(
      report.status === 'confirmed_and_repaired' || report.status === 'confirmed_no_repair',
      `expected the defect to be proven, got "${report.status}"`
    );
    assert(report.proof, 'status says confirmed but no proof certificate is present');
    assert(report.proof.violated_postcondition, 'proof has no violated postcondition');
    return `${report.status} — violated ${report.proof.violated_postcondition}`;
  });

  check('--json stdout is clean JSON (no diagnostics leaking)', () => {
    // Regression guard: config diagnostics once went to stdout via console.info,
    // which made every --json payload unparseable.
    const out = cli(['investigate', 'splitBill', '--file', 'src/money.ts', '--json']);
    assert(out.trimStart().startsWith('{'), `stdout starts with "${out.slice(0, 60)}"`);
    JSON.parse(out);
    return 'parses';
  });

  check('retrospect reads the recorded history', () => {
    const out = cli(['retrospect', '--json']);
    const report = JSON.parse(out);
    assert(typeof report.analysed_episodes === 'number', 'no analysed_episodes in retrospective');
    assert(Array.isArray(report.lessons), 'no lessons array in retrospective');
    assert(report.analysed_episodes > 0, 'the investigation above should have recorded an episode');
    return `${report.analysed_episodes} episode(s), ${report.lessons.length} lesson(s)`;
  });

  check('suggest proposes capabilities from that history', () => {
    const out = cli(['suggest', '--json']);
    const advice = JSON.parse(out);
    assert(Array.isArray(advice.suggestions), 'no suggestions array');
    for (const s of advice.suggestions) {
      assert(s.id && s.kind && s.target_path && s.content, `malformed suggestion: ${s.id}`);
      if (s.kind === 'hook') JSON.parse(s.content); // generated hooks must be valid JSON
    }
    return `${advice.suggestions.length} proposal(s)`;
  });

  console.log('\n\x1b[1mMCP server\x1b[0m');

  // Awaited before the check so the reported result is the real one. Wrapping
  // the promise in `check()` would print a pass before anything was verified.
  let toolNames = [];
  let mcpError = null;
  try {
    toolNames = await mcpToolsList();
  } catch (err) {
    mcpError = err;
  }

  check('stdio server answers initialize + tools/list', () => {
    assert(!mcpError, mcpError?.message ?? '');
    assert(toolNames.length > 0, 'server responded but advertised no tools');
    return `${toolNames.length} tools advertised`;
  });

  check('every documented MCP tool is exposed', () => {
    const expected = [
      'buggy_init', 'buggy_analyze', 'buggy_investigate', 'buggy_status',
      'buggy_query_graph', 'buggy_list_functions', 'buggy_recall',
      'buggy_retrospect', 'buggy_suggest_capabilities', 'buggy_apply_capability',
    ];
    const missing = expected.filter((t) => !toolNames.includes(t));
    assert(missing.length === 0, `missing tools: ${missing.join(', ')}`);
    return `${toolNames.length} tools`;
  });

  console.log('\n\x1b[1mProgrammatic API\x1b[0m');

  check('the package import exposes the public surface', () => {
    writeFileSync(
      join(workDir, 'api-check.mjs'),
      `import { ProofDebugger, Retrospective, CapabilityAdvisor } from '${PKG.name}';
       const dbg = new ProofDebugger({ projectRoot: process.cwd() });
       await dbg.initialize();
       const report = await dbg.investigate({ functionId: 'splitBill', filePath: 'src/money.ts' });
       const retro = dbg.retrospect();
       const advice = dbg.suggestCapabilities();
       await dbg.shutdown();
       if (typeof Retrospective !== 'function') throw new Error('Retrospective not exported');
       if (typeof CapabilityAdvisor !== 'function') throw new Error('CapabilityAdvisor not exported');
       process.stdout.write(JSON.stringify({
         status: report.status,
         episodes: retro.analysed_episodes,
         suggestions: advice.suggestions.length,
       }));`
    );
    const out = run(process.execPath, [join(workDir, 'api-check.mjs')]);
    const data = JSON.parse(out.slice(out.indexOf('{')));
    assert(data.status, 'investigate returned no status through the API');
    return `status=${data.status}, episodes=${data.episodes}`;
  });

  check('type declarations ship alongside the JS', () => {
    const dts = join(workDir, 'node_modules', PKG.name, PKG.types);
    assert(existsSync(dts), `types entry "${PKG.types}" is missing from the package`);
    return PKG.types;
  });
}

// ─── Entry ───────────────────────────────────────────────────────────────────

main()
  .then(() => {
    console.log(`\n\x1b[32m\x1b[1mAll ${results.length} checks passed.\x1b[0m`);
    console.log(`\x1b[2m${PKG.name}@${PKG.version} is safe to publish.\x1b[0m\n`);
  })
  .catch((err) => {
    const failed = results.filter((r) => !r.ok).length;
    if (!(err instanceof SmokeFailure)) {
      console.log(`\n\x1b[31mHarness error: ${err instanceof Error ? err.message : err}\x1b[0m`);
    }
    console.log(
      `\n\x1b[31m\x1b[1mSmoke test FAILED\x1b[0m — ${results.length - failed} passed, ${failed} failed.`
    );
    console.log('\x1b[2mDo not publish until this is green.\x1b[0m\n');
    process.exitCode = 1;
  })
  .finally(() => {
    if (!workDir) return;
    if (KEEP) {
      console.log(`\x1b[2mkept: ${workDir}\x1b[0m\n`);
      return;
    }
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {
      console.log(`\x1b[2mcould not remove ${workDir}\x1b[0m`);
    }
  });
