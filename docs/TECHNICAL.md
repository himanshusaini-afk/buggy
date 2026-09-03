# Buggy — Technical Documentation

## System Overview

The Buggy is a multi-agent system for autonomous code analysis, bug proving, and repair. It communicates internally via the Model Context Protocol (MCP) and exposes its capabilities through both a CLI and a programmatic API.

### Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          CLIENT LAYER                                     │
│                                                                           │
│   ┌───────────┐     ┌───────────────┐     ┌──────────────────────┐      │
│   │    CLI    │     │  MCP Server   │     │  Programmatic API    │      │
│   │ (proof-  │     │ (stdio        │     │  (ProofDebugger      │      │
│   │ debugger)│     │  transport)   │     │   class)             │      │
│   └─────┬─────┘     └───────┬───────┘     └──────────┬───────────┘      │
│         │                   │                        │                   │
└─────────┼───────────────────┼────────────────────────┼───────────────────┘
          │                   │                        │
          ▼                   ▼                        ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                      ORCHESTRATOR LAYER                                   │
│                                                                           │
│   ┌─────────────────────────────────────────────────────────────────┐   │
│   │                    AgentOrchestrator                              │   │
│   │  • Sequential pipeline: Parse → Prove → Repair → Classify       │   │
│   │  • Investigation state management                                │   │
│   │  • Sandbox concurrency control (max 4)                           │   │
│   │  • Halt/resume with intermediate result preservation             │   │
│   └─────────────────────────────────────────────────────────────────┘   │
│                                                                           │
└─────────────────────────────────────────────────────────────────────────┘
          │           │           │           │           │
          ▼           ▼           ▼           ▼           ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         AGENT LAYER                                       │
│                                                                           │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐ │
│  │  Parser  │  │Bug Proving│  │  Repair  │  │Classifier│  │ Sandbox  │ │
│  │  Agent   │  │  Agent   │  │  Agent   │  │  Agent   │  │  Agent   │ │
│  │          │  │          │  │          │  │          │  │          │ │
│  │Tree-sitter│  │Slicing   │  │Spec-guided│  │66-dim    │  │Firecracker│ │
│  │LSP       │  │SA-Fuzz   │  │patch gen │  │feature   │  │microVM   │ │
│  │Call graph│  │Proofs    │  │          │  │vector    │  │OAP       │ │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘  └──────────┘ │
│                                                                           │
└─────────────────────────────────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                       DATA LAYER                                          │
│                                                                           │
│   ┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐  │
│   │  SQLite Graph   │     │  Config Loader  │     │  Plug Registry  │  │
│   │  Database       │     │  (.debugger.yaml)│     │  (extensibility)│  │
│   └─────────────────┘     └─────────────────┘     └─────────────────┘  │
│                                                                           │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Agent Descriptions

### 1. Parser Agent (`ParserAgent`)

**Responsibility**: Fault-tolerant source code parsing and semantic graph construction.

**Capabilities**:
- Tree-sitter CST parsing preserving all whitespace, comments, and formatting
- Incremental re-parsing via Tree-sitter's edit API (sub-millisecond for local changes)
- LSP-based cross-file symbol resolution with 5-second timeout per symbol
- Error node collection with byte offset and length for partial parse recovery
- Supports files up to 100,000 lines

**Key Methods**:
- `parseFile(filePath)` — Full file parse returning CST + errors
- `parseIncremental(filePath, edit, newSource)` — Incremental re-parse
- `resolveSymbols(filePath)` — Cross-file symbol resolution via LSP
- `shutdownLsp()` — Graceful LSP teardown

### 2. Bug Proving Agent (`BugProvingAgent`)

**Responsibility**: Prove that a bug exists with mathematical certainty.

**Pipeline**:
1. **Backward Slicing** — Extract the minimal code slice relevant to the target function
2. **Specification Refinement** — Iteratively refine pre/postconditions using probe loops
3. **SA-Fuzz (Specification-Aware Fuzzing)** — Generate inputs that violate postconditions
4. **Proof Certificate Generation** — Construct a formal proof-of-failure certificate

**Output**: `ProofOfFailureCertificate` with admissibility, soundness, and reproducibility properties.

### 3. Repair Agent (`RepairAgent`)

**Responsibility**: Generate candidate patches guided by the proof certificate.

**Approach**:
- Uses the proof certificate's failure class to constrain the search space
- Generates patches based on defect context (backward slice + divergent variables)
- Produces AST edit operations, not text diffs
- Respects function specification (preconditions and postconditions)

**Output**: Array of `PatchCandidate` objects with AST edit operations and metadata.

### 4. Classifier Agent (`ClassifierAgent`)

**Responsibility**: Detect and reject overfit patches.

**Method**:
- Computes a 66-dimensional AST difference vector between original and patched code
- Evaluates semantic feature vector (control flow changes, data flow changes, scope changes)
- Calculates overfitting probability
- Approves patches below threshold; rejects those above

**Output**: `ClassificationResult` with `approved`, `overfitting_probability`, and `top_contributing_properties`.

### 5. Sandbox Agent (`SandboxAgent`)

**Responsibility**: Execute untrusted code in hardware-isolated environments.

**Features**:
- Firecracker microVM-based isolation (same tech as AWS Lambda)
- Configurable memory limits (64MB–8GB)
- Network egress policy enforcement (`deny` or `allow_host_only`)
- OAP (Origin-Aware Policy) passport system for every execution
- Circuit breaker for runaway processes
- Snapshot pooling for fast microVM boot times
- Available on-demand to all agents (up to 4 concurrent requests)

