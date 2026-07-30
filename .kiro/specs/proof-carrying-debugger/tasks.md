# Implementation Plan: Proof-Carrying Program Repair and Debugging System

## Overview

This plan implements the multi-agent proof-carrying debugger as a TypeScript project with 5 agents communicating over MCP middleware, backed by a SQLite graph database, and executing untrusted code in Firecracker microVMs. Tasks are organized into phases: project scaffolding, core infrastructure, individual agent implementations, integration wiring, and final validation.

## Tasks

- [x] 1. Project scaffolding and core interfaces
  - [x] 1.1 Initialize project structure and configuration
    - Create directory structure: `src/`, `src/agents/`, `src/middleware/`, `src/database/`, `src/sandbox/`, `src/plugs/`, `src/config/`, `src/orchestrator/`, `src/types/`
    - Create test directory structure: `tests/properties/`, `tests/unit/`, `tests/integration/`
    - Initialize `package.json` with dependencies: `@modelcontextprotocol/sdk`, `tree-sitter`, `better-sqlite3`, `yaml`, `fast-check`, `vitest`, `zod`
    - Configure `tsconfig.json` with strict mode, ES2022 target, Node16 module resolution
    - Configure `vitest.config.ts` with test paths
    - _Requirements: 18.1, 20.1_

  - [x] 1.2 Define all core TypeScript interfaces and types
    - Create `src/types/config.ts` with `DebuggerConfig`, `ParserConfig`, `LspConfig`, `SandboxConfig`, `OracleConfig`, `ProbeConfig`, `PlugConfig`
    - Create `src/types/cst.ts` with `CstNode`, `ParseResult`, `TreeSitterEdit`, `SyntaxError`, `Position`
    - Create `src/types/graph.ts` with `SymbolResolution`, `SourceLocation`, `CallGraphResult`
    - Create `src/types/mcp.ts` with `McpToolDefinition`, `McpToolResult`, `McpError`, `McpToolName`
    - Create `src/types/proof.ts` with `ProofOfFailureCertificate`, `ProofCandidate`, `ProofVerificationResult`
    - Create `src/types/repair.ts` with `PatchCandidate`, `DefectContext`, `AstEditOperation`, `CodeRange`
    - Create `src/types/classifier.ts` with `AstDifferenceVector`, `SemanticFeatureVector`, `ClassificationResult`
    - Create `src/types/sandbox.ts` with `ExecutionRequest`, `ExecutionResult`, `ResourceLimits`, `OapPassport`, `OracleViolation`, `OracleType`
    - Create `src/types/orchestrator.ts` with `InvestigationReport`, `InvestigationStatus`, `PhaseTimestamp`, `IntermediateResults`
    - Create `src/types/plugs.ts` with `ParsingPlug`, `OraclePlug`, `RepairPlug`, `SandboxExecutorPlug`, `PlugRegistry`, `ValidationResult`
    - Create `src/types/slicing.ts` with `BackwardSlice`, `SliceStatement`, `CapturedVariable`, `DefectLine`, `DivergentVariable`
    - Create `src/types/fuzzing.ts` with `Mutation`, `FuzzResult`, `FuzzViolation`
    - Create `src/types/spectune.ts` with `Postcondition`, `SpecTuneResult`, `AlphaConsistency`
    - Create `src/types/probe.ts` with `CandidateProperty`, `ProbeResult`, `ProbeRefinement`
    - Create `src/types/index.ts` barrel export
    - _Requirements: 1.1–1.5, 2.1–2.5, 3.1–3.5, 4.1–4.5, 5.1–5.5, 6.1–6.6, 7.1–7.6, 8.1–8.4, 9.1–9.6, 10.1–10.6, 11.1–11.6, 12.1–12.5, 13.1–13.5, 14.1–14.6, 15.1–15.7, 16.1–16.5, 17.1–17.6, 18.1–18.7, 19.1–19.6, 20.1–20.7, 21.1–21.8_

- [x] 2. Configuration loader
  - [x] 2.1 Implement YAML config loader with schema validation
    - Create `src/config/config-loader.ts`
    - Implement `loadConfig(projectRoot: string): DebuggerConfig` using `yaml` parser and `zod` schema validation
    - Validate type constraints: `memory_limit_mb` (64..8192), `timeout_seconds` (1..300), `timeout_threshold_seconds` (1..300), `determinism_check_count` (1..100)
    - Handle missing file (error with path), invalid YAML (error with line/column), invalid values (error with key/value/expected), unrecognized keys (warning + proceed), omitted optional keys (apply defaults + log)
    - Terminate startup on fatal errors (missing file, invalid YAML, invalid values)
    - _Requirements: 18.1, 18.2, 18.3, 18.4, 18.5, 18.6, 18.7_

  - [x]* 2.2 Write property test for configuration validation
    - **Property 29: Configuration Validation**
    - Generate random YAML content with valid/invalid syntax, type violations, unrecognized keys, and missing optional keys
    - Verify: invalid YAML → error with path/line/column; type violation → error with key/value/expected; unrecognized keys → warning + proceed; missing optionals → defaults applied
    - Test file: `tests/properties/config.property.test.ts`
    - **Validates: Requirements 18.4, 18.5, 18.6, 18.7**

  - [x]* 2.3 Write unit tests for config loader
    - Test file: `tests/unit/config-loader.test.ts`
    - Test cases: valid config loading, missing file error, invalid YAML with line/column, out-of-range values, unrecognized key warnings, default value application
    - _Requirements: 18.1–18.7_

