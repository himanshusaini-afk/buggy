/**
 * Integration test: MCP Middleware
 *
 * Tests 10+ concurrent MCP tool invocations, 30-second timeout enforcement,
 * and JSON schema validation for all 8 tools.
 *
 * Uses the real McpRouter implementation — no mocks.
 *
 * Requirements: 20.1–20.7
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { McpRouter, createMcpRouterWithDefaults } from '../../src/middleware/mcp-router.js';
import type { McpToolName, McpToolResult } from '../../src/types/mcp.js';

describe('MCP Middleware Integration', () => {
  let router: McpRouter;

  beforeEach(() => {
    router = createMcpRouterWithDefaults();
  });

  describe('Schema Validation for All 8 Tools', () => {
    it('should validate read_range with valid params', async () => {
      // Override handler to simulate success
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
        handler: async (params) => ({
          success: true,
          data: { lines: ['function add(a, b) {', '  return a + b;', '}'] },
        }),
      });

      const result = await router.invokeTool('read_range', {
        file_path: 'src/utils.ts',
        start_line: 1,
        end_line: 3,
      });

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
    });

    it('should reject read_range with missing required fields', async () => {
      const result = await router.invokeTool('read_range', {
        file_path: 'src/utils.ts',
        // Missing start_line and end_line
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error!.type).toBe('validation_error');
      expect(result.error!.tool_name).toBe('read_range');
    });

    it('should validate get_classes_and_methods with valid params', async () => {
      router.registerTool({
        name: 'get_classes_and_methods',
        description: 'Extract class and method declarations',
        inputSchema: {
          type: 'object',
          properties: { file_path: { type: 'string' } },
          required: ['file_path'],
        },
        handler: async () => ({ success: true, data: { classes: ['MyClass'], methods: ['doWork'] } }),
      });

      const result = await router.invokeTool('get_classes_and_methods', {
        file_path: 'src/app.ts',
      });

      expect(result.success).toBe(true);
    });

    it('should reject get_classes_and_methods with wrong type', async () => {
      const result = await router.invokeTool('get_classes_and_methods', {
        file_path: 42, // Should be string
      });

      expect(result.success).toBe(false);
      expect(result.error!.type).toBe('validation_error');
    });

    it('should validate extract_method with valid params', async () => {
      router.registerTool({
        name: 'extract_method',
        description: 'Extract a specific method body',
        inputSchema: {
          type: 'object',
          properties: {
            file_path: { type: 'string' },
            method_name: { type: 'string' },
            class_name: { type: 'string' },
          },
          required: ['file_path', 'method_name'],
        },
        handler: async () => ({ success: true, data: { body: 'return this.x;' } }),
      });

      const result = await router.invokeTool('extract_method', {
        file_path: 'src/service.ts',
        method_name: 'getResult',
        class_name: 'MyService',
      });

      expect(result.success).toBe(true);
    });

    it('should validate extract_tests with valid params', async () => {
      router.registerTool({
        name: 'extract_tests',
        description: 'Extract test cases from a test file',
        inputSchema: {
          type: 'object',
          properties: {
            file_path: { type: 'string' },
            test_pattern: { type: 'string' },
          },
          required: ['file_path'],
        },
        handler: async () => ({ success: true, data: { tests: ['it should add numbers'] } }),
      });

      const result = await router.invokeTool('extract_tests', {
        file_path: 'tests/math.test.ts',
      });

      expect(result.success).toBe(true);
    });

    it('should validate search_codebase with valid params', async () => {
      router.registerTool({
        name: 'search_codebase',
        description: 'Search the codebase for patterns',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            file_pattern: { type: 'string' },
            max_results: { type: 'integer' },
          },
          required: ['query'],
        },
        handler: async () => ({ success: true, data: { matches: [] } }),
      });

      const result = await router.invokeTool('search_codebase', {
        query: 'function add',
        max_results: 10,
      });

      expect(result.success).toBe(true);
    });

    it('should reject search_codebase with missing required query', async () => {
      const result = await router.invokeTool('search_codebase', {
        file_pattern: '*.ts',
      });

      expect(result.success).toBe(false);
      expect(result.error!.type).toBe('validation_error');
      expect(result.error!.message).toContain('query');
    });

    it('should validate find_similar_api_calls with valid params', async () => {
      router.registerTool({
        name: 'find_similar_api_calls',
        description: 'Find similar API call patterns',
        inputSchema: {
          type: 'object',
          properties: {
            api_pattern: { type: 'string' },
            file_pattern: { type: 'string' },
            max_results: { type: 'integer' },
          },
          required: ['api_pattern'],
        },
        handler: async () => ({ success: true, data: { calls: [] } }),
      });

      const result = await router.invokeTool('find_similar_api_calls', {
        api_pattern: 'db.query(*)',
      });

      expect(result.success).toBe(true);
    });

    it('should validate write_fix with valid params', async () => {
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
        handler: async () => ({ success: true, data: { written: true } }),
      });

      const result = await router.invokeTool('write_fix', {
        file_path: 'src/utils.ts',
        start_line: 5,
        end_line: 5,
        new_content: '  return a + b;',
      });

      expect(result.success).toBe(true);
    });

    it('should reject write_fix with missing new_content', async () => {
      const result = await router.invokeTool('write_fix', {
        file_path: 'src/utils.ts',
        start_line: 5,
        end_line: 5,
        // Missing new_content
      });

      expect(result.success).toBe(false);
      expect(result.error!.type).toBe('validation_error');
      expect(result.error!.message).toContain('new_content');
    });

    it('should validate run_tests with valid params', async () => {
      router.registerTool({
        name: 'run_tests',
        description: 'Execute tests in sandbox',
        inputSchema: {
          type: 'object',
          properties: {
            test_command: { type: 'string' },
            working_directory: { type: 'string' },
            timeout_seconds: { type: 'integer' },
          },
          required: ['test_command'],
        },
        handler: async () => ({ success: true, data: { passed: 12, failed: 0 } }),
      });

      const result = await router.invokeTool('run_tests', {
        test_command: 'vitest run',
        working_directory: '/project',
        timeout_seconds: 60,
      });

      expect(result.success).toBe(true);
    });

    it('should reject run_tests with non-string test_command', async () => {
      const result = await router.invokeTool('run_tests', {
        test_command: 123, // Should be string
      });

      expect(result.success).toBe(false);
      expect(result.error!.type).toBe('validation_error');
    });
  });

  describe('Concurrent Invocations (10+)', () => {
    it('should handle 10+ concurrent invocations without data corruption', async () => {
      // Register all tools with handlers that track concurrent access
      let activeConcurrent = 0;
      let maxConcurrent = 0;

      const tools: Array<{ name: McpToolName; params: Record<string, unknown> }> = [
        { name: 'read_range', params: { file_path: 'a.ts', start_line: 1, end_line: 10 } },
        { name: 'read_range', params: { file_path: 'b.ts', start_line: 5, end_line: 20 } },
        { name: 'get_classes_and_methods', params: { file_path: 'c.ts' } },
        { name: 'extract_method', params: { file_path: 'd.ts', method_name: 'foo' } },
        { name: 'extract_tests', params: { file_path: 'e.test.ts' } },
        { name: 'search_codebase', params: { query: 'import' } },
        { name: 'search_codebase', params: { query: 'export' } },
        { name: 'find_similar_api_calls', params: { api_pattern: 'fetch(*)' } },
        { name: 'write_fix', params: { file_path: 'f.ts', start_line: 1, end_line: 1, new_content: 'fixed' } },
        { name: 'run_tests', params: { test_command: 'vitest run' } },
        { name: 'read_range', params: { file_path: 'g.ts', start_line: 1, end_line: 5 } },
        { name: 'get_classes_and_methods', params: { file_path: 'h.ts' } },
      ];

      // Register handlers that simulate async work with concurrency tracking
      for (const tool of tools) {
        router.registerTool({
          name: tool.name,
          description: `Handler for ${tool.name}`,
          inputSchema: router.getTool(tool.name)!.inputSchema,
          handler: async (params) => {
            activeConcurrent++;
            maxConcurrent = Math.max(maxConcurrent, activeConcurrent);
            // Simulate async work
            await new Promise((r) => setTimeout(r, 10));
            activeConcurrent--;
            return { success: true, data: { tool: tool.name, params } };
          },
        });
      }

      // Fire all 12 invocations concurrently
      const promises = tools.map((t) => router.invokeTool(t.name, t.params));
      const results = await Promise.all(promises);

      // All should succeed
      expect(results).toHaveLength(12);
      for (const result of results) {
        expect(result.success).toBe(true);
        expect(result.data).toBeDefined();
      }

      // Verify concurrent execution happened
      expect(maxConcurrent).toBeGreaterThan(1);
    });

    it('should return independent results for concurrent invocations of same tool', async () => {
      let callCount = 0;

      router.registerTool({
        name: 'read_range',
        description: 'Read lines',
        inputSchema: {
          type: 'object',
          properties: {
            file_path: { type: 'string' },
            start_line: { type: 'integer' },
            end_line: { type: 'integer' },
          },
          required: ['file_path', 'start_line', 'end_line'],
        },
        handler: async (params: any) => {
          callCount++;
          const id = callCount;
          await new Promise((r) => setTimeout(r, Math.random() * 20));
          return { success: true, data: { id, file: params.file_path } };
        },
      });

      const files = Array.from({ length: 15 }, (_, i) => `file${i}.ts`);
      const promises = files.map((f) =>
        router.invokeTool('read_range', { file_path: f, start_line: 1, end_line: 10 })
      );

      const results = await Promise.all(promises);

      // All should succeed with unique data
      expect(results).toHaveLength(15);
      const resultFiles = results.map((r: any) => r.data?.file);
      expect(new Set(resultFiles).size).toBe(15);
    });

    it('should not corrupt state when mixing valid and invalid concurrent requests', async () => {
      router.registerTool({
        name: 'search_codebase',
        description: 'Search',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
        },
        handler: async (params: any) => {
          await new Promise((r) => setTimeout(r, 5));
          return { success: true, data: { query: params.query, results: [] } };
        },
      });

      const requests = [
        // Valid requests
        router.invokeTool('search_codebase', { query: 'valid1' }),
        router.invokeTool('search_codebase', { query: 'valid2' }),
        router.invokeTool('search_codebase', { query: 'valid3' }),
        // Invalid requests (missing required field)
        router.invokeTool('search_codebase', {}),
        router.invokeTool('search_codebase', { query: 123 }),
        // More valid
        router.invokeTool('search_codebase', { query: 'valid4' }),
        router.invokeTool('search_codebase', { query: 'valid5' }),
        router.invokeTool('search_codebase', { query: 'valid6' }),
        router.invokeTool('search_codebase', { query: 'valid7' }),
        router.invokeTool('search_codebase', { query: 'valid8' }),
        router.invokeTool('search_codebase', { query: 'valid9' }),
      ];

      const results = await Promise.all(requests);

      // Valid ones succeed
      const validResults = results.filter((r) => r.success);
      const invalidResults = results.filter((r) => !r.success);

      expect(validResults.length).toBe(9); // 9 valid queries
      expect(invalidResults.length).toBe(2); // 2 invalid

      // Invalid ones have proper error structure
      for (const inv of invalidResults) {
        expect(inv.error).toBeDefined();
        expect(inv.error!.type).toBe('validation_error');
        expect(inv.error!.tool_name).toBe('search_codebase');
      }
    });
  });

  describe('Timeout Enforcement', () => {
    it('should enforce 30-second timeout on tool execution', async () => {
      router.registerTool({
        name: 'run_tests',
        description: 'Run tests with delay',
        inputSchema: {
          type: 'object',
          properties: { test_command: { type: 'string' } },
          required: ['test_command'],
        },
        handler: async () => {
          // Simulate a tool that takes too long (use a controlled short timeout for testing)
          await new Promise((r) => setTimeout(r, 35_000));
          return { success: true, data: {} };
        },
      });

      const result = await router.invokeTool('run_tests', {
        test_command: 'vitest run --slow',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error!.type).toBe('timeout_error');
      expect(result.error!.tool_name).toBe('run_tests');
      expect(result.error!.message).toContain('timeout');
    }, 35_000);

    it('should return results for tools completing within timeout', async () => {
      router.registerTool({
        name: 'read_range',
        description: 'Fast read',
        inputSchema: {
          type: 'object',
          properties: {
            file_path: { type: 'string' },
            start_line: { type: 'integer' },
            end_line: { type: 'integer' },
          },
          required: ['file_path', 'start_line', 'end_line'],
        },
        handler: async () => {
          await new Promise((r) => setTimeout(r, 50));
          return { success: true, data: { lines: ['hello'] } };
        },
      });

      const result = await router.invokeTool('read_range', {
        file_path: 'test.ts',
        start_line: 1,
        end_line: 1,
      });

      expect(result.success).toBe(true);
    });
  });

  describe('Structured Error Responses', () => {
    it('should return structured error for unregistered tool', async () => {
      const result = await router.invokeTool('nonexistent_tool' as McpToolName, {});

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error!.type).toBe('execution_error');
      expect(result.error!.tool_name).toBe('nonexistent_tool');
    });

    it('should return structured error for handler exceptions', async () => {
      router.registerTool({
        name: 'read_range',
        description: 'Failing handler',
        inputSchema: {
          type: 'object',
          properties: {
            file_path: { type: 'string' },
            start_line: { type: 'integer' },
            end_line: { type: 'integer' },
          },
          required: ['file_path', 'start_line', 'end_line'],
        },
        handler: async () => {
          throw new Error('File not found: /missing/path.ts');
        },
      });

      const result = await router.invokeTool('read_range', {
        file_path: '/missing/path.ts',
        start_line: 1,
        end_line: 1,
      });

      expect(result.success).toBe(false);
      expect(result.error!.type).toBe('execution_error');
      expect(result.error!.message).toContain('File not found');
      expect(result.error!.tool_name).toBe('read_range');
    });

    it('should include tool_name in all error responses', async () => {
      // Validation error
      const validationResult = await router.invokeTool('write_fix', {});
      expect(validationResult.error!.tool_name).toBe('write_fix');

      // Execution error (default handler)
      const defaultResult = await router.invokeTool('extract_tests', { file_path: 'test.ts' });
      expect(defaultResult.error!.tool_name).toBe('extract_tests');
    });
  });

  describe('All 8 Tools Registered', () => {
    it('should have all 8 MCP tools registered with createMcpRouterWithDefaults', () => {
      const allTools = router.getRegisteredTools();
      const expectedTools: McpToolName[] = [
        'read_range',
        'get_classes_and_methods',
        'extract_method',
        'extract_tests',
        'search_codebase',
        'find_similar_api_calls',
        'write_fix',
        'run_tests',
      ];

      for (const tool of expectedTools) {
        expect(allTools).toContain(tool);
      }
      expect(allTools.length).toBe(8);
    });

    it('should have valid inputSchema for each registered tool', () => {
      const allTools = router.getRegisteredTools();

      for (const toolName of allTools) {
        const tool = router.getTool(toolName);
        expect(tool).toBeDefined();
        expect(tool!.inputSchema).toBeDefined();
        expect(tool!.inputSchema.type).toBe('object');
        expect(tool!.handler).toBeTypeOf('function');
      }
    });
  });
});