**Oracles**:
- Timeout detection
- Crash detection
- Integer/buffer overflow detection
- Determinism checking (run N times, compare outputs)

---

## Communication Protocol

### MCP Tool Definitions

The system uses MCP for both internal agent communication and external IDE integration.

#### Internal Router (`McpRouter`)

8 tools for inter-agent communication:

| Tool | Description |
|------|-------------|
| `read_range` | Read a range of lines from a source file |
| `get_classes_and_methods` | Extract class/method declarations |
| `extract_method` | Extract a specific method body |
| `extract_tests` | Extract test cases from a test file |
| `search_codebase` | Search for patterns/symbols |
| `find_similar_api_calls` | Find similar API call patterns |
| `write_fix` | Write a code fix to a source file |
| `run_tests` | Execute tests in the sandbox |

All tools enforce:
- JSON Schema validation on inputs
- 30-second timeout per invocation
- Structured error responses (`validation_error`, `execution_error`, `timeout_error`)
- At least 10 concurrent invocations without data corruption

#### External MCP Server

6 tools exposed to IDE clients:

| Tool | Description |
|------|-------------|
| `buggy_init` | Initialize debugger for a project |
| `buggy_analyze` | Parse file and return CST analysis |
| `buggy_investigate` | Run full investigation pipeline |
| `buggy_status` | Get investigation status |
| `buggy_query_graph` | Query the semantic graph |
| `buggy_list_functions` | List all functions in a file |

### Message Flow

```
IDE Client                MCP Server               Orchestrator              Agents
    │                         │                         │                       │
    │── tools/list ──────────▶│                         │                       │
    │◀── tool definitions ────│                         │                       │
    │                         │                         │                       │
    │── tools/call ──────────▶│                         │                       │
    │   (investigate)         │── startInvestigation ──▶│                       │
    │                         │                         │── parseFile ──────────▶│
    │                         │                         │◀── ParseResult ────────│
    │                         │                         │── investigate ────────▶│
    │                         │                         │◀── ProofCertificate ───│
    │                         │                         │── generatePatches ────▶│
    │                         │                         │◀── PatchCandidate[] ───│
    │                         │                         │── classify ───────────▶│
    │                         │                         │◀── ClassificationResult│
    │                         │◀── InvestigationReport──│                       │
    │◀── result ──────────────│                         │                       │
```

---

## Data Model

### SQLite Graph Database Schema

The semantic graph is stored in SQLite for fast local queries without external dependencies.

#### `nodes` Table

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT PRIMARY KEY | Unique node identifier |
| `type` | TEXT NOT NULL | Node type (function, class, variable, etc.) |
| `file_path` | TEXT NOT NULL | Source file containing this node |
| `start_byte` | INTEGER NOT NULL | Start byte offset in file |
| `end_byte` | INTEGER NOT NULL | End byte offset in file |
| `start_line` | INTEGER NOT NULL | Start line number (0-indexed) |
| `start_column` | INTEGER NOT NULL | Start column (0-indexed) |
| `end_line` | INTEGER NOT NULL | End line number |
| `end_column` | INTEGER NOT NULL | End column |
| `node_kind` | TEXT | Specific kind within type (e.g., arrow_function) |
| `text_content` | TEXT | Source text of the node |
| `is_error` | INTEGER NOT NULL | Whether this is an error node (0/1) |
| `metadata` | TEXT | JSON metadata blob |
| `created_at` | TEXT NOT NULL | ISO 8601 timestamp |

#### `edges` Table

| Column | Type | Description |
|--------|------|-------------|
| `source_id` | TEXT NOT NULL | Source node ID (FK → nodes) |
| `target_id` | TEXT NOT NULL | Target node ID (FK → nodes) |
| `relationship` | TEXT NOT NULL | Edge type (calls, imports, extends, etc.) |
| `metadata` | TEXT | JSON metadata blob |
| `created_at` | TEXT NOT NULL | ISO 8601 timestamp |

#### Indexes

- `idx_nodes_file_path` on `nodes(file_path)`
- `idx_edges_source` on `edges(source_id)`
- `idx_edges_target` on `edges(target_id)`
- `idx_edges_relationship` on `edges(relationship)`

#### Query Performance

All queries targeting <1000 nodes complete within 50ms. Path finding uses recursive CTEs with a depth limit of 50.

---

## Investigation Pipeline

### Step-by-Step Flow