- [x] 3. Checkpoint - Core infrastructure validated
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Graph Database layer
  - [x] 4.1 Implement SQLite database initialization and schema
    - Create `src/database/graph-db.ts`
    - Implement schema creation with all 11 tables: `nodes`, `edges`, `symbol_resolutions`, `behavioral_interpretations`, `diagnostic_assertions`, `spec_refinements`, `probe_iterations`, `proof_certificates`, `patches`, `oracle_violations`, plus indexes
    - Enable WAL mode for concurrent reads
    - Implement `initializeDatabase(dbPath: string): Database` function
    - _Requirements: 3.1, 3.2_

  - [x] 4.2 Implement graph write operations with referential integrity
    - Add to `src/database/graph-db.ts`
    - Implement `writeNode(node: NodeRecord): Promise<void>` with async batching (≤5ms latency addition)
    - Implement `writeEdge(edge: EdgeRecord): Promise<void>` with referential integrity check (reject dangling references)
    - Implement `writeSymbolResolution(resolution: SymbolResolutionRecord): Promise<void>`
    - Implement retry logic: 3 retries at 100ms intervals on failure, report via MCP on exhaustion
    - _Requirements: 3.1, 3.4, 3.5_

  - [x] 4.3 Implement graph query API
    - Create `src/database/graph-queries.ts`
    - Implement `lookupNode(id: string): NodeRecord | null`
    - Implement `traverseEdges(nodeId: string, relationship: string): EdgeRecord[]`
    - Implement `extractSubgraph(filePath: string): { nodes: NodeRecord[], edges: EdgeRecord[] }`
    - Implement `findPath(sourceId: string, targetId: string): NodeRecord[]` using recursive CTEs
    - All queries targeting <1000 nodes must complete within 50ms
    - _Requirements: 3.2, 3.3_

  - [x]* 4.4 Write property test for referential integrity enforcement
    - **Property 6: Referential Integrity Enforcement**
    - Generate random edge writes with mix of valid and invalid (non-existent) node IDs
    - Verify: writes with invalid source_id or target_id are rejected with error identifying missing node; DB state unchanged after rejection
    - Test file: `tests/properties/graph-db.property.test.ts`
    - **Validates: Requirements 3.4**

  - [x]* 4.5 Write property test for graph query correctness
    - **Property 7: Graph Query Correctness**
    - Generate random graph states and queries (node lookup, edge traversal, subgraph extraction, path query)
    - Verify: returned results exactly match query criteria (no false positives, no false negatives)
    - Test file: `tests/properties/graph-db.property.test.ts`
    - **Validates: Requirements 3.2**

  - [x]* 4.6 Write unit tests for graph database
    - Test file: `tests/unit/graph-queries.test.ts`
    - Test cases: WAL mode concurrent reads, referential integrity rejection, retry exhaustion reporting, 50ms query performance for <1000 nodes, recursive CTE path queries
    - _Requirements: 3.1–3.5_

- [x] 5. MCP Middleware
  - [x] 5.1 Implement MCP tool router with schema validation
    - Create `src/middleware/mcp-router.ts`
    - Implement `McpRouter` class using `@modelcontextprotocol/sdk`
    - Register 8 tools: `read_range`, `get_classes_and_methods`, `extract_method`, `extract_tests`, `search_codebase`, `find_similar_api_calls`, `write_fix`, `run_tests`
    - Implement JSON Schema validation on each tool request using tool's `inputSchema`
    - Implement 30-second timeout enforcement per tool invocation
    - Support at least 10 concurrent invocations without data corruption
    - Return structured `McpError` responses for validation failures, execution errors, and timeouts
    - _Requirements: 20.1, 20.2, 20.3, 20.4, 20.5, 20.6, 20.7_

  - [x]* 5.2 Write property test for MCP schema validation and error reporting
    - **Property 31: MCP Schema Validation and Error Reporting**
    - Generate random MCP tool requests with valid/invalid schemas
    - Verify: valid schema → proceeds to execution; invalid schema → rejected without execution + structured error with tool_name; execution failure → structured error with type/message/tool_name
    - Test file: `tests/properties/mcp.property.test.ts`
    - **Validates: Requirements 20.3, 20.4, 20.5**

  - [x]* 5.3 Write unit tests for MCP middleware
    - Test file: `tests/unit/mcp-middleware.test.ts` (mapped from integration concerns to unit scope)
    - Test cases: schema validation pass/fail for all 8 tools, 30-second timeout enforcement, concurrent invocation handling, structured error response shape
    - _Requirements: 20.1–20.7_

