/**
 * Core type exports for the Proof-Carrying Debugger system.
 */

export type {
  DebuggerConfig,
  ParserConfig,
  LspConfig,
  SandboxConfig,
  OracleConfig,
  ProbeConfig,
  PlugConfig,
} from './config.js';

export type {
  CstNode,
  ParseResult,
  TreeSitterEdit,
  SyntaxError,
  Position,
} from './cst.js';

export type {
  SymbolResolution,
  SourceLocation,
  CallGraphResult,
  NodeRecord,
  EdgeRecord,
} from './graph.js';

export type {
  McpToolDefinition,
  McpToolResult,
  McpError,
  McpToolName,
  JsonSchema,
} from './mcp.js';

export type {
  ProofOfFailureCertificate,
  ProofCandidate,
  ProofVerificationResult,
} from './proof.js';

export type {
  PatchCandidate,
  DefectContext,
  AstEditOperation,
  CodeRange,
  StageFeedback,
  VariableState,
  FunctionSpec,
} from './repair.js';

export type {
  AstDifferenceVector,
  SemanticFeatureVector,
  ClassificationResult,
  AstProperty,
} from './classifier.js';

export type {
  ExecutionRequest,
  ExecutionResult,
  ResourceLimits,
  OapPassport,
  OracleViolation,
  OracleType,
  ResourceUsage,
  TimeoutDetails,
  CrashDetails,
  DeterminismDetails,
  OverflowDetails,
} from './sandbox.js';

export type {
  InvestigationReport,
  InvestigationStatus,
  PhaseTimestamp,
  IntermediateResults,
  InvestigationTarget,
  ClassifiedPatch,
  RejectedPatch,
} from './orchestrator.js';

export type {
  ParsingPlug,
  OraclePlug,
  RepairPlug,
  SandboxExecutorPlug,
  PlugRegistry,
  ValidationResult,
  ExecutionStep,
} from './plugs.js';

export type {
  BackwardSlice,
  SliceStatement,
  CapturedVariable,
  DefectLine,
  DivergentVariable,
} from './slicing.js';

export type {
  Mutation,
  FuzzResult,
  FuzzViolation,
} from './fuzzing.js';

export type {
  Postcondition,
  SpecTuneResult,
  AlphaConsistency,
} from './spectune.js';

export type {
  CandidateProperty,
  ProbeResult,
  ProbeRefinement,
} from './probe.js';
