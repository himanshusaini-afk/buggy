# Usage Guide

A complete guide to using Buggy — from installation through CI/CD integration.

---

## Table of Contents

1. [Getting Started (5 minutes)](#1-getting-started)
2. [Attaching to Your Project](#2-attaching-to-your-project)
3. [Using the CLI](#3-using-the-cli)
4. [Using as an MCP Server (AI IDE Integration)](#4-using-as-an-mcp-server)
4b. [Kiro-Powered Features](#4b-kiro-powered-features)
5. [Using the Programmatic API](#5-using-the-programmatic-api)
6. [Understanding the Report](#6-understanding-the-report)
7. [Writing Specifications](#7-writing-specifications)
8. [Configuration Reference](#8-configuration-reference)
9. [Troubleshooting](#9-troubleshooting)
10. [Integration Recipes](#10-integration-recipes)
11. [Extending with Custom Plugs](#11-extending-with-custom-plugs)

---

## 1. Getting Started

Get up and running in under 5 minutes.

### Prerequisites

- **Node.js >= 18.0.0** (LTS recommended)
- A Tree-sitter grammar for your target language (bundled for TypeScript/JavaScript)
- An LSP server for symbol resolution (optional but recommended)

### Installation

Install globally for CLI access:

```bash
npm install -g buggy
```

Or use without installing via `npx`:

```bash
npx buggy --help
```

Or add to your project as a dev dependency:

```bash
npm install --save-dev buggy
```

### First Run

Confirm installation by running:

```bash
buggy --help
```

You should see:

```
buggy — Proof-Carrying Program Repair and Debugging System

USAGE:
  buggy <command> [options]

COMMANDS:
  init                              Create a .debugger.yaml template in the current directory
  analyze <file>                    Parse a file and show the semantic graph
  investigate <function> --file <path>  Run full investigation pipeline on a function
  status <id>                       Show status of a running investigation
  halt <id>                         Halt a running investigation

OPTIONS:
  --json        Output results as JSON (machine-readable)
  --verbose     Enable detailed logging
  --file, -f    Specify the target file (for investigate command)
  --help, -h    Show this help message
```

---

## 2. Attaching to Your Project

The debugger attaches to any project via a `.debugger.yaml` configuration file and a `.debugger/` working directory. Each language needs a Tree-sitter parser and optionally an LSP server for deeper symbol resolution.

### Scenario A: TypeScript / JavaScript Project

**Step 1: Initialize**

```bash
cd /path/to/your/ts-project
buggy init
```

This creates:
- `.debugger.yaml` — configuration file (edit this to match your project)
- `.debugger/` — working directory containing the SQLite graph database

**Step 2: Review the generated config**

The default `.debugger.yaml` for a TypeScript project:

```yaml
version: "1.0"

language: typescript

parser:
  command: tree-sitter-typescript

lsp:
  command: typescript-language-server

sandbox:
  runtime: node
  memory_limit_mb: 512
  timeout_seconds: 60
  egress_policy: deny

oracles:
  timeout_threshold_seconds: 10
  crash_detection: true
  overflow_detection: true
  determinism_check_count: 5

probe:
  search_budget: 100
  max_refinement_iterations: 10
```

For JavaScript projects, change:

```yaml
language: javascript
parser:
  command: tree-sitter-javascript
```

**Step 3: Add to .gitignore**

```gitignore
# Buggy
.debugger/
```

The `.debugger.yaml` config file should be committed — it's part of your project setup. The `.debugger/` directory contains generated data (graph database, intermediate results) and should be ignored.

**Step 4: Run your first analysis**

```bash
buggy analyze src/index.ts
```

---

### Scenario B: Python Project

```bash
cd /path/to/your/python-project
buggy init
```

Edit `.debugger.yaml`:

```yaml
version: "1.0"

language: python

parser:
  command: tree-sitter-python

lsp:
  command: pyright
  # Alternative: pylsp

sandbox:
  runtime: python
  memory_limit_mb: 512
  timeout_seconds: 60
  egress_policy: deny

oracles:
  timeout_threshold_seconds: 10
  crash_detection: true
  overflow_detection: true
  determinism_check_count: 5

probe:
  search_budget: 100
  max_refinement_iterations: 10
```

**LSP choices:**
- `pyright` — faster, stricter type checking (recommended for typed Python)
- `pylsp` — broader plugin ecosystem, more lenient

Run analysis:

```bash
buggy analyze app/services/payment.py
```

---

### Scenario C: Rust Project

```bash
cd /path/to/your/rust-project
buggy init
```

Edit `.debugger.yaml`:

```yaml
version: "1.0"

language: rust

parser:
  command: tree-sitter-rust

lsp:
  command: rust-analyzer

sandbox:
  runtime: cargo
  memory_limit_mb: 1024
  timeout_seconds: 120
  egress_policy: deny

oracles:
  timeout_threshold_seconds: 30
  crash_detection: true
  overflow_detection: true
  determinism_check_count: 5

probe:
  search_budget: 100
  max_refinement_iterations: 10
```

Note the higher memory and timeout limits — Rust compilation is resource-intensive.

---

### Scenario D: Java Project

```bash
cd /path/to/your/java-project
buggy init
```

Edit `.debugger.yaml`:

```yaml
version: "1.0"

language: java

parser:
  command: tree-sitter-java

lsp:
  command: jdtls

sandbox:
  runtime: java
  memory_limit_mb: 1024
  timeout_seconds: 90
  egress_policy: deny

oracles:
  timeout_threshold_seconds: 15
  crash_detection: true
  overflow_detection: true
  determinism_check_count: 5

probe:
  search_budget: 100
  max_refinement_iterations: 10
```

---

### Scenario E: Go Project

```bash
cd /path/to/your/go-project
buggy init
```

Edit `.debugger.yaml`:

```yaml
version: "1.0"

language: go

parser:
  command: tree-sitter-go

lsp:
  command: gopls

sandbox:
  runtime: go
  memory_limit_mb: 512
  timeout_seconds: 60
  egress_policy: deny

oracles:
  timeout_threshold_seconds: 10
  crash_detection: true
  overflow_detection: true
  determinism_check_count: 5

probe:
  search_budget: 100
  max_refinement_iterations: 10
```

---

## 3. Using the CLI

### `buggy init`

Creates a fresh configuration in the current directory.

**What it does:**
- Writes a `.debugger.yaml` template pre-filled for TypeScript
- Creates the `.debugger/` working directory
- Does NOT overwrite an existing `.debugger.yaml`

**When to re-run:**
- After deleting `.debugger.yaml` to get a fresh template
- After upgrading the debugger (new config fields may be available)

**Example:**

```bash
$ buggy init
✓ Created .debugger.yaml
✓ Created .debugger/ directory

  Edit .debugger.yaml to configure the debugger for your project.
  Then run: buggy analyze <file>
```

With `--json`:

```bash
$ buggy init --json
{"created":[".debugger.yaml",".debugger/"]}
```

If the config already exists:

```bash
$ buggy init
⚠ .debugger.yaml already exists in this directory.
  Remove it first if you want to regenerate.
```

---

### `buggy analyze <file>`

Parses a source file using Tree-sitter and displays a summary of the concrete syntax tree (CST), function declarations, and any syntax errors.

**What it shows:**
- File path and parse duration
- Number of syntax errors (with locations)
- Root CST node type and total node count
- Function list (with `--verbose`)

**Example — clean file:**

```bash
$ buggy analyze src/cart.ts
✓ Debugger initialized
✓ Parsed src/cart.ts

  Parse Result
  ─────────────────────────────────────
  File:       /home/user/project/src/cart.ts
  Duration:   12.34ms
  Errors:     0
  Root type:  program
  Node count: 847
```

**Example — file with errors:**

```bash
$ buggy analyze src/broken.ts
✓ Debugger initialized
✓ Parsed src/broken.ts

  Parse Result
  ─────────────────────────────────────
  File:       /home/user/project/src/broken.ts
  Duration:   8.91ms
  Errors:     2
  Root type:  program
  Node count: 312

  Syntax Errors:
    • Unexpected token '}' (15:2)
    • Missing semicolon (23:41)
```

**Using `--verbose` for deeper CST info:**

```bash
$ buggy analyze src/cart.ts --verbose
✓ Debugger initialized
✓ Parsed src/cart.ts

  Parse Result
  ─────────────────────────────────────
  File:       /home/user/project/src/cart.ts
  Duration:   12.34ms
  Errors:     0
  Root type:  program
  Node count: 847

  CST Summary (depth 2):
    import_statement (0:0)
      import_clause (0:7)
      string (0:27)
    export_keyword (2:0)
    interface_declaration (2:7)
      type_identifier (2:17)
      object_type (2:27)
    function_declaration (8:0)
      identifier (8:9)
      formal_parameters (8:22)
      statement_block (8:45)
```

**Using `--json` for machine-readable output:**

```bash
$ buggy analyze src/cart.ts --json
{
  "file_path": "/home/user/project/src/cart.ts",
  "duration_ms": 12.34,
  "cst": { ... },
  "errors": []
}
```

---

### `buggy investigate <function> --file <path>`

Runs the full investigation pipeline on a single function:

1. **Parse** — Build the CST and resolve symbols via LSP
2. **Prove** — Use the PROBE loop + specification-aware fuzzing to find a bug and construct a proof-of-failure certificate
3. **Repair** — Generate AST-aware patches and filter through compile → emulate → test stages
4. **Classify** — Score each patch for overfitting using PRISM-APCC analysis

**Example — confirmed bug with repair:**

```bash
$ buggy investigate calculateDiscount --file src/cart.ts
✓ Debugger initialized
✓ Investigation complete

  Investigation Report
  ─────────────────────────────────────
  ID:     inv_1718234567890_a7f3c21
  Status: confirmed_and_repaired

  Proof-of-Failure Certificate:
    Violated:    result >= 0
    Input:       {"price": 100, "discountPercent": 150}
    Output:      -50
    Admissible:  2024-06-12T14:22:47.123Z
    Sound:       2024-06-12T14:22:47.456Z
    Unique:      2024-06-12T14:22:47.789Z

  Approved Patches (1):
    ✓ patch_a7f3c21_001 — overfitting: 12.3%

  Timeline:
    parsing         ParserAgent     (14:22:45.100 → 14:22:45.312)
    proving         BugProvingAgent (14:22:45.312 → 14:22:47.789)
    repair          RepairAgent     (14:22:47.789 → 14:22:49.100)
    classification  ClassifierAgent (14:22:49.100 → 14:22:49.890)
```

**Understanding the proof:**

The proof-of-failure certificate has three verification stamps:

| Field | Meaning |
|-------|---------|
| `Admissible` | The test input satisfies all preconditions — it's a valid input, not a garbage value |
| `Sound` | The observed output genuinely violates the postcondition — the bug is real |
| `Unique` | The violation is deterministically reproducible — it's not a flaky timing issue |

**Understanding approved vs rejected patches:**

- **Approved patches** passed all filtering stages (compilation, emulation, test suite) AND scored below the overfitting threshold
- **Rejected patches** either failed a filtering stage or were classified as likely overfitting

**Understanding overfitting scores:**

The overfitting percentage indicates how likely the patch is to "cheat" — fixing only the specific failing case rather than the underlying bug. Lower is better:

| Score | Interpretation |
|-------|----------------|
| 0–20% | Likely a genuine fix |
| 20–50% | Moderate risk — review carefully |
| 50%+ | Probably overfitting — auto-rejected |

**Using `--verbose` for full patch diffs:**

```bash
$ buggy investigate calculateDiscount -f src/cart.ts --verbose
  ...
  Approved Patches (1):
    ✓ patch_a7f3c21_001 — overfitting: 12.3%
      File: src/cart.ts (L12-L14)
      Diff:
        - return price * (discountPercent / 100);
        + const clampedDiscount = Math.min(discountPercent, 100);
        + return price * (clampedDiscount / 100);

  Rejected Patches (2):
    ✗ patch_a7f3c21_002 — compilation_failed
    ✗ patch_a7f3c21_003 — overfitting_threshold_exceeded
```

**Using `--json` for CI/CD integration:**

```bash
$ buggy investigate calculateDiscount -f src/cart.ts --json
{
  "id": "inv_1718234567890_a7f3c21",
  "status": "confirmed_and_repaired",
  "proof": {
    "test_input": {"price": 100, "discountPercent": 150},
    "observed_output": -50,
    "violated_postcondition": "result >= 0",
    "admissibility_verified_at": "2024-06-12T14:22:47.123Z",
    "soundness_verified_at": "2024-06-12T14:22:47.456Z",
    "uniqueness_verified_at": "2024-06-12T14:22:47.789Z"
  },
  "approved_patches": [...],
  "rejected_patches": [...],
  "intermediate_results": {...},
  "timeline": [...]
}
```

---

### `buggy status <id>`

Check progress of a running investigation. Useful for long-running analyses where you want to monitor which phase the system is in.

**Example:**

```bash
$ buggy status inv_1718234567890_a7f3c21

  Investigation Status
  ─────────────────────────────────────
  ID:       inv_1718234567890_a7f3c21
  Phase:    repair
  Agent:    RepairAgent
  Elapsed:  4521ms
  Started:  2024-06-12T14:22:45.100Z

  Intermediate Results:
    CST nodes parsed:       847
    Symbols resolved:       42
    Specs refined:          3
    PROBE iterations:       27
    Fuzz mutations:         1504
    Patches generated:      5
    Patches approved:       0
```

With `--json`:

```bash
$ buggy status inv_1718234567890_a7f3c21 --json
{
  "id": "inv_1718234567890_a7f3c21",
  "phase": "repair",
  "current_agent": "RepairAgent",
  "started_at": "2024-06-12T14:22:45.100Z",
  "elapsed_ms": 4521,
  "intermediate_results": {
    "cst_nodes_parsed": 847,
    "symbols_resolved": 42,
    "specifications_refined": 3,
    "probe_iterations": 27,
    "fuzz_mutations": 1504,
    "patches_generated": 5,
    "patches_approved": 0
  }
}
```

---

### `buggy halt <id>`

Stops a running investigation. The system preserves all intermediate results collected up to that point — you can examine partial proofs or patches generated before halting.

**When to use:**
- An investigation is taking too long
- You've seen enough intermediate data to understand the issue
- You want to adjust specifications and re-run

**Example:**

```bash
$ buggy halt inv_1718234567890_a7f3c21
✓ Investigation inv_1718234567890_a7f3c21 halted.
```

---

## 4. Using as an MCP Server

The debugger exposes all its capabilities as MCP tools over stdio transport, allowing AI-powered IDEs to invoke proof-carrying debugging directly from chat.

### Available MCP Tools

| Tool | Description |
|------|-------------|
| `buggy_init` | Initialize the debugger for a project |
| `buggy_analyze` | Parse a file, return CST summary and function list |
| `buggy_investigate` | Run full investigation pipeline on a function |
| `buggy_status` | Check investigation progress |
| `buggy_query_graph` | Query the semantic graph (callees, nodes, file graph) |
| `buggy_list_functions` | List all function declarations in a file |

---

### Cursor

Add to your MCP configuration (Settings → MCP → Add Server):

```json
{
  "mcpServers": {
    "buggy": {
      "command": "npx",
      "args": ["buggy-mcp"],
      "env": {}
    }
  }
}
```

Then in Cursor's chat, you can say:

> "Investigate the processPayment function in src/payments.ts for bugs"

Cursor will invoke `buggy_investigate` and present the results inline.

---

### VS Code + Copilot

Add to `.vscode/mcp.json` in your workspace (or user settings):

```json
{
  "servers": {
    "buggy": {
      "command": "npx",
      "args": ["buggy-mcp"],
      "env": {}
    }
  }
}
```

Invoke from Copilot Chat using `@buggy` or by asking it to analyze a function.

---

### Kiro

Add to `.kiro/settings/mcp.json`:

```json
{
  "mcpServers": {
    "buggy": {
      "command": "npx",
      "args": ["buggy-mcp"],
      "env": {}
    }
  }
}
```

---

### Claude Desktop

Add to your Claude Desktop config file:

- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "buggy": {
      "command": "npx",
      "args": ["buggy-mcp"],
      "env": {}
    }
  }
}
```

---

### Generic MCP Client

The MCP server uses **stdio transport** — it reads JSON-RPC messages from stdin and writes responses to stdout. Any MCP-compatible client can connect:

```bash
# The server binary
npx buggy-mcp
```

The server advertises its tools via the standard `tools/list` method and handles invocations via `tools/call`. No HTTP server, no ports — just stdin/stdout.

For custom integrations, spawn the process and communicate over pipes:

```typescript
import { spawn } from 'node:child_process';

const proc = spawn('npx', ['buggy-mcp'], {
  stdio: ['pipe', 'pipe', 'inherit'],
});

// Send JSON-RPC messages to proc.stdin
// Read JSON-RPC responses from proc.stdout
```

---

## 4b. Kiro-Powered Features

Buggy now works automatically inside Kiro — your team doesn't need to run commands manually. Once the `.kiro/` folder is committed to your repo, every team member gets zero-effort bug detection.

### The 6 Hooks

Hooks fire automatically on IDE events, invoking Buggy's MCP tools behind the scenes.

| Hook | Event | What It Does |
|------|-------|--------------|
| `buggy-on-save` | `fileEdited` | Analyzes the saved file for bugs immediately after every save |
| `buggy-post-write` | `postToolUse` (write tools) | Verifies code correctness after Kiro writes or modifies files |
| `buggy-pre-task` | `preTaskExecution` | Scans files relevant to a spec task before work begins |
| `buggy-auto-fix` | `agentStop` | Self-healing loop — re-analyzes and fixes up to 3 iterations |
| `buggy-deep-scan` | `userTriggered` | Full project scan across all source files (manual trigger) |
| `buggy-spec-evolution` | `postTaskExecution` | Verifies new implementations match their specifications |

### The 8 Steering Files

Steering files provide persistent instructions that guide Kiro's behavior during debugging workflows.

#### Always Active (inclusion: `auto`)

| File | Purpose |
|------|---------|
| `buggy-debugging.md` | Core workflow — tells Kiro how to use Buggy's MCP tools step-by-step |
| `buggy-cross-file-impact.md` | Check all callers before modifying a function signature |
| `buggy-bug-trends.md` | Maintain a bug report file after every proven bug is found |
| `buggy-onboarding.md` | Warn developers about past bugs when they edit historically risky files |

#### File-Match Activated

| File | Trigger | Purpose |
|------|---------|---------|
| `buggy-spec-from-tests.md` | Test files (`**/*.test.ts`, `**/*.spec.ts`) | Infer specifications from test assertions when editing test files |

#### Manual Trigger

| File | Purpose |
|------|---------|
| `buggy-pr-review.md` | Proof-backed PR review — analyze changed functions before merge |
| `buggy-git-diff-specs.md` | Infer specifications from git diff context |
| `buggy-type-narrowing.md` | Suggest TypeScript branded types for stronger compile-time safety |

### Customizing Hook Behavior

Each hook is defined in `.kiro/hooks/`. You can edit the `outputPrompt` field to change what the agent does when the hook fires.

Example — make `buggy-on-save` only analyze TypeScript files:

```json
{
  "id": "buggy-on-save",
  "event": "fileEdited",
  "filePatterns": "**/*.ts,**/*.tsx",
  "action": "askAgent",
  "outputPrompt": "Run buggy_analyze on the saved file. Report any proven bugs."
}
```

### Disabling Specific Hooks

To disable a hook, either:

1. **Delete the hook file** from `.kiro/hooks/`
2. **Comment out the hook** by renaming the file with a `.disabled` extension

For steering files, change `inclusion: auto` to `inclusion: manual` in the front matter to prevent automatic activation.

### Team Deployment

The `.kiro/` folder contains all hooks and steering files. Commit it to your repo and every team member gets automatic bug detection:

```bash
# Add Kiro integration to your project
git add .kiro/hooks/ .kiro/steering/ .kiro/settings/mcp.json
git commit -m "Add Buggy Kiro integration — automatic bug detection for all team members"
git push
```

What gets committed:
- `.kiro/hooks/` — The 6 hook definitions
- `.kiro/steering/` — The 8 steering files
- `.kiro/settings/mcp.json` — MCP server configuration pointing to Buggy

What stays local (add to `.gitignore`):
- `.kiro/cache/` — Local analysis cache
- `.kiro/state/` — Per-developer state

---

## 5. Using the Programmatic API

### Installation as a Dependency

```bash
npm install buggy
```

### Basic Usage Pattern

The API follows a simple lifecycle: **Initialize → Investigate → Read Report → Shutdown**.

```typescript
import { ProofDebugger } from 'buggy';

async function main() {
  // 1. Create an instance pointing at your project
  const debugger_ = new ProofDebugger({
    projectRoot: '/path/to/your/project',
  });

  try {
    // 2. Initialize (loads config, boots database and agents)
    await debugger_.initialize();

    // 3. Investigate a function
    const report = await debugger_.investigate({
      functionId: 'calculateTotal',
      filePath: 'src/cart.ts',
      specification: {
        preconditions: ['items.length > 0', 'items.every(i => i.price >= 0)'],
        postconditions: ['result >= 0', 'result === items.reduce((s, i) => s + i.price * i.qty, 0)'],
        parameters: [{ name: 'items', type: 'CartItem[]' }],
        return_type: 'number',
      },
    });

    // 4. Read the report
    console.log(`Status: ${report.status}`);

    if (report.proof) {
      console.log(`Bug proven: ${report.proof.violated_postcondition}`);
      console.log(`Failing input: ${JSON.stringify(report.proof.test_input)}`);
    }

    if (report.approved_patches.length > 0) {
      console.log(`\nApproved fixes:`);
      for (const { patch, classification } of report.approved_patches) {
        console.log(`  ${patch.id} (overfitting: ${(classification.overfitting_probability * 100).toFixed(1)}%)`);
        console.log(`  ${patch.diff}`);
      }
    }
  } finally {
    // 5. Always shutdown to close DB and LSP connections
    await debugger_.shutdown();
  }
}

main().catch(console.error);
```

### Advanced Patterns

#### Batch Investigation (Multiple Functions)

```typescript
import { ProofDebugger } from 'buggy';

async function investigateAll(functions: string[], filePath: string) {
  const debugger_ = new ProofDebugger({ projectRoot: process.cwd() });
  await debugger_.initialize();

  const results = [];

  for (const fn of functions) {
    const report = await debugger_.investigate({
      functionId: fn,
      filePath,
    });
    results.push({ function: fn, report });
  }

  await debugger_.shutdown();
  return results;
}

// Investigate all functions in a file
const functions = ['validateEmail', 'processPayment', 'calculateShipping'];
const results = await investigateAll(functions, 'src/checkout.ts');
```

#### Custom Specifications

```typescript
const report = await debugger_.investigate({
  functionId: 'divide',
  filePath: 'src/math.ts',
  specification: {
    preconditions: [
      'typeof a === "number"',
      'typeof b === "number"',
      'b !== 0',
      'Number.isFinite(a)',
      'Number.isFinite(b)',
    ],
    postconditions: [
      'Number.isFinite(result)',
      'Math.abs(result * b - a) < 1e-10',
    ],
    parameters: [
      { name: 'a', type: 'number' },
      { name: 'b', type: 'number' },
    ],
    return_type: 'number',
  },
});
```

#### Graph Queries for Code Understanding

```typescript
// Parse a file first
const parseResult = await debugger_.parse('src/services/auth.ts');
console.log(`Nodes: ${parseResult.cst.children.length}`);
console.log(`Errors: ${parseResult.errors.length}`);

// Query what a function calls
const { callees, edges } = await debugger_.queryCallees('authenticateUser');
console.log(`authenticateUser calls ${callees.length} functions:`);
for (const callee of callees) {
  console.log(`  → ${callee.text_content} (${callee.file_path}:${callee.start_line})`);
}

// Get the full graph for a file
const fileGraph = debugger_.queryFileGraph('src/services/auth.ts');
console.log(`File has ${fileGraph.nodes.length} nodes and ${fileGraph.edges.length} edges`);

// Look up a specific node
const node = debugger_.queryNode('node_42');
if (node) {
  console.log(`Node type: ${node.type}, line: ${node.start_line}`);
}
```

#### Integration with CI/CD Scripts

```typescript
import { ProofDebugger } from 'buggy';

async function ciCheck(changedFiles: string[]) {
  const debugger_ = new ProofDebugger({ projectRoot: process.cwd() });
  await debugger_.initialize();

  const failures: string[] = [];

  for (const file of changedFiles) {
    const parseResult = await debugger_.parse(file);

    if (parseResult.errors.length > 0) {
      failures.push(`${file}: ${parseResult.errors.length} syntax errors`);
    }
  }

  await debugger_.shutdown();

  if (failures.length > 0) {
    console.error('Buggy CI check failed:');
    failures.forEach(f => console.error(`  ${f}`));
    process.exit(1);
  }

  console.log('All files passed analysis.');
}
```

---

## 6. Understanding the Report

An investigation report (`InvestigationReport`) contains everything the debugger found.

### `status`

| Value | Meaning |
|-------|---------|
| `confirmed_and_repaired` | A bug was proven AND at least one non-overfitting patch was generated |
| `confirmed_no_repair` | A bug was proven but no acceptable patch could be generated |
| `unconfirmed` | The debugger could not prove a bug exists (specs may be satisfied, or too weak to find violations) |
| `halted` | The investigation was manually halted before completing |

### `proof`

The proof-of-failure certificate. Present when `status` is `confirmed_and_repaired` or `confirmed_no_repair`.

| Field | Description |
|-------|-------------|
| `test_input` | The concrete input that triggers the bug |
| `observed_output` | What the function actually returned |
| `violated_postcondition` | Which postcondition was broken |
| `admissibility_verified_at` | Timestamp: the input satisfies all preconditions |
| `soundness_verified_at` | Timestamp: the output genuinely violates the postcondition |
| `uniqueness_verified_at` | Timestamp: the violation is deterministically reproducible |

The three timestamps form the certificate's validity chain. If any check fails, no certificate is issued.

### `approved_patches`

Each approved patch contains:

| Field | Description |
|-------|-------------|
| `patch.id` | Unique patch identifier |
| `patch.diff` | The unified diff showing the change |
| `patch.target_file` | File that would be modified |
| `patch.target_range` | Line range (`start_line` to `end_line`) |
| `patch.edit_operations` | AST-level operations (insert, delete, replace, move) |
| `classification.overfitting_probability` | 0.0–1.0 score (lower = better) |

To apply a patch, use the `diff` field with standard patch tools, or manually apply the changes at the indicated line range.

### `rejected_patches`

Each rejected patch includes a `rejection_reason`:

| Reason | Meaning |
|--------|---------|
| `compilation_failed` | The patched code doesn't compile |
| `emulation_failed` | The patch fails during sandbox emulation |
| `test_failed` | The patch breaks existing test cases |
| `overfitting_threshold_exceeded` | PRISM-APCC classified the patch as likely overfitting |

### `timeline`

Shows how long each phase took:

```json
[
  { "phase": "parsing", "agent": "ParserAgent", "started_at": "...", "completed_at": "..." },
  { "phase": "proving", "agent": "BugProvingAgent", "started_at": "...", "completed_at": "..." },
  { "phase": "repair", "agent": "RepairAgent", "started_at": "...", "completed_at": "..." },
  { "phase": "classification", "agent": "ClassifierAgent", "started_at": "...", "completed_at": "..." }
]
```

### `intermediate_results`

Diagnostic counters useful for debugging the debugger itself:

| Field | Description |
|-------|-------------|
| `cst_nodes_parsed` | Total CST nodes in the parsed file |
| `symbols_resolved` | Symbols successfully resolved by LSP |
| `specifications_refined` | Number of PROBE spec refinement iterations |
| `probe_iterations` | Total PROBE loop iterations |
| `fuzz_mutations` | Number of fuzz mutations explored |
| `patches_generated` | Total patches generated before filtering |
| `patches_approved` | Patches that passed all stages |

---

## 7. Writing Specifications

Specifications define what your function should do. They consist of **preconditions** (what must be true about inputs) and **postconditions** (what must be true about outputs). Better specifications lead to stronger proofs and better repairs.

### What Makes a Good Precondition

Preconditions constrain the input space to meaningful values. They answer: "Under what conditions is this function supposed to work correctly?"

```typescript
// Good — specific, testable constraints
preconditions: [
  'amount > 0',
  'amount <= 1_000_000',
  'typeof currency === "string"',
  'currency.length === 3',
]

// Bad — too vague or untestable
preconditions: [
  'amount is reasonable',     // Not machine-checkable
  'valid input',              // Too vague
]
```

### What Makes a Good Postcondition

Postconditions describe the output guarantees. They answer: "If the input is valid, what must be true about the result?"

```typescript
// Good — concrete, verifiable properties
postconditions: [
  'result >= 0',
  'result <= amount',
  'typeof result === "number"',
  'Number.isFinite(result)',
]

// Bad — trivial or implementation-coupled
postconditions: [
  'result !== undefined',        // Almost always true, catches nothing
  'result === amount * 0.85',    // Encodes the implementation, not the intent
]
```

### Common Patterns

**Non-null / defined results:**
```typescript
postconditions: ['result !== null', 'result !== undefined']
```

**Non-negative numeric results:**
```typescript
postconditions: ['result >= 0', 'Number.isFinite(result)']
```

**Type guards:**
```typescript
postconditions: ['typeof result === "string"', 'result.length > 0']
```

**State transitions:**
```typescript
postconditions: [
  'result.status === "active" || result.status === "inactive"',
  'result.updatedAt > result.createdAt',
]
```

**Array invariants:**
```typescript
postconditions: [
  'Array.isArray(result)',
  'result.length <= input.length',
  'result.every(item => item.score >= threshold)',
]
```

### Examples for Different Function Types

#### Pure Computation Functions

```typescript
// Function: clamp(value, min, max)
specification: {
  preconditions: ['min <= max', 'Number.isFinite(value)'],
  postconditions: [
    'result >= min',
    'result <= max',
    'value >= min && value <= max ? result === value : true',
  ],
  parameters: [
    { name: 'value', type: 'number' },
    { name: 'min', type: 'number' },
    { name: 'max', type: 'number' },
  ],
  return_type: 'number',
}
```

#### Validation Functions

```typescript
// Function: validateEmail(email)
specification: {
  preconditions: ['typeof email === "string"'],
  postconditions: [
    'typeof result === "boolean"',
    'email.includes("@") || result === false',
    'email.length === 0 ? result === false : true',
  ],
  parameters: [{ name: 'email', type: 'string' }],
  return_type: 'boolean',
}
```

#### State-Mutating Functions

```typescript
// Function: addItem(cart, item)
specification: {
  preconditions: [
    'Array.isArray(cart.items)',
    'item.quantity > 0',
    'item.price >= 0',
  ],
  postconditions: [
    'result.items.length === cart.items.length + 1',
    'result.total >= cart.total',
    'result.items[result.items.length - 1].id === item.id',
  ],
  parameters: [
    { name: 'cart', type: 'Cart' },
    { name: 'item', type: 'CartItem' },
  ],
  return_type: 'Cart',
}
```

#### Async Functions

```typescript
// Function: fetchUser(id)
specification: {
  preconditions: [
    'typeof id === "string"',
    'id.length > 0',
  ],
  postconditions: [
    'result === null || typeof result.name === "string"',
    'result === null || result.id === id',
  ],
  parameters: [{ name: 'id', type: 'string' }],
  return_type: 'Promise<User | null>',
}
```

---

## 8. Configuration Reference

Full `.debugger.yaml` schema with all fields.

### `version`

| | |
|---|---|
| **Type** | `string` |
| **Required** | Yes |
| **Valid values** | `"1.0"` |
| **Description** | Config schema version. Currently only `"1.0"` is supported. |

### `language`

| | |
|---|---|
| **Type** | `string` |
| **Required** | Yes |
| **Valid values** | `typescript`, `javascript`, `python`, `rust`, `go`, `java`, `c`, `cpp` |
| **Description** | Primary project language. Determines default parser and LSP if not explicitly configured. |

### `parser`

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `command` | `string` | Yes | — | Tree-sitter grammar identifier (e.g., `tree-sitter-typescript`) |
| `grammar_path` | `string` | No | — | Path to a custom `.wasm` grammar file |

### `lsp`

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `command` | `string` | Yes | — | LSP server command (e.g., `typescript-language-server`) |
| `initialization_options` | `object` | No | `{}` | Options passed to the LSP server during initialization |

### `sandbox`

| Field | Type | Required | Default | Range | Description |
|-------|------|----------|---------|-------|-------------|
| `runtime` | `string` | Yes | — | — | Execution runtime (`node`, `python`, `deno`, `bun`, `cargo`, `go`, `java`) |
| `memory_limit_mb` | `number` | Yes | — | 64–8192 | Maximum memory per sandbox instance in MB |
| `timeout_seconds` | `number` | Yes | — | 1–300 | Maximum execution time per sandbox run |
| `egress_policy` | `string` | No | `deny` | `deny`, `allow_host_only` | Network egress policy for sandboxed code |

**When to change:**
- Increase `memory_limit_mb` for projects with heavy dependencies or large test data
- Increase `timeout_seconds` for slow build systems (Rust, Java) or integration tests
- Use `allow_host_only` if your code needs to talk to a local database during testing

### `oracles`

| Field | Type | Required | Default | Range | Description |
|-------|------|----------|---------|-------|-------------|
| `timeout_threshold_seconds` | `number` | Yes | — | 1–300 | Execution time above this triggers timeout oracle |
| `crash_detection` | `boolean` | Yes | — | — | Detect uncaught exceptions as violations |
| `overflow_detection` | `boolean` | Yes | — | — | Detect integer/buffer overflows |
| `determinism_check_count` | `number` | Yes | — | 1–100 | Number of executions to verify determinism |

**When to change:**
- Lower `timeout_threshold_seconds` for performance-critical paths
- Increase `determinism_check_count` if you suspect intermittent failures
- Disable `overflow_detection` for code that intentionally uses wrapping arithmetic

### `probe`

| Field | Type | Required | Default | Range | Description |
|-------|------|----------|---------|-------|-------------|
| `search_budget` | `number` | Yes | — | 1–10000 | Maximum property candidates to explore |
| `max_refinement_iterations` | `number` | Yes | — | 1–100 | Maximum refinement iterations per property |

**When to change:**
- Increase `search_budget` for complex functions where the bug is hard to find
- Decrease both values for faster (but shallower) analysis

### `plugs` (Optional)

| Field | Type | Description |
|-------|------|-------------|
| `parsing` | `string` | Path to a custom parser module implementing `ParsingPlug` |
| `oracles` | `string[]` | Paths to custom oracle modules implementing `OraclePlug` |
| `repair` | `string` | Path to a custom repair module implementing `RepairPlug` |
| `sandbox_executor` | `string` | Path to a custom sandbox module implementing `SandboxExecutorPlug` |

---

## 9. Troubleshooting

### "ConfigError: .debugger.yaml not found"

The debugger couldn't find a config file.

**Fix:** Run `buggy init` in your project root, or specify a custom path via the `configPath` option in the API.

---

### "LSP timeout" or "LSP connection refused"

The LSP server isn't responding.

**Fix:**
1. Verify the LSP server is installed: `which typescript-language-server` (or the server for your language)
2. Install it if missing: `npm install -g typescript-language-server typescript`
3. Check that the `lsp.command` in `.debugger.yaml` matches the installed binary name

---

### "Sandbox unavailable"

The Firecracker microVM sandbox isn't configured.

**Context:** Full isolation uses Firecracker VMs. If unavailable, the system falls back to emulated mode (process-level isolation with resource limits). Emulated mode is safe for development but not recommended for untrusted code.

**Fix:** For development, this warning is informational — the debugger still works. For production isolation, configure Firecracker according to its documentation.

---

### "No proof found" / Status: `unconfirmed`

The debugger exhausted its search budget without finding a specification violation.

**Possible causes:**
1. The function might actually be correct
2. Specifications are too weak (the postconditions don't capture the real requirement)
3. The search budget is too low for a complex function

**Fix:**
- Strengthen your postconditions to describe what the function should guarantee
- Increase `probe.search_budget` in `.debugger.yaml`
- Add more specific preconditions to focus the search space

---

### "All patches rejected"

A bug was proven but every generated patch was rejected.

**Possible causes:**
1. The overfitting threshold is too aggressive (rejecting good patches)
2. The bug requires architectural changes that AST-local patches can't capture
3. Missing test coverage makes it impossible to verify patches

**Fix:**
- Review the rejection reasons in `--verbose` output
- If all rejections are `overfitting_threshold_exceeded`, the patches might actually be fine — review them manually
- If all rejections are `compilation_failed`, the repair agent may need more context (check LSP connectivity)

---

### Build or compilation errors

```
Error: Cannot find module 'buggy'
```

**Fix:**
1. Check Node.js version: `node --version` (must be >= 18)
2. Reinstall: `npm install buggy`
3. If using globally: `npm install -g buggy`

---

### "Database locked" or SQLite errors

The graph database is being accessed by multiple processes simultaneously.

**Fix:**
1. Ensure only one `buggy` process runs per project at a time
2. Delete `.debugger/graph.db` to reset (it will be rebuilt on next run)

---

## 10. Integration Recipes

### CI/CD — GitHub Actions

```yaml
name: Proof-Carrying Debug Check

on:
  pull_request:
    paths:
      - 'src/**/*.ts'

jobs:
  proof-debug:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Install dependencies
        run: npm ci

      - name: Install buggy
        run: npm install -g buggy

      - name: Initialize debugger
        run: buggy init

      - name: Analyze changed files
        run: |
          CHANGED_FILES=$(git diff --name-only origin/main -- 'src/**/*.ts')
          for file in $CHANGED_FILES; do
            echo "## Analyzing $file" >> $GITHUB_STEP_SUMMARY
            buggy analyze "$file" --json >> analysis.json 2>&1 || true
          done

      - name: Investigate functions in changed files
        run: |
          CHANGED_FILES=$(git diff --name-only origin/main -- 'src/**/*.ts')
          for file in $CHANGED_FILES; do
            # Extract function names using the analyze command
            FUNCTIONS=$(buggy analyze "$file" --json | jq -r '.functions[]?.name // empty' 2>/dev/null)
            for fn in $FUNCTIONS; do
              echo "Investigating $fn in $file..."
              RESULT=$(buggy investigate "$fn" --file "$file" --json 2>&1)
              STATUS=$(echo "$RESULT" | jq -r '.status // "error"')
              if [ "$STATUS" = "confirmed_and_repaired" ] || [ "$STATUS" = "confirmed_no_repair" ]; then
                echo "::warning file=$file::Bug proven in function $fn"
                echo "### ⚠️ Bug found: \`$fn\` in \`$file\`" >> $GITHUB_STEP_SUMMARY
                echo '```json' >> $GITHUB_STEP_SUMMARY
                echo "$RESULT" | jq '.proof' >> $GITHUB_STEP_SUMMARY
                echo '```' >> $GITHUB_STEP_SUMMARY
              fi
            done
          done

      - name: Upload analysis results
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: proof-debug-results
          path: analysis.json
```

---

### CI/CD — GitLab CI

```yaml
proof-debug:
  stage: test
  image: node:20
  script:
    - npm ci
    - npm install -g buggy
    - buggy init
    - |
      CHANGED_FILES=$(git diff --name-only $CI_MERGE_REQUEST_DIFF_BASE_SHA -- 'src/**/*.ts')
      EXIT_CODE=0
      for file in $CHANGED_FILES; do
        RESULT=$(buggy analyze "$file" --json 2>&1)
        ERRORS=$(echo "$RESULT" | jq '.syntax_errors | length')
        if [ "$ERRORS" -gt 0 ]; then
          echo "ERROR: $file has $ERRORS syntax errors"
          EXIT_CODE=1
        fi
      done
      exit $EXIT_CODE
  rules:
    - if: $CI_MERGE_REQUEST_ID
      changes:
        - src/**/*.ts
  artifacts:
    reports:
      dotenv: proof-debug.env
```

---

### Pre-commit Hook

Create `.git/hooks/pre-commit` (or use with husky/lint-staged):

```bash
#!/bin/bash
# Pre-commit hook: run buggy analysis on staged TypeScript files

STAGED_TS_FILES=$(git diff --cached --name-only --diff-filter=ACM | grep '\.ts$')

if [ -z "$STAGED_TS_FILES" ]; then
  exit 0
fi

echo "Running buggy analysis on staged files..."

EXIT_CODE=0
for file in $STAGED_TS_FILES; do
  RESULT=$(npx buggy analyze "$file" --json 2>&1)
  ERRORS=$(echo "$RESULT" | jq '.errors | length' 2>/dev/null)

  if [ "$ERRORS" -gt 0 ]; then
    echo "⚠ $file has syntax errors:"
    echo "$RESULT" | jq -r '.errors[] | "  Line \(.location.row): \(.message)"'
    EXIT_CODE=1
  fi
done

if [ $EXIT_CODE -ne 0 ]; then
  echo ""
  echo "Fix syntax errors before committing."
fi

exit $EXIT_CODE
```

Make it executable:

```bash
chmod +x .git/hooks/pre-commit
```

---

### VS Code Task

Add to `.vscode/tasks.json`:

```json
{
  "version": "2.0.0",
  "tasks": [
    {
      "label": "Buggy: Analyze Current File",
      "type": "shell",
      "command": "npx buggy analyze ${relativeFile}",
      "group": "test",
      "presentation": {
        "reveal": "always",
        "panel": "shared"
      },
      "problemMatcher": []
    },
    {
      "label": "Buggy: Investigate Function",
      "type": "shell",
      "command": "npx buggy investigate ${input:functionName} --file ${relativeFile} --verbose",
      "group": "test",
      "presentation": {
        "reveal": "always",
        "panel": "dedicated"
      },
      "problemMatcher": []
    }
  ],
  "inputs": [
    {
      "id": "functionName",
      "description": "Function name to investigate",
      "type": "promptString"
    }
  ]
}
```

Run via: `Ctrl+Shift+P` → "Tasks: Run Task" → select the task.

---

### NPM Script

Add to your `package.json`:

```json
{
  "scripts": {
    "debug:analyze": "buggy analyze",
    "debug:investigate": "buggy investigate",
    "debug:check": "buggy analyze src/index.ts --json",
    "debug:full": "buggy investigate processPayment --file src/payments.ts --verbose"
  }
}
```

Usage:

```bash
npm run debug:analyze -- src/cart.ts
npm run debug:investigate -- calculateTotal --file src/cart.ts
npm run debug:check
npm run debug:full
```

---

## 11. Extending with Custom Plugs

The plug system lets you replace or extend default agent behavior without modifying core code. There are four plug types, each implementing a well-defined interface.

> For full architectural details and type definitions, see [TECHNICAL.md](./TECHNICAL.md).

### When You Need a Custom Plug

- **Custom parser:** Your language doesn't have a Tree-sitter grammar, or you need specialized preprocessing
- **Custom oracle:** You want to detect domain-specific bugs (memory leaks, concurrency issues, security violations)
- **Custom repair:** You have an ML model or heuristic that generates better patches for your domain
- **Custom sandbox:** You need a different isolation mechanism (Docker, Podman, WASM, remote execution)

### The 4 Plug Types

| Plug | Interface | Purpose |
|------|-----------|---------|
| `ParsingPlug` | `parse(source, filePath)` + `parseIncremental(...)` | Custom CST generation |
| `OraclePlug` | `monitor(executionStep)` + `onFailure()` | Custom violation detection |
| `RepairPlug` | `generateCandidates(context)` + `refine(patch, feedback)` | Custom patch generation |
| `SandboxExecutorPlug` | `execute(request)` + `configure(config)` | Custom isolated execution |

### Quick Example: Custom Oracle

```typescript
// plugs/memory-oracle.ts
import type { OraclePlug, ExecutionStep } from 'buggy';
import type { OracleViolation } from 'buggy';

export const memoryOracle: OraclePlug = {
  name: 'memory-leak-detector',

  async monitor(step: ExecutionStep) {
    // Track allocations across execution steps
    const heapUsed = process.memoryUsage().heapUsed;
    const threshold = 100 * 1024 * 1024; // 100MB

    if (heapUsed > threshold) {
      return {
        type: 'resource_exhaustion',
        message: `Heap exceeded ${threshold / 1024 / 1024}MB at step ${step.statement_index}`,
        severity: 'error',
        location: step.source_location,
      };
    }

    return null;
  },

  onFailure() {
    // Cleanup logic when the oracle detects a failure
    global.gc?.();
  },
};
```

Register in `.debugger.yaml`:

```yaml
plugs:
  oracles:
    - ./plugs/memory-oracle
```

The debugger loads and validates plugs at startup. If a plug fails to load or doesn't match the expected interface, the system falls back to the default implementation and logs a warning.

---

## What's Next

- Read [TECHNICAL.md](./TECHNICAL.md) for the full architecture, data model, and agent internals
- Browse the `tests/demo/` directory for working examples with buggy fixtures
- Try investigating the demo app: `buggy investigate calculateTotal --file tests/demo/fixtures/demo-buggy-app/src/cart.ts`