- [x] 6. Checkpoint - Infrastructure layers validated
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. Parser_Agent implementation
  - [x] 7.1 Implement Tree-sitter CST parsing with fault tolerance
    - Create `src/agents/parser-agent.ts`
    - Implement `parseFile(filePath: string): Promise<ParseResult>` using Tree-sitter Node.js binding
    - Handle files up to 100,000 lines with sub-millisecond target
    - Produce fault-tolerant CSTs: error nodes for invalid regions with byte offset and length
    - Preserve all whitespace, comments, and formatting in CST nodes
    - Report actual duration if exceeding 1ms threshold
    - _Requirements: 1.1, 1.2, 1.4, 1.5_

  - [x] 7.2 Implement incremental re-parsing
    - Add `parseIncremental(filePath: string, edit: TreeSitterEdit): Promise<ParseResult>` to Parser_Agent
    - Re-parse only the changed region using Tree-sitter's edit API
    - Ensure structural equivalence with full re-parse of edited file
    - _Requirements: 1.3_

  - [x] 7.3 Implement LSP symbol resolution
    - Add `resolveSymbols(filePath: string): Promise<SymbolResolutionResult>` to Parser_Agent
    - Query attached LSP instance for definition location, type, and enclosing scope per symbol
    - Store resolved symbols as typed edges in Graph_Database
    - Mark unresolved symbols (LSP failure or 5s timeout) in `symbol_resolutions` table with `resolved=false`
    - _Requirements: 2.1, 2.2, 2.3, 2.4_

  - [x] 7.4 Implement call graph construction
    - Add `buildCallGraph(): Promise<CallGraphResult>` to Parser_Agent
    - Aggregate all resolved function/method call edges from Graph_Database into a call graph
    - Store directed edges for every unique caller-callee pair; exclude unresolved references
    - _Requirements: 2.5_

  - [x]* 7.5 Write property test for CST round-trip preservation
    - **Property 1: CST Round-Trip Preservation**
    - Generate random valid TypeScript/JavaScript source files
    - Verify: reconstructing source from all CST leaf nodes (whitespace + comments included) produces byte-for-byte identical output
    - Test file: `tests/properties/parsing.property.test.ts`
    - **Validates: Requirements 1.1, 1.4**

  - [x]* 7.6 Write property test for fault-tolerant parsing with error nodes
    - **Property 2: Fault-Tolerant Parsing with Error Nodes**
    - Generate valid source files with random syntax error injection
    - Verify: (a) valid regions covered by non-error nodes with correct byte ranges; (b) erroneous regions represented by error nodes with correct offset and length
    - Test file: `tests/properties/parsing.property.test.ts`
    - **Validates: Requirements 1.2**

  - [x]* 7.7 Write property test for incremental parse equivalence
    - **Property 3: Incremental Parse Equivalence**
    - Generate random files + random edits (insertion, deletion, replacement)
    - Verify: incremental re-parse CST is structurally identical to full re-parse of edited file
    - Test file: `tests/properties/parsing.property.test.ts`
    - **Validates: Requirements 1.3**

  - [x]* 7.8 Write property test for symbol resolution graph correctness
    - **Property 4: Symbol Resolution Graph Correctness**
    - Generate symbol references with mix of resolved and unresolved outcomes
    - Verify: resolved → edge from usage to definition with correct type; unresolved → record with resolved=false and correct location
    - Test file: `tests/properties/graph-db.property.test.ts`
    - **Validates: Requirements 2.2, 2.3**

  - [x]* 7.9 Write property test for call graph completeness
    - **Property 5: Call Graph Completeness**
    - Generate sets of resolved function/method call edges
    - Verify: call graph contains directed edge for every unique caller-callee pair; no edges for unresolved references
    - Test file: `tests/properties/graph-db.property.test.ts`
    - **Validates: Requirements 2.5**

  - [x]* 7.10 Write unit tests for Parser_Agent
    - Test file: `tests/unit/parser-agent.test.ts`
    - Test cases: parsing known valid file, parsing file with known errors (verify error node positions), incremental edit correctness, LSP timeout handling, call graph edge count
    - _Requirements: 1.1–1.5, 2.1–2.5_

