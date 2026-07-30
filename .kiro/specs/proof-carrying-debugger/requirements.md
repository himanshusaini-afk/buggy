# Requirements Document

## Introduction

This document specifies the requirements for a Customizable, Proof-Carrying Program Repair and Debugging System. The system operates as an autonomous multi-agent network communicating over MCP (Model Context Protocol). It parses source code into semantic graphs, localizes defects through specification refinement and dynamic slicing, mathematically proves bugs via adversarial property generation, performs test-driven automated repair, and executes all untrusted code inside isolated Firecracker microVMs. The system is TypeScript-based and exposes extensibility through a `.debugger.yaml` configuration file and four pluggable extension points.

## Glossary

- **System**: The Proof-Carrying Program Repair and Debugging System as a whole
- **Parser_Agent**: The sub-agent responsible for parsing source files into CSTs, querying LSP instances, and writing outputs to the Graph Database
- **Bug_Proving_Agent**: The sub-agent responsible for running PROBE loops, SAFuzz fuzzing, and mathematical proof verification of failures
- **Repair_Agent**: The sub-agent responsible for generating and refining candidate patches using MCP file tools
- **Classifier_Agent**: The sub-agent responsible for computing 66-dimensional semantic feature vectors and overfitting detection via Prism APCC
- **Sandbox_Agent**: The sub-agent responsible for managing Firecracker microVM lifecycle, snapshot pools, and circuit breakers
- **CST**: Concrete Syntax Tree — a lossless representation of source code produced by Tree-sitter
- **LSP**: Language Server Protocol — a standardized protocol for querying symbol references, types, and call graphs
- **Graph_Database**: A local SQLite database storing syntax nodes, symbol tables, and cross-file reference edges
- **MCP**: Model Context Protocol — the inter-agent communication protocol used by the system
- **TrajSpec**: A component that processes historical repository context into structured behavioral interpretations
- **SpecTune**: A component that synthesizes intermediate checkpoints and evaluates candidate postconditions against passing test cases
- **Alpha_Consistency**: A numeric signal computed as the ratio of passing test cases agreeing with a postcondition to total passing test cases (α = agreeing / total)
- **PROBE_Loop**: An adversarial loop pairing a Generator Agent (drafts properties) with a Validator Agent (generates counter-implementations) to refine specification assertions
- **DiffTestGen**: Differential test analysis that flags behavioral differences between implementations
- **SAFuzz**: Biased fuzzing engine applying Masked Language Modeling mutations (Insert, Overwrite, Splice)
- **Semantic_Oracle**: A specialized runtime monitor that detects specific failure classes during execution
- **Timeout_Oracle**: A Semantic Oracle that detects execution exceeding configured time limits
- **Crash_Oracle**: A Semantic Oracle that detects unhandled exceptions and process crashes
- **Determinism_Oracle**: A Semantic Oracle that detects non-deterministic behavior across repeated executions
- **Overflow_Oracle**: A Semantic Oracle that detects integer overflow and buffer overflow conditions
- **Admissibility**: A proof property requiring that input satisfies preconditions: pre(i)
- **Soundness**: A proof property requiring that output satisfies postconditions given input: post(i, o)
- **Uniqueness**: A proof property requiring that no alternative output satisfies postconditions: ∀o' ≠ o, ¬post(i, o')
- **Layered_Progressive_Repair**: A multi-stage filtering pipeline for candidate patches: Static Compilation → Transition Model Emulation → Sandbox Test Execution
- **M_SWT**: Transition Model Emulation — a lightweight model that emulates program state transitions without full execution
- **AST_Difference_Vector**: An 11-property vector computed across 3 edit states (Gen, Del, Remain) forming a 66-dimensional semantic feature representation
- **Prism_APCC**: Automated Patch Correctness Classifier — an overfitting blocker that uses the 66-dimensional feature vector to classify patches
- **Firecracker_MicroVM**: An AWS Firecracker-based lightweight virtual machine providing hardware-level isolation for code execution
- **CoW_Mapping**: Copy-on-Write memory mapping used to restore pre-warmed microVM guest states
- **OAP_Passport**: Open Agent Policy passport — a credential governing agent permissions within the sandbox
- **TAP_Subnet**: An isolated /30 network subnet using TAP virtual interfaces for microVM networking
- **Circuit_Breaker**: A fault-tolerance mechanism that terminates execution when resource or time thresholds are exceeded
- **TTL**: Time-To-Live — a hard upper bound on the duration a process or microVM instance may execute
- **Parsing_Plug**: An extensible plug point allowing custom parser integrations
- **Oracle_Plug**: An extensible plug point allowing custom semantic oracle definitions
- **Repair_Plug**: An extensible plug point allowing custom repair strategy implementations
- **Sandbox_Executor_Plug**: An extensible plug point allowing custom sandbox runtime configurations
- **MCP_Middleware**: The set of MCP tools exposed for inter-agent file and code operations

