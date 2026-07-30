/**
 * Repair agent types for patch generation and refinement.
 */

import type { SourceLocation } from './graph.js';

export interface CodeRange {
  start_line: number;
  end_line: number;
}

export interface AstEditOperation {
  type: 'insert' | 'delete' | 'replace' | 'move';
  node_type: string;
  location: SourceLocation;
}

export interface PatchCandidate {
  id: string;
  diff: string;
  edit_operations: AstEditOperation[];
  target_file: string;
  target_range: CodeRange;
  refinement_attempt: number;
}

export interface VariableState {
  name: string;
  value: unknown;
  type: string;
}

export interface FunctionSpec {
  name: string;
  preconditions: string[];
  postconditions: string[];
  parameters: { name: string; type: string }[];
  return_type: string;
}

export interface DefectContext {
  defect_line: number;
  file_path: string;
  context_window: CodeRange;
  variable_states: VariableState[];
  specification: FunctionSpec;
}

export interface StageFeedback {
  /** The filtering stage that failed. */
  stage: 'compilation' | 'emulation' | 'test';
  /** Whether the stage passed. */
  passed: boolean;
  /** Human-readable reason for failure. */
  reason: string;
  /** Compilation diagnostic errors (file, line, message). */
  compilation_errors?: CompilationError[];
  /** Names/IDs of failing test cases. */
  failing_tests?: string[];
  /** Raw error message or stack trace from the stage. */
  error_message?: string;
}

export interface CompilationError {
  file: string;
  line: number;
  column?: number;
  message: string;
  severity: 'error' | 'warning';
}

/** Maximum number of refinement attempts allowed per patch candidate. */
export const MAX_REFINEMENT_ATTEMPTS = 3;

/** Result of a failed refinement cycle after exhausting all attempts. */
export interface RefinementExhaustedResult {
  patch_id: string;
  final_attempt: number;
  last_stage: StageFeedback['stage'];
  failure_reason: string;
}