- [x] 8. Bug_Proving_Agent implementation
  - [x] 8.1 Implement TrajSpec behavioral interpretation
    - Create `src/agents/bug-proving-agent.ts`
    - Implement `runTrajSpec(repoPath: string): Promise<TrajSpecOutput>`
    - Process commits on default branch → produce behavioral interpretations with code region, summary, commit IDs
    - Produce diagnostic assertions (precondition-postcondition pairs per function)
    - Compute defect correlation score (D/N ratio) per code region
    - Support incremental updates (new commits only, ≤5s per commit for repos up to 10,000 files)
    - Store results in `behavioral_interpretations` and `diagnostic_assertions` tables
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5_

  - [x] 8.2 Implement SpecTune specification refinement
    - Implement `runSpecTune(postconditions: Postcondition[], testSuite: TestSuite): Promise<SpecTuneResult>`
    - Evaluate each postcondition against all passing test cases
    - Compute Alpha_Consistency = agreeing / total
    - Classify: α=1.0 → 'fully_consistent'; α < threshold → 'discarded' + disagreeing test IDs; threshold ≤ α < 1.0 → 'partially_consistent'
    - Store results in `spec_refinements` table
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5_

  - [x] 8.3 Implement PROBE adversarial loop
    - Implement `runProbeLoop(property: CandidateProperty): Promise<ProbeResult>`
    - Pair Generator Agent (drafts properties) with Validator Agent (generates counter-implementations)
    - On counter-implementation found: Generator refines property to exclude it
    - On search budget exhausted: accept property as verified
    - On max iterations reached without exhaustion: mark inconclusive with iteration count and last counter-implementation
    - Record each refinement: iteration number, counter-implementation, updated property text
    - Store iterations in `probe_iterations` table
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6_

  - [x] 8.4 Implement DiffTestGen differential test analysis
    - Implement `runDiffTestGen(implementations: Implementation[]): Promise<DiffTestResult>`
    - Generate ≥100 test inputs per interface method exercising behavioral differences
    - Flag differences with: triggering input, both outputs, code locations, severity (specification-violating vs unspecified-behavior)
    - Prioritize specification-violating differences before unspecified-behavior
    - Report "behaviorally equivalent" if budget exhausted without differences
    - _Requirements: 8.1, 8.2, 8.3, 8.4_

  - [x] 8.5 Implement SAFuzz biased fuzzing engine
    - Implement `runSAFuzz(regions: CodeRegion[], seeds: TestInput[]): Promise<FuzzResult>`
    - Support 3 mutation operators: Insert (1-10 tokens), Overwrite (1-10 tokens replaced), Splice (recombine from 2 seeds)
    - Allocate ≥70% mutations to defect-correlated regions
    - Derive seed corpus from existing test inputs and DiffTestGen inputs
    - Record violations: mutated input, operator, oracle type, seed input
    - Report "fuzzing-inconclusive" if budget exhausted without violations
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6_

  - [x] 8.6 Implement dynamic backward program slicing
    - Create `src/agents/slicing.ts` (used by Bug_Proving_Agent)
    - Implement backward slice from violation point computing influencing statements
    - Instrument target program to capture variable values (up to 10,000 statements)
    - Identify defect line: earliest statement where actual value diverges from postcondition-required value
    - Produce structured output: line number, file path, divergent variables, actual/expected values
    - Handle: no divergence found → report full slice boundary; slice >10,000 → truncate + indicate
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6_

  - [x] 8.7 Implement mathematical proof verification
    - Implement `verifyProof(candidate: ProofCandidate): Promise<ProofVerificationResult>`
    - Verify Admissibility: input satisfies all preconditions (≤30s)
    - Verify Soundness: output violates ≥1 postcondition (≤30s)
    - Verify Uniqueness: no alternative output satisfies all postconditions (≤60s)
    - All 3 pass → produce certificate with input, output, violated postcondition, timestamps; trigger repair
    - Any fail → mark unconfirmed with failed property and reason
    - Timeout → mark inconclusive with timed-out property
    - Store certificates in `proof_certificates` table
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6_

  - [x]* 8.8 Write property test for defect correlation score
    - **Property 8: Defect Correlation Score Computation**
    - Generate random N (total commits) and D (defect-fixing commits) where N > 0
    - Verify: defect_correlation_score = D/N in [0.0, 1.0]
    - Test file: `tests/properties/trajspec.property.test.ts`
    - **Validates: Requirements 4.3**

  - [x]* 8.9 Write property test for Alpha-Consistency computation
    - **Property 9: Alpha-Consistency Computation and Classification**
    - Generate random boolean arrays (agreement per test case) and configurable threshold
    - Verify: (a) α = A/T; (b) α=1.0 → 'fully_consistent'; (c) α < threshold → 'discarded' + disagreeing IDs; (d) threshold ≤ α < 1.0 → 'partially_consistent'
    - Test file: `tests/properties/spectune.property.test.ts`
    - **Validates: Requirements 5.2, 5.3, 5.4, 5.5**

  - [x]* 8.10 Write property test for backward slice defect identification
    - **Property 10: Backward Slice Defect Line Identification**
    - Generate execution traces with variable values at each statement and a violated postcondition
    - Verify: defect line is earliest statement where actual diverges from expected; slice contains all influencing statements
    - Test file: `tests/properties/slicing.property.test.ts`
    - **Validates: Requirements 6.1, 6.3**

  - [x]* 8.11 Write property test for defect report completeness
    - **Property 11: Defect Report Completeness**
    - Generate identified defect lines with variable states
    - Verify: report contains line_number, file_path, non-empty divergent_variable_names list, actual_values, and expected_values
    - Test file: `tests/properties/slicing.property.test.ts`
    - **Validates: Requirements 6.4**

  - [x]* 8.12 Write property test for PROBE refinement
    - **Property 12: PROBE Refinement Excludes Counter-Implementations**
    - Generate candidate properties P and counter-implementations C satisfying P
    - Verify: refined property P' does not admit C (C violates P')
    - Test file: `tests/properties/probe.property.test.ts`
    - **Validates: Requirements 7.3**

  - [x]* 8.13 Write property test for behavioral difference prioritization
    - **Property 13: Behavioral Difference Severity Prioritization**
    - Generate mixed sets of specification-violating and unspecified-behavior differences
    - Verify: all specification-violating differences appear before unspecified-behavior differences in results
    - Test file: `tests/properties/difftestgen.property.test.ts`
    - **Validates: Requirements 8.3**

  - [x]* 8.14 Write property test for SAFuzz mutation operators
    - **Property 14: SAFuzz Mutation Operator Correctness**
    - Generate random token arrays + random mutation parameters
    - Verify: Insert → length L+K (1≤K≤10); Overwrite → length L with 1-10 tokens replaced; Splice → recombination from exactly 2 seeds
    - Test file: `tests/properties/safuzz.property.test.ts`
    - **Validates: Requirements 9.2**

  - [x]* 8.15 Write property test for SAFuzz region allocation bias
    - **Property 15: SAFuzz Region Allocation Bias**
    - Generate SAFuzz campaigns with labeled defect-correlated and non-correlated regions
    - Verify: ≥70% of mutation attempts target defect-correlated regions
    - Test file: `tests/properties/safuzz.property.test.ts`
    - **Validates: Requirements 9.4**

  - [x]* 8.16 Write property tests for proof verification properties
    - **Property 17: Admissibility Verification** — verify: returns true iff all preconditions evaluate true on input
    - **Property 18: Soundness Verification** — verify: returns true iff ≥1 postcondition evaluates false given input/output
    - **Property 19: Uniqueness Verification** — verify: returns true iff no alternative output satisfies all postconditions
    - **Property 20: Proof Certification Decision** — verify: certified iff all 3 pass; unconfirmed with failed property otherwise
    - Generate random precondition/postcondition functions + random inputs
    - Test file: `tests/properties/proof.property.test.ts`
    - **Validates: Requirements 11.1, 11.2, 11.3, 11.4, 11.5**

  - [x]* 8.17 Write unit tests for Bug_Proving_Agent
    - Test file: `tests/unit/probe-loop.test.ts`
    - Test cases: PROBE loop termination at exact iteration count, SpecTune at threshold boundary (0.5), TrajSpec incremental update, DiffTestGen with no differences, SAFuzz budget exhaustion, proof timeout handling
    - _Requirements: 4.1–11.6_

