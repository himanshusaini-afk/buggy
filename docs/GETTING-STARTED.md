# Buggy — Getting Started

A practical walkthrough: how to add Buggy to your project and use it day to day.
Buggy is a proof-carrying debugger. It finds a concrete input that breaks a
function, **proves** the bug reproduces, proposes fixes, and rejects fixes that
only paper over the failing test. It runs as a CLI, an MCP server (for Kiro /
Cursor / Windsurf), and a programmatic API, and it remembers what it learns.

- **Full support:** TypeScript, JavaScript.
- **Python:** bug proving works today; `analyze`/`list_functions` need an optional grammar (see §10).
- **Requires:** Node.js ≥ 18.

---

## 1. Install

Add it as a dev dependency (recommended) or install globally for the CLI.

```bash
npm install --save-dev buggy      # project-local
# or
npm install -g buggy              # global CLI
```

This gives you two executables: `buggy` (CLI) and `buggy-mcp` (MCP server).

---

## 2. Initialize in your project

From your project root:

```bash
npx buggy init
```

This creates:

- `.debugger.yaml` — configuration.
- `.debugger/` — working directory (SQLite graph DB + the local watchlist memory).

Then git-ignore the working directory (keep the config):

```bash
echo ".debugger/" >> .gitignore
```

---

## 3. Configure `.debugger.yaml`

The generated file is ready to use. The fields that matter most:

```yaml
language: typescript          # or: python
parser:   { command: tree-sitter-typescript }
lsp:      { command: typescript-language-server }   # optional (symbol resolution)
sandbox:  { runtime: node, memory_limit_mb: 512, timeout_seconds: 60 }
oracles:  { timeout_threshold_seconds: 10, crash_detection: true,
            overflow_detection: true, determinism_check_count: 5 }
probe:    { search_budget: 100, max_refinement_iterations: 10 }

# Experience memory — records what worked / what failed and feeds it back (see §9)
watchlist: { enabled: true, scope: layered }
```

- `oracles.timeout_threshold_seconds` — how long a function may run before it's flagged as a hang (catches infinite loops).
- `watchlist.scope` — `local` (private), `team` (committed steering), `global` (cross-project), or `layered` (all; default). Use `local` for sensitive repos.

---

## 4. Your first analysis

`analyze` parses a file and reports structure and syntax errors. It's fast and needs no spec.

```bash
npx buggy analyze src/embeddings.ts
```

```
✓ Parsed src/embeddings.ts
  Duration:   9.65ms
  Errors:     0
  Root type:  program
  Node count: 587
```

Use this (and `buggy_list_functions` over MCP) to find risky functions to investigate next.

---

## 5. Your first investigation — the core loop

`investigate` runs the full pipeline (Parse → Prove → Repair → Classify) on one function.

```bash
npx buggy investigate cosineSimilarity --file src/embeddings.ts
```

```
status: confirmed_no_repair
proof.test_input:            [[], []]        # two empty embedding vectors
proof.observed_output:       NaN
proof.violated_postcondition: !isNaN(result)
patches: 0 approved, 3 rejected
```

Buggy handed you the exact input that breaks the function. Now fix it with the trigger in hand:

```ts
// before
return dot / (Math.sqrt(normA) * Math.sqrt(normB));   // 0 / 0 = NaN for a zero vector

// after
const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
if (magnitude === 0) return 0;                          // guard the proven trigger
return dot / magnitude;
```

Re-run the same command to confirm it now reports `unconfirmed` (no bug found).

### Reading the status

| Status | Meaning |
|---|---|
| `confirmed_and_repaired` | Bug proven **and** at least one non-overfit fix approved |
| `confirmed_no_repair` | Bug proven, but every candidate fix was rejected as overfit — you write the fix |
| `unconfirmed` | No bug found under the given spec/budget |
| `halted` | Investigation was stopped |

> Buggy is deliberately conservative about fixes: it would rather give you a proven bug than auto-apply a patch that only satisfies the one failing input.

---

