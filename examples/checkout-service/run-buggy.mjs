/**
 * End-to-end Buggy run for the checkout-service example.
 *
 * Runs the full pipeline (Parse -> Prove -> Repair -> Classify) over the TS and
 * Python sources and writes human-readable logs to ./logs:
 *   - run.log              full transcript
 *   - investigations.jsonl one JSON record per function investigated
 *   - summary.md           a readable table of findings
 *   - watchlist.log        the experience memory (episodes, recall, stats)
 *
 * Usage (from the Buggy repo root, after `npm run build`):
 *   node examples/checkout-service/run-buggy.mjs
 */
import { writeFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ProofDebugger } from '../../dist/index.js';
import { initializeDatabase } from '../../dist/database/graph-db.js';

const root = dirname(fileURLToPath(import.meta.url));
const logsDir = join(root, 'logs');
mkdirSync(logsDir, { recursive: true });

const runLog = join(logsDir, 'run.log');
writeFileSync(runLog, `Buggy end-to-end run — checkout-service\n${new Date().toISOString()}\n${'='.repeat(60)}\n`);
const log = (s = '') => { appendFileSync(runLog, s + '\n'); console.log(s); };

const countNodes = (n) => 1 + n.children.reduce((a, c) => a + countNodes(c), 0);

// Realistic input scoping: real prices/quantities/counts are finite and in a
// sane range. Without this, the fuzzer's NaN/Infinity injection makes EVERY
// arithmetic function look buggy (f(NaN) = NaN). Preconditions filter those out
// so the meaningful bugs (negative price, div-by-zero, empty array) surface.
const fin = (name, lo = 0, hi = 100000) =>
  `Number.isFinite(${name}) && ${name} >= ${lo} && ${name} <= ${hi}`;

const TS_TARGETS = [
  { file: 'src/pricing.ts', fn: 'applyDiscount', post: ['result >= 0'],
    pre: [fin('price'), fin('percentOff')],
    params: [{ name: 'price', type: 'number' }, { name: 'percentOff', type: 'number' }] },
  { file: 'src/pricing.ts', fn: 'pricePerUnit', post: ['isFinite(result)', '!isNaN(result)'],
    pre: [fin('total'), fin('quantity')],
    params: [{ name: 'total', type: 'number' }, { name: 'quantity', type: 'number' }] },
  { file: 'src/pricing.ts', fn: 'averageOrderValue', post: ['!isNaN(result)', 'isFinite(result)'],
    pre: ['Array.isArray(orders) && orders.every(v => Number.isFinite(v))'],
    params: [{ name: 'orders', type: 'number[]' }] },
  { file: 'src/pricing.ts', fn: 'taxAmount', post: ['isFinite(result)'],
    pre: [fin('subtotal'), fin('rate')],
    params: [{ name: 'subtotal', type: 'number' }, { name: 'rate', type: 'number' }] },
  { file: 'src/inventory.ts', fn: 'stockCoverageDays', post: ['isFinite(result)', '!isNaN(result)'],
    pre: [fin('stock'), fin('dailyUsage')],
    params: [{ name: 'stock', type: 'number' }, { name: 'dailyUsage', type: 'number' }] },
  { file: 'src/inventory.ts', fn: 'reorderQuantity', post: ['result >= 0'],
    pre: [fin('target'), fin('current')],
    params: [{ name: 'target', type: 'number' }, { name: 'current', type: 'number' }] },
];

const PY_TARGETS = [
  { file: 'src/discounts.py', fn: 'split_payment', post: ['isFinite(result)'],
    pre: [fin('total'), fin('people')],
    params: [{ name: 'total', type: 'float' }, { name: 'people', type: 'float' }] },
  { file: 'src/discounts.py', fn: 'bulk_unit_price', post: ['isFinite(result)', '!isNaN(result)'],
    pre: [fin('total'), fin('quantity')],
    params: [{ name: 'total', type: 'float' }, { name: 'quantity', type: 'float' }] },
  { file: 'src/discounts.py', fn: 'clamp_percent', post: ['result >= 0', 'result <= 100'],
    pre: [fin('value', -100000, 100000)],
    params: [{ name: 'value', type: 'float' }] },
];

const results = [];

async function pass(language, targets, filesToAnalyze) {
  log(`\n${'─'.repeat(60)}\n  ${language.toUpperCase()} PASS\n${'─'.repeat(60)}`);
  const dbg = new ProofDebugger({ projectRoot: root, language });
  await dbg.initialize();

  for (const f of filesToAnalyze) {
    try {
      const pr = await dbg.parse(f);
      log(`  analyze  ${f.padEnd(22)} nodes=${countNodes(pr.cst)} syntax_errors=${pr.errors.length}`);
    } catch (e) {
      log(`  analyze  ${f}: ERROR ${e.message}`);
    }
  }
  log('');

  for (const t of targets) {
    const started = Date.now();
    let rep;
    try {
      rep = await dbg.investigate({
        functionId: t.fn,
        filePath: t.file,
        specification: { preconditions: t.pre ?? [], postconditions: t.post, parameters: t.params, return_type: 'unknown' },
      });
    } catch (e) {
      log(`  investigate ${t.fn}: ERROR ${e.message}`);
      continue;
    }
    const ms = Date.now() - started;
    const entry = {
      language, file: t.file, function: t.fn, status: rep.status, elapsed_ms: ms,
      proof: rep.proof ? {
        test_input: rep.proof.test_input,
        observed_output: rep.proof.observed_output,
        violated_postcondition: rep.proof.violated_postcondition,
      } : null,
      approved_patches: rep.approved_patches.length,
      rejected_patches: rep.rejected_patches.length,
    };
    results.push(entry);
    const icon = rep.proof ? '🐛' : '✓ ';
    const detail = entry.proof
      ? `trigger=${JSON.stringify(entry.proof.test_input)}  →  ${entry.proof.violated_postcondition}`
      : 'no bug found';
    log(`  ${icon} ${t.fn.padEnd(20)} ${String(ms).padStart(6)}ms  ${rep.status.padEnd(20)} ${detail}`);
  }

  const stats = dbg.watchlistStats();
  await dbg.shutdown();
  return stats;
}

