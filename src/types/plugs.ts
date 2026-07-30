/**
 * Plug system types for extensible component interfaces.
 */

import type { CstNode, TreeSitterEdit } from './cst.js';
import type { OracleViolation } from './sandbox.js';
import type { ExecutionRequest, ExecutionResult } from './sandbox.js';
import type { SandboxConfig } from './config.js';
import type { DefectContext, PatchCandidate, StageFeedback } from './repair.js';

export interface ExecutionStep {
  statement_index: number;
  source_location: { line: number; column: number };
  variables: Record<string, unknown>;
  call_stack_depth: number;
}

export interface ParsingPlug {
  parse(source: string, filePath: string): Promise<CstNode>;
  parseIncremental(source: string, edit: TreeSitterEdit, previousTree: CstNode): Promise<CstNode>;
}

export interface OraclePlug {
  name: string;
  monitor(executionStep: ExecutionStep): Promise<OracleViolation | null>;
  onFailure(): void;
}

export interface RepairPlug {
  generateCandidates(context: DefectContext): Promise<PatchCandidate[]>;
  refine(patch: PatchCandidate, feedback: StageFeedback): Promise<PatchCandidate>;
}

export interface SandboxExecutorPlug {
  execute(request: ExecutionRequest): Promise<ExecutionResult>;
  configure(config: SandboxConfig): Promise<void>;
}

export interface ValidationResult {
  valid: boolean;
  missing_methods?: string[];
  type_mismatches?: string[];
}

export interface PlugRegistry {
  registerParsing(plug: ParsingPlug): void;
  registerOracle(plug: OraclePlug): void;
  registerRepair(plug: RepairPlug): void;
  registerSandboxExecutor(plug: SandboxExecutorPlug): void;
  validate(plug: unknown, interfaceName: string): ValidationResult;
}