## Requirements

### Requirement 1: Incremental Source Parsing

**User Story:** As a developer, I want source files parsed into Concrete Syntax Trees with fault tolerance, so that the system can analyze code even when it contains syntax errors.

#### Acceptance Criteria

1. WHEN a source file of up to 100,000 lines is opened or saved, THE Parser_Agent SHALL parse the file into a CST using Tree-sitter within 1 millisecond per parse operation
2. IF a source file contains syntax errors, THEN THE Parser_Agent SHALL produce a partial CST that includes nodes for all syntactically valid regions and marks each erroneous region with an error node indicating its byte offset and length
3. WHEN an edit event occurs on a previously parsed file, THE Parser_Agent SHALL perform incremental re-parsing limited to the changed region rather than re-parsing the entire file, completing within 1 millisecond
4. THE Parser_Agent SHALL preserve all whitespace, comments, and formatting information in the produced CST
5. IF a parse operation exceeds 1 millisecond, THEN THE Parser_Agent SHALL still return the completed CST and report the actual duration to the caller

### Requirement 2: LSP Symbol Resolution

**User Story:** As a developer, I want cross-file symbol references resolved via LSP, so that the system can understand type relationships and call graphs across the entire codebase.

#### Acceptance Criteria

1. WHEN the Parser_Agent encounters a symbol reference, THE Parser_Agent SHALL query the attached LSP instance to resolve the symbol's definition location, type, and enclosing scope within 5 seconds per symbol query
2. WHEN the LSP instance returns a resolved symbol, THE Parser_Agent SHALL store the resolution as a typed edge in the Graph_Database linking usage site to definition site
3. WHEN the LSP instance fails to resolve a symbol, THE Parser_Agent SHALL record the unresolved reference with its source location and mark it as unresolved in the Graph_Database
4. IF the LSP instance does not respond within 5 seconds or is unavailable, THEN THE Parser_Agent SHALL mark the symbol as unresolved in the Graph_Database and continue processing remaining symbols
5. WHEN all files in the target codebase have been parsed and all symbol references have been resolved or marked as unresolved, THE Parser_Agent SHALL construct a call graph by aggregating all resolved function and method call edges from the LSP instance into the Graph_Database

### Requirement 3: Graph Database Persistence and Query API

**User Story:** As a sub-agent, I want syntax and symbol data stored in SQLite and queryable via MCP endpoints, so that all agents can access the semantic graph for analysis.

#### Acceptance Criteria

1. WHEN a CST or symbol resolution is produced, THE Parser_Agent SHALL write the data incrementally to the Graph_Database using asynchronous writes that add no more than 5 milliseconds of latency to the parse pipeline per write operation
2. THE Graph_Database SHALL expose graph query endpoints via MCP to all registered sub-agents supporting at minimum: node lookup by identifier, edge traversal by relationship type, subgraph extraction by file scope, and path queries between two nodes
3. WHEN a sub-agent submits a graph query via MCP, THE Graph_Database SHALL return matching nodes and edges within 50 milliseconds for queries traversing fewer than 1000 nodes
4. THE Graph_Database SHALL maintain referential integrity between CST nodes, symbol definitions, and cross-file reference edges by rejecting any write operation that would create a dangling reference and returning an error indicating the missing target node
5. IF a write to the Graph_Database fails due to a database error or constraint violation, THEN THE Parser_Agent SHALL retain the failed write payload, retry the write up to 3 times with 100-millisecond intervals, and if all retries fail, report the failure to the requesting agent via MCP with the affected node identifiers