```
Input: InvestigationTarget { function_id, file_path, specification }
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────┐
│ PHASE 1: PARSING                                             │
│                                                              │
│ 1. Read source file                                         │
│ 2. Tree-sitter parse → CST (fault-tolerant)                │
│ 3. Resolve symbols via LSP (5s timeout per symbol)          │
│ 4. Build call graph                                         │
│ 5. Store graph in SQLite                                    │
│                                                              │
│ Output: ParseResult, populated graph database               │
│ Constraint: Graph available to next phase within 5s         │
└─────────────────────────────────────────┬───────────────────┘
                                          │
                                          ▼
┌─────────────────────────────────────────────────────────────┐
│ PHASE 2: PROVING                                             │
│                                                              │
│ 1. Compute backward slice from target function              │
│ 2. Identify divergent variables                             │
│ 3. Run probe loop (iterative spec refinement)               │
│ 4. Run SA-Fuzz (specification-aware fuzzing)                │
│ 5. Construct proof-of-failure certificate                   │
│                                                              │
│ Output: ProofOfFailureCertificate (or unconfirmed)          │
│ If unconfirmed → pipeline terminates (status: 'unconfirmed')│
└─────────────────────────────────────────┬───────────────────┘
                                          │ (if certified)
                                          ▼
┌─────────────────────────────────────────────────────────────┐
│ PHASE 3: REPAIR                                              │
│                                                              │
│ 1. Extract defect context from proof certificate            │
│ 2. Generate candidate patches (AST edit operations)         │
│ 3. Cap at 20 patches per investigation                      │
│                                                              │
│ Output: PatchCandidate[] (max 20)                           │
└─────────────────────────────────────────┬───────────────────┘
                                          │
                                          ▼
┌─────────────────────────────────────────────────────────────┐
│ PHASE 4: CLASSIFICATION                                      │
│                                                              │
│ For each patch:                                             │
│   1. Compute AST difference vector (66 dimensions)          │
│   2. Compute semantic feature vector                        │
│   3. Calculate overfitting probability                      │
│   4. Approve (below threshold) or Reject (above threshold)  │
│                                                              │
│ Output: ClassifiedPatch[] (approved) + RejectedPatch[]      │
└─────────────────────────────────────────┬───────────────────┘
                                          │
                                          ▼
┌─────────────────────────────────────────────────────────────┐
│ FINAL REPORT                                                 │
│                                                              │
│ InvestigationReport {                                       │
│   status: confirmed_and_repaired | confirmed_no_repair      │
│           | unconfirmed | halted                            │
│   proof: ProofOfFailureCertificate                          │
│   approved_patches: ClassifiedPatch[]                       │
│   rejected_patches: RejectedPatch[]                         │
│   timeline: PhaseTimestamp[]                                │
│   intermediate_results: IntermediateResults                 │
│ }                                                           │
└─────────────────────────────────────────────────────────────┘
```

### Data Transformations

| Phase Boundary | Input Type | Output Type |
|----------------|-----------|-------------|
| Client → Orchestrator | `InvestigationTarget` | — |
| Parsing → Proving | `ParseResult` + Graph DB | `ProofOfFailureCertificate` |
| Proving → Repair | `ProofOfFailureCertificate` + `InvestigationTarget` | `PatchCandidate[]` |
| Repair → Classification | `PatchCandidate` + original `CstNode` | `ClassificationResult` |
| Orchestrator → Client | — | `InvestigationReport` |

---

## Proof-of-Failure Certificates

A `ProofOfFailureCertificate` is the core artifact produced by the Bug Proving Agent. It provides mathematical evidence that a specific bug exists.

### Structure

```typescript
interface ProofOfFailureCertificate {
  function_id: string;          // Target function
  failure_class: string;        // Category of failure (null_deref, overflow, etc.)
  admissibility: boolean;       // Are preconditions satisfiable?
  soundness: boolean;           // Does the output violate a postcondition?
  reproducibility: boolean;     // Does the failure reproduce deterministically?
  triggering_input: unknown;    // Concrete input that triggers the bug
  execution_trace: string[];    // Steps leading to failure
  violated_postcondition: string; // Which postcondition was violated
}
```

### Mathematical Properties

#### 1. Admissibility

**Definition**: The conjunction of all preconditions is satisfiable — there exists at least one concrete program state that satisfies them.

**Formally**: ∃σ . σ ⊨ Pre₁ ∧ Pre₂ ∧ ... ∧ Preₙ

**Purpose**: Prevents the system from "proving" bugs based on impossible states. If the preconditions are contradictory (e.g., `x > 5 ∧ x < 3`), no bug can actually be triggered.

#### 2. Soundness

**Definition**: Given a state satisfying the preconditions, executing the function necessarily violates at least one postcondition.

**Formally**: ∀σ . (σ ⊨ Pre) → ¬(exec(f, σ) ⊨ Post)

**Purpose**: Ensures the proof is logically valid. The bug isn't a fluke of one particular input — it follows from the function's logic applied to any valid precondition-satisfying state.

#### 3. Reproducibility

**Definition**: The failure reproduces deterministically. Re-executing the function on the same triggering input reproduces the violation (in at least 2 of 3 re-runs), ruling out flakes, timing artifacts, and non-deterministic behavior.

**Formally**: exec(f, σ) violates Post on repeated executions, not just once.

**Purpose**: Ensures the certified failure is a stable property of the code, not a transient fluke.

> **Formal vs. live third pillar.** The live `BugProvingAgent` (which fuzzes inputs) verifies **Reproducibility** as above. The formal `ProofVerifier` module instead verifies **Feasibility** — that a spec-satisfying output exists in a declared output domain (∃o′ . post(i, o′)) — proving the specification is achievable and the observed violation is a genuine code failure rather than an impossible spec. The live agent uses Reproducibility because it has no enumerated output domain to search.

---

## Patch Classification

### The 66-Dimensional Feature Vector

The Classifier Agent computes a feature vector capturing structural and semantic differences between the original code and a candidate patch.

### Feature Categories

#### AST Structural Features (Dimensions 1–22)

| # | Feature | Description |
|---|---------|-------------|
| 1–4 | Node count changes | Added/removed/modified/unchanged node counts |
| 5–8 | Depth changes | Max depth delta, average depth delta, depth variance |
| 9–12 | Branching changes | If/else additions, loop modifications, switch cases |
| 13–16 | Expression complexity | Operator count changes, nesting depth, ternary usage |
| 17–20 | Declaration changes | Variable additions, type annotation changes |
| 21–22 | Scope changes | Scope depth modifications, closure introductions |

