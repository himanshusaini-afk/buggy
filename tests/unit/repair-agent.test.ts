/**
 * Unit tests for RepairAgent
 *
 * Covers:
 * - Patch generation with ≥3 structurally distinct candidates per defect
 * - MCP tool usage (read_range, extract_method, write_fix)
 * - Refinement retry exhaustion at max 3 attempts
 * - Pipeline stage failure handling (stage name + reason)
 * - Stage time reporting (elapsed time) on failure
 *
 * Requirements: 12.1–12.5, 13.1–13.5
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { RepairAgent, CONTEXT_WINDOW_RADIUS, MIN_PATCHES_PER_DEFECT } from '../../src/agents/repair-agent.js';
import { McpRouter } from '../../src/middleware/mcp-router.js';
import type { ProofOfFailureCertificate } from '../../src/types/proof.js';
import type { DefectContext, PatchCandidate, StageFeedback, RefinementExhaustedResult } from '../../src/types/repair.js';
import { MAX_REFINEMENT_ATTEMPTS } from '../../src/types/repair.js';
import type { McpToolResult } from '../../src/types/mcp.js';

function createMockRouter(): McpRouter {
  const router = new McpRouter();

  // Register read_range returning sample code lines
  router.registerTool({
    name: 'read_range',
    description: 'Read a range of lines from a source file',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        start_line: { type: 'integer' },
        end_line: { type: 'integer' },
      },
      required: ['file_path', 'start_line', 'end_line'],
    },
    handler: async (params: unknown): Promise<McpToolResult> => {
      const { start_line, end_line } = params as { start_line: number; end_line: number };
      const lines: string[] = [];
      for (let i = start_line; i <= end_line; i++) {
        if (i === 15) {
          lines.push('  const result = value * factor;');
        } else if (i === 14) {
          lines.push('  const factor = getFactor(input);');
        } else if (i === 16) {
          lines.push('  return result + offset;');
        } else {
          lines.push(`  // line ${i}`);
        }
      }
      return { success: true, data: { lines } };
    },
  });

  // Register extract_method returning a method body
  router.registerTool({
    name: 'extract_method',
    description: 'Extract a specific method body',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        method_name: { type: 'string' },
      },
      required: ['file_path', 'method_name'],
    },
    handler: async (_params: unknown): Promise<McpToolResult> => {
      return {
        success: true,
        data: {
          content: 'function compute(value: number, input: string): number {\n  const factor = getFactor(input);\n  const result = value * factor;\n  return result + offset;\n}',
        },
      };
    },
  });

  // Register write_fix accepting patch writes
  router.registerTool({
    name: 'write_fix',
    description: 'Write a code fix to a source file',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        start_line: { type: 'integer' },
        end_line: { type: 'integer' },
        new_content: { type: 'string' },
      },
      required: ['file_path', 'start_line', 'end_line', 'new_content'],
    },
    handler: async (_params: unknown): Promise<McpToolResult> => {
      return { success: true, data: { written: true } };
    },
  });

  return router;
}

function createProof(): ProofOfFailureCertificate {
  return {
    test_input: { value: 10, input: 'test' },
    observed_output: -5,
    violated_postcondition: 'result >= 0',
    admissibility_verified_at: '2024-01-01T00:00:00Z',
    soundness_verified_at: '2024-01-01T00:00:01Z',
    uniqueness_verified_at: '2024-01-01T00:00:02Z',
  };
}

function createContext(): DefectContext {
  return {
    defect_line: 15,
    file_path: '/project/src/compute.ts',
    context_window: { start_line: 5, end_line: 25 },
    variable_states: [
      { name: 'value', value: 10, type: 'number' },
      { name: 'factor', value: -0.5, type: 'number' },
    ],
    specification: {
      name: 'compute',
      preconditions: ['value >= 0'],
      postconditions: ['result >= 0'],
      parameters: [
        { name: 'value', type: 'number' },
        { name: 'input', type: 'string' },
      ],
      return_type: 'number',
    },
  };
}

describe('RepairAgent', () => {
  let agent: RepairAgent;

  beforeEach(() => {
    const router = createMockRouter();
    agent = new RepairAgent(router);
  });

  describe('generatePatches', () => {
    it('should generate at least 3 candidate patches', async () => {
      const patches = await agent.generatePatches(createProof(), createContext());
      expect(patches.length).toBeGreaterThanOrEqual(MIN_PATCHES_PER_DEFECT);
    });

    it('should produce patches with unique IDs', async () => {
      const patches = await agent.generatePatches(createProof(), createContext());
      const ids = patches.map((p) => p.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(ids.length);
    });

    it('should produce structurally distinct patches (different node types or locations)', async () => {
      const patches = await agent.generatePatches(createProof(), createContext());

      for (let i = 0; i < patches.length; i++) {
        for (let j = i + 1; j < patches.length; j++) {
          const a = patches[i].edit_operations[0];
          const b = patches[j].edit_operations[0];

          // At least one of node_type or location must differ
          const sameNodeType = a.node_type === b.node_type;
          const sameLocation = a.location.start_line === b.location.start_line;
          expect(sameNodeType && sameLocation).toBe(false);
        }
      }
    });

    it('should target patches within defect line ±10 context window', async () => {
      const context = createContext();
      const patches = await agent.generatePatches(createProof(), context);

      const minLine = context.defect_line - CONTEXT_WINDOW_RADIUS;
      const maxLine = context.defect_line + CONTEXT_WINDOW_RADIUS;

      for (const patch of patches) {
        expect(patch.target_range.start_line).toBeGreaterThanOrEqual(minLine);
        expect(patch.target_range.end_line).toBeLessThanOrEqual(maxLine);
      }
    });

    it('should set target_file to the defect file path', async () => {
      const context = createContext();
      const patches = await agent.generatePatches(createProof(), context);

      for (const patch of patches) {
        expect(patch.target_file).toBe(context.file_path);
      }
    });

    it('should have refinement_attempt set to 0 for new patches', async () => {
      const patches = await agent.generatePatches(createProof(), createContext());

      for (const patch of patches) {
        expect(patch.refinement_attempt).toBe(0);
      }
    });

    it('should include non-empty diff content', async () => {
      const patches = await agent.generatePatches(createProof(), createContext());

      for (const patch of patches) {
        expect(patch.diff.length).toBeGreaterThan(0);
      }
    });

    it('should include at least one edit operation per patch', async () => {
      const patches = await agent.generatePatches(createProof(), createContext());

      for (const patch of patches) {
        expect(patch.edit_operations.length).toBeGreaterThanOrEqual(1);
      }
    });
  });

  describe('computeContextWindow', () => {
    it('should compute ±10 lines around defect line', () => {
      const context = createContext();
      const window = agent.computeContextWindow(context);

      expect(window.start_line).toBe(context.defect_line - CONTEXT_WINDOW_RADIUS);
      expect(window.end_line).toBe(context.defect_line + CONTEXT_WINDOW_RADIUS);
    });

    it('should clamp start_line to minimum of 1', () => {
      const context = { ...createContext(), defect_line: 3 };
      const window = agent.computeContextWindow(context);

      expect(window.start_line).toBe(1);
      expect(window.end_line).toBe(13);
    });
  });

  describe('MCP tool usage', () => {
    it('should invoke read_range via MCP router', async () => {
      let readRangeCalled = false;
      const router = new McpRouter();

      router.registerTool({
        name: 'read_range',
        description: 'Read a range of lines',
        inputSchema: {
          type: 'object',
          properties: {
            file_path: { type: 'string' },
            start_line: { type: 'integer' },
            end_line: { type: 'integer' },
          },
          required: ['file_path', 'start_line', 'end_line'],
        },
        handler: async (params: unknown): Promise<McpToolResult> => {
          readRangeCalled = true;
          const { start_line, end_line } = params as { start_line: number; end_line: number };
          const lines = [];
          for (let i = start_line; i <= end_line; i++) {
            lines.push(`  const x = ${i};`);
          }
          return { success: true, data: { lines } };
        },
      });

      router.registerTool({
        name: 'extract_method',
        description: 'Extract method',
        inputSchema: { type: 'object', properties: { file_path: { type: 'string' }, method_name: { type: 'string' } }, required: ['file_path', 'method_name'] },
        handler: async (): Promise<McpToolResult> => ({ success: true, data: { content: '' } }),
      });

      router.registerTool({
        name: 'write_fix',
        description: 'Write fix',
        inputSchema: { type: 'object', properties: { file_path: { type: 'string' }, start_line: { type: 'integer' }, end_line: { type: 'integer' }, new_content: { type: 'string' } }, required: ['file_path', 'start_line', 'end_line', 'new_content'] },
        handler: async (): Promise<McpToolResult> => ({ success: true, data: { written: true } }),
      });

      const testAgent = new RepairAgent(router);
      await testAgent.generatePatches(createProof(), createContext());

      expect(readRangeCalled).toBe(true);
    });

    it('should invoke write_fix for each generated patch', async () => {
      let writeFixCount = 0;
      const router = new McpRouter();

      router.registerTool({
        name: 'read_range',
        description: 'Read range',
        inputSchema: { type: 'object', properties: { file_path: { type: 'string' }, start_line: { type: 'integer' }, end_line: { type: 'integer' } }, required: ['file_path', 'start_line', 'end_line'] },
        handler: async (params: unknown): Promise<McpToolResult> => {
          const { start_line, end_line } = params as { start_line: number; end_line: number };
          const lines = [];
          for (let i = start_line; i <= end_line; i++) {
            lines.push(`  const x = value + ${i};`);
          }
          return { success: true, data: { lines } };
        },
      });

      router.registerTool({
        name: 'extract_method',
        description: 'Extract method',
        inputSchema: { type: 'object', properties: { file_path: { type: 'string' }, method_name: { type: 'string' } }, required: ['file_path', 'method_name'] },
        handler: async (): Promise<McpToolResult> => ({ success: true, data: { content: '' } }),
      });

      router.registerTool({
        name: 'write_fix',
        description: 'Write fix',
        inputSchema: { type: 'object', properties: { file_path: { type: 'string' }, start_line: { type: 'integer' }, end_line: { type: 'integer' }, new_content: { type: 'string' } }, required: ['file_path', 'start_line', 'end_line', 'new_content'] },
        handler: async (): Promise<McpToolResult> => {
          writeFixCount++;
          return { success: true, data: { written: true } };
        },
      });

      const testAgent = new RepairAgent(router);
      const patches = await testAgent.generatePatches(createProof(), createContext());

      expect(writeFixCount).toBe(patches.length);
    });

    it('should invoke extract_method via MCP router with correct params', async () => {
      let extractMethodCalled = false;
      let extractMethodParams: unknown = null;
      const router = new McpRouter();

      router.registerTool({
        name: 'read_range',
        description: 'Read range',
        inputSchema: { type: 'object', properties: { file_path: { type: 'string' }, start_line: { type: 'integer' }, end_line: { type: 'integer' } }, required: ['file_path', 'start_line', 'end_line'] },
        handler: async (params: unknown): Promise<McpToolResult> => {
          const { start_line, end_line } = params as { start_line: number; end_line: number };
          const lines = [];
          for (let i = start_line; i <= end_line; i++) {
            lines.push(`  const x = ${i};`);
          }
          return { success: true, data: { lines } };
        },
      });

      router.registerTool({
        name: 'extract_method',
        description: 'Extract method',
        inputSchema: { type: 'object', properties: { file_path: { type: 'string' }, method_name: { type: 'string' } }, required: ['file_path', 'method_name'] },
        handler: async (params: unknown): Promise<McpToolResult> => {
          extractMethodCalled = true;
          extractMethodParams = params;
          return { success: true, data: { content: 'function compute() {}' } };
        },
      });

      router.registerTool({
        name: 'write_fix',
        description: 'Write fix',
        inputSchema: { type: 'object', properties: { file_path: { type: 'string' }, start_line: { type: 'integer' }, end_line: { type: 'integer' }, new_content: { type: 'string' } }, required: ['file_path', 'start_line', 'end_line', 'new_content'] },
        handler: async (): Promise<McpToolResult> => ({ success: true, data: { written: true } }),
      });

      const testAgent = new RepairAgent(router);
      const context = createContext();
      await testAgent.generatePatches(createProof(), context);

      expect(extractMethodCalled).toBe(true);
      const params = extractMethodParams as { file_path: string; method_name: string };
      expect(params.file_path).toBe(context.file_path);
      expect(params.method_name).toBe(context.specification.name);
    });

    it('should pass correct read_range params matching context window', async () => {
      let readRangeParams: { file_path: string; start_line: number; end_line: number } | null = null;
      const router = new McpRouter();

      router.registerTool({
        name: 'read_range',
        description: 'Read range',
        inputSchema: { type: 'object', properties: { file_path: { type: 'string' }, start_line: { type: 'integer' }, end_line: { type: 'integer' } }, required: ['file_path', 'start_line', 'end_line'] },
        handler: async (params: unknown): Promise<McpToolResult> => {
          if (!readRangeParams) {
            readRangeParams = params as { file_path: string; start_line: number; end_line: number };
          }
          const { start_line, end_line } = params as { start_line: number; end_line: number };
          const lines = [];
          for (let i = start_line; i <= end_line; i++) {
            lines.push(`  const x = ${i};`);
          }
          return { success: true, data: { lines } };
        },
      });

      router.registerTool({
        name: 'extract_method',
        description: 'Extract method',
        inputSchema: { type: 'object', properties: { file_path: { type: 'string' }, method_name: { type: 'string' } }, required: ['file_path', 'method_name'] },
        handler: async (): Promise<McpToolResult> => ({ success: true, data: { content: '' } }),
      });

      router.registerTool({
        name: 'write_fix',
        description: 'Write fix',
        inputSchema: { type: 'object', properties: { file_path: { type: 'string' }, start_line: { type: 'integer' }, end_line: { type: 'integer' }, new_content: { type: 'string' } }, required: ['file_path', 'start_line', 'end_line', 'new_content'] },
        handler: async (): Promise<McpToolResult> => ({ success: true, data: { written: true } }),
      });

      const testAgent = new RepairAgent(router);
      const context = createContext();
      await testAgent.generatePatches(createProof(), context);

      expect(readRangeParams).not.toBeNull();
      expect(readRangeParams!.file_path).toBe(context.file_path);
      expect(readRangeParams!.start_line).toBe(context.defect_line - CONTEXT_WINDOW_RADIUS);
      expect(readRangeParams!.end_line).toBe(context.defect_line + CONTEXT_WINDOW_RADIUS);
    });
  });

  describe('refinement retry exhaustion', () => {
    it('should throw RefinementExhaustedResult when refinement_attempt reaches MAX_REFINEMENT_ATTEMPTS (3)', async () => {
      const patch: PatchCandidate = {
        id: 'patch-exhaust-001',
        diff: '  if (x != null) { return x; }',
        edit_operations: [{
          type: 'insert',
          node_type: 'if_statement',
          location: { file_path: '/project/src/compute.ts', start_line: 15, start_column: 0, end_line: 15, end_column: 0 },
        }],
        target_file: '/project/src/compute.ts',
        target_range: { start_line: 15, end_line: 15 },
        refinement_attempt: 3,
      };

      const feedback: StageFeedback = {
        stage: 'compilation',
        passed: false,
        reason: 'Type error persists',
        error_message: 'Cannot resolve symbol',
      };

      try {
        await agent.refinePatch(patch, feedback);
        expect.fail('Should have thrown RefinementExhaustedResult');
      } catch (error) {
        const result = error as RefinementExhaustedResult;
        expect(result.patch_id).toBe('patch-exhaust-001');
        expect(result.final_attempt).toBe(3);
        expect(result.last_stage).toBe('compilation');
        expect(result.failure_reason).toBeDefined();
        expect(result.failure_reason.length).toBeGreaterThan(0);
      }
    });

    it('should allow refinement at attempt 0, 1, and 2 (below max)', async () => {
      for (let attempt = 0; attempt < MAX_REFINEMENT_ATTEMPTS; attempt++) {
        const patch: PatchCandidate = {
          id: `patch-attempt-${attempt}`,
          diff: '  return x + 1;',
          edit_operations: [{
            type: 'replace',
            node_type: 'return_statement',
            location: { file_path: '/project/src/compute.ts', start_line: 16, start_column: 0, end_line: 16, end_column: 20 },
          }],
          target_file: '/project/src/compute.ts',
          target_range: { start_line: 15, end_line: 17 },
          refinement_attempt: attempt,
        };

        const feedback: StageFeedback = {
          stage: 'test',
          passed: false,
          reason: 'Test failed',
          failing_tests: ['test_compute'],
        };

        const refined = await agent.refinePatch(patch, feedback);
        expect(refined.refinement_attempt).toBe(attempt + 1);
      }
    });

    it('should include stage name and failure reason in exhausted result', async () => {
      const patch: PatchCandidate = {
        id: 'patch-stage-info',
        diff: '  return 0;',
        edit_operations: [{
          type: 'replace',
          node_type: 'return_statement',
          location: { file_path: '/project/src/compute.ts', start_line: 16, start_column: 0, end_line: 16, end_column: 10 },
        }],
        target_file: '/project/src/compute.ts',
        target_range: { start_line: 15, end_line: 17 },
        refinement_attempt: MAX_REFINEMENT_ATTEMPTS,
      };

      const feedback: StageFeedback = {
        stage: 'test',
        passed: false,
        reason: 'Assertion mismatch',
        failing_tests: ['test_positive_values', 'test_boundary'],
      };

      try {
        await agent.refinePatch(patch, feedback);
        expect.fail('Should have thrown');
      } catch (error) {
        const result = error as RefinementExhaustedResult;
        expect(result.last_stage).toBe('test');
        expect(result.failure_reason).toContain('test');
        expect(result.failure_reason).toContain('test_positive_values');
        expect(result.failure_reason).toContain('test_boundary');
      }
    });

    it('should report MAX_REFINEMENT_ATTEMPTS as exactly 3', () => {
      expect(MAX_REFINEMENT_ATTEMPTS).toBe(3);
    });
  });

  describe('pipeline stage failure handling', () => {
    it('should report compilation stage name in StageFeedback', async () => {
      const patch: PatchCandidate = {
        id: 'patch-compile-fail',
        diff: '  const y = x;',
        edit_operations: [{
          type: 'insert',
          node_type: 'assignment_expression',
          location: { file_path: '/project/src/compute.ts', start_line: 14, start_column: 0, end_line: 14, end_column: 0 },
        }],
        target_file: '/project/src/compute.ts',
        target_range: { start_line: 14, end_line: 14 },
        refinement_attempt: MAX_REFINEMENT_ATTEMPTS,
      };

      const feedback: StageFeedback = {
        stage: 'compilation',
        passed: false,
        reason: 'Cannot find name x',
        compilation_errors: [
          { file: 'src/compute.ts', line: 14, message: "Cannot find name 'x'", severity: 'error' },
        ],
      };

      try {
        await agent.refinePatch(patch, feedback);
        expect.fail('Should have thrown');
      } catch (error) {
        const result = error as RefinementExhaustedResult;
        expect(result.last_stage).toBe('compilation');
        expect(result.failure_reason).toContain("Stage 'compilation' failed");
        expect(result.failure_reason).toContain("Cannot find name 'x'");
        expect(result.failure_reason).toContain('src/compute.ts:14');
      }
    });

    it('should report emulation stage name and reason in failure', async () => {
      const patch: PatchCandidate = {
        id: 'patch-emulation-fail',
        diff: '  count = 0;',
        edit_operations: [{
          type: 'insert',
          node_type: 'assignment_expression',
          location: { file_path: '/project/src/compute.ts', start_line: 14, start_column: 0, end_line: 14, end_column: 0 },
        }],
        target_file: '/project/src/compute.ts',
        target_range: { start_line: 14, end_line: 14 },
        refinement_attempt: MAX_REFINEMENT_ATTEMPTS,
      };

      const feedback: StageFeedback = {
        stage: 'emulation',
        passed: false,
        reason: 'State transition regression detected in variable count',
        error_message: 'Expected state stateB, got stateC',
      };

      try {
        await agent.refinePatch(patch, feedback);
        expect.fail('Should have thrown');
      } catch (error) {
        const result = error as RefinementExhaustedResult;
        expect(result.last_stage).toBe('emulation');
        expect(result.failure_reason).toContain("Stage 'emulation' failed");
        expect(result.failure_reason).toContain('Expected state stateB, got stateC');
      }
    });

    it('should report test stage name and failing test names in failure', async () => {
      const patch: PatchCandidate = {
        id: 'patch-test-fail',
        diff: '  return -1;',
        edit_operations: [{
          type: 'replace',
          node_type: 'return_statement',
          location: { file_path: '/project/src/compute.ts', start_line: 16, start_column: 0, end_line: 16, end_column: 12 },
        }],
        target_file: '/project/src/compute.ts',
        target_range: { start_line: 16, end_line: 16 },
        refinement_attempt: MAX_REFINEMENT_ATTEMPTS,
      };

      const feedback: StageFeedback = {
        stage: 'test',
        passed: false,
        reason: 'Three tests failed after patch application',
        failing_tests: ['should_return_positive', 'should_handle_zero', 'should_multiply'],
      };

      try {
        await agent.refinePatch(patch, feedback);
        expect.fail('Should have thrown');
      } catch (error) {
        const result = error as RefinementExhaustedResult;
        expect(result.last_stage).toBe('test');
        expect(result.failure_reason).toContain("Stage 'test' failed");
        expect(result.failure_reason).toContain('should_return_positive');
        expect(result.failure_reason).toContain('should_handle_zero');
        expect(result.failure_reason).toContain('should_multiply');
      }
    });
  });

  describe('stage time reporting', () => {
    it('should report elapsed time on compilation failure via pipeline result', async () => {
      // Import and use RepairPipeline to verify elapsed time in failure results
      const { RepairPipeline } = await import('../../src/agents/repair-pipeline.js');
      const { initializeDatabase } = await import('../../src/database/graph-db.js');
      const Database = (await import('better-sqlite3')).default;

      const db = initializeDatabase(':memory:');

      // Set up patch in DB
      db.prepare(`
        INSERT INTO proof_certificates (id, investigation_id, test_input, observed_output, violated_postcondition, admissibility_verified_at, soundness_verified_at, uniqueness_verified_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run('proof-t1', 'inv-t1', '{}', '{}', 'x > 0', '2024-01-01', '2024-01-01', '2024-01-01');

      db.prepare(`
        INSERT INTO patches (id, proof_certificate_id, diff, edit_operations, target_file, target_range, status)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run('patch-time-1', 'proof-t1', '+ fix', '[]', 'src/ex.ts', '{"start_line":10,"end_line":10}', 'generated');

      const pipeline = new RepairPipeline(
        db,
        {
          check: async () => ({ success: false, errors: ['TS2322: Type mismatch'], elapsed_ms: 142 }),
        },
        {
          emulate: async () => ({ success: true, regressions: [], elapsed_ms: 0 }),
        },
        {
          execute: async () => ({ success: true, total_tests: 0, passed_tests: 0, failed_tests: [], elapsed_ms: 0 }),
        }
      );

      const result = await pipeline.filterPatch({
        id: 'patch-time-1',
        diff: '+ fix',
        edit_operations: [],
        target_file: 'src/ex.ts',
        target_range: { start_line: 10, end_line: 10 },
        refinement_attempt: 0,
      });

      expect(result.passed).toBe(false);
      expect(result.failed_stage).toBe('compilation');
      expect(result.elapsed_ms).toBe(142);
      expect(result.elapsed_ms).toBeGreaterThan(0);
    });

    it('should report elapsed time on emulation failure via pipeline result', async () => {
      const { RepairPipeline } = await import('../../src/agents/repair-pipeline.js');
      const { initializeDatabase } = await import('../../src/database/graph-db.js');

      const db = initializeDatabase(':memory:');

      db.prepare(`
        INSERT INTO proof_certificates (id, investigation_id, test_input, observed_output, violated_postcondition, admissibility_verified_at, soundness_verified_at, uniqueness_verified_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run('proof-t2', 'inv-t2', '{}', '{}', 'x > 0', '2024-01-01', '2024-01-01', '2024-01-01');

      db.prepare(`
        INSERT INTO patches (id, proof_certificate_id, diff, edit_operations, target_file, target_range, status)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run('patch-time-2', 'proof-t2', '+ fix', '[]', 'src/ex.ts', '{"start_line":10,"end_line":10}', 'generated');

      const pipeline = new RepairPipeline(
        db,
        {
          check: async () => ({ success: true, errors: [], elapsed_ms: 30 }),
        },
        {
          emulate: async () => ({
            success: false,
            regressions: [{ transition: { from_state: 'A', to_state: 'B', trigger: 'ev', variables: {} }, expected_state: 'B', actual_state: 'C', message: 'Regressed' }],
            elapsed_ms: 275,
          }),
        },
        {
          execute: async () => ({ success: true, total_tests: 0, passed_tests: 0, failed_tests: [], elapsed_ms: 0 }),
        }
      );

      const result = await pipeline.filterPatch({
        id: 'patch-time-2',
        diff: '+ fix',
        edit_operations: [],
        target_file: 'src/ex.ts',
        target_range: { start_line: 10, end_line: 10 },
        refinement_attempt: 0,
      });

      expect(result.passed).toBe(false);
      expect(result.failed_stage).toBe('emulation');
      expect(result.elapsed_ms).toBe(275);
      expect(result.elapsed_ms).toBeGreaterThan(0);
    });

    it('should report elapsed time on test execution failure via pipeline result', async () => {
      const { RepairPipeline } = await import('../../src/agents/repair-pipeline.js');
      const { initializeDatabase } = await import('../../src/database/graph-db.js');

      const db = initializeDatabase(':memory:');

      db.prepare(`
        INSERT INTO proof_certificates (id, investigation_id, test_input, observed_output, violated_postcondition, admissibility_verified_at, soundness_verified_at, uniqueness_verified_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run('proof-t3', 'inv-t3', '{}', '{}', 'x > 0', '2024-01-01', '2024-01-01', '2024-01-01');

      db.prepare(`
        INSERT INTO patches (id, proof_certificate_id, diff, edit_operations, target_file, target_range, status)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run('patch-time-3', 'proof-t3', '+ fix', '[]', 'src/ex.ts', '{"start_line":10,"end_line":10}', 'generated');

      const pipeline = new RepairPipeline(
        db,
        {
          check: async () => ({ success: true, errors: [], elapsed_ms: 40 }),
        },
        {
          emulate: async () => ({ success: true, regressions: [], elapsed_ms: 60 }),
        },
        {
          execute: async () => ({
            success: false,
            total_tests: 10,
            passed_tests: 8,
            failed_tests: ['test_add', 'test_multiply'],
            elapsed_ms: 520,
          }),
        }
      );

      const result = await pipeline.filterPatch({
        id: 'patch-time-3',
        diff: '+ fix',
        edit_operations: [],
        target_file: 'src/ex.ts',
        target_range: { start_line: 10, end_line: 10 },
        refinement_attempt: 0,
      });

      expect(result.passed).toBe(false);
      expect(result.failed_stage).toBe('test');
      expect(result.elapsed_ms).toBe(520);
      expect(result.elapsed_ms).toBeGreaterThan(0);
    });
  });
});