### Requirement 4: Behavioral Interpretation via TrajSpec

**User Story:** As a developer, I want historical repository context processed into structured behavioral interpretations, so that the system can understand intended program behavior from project history.

#### Acceptance Criteria

1. WHEN a repository is loaded, THE TrajSpec component SHALL process all commits on the default branch and produce structured behavioral interpretations, where each interpretation includes the associated code region (file path and function or method scope), a natural-language behavioral summary, and the set of commit identifiers from which it was derived
2. THE TrajSpec component SHALL produce diagnostic assertions derived from historical test patterns and code evolution, where each assertion specifies a precondition-postcondition pair linked to a specific function or method, expressed as testable boolean conditions
3. THE TrajSpec component SHALL produce localized observations identifying code regions at function-level granularity with a defect correlation score above a configurable threshold (default 0.7 on a 0.0 to 1.0 scale), computed from the ratio of defect-fixing commits touching that region to total commits touching that region
4. WHEN new commits are added to the repository, THE TrajSpec component SHALL incrementally update behavioral interpretations by processing only the new commits and their affected code regions, completing the update within 5 seconds per commit on repositories with up to 10,000 files
5. WHEN TrajSpec completes processing, THE TrajSpec component SHALL make all behavioral interpretations and diagnostic assertions available to other agents via the Graph_Database and queryable through MCP endpoints

### Requirement 5: Specification Refinement via SpecTune

**User Story:** As a developer, I want candidate postconditions evaluated against passing test cases, so that the system can determine which specifications accurately describe correct behavior.

#### Acceptance Criteria

1. WHEN candidate postconditions are generated, THE SpecTune component SHALL evaluate each postcondition against all passing test cases in the test suite by checking whether the postcondition holds true given each test case's recorded inputs and expected outputs
2. THE SpecTune component SHALL compute the Alpha_Consistency signal for each candidate postcondition as the ratio of passing test cases for which the postcondition holds true to the total number of passing test cases, yielding a value between 0.0 and 1.0 inclusive
3. WHEN a postcondition achieves an Alpha_Consistency value of 1.0, THE SpecTune component SHALL mark the postcondition as fully consistent and retain it for use in specification output
4. WHEN a postcondition achieves an Alpha_Consistency value below a configurable threshold (default: 0.5, valid range: 0.0 to 1.0 exclusive), THE SpecTune component SHALL discard the postcondition and return the list of disagreeing test case identifiers
5. WHEN a postcondition achieves an Alpha_Consistency value at or above the configurable threshold but below 1.0, THE SpecTune component SHALL mark the postcondition as partially consistent and retain it as a candidate requiring further refinement

### Requirement 6: Dynamic Backward Program Slicing

**User Story:** As a developer, I want defect lines and variable states isolated through dynamic slicing, so that the system can pinpoint exactly where execution diverges from postconditions.

#### Acceptance Criteria

1. WHEN an execution trace violates a verified postcondition, THE System SHALL perform dynamic backward program slicing from the violation point, computing the set of statements that influenced the violated postcondition variable values
2. WHEN a backward slice is computed, THE System SHALL instrument the target program at runtime to capture the values of all local variables and function parameters at each statement within the slice, up to a maximum of 10,000 instrumented statements
3. WHEN instrumented variable states are captured, THE System SHALL identify the defect line as the earliest statement in the backward slice where a variable's actual value differs from the value required to satisfy the postcondition
4. WHEN a defect line is identified, THE System SHALL report the defect line number, source file path, the divergent variable names, their actual values at that statement, and their expected values derived from the postcondition as structured output
5. IF the backward slice contains no statement where a variable value differs from postcondition expectations, THEN THE System SHALL report that no single-statement divergence point was identified and provide the full slice boundary (first and last statement locations) for manual inspection
6. IF the computed backward slice exceeds 10,000 statements, THEN THE System SHALL truncate instrumentation to the 10,000 statements nearest to the violation point and indicate that the slice was truncated in the output