// ── Run both passes ─────────────────────────────────────────────────────────
const tsStats = await pass('typescript', TS_TARGETS, ['src/pricing.ts', 'src/inventory.ts']);
// Python analyze needs the tree-sitter-python grammar (optional); proving does not.
log(`\n${'─'.repeat(60)}\n  PYTHON PASS  (analyze skipped — grammar optional; proving runs via system python)\n${'─'.repeat(60)}`);
const pyStats = await pass('python', PY_TARGETS, []);

// ── investigations.jsonl ─────────────────────────────────────────────────────
writeFileSync(join(logsDir, 'investigations.jsonl'), results.map((r) => JSON.stringify(r)).join('\n') + '\n');

// ── summary.md ───────────────────────────────────────────────────────────────
const proven = results.filter((r) => r.proof);
const clean = results.filter((r) => !r.proof);
const rows = results.map((r) =>
  `| \`${r.function}\` | ${r.language} | ${r.file.replace('src/', '')} | ${r.status} | ${r.proof ? '`' + JSON.stringify(r.proof.test_input) + '`' : '—'} | ${r.proof ? r.proof.violated_postcondition.replace(/\|/g, '\\|') : '—'} |`
).join('\n');
const summary = `# Buggy findings — checkout-service

_Generated ${new Date().toISOString()}_

**${proven.length} bugs proven** across ${results.length} functions (${clean.length} clean).

| Function | Lang | File | Status | Trigger | Violated |
|---|---|---|---|---|---|
${rows}

## Proven bugs
${proven.map((r) => `- **${r.function}** (${r.file}) — trigger \`${JSON.stringify(r.proof.test_input)}\` → ${r.proof.violated_postcondition}`).join('\n')}

## Clean (no bug found)
${clean.map((r) => `- ${r.function} (${r.file})`).join('\n')}
`;
writeFileSync(join(logsDir, 'summary.md'), summary);

// ── watchlist.log (the experience memory) ────────────────────────────────────
let wl = `Watchlist experience memory — checkout-service\n${new Date().toISOString()}\n${'='.repeat(60)}\n\n`;
try {
  const db = initializeDatabase(join(root, '.debugger', 'graph.db'));
  const episodes = db.prepare(
    `SELECT function_id, language, outcome, failure_class, defect_class, lesson_key, trigger_json
       FROM watchlist_episodes ORDER BY created_at`
  ).all();
  db.close();
  wl += `EPISODES (${episodes.length} recorded):\n`;
  for (const e of episodes) {
    const trig = e.trigger_json ? JSON.parse(e.trigger_json).input : undefined;
    wl += `  • [${e.language}] ${e.function_id}  outcome=${e.outcome}  class=${e.failure_class}  trigger=${JSON.stringify(trig)}\n`;
    wl += `      lesson_key=${e.lesson_key}\n`;
  }
} catch (e) {
  wl += `(could not read episodes: ${e.message})\n`;
}

// Recall demo — what Kiro sees before editing a risky function.
const recallDbg = new ProofDebugger({ projectRoot: root });
await recallDbg.initialize();
const recall = recallDbg.recall({ function_id: 'pricePerUnit' });
const stats = recallDbg.watchlistStats();
await recallDbg.shutdown();

wl += `\nRECALL  buggy_recall({ function_id: "pricePerUnit" }):\n`;
wl += `  seen_before=${recall.seen_before}  lessons=${recall.lessons.length}\n`;
for (const l of recall.lessons) {
  wl += `  • [${l.tier}] ${l.title}\n`;
  if (l.what_failed) wl += `      what_failed: ${l.what_failed[0]}\n`;
  if (l.trigger_shape) wl += `      trigger: ${l.trigger_shape}\n`;
}
wl += `\nSTATS: ${JSON.stringify({ total_episodes: stats.total_episodes, verified: stats.verified_episodes, distinct_lessons: stats.distinct_lessons, outcomes: stats.outcomes }, null, 0)}\n`;
writeFileSync(join(logsDir, 'watchlist.log'), wl);

// ── Console summary ──────────────────────────────────────────────────────────
log(`\n${'='.repeat(60)}\n  SUMMARY: ${proven.length} bugs proven / ${results.length} functions\n${'='.repeat(60)}`);
log(`  Logs written to: ${logsDir}`);
log(`    run.log · investigations.jsonl · summary.md · watchlist.log`);
const teamSteering = join(root, '.kiro', 'steering', 'buggy-watchlist.md');
log(`  Team memory:  ${existsSync(teamSteering) ? teamSteering : '(not generated)'}`);
