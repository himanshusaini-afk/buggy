# Buggy — Features

What Buggy does, stated against the code that does it. Every count and claim
here was read off `src/` and confirmed by a test run at the version named below.

- **Package** — `buggy-debugger` v0.1.0, MIT licensed
- **Binaries** — `buggy` (CLI), `buggy-mcp` (MCP server)
- **Languages** — TypeScript, JavaScript, Python
- **Tests** — 931 passing across 48 files

> Two things worth knowing before you read further. Untrusted code runs in an OS
> child process, not a hardware-isolated VM. And an approved patch has passed the
> overfitting check only — it has not been compiled or test-run for you. Read the
> diff before you apply it.
>
> For the full list of what is and is not wired into the live pipeline, see
> [What runs today](#what-runs-today) at the end.

---

## The core idea

Static analysis tells you where a bug *might* be. AI assistants write a fix that
*looks* right. Neither proves anything, and both leave you the triage.

Buggy does not report a defect until it has produced a concrete input that
breaks the function, re-run that input, and confirmed the failure holds. What
you get is a witness, not a warning.

The same discipline applies to the fix: every candidate patch is scored for
overfitting, and high scorers are rejected even when they resolve the failure
that produced them.

---

## The pipeline — four phases

Driven by `AgentOrchestrator` (`src/orchestrator/orchestrator.ts`). Phases run in
order and each stamps a timeline entry as it completes. If a phase throws, the
run halts and keeps whatever earlier phases already produced.

| # | Phase | Agent | Produces |
|---|-------|-------|----------|
| 1 | `parsing` | `Parser_Agent` | CST, symbol resolutions, `cst_nodes_parsed` |
| 2 | `proving` | `Bug_Proving_Agent` | Proof-of-failure certificate, or nothing |
| 3 | `repair` | `Repair_Agent` | Candidate patches (capped at 20), `patches_generated` |
| 4 | `classification` | `Classifier_Agent` | Approved and rejected patches, `patches_approved` |

Phase 2 is a gate. If no certificate is produced the run ends as `unconfirmed`
and phases 3 and 4 never execute — Buggy will not propose a fix for a defect it
could not demonstrate.

**Four terminal statuses**, derived in `buildReport`:

| Status | Meaning |
|--------|---------|
| `confirmed_and_repaired` | Defect proven, at least one patch approved |
| `confirmed_no_repair` | Defect proven, every patch rejected as overfit |
| `unconfirmed` | No certificate — no defect demonstrated under the given spec |
| `halted` | A phase failed, or the operator halted the run |

A fifth agent, `Sandbox_Agent`, is available to the orchestrator on demand
(4 concurrent, 3 retries at 2s intervals). It is wired as a stub today — see
[What runs today](#what-runs-today).

---

## Proving

### Execution-based fuzzing

`src/agents/real-fuzzer.ts`. Inputs are generated edge-case-first, then
randomly. The edge cases are the values that break arithmetic in practice:

```
0, -0, NaN, Infinity, -Infinity
Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER
[] and single-element arrays
'' (empty string), null, undefined
```

Each candidate runs the real function in a child process — not a simulation and
not static reasoning. TypeScript and JavaScript execute under Node; Python
executes under a Python interpreter (`src/sandbox/executor-factory.ts`).

Because the NaN/Infinity oracle fires without any specification, division-style
defects are caught on the first attempt with no spec authored at all. Richer
defects need postconditions.

### Five oracles

Declared on `FuzzViolation.oracleType`:

| Oracle | Fires when |
|--------|-----------|
| `timeout` | Execution exceeds the configured threshold |
| `crash` | The function throws |
| `nan` | Result is NaN or non-finite |
| `postcondition` | A declared postcondition evaluates false |
| `determinism` | Repeated runs on one input disagree |

`timeout` and `crash` short-circuit — they are detected before any output check,
because there is no output to check.

### Three-pillar certification

A violation is not reported until it survives all three
(`BugProvingAgent.verifyAndCertify`):

| Pillar | Check |
|--------|-------|
| **Admissibility** | Every precondition re-evaluated against the triggering input. Prose preconditions that cannot be evaluated are skipped rather than treated as failures. |
| **Soundness** | The input is re-executed and the violation confirmed to hold. |
| **Reproducibility** | Three further executions; at least two must reproduce. |

Determinism violations take a dedicated branch: five executions, certified when
more than one distinct outcome appears. For that class, varying output *is* the
defect, so soundness and reproducibility are satisfied by the same observation.

This is an empirical procedure, and the honest word for its output is a
**reproducible witness**. There is no SMT solver, no symbolic execution and no
proof calculus in the proving path. The certificate's value is that it is
concrete and re-runnable, not that it is formal.

Each certificate carries the violated postcondition, the triggering input, the
observed output, and three verification timestamps.

---

## Repair

`src/agents/repair-agent.ts`. Patches are derived from the proof — the triggering
input is analysed and a guard is generated for that specific failure mode, then
rendered through a language dialect so the emitted source is valid in the target
language (`src/agents/repair-dialects.ts`: Python guards, not TypeScript braces).

Two dialects exist: TypeScript and Python. Anything else falls back to the
TypeScript dialect.

**Investigations never touch your source.** The repair agent works through an MCP
router whose `read_range` is a read-only file reader and whose `write_fix` is a
deliberate no-op (`api.ts#buildRepairRouter`). Patches come back as diffs for you
to apply.

At most 20 patches per investigation proceed to classification.

---

## Classification — 66 dimensions

`src/agents/classifier-agent.ts`. Every candidate patch is reduced to a
66-dimensional AST difference vector:

**11 properties** — `statement_count`, `branch_count`, `loop_count`,
`function_call_count`, `variable_declaration_count`, `assignment_count`,
`return_count`, `literal_count`, `operator_count`, `nesting_depth`,
`identifier_count`

**× 3 edit states** — added (`gen`), deleted (`del`), unchanged (`remain`)

**× 2** — raw and normalized

`11 × 3 × 2 = 66`

The vector yields an overfitting probability in `[0,1]`. Above the threshold
(default `0.5`) the patch is rejected and the top three contributing properties
are reported, so a rejection comes with a reason. A patch is rejected on this
basis even if it passes your existing tests — that is the point.

If the model times out (default 30s) or fails, the patch is marked
`inconclusive` with probability `-1` and stored for manual review rather than
being silently approved.

Classification is pure in-memory CST analysis.

---

## Learning across runs

Buggy keeps a record of its own history and acts on it. All four modules below
are wired and running.

### The Watchlist

One episode per investigation: the triggering input, every patch that was
rejected and *how* it failed, and the one that worked. Recording happens at the
single convergence point every outcome passes through, and is best-effort — a
recording failure can never change an investigation result.

Verified episodes become lessons, promoted through three tiers:

| Tier | Where it lives | Shared with |
|------|---------------|-------------|
| **local** | `.debugger/graph.db` | you, git-ignored |
| **team** | regenerated markdown in `.kiro/steering/` | the repo |
| **global** | cross-project steering | everything you work on |

Global promotion is deliberately conservative. Lessons are keyed by a signature
*shape*, and details are reduced to shapes before they cross a project boundary,
so no code and no literal values travel with them. Promotion requires
corroboration from a second project.

`buggy_recall` and the `buggy-recall-first` hook feed lessons back *before* code
is edited, so a known dead end is not retried.

### The Retrospective

`buggy retrospect` asks whether any of that actually helped. It reads each
lesson as a timeline and separates:

- fixes that **held**
- fixes that **regressed** — the defect was proven again after being repaired
- defects that are **unresolved** — no patch was ever accepted
- repeated **dead ends** — the same rejection reason, collapsed and named
- **hotspots** — defect density by file

It reports an improvement score, and returns `null` rather than a number when
there is not yet enough history to judge.

### The Advisor

`buggy suggest`. When a defect class keeps recurring, the useful response is
usually a guardrail rather than another patch. The advisor proposes Kiro hooks,
steering rules and skills derived from the project's own recorded evidence — a
regression guard scoped to files where fixes did not stick, a dead-ends steering
file, a language-specific defect guide, a triage skill for defects where every
patch was rejected.

Every proposal names the episodes that motivated it and arrives with finished
file content. **Nothing is written until you accept it** via
`buggy suggest --apply <id>`, which refuses to overwrite an existing file unless
forced.

---

## Interfaces

### CLI — 7 commands

| Command | Purpose |
|---------|---------|
| `buggy init` | Setup wizard — detects language, writes `.debugger.yaml` |
| `buggy analyze <file>` | Parse one file; report nodes and syntax errors |
| `buggy investigate <function> --file <path>` | Run the full four-phase pipeline |
| `buggy status <id>` | Phase, agent, elapsed time, intermediate results |
| `buggy halt <id>` | Halt a run, preserving intermediate results |
| `buggy retrospect` | Did past fixes hold? |
| `buggy suggest [--apply <id>]` | Propose guardrails from defect history |

**Flags** — `--json`, `--verbose`, `--file`/`-f`, `--help`/`-h`, `--yes`/`-y`,
`--force`, `--language`/`-l`, `--apply`.

`--json` emits a machine-readable document on stdout; all diagnostics go to
stderr specifically so that output stays parseable. Colour is suppressed when
`NO_COLOR` is set or `TERM=dumb`, and the spinner degrades to plain lines when
stdout is not a TTY.

One caveat: investigations are held in memory per process, so `buggy status` and
`buggy halt` in a *new* shell will not find an id from an earlier `buggy
investigate`. They are useful from the API and MCP server, where the instance
persists.

### MCP — 10 tools

Point any MCP-compatible client at `buggy-mcp`:

```json
{
  "mcpServers": {
    "buggy": { "command": "npx", "args": ["buggy-mcp"] }
  }
}
```

| Tool | Purpose |
|------|---------|
| `buggy_init` | Initialize a project, boot subsystems |
| `buggy_analyze` | Parse a file — nodes, syntax errors, functions |
| `buggy_investigate` | Full pipeline; returns certificate, patches, diffs |
| `buggy_status` | Status of a running or finished investigation |
| `buggy_query_graph` | Query the semantic graph (`callees`, `node`, `file_graph`) |
| `buggy_list_functions` | Functions in a file with lines and kinds |
| `buggy_recall` | Prior lessons for code you are about to edit |
| `buggy_retrospect` | Whether fixes held, regressed, or never landed |
| `buggy_suggest_capabilities` | Propose hooks, steering rules, skills |
| `buggy_apply_capability` | Write one accepted proposal to disk |

`halt` is not exposed over MCP; it is available on the CLI and the API.

### Programmatic API — 15 methods

```typescript
import { ProofDebugger } from 'buggy-debugger';

const dbg = new ProofDebugger({ projectRoot: '/path/to/project' });
await dbg.initialize();

const report = await dbg.investigate({
  functionId: 'splitExpense',
  filePath: 'src/expenses.ts',
  specification: {
    preconditions:  ['people >= 0'],
    postconditions: ['isFinite(result)', 'result >= 0'],
  },
});

console.log(report.status, report.proof, report.approved_patches);
await dbg.shutdown();
```

**Lifecycle** — `initialize`, `shutdown`, `getConfig`
**Analysis** — `parse`, `investigate`, `getStatus`, `halt`
**Memory** — `recall`, `watchlistStats`, `retrospect`, `suggestCapabilities`, `applyCapability`
**Graph** — `queryCallees`, `queryNode`, `queryFileGraph`

`ProofDebuggerOptions` accepts `projectRoot` (required), plus `language`,
`sandbox`, `probe`, `configPath` and `dbPath` overrides.

When no parameter list is supplied, the signature is recovered from source
first — otherwise the fuzzer has no arity to work with and reports a bogus
missing-argument failure instead of a real defect. An explicit specification
always wins.

### Kiro integration

7 hooks and 9 steering files. Commit `.kiro/` and every team member gets the
same behaviour with no per-developer setup.

| Hook | Trigger |
|------|---------|
| `buggy-on-save` | File saved |
| `buggy-post-write` | Kiro writes code |
| `buggy-pre-task` | Before a spec task runs |
| `buggy-auto-fix` | Agent finishes work (max 3 iterations) |
| `buggy-deep-scan` | User-triggered full scan |
| `buggy-spec-evolution` | After task completion |
| `buggy-recall-first` | A code-change request is submitted |

---

## Language support

| Language | Parse | Execute | Repair dialect |
|----------|-------|---------|----------------|
| TypeScript | ✅ tree-sitter-typescript | ✅ Node child process | ✅ |
| JavaScript | ✅ tree-sitter-typescript | ✅ Node child process | ✅ (TS dialect) |
| Python | ✅ tree-sitter-python | ✅ Python child process | ✅ |

Python resolves its grammar at runtime and falls back to the TypeScript grammar
if `tree-sitter-python` is missing. Both grammars are hard dependencies, so a
normal install is fine; a pruned install degrades quietly.

`detectLanguage` recognises other extensions by name, but nothing downstream
supports them. The three languages above are the real surface.

---

## Configuration

`.debugger.yaml`, validated with Zod. Eight top-level keys. `buggy init` writes
a working file, so editing this by hand is optional.

| Key | Constraint | Default |
|-----|-----------|---------|
| `language` | required | — (wizard detects) |
| `parser.command` | required | — |
| `parser.grammar_path` | optional | — |
| `lsp.command` | required | — |
| `lsp.initialization_options` | optional | `{}` |
| `sandbox.runtime` | required | — (wizard: `node` or `python`) |
| `sandbox.memory_limit_mb` | int 64–8192 | — (wizard: `512`) |
| `sandbox.timeout_seconds` | int 1–300 | — (wizard: `60`) |
| `sandbox.egress_policy` | `deny` \| `allow_host_only` | `deny` |
| `oracles.timeout_threshold_seconds` | int 1–300 | — (wizard: `10`) |
| `oracles.crash_detection` | boolean | — (wizard: `true`) |
| `oracles.overflow_detection` | boolean | — (wizard: `true`) |
| `oracles.determinism_check_count` | int 1–100 | — (wizard: `5`) |
| `probe.search_budget` | positive int | — (wizard: `30`/`100`/`300`) |
| `probe.max_refinement_iterations` | positive int | — (wizard: `3`/`10`/`20`) |
| `plugs.*` | all optional | `undefined` |
| `watchlist.enabled` | optional | `true` |
| `watchlist.scope` | `local` \| `team` \| `global` \| `layered` | `layered` |

Search presets: quick `30/3`, balanced `100/10`, thorough `300/20`.

`sandbox.memory_limit_mb` is validated and recorded but **not enforced** in the
live path — OS-level memory capping needs the Firecracker executor, which is not
wired. Treat it as documentation of intent.

A missing file, invalid YAML, or a failed constraint is fatal and raises
`ConfigError` naming the key and the offending value. An unrecognised key is a
warning, and loading continues.

---

## Operating characteristics

- **Local only.** No network calls in the proving path, no API key, no LLM, no
  cloud dependency. Your code does not leave the machine.
- **Non-destructive.** Investigations never write to your source. Patches are
  returned as diffs; `buggy suggest --apply` is the only command that writes, and
  only to `.kiro/`, and only when you name a proposal.
- **Works without tests.** Proving needs a function and optionally a
  specification. It does not need existing test coverage, which is what makes it
  usable on legacy code.
- **Storage** is a SQLite graph database in WAL mode at `.debugger/graph.db`,
  holding CST nodes, edges, symbol resolutions, proofs, patches and watchlist
  episodes.

---

## What runs today

The repository contains more than the live pipeline calls. Rather than let the
architecture diagram imply otherwise, here is the split. This section is the
project's credibility — an inaccurate claim here is worse than no claim.

### Wired and running

- Tree-sitter parsing with error recovery, incremental re-parse, LSP resolution
- Execution-based fuzzing with edge-case-first input generation
- Five oracles: timeout, crash, NaN/Infinity, postcondition, determinism
- Three-pillar certification: admissibility, soundness, reproducibility
- Trigger-derived repair with TypeScript and Python dialects
- 66-dimensional overfitting classification
- Watchlist recording and recall across all three tiers
- Retrospective analysis and the capability advisor
- CLI, MCP server and programmatic API

### Present, not yet in the pipeline

- **Firecracker microVM isolation** — `SandboxAgent` is a complete
  implementation that drives the Firecracker REST API over a Unix socket, and it
  needs a Linux host with KVM. The orchestrator receives a stub whose
  `isAvailable()` returns `false`, so today the execution boundary is an OS child
  process.
- Compile and test filtering of patches before classification
- PROBE adversarial property refinement
- SpecTune alpha-consistency refinement
- TrajSpec commit-history interpretation
- SAFuzz region-biased mutation
- Backward slicing for defect localisation
- Differential test generation — instantiated, but unreachable from `investigate()`
- OAP passports, circuit breaker, snapshot pool
- The standalone `ProofVerifier` and `OracleMonitor`, which differ from the live
  implementations: `ProofVerifier`'s third pillar is *feasibility*, not
  reproducibility
- Call-graph population — `buildCallGraph` returns empty, so graph queries
  return empty on a fresh project
- The four plug-in extension points. The `plugs:` config key is parsed and
  validated, then ignored; the registry is implemented and tested but never
  reached.

---

## Further reading

- [README](../README.md) — install, quick start, full CLI and config reference
- [Getting started](GETTING-STARTED.md)
- [Usage guide](USAGE-GUIDE.md)
- [Technical notes](TECHNICAL.md)
- [Marketing overview](MARKETING.md) — positioning, including an explicit roadmap section
