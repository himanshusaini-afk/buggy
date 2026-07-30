/**
 * Agent orchestrator types for investigation pipeline coordination.
 */

import type { ProofOfFailureCertificate } from './proof.js';
import type { ClassificationResult } from './classifier.js';
import type { PatchCandidate } from './repair.js';
import type { FunctionSpec } from './repair.js';

export interface InvestigationTarget {
  function_id: string;
  file_path: string;
  specification: FunctionSpec;
}

export type InvestigationStatus = {
  id: string;
  phase: 'parsing' | 'proving' | 'repair' | 'classification' | 'completed' | 'halted';
  current_agent: string;
  started_at: string;
  elapsed_ms: number;
  intermediate_results: IntermediateResults;
};

export interface IntermediateResults {
  cst_nodes_parsed?: number;
  symbols_resolved?: number;
  specifications_refined?: number;
  probe_iterations?: number;
  fuzz_mutations?: number;
  patches_generated?: number;
  patches_approved?: number;
}

export interface PhaseTimestamp {
  phase: 'parsing' | 'proving' | 'repair' | 'classification';
  started_at: string;
  completed_at: string;
  agent: string;
}

export interface ClassifiedPatch {
  patch: PatchCandidate;
  classification: ClassificationResult;
}

export interface RejectedPatch {
  patch: PatchCandidate;
  classification: ClassificationResult;
  rejection_reason: string;
}

export interface InvestigationReport {
  id: string;
  status: 'confirmed_and_repaired' | 'confirmed_no_repair' | 'unconfirmed' | 'halted';
  proof?: ProofOfFailureCertificate;
  approved_patches: ClassifiedPatch[];
  rejected_patches: RejectedPatch[];
  intermediate_results: IntermediateResults;
  timeline: PhaseTimestamp[];
}
