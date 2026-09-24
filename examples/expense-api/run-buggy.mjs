/**
 * Full Buggy run over the expense-api example, logging every phase so the
 * internals are visible: config in use, parse results, the specification handed
 * to each investigation, the proof certificate with its three verification
 * stamps, every candidate patch (approved and rejected) with its diff and
 * overfitting score, per-phase timings, and the experience memory.
 *
 * Usage, from the Buggy repo root after `npm run build`:
 *   node examples/expense-api/run-buggy.mjs
 *
 * Writes to ./logs:
 *   run.log               full human-readable transcript
 *   investigations.jsonl  one JSON record per function (machine-readable)
 *   patches.md            every candidate fix with its diff and score
 *   summary.md            findings table
 *   watchlist.log         what Buggy remembered for next time
 */
import { writeFileSync, appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ProofDebugger } from '../../dist/index.js';
import { initializeDatabase } from '../../dist/database/graph-db.js';

const root = dirname(fileURLToPath(import.meta.url));
const logsDir = join(root, 'logs');
mkdirSync(logsDir, { recursive: true });

const runLog = join(logsDir, 'run.log');
writeFileSync(runLog, '');
const log = (s = '') => {
  appendFileSync(runLog, s + '\n');
  console.log(s);
};
const rule = (ch = '─') => log(ch.repeat(78));
const countNodes = (n) => 1 + n.children.reduce((a, c) => a + countNodes(c), 0);
const ms = (a, b) => `${new Date(b) - new Date(a)}ms`;

// ── Specifications ──────────────────────────────────────────────────────────
// Preconditions filter which generated inputs count as valid; postconditions are
// the properties the result must satisfy. Both are JavaScript expressions even
// for Python targets: `result` is the return value and parameter names are in
// scope. Declaring `parameters` matters most — without it the harness guesses the
// arity and can call a 2-arg function with 1 argument.
const finite = (n, lo = 0, hi = 100000) =>
  `Number.isFinite(${n}) && ${n} >= ${lo} && ${n} <= ${hi}`;

const TARGETS = [
  {
    file: 'src/expenses.py',
    fn: 'split_expense',
    why: 'divides by a caller-supplied count',
    pre: [finite('amount'), finite('people')],
    post: ['isFinite(result)', '!isNaN(result)'],
    params: [{ name: 'amount', type: 'float' }, { name: 'people', type: 'float' }],
    returns: 'float',
  },
  {
    file: 'src/expenses.py',
    fn: 'average_expense',
    why: 'averages a collection that may be empty',
    pre: ['Array.isArray(amounts) && amounts.every(v => Number.isFinite(v))'],
    post: ['isFinite(result)', '!isNaN(result)'],
    params: [{ name: 'amounts', type: 'number[]' }],
    returns: 'float',
  },
  {
    file: 'src/expenses.py',
    fn: 'apply_discount',
    why: 'applies a percentage that is never clamped',
    pre: [finite('price'), finite('percent_off')],
    post: ['result >= 0'],
    params: [{ name: 'price', type: 'float' }, { name: 'percent_off', type: 'float' }],
    returns: 'float',
  },
  {
    file: 'src/expenses.py',
    fn: 'monthly_average',
    why: 'control case — divisor is a non-zero constant',
    pre: [finite('yearly_total')],
    post: ['isFinite(result)', '!isNaN(result)'],
    params: [{ name: 'yearly_total', type: 'float' }],
    returns: 'float',
  },
  {
    file: 'src/budget.py',
    fn: 'budget_usage',
    why: 'divides by a caller-supplied budget',
    pre: [finite('spent'), finite('budget')],
    post: ['isFinite(result)', '!isNaN(result)'],
    params: [{ name: 'spent', type: 'float' }, { name: 'budget', type: 'float' }],
    returns: 'float',
  },
  {
    file: 'src/budget.py',
    fn: 'remaining_budget',
    why: 'control case — clamped at 0',
    pre: [finite('budget'), finite('spent')],
    post: ['result >= 0'],
    params: [{ name: 'budget', type: 'float' }, { name: 'spent', type: 'float' }],
    returns: 'float',
  },
  {
    file: 'src/budget.py',
    fn: 'clamp_percent',
    why: 'control case — bounded by construction',
    pre: [finite('value', -100000, 100000)],
    post: ['result >= 0', 'result <= 100'],
    params: [{ name: 'value', type: 'float' }],
    returns: 'float',
  },
];