#### Semantic Features (Dimensions 23–44)

| # | Feature | Description |
|---|---------|-------------|
| 23–28 | Control flow | Path additions, path removals, reachability changes |
| 29–34 | Data flow | New definitions, killed definitions, use-def chain changes |
| 35–38 | Type changes | Type narrowing, type widening, cast introductions |
| 39–42 | Effect changes | Side effect additions, purity changes |
| 43–44 | Exception flow | Try/catch additions, throw modifications |

#### Overfitting Indicators (Dimensions 45–66)

| # | Feature | Description |
|---|---------|-------------|
| 45–50 | Literal sensitivity | Hard-coded values matching test inputs |
| 51–54 | Guard specificity | Conditions that match only known failure triggers |
| 55–58 | Coverage narrowing | Code paths that become unreachable |
| 59–62 | Input dependence | Patches that branch on specific input shapes |
| 63–66 | Generalization score | Cross-validation against specification |

### Classification Decision

```
overfitting_probability = sigmoid(W · feature_vector + b)

if overfitting_probability < threshold:
    APPROVE patch
else:
    REJECT patch (with top contributing properties)
```

Default threshold: 0.5. Configurable per project.

---

## Sandbox Isolation

### Firecracker microVM Architecture

```
┌─────────────────────────────────────────────────┐
│                  Host System                      │
│                                                  │
│  ┌────────────────────────────────────────────┐ │
│  │           Snapshot Pool                     │ │
│  │  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐     │ │
│  │  │ Snap │ │ Snap │ │ Snap │ │ Snap │     │ │
│  │  │  #1  │ │  #2  │ │  #3  │ │  #4  │     │ │
│  │  └──┬───┘ └──┬───┘ └──┬───┘ └──┬───┘     │ │
│  └─────┼────────┼────────┼────────┼──────────┘ │
│         │        │        │        │            │
│         ▼        ▼        ▼        ▼            │
│  ┌──────────────────────────────────────────┐   │
│  │         Circuit Breaker                   │   │
│  │  • Memory limit enforcement              │   │
│  │  • CPU time accounting                   │   │
│  │  • Network egress policy                 │   │
│  │  • Timeout termination                   │   │
│  └──────────────────────────────────────────┘   │
│         │        │        │        │            │
│         ▼        ▼        ▼        ▼            │
│  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐          │
│  │ μVM  │ │ μVM  │ │ μVM  │ │ μVM  │          │
│  │  #1  │ │  #2  │ │  #3  │ │  #4  │          │
│  │      │ │      │ │      │ │      │          │
│  │ exec │ │ exec │ │ exec │ │ exec │          │
│  └──────┘ └──────┘ └──────┘ └──────┘          │
│                                                  │
└─────────────────────────────────────────────────┘
```

### OAP (Origin-Aware Policy) Passports

Every execution request includes an OAP passport that specifies:

```typescript
interface OapPassport {
  execution_id: string;       // Unique ID for this execution
  origin_agent: string;       // Which agent requested execution
  code_hash: string;          // SHA-256 of the code being executed
  resource_limits: {
    memory_mb: number;        // Max memory allocation
    cpu_seconds: number;      // Max CPU time
    wall_time_seconds: number;// Max wall-clock time
    disk_io_mb: number;       // Max disk I/O
  };
  network_policy: 'deny' | 'allow_host_only';
  allowed_syscalls: string[]; // Syscall whitelist (when applicable)
  created_at: string;         // ISO 8601 timestamp
  expires_at: string;         // Passport expiry
}
```

### Concurrency Model

- Maximum 4 concurrent sandbox executions
- Requests beyond 4 are queued (FIFO)
- Retry logic: 3 attempts with 2-second intervals if sandbox unavailable
- `SandboxUnavailableError` thrown after all retries exhausted

---

## Extensibility

### Plug System

The debugger supports custom plugs for extending or replacing built-in behavior.

#### Plug Interfaces

```typescript
interface ParsingPlug {
  name: string;
  parse(source: string, filePath: string): Promise<ParseResult>;
  supportedLanguages: string[];
}

interface OraclePlug {
  name: string;
  check(result: ExecutionResult): ValidationResult;
  oracleType: string;
}

interface RepairPlug {
  name: string;
  generatePatches(
    proof: ProofOfFailureCertificate,
    target: InvestigationTarget
  ): Promise<PatchCandidate[]>;
}

interface SandboxExecutorPlug {
  name: string;
  execute(request: ExecutionRequest): Promise<ExecutionResult>;
  isAvailable(): Promise<boolean>;
}
```

#### Creating a Custom Plug

1. Implement one of the plug interfaces
2. Register in `.debugger.yaml`:

```yaml
plugs:
  parsing: ./plugs/my-custom-parser
  oracles:
    - ./plugs/memory-oracle
    - ./plugs/concurrency-oracle
  repair: ./plugs/my-repair-strategy
  sandbox_executor: ./plugs/docker-sandbox
```

3. The plug registry validates and loads plugs at startup

#### Plug Registry

```typescript
class PlugRegistry {
  register(plug: ParsingPlug | OraclePlug | RepairPlug | SandboxExecutorPlug): void;
  getParsingPlug(): ParsingPlug | undefined;
  getOraclePlugs(): OraclePlug[];
  getRepairPlug(): RepairPlug | undefined;
  getSandboxExecutorPlug(): SandboxExecutorPlug | undefined;
}
```

---

## MCP Server Protocol

### Tool Schemas with Examples