### Requirement 7: PROBE Asymmetry Loop

**User Story:** As a developer, I want specification assertions refined through adversarial generation and validation, so that the system produces precise and complete bug specifications.

#### Acceptance Criteria

1. THE Bug_Proving_Agent SHALL pair a Generator Agent that drafts candidate properties with a Validator Agent that generates counter-implementations
2. WHEN the Generator Agent produces a candidate property, THE Validator Agent SHALL attempt to generate a counter-implementation that satisfies the property while producing at least one output value differing from the reference implementation on the same input
3. WHEN the Validator Agent succeeds in generating a counter-implementation, THE Generator Agent SHALL refine the candidate property to exclude the counter-implementation
4. WHEN the Validator Agent fails to generate a counter-implementation within a configurable search budget measured in maximum candidate counter-implementations evaluated, THE Bug_Proving_Agent SHALL accept the candidate property as a verified specification assertion
5. IF the PROBE loop completes a configurable maximum number of refinement iterations without the Validator Agent exhausting its search budget, THEN THE Bug_Proving_Agent SHALL halt the loop, mark the candidate property as inconclusive, and report the number of iterations completed and the last counter-implementation found
6. WHEN the Generator Agent refines a candidate property, THE Bug_Proving_Agent SHALL record the refinement iteration number, the counter-implementation that triggered the refinement, and the updated property text as structured output

### Requirement 8: Differential Test Analysis

**User Story:** As a developer, I want behavioral differences between implementations automatically detected, so that the system can identify regression-inducing changes.

#### Acceptance Criteria

1. WHEN two or more implementations of the same interface are available, THE Bug_Proving_Agent SHALL execute DiffTestGen to generate at least 100 test inputs per interface method exercising behavioral differences
2. WHEN DiffTestGen detects a behavioral difference, THE Bug_Proving_Agent SHALL flag the difference with the input that triggered it, both outputs, the code locations responsible in each implementation, and a severity classification (specification-violating or unspecified-behavior)
3. THE Bug_Proving_Agent SHALL prioritize behavioral differences that violate verified specification assertions over differences in unspecified behavior when reporting results
4. IF DiffTestGen exhausts its input generation budget without finding behavioral differences, THEN THE Bug_Proving_Agent SHALL report the interface as behaviorally equivalent within the tested input space

### Requirement 9: SAFuzz Biased Fuzzing

**User Story:** As a developer, I want mutation-based fuzzing guided by code semantics, so that the system can discover edge-case failures that conventional testing misses.

#### Acceptance Criteria

1. WHEN dynamic backward slicing identifies defect-correlated code regions, THE Bug_Proving_Agent SHALL initiate SAFuzz biased fuzzing using Masked Language Modeling mutations against those regions
2. THE SAFuzz component SHALL support three mutation operators: Insert (adds between 1 and 10 tokens at a random position), Overwrite (replaces between 1 and 10 contiguous tokens), and Splice (recombines token sequences from two seed inputs)
3. WHEN SAFuzz generates a mutated input that triggers a Semantic Oracle violation, THE Bug_Proving_Agent SHALL record the input as a candidate proof-of-failure including the mutated input, the mutation operator applied, the violated oracle type, and the originating seed input
4. THE SAFuzz component SHALL allocate at least 70% of mutation attempts to code regions identified by dynamic backward slicing as defect-correlated, with the remaining attempts distributed across non-correlated regions
5. THE SAFuzz component SHALL derive its seed corpus from existing test inputs and inputs generated by DiffTestGen
6. IF SAFuzz exhausts its configured mutation budget without triggering any Semantic Oracle violation, THEN THE Bug_Proving_Agent SHALL report a fuzzing-inconclusive result for the target code region

### Requirement 10: Semantic Oracle Monitoring

**User Story:** As a developer, I want specialized runtime oracles monitoring execution for specific failure classes, so that the system can detect bugs that do not produce explicit crashes.

#### Acceptance Criteria

