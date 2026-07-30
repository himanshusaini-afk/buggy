# Buggy

A multi-agent system that autonomously analyzes code, proves bugs exist with formal certificates, generates repairs, and validates patches against overfitting — all coordinated over the Model Context Protocol (MCP). Unlike traditional debuggers that rely on breakpoints and manual inspection, this system produces cryptographically-verifiable proof-of-failure certificates before attempting any repair.

## Quick Start

```bash
# Install
npm install buggy

# Initialize in your project
cd /path/to/your/project
npx buggy init

# Edit .debugger.yaml to match your project setup, then:
npx buggy analyze src/payments.ts
npx buggy investigate processPayment --file src/payments.ts
```

## Kiro Integration

Buggy now works automatically inside Kiro — your team doesn't need to run commands manually. Once configured, every file save, every AI-generated edit, and every spec task is automatically analyzed for bugs with zero developer effort.

### How It Works

Buggy ships with 6 Kiro hooks that fire on IDE events. When a hook triggers, Kiro's agent calls Buggy's MCP tools behind the scenes, interprets the results, and either reports findings or applies fixes automatically.

### Hooks (Automatic Bug Detection)

| Hook | Trigger | What It Does |
|------|---------|--------------|
| `buggy-on-save` | File saved | Analyzes the saved file for bugs immediately |
| `buggy-post-write` | Kiro writes code | Verifies AI-generated code for correctness |
| `buggy-pre-task` | Before spec task execution | Scans relevant files before changes are made |
| `buggy-auto-fix` | Agent completes work | Self-healing loop — re-checks and fixes (max 3 iterations) |
| `buggy-deep-scan` | User-triggered | Full project scan across all source files |
| `buggy-spec-evolution` | After task completion | Verifies new implementations match specifications |

### What Developers Experience

- Save a file → bugs are surfaced in seconds, no command needed
- Kiro writes code → Buggy verifies it before you even review
- Start a spec task → risky files are pre-scanned for existing issues
- Complete a task → implementation is verified against the spec

### Deploying to Your Team

Commit the `.kiro/` folder to your repository. Every team member who opens the project in Kiro gets automatic bug detection with no setup:

```bash
git add .kiro/
git commit -m "Add Buggy hooks and steering files for automatic bug detection"
```

### Steering Files (Advanced Workflows)

Buggy includes 8 steering files that guide Kiro's behavior during debugging workflows. Four are always active (cross-file impact analysis, bug trend tracking, onboarding warnings, core debugging workflow), and four activate on demand for PR reviews, git-diff analysis, spec inference, and TypeScript type narrowing suggestions.

See the [Usage Guide](docs/USAGE-GUIDE.md) for the full list and customization options.

---

## Installation

```bash
npm install buggy
```

Or install globally for CLI access:

```bash
npm install -g buggy
buggy --help
```

### Requirements

- Node.js >= 18.0.0
- A Tree-sitter grammar for your language
- An LSP server for symbol resolution (optional but recommended)

## Integration Guide

### 1. Add configuration to your project

Run `buggy init` in your project root. This creates:

- `.debugger.yaml` — configuration file
- `.debugger/` — working directory for the graph database

### 2. Configure for your language

Edit `.debugger.yaml` to match your project:

```yaml
language: typescript
parser:
  command: tree-sitter-typescript
lsp:
  command: typescript-language-server
sandbox:
  runtime: node
  memory_limit_mb: 512
  timeout_seconds: 60
```

### 3. Add to .gitignore

```gitignore
# Buggy
.debugger/
```

## Programmatic API