#### `buggy_init`

Initialize the debugger for a project.

**Input**:
```json
{
  "project_path": "/home/user/my-project"
}
```

**Output**:
```json
{
  "status": "initialized",
  "project_path": "/home/user/my-project",
  "language": "typescript",
  "config_path": "/home/user/my-project/.debugger.yaml"
}
```

#### `buggy_analyze`

Parse a file and return CST analysis.

**Input**:
```json
{
  "file_path": "src/payments.ts",
  "project_path": "/home/user/my-project"
}
```

**Output**:
```json
{
  "file_path": "/home/user/my-project/src/payments.ts",
  "duration_ms": 0.45,
  "total_nodes": 847,
  "syntax_errors": [],
  "functions": [
    {
      "name": "processPayment",
      "line": 15,
      "type": "function_declaration",
      "start_byte": 312,
      "end_byte": 892
    },
    {
      "name": "validateAmount",
      "line": 42,
      "type": "arrow_function",
      "start_byte": 1024,
      "end_byte": 1198
    }
  ],
  "has_errors": false
}
```

#### `buggy_investigate`

Run full investigation pipeline.

**Input**:
```json
{
  "function_id": "processPayment",
  "file_path": "src/payments.ts",
  "project_path": "/home/user/my-project",
  "preconditions": ["amount > 0", "account.balance >= amount"],
  "postconditions": ["account.balance == old(balance) - amount"]
}
```

**Output**:
```json
{
  "investigation_id": "inv_1700000000000_abc1234",
  "status": "confirmed_and_repaired",
  "proof": {
    "function_id": "processPayment",
    "failure_class": "arithmetic_underflow",
    "admissibility": true,
    "soundness": true,
    "reproducibility": true
  },
  "approved_patches": 2,
  "rejected_patches": 5,
  "timeline": [
    { "phase": "parsing", "agent": "Parser_Agent", "started_at": "...", "completed_at": "..." },
    { "phase": "proving", "agent": "Bug_Proving_Agent", "started_at": "...", "completed_at": "..." },
    { "phase": "repair", "agent": "Repair_Agent", "started_at": "...", "completed_at": "..." },
    { "phase": "classification", "agent": "Classifier_Agent", "started_at": "...", "completed_at": "..." }
  ],
  "intermediate_results": {
    "cst_nodes_parsed": 847,
    "patches_generated": 7,
    "patches_approved": 2
  }
}
```

#### `buggy_status`

Get investigation status.

**Input**:
```json
{
  "investigation_id": "inv_1700000000000_abc1234",
  "project_path": "/home/user/my-project"
}
```

**Output**:
```json
{
  "id": "inv_1700000000000_abc1234",
  "phase": "classification",
  "current_agent": "Classifier_Agent",
  "started_at": "2024-01-15T10:30:00.000Z",
  "elapsed_ms": 4523,
  "intermediate_results": {
    "cst_nodes_parsed": 847,
    "patches_generated": 7
  }
}
```

#### `buggy_query_graph`

Query the semantic graph.

**Input (callees)**:
```json
{
  "query_type": "callees",
  "node_id": "processPayment",
  "project_path": "/home/user/my-project"
}
```

**Output**:
```json
{
  "query_type": "callees",
  "node_id": "processPayment",
  "callees": [
    { "id": "validateAmount", "type": "function", "file_path": "src/payments.ts", "start_line": 42 },
    { "id": "debitAccount", "type": "function", "file_path": "src/accounts.ts", "start_line": 18 }
  ],
  "edge_count": 2
}
```

#### `buggy_list_functions`

List all functions in a file.

**Input**:
```json
{
  "file_path": "src/payments.ts",
  "project_path": "/home/user/my-project"
}
```

**Output**:
```json
{
  "file_path": "/home/user/my-project/src/payments.ts",
  "function_count": 4,
  "functions": [
    { "name": "processPayment", "line": 15, "type": "function_declaration", "start_byte": 312, "end_byte": 892 },
    { "name": "validateAmount", "line": 42, "type": "arrow_function", "start_byte": 1024, "end_byte": 1198 },
    { "name": "refund", "line": 58, "type": "function_declaration", "start_byte": 1200, "end_byte": 1580 },
    { "name": "formatReceipt", "line": 82, "type": "arrow_function", "start_byte": 1600, "end_byte": 1850 }
  ]
}
```

---

## Performance Characteristics

### Parsing

| Metric | Target | Measured |
|--------|--------|----------|
| File parse (< 1000 lines) | < 1ms | ~0.3ms |
| File parse (10,000 lines) | < 10ms | ~5ms |
| File parse (100,000 lines) | < 100ms | ~45ms |
| Incremental re-parse (local edit) | < 0.5ms | ~0.1ms |
| Symbol resolution (per symbol) | < 5s timeout | ~200ms avg |

### Investigation Throughput

| Metric | Value |
|--------|-------|
| Full pipeline (simple function) | 2–10 seconds |
| Full pipeline (complex function, 50+ nodes) | 10–60 seconds |
| Patch generation | 1–5 seconds per patch |
| Classification | < 100ms per patch |
| Sandbox execution | 1–30 seconds (configurable timeout) |

### Resource Usage

| Resource | Constraint |
|----------|-----------|
| Memory (CLI mode) | 128–512 MB typical |
| Memory (with sandbox) | 512 MB–8 GB (configurable per microVM) |
| Disk (graph database) | 1–50 MB per project |
| CPU | Single-threaded agents, up to 4 concurrent sandbox workers |
| Network | Egress denied by default in sandbox |