// ── Header ──────────────────────────────────────────────────────────────────
log('BUGGY RUN — expense-api example');
log(new Date().toISOString());
rule('═');
log('');
log('Pipeline per function:  Parse → Prove → Repair → Classify');
log('Buggy never edits your source: patches are returned as data for you to');
log('review. Nothing below was written to src/.');
log('');

// ── Phase 0: configuration ──────────────────────────────────────────────────
rule();
log('PHASE 0 — CONFIGURATION (.debugger.yaml, created by `buggy init`)');
rule();
for (const line of readFileSync(join(root, '.debugger.yaml'), 'utf-8').split('\n')) {
  if (line.trim() && !line.trim().startsWith('#')) log('  ' + line);
}
log('');
log('  language: python  → selects BOTH the Tree-sitter grammar and the runtime.');
log('  Functions are executed in a real python process to prove bugs.');
log('');

const dbg = new ProofDebugger({ projectRoot: root, language: 'python' });
await dbg.initialize();

// ── Phase 1: parse ──────────────────────────────────────────────────────────
rule();
log('PHASE 1 — PARSE (Parser_Agent, Tree-sitter)');
rule();
for (const file of ['src/expenses.py', 'src/budget.py']) {
  const pr = await dbg.parse(file);
  const fns = [];
  (function walk(n) {
    if (n.type === 'function_definition') {
      const id = n.children.find((c) => c.type === 'identifier');
      fns.push(id ? id.text : '?');
    }
    for (const c of n.children) walk(c);
  })(pr.cst);
  log(`  ${file}`);
  log(`    root node:      ${pr.cst.type}   (a real Python parse; "program" would mean the TS fallback)`);
  log(`    total nodes:    ${countNodes(pr.cst)}`);
  log(`    syntax errors:  ${pr.errors.length}`);
  log(`    functions:      ${fns.join(', ')}`);
  log(`    parse time:     ${pr.duration_ms.toFixed(2)}ms`);
  log('');
}

// ── Phase 2-4: prove, repair, classify ──────────────────────────────────────
rule();
log('PHASE 2-4 — PROVE, REPAIR, CLASSIFY (per function)');
rule();
log('');

const results = [];
const patchDocs = [];

