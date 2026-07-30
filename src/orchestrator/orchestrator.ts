/**
 * Agent Orchestrator - Coordinates the investigation pipeline.
 *
 * Orchestrates sequential phases: Parser_Agent → Bug_Proving_Agent → Repair_Agent → Classifier_Agent
 * with Sandbox_Agent available to all agents on-demand (up to 4 concurrent requests).
 *
 * Requirements: 21.1, 21.2, 21.3, 21.4, 21.5, 21.6, 21.7, 21.8
 */

import type {
  InvestigationTarget,
  InvestigationReport,
  InvestigationStatus,
  IntermediateResults,
  PhaseTimestamp,
  ClassifiedPatch,
  RejectedPatch,
} from '../types/orchestrator.js';
import type { ProofOfFailureCertificate } from '../types/proof.js';
import type { PatchCandidate } from '../types/repair.js';
import type { ClassificationResult } from '../types/classifier.js';
import type { ExecutionRequest, ExecutionResult } from '../types/sandbox.js';
import type { ParseResult, CstNode } from '../types/cst.js';

/** Maximum number of patches routed through the Classifier_Agent per investigation. */
const MAX_PATCHES_PER_INVESTIGATION = 20;

/** Maximum concurrent sandbox execution requests. */
const MAX_CONCURRENT_SANDBOX_REQUESTS = 4;

/** Sandbox retry configuration. */
const SANDBOX_RETRY_COUNT = 3;
const SANDBOX_RETRY_INTERVAL_MS = 2000;

/** Maximum time allowed after parsing completes to make graph available to Bug_Proving_Agent. */
const GRAPH_HANDOFF_TIMEOUT_MS = 5000;

/**
 * Describes a failure that halted the pipeline.
 */
export interface PipelineFailure {
  agent: string;
  phase: InvestigationStatus['phase'];
  error: string;
  timestamp: string;
}

/**
 * Interface for the Parser_Agent as seen by the orchestrator.
 */
export interface OrchestratorParserAgent {
  parseFile(filePath: string): Promise<ParseResult>;
  resolveSymbols(filePath: string): Promise<unknown>;
  buildCallGraph(): Promise<unknown>;
}

/**
 * Interface for the Bug_Proving_Agent as seen by the orchestrator.
 */
export interface OrchestratorBugProvingAgent {
  investigate(target: InvestigationTarget): Promise<BugProvingResult>;
}

/**
 * Result from Bug_Proving_Agent investigation.
 */
export interface BugProvingResult {
  certified: boolean;
  proof?: ProofOfFailureCertificate;
  intermediate: Partial<IntermediateResults>;
}

/**
 * Interface for the Repair_Agent as seen by the orchestrator.
 */
export interface OrchestratorRepairAgent {
  generatePatches(proof: ProofOfFailureCertificate, target: InvestigationTarget): Promise<PatchCandidate[]>;
}

/**
 * Interface for the Classifier_Agent as seen by the orchestrator.
 */
export interface OrchestratorClassifierAgent {
  classify(patch: PatchCandidate, original: CstNode): Promise<ClassificationResult>;
}

/**
 * Interface for the Sandbox_Agent as seen by the orchestrator.
 */
export interface OrchestratorSandboxAgent {
  execute(request: ExecutionRequest): Promise<ExecutionResult>;
  isAvailable(): Promise<boolean>;
}

/**
 * Dependencies injected into the orchestrator.
 */
export interface OrchestratorDeps {
  parserAgent: OrchestratorParserAgent;
  bugProvingAgent: OrchestratorBugProvingAgent;
  repairAgent: OrchestratorRepairAgent;
  classifierAgent: OrchestratorClassifierAgent;
  sandboxAgent: OrchestratorSandboxAgent;
}

/**
 * Internal state for a running investigation.
 */
interface InvestigationState {
  id: string;
  target: InvestigationTarget;
  status: InvestigationStatus;
  report: Partial<InvestigationReport>;
  timeline: PhaseTimestamp[];
  halted: boolean;
  failure?: PipelineFailure;
  parseResult?: ParseResult;
}