1. WHILE code is executing in the sandbox, THE System SHALL monitor execution via the Timeout_Oracle, Crash_Oracle, Determinism_Oracle, and Overflow_Oracle, checking for violations at each statement-level execution step
2. WHEN the Timeout_Oracle detects execution exceeding the configured time limit, THE System SHALL terminate the execution and record a timeout violation including the oracle identifier, a timestamp, and the elapsed execution duration
3. WHEN the Crash_Oracle detects an unhandled exception or process crash, THE System SHALL capture the stack trace up to a maximum of 50 frames and record a crash violation including the oracle identifier, a timestamp, the exception type, and the captured stack trace
4. WHEN the Determinism_Oracle detects differing outputs across a minimum of 2 repeated executions with identical inputs, THE System SHALL record a determinism violation including the oracle identifier, a timestamp, the input used, and both differing outputs
5. WHEN the Overflow_Oracle detects an integer overflow or buffer overflow condition, THE System SHALL record an overflow violation including the oracle identifier, a timestamp, the offending value, and the expected valid bounds
6. IF an oracle encounters an internal failure during monitoring, THEN THE System SHALL log the oracle failure, disable the failing oracle for the current execution, and continue monitoring with the remaining active oracles

### Requirement 11: Mathematical Proof of Failure Verification

**User Story:** As a developer, I want failing tests mathematically verified as concrete proofs of failure, so that the system can guarantee that identified bugs are real and not false positives.

#### Acceptance Criteria

1. WHEN a failing test is identified as a candidate proof-of-failure, THE Bug_Proving_Agent SHALL verify Admissibility by confirming that the test input satisfies all preconditions declared in the function's specification within 30 seconds
2. WHEN a failing test is identified as a candidate proof-of-failure, THE Bug_Proving_Agent SHALL verify Soundness by confirming that the test output violates at least one postcondition declared in the function's specification within 30 seconds
3. WHEN a failing test is identified as a candidate proof-of-failure, THE Bug_Proving_Agent SHALL verify Uniqueness by confirming within 60 seconds that no alternative output satisfying all postconditions exists for the given input, using the function's declared output domain as the search space
4. WHEN all three proof properties (Admissibility, Soundness, Uniqueness) are verified, THE Bug_Proving_Agent SHALL produce a proof-of-failure certificate containing the test input, observed output, violated postcondition, and verification timestamps, and trigger Phase II repair
5. IF any of the three proof properties (Admissibility, Soundness, Uniqueness) cannot be verified, THEN THE Bug_Proving_Agent SHALL mark the candidate as unconfirmed, record which property failed verification with the reason, and exclude the candidate from Phase II repair
6. IF the verification of any proof property exceeds its time limit, THEN THE Bug_Proving_Agent SHALL abort the verification, mark the candidate as inconclusive, and record the property that timed out

### Requirement 12: Candidate Patch Generation

**User Story:** As a developer, I want candidate patches generated automatically when a proof of failure is confirmed, so that the system can propose fixes without manual intervention.

#### Acceptance Criteria

1. WHEN a confirmed proof-of-failure is received, THE Repair_Agent SHALL generate candidate patches targeting the identified defect line and a surrounding context window of up to 10 lines above and below the defect line
2. THE Repair_Agent SHALL use MCP file tools (read_range, extract_method, write_fix) to read defective code and write candidate patches
3. THE Repair_Agent SHALL generate at least 3 candidate patches per confirmed defect, where each patch applies a structurally distinct edit operation (different AST node types modified or different edit locations within the context window)
4. IF a candidate patch fails all filtering stages, THEN THE Repair_Agent SHALL refine the patch using feedback from the failing stage and re-submit, up to a maximum of 3 refinement attempts per candidate patch
5. IF a candidate patch exhausts all refinement attempts without passing any filtering stage, THEN THE Repair_Agent SHALL discard the patch and report the final failure reason to the requesting agent

### Requirement 13: Layered Progressive Repair Filtering

**User Story:** As a developer, I want candidate patches filtered through progressive validation stages, so that only compilable, behaviorally sound, and test-passing patches reach the developer.

#### Acceptance Criteria

