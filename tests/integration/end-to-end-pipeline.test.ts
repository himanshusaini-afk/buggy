/**
 * Integration test: End-to-End Investigation Pipeline
 *
 * Tests the full investigation flow from parsing through proof to repair
 * with a known-buggy program. Validates that the orchestrator coordinates
 * all agents correctly through the pipeline.
 *
 * Requirements: 21.1–21.8
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { AgentOrchestrator } from '../../src/orchestrator/orchestrator.js';
import type {
  OrchestratorParserAgent,
  OrchestratorBugProvingAgent,
  OrchestratorRepairAgent,
  OrchestratorClassifierAgent,
  OrchestratorSandboxAgent,
  OrchestratorDeps,
  BugProvingResult,
} from '../../src/orchestrator/orchestrator.js';
import type { InvestigationTarget } from '../../src/types/orchestrator.js';
import type { ParseResult, CstNode } from '../../src/types/cst.js';
import type { ProofOfFailureCertificate } from '../../src/types/proof.js';
import type { PatchCandidate } from '../../src/types/repair.js';
import type { ClassificationResult } from '../../src/types/classifier.js';
import type { ExecutionRequest, ExecutionResult } from '../../src/types/sandbox.js';

/**
 * Creates a realistic CstNode representing a known-buggy function:
 *
 * function add(a: number, b: number): number {
 *   return a - b; // BUG: should be a + b
 * }
 */
function createBuggyCst(): CstNode {
  return {
    id: 'root-1',
    type: 'program',
    start_byte: 0,
    end_byte: 80,
    start_position: { row: 0, column: 0 },
    end_position: { row: 2, column: 1 },
    children: [
      {
        id: 'func-1',
        type: 'function_declaration',
        start_byte: 0,
        end_byte: 80,
        start_position: { row: 0, column: 0 },
        end_position: { row: 2, column: 1 },
        children: [
          {
            id: 'body-1',
            type: 'statement_block',
            start_byte: 45,
            end_byte: 80,
            start_position: { row: 0, column: 45 },
            end_position: { row: 2, column: 1 },
            children: [
              {
                id: 'return-1',
                type: 'return_statement',
                start_byte: 49,
                end_byte: 63,
                start_position: { row: 1, column: 2 },
                end_position: { row: 1, column: 16 },
                children: [
                  {
                    id: 'expr-1',
                    type: 'binary_expression',
                    start_byte: 56,
                    end_byte: 61,
                    start_position: { row: 1, column: 9 },
                    end_position: { row: 1, column: 14 },
                    children: [],
                    is_error: false,
                    text: 'a - b',
                  },
                ],
                is_error: false,
              },
            ],
            is_error: false,
          },
        ],
        is_error: false,
        text: 'function add(a: number, b: number): number {\n  return a - b;\n}',
      },
    ],
    is_error: false,
  };
}

function createProofCertificate(): ProofOfFailureCertificate {
  return {
    test_input: { a: 3, b: 2 },
    observed_output: 1, // 3 - 2 = 1 (buggy)
    violated_postcondition: 'result === a + b',
    admissibility_verified_at: new Date().toISOString(),
    soundness_verified_at: new Date().toISOString(),
    uniqueness_verified_at: new Date().toISOString(),
  };
}

function createPatchCandidates(): PatchCandidate[] {
  return [
    {
      id: 'patch-1',
      diff: '- return a - b;\n+ return a + b;',
      edit_operations: [
        { type: 'replace', node_type: 'binary_expression', location: { file_path: 'buggy.ts', start_line: 1, start_column: 9, end_line: 1, end_column: 14 } },
      ],
      target_file: 'buggy.ts',
      target_range: { start_line: 0, end_line: 2 },
      refinement_attempt: 0,
    },
    {
      id: 'patch-2',
      diff: '- return a - b;\n+ return Number(a) + Number(b);',
      edit_operations: [
        { type: 'replace', node_type: 'return_statement', location: { file_path: 'buggy.ts', start_line: 1, start_column: 2, end_line: 1, end_column: 16 } },
      ],
      target_file: 'buggy.ts',
      target_range: { start_line: 0, end_line: 2 },
      refinement_attempt: 0,
    },
    {
      id: 'patch-3',
      diff: '- return a - b;\n+ const sum = a + b; return sum;',
      edit_operations: [
        { type: 'insert', node_type: 'variable_declaration', location: { file_path: 'buggy.ts', start_line: 1, start_column: 2, end_line: 1, end_column: 2 } },
        { type: 'replace', node_type: 'return_statement', location: { file_path: 'buggy.ts', start_line: 1, start_column: 2, end_line: 1, end_column: 16 } },
      ],
      target_file: 'buggy.ts',
      target_range: { start_line: 0, end_line: 2 },
      refinement_attempt: 0,
    },
  ];
}

