# Buggy

## *The first debugger that proves bugs exist before fixing them.*

---

## The Problem

Every developer knows the pain:

- **False positives everywhere.** Static analysis tools flag hundreds of "issues" — most aren't real bugs. Engineers waste hours triaging noise.
- **Patches that pass tests but don't generalize.** A fix works on the test suite, ships to production, and breaks on edge cases nobody wrote tests for. The patch was overfit.
- **No proof the bug exists.** When your tool says "potential null dereference on line 47," there's no mathematical guarantee that execution can actually reach that state. You're debugging a maybe.
- **Manual debugging is a time sink.** Senior engineers spend 30–50% of their time reading code, tracing control flow, and reasoning about state. The tooling hasn't caught up to the complexity of modern systems.
- **AI-generated patches are untrustworthy.** LLM-based repair tools generate plausible-looking code that passes superficial checks. Nobody verifies that the fix is correct in the general case.

The result: slow cycles, escaped bugs, and burned-out engineers.

---

## The Solution

The Buggy takes a fundamentally different approach. It doesn't guess. It proves.

1. **Mathematically proves a bug exists** before attempting any repair — using proof-of-failure certificates with formal admissibility, soundness, and uniqueness guarantees.
2. **Generates candidate patches** using specification-guided repair, not pattern matching.
3. **Rejects overfit patches** using a 66-dimensional feature vector classifier that detects when a patch only works on known inputs.
4. **Runs everything in hardware-isolated sandboxes** so untrusted code never touches your system.
5. **Plugs into any AI IDE** via a single MCP server — no custom integrations needed.

---

## It Actually Works — Proven Results

This isn't a roadmap. The proving engine runs today and finds real bugs autonomously.

### Live Test Results: 4/4 Bugs Found and Certified

| Function | Input | Output | Violation | Attempts |
|----------|-------|--------|-----------|----------|
| `splitExpense(0, 0)` | `(0, 0)` | `NaN` | Result must be a finite number | 1 |
| `budgetUsage(0, 0)` | `(0, 0)` | `NaN` | Result must be a finite number | 1 |
| `growthRate(0, 0)` | `(0, 0)` | `NaN` | Result must be a finite number | 1 |
| `dailyRate(0, 0)` | `(0, 0)` | `NaN` | Result must be a finite number | 1 |

**4 out of 4 bugs found and certified with ZERO human guidance.** Every proof passed all three verification steps (admissibility, soundness, uniqueness).

### How It Works

The proving engine follows a simple but effective pipeline:

1. **Generate edge-case inputs** — prioritizes 0, NaN, Infinity, -Infinity, empty arrays, and boundary values before random fuzzing
2. **Execute in a real subprocess** — each input runs the actual function in an isolated Node.js child process (not simulation, not static analysis)
3. **Check postconditions** — four oracle checks run on every execution: NaN detection, Infinity detection, crash detection, and timeout detection
4. **Verify the proof** — admissibility (input is valid), soundness (output actually violates the spec), uniqueness (reproduces deterministically)

### Why It Finds Bugs on Attempt #1

Traditional fuzzers explore random inputs hoping to stumble on a failure. Buggy's fuzzer starts with the inputs most likely to trigger division-by-zero, overflow, and boundary errors:

- `0`, `-0`, `NaN`, `Infinity`, `-Infinity`
- `Number.MAX_SAFE_INTEGER`, `Number.MIN_SAFE_INTEGER`
- Empty arrays `[]`, single-element arrays
- Empty strings, null, undefined

This means common numerical bugs are caught immediately — no hours of fuzzing required.

### No Cloud, No LLM, No API Key

The proving engine runs entirely locally. No network calls, no API keys, no cloud dependencies. Each function is proved in under 1 second on commodity hardware.

### Real Example: splitExpense

```
Function:    splitExpense(amount: number, people: number)
Input:       (0, 0)
Output:      NaN
Violation:   Output is NaN — not a finite number
Proved in:   1 attempt (< 100ms)

Proof Certificate:
  ✓ Admissible — inputs (0, 0) satisfy preconditions (both are valid numbers)
  ✓ Sound — NaN genuinely violates "result must be finite"
  ✓ Unique — reproduced 3/3 times deterministically
```

---

## Key Differentiators

### Proof-of-Failure Certificates

Not just "test failed" — a mathematical certificate proving the bug exists. Each certificate satisfies three properties:

- **Admissibility**: The preconditions are satisfiable (the bug-triggering state is reachable)
- **Soundness**: The postcondition violation follows logically from the preconditions
- **Uniqueness**: The certificate identifies one specific failure mode, not a class of potential issues

### Overfitting Blocker

Every candidate patch passes through a classifier that computes a 66-dimensional AST difference vector. Patches that score high on overfitting probability are rejected — even if they pass all existing tests. This catches the "works on the test suite, fails in production" problem at the source.

### Multi-Agent Architecture

Five specialized agents, not a monolithic tool:

| Agent | Role |
|-------|------|
| **Parser Agent** | Tree-sitter CST parsing, LSP symbol resolution, call graph construction |
| **Bug Proving Agent** | Backward slicing, spec refinement, SA-Fuzz, proof certificate generation |
| **Repair Agent** | Specification-guided patch generation with defect context |
| **Classifier Agent** | 66-dimensional overfitting detection, patch approval/rejection |
| **Sandbox Agent** | Hardware-isolated execution, oracle checking, OAP passport enforcement |

Each agent does one thing well. The orchestrator coordinates the pipeline.

### Hardware-Isolated Sandbox

Patches run inside Firecracker microVMs — the same technology behind AWS Lambda. Not Docker containers with shared kernels. Full hardware isolation with:

- Memory limits (configurable, 64MB–8GB)
- Network egress denied by default
- OAP (Origin-Aware Policy) passports for every execution
- Circuit breakers that terminate runaway processes

### Zero-Configuration IDE Integration

In Kiro, Buggy works automatically with zero setup beyond committing the `.kiro/` folder. Six hooks fire on IDE events — file saves, AI-generated code, spec tasks — running proof-carrying analysis without any manual commands. Developers get bug detection as a background service:

- **On save**: Every file save triggers automatic analysis
- **Post-write**: AI-generated code is verified before developers review it
- **Self-healing**: A feedback loop re-checks and fixes code up to 3 iterations
- **Spec evolution**: New implementations are verified against their specifications

The entire team gets automatic bug detection by committing one folder to the repo. No per-developer setup, no CI configuration, no commands to remember.

### Plug-and-Play MCP Integration

One command adds the debugger to any MCP-compatible IDE:

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

Works with Cursor, Windsurf, VS Code + Copilot, Claude Desktop, and any tool that speaks MCP.

---

## Target Users

### Senior Engineers at Production-Critical Companies

You maintain payment systems, trading platforms, or infrastructure that can't go down. You need guarantees, not suggestions. Buggy gives you mathematical certainty that a bug exists and that a fix generalizes beyond the test suite.

### Platform Teams Building Internal Developer Tools

You're building the next generation of developer experience for your org. Embed the debugger as a service — the programmatic API and MCP server integrate into CI pipelines, internal dashboards, and custom toolchains.

### Security Teams Needing Formal Verification

Security patches are high-stakes. A fix that doesn't generalize means a vulnerability that reopens. The overfitting blocker ensures patches hold under adversarial inputs, not just the ones in your regression suite.

### AI Coding Tool Builders

You're building the next Copilot, Cursor, or Devin. Embed proof-carrying debugging via MCP to give your AI assistant the ability to not just generate code, but prove its fixes are correct.

---

## Use Cases

### CI/CD Pipeline Integration

Prove bugs exist before merging fixes. Add the debugger to your PR workflow:

1. Developer submits a fix
2. Debugger re-proves the original bug
3. Debugger classifies the patch for overfitting
4. PR gets a proof certificate badge — or a rejection with explanation

### Security Patch Validation

When a CVE lands, you need to move fast and ship a fix. But fast fixes that don't generalize reopen vulnerabilities. Buggy validates that your security patch holds under the full specification — not just the PoC exploit.

### Legacy Code Modernization

You're migrating a 10-year-old codebase. Bugs are hiding in code nobody understands anymore. The debugger's backward slicing and proof generation work on code without existing test coverage — it doesn't need tests to prove a bug exists.

### AI Coding Assistant Augmentation

Give Copilot, Cursor, or your custom AI agent proof-backed repairs:

1. AI assistant detects a potential issue
2. Calls `buggy_investigate` via MCP
3. Gets back a proof certificate and approved patches
4. Presents mathematically-verified fixes to the developer

### Team-Wide Automatic Bug Detection

Deploy Buggy across your entire team with a single commit. With Kiro integration:

1. Commit the `.kiro/` folder containing hooks and steering files
2. Every developer who opens the project in Kiro gets automatic bug detection
3. Bugs are caught on every file save, every AI edit, and every spec task — no commands needed
4. The self-healing loop (`buggy-auto-fix`) re-checks code up to 3 times after each agent action
5. Bug trends are tracked automatically, and new team members are warned about historically risky files

Zero configuration per developer. Zero commands to remember. The entire team gets proof-carrying debugging as a background service.

---

## How It Works

### Core Pipeline

```
┌─────────────┐     ┌──────────────┐     ┌──────────────┐     ┌──────────────────┐
│  1. PARSE   │────▶│  2. PROVE    │────▶│  3. REPAIR   │────▶│  4. CLASSIFY     │
│             │     │              │     │              │     │                  │
│ Tree-sitter │     │ Backward     │     │ Spec-guided  │     │ 66-dim feature   │
│ CST + LSP   │     │ slicing +    │     │ patch        │     │ vector analysis  │
│ resolution  │     │ SA-Fuzz +    │     │ generation   │     │                  │
│             │     │ proof cert   │     │              │     │ Approve/Reject   │
└─────────────┘     └──────────────┘     └──────────────┘     └──────────────────┘
                           │                     │                       │
                           ▼                     ▼                       ▼
                    ┌──────────────────────────────────────────────────────────┐
                    │              SANDBOX AGENT (Firecracker microVM)          │
                    │   Available on-demand to all agents throughout pipeline   │
                    └──────────────────────────────────────────────────────────┘
```