## 6. What the CLI catches vs. custom specs

The **CLI** `investigate` runs with inferred/empty specifications, so it catches the always-on oracles with zero setup:

- **Crashes** (uncaught exceptions)
- **Timeouts** (infinite loops / pathological inputs)
- **NaN / Infinity** in the output
- **Non-determinism** (different output for the same input)

To assert **custom pre/postconditions** (e.g. "result is between -1 and 1"), use the MCP tool or the API, which accept a specification. Preconditions filter which inputs count; postconditions are the properties the output must satisfy.

```jsonc
// via MCP (buggy_investigate)
{
  "function_id": "cosineSimilarity",
  "file_path": "src/embeddings.ts",
  "preconditions": [],
  "postconditions": ["!isNaN(result)", "result >= -1", "result <= 1"]
}
```

**Writing good specs:**
- Division → `!isNaN(result) && isFinite(result)`
- Money / counts → `result >= 0`
- Array access → precondition about length, or postcondition `Array.isArray(result)`
- Postconditions are JavaScript expressions; `result` is the return value, and parameter names are in scope.

---

## 7. Use it three ways

### A. CLI (local + CI)

```bash
npx buggy analyze <file>
npx buggy investigate <fn> --file <path>          # add --json for machine-readable output
npx buggy status <id>
npx buggy halt <id>
```

Great for a pre-merge CI gate on hot files.

### B. Kiro (zero-effort — recommended)

Point Kiro at the MCP server once, then it calls Buggy automatically.

```jsonc
// .kiro/settings/mcp.json  (workspace)  — or ~/.kiro/settings/mcp.json (all projects)
{ "mcpServers": { "buggy": { "command": "npx", "args": ["buggy-mcp"] } } }
```

Buggy ships **7 MCP tools** Kiro can call: `buggy_init`, `buggy_analyze`,
`buggy_investigate`, `buggy_status`, `buggy_query_graph`, `buggy_list_functions`,
and `buggy_recall`.

It also ships Kiro **hooks** (automatic behavior) and **steering** (guidance). Once you commit `.kiro/`, every teammate gets:

- analyze-on-save, verify-after-Kiro-writes-code, pre-spec-task scan
- a self-healing auto-fix loop after the agent finishes
- a user-triggered deep scan
- **recall-first**: before Kiro edits a function, it consults the memory (§9) so it reuses fixes that worked and avoids ones that were rejected

You don't run commands — you just code, and bugs surface in seconds.

### C. Programmatic API (scripts / integrations)

```ts
import { ProofDebugger } from 'buggy';

const dbg = new ProofDebugger({ projectRoot: process.cwd() });
await dbg.initialize();

const report = await dbg.investigate({
  functionId: 'cosineSimilarity',
  filePath: 'src/embeddings.ts',
  specification: {
    postconditions: ['!isNaN(result)', 'result >= -1', 'result <= 1'],
    parameters: [{ name: 'a', type: 'number[]' }, { name: 'b', type: 'number[]' }],
    return_type: 'number',
  },
});
console.log(report.status, report.proof?.test_input);

// Consult the memory before making a change
const { seen_before, lessons } = dbg.recall({ function_id: 'cosineSimilarity' });

await dbg.shutdown();
```

---

## 8. A full first-run, end to end

1. `npx buggy init` and add `.debugger/` to `.gitignore`.
2. `npx buggy analyze src/retriever.ts` — see the functions and confirm it parses clean.
3. `npx buggy investigate bm25Score --file src/retriever.ts` — Buggy proves `avgDocLength = 0` yields `NaN`.
4. Fix it (`const safeAvg = avgDocLength > 0 ? avgDocLength : 1;`) using the trigger.
5. Re-run — now `unconfirmed`.
6. The episode is recorded automatically; next time anyone touches `bm25Score`, `buggy_recall` surfaces the lesson.

---

## 9. The Watchlist — experience memory

Every investigation writes one **episode** (what was tried, what worked, what failed and how). Verified, proof-backed episodes become **lessons** that are fed back before the next change.