for (const t of TARGETS) {
  rule('·');
  log(`FUNCTION  ${t.fn}   (${t.file})`);
  log(`  why targeted: ${t.why}`);
  log('');
  log('  SPECIFICATION handed to the prover:');
  log(`    parameters:     ${t.params.map((p) => `${p.name}: ${p.type}`).join(', ')}`);
  log(`    return type:    ${t.returns}`);
  for (const p of t.pre) log(`    precondition:   ${p}`);
  for (const p of t.post) log(`    postcondition:  ${p}`);
  log('');

  const started = Date.now();
  const rep = await dbg.investigate({
    functionId: t.fn,
    filePath: t.file,
    specification: {
      preconditions: t.pre,
      postconditions: t.post,
      parameters: t.params,
      return_type: t.returns,
    },
  });
  const elapsed = Date.now() - started;

  log(`  RESULT: ${rep.status}   (${elapsed}ms)`);
  log('');

  if (rep.proof) {
    log('  PROOF-OF-FAILURE CERTIFICATE');
    log(`    triggering input:   ${JSON.stringify(rep.proof.test_input)}`);
    log(`    observed output:    ${JSON.stringify(rep.proof.observed_output)}   (null = NaN/None or a raised error)`);
    log(`    violated rule:      ${rep.proof.violated_postcondition}`);
    log('    verification:');
    log(`      admissible  ${rep.proof.admissibility_verified_at}   (input satisfies the preconditions)`);
    log(`      sound       ${rep.proof.soundness_verified_at}   (re-running really does violate the rule)`);
    log(`      unique      ${rep.proof.uniqueness_verified_at}   (failure attributed to this function)`);
  } else {
    log('  No violating input found within budget.');
    log('    NOTE: "unconfirmed" means not-found-within-budget, NOT proven safe.');
  }
  log('');

  const ir = rep.intermediate_results ?? {};
  log('  WORK DONE');
  log(`    CST nodes parsed:   ${ir.cst_nodes_parsed ?? 'n/a'}`);
  log(`    inputs tried:       ${ir.fuzz_mutations ?? 'n/a'}`);
  log(`    violations found:   ${ir.violations_found ?? 0}`);
  log(`    patches generated:  ${ir.patches_generated ?? 0}`);
  log(`    patches approved:   ${ir.patches_approved ?? 0}`);
  log('');

  log('  PHASE TIMINGS');
  for (const p of rep.timeline) {
    log(`    ${p.phase.padEnd(15)} ${p.agent.padEnd(20)} ${ms(p.started_at, p.completed_at)}`);
  }
  log('');

  const allPatches = [
    ...rep.approved_patches.map((p) => ({ ...p, verdict: 'APPROVED' })),
    ...rep.rejected_patches.map((p) => ({ ...p, verdict: 'REJECTED' })),
  ];

  if (allPatches.length > 0) {
    log('  CANDIDATE FIXES (proposed only — you decide whether to apply)');
    patchDocs.push(`\n## \`${t.fn}\` (${t.file}) — ${rep.status}\n`);
    if (rep.proof) {
      patchDocs.push(
        `Trigger: \`${JSON.stringify(rep.proof.test_input)}\` → ${rep.proof.violated_postcondition}\n`
      );
    }
    for (const p of allPatches) {
      const score = (p.classification.overfitting_probability * 100).toFixed(1);
      log(`    [${p.verdict}] overfitting ${score}%  lines ${p.patch.target_range.start_line}-${p.patch.target_range.end_line}`);
      if (p.verdict === 'REJECTED') log(`       reason: ${p.rejection_reason}`);
      for (const line of p.patch.diff.split('\n')) log(`       │ ${line}`);
      patchDocs.push(`**${p.verdict}** — overfitting ${score}%`);
      if (p.verdict === 'REJECTED') patchDocs.push(`Rejected because: ${p.rejection_reason}`);
      patchDocs.push('```python\n' + p.patch.diff + '\n```\n');
    }
  } else {
    log('  No candidate fixes generated (nothing to repair).');
  }
  log('');

  results.push({
    file: t.file,
    function: t.fn,
    status: rep.status,
    elapsed_ms: elapsed,
    proof: rep.proof
      ? {
          test_input: rep.proof.test_input,
          observed_output: rep.proof.observed_output,
          violated_postcondition: rep.proof.violated_postcondition,
        }
      : null,
    specification: { preconditions: t.pre, postconditions: t.post, parameters: t.params },
    approved_patches: rep.approved_patches.length,
    rejected_patches: rep.rejected_patches.length,
    intermediate_results: ir,
  });
}

// ── Phase 5: memory ─────────────────────────────────────────────────────────
rule();
log('PHASE 5 — EXPERIENCE MEMORY (Watchlist)');
rule();
const stats = dbg.watchlistStats();
const recallTarget = results.find((r) => r.proof)?.function;
const recall = recallTarget ? dbg.recall({ function_id: recallTarget }) : null;
log(`  episodes recorded:  ${stats.total_episodes}`);
log(`  verified episodes:  ${stats.verified_episodes}`);
log(`  distinct lessons:   ${stats.distinct_lessons}`);
log(`  outcomes:           ${JSON.stringify(stats.outcomes)}`);
log('');
if (recall) {
  log(`  RECALL — what Buggy tells an agent before it edits \`${recallTarget}\`:`);
  log(`    seen_before: ${recall.seen_before}   lessons: ${recall.lessons.length}`);
  for (const l of recall.lessons.slice(0, 3)) {
    log(`      • [${l.tier}] ${l.title}`);
    if (l.trigger_shape) log(`          trigger: ${l.trigger_shape}`);
    if (l.what_failed?.length) log(`          what failed before: ${l.what_failed[0]}`);
  }
}
log('');