1. WHEN a candidate patch is generated, THE System SHALL apply the Static Compilation Pass to verify the patch produces no compilation errors within 30 seconds of stage initiation
2. WHEN a candidate patch passes static compilation, THE System SHALL apply Transition Model Emulation via M_SWT to verify the patch does not introduce state transition regressions compared to the pre-patch program behavior
3. WHEN a candidate patch passes transition model emulation, THE System SHALL execute the full test suite against the patched code inside the sandbox environment and mark the patch as passing only if all previously-passing tests continue to pass
4. IF a candidate patch fails any filtering stage or exceeds the stage time limit, THEN THE System SHALL discard the patch and report the failure stage, failure reason, and elapsed time to the Repair_Agent
5. WHEN a candidate patch passes all three filtering stages (Static Compilation Pass, Transition Model Emulation, and Sandbox Test Execution), THE System SHALL forward the patch to the Classifier_Agent for overfitting analysis

### Requirement 14: AST Difference Vector and Overfitting Detection

**User Story:** As a developer, I want patches analyzed for overfitting risk using semantic feature vectors, so that the system avoids patches that pass tests but do not generalize.

#### Acceptance Criteria

1. WHEN a candidate patch passes all Layered_Progressive_Repair stages, THE Classifier_Agent SHALL extract an 11-property AST difference vector across 3 edit states (Gen, Del, Remain)
2. THE Classifier_Agent SHALL compose the 11-property vectors across 3 edit states into a 66-dimensional semantic feature vector
3. THE Classifier_Agent SHALL evaluate the 66-dimensional feature vector using the Prism_APCC model to produce an overfitting probability score in the range 0.0 to 1.0, where 0.0 indicates no overfitting risk and 1.0 indicates certain overfitting
4. WHEN the Prism_APCC model produces an overfitting probability above a configurable threshold (default 0.5, configurable within the range 0.0 to 1.0), THE Classifier_Agent SHALL reject the patch and report at least the top 3 AST difference properties that contributed most to the overfitting probability
5. WHEN the Prism_APCC model produces an overfitting probability at or below the threshold, THE Classifier_Agent SHALL approve the patch for developer review and include the computed overfitting probability score in the approval output
6. IF the Prism_APCC model fails to produce an overfitting probability score within 30 seconds or returns an error, THEN THE Classifier_Agent SHALL reject the patch, indicate that classification was inconclusive due to model evaluation failure, and preserve the candidate patch for manual review

### Requirement 15: Firecracker MicroVM Isolation

**User Story:** As a developer, I want all untrusted code executed inside hardware-isolated microVMs, so that malicious or buggy code cannot affect the host system or other workloads.

#### Acceptance Criteria

1. THE Sandbox_Agent SHALL execute all untrusted code inside Firecracker_MicroVM instances with hardware virtualization enabled and no microVM instance SHALL share a kernel or memory space with another instance or the host userspace
2. THE Sandbox_Agent SHALL configure each Firecracker_MicroVM with virtio devices limited exclusively to block and network, rejecting any device configuration request outside this set
3. THE Sandbox_Agent SHALL assign each Firecracker_MicroVM an isolated /30 TAP_Subnet with iptables rules that drop all packets destined for other microVM subnets, permitting only host-gateway communication
4. THE Sandbox_Agent SHALL attach an OAP_Passport to each agent session specifying permitted operations within the sandbox, and SHALL reject any operation not explicitly listed in the OAP_Passport
5. IF the Sandbox_Agent fails to create or start a Firecracker_MicroVM, THEN THE Sandbox_Agent SHALL reject the code execution request with an error indication describing the resource or configuration failure, and SHALL NOT fall back to non-isolated execution
6. THE Sandbox_Agent SHALL enforce per-microVM resource limits of no more than 2 vCPUs, no more than 512 MB of memory, and no more than 10 GB of block storage, and SHALL terminate any microVM that exceeds a maximum execution duration of 300 seconds
7. IF a Firecracker_MicroVM terminates unexpectedly or is killed due to resource limits, THEN THE Sandbox_Agent SHALL release all associated resources including the TAP_Subnet and block device within 5 seconds of termination

### Requirement 16: MicroVM Snapshot Restore

**User Story:** As a developer, I want pre-warmed microVM states restored rapidly, so that the system can execute code analysis iterations without cold-start latency.