### Graph Query Performance

| Query Type | Target | Constraint |
|-----------|--------|------------|
| Node lookup | < 1ms | Single indexed lookup |
| Edge traversal | < 5ms | Indexed on source_id + relationship |
| Subgraph extraction | < 50ms | For graphs < 1000 nodes |
| Path finding (recursive CTE) | < 50ms | Depth limit: 50 |

---

## Security Model

### Threat Model

| Threat | Mitigation |
|--------|-----------|
| Malicious code execution | Firecracker microVM isolation, no host access |
| Network exfiltration | Egress policy: deny by default |
| Resource exhaustion | Memory limits, CPU time limits, circuit breaker |
| Privilege escalation | microVM runs with minimal capabilities, no root |
| Data leakage between investigations | Fresh microVM per execution, no shared state |
| Supply chain attacks (malicious patches) | Patches classified before approval, never auto-applied |
| LSP server compromise | 5-second timeout, symbol resolution is non-fatal |
| Config injection | Zod schema validation, strict typing, no eval |

### Isolation Guarantees

1. **Process isolation**: Each sandbox execution runs in a separate Firecracker microVM
2. **Memory isolation**: Hardware-enforced memory boundaries (not just cgroups)
3. **Network isolation**: No network access by default; `allow_host_only` for controlled scenarios
4. **Filesystem isolation**: Copy-on-write rootfs, no access to host filesystem
5. **Temporal isolation**: microVMs destroyed after execution, no persistent state

### What the System Cannot Do

- Cannot guarantee patch correctness beyond the specified pre/postconditions
- Cannot detect bugs that require environmental state (network, filesystem, time)
- Cannot replace human review for security-critical changes
- Cannot prove the absence of bugs (only the presence of specific bugs)
- Cannot handle non-deterministic bugs reliably (requires determinism oracle)

---

## Deployment Options

### 1. Local CLI

```bash
npm install -g buggy
buggy init
buggy investigate --function processPayment --file src/payments.ts
```

**Best for**: Individual developers, one-off investigations, debugging sessions.

### 2. MCP Server (AI IDE Integration)

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

**Best for**: AI-assisted development workflows, Cursor/Windsurf/Copilot integration.

### 3. CI/CD Integration

```yaml
# GitHub Actions example
- name: Buggy Debug
  run: |
    npx buggy investigate \
      --function ${{ inputs.function }} \
      --file ${{ inputs.file }} \
      --output report.json

- name: Check proof status
  run: |
    status=$(jq -r '.status' report.json)
    if [ "$status" = "confirmed_and_repaired" ]; then
      echo "Bug confirmed and repaired"
    fi
```

**Best for**: PR validation, pre-merge verification, automated bug detection.

### 4. Cloud-Hosted (Enterprise)

Self-hosted deployment with:
- Centralized investigation queue
- Shared graph database across team
- Audit trail and compliance reporting
- SSO/SAML authentication
- Multi-tenant isolation

**Best for**: Large engineering organizations, compliance-heavy environments.

---

## API Reference

### `ProofDebugger` Class

The main entry point for programmatic usage.

#### Constructor

```typescript
new ProofDebugger(options: ProofDebuggerOptions)
```

**`ProofDebuggerOptions`**:

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `projectRoot` | `string` | Yes | Absolute path to the target project root |
| `language` | `string` | No | Override language detection |
| `sandbox` | `object` | No | Override sandbox config |
| `sandbox.memory_limit_mb` | `number` | No | Memory limit (64–8192) |
| `sandbox.timeout_seconds` | `number` | No | Execution timeout (1–300) |
| `sandbox.egress_policy` | `'deny' \| 'allow_host_only'` | No | Network policy |
| `probe` | `object` | No | Override probe config |
| `probe.search_budget` | `number` | No | Max proof search iterations |
| `probe.max_refinement_iterations` | `number` | No | Max spec refinement rounds |
| `configPath` | `string` | No | Custom path to .debugger.yaml |
| `dbPath` | `string` | No | Custom path for SQLite database |

#### Methods

##### `initialize(): Promise<void>`

Boot all subsystems (config, database, parser, orchestrator). Must be called before any other method.

**Throws**: `ConfigError` if `.debugger.yaml` is missing or invalid.

##### `parse(filePath: string): Promise<ParseResult>`

Parse a file into a fault-tolerant CST.

**Parameters**:
- `filePath` — Absolute or relative path to the source file

**Returns**: `ParseResult` with CST tree, syntax errors, duration, and file path.

##### `investigate(options: InvestigateOptions): Promise<InvestigationReport>`

Run the full investigation pipeline on a function.

**Parameters**:
- `options.functionId` — Name/identifier of the target function
- `options.filePath` — Path to the file containing the function
- `options.specification` — Optional pre/postconditions and type info

**Returns**: `InvestigationReport` with status, proof, patches, timeline.

##### `getStatus(id: string): InvestigationStatus | undefined`

Get the current status of a running investigation.

**Parameters**:
- `id` — Investigation identifier (from `InvestigationReport.id`)

**Returns**: Current status or `undefined` if not found.

##### `halt(id: string): void`

Halt a running investigation, preserving intermediate results.

##### `queryCallees(functionId: string): Promise<QueryCalleesResult>`

Query the semantic graph for callees of a function.

**Returns**: `{ callees: NodeRecord[], edges: EdgeRecord[] }`

##### `queryNode(nodeId: string): NodeRecord | null`

Look up a specific node in the semantic graph.