await dbg.shutdown();

// ── Artifacts ───────────────────────────────────────────────────────────────
writeFileSync(
  join(logsDir, 'investigations.jsonl'),
  results.map((r) => JSON.stringify(r)).join('\n') + '\n'
);

const proven = results.filter((r) => r.proof);
const clean = results.filter((r) => !r.proof);
writeFileSync(
  join(logsDir, 'summary.md'),
  `# Buggy findings — expense-api

_Generated ${new Date().toISOString()}_

**${proven.length} bugs proven** across ${results.length} functions (${clean.length} reported clean).

| Function | File | Status | Trigger | Violated rule |
|---|---|---|---|---|
${results
  .map(
    (r) =>
      `| \`${r.function}\` | ${r.file.replace('src/', '')} | ${r.status} | ${
        r.proof ? '`' + JSON.stringify(r.proof.test_input) + '`' : '—'
      } | ${r.proof ? r.proof.violated_postcondition.replace(/\|/g, '\\|') : '—'} |`
  )
  .join('\n')}

## Proven bugs
${proven.map((r) => `- **${r.function}** — \`${JSON.stringify(r.proof.test_input)}\` → ${r.proof.violated_postcondition}`).join('\n')}

## Reported clean (no violating input within budget)
${clean.map((r) => `- ${r.function} (${r.file})`).join('\n')}

> \`unconfirmed\` means "no failing input found within the search budget" — it is
> not a proof of safety. A proven bug, by contrast, is always a true positive:
> it was re-executed and observed to fail.
`
);

writeFileSync(
  join(logsDir, 'patches.md'),
  `# Candidate fixes — expense-api

_Generated ${new Date().toISOString()}_

Every fix Buggy proposed, with the overfitting score the classifier assigned.
**None of these were applied** — Buggy returns patches as data so you stay in
control. Scores above the 0.5 threshold are rejected as likely overfit.
${patchDocs.join('\n')}`
);

let wl = `Watchlist experience memory — expense-api\n${new Date().toISOString()}\n${'='.repeat(60)}\n\n`;
try {
  const db = initializeDatabase(join(root, '.debugger', 'graph.db'));
  const episodes = db
    .prepare(
      `SELECT function_id, language, outcome, failure_class, defect_class, trigger_json
         FROM watchlist_episodes ORDER BY created_at`
    )
    .all();
  db.close();
  wl += `EPISODES (${episodes.length}):\n`;
  for (const e of episodes) {
    const trig = e.trigger_json ? JSON.parse(e.trigger_json).input : undefined;
    wl += `  • [${e.language}] ${String(e.function_id).padEnd(18)} ${String(e.outcome).padEnd(22)} class=${e.failure_class ?? '-'} trigger=${JSON.stringify(trig)}\n`;
  }
} catch (err) {
  wl += `(could not read episodes: ${err.message})\n`;
}
wl += `\nSTATS: ${JSON.stringify({
  total_episodes: stats.total_episodes,
  verified: stats.verified_episodes,
  distinct_lessons: stats.distinct_lessons,
  outcomes: stats.outcomes,
})}\n`;
writeFileSync(join(logsDir, 'watchlist.log'), wl);

// ── Console summary ─────────────────────────────────────────────────────────
rule('═');
log(`  SUMMARY: ${proven.length} bugs proven / ${results.length} functions investigated`);
rule('═');
for (const r of results) {
  const icon = r.proof ? 'BUG ' : 'ok  ';
  log(`  ${icon} ${r.function.padEnd(18)} ${r.status.padEnd(22)} ${r.proof ? JSON.stringify(r.proof.test_input) : ''}`);
}
log('');
log('  Logs written to examples/expense-api/logs/:');
log('    run.log · investigations.jsonl · patches.md · summary.md · watchlist.log');