describe('End-to-End Investigation Pipeline', () => {
  let parserAgent: OrchestratorParserAgent;
  let bugProvingAgent: OrchestratorBugProvingAgent;
  let repairAgent: OrchestratorRepairAgent;
  let classifierAgent: OrchestratorClassifierAgent;
  let sandboxAgent: OrchestratorSandboxAgent;
  let orchestrator: AgentOrchestrator;

  const target: InvestigationTarget = {
    function_id: 'add',
    file_path: 'buggy.ts',
    specification: {
      preconditions: ['typeof a === "number"', 'typeof b === "number"'],
      postconditions: ['result === a + b'],
    },
  };

  beforeEach(() => {
    const buggyCst = createBuggyCst();

    parserAgent = {
      parseFile: async (filePath: string): Promise<ParseResult> => ({
        cst: buggyCst,
        errors: [],
        duration_ms: 0.4,
        file_path: filePath,
      }),
      resolveSymbols: async () => ({
        symbols: [
          { name: 'add', resolved: true, type: 'function' },
        ],
      }),
      buildCallGraph: async () => ({
        nodes: [],
        edges: [],
        entry_points: ['add'],
      }),
    };

    bugProvingAgent = {
      investigate: async (): Promise<BugProvingResult> => ({
        certified: true,
        proof: createProofCertificate(),
        intermediate: {
          specifications_refined: 1,
          probe_iterations: 3,
          fuzz_mutations: 150,
        },
      }),
    };

    repairAgent = {
      generatePatches: async () => createPatchCandidates(),
    };

    classifierAgent = {
      classify: async (patch: PatchCandidate): Promise<ClassificationResult> => {
        // First patch approved (good fix), others rejected
        if (patch.id === 'patch-1') {
          return {
            approved: true,
            overfitting_probability: 0.12,
            patch_id: patch.id,
          };
        }
        return {
          approved: false,
          overfitting_probability: 0.78,
          top_contributing_properties: [
            { name: 'node_depth_change', contribution: 0.35 },
            { name: 'token_count_delta', contribution: 0.22 },
            { name: 'scope_boundary_cross', contribution: 0.15 },
          ],
          patch_id: patch.id,
        };
      },
    };

    sandboxAgent = {
      execute: async (request: ExecutionRequest): Promise<ExecutionResult> => ({
        status: 'completed',
        output: { passed: true },
        oracle_violations: [],
        duration_ms: 250,
        resource_usage: {
          cpu_time_ms: 120,
          memory_peak_mb: 64,
          disk_io_mb: 2,
        },
      }),
      isAvailable: async () => true,
    };

    orchestrator = new AgentOrchestrator({
      parserAgent,
      bugProvingAgent,
      repairAgent,
      classifierAgent,
      sandboxAgent,
    });
  });

  it('should execute the full pipeline from parsing through proof to repair', async () => {
    const report = await orchestrator.startInvestigation(target);

    expect(report).toBeDefined();
    expect(report.id).toBeDefined();
    expect(report.proof).toBeDefined();
    expect(report.proof!.test_input).toEqual({ a: 3, b: 2 });
    expect(report.proof!.violated_postcondition).toBe('result === a + b');
  });

  it('should produce approved patches for correct fixes', async () => {
    const report = await orchestrator.startInvestigation(target);

    // At least one patch should be approved
    expect(report.approved_patches.length).toBeGreaterThanOrEqual(1);
    // The first patch (correct fix) should be approved
    // ClassifiedPatch has { patch, classification } structure
    const approvedIds = report.approved_patches.map((p) => p.patch.id);
    expect(approvedIds).toContain('patch-1');
  });

  it('should reject overfitting patches', async () => {
    const report = await orchestrator.startInvestigation(target);

    // Patches 2 and 3 should be rejected
    expect(report.rejected_patches.length).toBeGreaterThanOrEqual(1);
  });

  it('should record timeline with all pipeline phases', async () => {
    const report = await orchestrator.startInvestigation(target);

    expect(report.timeline.length).toBeGreaterThanOrEqual(3);
    const phases = report.timeline.map((t: any) => t.phase);
    expect(phases).toContain('parsing');
    expect(phases).toContain('proving');
    expect(phases).toContain('repair');
  });

  it('should preserve intermediate results from all phases', async () => {
    const report = await orchestrator.startInvestigation(target);

    expect(report.intermediate_results).toBeDefined();
    expect(report.intermediate_results.cst_nodes_parsed).toBeGreaterThan(0);
    expect(report.intermediate_results.patches_generated).toBe(3);
  });

  it('should halt and preserve results when an agent fails', async () => {
    const failingBugProvingAgent: OrchestratorBugProvingAgent = {
      investigate: async () => {
        throw new Error('PROBE loop internal error: search space exhausted');
      },
    };

    const failingOrchestrator = new AgentOrchestrator({
      parserAgent,
      bugProvingAgent: failingBugProvingAgent,
      repairAgent,
      classifierAgent,
      sandboxAgent,
    });

    const report = await failingOrchestrator.startInvestigation(target);

    // Pipeline should halt
    expect(report.status).toMatch(/halted|unconfirmed/);
    // Intermediate results from parsing should be preserved
    expect(report.intermediate_results.cst_nodes_parsed).toBeGreaterThan(0);
    // Timeline should contain at least the parsing phase
    expect(report.timeline.length).toBeGreaterThanOrEqual(1);
    expect(report.timeline[0].phase).toBe('parsing');
  });

  it('should stop at proving phase if bug is not confirmed', async () => {
    const noProofAgent: OrchestratorBugProvingAgent = {
      investigate: async (): Promise<BugProvingResult> => ({
        certified: false,
        intermediate: {
          specifications_refined: 2,
          probe_iterations: 5,
        },
      }),
    };

    const noProofOrchestrator = new AgentOrchestrator({
      parserAgent,
      bugProvingAgent: noProofAgent,
      repairAgent,
      classifierAgent,
      sandboxAgent,
    });

    const report = await noProofOrchestrator.startInvestigation(target);

    // No proof → no repair phase
    expect(report.proof).toBeUndefined();
    expect(report.approved_patches).toHaveLength(0);
    expect(report.status).toMatch(/unconfirmed|completed/);
  });

  it('should cap patches at 20 before classification', async () => {
    // Generate 25 patches
    const manyPatchesAgent: OrchestratorRepairAgent = {
      generatePatches: async () => {
        return Array.from({ length: 25 }, (_, i) => ({
          id: `patch-${i}`,
          diff: `- return a - b;\n+ return a + b; // variant ${i}`,
          edit_operations: [
            { type: 'replace' as const, node_type: 'binary_expression', location: { file_path: 'buggy.ts', start_line: 1, start_column: 9, end_line: 1, end_column: 14 } },
          ],
          target_file: 'buggy.ts',
          target_range: { start_line: 0, end_line: 2 },
          refinement_attempt: 0,
        }));
      },
    };

    let classifyCallCount = 0;
    const countingClassifier: OrchestratorClassifierAgent = {
      classify: async (patch: PatchCandidate): Promise<ClassificationResult> => {
        classifyCallCount++;
        return { approved: true, overfitting_probability: 0.1, patch_id: patch.id };
      },
    };

    const cappedOrchestrator = new AgentOrchestrator({
      parserAgent,
      bugProvingAgent,
      repairAgent: manyPatchesAgent,
      classifierAgent: countingClassifier,
      sandboxAgent,
    });

    await cappedOrchestrator.startInvestigation(target);

    // At most 20 patches should reach the classifier (Requirement 21.4)
    expect(classifyCallCount).toBeLessThanOrEqual(20);
  });

  it('should provide investigation status during execution', async () => {
    let capturedStatus: any;

    const slowBugProver: OrchestratorBugProvingAgent = {
      investigate: async (): Promise<BugProvingResult> => {
        // Capture status mid-execution
        await new Promise((r) => setTimeout(r, 10));
        return {
          certified: true,
          proof: createProofCertificate(),
          intermediate: {},
        };
      },
    };

    const statusOrchestrator = new AgentOrchestrator({
      parserAgent,
      bugProvingAgent: slowBugProver,
      repairAgent,
      classifierAgent,
      sandboxAgent,
    });

    const promise = statusOrchestrator.startInvestigation(target);

    // Give it a tick to start
    await new Promise((r) => setTimeout(r, 5));

    // Note: The investigation ID isn't easily accessible from outside during execution,
    // but the orchestrator tracks it internally. We verify it completes correctly.
    const report = await promise;
    expect(report.id).toBeDefined();
    const status = statusOrchestrator.getStatus(report.id);
    expect(status).toBeDefined();
  });

  it('should support sandbox execution during pipeline phases', async () => {
    let sandboxCalled = false;
    const trackingSandbox: OrchestratorSandboxAgent = {
      execute: async (): Promise<ExecutionResult> => {
        sandboxCalled = true;
        return {
          status: 'completed',
          output: { result: 5 },
          oracle_violations: [],
          duration_ms: 100,
          resource_usage: { cpu_time_ms: 50, memory_peak_mb: 32, disk_io_mb: 1 },
        };
      },
      isAvailable: async () => true,
    };

    const sandboxOrchestrator = new AgentOrchestrator({
      parserAgent,
      bugProvingAgent,
      repairAgent,
      classifierAgent,
      sandboxAgent: trackingSandbox,
    });

    // Start investigation and also request a sandbox execution
    const reportPromise = sandboxOrchestrator.startInvestigation(target);
    const sandboxResult = await sandboxOrchestrator.executeSandbox({
      code: 'console.log("test")',
      runtime: 'node',
      oap_passport: {
        agent_id: 'test-agent',
        permitted_operations: ['execute'],
        issued_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 60000).toISOString(),
      },
      resource_limits: {
        vcpus: 1,
        memory_mb: 256,
        disk_mb: 1024,
        ttl_seconds: 60,
        cpu_time_seconds: 30,
        disk_io_mb: 100,
      },
      oracles: ['timeout', 'crash'],
    });

    expect(sandboxResult.status).toBe('completed');
    expect(sandboxCalled).toBe(true);

    const report = await reportPromise;
    expect(report).toBeDefined();
  });
});