##### `queryFileGraph(filePath: string): { nodes: NodeRecord[]; edges: EdgeRecord[] }`

Extract the full subgraph for a file.

##### `getConfig(): DebuggerConfig`

Get the active configuration (read-only copy).

##### `shutdown(): Promise<void>`

Gracefully close database connections and LSP clients. Must be called when done.

---

### Key Types

```typescript
// Investigation result
interface InvestigationReport {
  id: string;
  status: 'confirmed_and_repaired' | 'confirmed_no_repair' | 'unconfirmed' | 'halted';
  proof?: ProofOfFailureCertificate;
  approved_patches: ClassifiedPatch[];
  rejected_patches: RejectedPatch[];
  intermediate_results: IntermediateResults;
  timeline: PhaseTimestamp[];
}

// Parse result
interface ParseResult {
  cst: CstNode;
  errors: SyntaxError[];
  duration_ms: number;
  file_path: string;
}

// CST node
interface CstNode {
  id: string;
  type: string;
  start_byte: number;
  end_byte: number;
  start_position: Position;
  end_position: Position;
  children: CstNode[];
  is_error: boolean;
  text?: string;
}

// Graph node
interface NodeRecord {
  id: string;
  type: string;
  file_path: string;
  start_byte: number;
  end_byte: number;
  start_line: number;
  start_column: number;
  end_line: number;
  end_column: number;
  node_kind?: string;
  text_content?: string;
  is_error: boolean;
  metadata?: string;
  created_at: string;
}

// Graph edge
interface EdgeRecord {
  source_id: string;
  target_id: string;
  relationship: string;
  metadata?: string;
  created_at: string;
}

// Configuration
interface DebuggerConfig {
  language: string;
  parser: ParserConfig;
  lsp: LspConfig;
  sandbox: SandboxConfig;
  oracles: OracleConfig;
  probe: ProbeConfig;
  plugs?: PlugConfig;
}
```


---

## Kiro Integration Architecture

Buggy integrates with Kiro through two mechanisms: **hooks** (event-driven automation) and **steering files** (persistent behavioral instructions). Together, they make Buggy work automatically inside Kiro — your team doesn't need to run commands manually.

### Hook System Design

Hooks are event listeners that trigger agent actions when specific IDE events occur. Each hook definition specifies an event type, optional file patterns, and an agent prompt.

#### Event Types Used

| Hook | Event Type | Trigger Condition |
|------|-----------|-------------------|
| `buggy-on-save` | `fileEdited` | Any source file is saved (filtered by `filePatterns`) |
| `buggy-post-write` | `postToolUse` | After Kiro's agent uses a write tool (file creation/modification) |
| `buggy-pre-task` | `preTaskExecution` | Before a spec task begins execution |
| `buggy-auto-fix` | `agentStop` | After the agent completes its current work |
| `buggy-deep-scan` | `userTriggered` | Manual activation by the developer |
| `buggy-spec-evolution` | `postTaskExecution` | After a spec task completes successfully |

#### Hook Data Flow

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────────┐
│  IDE EVENT      │────▶│  HOOK MATCHER    │────▶│  AGENT PROMPT       │
│                 │     │                  │     │                     │
│ fileEdited      │     │ Check event type │     │ outputPrompt text   │
│ postToolUse     │     │ Check filePatterns│     │ injected into agent │
│ agentStop       │     │ Check toolTypes  │     │ context             │
│ etc.            │     │                  │     │                     │
└─────────────────┘     └──────────────────┘     └──────────┬──────────┘
                                                             │
                                                             ▼
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────────┐
│  RESULTS        │◀────│  MCP TOOL CALL   │◀────│  KIRO LLM AGENT    │
│                 │     │                  │     │                     │
│ Proof certs     │     │ buggy_analyze    │     │ Interprets prompt   │
│ Approved patches│     │ buggy_investigate│     │ Decides which tools │
│ Bug reports     │     │ buggy_list_funcs │     │ to call and how     │
│                 │     │                  │     │                     │
└─────────────────┘     └──────────────────┘     └─────────────────────┘
```

#### Hook Prompt Design

Each hook's `outputPrompt` contains structured instructions that tell Kiro's LLM what to do. The prompts reference Buggy's MCP tools by name:

```
// Example: buggy-on-save outputPrompt
"Analyze the saved file using buggy_analyze. If syntax errors are found, report them.
 If the file contains functions with risky patterns (division, array indexing, unbounded
 math), run buggy_investigate on those functions with appropriate specifications.
 Report any proven bugs with their proof certificates."