- [x] 9. Checkpoint - Parsing and proving agents validated
  - Ensure all tests pass, ask the user if questions arise.

- [x] 10. Semantic Oracle monitoring
  - [x] 10.1 Implement oracle monitoring framework
    - Create `src/agents/oracles.ts`
    - Implement base `OracleMonitor` class with per-statement execution step monitoring
    - Implement `TimeoutOracle`: detect execution exceeding configured time limit → record timeout violation (oracle_id, timestamp, elapsed_duration)
    - Implement `CrashOracle`: detect unhandled exceptions → capture stack trace (≤50 frames) → record crash violation (oracle_id, timestamp, exception_type, stack_trace)
    - Implement `DeterminismOracle`: detect differing outputs across ≥2 repeated executions → record determinism violation (oracle_id, timestamp, input, both outputs)
    - Implement `OverflowOracle`: detect integer/buffer overflow → record overflow violation (oracle_id, timestamp, offending_value, expected_bounds)
    - Handle internal oracle failures: log, disable failing oracle, continue with remaining
    - Store violations in `oracle_violations` table
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6_

  - [x]* 10.2 Write property test for oracle violation record completeness
    - **Property 16: Oracle Violation Record Completeness**
    - Generate oracle violations of each type (timeout, crash, determinism, overflow)
    - Verify: each record contains oracle_id matching type, timestamp, and type-specific details (elapsed_duration; exception_type + stack_trace ≤ 50 frames; input + both outputs; offending_value + bounds)
    - Test file: `tests/properties/oracles.property.test.ts`
    - **Validates: Requirements 10.2, 10.3, 10.4, 10.5**