#### Acceptance Criteria

1. THE Sandbox_Agent SHALL maintain a pool of at least 2 pre-warmed microVM snapshots per configured runtime environment, where the set of configured runtime environments is defined by system configuration
2. WHEN a new sandbox execution is requested, THE Sandbox_Agent SHALL restore a pre-warmed microVM guest state using CoW_Mapping
3. THE Sandbox_Agent SHALL restore microVM guest states with a median latency of 150 milliseconds or less and a 99th-percentile latency of 500 milliseconds or less
4. WHEN a CoW_Mapping restoration fails, THE Sandbox_Agent SHALL fall back to a cold-start microVM initialization completing within 5 seconds and report the restoration failure to the system logging service
5. IF a new sandbox execution is requested and no pre-warmed microVM snapshot is available in the pool, THEN THE Sandbox_Agent SHALL initiate a cold-start microVM initialization and trigger asynchronous pool replenishment

### Requirement 17: Resource Enforcement and Circuit Breakers

**User Story:** As a developer, I want hard resource limits enforced on all sandboxed executions, so that runaway processes cannot exhaust system resources.

#### Acceptance Criteria

1. THE Sandbox_Agent SHALL enforce hypervisor-level resource caps on CPU time (configurable, maximum 300 seconds), memory allocation (configurable, maximum 2048 MB), and disk I/O (configurable, maximum 1024 MB total written) for each Firecracker_MicroVM
2. THE Sandbox_Agent SHALL enforce a hard TTL (configurable, maximum 600 seconds) on each microVM instance
3. WHEN the TTL expires on a microVM instance, THE Sandbox_Agent SHALL terminate the instance regardless of execution state
4. WHEN a microVM instance exceeds any configured resource cap, THE Circuit_Breaker SHALL terminate the instance and record the resource violation including which resource cap was exceeded and the value at time of violation
5. WHEN a Circuit_Breaker triggers, THE Sandbox_Agent SHALL release all resources held by the terminated instance within 10 seconds and notify the requesting agent of the termination reason including the violated resource type and the configured cap value
6. IF the Sandbox_Agent fails to terminate a microVM instance within 5 seconds of initiating termination, THEN THE Sandbox_Agent SHALL force-kill the instance at the hypervisor level and record a forced termination event

### Requirement 18: Configuration File Loading

**User Story:** As a developer, I want runtime behavior controlled via a `.debugger.yaml` configuration file, so that I can customize the system for different languages, projects, and environments.

#### Acceptance Criteria

1. WHEN the System starts, THE System SHALL load runtime configuration from the `.debugger.yaml` file located in the project root directory and apply all settings before accepting any agent requests
2. THE System SHALL support configuration of: language identifier, parser command, LSP command, sandbox settings (runtime, memory limit between 64 MB and 8192 MB, timeout between 1 second and 300 seconds, egress policy), oracle settings (timeout threshold between 1 second and 300 seconds, crash detection enabled or disabled, overflow detection enabled or disabled, determinism check count between 1 and 100), and PROBE_Loop parameters (search budget, maximum refinement iterations)
3. IF the `.debugger.yaml` file is missing, THEN THE System SHALL report an error message identifying the expected file path and terminate startup without accepting agent requests
4. IF the `.debugger.yaml` file contains invalid YAML syntax, THEN THE System SHALL report an error message identifying the file path and the line and column of the syntax error and terminate startup without accepting agent requests
5. IF the `.debugger.yaml` file contains a configuration value that violates the expected type or range for its key, THEN THE System SHALL report an error message identifying the key name, the provided value, and the expected type or range, and terminate startup without accepting agent requests
6. IF the `.debugger.yaml` file contains unrecognized configuration keys, THEN THE System SHALL log a warning for each unrecognized key including the key name and proceed with startup
7. IF the `.debugger.yaml` file omits an optional configuration key, THEN THE System SHALL apply the documented default value for that key and log an informational message identifying the key and the default value applied

### Requirement 19: Extensible Plug System

**User Story:** As a developer, I want four extensible plug points, so that I can integrate custom parsers, oracles, repair strategies, and sandbox executors without modifying the core system.

