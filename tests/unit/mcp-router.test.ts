import { describe, it, expect, vi } from 'vitest';
import {
  McpRouter,
  createMcpRouterWithDefaults,
} from '../../src/middleware/mcp-router.js';
import type { McpToolDefinition, McpToolName } from '../../src/types/mcp.js';

function makeToolDefinition(
  overrides: Partial<McpToolDefinition> = {},
): McpToolDefinition {
  return {
    name: 'read_range',
    description: 'Test tool',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
      },
      required: ['file_path'],
    },
    handler: async (_params: unknown) => ({ success: true, data: 'ok' }),
    ...overrides,
  };
}

describe('McpRouter', () => {
  describe('registerTool', () => {
    it('registers a tool that can be retrieved', () => {
      const router = new McpRouter();
      const def = makeToolDefinition();
      router.registerTool(def);

      expect(router.getTool('read_range')).toBe(def);
      expect(router.getRegisteredTools()).toContain('read_range');
    });

    it('overwrites a previously registered tool with the same name', () => {
      const router = new McpRouter();
      const def1 = makeToolDefinition({
        handler: async () => ({ success: true, data: 'first' }),
      });
      const def2 = makeToolDefinition({
        handler: async () => ({ success: true, data: 'second' }),
      });

      router.registerTool(def1);
      router.registerTool(def2);

      expect(router.getTool('read_range')).toBe(def2);
    });
  });

  describe('invokeTool', () => {
    it('returns execution_error for unregistered tool', async () => {
      const router = new McpRouter();
      const result = await router.invokeTool('read_range', {});

      expect(result.success).toBe(false);
      expect(result.error?.type).toBe('execution_error');
      expect(result.error?.tool_name).toBe('read_range');
      expect(result.error?.message).toContain('not registered');
    });

    it('executes handler and returns result on valid invocation', async () => {
      const router = new McpRouter();
      router.registerTool(
        makeToolDefinition({
          handler: async (params: unknown) => ({
            success: true,
            data: params,
          }),
        }),
      );

      const result = await router.invokeTool('read_range', {
        file_path: '/src/main.ts',
      });

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ file_path: '/src/main.ts' });
    });
  });

  describe('schema validation', () => {
    it('returns validation_error when required property is missing', async () => {
      const router = new McpRouter();
      router.registerTool(makeToolDefinition());

      const result = await router.invokeTool('read_range', {});

      expect(result.success).toBe(false);
      expect(result.error?.type).toBe('validation_error');
      expect(result.error?.tool_name).toBe('read_range');
      expect(result.error?.message).toContain('file_path');
    });

    it('returns validation_error when value is not an object', async () => {
      const router = new McpRouter();
      router.registerTool(makeToolDefinition());

      const result = await router.invokeTool('read_range', 'not an object');

      expect(result.success).toBe(false);
      expect(result.error?.type).toBe('validation_error');
      expect(result.error?.message).toContain('Expected object');
    });

    it('returns validation_error when property type is wrong', async () => {
      const router = new McpRouter();
      router.registerTool(makeToolDefinition());

      const result = await router.invokeTool('read_range', {
        file_path: 123,
      });

      expect(result.success).toBe(false);
      expect(result.error?.type).toBe('validation_error');
      expect(result.error?.message).toContain('file_path');
    });

    it('does not execute handler when validation fails', async () => {
      const router = new McpRouter();
      const handler = vi.fn().mockResolvedValue({ success: true });
      router.registerTool(makeToolDefinition({ handler }));

      await router.invokeTool('read_range', {});

      expect(handler).not.toHaveBeenCalled();
    });

    it('validates integer type correctly', async () => {
      const router = new McpRouter();
      router.registerTool(
        makeToolDefinition({
          name: 'write_fix',
          inputSchema: {
            type: 'object',
            properties: {
              start_line: { type: 'integer' },
            },
            required: ['start_line'],
          },
        }),
      );

      // Float should fail integer check
      const result = await router.invokeTool('write_fix' as McpToolName, {
        start_line: 1.5,
      });
      expect(result.success).toBe(false);
      expect(result.error?.type).toBe('validation_error');

      // Integer should pass
      router.registerTool(
        makeToolDefinition({
          name: 'write_fix',
          inputSchema: {
            type: 'object',
            properties: {
              start_line: { type: 'integer' },
            },
            required: ['start_line'],
          },
          handler: async () => ({ success: true, data: 'ok' }),
        }),
      );
      const result2 = await router.invokeTool('write_fix' as McpToolName, {
        start_line: 5,
      });
      expect(result2.success).toBe(true);
    });
  });

  describe('timeout enforcement', () => {
    it('returns timeout_error when handler exceeds 30 seconds', async () => {
      vi.useFakeTimers();
      const router = new McpRouter();

      router.registerTool(
        makeToolDefinition({
          handler: () =>
            new Promise((resolve) => {
              setTimeout(() => resolve({ success: true }), 60_000);
            }),
        }),
      );

      const promise = router.invokeTool('read_range', {
        file_path: '/test.ts',
      });

      // Advance time past the 30s timeout
      await vi.advanceTimersByTimeAsync(31_000);

      const result = await promise;

      expect(result.success).toBe(false);
      expect(result.error?.type).toBe('timeout_error');
      expect(result.error?.tool_name).toBe('read_range');
      expect(result.error?.message).toContain('30000ms');

      vi.useRealTimers();
    });

    it('does not timeout when handler completes quickly', async () => {
      const router = new McpRouter();
      router.registerTool(
        makeToolDefinition({
          handler: async () => ({ success: true, data: 'fast' }),
        }),
      );

      const result = await router.invokeTool('read_range', {
        file_path: '/test.ts',
      });

      expect(result.success).toBe(true);
      expect(result.data).toBe('fast');
    });
  });

  describe('execution errors', () => {
    it('returns execution_error when handler throws', async () => {
      const router = new McpRouter();
      router.registerTool(
        makeToolDefinition({
          handler: async () => {
            throw new Error('Something went wrong');
          },
        }),
      );

      const result = await router.invokeTool('read_range', {
        file_path: '/test.ts',
      });

      expect(result.success).toBe(false);
      expect(result.error?.type).toBe('execution_error');
      expect(result.error?.tool_name).toBe('read_range');
      expect(result.error?.message).toBe('Something went wrong');
    });

    it('handles non-Error throws gracefully', async () => {
      const router = new McpRouter();
      router.registerTool(
        makeToolDefinition({
          handler: async () => {
            throw 'string error';
          },
        }),
      );

      const result = await router.invokeTool('read_range', {
        file_path: '/test.ts',
      });

      expect(result.success).toBe(false);
      expect(result.error?.type).toBe('execution_error');
      expect(result.error?.message).toBe('string error');
    });
  });

  describe('concurrent invocations', () => {
    it('supports 10 concurrent invocations without data corruption', async () => {
      const router = new McpRouter();
      router.registerTool(
        makeToolDefinition({
          handler: async (params: unknown) => {
            // Simulate some async work
            await new Promise((r) => setTimeout(r, 10));
            return { success: true, data: params };
          },
        }),
      );

      const invocations = Array.from({ length: 10 }, (_, i) =>
        router.invokeTool('read_range', { file_path: `/file${i}.ts` }),
      );

      const results = await Promise.all(invocations);

      for (let i = 0; i < 10; i++) {
        expect(results[i].success).toBe(true);
        expect(results[i].data).toEqual({ file_path: `/file${i}.ts` });
      }
    });
  });

  describe('createMcpRouterWithDefaults', () => {
    it('pre-registers all 8 MCP tools', () => {
      const router = createMcpRouterWithDefaults();
      const tools = router.getRegisteredTools();

      expect(tools).toContain('read_range');
      expect(tools).toContain('get_classes_and_methods');
      expect(tools).toContain('extract_method');
      expect(tools).toContain('extract_tests');
      expect(tools).toContain('search_codebase');
      expect(tools).toContain('find_similar_api_calls');
      expect(tools).toContain('write_fix');
      expect(tools).toContain('run_tests');
      expect(tools).toHaveLength(8);
    });

    it('placeholder handlers return execution_error', async () => {
      const router = createMcpRouterWithDefaults();

      const result = await router.invokeTool('search_codebase', {
        query: 'test',
      });

      expect(result.success).toBe(false);
      expect(result.error?.type).toBe('execution_error');
      expect(result.error?.message).toContain('not yet wired');
    });

    it('validates input schema on default tools', async () => {
      const router = createMcpRouterWithDefaults();

      // read_range requires file_path, start_line, end_line
      const result = await router.invokeTool('read_range', {
        file_path: '/test.ts',
      });

      expect(result.success).toBe(false);
      expect(result.error?.type).toBe('validation_error');
      expect(result.error?.message).toContain('start_line');
    });

    it('allows overwriting default handler via registerTool', async () => {
      const router = createMcpRouterWithDefaults();

      router.registerTool({
        name: 'search_codebase',
        description: 'Custom search',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
        },
        handler: async (params: unknown) => ({
          success: true,
          data: { results: [] },
        }),
      });

      const result = await router.invokeTool('search_codebase', {
        query: 'hello',
      });
      expect(result.success).toBe(true);
    });
  });
});