### Kiro Integration Flow

Inside Kiro, the entire pipeline is triggered automatically via hooks — no manual commands:

```
┌──────────────┐     ┌──────────────┐     ┌──────────────────┐     ┌────────────────┐
│  FILE EDIT   │────▶│  KIRO HOOK   │────▶│  AGENT PROMPT    │────▶│  MCP TOOL CALL │
│              │     │              │     │                  │     │                │
│ Developer    │     │ buggy-on-save│     │ Kiro's LLM      │     │ buggy_analyze  │
│ saves file   │     │ fires        │     │ interprets hook  │     │ buggy_investigate│
│              │     │              │     │ instructions     │     │                │
└──────────────┘     └──────────────┘     └──────────────────┘     └───────┬────────┘
                                                                           │
                     ┌──────────────┐     ┌──────────────────┐            │
                     │  APPLY FIX   │◀────│  RESULTS         │◀───────────┘
                     │              │     │                  │
                     │ Agent applies│     │ Proof certificate│
                     │ approved     │     │ + approved       │
                     │ patches      │     │ patches returned │
                     └──────────────┘     └──────────────────┘
```

**The self-healing loop** (`buggy-auto-fix`): After the agent applies a fix, the hook re-triggers analysis on the modified file. If new issues are found, it fixes them again — up to 3 iterations. This catches cascading bugs introduced by patches.

**Step 1: Parse** — Tree-sitter produces a fault-tolerant CST. LSP resolves symbols. Call graph is built.

**Step 2: Prove** — The proving engine uses REAL CODE EXECUTION, not just static analysis. It generates edge-case inputs (0, NaN, Infinity, empty arrays), executes the function in an isolated subprocess, and checks postconditions against actual outputs. Backward slicing narrows the search space. A proof-of-failure certificate is generated with formal guarantees (admissibility + soundness + uniqueness).

**Step 3: Repair** — Using the proof certificate as a guide, the repair agent generates candidate patches that address the proven failure mode.

**Step 4: Classify** — Each patch is analyzed against a 66-dimensional AST difference vector. Patches that show signs of overfitting are rejected. Only generalizing fixes are approved.

---

## Pricing

### Free (Open Source Core)

- CLI tool + MCP server
- **Kiro integration (all 6 hooks + 8 steering files) — included**
- Single-agent mode (Parser + basic analysis)
- 100 investigations per month
- Community support
- Apache 2.0 license

### Pro — $49/seat/month

- Full 5-agent pipeline
- Firecracker sandbox isolation
- Unlimited investigations
- Priority support
- Overfitting detection with full 66-dim classifier
- CI/CD webhook integration

### Enterprise — Custom

- Self-hosted deployment
- Custom plug development
- Audit trail and compliance reports (SOC2, HIPAA)
- Dedicated support engineer
- SLA guarantees
- SSO / SAML integration
- Air-gapped deployment option

---

## Competitive Landscape

| Tool | What it does | What's missing |
|------|-------------|----------------|
| **SonarQube** | Static analysis rules | No proof bugs exist. High false-positive rate. No repair. |
| **Snyk** | Dependency vulnerability scanning | Doesn't analyze your code logic. No patch generation. |
| **GitHub Copilot** | AI code generation | Generates patches with no guarantee of correctness. No overfitting detection. |
| **Cursor** | AI-assisted editing | Great UX, but no formal verification. Patches are "probably right." |
| **Amazon CodeGuru** | ML-based code review | Pattern matching, not proof. Suggestions, not verified fixes. |
| **Infer (Meta)** | Separation logic analysis | Strong formal foundations but no repair pipeline. Research-grade UX. |
| **Buggy** | **Prove → Repair → Verify** | **Full pipeline: mathematical proof, spec-guided repair, overfitting rejection, hardware isolation.** |

---

## Get Started

### Quick Start (CLI)

```bash
npm install -g buggy
buggy init
buggy investigate --function processPayment --file src/payments.ts
```

### MCP Integration (Any AI IDE)

Add to your MCP configuration:

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
import { ProofDebugger } from 'buggy';

const debugger = new ProofDebugger({ projectRoot: '/path/to/project' });
await debugger.initialize();

const report = await debugger.investigate({
  functionId: 'processPayment',
  filePath: 'src/payments.ts',
  specification: {
    preconditions: ['amount > 0', 'account.balance >= amount'],
    postconditions: ['account.balance == old(balance) - amount'],
  },
});

if (report.status === 'confirmed_and_repaired') {
  console.log(`Bug proven. ${report.approved_patches.length} verified fixes available.`);
}

await debugger.shutdown();
```

---

## Contact

- **GitHub**: [buggy](https://github.com/buggy)
- **Documentation**: [docs.buggy.dev](https://docs.buggy.dev)
- **Enterprise inquiries**: enterprise@buggy.dev
