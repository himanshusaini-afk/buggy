/**
 * Unit tests for RepairAgent.refinePatch method.
 *
 * Tests patch refinement with feedback from filtering stages,
 * counter tracking (0..3), exhaustion behavior, and stage-specific
 * refinement logic.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { RepairAgent } from '../../src/agents/repair-agent.js';
import { McpRouter } from '../../src/middleware/mcp-router.js';
import type {
  PatchCandidate,
  StageFeedback,
  RefinementExhaustedResult,
} from '../../src/types/repair.js';
import { MAX_REFINEMENT_ATTEMPTS } from '../../src/types/repair.js';

function createMockRouter(): McpRouter {
  const router = new McpRouter();

  // Register read_range tool that returns dummy code content
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
    handler: async () => ({
      success: true,
      data: { lines: ['  const x = getValue();', '  return x + 1;'] },
    }),
  });

  // Register write_fix tool that always succeeds
  router.registerTool({
    name: 'write_fix',
    description: 'Write a fix',
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
    handler: async () => ({ success: true, data: {} }),
  });

  // Register extract_method (needed by generatePatches but not refinePatch directly)
  router.registerTool({
    name: 'extract_method',
    description: 'Extract method',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        method_name: { type: 'string' },
      },
      required: ['file_path', 'method_name'],
    },
    handler: async () => ({ success: true, data: { content: 'function foo() {}' } }),
  });

  return router;
}

function createPatch(overrides: Partial<PatchCandidate> = {}): PatchCandidate {
  return {
    id: 'patch-001',
    diff: '  if (x != null) { return x; }',
    edit_operations: [
      {
        type: 'insert',
        node_type: 'if_statement',
        location: {
          file_path: 'src/foo.ts',
          start_line: 10,
          start_column: 0,
          end_line: 10,
          end_column: 0,
        },
      },
    ],
    target_file: 'src/foo.ts',
    target_range: { start_line: 10, end_line: 12 },
    refinement_attempt: 0,
    ...overrides,
  };
}

describe('RepairAgent.refinePatch', () => {
  let agent: RepairAgent;

  beforeEach(() => {
    const router = createMockRouter();
    agent = new RepairAgent(router);
  });

  it('should increment refinement_attempt counter on each refinement', async () => {
    const patch = createPatch({ refinement_attempt: 0 });
    const feedback: StageFeedback = {
      stage: 'compilation',
      passed: false,
      reason: 'Type mismatch on line 10',
      error_message: 'Type error',
    };

    const refined = await agent.refinePatch(patch, feedback);

    expect(refined.refinement_attempt).toBe(1);
  });

  it('should produce a new patch ID for the refined patch', async () => {
    const patch = createPatch();
    const feedback: StageFeedback = {
      stage: 'test',
      passed: false,
      reason: 'Test assertion failed',
      failing_tests: ['test_add_numbers'],
    };

    const refined = await agent.refinePatch(patch, feedback);

    expect(refined.id).not.toBe(patch.id);
  });

  it('should preserve target_file and target_range from original patch', async () => {
    const patch = createPatch({
      target_file: 'src/bar.ts',
      target_range: { start_line: 20, end_line: 25 },
    });
    const feedback: StageFeedback = {
      stage: 'emulation',
      passed: false,
      reason: 'State regression detected',
    };

    const refined = await agent.refinePatch(patch, feedback);

    expect(refined.target_file).toBe('src/bar.ts');
    expect(refined.target_range).toEqual({ start_line: 20, end_line: 25 });
  });

  it('should throw RefinementExhaustedResult when attempt reaches MAX_REFINEMENT_ATTEMPTS', async () => {
    const patch = createPatch({ refinement_attempt: MAX_REFINEMENT_ATTEMPTS });
    const feedback: StageFeedback = {
      stage: 'compilation',
      passed: false,
      reason: 'Persistent type error',
      error_message: 'Cannot resolve symbol',
    };

    try {
      await agent.refinePatch(patch, feedback);
      expect.fail('Should have thrown');
    } catch (error) {
      const result = error as RefinementExhaustedResult;
      expect(result.patch_id).toBe(patch.id);
      expect(result.final_attempt).toBe(MAX_REFINEMENT_ATTEMPTS);
      expect(result.last_stage).toBe('compilation');
      expect(result.failure_reason).toContain('compilation');
    }
  });

  it('should throw when refinement_attempt exceeds MAX_REFINEMENT_ATTEMPTS', async () => {
    const patch = createPatch({ refinement_attempt: 4 });
    const feedback: StageFeedback = {
      stage: 'test',
      passed: false,
      reason: 'Still failing',
    };

    await expect(agent.refinePatch(patch, feedback)).rejects.toBeTruthy();
  });

  it('should allow refinement at attempt 2 (below max of 3)', async () => {
    const patch = createPatch({ refinement_attempt: 2 });
    const feedback: StageFeedback = {
      stage: 'test',
      passed: false,
      reason: 'Assertion error',
      failing_tests: ['should_return_sum'],
    };

    const refined = await agent.refinePatch(patch, feedback);

    expect(refined.refinement_attempt).toBe(3);
  });

  it('should include compilation error info in exhausted failure_reason', async () => {
    const patch = createPatch({ refinement_attempt: MAX_REFINEMENT_ATTEMPTS });
    const feedback: StageFeedback = {
      stage: 'compilation',
      passed: false,
      reason: 'Cannot compile',
      compilation_errors: [
        { file: 'src/foo.ts', line: 10, message: "Cannot find name 'bar'", severity: 'error' },
      ],
    };

    try {
      await agent.refinePatch(patch, feedback);
      expect.fail('Should have thrown');
    } catch (error) {
      const result = error as RefinementExhaustedResult;
      expect(result.failure_reason).toContain("Cannot find name 'bar'");
      expect(result.failure_reason).toContain('src/foo.ts:10');
    }
  });

  it('should include failing test names in exhausted failure_reason', async () => {
    const patch = createPatch({ refinement_attempt: MAX_REFINEMENT_ATTEMPTS });
    const feedback: StageFeedback = {
      stage: 'test',
      passed: false,
      reason: 'Tests failed',
      failing_tests: ['test_a', 'test_b'],
    };

    try {
      await agent.refinePatch(patch, feedback);
      expect.fail('Should have thrown');
    } catch (error) {
      const result = error as RefinementExhaustedResult;
      expect(result.failure_reason).toContain('test_a');
      expect(result.failure_reason).toContain('test_b');
    }
  });

  it('should handle compilation feedback refinement', async () => {
    const patch = createPatch({ refinement_attempt: 0 });
    const feedback: StageFeedback = {
      stage: 'compilation',
      passed: false,
      reason: "Cannot find name 'missingVar'",
      compilation_errors: [
        { file: 'src/foo.ts', line: 10, message: "Cannot find name 'missingVar'", severity: 'error' },
      ],
    };

    const refined = await agent.refinePatch(patch, feedback);

    expect(refined.diff).toContain('missingVar');
    expect(refined.refinement_attempt).toBe(1);
  });

  it('should handle emulation feedback refinement', async () => {
    const patch = createPatch({ refinement_attempt: 1 });
    const feedback: StageFeedback = {
      stage: 'emulation',
      passed: false,
      reason: 'State transition regression on variable count',
    };

    const refined = await agent.refinePatch(patch, feedback);

    expect(refined.diff).toContain('preserve state invariant');
    expect(refined.refinement_attempt).toBe(2);
  });

  it('should handle test failure feedback refinement', async () => {
    const patch = createPatch({ refinement_attempt: 0 });
    const feedback: StageFeedback = {
      stage: 'test',
      passed: false,
      reason: 'Two tests failed',
      failing_tests: ['calculate_total', 'validate_input'],
    };

    const refined = await agent.refinePatch(patch, feedback);

    expect(refined.diff).toContain('calculate_total');
    expect(refined.refinement_attempt).toBe(1);
  });

  it('MAX_REFINEMENT_ATTEMPTS should be 3', () => {
    expect(MAX_REFINEMENT_ATTEMPTS).toBe(3);
  });
});