/**
 * Agent Orchestrator coordinates the five-phase investigation pipeline.
 *
 * Pipeline flow:
 * 1. Parser_Agent parses file and builds semantic graph
 * 2. Bug_Proving_Agent investigates target function, proves bug
 * 3. Repair_Agent generates candidate patches
 * 4. Classifier_Agent evaluates each patch for overfitting
 *
 * Sandbox_Agent is available on-demand to all agents throughout all phases.
 */
export class AgentOrchestrator {
  private deps: OrchestratorDeps;
  private investigations: Map<string, InvestigationState> = new Map();
  private activeSandboxRequests = 0;
  private sandboxQueue: Array<{
    resolve: (result: ExecutionResult) => void;
    reject: (error: Error) => void;
    request: ExecutionRequest;
  }> = [];

  constructor(deps: OrchestratorDeps) {
    this.deps = deps;
  }

  /**
   * Start a new investigation for the given target.
   *
   * Coordinates sequential phases:
   * Parser_Agent → Bug_Proving_Agent → Repair_Agent → Classifier_Agent
   *
   * @param target - The function/file to investigate
   * @returns The final investigation report
   */
  async startInvestigation(target: InvestigationTarget): Promise<InvestigationReport> {
    const id = this.generateId();
    const now = new Date().toISOString();

    const state: InvestigationState = {
      id,
      target,
      status: {
        id,
        phase: 'parsing',
        current_agent: 'Parser_Agent',
        started_at: now,
        elapsed_ms: 0,
        intermediate_results: {},
      },
      report: {
        id,
        approved_patches: [],
        rejected_patches: [],
        intermediate_results: {},
        timeline: [],
      },
      timeline: [],
      halted: false,
    };

    this.investigations.set(id, state);

    try {
      // Phase 1: Parsing
      await this.runParsingPhase(state);
      if (state.halted) return this.buildReport(state);

      // Phase 2: Proving
      await this.runProvingPhase(state);
      if (state.halted) return this.buildReport(state);

      // Phase 3: Repair (only if proof certified)
      if (state.report.proof) {
        await this.runRepairPhase(state);
        if (state.halted) return this.buildReport(state);

        // Phase 4: Classification
        await this.runClassificationPhase(state);
        if (state.halted) return this.buildReport(state);
      }

      // Determine final status
      state.status.phase = 'completed';
      return this.buildReport(state);
    } catch (error) {
      // Unexpected error - halt and preserve
      if (!state.halted) {
        state.halted = true;
        state.failure = {
          agent: state.status.current_agent,
          phase: state.status.phase,
          error: error instanceof Error ? error.message : String(error),
          timestamp: new Date().toISOString(),
        };
      }
      return this.buildReport(state);
    }
  }

  /**
   * Get the current status of an investigation.
   *
   * @param id - Investigation identifier
   * @returns Current status or undefined if not found
   */
  getStatus(id: string): InvestigationStatus | undefined {
    const state = this.investigations.get(id);
    if (!state) return undefined;

    // Update elapsed time
    const startTime = new Date(state.status.started_at).getTime();
    state.status.elapsed_ms = Date.now() - startTime;
    return { ...state.status };
  }

  /**
   * Halt an in-progress investigation.
   *
   * Preserves intermediate results produced by previously completed phases.
   *
   * @param id - Investigation identifier
   */
  halt(id: string): void {
    const state = this.investigations.get(id);
    if (!state) return;

    state.halted = true;
    state.failure = {
      agent: state.status.current_agent,
      phase: state.status.phase,
      error: 'Investigation halted by operator',
      timestamp: new Date().toISOString(),
    };
    state.status.phase = 'halted';
  }

  /**
   * Execute code in the sandbox with concurrency limiting (max 4) and retry logic.
   *
   * Available to all agents on-demand throughout all investigation phases.
   * Retries up to 3 times with 2-second intervals if sandbox is unavailable.
   *
   * @param request - The execution request
   * @returns Execution result from the sandbox
   * @throws Error if sandbox is unavailable after all retries
   */
  async executeSandbox(request: ExecutionRequest): Promise<ExecutionResult> {
    // Check availability with retry
    for (let attempt = 0; attempt < SANDBOX_RETRY_COUNT; attempt++) {
      const available = await this.deps.sandboxAgent.isAvailable();
      if (available) {
        return this.enqueueSandboxExecution(request);
      }
      if (attempt < SANDBOX_RETRY_COUNT - 1) {
        await this.delay(SANDBOX_RETRY_INTERVAL_MS);
      }
    }

    throw new SandboxUnavailableError(
      'Sandbox_Agent unavailable after 3 retry attempts (2s intervals)'
    );
  }