| Scope | Lives in | Shared with |
|---|---|---|
| local | `.debugger/` (git-ignored) | nobody — raw episodes |
| team | `.kiro/steering/buggy-watchlist.md` (committed) | teammates on the repo |
| global | `~/.buggy/` + user-level steering | all your projects (sanitized, ≥2-project corroboration) |

- **Recall** it anytime: the `buggy_recall` tool, or `ProofDebugger.recall({ function_id })`. Project lessons win over global on conflict.
- **Safety:** only proof-backed lessons promote; the global tier is sanitized of code, paths, and literal values; investigations never modify your source.
- **Metrics:** `ProofDebugger.watchlistStats()` shows totals, outcomes, and the most-recurring lessons (a proxy for whether fixes are sticking).

This is what makes Buggy get better with each iteration.

---

## 10. Python projects

Set the language and run investigations exactly as above:

```yaml
# .debugger.yaml
language: python
sandbox: { runtime: python, timeout_seconds: 30 }
```

```bash
npx buggy investigate split_expense --file src/expenses.py
# status: confirmed_no_repair
# proof.test_input: [0, 0]  →  ZeroDivisionError: division by zero
```

Buggy runs the function in your system `python` to prove the bug (no grammar needed).
Language-specific behavior is captured faithfully — e.g. `x / 0` **raises** in
Python (vs. `Infinity` in JS).

**One caveat:** Python `analyze` / `list_functions` (CST features) need the
Tree-sitter Python grammar. Install it once in an environment with npm access —
the parser detects it automatically, no code change:

```bash
npm install tree-sitter-python --legacy-peer-deps
```

Until then, Python **proving works**; only Python parsing/analyze is degraded.

---

## 11. Roll it out to your team

The Kiro integration ships per-repo, not via npm:

```bash
git add .kiro/            # 7 hooks + steering, incl. the committed team watchlist
git commit -m "Add Buggy: automatic proof-carrying bug detection"
```

Every teammate who opens the project in Kiro now gets automatic detection and
inherits the team's proven lessons — with no setup. Add the `mcp.json` snippet
from §7B so the MCP server is available.

---

## 12. Troubleshooting & honest limits

- **`unconfirmed` on a function you think is buggy.** The fuzzer didn't find a trigger within budget, or your spec is too weak. Add postconditions (via MCP/API), or raise `probe.search_budget` / `oracles.timeout_threshold_seconds`.
- **Bug proven, all fixes rejected (`confirmed_no_repair`).** Expected and safe — apply the guard yourself using the trigger. Buggy won't ship an overfit fix.
- **Array/object-input functions are harder to trigger** than scalar/numeric ones; give tighter parameter types and preconditions.
- **Sandbox is process-level, not VM-level.** Functions run in a forked Node / spawned Python subprocess sharing host FS and network. Fine for your own code; do **not** point it at untrusted third-party code expecting containment.
- **Repair candidates are screened for overfitting, not compile/test-verified** on the default path.

---

## 13. Quick reference

```bash
# CLI
npx buggy init
npx buggy analyze <file>
npx buggy investigate <fn> --file <path> [--json] [--verbose]
npx buggy status <id>
npx buggy halt <id>
```

| MCP tool | Purpose |
|---|---|
| `buggy_init` | Initialize for a project |
| `buggy_analyze` | Parse + list functions + syntax errors |
| `buggy_investigate` | Full pipeline (accepts pre/postconditions) |
| `buggy_status` | Investigation status |
| `buggy_query_graph` | Query the semantic graph |
| `buggy_list_functions` | List functions in a file |
| `buggy_recall` | Recall prior watchlist lessons before editing |

```ts
// API surface
new ProofDebugger({ projectRoot }); initialize(); parse(); investigate();
recall(); watchlistStats(); getStatus(); halt(); queryCallees(); shutdown();
```

See `docs/Buggy-Usage-and-Sandbox-Guide.pdf` for capabilities, the RAG walkthrough, and the sandbox in depth.