```

The LLM acts as the intelligence layer — it interprets results, decides what to investigate further, and formats findings for the developer.

### Steering File Inclusion Modes

Steering files use three inclusion strategies:

#### `auto` — Always Active

```yaml
---
inclusion: auto
---
```

These files are loaded into every agent conversation. They provide background instructions that shape all interactions:

- `buggy-debugging.md` — Core workflow (how to use MCP tools)
- `buggy-cross-file-impact.md` — Always check callers before modifying functions
- `buggy-bug-trends.md` — Maintain a running bug report
- `buggy-onboarding.md` — Warn about historically risky files

#### `fileMatch` — Context-Activated

```yaml
---
inclusion: fileMatch
fileMatch: ["**/*.test.ts", "**/*.spec.ts"]
---
```

These activate only when the developer is working with matching files:

- `buggy-spec-from-tests.md` — Infer specifications from test assertions

#### Manual — On-Demand

```yaml
---
inclusion: manual
---
```

These are activated explicitly by the developer or by other steering files referencing them:

- `buggy-pr-review.md` — Proof-backed PR review
- `buggy-git-diff-specs.md` — Infer specs from git context
- `buggy-type-narrowing.md` — Suggest TypeScript branded types

### Self-Healing Loop Architecture

The `buggy-auto-fix` hook implements a self-healing feedback cycle:

```
┌─────────────────────────────────────────────────────────────────┐
│                    SELF-HEALING LOOP (max 3 iterations)          │
│                                                                  │
│  ┌───────────┐     ┌───────────────┐     ┌──────────────────┐  │
│  │  AGENT    │────▶│  ANALYZE      │────▶│  BUGS FOUND?     │  │
│  │  STOPS    │     │  Modified     │     │                  │  │
│  │           │     │  Files        │     │  Yes → Fix them  │  │
│  └───────────┘     └───────────────┘     │  No  → Done      │  │
│                                           └────────┬─────────┘  │
│                                                    │             │
│       ┌────────────────────────────────────────────┘             │
│       │                                                          │
│       ▼                                                          │
│  ┌───────────────┐     ┌───────────────┐     ┌──────────────┐  │
│  │  APPLY FIX    │────▶│  RE-ANALYZE   │────▶│  ITERATION   │  │
│  │               │     │  (loop back)  │     │  < 3?        │  │
│  │  Agent writes │     │               │     │              │  │
│  │  the patch    │     │  Check for    │     │  Yes → Loop  │  │
│  │               │     │  new issues   │     │  No  → Stop  │  │
│  └───────────────┘     └───────────────┘     └──────────────┘  │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

**Why max 3 iterations?** Patches can introduce cascading issues (e.g., fixing a null check reveals an unreachable code path). Three iterations catches most cascades without risking infinite loops. The iteration count is tracked via the hook's internal state.

**Termination conditions:**
1. No bugs found after analysis → success, loop ends
2. Three iterations completed → loop ends, remaining issues reported to developer
3. Analysis returns `unconfirmed` for all functions → loop ends (no provable bugs)

### Kiro's LLM as Intelligence Layer

Kiro's LLM interprets Buggy's MCP tool outputs and makes decisions that a static tool chain cannot:

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        INTELLIGENCE LAYER                                │
│                                                                          │
│  Buggy MCP Tools (data)          Kiro LLM (decisions)                   │
│  ─────────────────────           ────────────────────                   │
│  buggy_analyze → syntax errors   "This error is in dead code, skip"     │
│  buggy_list_functions → fn list  "processPayment looks risky, check it" │
│  buggy_investigate → proof cert  "Bug proven, apply the 8% patch"       │
│  buggy_query_graph → call graph  "3 callers affected, warn developer"   │
│                                                                          │
│  The LLM provides:                                                       │
│  • Specification inference (what should this function guarantee?)        │
│  • Risk prioritization (which functions to investigate first)            │
│  • Result interpretation (explain proofs in plain English)               │
│  • Fix application (apply patches using str_replace)                    │
│  • Cross-file reasoning (trace impact through call graph)               │
└─────────────────────────────────────────────────────────────────────────┘
```

### Complete Data Flow

End-to-end flow from a developer's file edit to an applied fix:

```
Developer saves file
        │
        ▼
[1] fileEdited event fires
        │
        ▼
[2] buggy-on-save hook matches (filePatterns: **/*.ts)
        │
        ▼
[3] Hook's outputPrompt injected into Kiro agent context
        │
        ▼
[4] Kiro LLM reads steering file (buggy-debugging.md) for workflow
        │
        ▼
[5] Agent calls buggy_analyze(file_path) via MCP
        │
        ▼
[6] Buggy parses file, returns function list + syntax errors
        │
        ▼
[7] Agent identifies risky functions, infers specifications
        │
        ▼
[8] Agent calls buggy_investigate(function_id, specs) via MCP
        │
        ▼
[9] Buggy runs full pipeline: Parse → Prove → Repair → Classify
        │
        ▼
[10] Investigation report returned (proof + approved patches)
        │
        ▼
[11] Agent explains bug to developer, applies approved patch
        │
        ▼
[12] buggy-post-write hook fires (verifies the applied patch)
        │
        ▼
[13] If issues remain, buggy-auto-fix loop engages (max 3 iterations)
```

### File Structure

The Kiro integration lives entirely in the `.kiro/` directory:

```
.kiro/
├── hooks/
│   ├── buggy-on-save.json          # fileEdited → analyze
│   ├── buggy-post-write.json       # postToolUse → verify
│   ├── buggy-pre-task.json         # preTaskExecution → scan
│   ├── buggy-auto-fix.json         # agentStop → self-heal
│   ├── buggy-deep-scan.json        # userTriggered → full scan
│   └── buggy-spec-evolution.json   # postTaskExecution → verify
├── steering/
│   ├── buggy-debugging.md          # Core workflow (auto)
│   ├── buggy-cross-file-impact.md  # Caller checking (auto)
│   ├── buggy-bug-trends.md         # Bug tracking (auto)
│   ├── buggy-onboarding.md         # Risky file warnings (auto)
│   ├── buggy-spec-from-tests.md    # Test spec inference (fileMatch)
│   ├── buggy-pr-review.md          # PR review (manual)
│   ├── buggy-git-diff-specs.md     # Git diff specs (manual)
│   └── buggy-type-narrowing.md     # Type suggestions (manual)
└── settings/
    └── mcp.json                    # Buggy MCP server configuration
```