- [x] 11. Repair_Agent implementation
  - [x] 11.1 Implement candidate patch generation
    - Create `src/agents/repair-agent.ts`
    - Implement `generatePatches(proof: ProofOfFailureCertificate, context: DefectContext): Promise<PatchCandidate[]>`
    - Target defect line ±10 lines context window
    - Use MCP file tools (read_range, extract_method, write_fix)
    - Generate ≥3 structurally distinct patches per defect (different AST node types or locations)
    - _Requirements: 12.1, 12.2, 12.3_

  - [x] 11.2 Implement patch refinement with feedback
    - Implement `refinePatch(patch: PatchCandidate, feedback: StageFeedback): Promise<PatchCandidate>`
    - Accept feedback from failing filtering stage
    - Re-submit refined patch (max 3 refinement attempts per candidate)
    - Discard and report final failure reason on exhaustion
    - Track `refinement_attempt` counter (0..3)
    - _Requirements: 12.4, 12.5_

  - [x] 11.3 Implement layered progressive repair filtering pipeline
    - Create `src/agents/repair-pipeline.ts`
    - Stage 1: Static Compilation Pass — verify no compilation errors within 30s
    - Stage 2: M_SWT Transition Model Emulation — verify no state transition regressions
    - Stage 3: Sandbox Test Execution — run full test suite, pass only if all previously-passing tests still pass
    - On failure: discard patch, report stage/reason/elapsed time to Repair_Agent
    - On all stages pass: forward to Classifier_Agent
    - Update `patches` table status at each stage
    - _Requirements: 13.1, 13.2, 13.3, 13.4, 13.5_

  - [x]* 11.4 Write property test for patch context window targeting
    - **Property 21: Patch Context Window Targeting**
    - Generate defects at various line numbers L in files
    - Verify: all generated patches target code exclusively within [L-10, L+10]
    - Test file: `tests/properties/repair.property.test.ts`
    - **Validates: Requirements 12.1**

  - [x]* 11.5 Write property test for patch structural diversity
    - **Property 22: Patch Structural Diversity**
    - Generate confirmed defects and their patch sets
    - Verify: ≥3 patches produced, no two modify same AST node type at same location
    - Test file: `tests/properties/repair.property.test.ts`
    - **Validates: Requirements 12.3**

  - [x]* 11.6 Write unit tests for Repair_Agent
    - Test file: `tests/unit/repair-agent.test.ts`
    - Test cases: patch generation with ≥3 candidates, MCP tool usage (read_range, write_fix), refinement retry exhaustion, pipeline stage failure handling, stage time reporting
    - _Requirements: 12.1–12.5, 13.1–13.5_

- [x] 12. Classifier_Agent implementation
  - [x] 12.1 Implement AST difference vector computation and Prism APCC classification
    - Create `src/agents/classifier-agent.ts`
    - Implement `classify(patch: PatchCandidate, original: CstNode): Promise<ClassificationResult>`
    - Extract 11-property AST difference vector per edit state (Gen, Del, Remain)
    - Compose into 66-dimensional semantic feature vector (11 × 3 × 2 = 66)
    - Evaluate via Prism_APCC model → overfitting probability [0.0, 1.0]
    - If score > threshold (default 0.5): reject + report top 3 contributing AST properties
    - If score ≤ threshold: approve + include overfitting probability in output
    - Handle model failure (>30s or error): reject as inconclusive, preserve for manual review
    - Store feature vector and probability in `patches` table
    - _Requirements: 14.1, 14.2, 14.3, 14.4, 14.5, 14.6_

  - [x]* 12.2 Write property test for AST difference vector composition
    - **Property 23: AST Difference Vector Composition**
    - Generate random AST diffs with Gen/Del/Remain node sets
    - Verify: 11-property vector per state, composed into 66-dimensional vector, all dimensions present and finite
    - Test file: `tests/properties/classifier.property.test.ts`
    - **Validates: Requirements 14.1, 14.2**

  - [x]* 12.3 Write property test for Prism APCC output range
    - **Property 24: Prism APCC Output Range**
    - Generate random 66-dimensional feature vectors
    - Verify: output score in closed interval [0.0, 1.0]
    - Test file: `tests/properties/classifier.property.test.ts`
    - **Validates: Requirements 14.3**

  - [x]* 12.4 Write property test for overfitting classification decision
    - **Property 25: Overfitting Classification Decision**
    - Generate scores S and configurable thresholds T
    - Verify: S > T → rejected with ≥3 top contributing properties; S ≤ T → approved with score included
    - Test file: `tests/properties/classifier.property.test.ts`
    - **Validates: Requirements 14.4, 14.5**

  - [x]* 12.5 Write unit tests for Classifier_Agent
    - Test file: `tests/unit/classifier-agent.test.ts`
    - Test cases: 66-dim vector shape validation, threshold boundary classification, model timeout (30s) handling, top-3 contributing properties format
    - _Requirements: 14.1–14.6_

- [x] 13. Checkpoint - Repair and classification validated
  - Ensure all tests pass, ask the user if questions arise.

