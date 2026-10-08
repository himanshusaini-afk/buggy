# Buggy

## *A debugger that demonstrates the bug before it offers you a fix.*

> **About this document.** This is the positioning and messaging doc. Everything
> in the sections above "Roadmap" describes behaviour that exists today and was
> verified against the source. Anything not yet built lives under
> [Roadmap](#roadmap) and is labelled as such.
>
> For the precise feature inventory — including a module-by-module list of what
> is wired into the live pipeline and what is library code only — see
> [FEATURES.md](FEATURES.md).

---

## The Problem

Every developer knows the pain:

- **False positives everywhere.** Static analysis flags hundreds of "issues" and
  most are not real. Engineers burn hours triaging noise.
- **Patches that pass tests but do not generalize.** A fix works on the suite,
  ships, and breaks on an edge case nobody wrote a test for. The patch was overfit.
- **No evidence the bug is reachable.** When a tool says "potential null
  dereference on line 47," nothing has established that execution can actually
  reach that state. You are debugging a maybe.
- **Manual debugging is a time sink.** Senior engineers spend a large share of
  their time reading code and reasoning about state by hand.
- **AI-generated patches are unverified.** LLM repair tools produce
  plausible-looking code that passes a glance. Nothing checks whether the fix is
  right in the general case.

The result: slow cycles, escaped bugs, and tired engineers.

---

## The Solution

Buggy does not guess, and it does not report a defect it cannot demonstrate.

1. **Produces a concrete failing input** before attempting any repair, then
   re-runs it and re-checks it. The output is a proof-of-failure certificate: a
   reproducible witness, not a warning.
2. **Derives candidate patches from that certificate** — the guard addresses the
   specific failure mode the witness exposed, rendered in the target language.
3. **Rejects overfit patches** using a 66-dimensional AST difference vector, even
   when they pass every existing test.
4. **Records what happened** so the next investigation starts from what already
   worked and avoids what already failed.
5. **Plugs into any AI IDE** through a single MCP server — 10 tools, no custom
   integration.

Local only. No network calls in the proving path, no API key, no LLM, no cloud.
Your code does not leave the machine.

---

## It Actually Works

The proving engine runs today and finds real bugs without being told where to look.

### Demo: four functions, four certificates

From `examples/` — four division-style defects across TypeScript and Python:

| Function | Input | Output | Violation | Attempts |
|----------|-------|--------|-----------|----------|
| `splitExpense(0, 0)` | `(0, 0)` | `NaN` | Result must be a finite number | 1 |
| `budgetUsage(0, 0)` | `(0, 0)` | `NaN` | Result must be a finite number | 1 |
| `growthRate(0, 0)` | `(0, 0)` | `NaN` | Result must be a finite number | 1 |
| `dailyRate(0, 0)` | `(0, 0)` | `NaN` | Result must be a finite number | 1 |

Every certificate passed all three verification steps. No specification was
written for any of them — the NaN/Infinity oracle fires without one.

To be straight about what this is: these are demo fixtures of the same defect
shape, chosen to show the mechanism end to end. It is a demonstration, not a
benchmark. Defects beyond the spec-free oracles (NaN, Infinity, crash, timeout,
determinism) need postconditions to be caught.

### Why it lands on attempt #1

Traditional fuzzers explore randomly and hope. Buggy's fuzzer starts with the
values that actually break arithmetic:

- `0`, `-0`, `NaN`, `Infinity`, `-Infinity`
- `Number.MAX_SAFE_INTEGER`, `Number.MIN_SAFE_INTEGER`
- Empty arrays, single-element arrays
- Empty strings, `null`, `undefined`

Common numerical defects surface immediately, with no fuzzing campaign required.

### How it works

1. **Generate edge-case inputs** — boundary values first, then random.
2. **Execute for real** — each input runs the actual function in a child
   process. Not simulation, not static reasoning.
3. **Check five oracles** — timeout, crash, NaN/Infinity, postcondition,
   determinism. Timeout and crash short-circuit, since there is no output to check.
4. **Certify** — admissibility (preconditions hold for this input), soundness
   (re-execution confirms the violation), reproducibility (at least 2 of 3
   further runs reproduce it).

### Real example

```
Function:    splitExpense(amount: number, people: number)
Input:       (0, 0)
Output:      NaN
Violation:   Output is NaN — not a finite number

Proof Certificate:
  ✓ Admissible    — inputs (0, 0) satisfy the stated preconditions
  ✓ Sound         — re-execution confirms NaN violates "result must be finite"
  ✓ Reproducible  — reproduced on repeated execution, not a one-off flake
```

---

## Key Differentiators

### Proof-of-failure certificates

Not "a test failed" — a certificate carrying the triggering input, the observed
output, the violated postcondition, and three verification timestamps. Three
properties must hold before anything is reported:

- **Admissibility** — the triggering input genuinely satisfies the preconditions,
  so the state is reachable rather than hypothetical
- **Soundness** — re-execution confirms the violation is real
- **Reproducibility** — it reproduces across repeated executions

**On the word "proof."** The mechanism is execution-based: fuzzing plus
re-execution. There is no SMT solver, no symbolic execution and no proof
calculus. The certificate is empirical, and its value is that it is concrete and
re-runnable — you get the input, not an argument. Calling that *mathematical*
certainty would be overselling it.

### The overfitting blocker

Every candidate patch is reduced to a 66-dimensional AST difference vector —
11 structural properties × 3 edit states (added, deleted, unchanged) × 2 (raw and
normalized). Patches scoring above the overfitting threshold are rejected, and
the rejection names the top three contributing properties.

A patch is rejected on this basis **even if it passes all existing tests.** That
is precisely the "green suite, broken production" failure mode, caught at the source.

### It learns across runs

Most tools start every analysis from zero. Buggy keeps a record of its own
history and acts on it.

- **The Watchlist** records one episode per investigation: the triggering input,
  every patch rejected and *how* it failed, and the one that worked. Verified
  episodes become lessons promoted through three tiers — private, committed to
  the repo, then reused across all your projects once a second project
  corroborates them. Cross-project lessons are reduced to shapes first, so no
  code and no literal values travel with them.
- **The Retrospective** asks whether it helped: which fixes held, which
  **regressed** (proven again after being repaired), which defects never got an
  accepted patch, and which approaches are repeated dead ends.
- **The Advisor** proposes guardrails from that evidence — hooks, steering rules
  and skills scoped to the files where fixes did not stick. Every proposal names
  the episodes that motivated it, and nothing is written until you accept it.

### It never edits your code behind your back

Investigations are read-only. The repair agent runs through a router whose
`write_fix` is a deliberate no-op, so patches come back as diffs you choose to
apply. The one command that writes anything is `buggy suggest --apply`, and only
into `.kiro/`, and only for a proposal you named.

### It works without tests

Proving needs a function and optionally a specification. It does not need
existing coverage — which is what makes it usable on code nobody has touched in
five years.

### Multi-agent architecture

| Agent | Role |
|-------|------|
| **Parser Agent** | Tree-sitter CST parsing with error recovery, LSP symbol resolution |
| **Bug Proving Agent** | Edge-case-first fuzzing, five oracles, three-pillar certification |
| **Repair Agent** | Trigger-derived patch generation with TypeScript and Python dialects |
| **Classifier Agent** | 66-dimensional overfitting detection, patch approval/rejection |
| **Sandbox Agent** | Firecracker microVM execution — built, not yet wired (see [Roadmap](#roadmap)) |

An orchestrator runs four phases in order: Parse → Prove → Repair → Classify.
Phase 2 is a gate; if nothing is certified, no repair is attempted.

### Execution isolation — stated plainly

Untrusted code runs in an **OS child process** with a timeout. That is the
boundary today.

A full Firecracker microVM executor is implemented in the repo, but it is not
wired into the pipeline and requires a Linux host with KVM. Until it is,
`sandbox.memory_limit_mb` is recorded rather than enforced, and you should treat
the isolation as process-level. If you are investigating genuinely hostile code,
run Buggy in a VM or container you control.

### Zero-configuration IDE integration

In Kiro, Buggy works with no setup beyond committing the `.kiro/` folder. **7
hooks** fire on IDE events — file saves, AI-generated code, spec tasks — so
analysis runs without manual commands:

- **On save** — the saved file is analysed immediately
- **Post-write** — AI-generated code is checked before you review it
- **Recall-first** — before editing, prior lessons for that code are consulted
- **Self-healing** — a feedback loop re-checks and fixes, up to 3 iterations
- **Spec evolution** — new implementations are verified against their specs

Plus **9 steering files** for PR review, git-diff analysis, spec inference and
type-narrowing workflows. One commit, and the whole team has it.

### Plug-and-play MCP integration

```json
{
  "mcpServers": {
    "buggy": {
      "command": "npx",
      "args": ["buggy-mcp"]
    }
  }
}
```

Works with Kiro, Cursor, Windsurf, VS Code + Copilot, Claude Desktop, and
anything else that speaks MCP.

---

## Target Users

### Senior engineers on production-critical systems

You maintain payments, trading, or infrastructure that cannot go down. You want
the failing input in your hand, not a ranked list of maybes — and you want to
know whether the fix generalizes past the case that caught it.

### Platform teams building internal developer tools

Embed it as a service. The programmatic API and the MCP server drop into
internal dashboards and custom toolchains.

### Teams modernizing legacy code

Bugs hide in code nobody understands anymore. Proving works without existing
test coverage, so you can point it at the scary module on day one.

### AI coding tool builders

Give your agent the ability to check its own work: call `buggy_investigate` over
MCP and get back a reproducible witness plus patches that survived an
overfitting screen.

---

## Use Cases

### Investigating a risky function

Point it at the function you least want to be wrong. If an input breaks it, you
get that input, the output it produced, and the postcondition it violated.

### Validating a security patch

A fix that does not generalize reopens the vulnerability. The overfitting
classifier screens patches on structural grounds rather than on whether they
satisfy the PoC exploit.

### Augmenting an AI coding assistant

1. The assistant is asked to change some code
2. `buggy_recall` surfaces what worked and what failed on that code before
3. `buggy_investigate` returns a certificate and screened patches
4. The developer sees a fix backed by a reproducible failing input

### Team-wide automatic detection

1. Commit `.kiro/`
2. Everyone who opens the project in Kiro gets analysis on save, on AI edit, and
   on spec task
3. `buggy retrospect` reports whether fixes are actually holding
4. `buggy suggest` turns recurring defects into guardrails

No per-developer setup, no commands to memorize.

---

## How It Works

```
┌─────────────┐     ┌──────────────┐     ┌──────────────┐     ┌──────────────────┐
│  1. PARSE   │────▶│  2. PROVE    │────▶│  3. REPAIR   │────▶│  4. CLASSIFY     │
│             │     │              │     │              │     │                  │
│ Tree-sitter │     │ Edge-case    │     │ Trigger-     │     │ 66-dim feature   │
│ CST + LSP   │     │ fuzzing +    │     │ derived      │     │ vector analysis  │
│ resolution  │     │ 5 oracles +  │     │ guards, TS   │     │                  │
│             │     │ 3-pillar     │     │ and Python   │     │ Approve/Reject   │
│             │     │ certification│     │ dialects     │     │                  │
└─────────────┘     └──────┬───────┘     └──────────────┘     └────────┬─────────┘
                           │                                           │
                      no certificate ──▶ unconfirmed, stop             │
                                                                       ▼
                    ┌──────────────────────────────────────────────────────────┐
                    │  WATCHLIST — every outcome recorded as an episode and    │
                    │  promoted to a lesson, recalled before the next edit     │
                    └──────────────────────────────────────────────────────────┘
```

**Step 1: Parse** — Tree-sitter produces a fault-tolerant CST. LSP resolves symbols.

**Step 2: Prove** — Real execution, not static reasoning. Edge-case inputs run
the function in a child process; five oracles check the result; survivors are
certified against admissibility, soundness and reproducibility. **No certificate
means no repair** — the run ends as `unconfirmed` rather than guessing.

**Step 3: Repair** — The triggering input is analysed and a guard is generated
for that failure mode, rendered through the dialect for the target language.

**Step 4: Classify** — Each patch is scored on a 66-dimensional AST difference
vector. Overfit patches are rejected with their top contributing factors named.

Then every outcome — proven, unconfirmed or halted — is recorded to the
Watchlist, so the next run starts better informed than this one did.

---

## Competitive Landscape

| Tool | What it does | What's missing |
|------|-------------|----------------|
| **SonarQube** | Static analysis rules | No evidence the bug is reachable. High false-positive rate. No repair. |
| **Snyk** | Dependency vulnerability scanning | Does not analyze your code logic. No patch generation. |
| **GitHub Copilot** | AI code generation | Patches come with no correctness check. No overfitting detection. |
| **Cursor** | AI-assisted editing | Great UX, but patches are "probably right." |
| **Amazon CodeGuru** | ML-based code review | Pattern matching. Suggestions, not demonstrated defects. |
| **Infer (Meta)** | Separation logic analysis | Genuine formal foundations — stronger than Buggy here — but no repair pipeline, research-grade UX. |
| **Buggy** | **Demonstrate → Repair → Screen** | **Reproducible failing input, trigger-derived repair, overfitting rejection, and memory across runs.** |

Where Buggy is weaker: Infer and similar tools reason formally and can cover
paths no fuzzer will reach. Buggy's claim is not that it proves more — it is
that what it reports comes with a concrete input you can re-run, and that it
screens its own fixes.

---

## Get Started

### CLI

```bash
# NOTE: the package is `buggy-debugger`. Plain `buggy` on npm is an
# unrelated issue tracker.
npm install -g buggy-debugger

cd /path/to/your/project
buggy init

buggy analyze src/payments.ts
buggy investigate processPayment --file src/payments.ts
```

### MCP (any AI IDE)

```json
{
  "mcpServers": {
    "buggy": {
      "command": "npx",
      "args": ["buggy-mcp"]
    }
  }
}
```

### Programmatic API

```typescript
import { ProofDebugger } from 'buggy-debugger';

const dbg = new ProofDebugger({ projectRoot: '/path/to/project' });
await dbg.initialize();

// What do we already know about this code?
const prior = dbg.recall({ functionId: 'processPayment', filePath: 'src/payments.ts' });

const report = await dbg.investigate({
  functionId: 'processPayment',
  filePath: 'src/payments.ts',
  specification: {
    preconditions: ['amount > 0'],
    postconditions: ['isFinite(result)', 'result >= 0'],
  },
});

if (report.status === 'confirmed_and_repaired') {
  console.log(`Defect demonstrated. ${report.approved_patches.length} screened fixes.`);
}

await dbg.shutdown();
```

---

## Roadmap

Everything below is **not built, or built but not wired into the live pipeline.**
It is listed here so the sections above can stay honest.

### Built, not yet wired

- **Firecracker microVM isolation** — a complete executor driving the Firecracker
  REST API exists; it needs a Linux host with KVM and is not connected to the
  orchestrator. Today's boundary is an OS child process, and memory limits are
  recorded rather than enforced.
- **Compile and test filtering** of patches before classification. Today an
  approved patch has passed the overfitting screen only — it has not been
  compiled or test-run for you.
- **PROBE** adversarial property refinement
- **SpecTune** alpha-consistency refinement
- **TrajSpec** commit-history interpretation
- **SAFuzz** region-biased mutation
- **Backward slicing** for defect localisation
- **Differential test generation**
- **OAP passports, circuit breaker, snapshot pool**
- **Call-graph population** — graph queries return empty on a fresh project
- **The four plug-in extension points** — the `plugs:` config key is parsed and
  validated, then ignored

### Not built

- CI/CD integration: PR workflow, proof-certificate badges, webhooks
- Languages beyond TypeScript, JavaScript and Python
- Hosted or team-server deployment
- Any form of licence gating, metering or paid tier

### Commercial model

Buggy is MIT licensed and entirely free. There is no paid tier, no usage
metering and no feature gating anywhere in the code. If a commercial offering
ever exists it will be announced here; until then, treat any pricing you see
attributed to this project as fiction.

---

## Links

- **Repository**: [github.com/himanshusaini-afk/buggy](https://github.com/himanshusaini-afk/buggy)
- **Site**: [himanshusaini-afk.github.io/buggy](https://himanshusaini-afk.github.io/buggy/)
- **Features — what actually ships**: [FEATURES.md](FEATURES.md)
- **Usage guide**: [USAGE-GUIDE.md](USAGE-GUIDE.md)
- **Technical notes**: [TECHNICAL.md](TECHNICAL.md)
- **Issues**: [github.com/himanshusaini-afk/buggy/issues](https://github.com/himanshusaini-afk/buggy/issues)