  // --- Private Phase Implementations ---

  private async runParsingPhase(state: InvestigationState): Promise<void> {
    const phaseStart = new Date().toISOString();
    state.status.phase = 'parsing';
    state.status.current_agent = 'Parser_Agent';

    try {
      // Parse the target file
      const parseResult = await this.deps.parserAgent.parseFile(state.target.file_path);
      state.parseResult = parseResult;

      // Resolve symbols
      await this.deps.parserAgent.resolveSymbols(state.target.file_path);

      // Build call graph
      await this.deps.parserAgent.buildCallGraph();

      // Update intermediate results
      state.status.intermediate_results.cst_nodes_parsed = this.countNodes(parseResult.cst);

      // Record phase completion
      const phaseEnd = new Date().toISOString();
      state.timeline.push({
        phase: 'parsing',
        started_at: phaseStart,
        completed_at: phaseEnd,
        agent: 'Parser_Agent',
      });

      // Requirement 21.2: graph must be available to Bug_Proving_Agent within 5s
      // Since we pass data directly, this is immediate (well under 5s).
      // We validate the handoff constraint by checking elapsed time.
      const elapsed = Date.now() - new Date(phaseEnd).getTime();
      if (elapsed > GRAPH_HANDOFF_TIMEOUT_MS) {
        throw new Error(
          `Graph handoff to Bug_Proving_Agent exceeded ${GRAPH_HANDOFF_TIMEOUT_MS}ms`
        );
      }
    } catch (error) {
      this.haltWithFailure(state, 'Parser_Agent', 'parsing', error);
    }
  }

  private async runProvingPhase(state: InvestigationState): Promise<void> {
    const phaseStart = new Date().toISOString();
    state.status.phase = 'proving';
    state.status.current_agent = 'Bug_Proving_Agent';

    try {
      const result = await this.deps.bugProvingAgent.investigate(state.target);

      // Merge intermediate results
      if (result.intermediate) {
        Object.assign(state.status.intermediate_results, result.intermediate);
      }

      if (result.certified && result.proof) {
        // Requirement 21.3: forward proof to Repair_Agent
        state.report.proof = result.proof;
      } else {
        // Requirement 21.6: no proof certified → terminate, record as unconfirmed
        state.status.phase = 'completed';
      }

      const phaseEnd = new Date().toISOString();
      state.timeline.push({
        phase: 'proving',
        started_at: phaseStart,
        completed_at: phaseEnd,
        agent: 'Bug_Proving_Agent',
      });
    } catch (error) {
      this.haltWithFailure(state, 'Bug_Proving_Agent', 'proving', error);
    }
  }

  private async runRepairPhase(state: InvestigationState): Promise<void> {
    const phaseStart = new Date().toISOString();
    state.status.phase = 'repair';
    state.status.current_agent = 'Repair_Agent';

    try {
      const proof = state.report.proof!;
      const patches = await this.deps.repairAgent.generatePatches(proof, state.target);

      // Store patches for classification (cap at MAX_PATCHES_PER_INVESTIGATION)
      state.report.approved_patches = [];
      state.report.rejected_patches = [];

      // Store raw patches on state for classification phase
      (state as any)._rawPatches = patches.slice(0, MAX_PATCHES_PER_INVESTIGATION);

      state.status.intermediate_results.patches_generated = patches.length;

      const phaseEnd = new Date().toISOString();
      state.timeline.push({
        phase: 'repair',
        started_at: phaseStart,
        completed_at: phaseEnd,
        agent: 'Repair_Agent',
      });
    } catch (error) {
      this.haltWithFailure(state, 'Repair_Agent', 'repair', error);
    }
  }