- [x] 14. Sandbox_Agent implementation
  - [x] 14.1 Implement Firecracker microVM lifecycle management
    - Create `src/sandbox/sandbox-agent.ts`
    - Implement `execute(request: ExecutionRequest): Promise<ExecutionResult>`
    - Create Firecracker microVM via REST API over Unix socket
    - Configure: hardware virtualization, virtio block + network only (reject others), isolated /30 TAP_Subnet with iptables rules
    - Enforce resource limits: ≤2 vCPUs, ≤512 MB memory, ≤10 GB storage, ≤300s execution
    - Terminate at resource cap exceeded or TTL expiry (max 600s)
    - Release all resources (TAP_Subnet, block device) within 5s of termination; force-kill at hypervisor level if stuck >5s
    - Never fall back to non-isolated execution on failure
    - _Requirements: 15.1, 15.2, 15.3, 15.5, 15.6, 15.7_

  - [x] 14.2 Implement OAP Passport permission enforcement
    - Implement passport validation in `execute()` flow
    - Attach OAP_Passport to each agent session specifying permitted operations
    - Reject any operation not in passport's `permitted_operations` list
    - _Requirements: 15.4_

  - [x] 14.3 Implement snapshot pool and CoW restore
    - Create `src/sandbox/snapshot-pool.ts`
    - Maintain ≥2 pre-warmed snapshots per configured runtime environment
    - Implement `restoreSnapshot(runtime: string): Promise<MicroVmInstance>` using CoW_Mapping
    - Target: median restore ≤150ms, p99 ≤500ms
    - Fallback: cold-start within 5s on CoW failure + report + async pool replenishment
    - If no snapshot available: cold-start + trigger async replenishment
    - _Requirements: 16.1, 16.2, 16.3, 16.4, 16.5_

  - [x] 14.4 Implement circuit breaker and resource enforcement
    - Create `src/sandbox/circuit-breaker.ts`
    - Enforce hypervisor-level resource caps: CPU time (max 300s), memory (max 2048 MB), disk I/O (max 1024 MB)
    - Enforce hard TTL (max 600s) per microVM instance
    - On cap exceeded: terminate + record violated resource and value
    - Release all resources within 10s on circuit breaker trigger
    - Force-kill at hypervisor level if termination stuck >5s
    - Notify requesting agent of termination reason (violated resource + cap value)
    - _Requirements: 17.1, 17.2, 17.3, 17.4, 17.5, 17.6_

  - [x]* 14.5 Write property test for OAP Passport permission enforcement
    - **Property 26: OAP Passport Permission Enforcement**
    - Generate random operations and passports with various permitted_operations lists
    - Verify: operation allowed iff it appears in permitted_operations; all others rejected
    - Test file: `tests/properties/sandbox.property.test.ts`
    - **Validates: Requirements 15.4**

  - [x]* 14.6 Write property test for no fallback to non-isolated execution
    - **Property 27: No Fallback to Non-Isolated Execution**
    - Generate various Firecracker creation/start failure scenarios
    - Verify: execution request rejected with error; code never executes outside microVM
    - Test file: `tests/properties/sandbox.property.test.ts`
    - **Validates: Requirements 15.5**

  - [x]* 14.7 Write property test for resource limit enforcement
    - **Property 28: Resource Limit Enforcement**
    - Generate random resource configurations with values 0..10000
    - Verify: enforced limits clamped to maximums (vCPUs ≤ 2, memory ≤ 2048 MB, disk I/O ≤ 1024 MB, CPU time ≤ 300s, storage ≤ 10 GB, TTL ≤ 600s)
    - Test file: `tests/properties/sandbox.property.test.ts`
    - **Validates: Requirements 15.6, 17.1, 17.2**

  - [x]* 14.8 Write unit tests for Sandbox_Agent
    - Test file: `tests/unit/sandbox-agent.test.ts`
    - Test cases: VM creation failure handling (no fallback), resource limit clamping, TAP subnet isolation, OAP passport rejection, snapshot restore timing, circuit breaker trigger, force-kill escalation, resource cleanup within 5/10s
    - _Requirements: 15.1–15.7, 16.1–16.5, 17.1–17.6_

- [x] 15. Plug System
  - [x] 15.1 Implement plug registry with interface validation and fallback
    - Create `src/plugs/plug-registry.ts`
    - Implement `PlugRegistry` with `registerParsing`, `registerOracle`, `registerRepair`, `registerSandboxExecutor`
    - Validate custom implementations: export all interface methods with matching type signatures
    - On validation failure: reject + report missing/mistyped methods
    - Allow up to 8 Oracle_Plug registrations (execute all on each monitored event)
    - On plug exception: terminate invocation, log error, fallback to default within 500ms
    - On registration of Parsing/Repair/SandboxExecutor plug: deactivate default, route through custom
    - _Requirements: 19.1, 19.2, 19.3, 19.4, 19.5, 19.6_

  - [x]* 15.2 Write property test for plug interface validation and routing
    - **Property 30: Plug Interface Validation and Routing**
    - Generate custom plug implementations with valid/invalid/partial method exports
    - Verify: (a) accepted iff all interface methods present with correct signatures; (b) Parsing/Repair/SandboxExecutor acceptance → default deactivated; (c) failure → specific missing/mistyped methods reported
    - Test file: `tests/properties/plugs.property.test.ts`
    - **Validates: Requirements 19.2, 19.3, 19.6**

- [x] 16. Checkpoint - All agents and plugs validated
  - Ensure all tests pass, ask the user if questions arise.