#### Acceptance Criteria

1. THE System SHALL expose four extensible plugs: Parsing_Plug, Oracle_Plug, Repair_Plug, and Sandbox_Executor_Plug, each with a default implementation that is active when no custom implementation is registered
2. WHEN a custom plug implementation is registered via the `.debugger.yaml` configuration file, THE System SHALL validate that the implementation exports all methods defined in the plug's interface contract with matching type signatures before activation
3. WHEN a custom plug implementation fails validation, THE System SHALL reject the registration and report which interface methods are missing or incorrectly typed
4. THE System SHALL allow up to 8 Oracle_Plug implementations to be registered and active simultaneously, executing each registered oracle on every monitored event
5. WHEN a plug implementation throws an unhandled exception during execution, THE System SHALL terminate the plug invocation, log the error with the plug name and exception details, and fall back to the default implementation within 500 milliseconds of the exception
6. WHEN a custom plug is registered for Parsing_Plug, Repair_Plug, or Sandbox_Executor_Plug, THE System SHALL deactivate the default implementation for that plug and route all operations through the custom implementation

### Requirement 20: MCP Inter-Agent Communication

**User Story:** As a system operator, I want all agents communicating over a standardized MCP protocol, so that agents can be developed, deployed, and scaled independently.

#### Acceptance Criteria

1. THE System SHALL route all inter-agent communication through MCP message channels
2. THE MCP_Middleware SHALL expose the following tools to all registered agents: read_range, get_classes_and_methods, extract_method, extract_tests, search_codebase, find_similar_api_calls, write_fix, and run_tests
3. WHEN an agent invokes an MCP tool with a valid request, THE MCP_Middleware SHALL validate the request against the tool's input schema before execution
4. IF an MCP tool request fails schema validation, THEN THE MCP_Middleware SHALL reject the request without executing the tool and SHALL return a structured error response indicating the validation failure and the originating tool name
5. WHEN an MCP tool invocation fails during execution, THE MCP_Middleware SHALL return a structured error response containing the error type, message, and the originating tool name
6. IF an MCP tool invocation does not complete within 30 seconds, THEN THE MCP_Middleware SHALL terminate the invocation and return a structured error response indicating a timeout and the originating tool name
7. THE System SHALL support at least 10 concurrent MCP tool invocations from multiple agents without data corruption or race conditions

### Requirement 21: Multi-Agent Orchestration

**User Story:** As a system operator, I want the five specialized agents orchestrated through defined phases, so that bug detection flows correctly from parsing through proving to repair.

#### Acceptance Criteria

1. THE System SHALL orchestrate the following agents in sequence for each defect investigation: Parser_Agent, Bug_Proving_Agent, Repair_Agent, Classifier_Agent, and Sandbox_Agent
2. WHEN the Parser_Agent completes semantic graph construction, THE System SHALL make the graph available to the Bug_Proving_Agent and initiate the proving phase within 5 seconds of graph completion
3. WHEN the Bug_Proving_Agent certifies a proof-of-failure, THE System SHALL forward the proof to the Repair_Agent to initiate patch generation
4. WHEN the Repair_Agent produces candidate patches, THE System SHALL route each patch (up to a maximum of 20 patches per investigation) through the Classifier_Agent for overfitting analysis before presenting results to the developer
5. THE Sandbox_Agent SHALL be available to all other agents for on-demand code execution throughout all phases, supporting up to 4 concurrent execution requests
6. IF the Bug_Proving_Agent completes analysis without certifying a proof-of-failure, THEN THE System SHALL terminate the investigation for that defect candidate and record the outcome as unconfirmed
7. IF any agent fails or becomes unresponsive during an investigation, THEN THE System SHALL halt the current investigation pipeline, report the failure to the system operator indicating which agent failed and at which phase, and preserve any intermediate results produced by previously completed phases
8. IF the Sandbox_Agent is unavailable when an agent requests code execution, THEN THE System SHALL retry the execution request up to 3 times with a 2-second interval, and if still unavailable, halt the requesting agent's current operation and report the failure to the system operator