```typescript
import { ProofDebugger } from 'buggy';

const debugger_ = new ProofDebugger({
  projectRoot: '/path/to/your/project',
  language: 'typescript', // optional override
  sandbox: { memory_limit_mb: 1024 }, // optional override
});

await debugger_.initialize();

// Investigate a specific function
const report = await debugger_.investigate({
  functionId: 'processPayment',
  filePath: 'src/payments.ts',
  specification: {
    preconditions: ['amount > 0'],
    postconditions: ['result.status === "success" || result.status === "failed"'],
    parameters: [{ name: 'amount', type: 'number' }],
    return_type: 'PaymentResult',
  },
});

// Access results
console.log(report.status);
// → 'confirmed_and_repaired' | 'confirmed_no_repair' | 'unconfirmed' | 'halted'

console.log(report.proof);           // The proof-of-failure certificate
console.log(report.approved_patches); // Patches that passed overfitting check

// Run a single parse
const parseResult = await debugger_.parse('src/payments.ts');
console.log(parseResult.cst);    // Full concrete syntax tree
console.log(parseResult.errors); // Syntax errors with locations

// Query the semantic graph
const { callees, edges } = await debugger_.queryCallees('processPayment');

// Query a specific node
const node = debugger_.queryNode('node_42');

// Get file subgraph
const { nodes, edges: fileEdges } = debugger_.queryFileGraph('src/payments.ts');

// Check investigation status
const status = debugger_.getStatus(report.id);

// Halt a running investigation
debugger_.halt(report.id);

// Shutdown (closes DB, LSP connections)
await debugger_.shutdown();
```

### ProofDebugger Options

```typescript
interface ProofDebuggerOptions {
  projectRoot: string;        // Required: path to your project
  language?: string;          // Override auto-detected language
  configPath?: string;        // Custom .debugger.yaml path
  dbPath?: string;            // Custom database path
  sandbox?: {
    memory_limit_mb?: number;
    timeout_seconds?: number;
    egress_policy?: 'deny' | 'allow_host_only';
  };
  probe?: {
    search_budget?: number;
    max_refinement_iterations?: number;
  };
}
```

## CLI Reference

### `buggy init`

Creates a `.debugger.yaml` template and `.debugger/` directory in the current working directory.

```bash
buggy init
buggy init --json  # Machine-readable output
```

### `buggy analyze <file>`

Parses a file using Tree-sitter and displays the semantic graph summary.

```bash
buggy analyze src/payments.ts
buggy analyze src/payments.ts --verbose   # Show CST depth-2 summary
buggy analyze src/payments.ts --json      # Full JSON output
```

### `buggy investigate <function> --file <path>`

Runs the full investigation pipeline (Parse → Prove → Repair → Classify) on a function.

```bash
buggy investigate processPayment --file src/payments.ts
buggy investigate processPayment -f src/payments.ts --verbose
buggy investigate processPayment -f src/payments.ts --json
```

### `buggy status <id>`

Shows the current status of a running or completed investigation.

```bash
buggy status inv_1234567890_abc1234
buggy status inv_1234567890_abc1234 --json
```

### `buggy halt <id>`

Halts a running investigation, preserving intermediate results.

```bash
buggy halt inv_1234567890_abc1234
```

### Global Options

| Flag | Description |
|------|-------------|
| `--json` | Output results as JSON (machine-readable) |
| `--verbose` | Enable detailed logging and extended output |
| `--help`, `-h` | Show help message |

## Configuration Reference

The `.debugger.yaml` file controls all aspects of the debugger. Here's the full schema:

```yaml
# Required
version: "1.0"
language: typescript    # Primary project language

# Parser configuration
parser:
  command: tree-sitter-typescript  # Tree-sitter grammar to use
  grammar_path: ./custom.wasm     # Optional: path to custom grammar

# Language Server Protocol
lsp:
  command: typescript-language-server
  initialization_options:          # Optional: passed to LSP on init
    preferences:
      includeInlayParameterNameHints: "all"

# Sandbox execution environment
sandbox:
  runtime: node                    # Execution runtime (node, python, deno, bun)
  memory_limit_mb: 512             # 64-8192 MB
  timeout_seconds: 60              # 1-300 seconds
  egress_policy: deny              # deny | allow_host_only

# Oracle violation detectors
oracles:
  timeout_threshold_seconds: 10    # 1-300 seconds
  crash_detection: true
  overflow_detection: true
  determinism_check_count: 5       # 1-100 runs

# PROBE loop configuration
probe:
  search_budget: 100               # Max property candidates
  max_refinement_iterations: 10    # Max iterations per property

# Optional: custom plug-ins
plugs:
  parsing: ./plugs/parser
  oracles:
    - ./plugs/memory-oracle
  repair: ./plugs/repair-strategy
  sandbox_executor: ./plugs/sandbox
```