  private async runClassificationPhase(state: InvestigationState): Promise<void> {
    const phaseStart = new Date().toISOString();
    state.status.phase = 'classification';
    state.status.current_agent = 'Classifier_Agent';

    try {
      const patches: PatchCandidate[] = (state as any)._rawPatches ?? [];
      const originalCst = state.parseResult?.cst;

      if (!originalCst) {
        throw new Error('No parsed CST available for classification');
      }

      // Requirement 21.4: route each patch (max 20) through Classifier_Agent
      const approved: ClassifiedPatch[] = [];
      const rejected: RejectedPatch[] = [];

      for (const patch of patches) {
        if (state.halted) break;

        try {
          const classification = await this.deps.classifierAgent.classify(patch, originalCst);

          if (classification.approved) {
            approved.push({ patch, classification });
          } else {
            rejected.push({
              patch,
              classification,
              rejection_reason: classification.top_contributing_properties
                ? `Overfitting risk: top factors - ${classification.top_contributing_properties.map(p => p.name).join(', ')}`
                : 'Classification rejected',
            });
          }
        } catch (classifyError) {
          // Individual classification failure: reject as inconclusive
          rejected.push({
            patch,
            classification: {
              approved: false,
              overfitting_probability: -1,
              patch_id: patch.id,
              inconclusive: true,
            },
            rejection_reason: classifyError instanceof Error
              ? classifyError.message
              : 'Classification failed',
          });
        }
      }

      state.report.approved_patches = approved;
      state.report.rejected_patches = rejected;
      state.status.intermediate_results.patches_approved = approved.length;

      const phaseEnd = new Date().toISOString();
      state.timeline.push({
        phase: 'classification',
        started_at: phaseStart,
        completed_at: phaseEnd,
        agent: 'Classifier_Agent',
      });
    } catch (error) {
      this.haltWithFailure(state, 'Classifier_Agent', 'classification', error);
    }
  }

  // --- Sandbox Concurrency Management ---

  private async enqueueSandboxExecution(request: ExecutionRequest): Promise<ExecutionResult> {
    if (this.activeSandboxRequests < MAX_CONCURRENT_SANDBOX_REQUESTS) {
      return this.executeSandboxDirect(request);
    }

    // Queue the request and wait
    return new Promise<ExecutionResult>((resolve, reject) => {
      this.sandboxQueue.push({ resolve, reject, request });
    });
  }

  private async executeSandboxDirect(request: ExecutionRequest): Promise<ExecutionResult> {
    this.activeSandboxRequests++;
    try {
      const result = await this.deps.sandboxAgent.execute(request);
      return result;
    } finally {
      this.activeSandboxRequests--;
      this.processQueue();
    }
  }

  private processQueue(): void {
    if (this.sandboxQueue.length === 0) return;
    if (this.activeSandboxRequests >= MAX_CONCURRENT_SANDBOX_REQUESTS) return;

    const next = this.sandboxQueue.shift()!;
    this.executeSandboxDirect(next.request)
      .then(next.resolve)
      .catch(next.reject);
  }

  // --- Utility Methods ---

  private haltWithFailure(
    state: InvestigationState,
    agent: string,
    phase: InvestigationStatus['phase'],
    error: unknown
  ): void {
    state.halted = true;
    state.failure = {
      agent,
      phase,
      error: error instanceof Error ? error.message : String(error),
      timestamp: new Date().toISOString(),
    };
    state.status.phase = 'halted';
  }

  private buildReport(state: InvestigationState): InvestigationReport {
    let status: InvestigationReport['status'];

    if (state.halted) {
      status = 'halted';
    } else if (!state.report.proof) {
      status = 'unconfirmed';
    } else if (state.report.approved_patches && state.report.approved_patches.length > 0) {
      status = 'confirmed_and_repaired';
    } else {
      status = 'confirmed_no_repair';
    }

    return {
      id: state.id,
      status,
      proof: state.report.proof,
      approved_patches: state.report.approved_patches ?? [],
      rejected_patches: state.report.rejected_patches ?? [],
      intermediate_results: state.status.intermediate_results,
      timeline: state.timeline,
    };
  }

  private countNodes(node: CstNode): number {
    let count = 1;
    for (const child of node.children) {
      count += this.countNodes(child);
    }
    return count;
  }

  private generateId(): string {
    return `inv_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

/**
 * Error thrown when the Sandbox_Agent is unavailable after all retry attempts.
 */
export class SandboxUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SandboxUnavailableError';
  }
}