- [x] 17. Agent Orchestrator and pipeline integration
  - [x] 17.1 Implement Agent Orchestrator pipeline coordination
    - Create `src/orchestrator/orchestrator.ts`
    - Implement `startInvestigation(target: InvestigationTarget): Promise<InvestigationReport>`
    - Coordinate sequential phases: Parser_Agent → Bug_Proving_Agent → Repair_Agent → Classifier_Agent
    - Make Sandbox_Agent available to all agents on-demand (up to 4 concurrent requests)
    - After parsing completes: make graph available to Bug_Proving_Agent within 5s
    - After proof certified: forward to Repair_Agent
    - After patches generated: route each (max 20) through Classifier_Agent
    - If no proof certified: terminate investigation, record as unconfirmed
    - On agent failure/unresponsive: halt pipeline, report which agent/phase failed, preserve intermediate results
    - On Sandbox unavailable: retry 3× at 2s, then halt and report
    - Implement `getStatus(id)` and `halt(id)` for monitoring
    - _Requirements: 21.1, 21.2, 21.3, 21.4, 21.5, 21.6, 21.7, 21.8_

  - [x]* 17.2 Write property test for pipeline patch routing cap
    - **Property 32: Pipeline Patch Routing Cap**
    - Generate investigations producing varying numbers of filtered patches (0..50)
    - Verify: at most 20 patches routed to Classifier_Agent; patches beyond 20th not classified
    - Test file: `tests/properties/orchestrator.property.test.ts`
    - **Validates: Requirements 21.4**

  - [x]* 17.3 Write property test for agent failure intermediate result preservation
    - **Property 33: Agent Failure Intermediate Result Preservation**
    - Generate agent failures at various pipeline phases
    - Verify: (a) pipeline halted; (b) report identifies failed agent and phase; (c) intermediate results from completed phases preserved
    - Test file: `tests/properties/orchestrator.property.test.ts`
    - **Validates: Requirements 21.7**

  - [x]* 17.4 Write unit tests for orchestrator
    - Test file: `tests/unit/orchestrator.test.ts`
    - Test cases: full happy-path pipeline, agent failure at each phase, Sandbox unavailable retry logic, 20-patch routing cap, 4 concurrent sandbox executions, investigation status tracking, halt behavior
    - _Requirements: 21.1–21.8_

- [x] 18. Final integration wiring and entry point
  - [x] 18.1 Wire all components together in system entry point
    - Create `src/index.ts` as main entry point
    - Load config → initialize Graph DB → register MCP tools → start plug registry → initialize all agents → start orchestrator
    - Create `src/agents/index.ts` barrel export for all agents
    - Wire config values into each component (sandbox limits, oracle thresholds, PROBE parameters)
    - Handle startup failure gracefully (config errors terminate, DB errors terminate, agent init errors report)
    - _Requirements: 18.1, 19.1, 20.1, 21.1_

  - [x]* 18.2 Write integration tests
    - Test file: `tests/integration/end-to-end-pipeline.test.ts`
    - Test: full investigation pipeline from parsing through proof to repair with a known-buggy program
    - Test file: `tests/integration/mcp-middleware.test.ts`
    - Test: 10+ concurrent tool invocations, timeout enforcement, schema validation for all 8 tools
    - Test file: `tests/integration/sqlite-graph-db.test.ts`
    - Test: WAL mode concurrency, referential integrity under concurrent writes, recursive CTE path queries
    - _Requirements: 3.1–3.5, 20.1–20.7, 21.1–21.8_

- [x] 19. Final checkpoint - Full system validated
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation at logical boundaries
- Property tests validate universal correctness properties (33 total) from the design document
- Unit tests validate specific examples and edge cases
- Integration tests validate component interaction and system-level behavior
- The design explicitly uses TypeScript — all implementation uses TypeScript with strict mode
- fast-check is used for all property-based tests with minimum 100 iterations
- vitest is the test runner for all test types
- SQLite with WAL mode provides the graph database backend
- MCP SDK (`@modelcontextprotocol/sdk`) provides inter-agent communication
- Tree-sitter Node.js bindings provide parsing
- Firecracker REST API (Unix socket) provides sandbox VM management

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2"] },
    { "id": 2, "tasks": ["2.1", "4.1", "5.1"] },
    { "id": 3, "tasks": ["2.2", "2.3", "4.2", "4.3", "5.2", "5.3"] },
    { "id": 4, "tasks": ["4.4", "4.5", "4.6", "7.1", "7.2"] },
    { "id": 5, "tasks": ["7.3", "7.4", "7.5", "7.6", "7.7"] },
    { "id": 6, "tasks": ["7.8", "7.9", "7.10", "8.1", "8.2", "8.3"] },
    { "id": 7, "tasks": ["8.4", "8.5", "8.6", "8.7", "10.1"] },
    { "id": 8, "tasks": ["8.8", "8.9", "8.10", "8.11", "8.12", "8.13", "8.14", "8.15", "8.16", "8.17", "10.2"] },
    { "id": 9, "tasks": ["11.1", "11.2", "12.1"] },
    { "id": 10, "tasks": ["11.3", "11.4", "11.5", "11.6", "12.2", "12.3", "12.4", "12.5"] },
    { "id": 11, "tasks": ["14.1", "14.2", "14.3", "14.4", "15.1"] },
    { "id": 12, "tasks": ["14.5", "14.6", "14.7", "14.8", "15.2"] },
    { "id": 13, "tasks": ["17.1"] },
    { "id": 14, "tasks": ["17.2", "17.3", "17.4", "18.1"] },
    { "id": 15, "tasks": ["18.2"] }
  ]
}
```