### Defaults

| Field | Default |
|-------|---------|
| `lsp.initialization_options` | `{}` |
| `sandbox.egress_policy` | `deny` |
| `plugs` | `undefined` (no custom plugs) |

## Architecture Overview

The system consists of five specialized agents coordinated by an orchestrator:

```
┌──────────────────────────────────────────────────────────────┐
│                     Agent Orchestrator                        │
│  (Coordinates sequential pipeline + sandbox concurrency)     │
└─────────┬──────────┬──────────────┬──────────────┬───────────┘
          │          │              │              │
    ┌─────▼─────┐ ┌─▼──────────┐ ┌▼──────────┐ ┌─▼───────────┐
    │  Parser   │ │ Bug-Proving │ │  Repair   │ │ Classifier  │
    │  Agent    │ │   Agent     │ │  Agent    │ │   Agent     │
    └───────────┘ └─────────────┘ └───────────┘ └─────────────┘
          │              │              │              │
          └──────────────┴──────────────┴──────────────┘
                              │
                    ┌─────────▼─────────┐
                    │   Sandbox Agent   │
                    │  (up to 4 conc.)  │
                    └───────────────────┘
```

**Pipeline flow:**
1. **Parser Agent** — Tree-sitter CST parsing, symbol resolution via LSP, call graph construction
2. **Bug-Proving Agent** — PROBE loop + fuzzing + specification refinement → proof-of-failure certificate
3. **Repair Agent** — AST-aware patch generation with multi-stage filtering (compile → emulate → test)
4. **Classifier Agent** — PRISM-APCC overfitting detection using AST difference vectors
5. **Sandbox Agent** — Isolated execution with resource limits, available on-demand to all agents

**Data layer:**
- SQLite graph database (WAL mode) stores CST nodes, edges, symbol resolutions, proofs, and patches
- All inter-agent data flows through typed MCP tool calls

## Extending with Custom Plugs

The plug system lets you override default agent behavior without modifying core code.

### Creating a Parser Plug

```typescript
import type { ParsingPlug } from 'buggy';

export const myParser: ParsingPlug = {
  name: 'my-custom-parser',
  parse(source: string, filePath: string) {
    // Your custom parsing logic
    return { cst, errors, duration_ms, file_path: filePath };
  },
};
```

### Creating an Oracle Plug

```typescript
import type { OraclePlug } from 'buggy';

export const memoryOracle: OraclePlug = {
  name: 'memory-leak-detector',
  detect(executionResult) {
    // Analyze execution for memory leaks
    return violations;
  },
};
```

### Creating a Repair Plug

```typescript
import type { RepairPlug } from 'buggy';

export const mlRepair: RepairPlug = {
  name: 'ml-based-repair',
  generatePatches(proof, target) {
    // ML-based patch generation
    return patches;
  },
};
```

### Registering Plugs

Add plug paths to `.debugger.yaml`:

```yaml
plugs:
  parsing: ./plugs/my-custom-parser
  oracles:
    - ./plugs/memory-leak-detector
  repair: ./plugs/ml-based-repair
```

The debugger loads and validates plugs at startup, falling back to defaults if a plug fails to load.

## Development

```bash
# Build
npm run build

# Run tests
npm test

# Run specific test suites
npm run test:unit
npm run test:properties
npm run test:integration

# Run the CLI locally
node dist/cli.js --help
```

## License

MIT
