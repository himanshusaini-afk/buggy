import { describe, it, expect, vi } from 'vitest';
import {
  McpRouter,
  createMcpRouterWithDefaults,
} from '../../src/middleware/mcp-router.js';
import type { McpToolName, McpToolResult, McpError } from '../../src/types/mcp.js';

/**
 * Unit tests for MCP Middleware (task 5.3)
 *
 * Covers:
 * - Schema validation pass/fail for all 8 tools
 * - 30-second timeout enforcement
 * - Concurrent invocation handling
 * - Structured error response shape
 *
 * Requirements: 20.1–20.7
 */

// --- Helpers ---

function getRouterWithLiveHandlers(): McpRouter {
  const router = createMcpRouterWithDefaults();

  // Replace placeholder handlers with simple pass-through handlers
  const toolConfigs: Array<{ name: McpToolName; schema: { type: string; properties: Record<string, unknown>; required: string[] } }> = [
    {
      name: 'read_range',
      schema: {
        type: 'object',
        properties: { file_path: { type: 'string' }, start_line: { type: 'integer' }, end_line: { type: 'integer' } },
        required: ['file_path', 'start_line', 'end_line'],
      },
    },
    {
      name: 'get_classes_and_methods',
      schema: {
        type: 'object',
        properties: { file_path: { type: 'string' } },
        required: ['file_path'],
      },
    },
    {
      name: 'extract_method',
      schema: {
        type: 'object',
        properties: { file_path: { type: 'string' }, method_name: { type: 'string' }, class_name: { type: 'string' } },
        required: ['file_path', 'method_name'],
      },
    },
    {
      name: 'extract_tests',
      schema: {
        type: 'object',
        properties: { file_path: { type: 'string' }, test_pattern: { type: 'string' } },
        required: ['file_path'],
      },
    },
    {
      name: 'search_codebase',
      schema: {
        type: 'object',
        properties: { query: { type: 'string' }, file_pattern: { type: 'string' }, max_results: { type: 'integer' } },
        required: ['query'],
      },
    },
    {
      name: 'find_similar_api_calls',
      schema: {
        type: 'object',
        properties: { api_pattern: { type: 'string' }, file_pattern: { type: 'string' }, max_results: { type: 'integer' } },
        required: ['api_pattern'],
      },
    },
    {
      name: 'write_fix',
      schema: {
        type: 'object',
        properties: { file_path: { type: 'string' }, start_line: { type: 'integer' }, end_line: { type: 'integer' }, new_content: { type: 'string' } },
        required: ['file_path', 'start_line', 'end_line', 'new_content'],
      },
    },
    {
      name: 'run_tests',
      schema: {
        type: 'object',
        properties: { test_command: { type: 'string' }, working_directory: { type: 'string' }, timeout_seconds: { type: 'integer' } },
        required: ['test_command'],
      },
    },
  ];

  for (const cfg of toolConfigs) {
    router.registerTool({
      name: cfg.name,
      description: `Live handler for ${cfg.name}`,
      inputSchema: cfg.schema,
      handler: async (params: unknown) => ({ success: true, data: params }),
    });
  }

  return router;
}

// Valid params for each tool (minimum required fields)
const validParams: Record<McpToolName, Record<string, unknown>> = {
  read_range: { file_path: '/src/main.ts', start_line: 1, end_line: 10 },
  get_classes_and_methods: { file_path: '/src/main.ts' },
  extract_method: { file_path: '/src/main.ts', method_name: 'doWork' },
  extract_tests: { file_path: '/tests/main.test.ts' },
  search_codebase: { query: 'function doWork' },
  find_similar_api_calls: { api_pattern: 'fetch(' },
  write_fix: { file_path: '/src/main.ts', start_line: 5, end_line: 8, new_content: 'fixed code' },
  run_tests: { test_command: 'npm test' },
};

// --- Schema validation pass/fail for all 8 tools ---

describe('MCP Middleware - Schema Validation', () => {
  const ALL_TOOLS: McpToolName[] = [
    'read_range',
    'get_classes_and_methods',
    'extract_method',
    'extract_tests',
    'search_codebase',
    'find_similar_api_calls',
    'write_fix',
    'run_tests',
  ];

  describe('validation passes with valid params for each tool', () => {
    const router = getRouterWithLiveHandlers();

    it.each(ALL_TOOLS)('%s accepts valid params', async (toolName) => {
      const result = await router.invokeTool(toolName, validParams[toolName]);
      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
      expect(result.data).toEqual(validParams[toolName]);
    });
  });

  describe('validation fails when required params are missing', () => {
    const router = getRouterWithLiveHandlers();

    it('read_range: missing file_path, start_line, end_line', async () => {
      const result = await router.invokeTool('read_range', {});
      expect(result.success).toBe(false);
      expect(result.error?.type).toBe('validation_error');
      expect(result.error?.message).toContain('file_path');
      expect(result.error?.message).toContain('start_line');
      expect(result.error?.message).toContain('end_line');
    });

    it('get_classes_and_methods: missing file_path', async () => {
      const result = await router.invokeTool('get_classes_and_methods', {});
      expect(result.success).toBe(false);
      expect(result.error?.type).toBe('validation_error');
      expect(result.error?.message).toContain('file_path');
    });

    it('extract_method: missing file_path and method_name', async () => {
      const result = await router.invokeTool('extract_method', {});
      expect(result.success).toBe(false);
      expect(result.error?.type).toBe('validation_error');
      expect(result.error?.message).toContain('file_path');
      expect(result.error?.message).toContain('method_name');
    });

    it('extract_tests: missing file_path', async () => {
      const result = await router.invokeTool('extract_tests', {});
      expect(result.success).toBe(false);
      expect(result.error?.type).toBe('validation_error');
      expect(result.error?.message).toContain('file_path');
    });

    it('search_codebase: missing query', async () => {
      const result = await router.invokeTool('search_codebase', {});
      expect(result.success).toBe(false);
      expect(result.error?.type).toBe('validation_error');
      expect(result.error?.message).toContain('query');
    });

    it('find_similar_api_calls: missing api_pattern', async () => {
      const result = await router.invokeTool('find_similar_api_calls', {});
      expect(result.success).toBe(false);
      expect(result.error?.type).toBe('validation_error');
      expect(result.error?.message).toContain('api_pattern');
    });

    it('write_fix: missing file_path, start_line, end_line, new_content', async () => {
      const result = await router.invokeTool('write_fix', {});
      expect(result.success).toBe(false);
      expect(result.error?.type).toBe('validation_error');
      expect(result.error?.message).toContain('file_path');
      expect(result.error?.message).toContain('start_line');
      expect(result.error?.message).toContain('end_line');
      expect(result.error?.message).toContain('new_content');
    });

    it('run_tests: missing test_command', async () => {
      const result = await router.invokeTool('run_tests', {});
      expect(result.success).toBe(false);
      expect(result.error?.type).toBe('validation_error');
      expect(result.error?.message).toContain('test_command');
    });
  });

  describe('validation fails with wrong property types', () => {
    const router = getRouterWithLiveHandlers();

    it('read_range: file_path must be string, start_line must be integer', async () => {
      const result = await router.invokeTool('read_range', {
        file_path: 123,
        start_line: 'not a number',
        end_line: 10,
      });
      expect(result.success).toBe(false);
      expect(result.error?.type).toBe('validation_error');
    });

    it('write_fix: start_line as float fails integer validation', async () => {
      const result = await router.invokeTool('write_fix', {
        file_path: '/src/main.ts',
        start_line: 3.7,
        end_line: 5,
        new_content: 'code',
      });
      expect(result.success).toBe(false);
      expect(result.error?.type).toBe('validation_error');
      expect(result.error?.message).toContain('start_line');
    });

    it('search_codebase: max_results as string fails integer validation', async () => {
      const result = await router.invokeTool('search_codebase', {
        query: 'test',
        max_results: 'ten',
      });
      expect(result.success).toBe(false);
      expect(result.error?.type).toBe('validation_error');
      expect(result.error?.message).toContain('max_results');
    });

    it('run_tests: timeout_seconds as float fails integer validation', async () => {
      const result = await router.invokeTool('run_tests', {
        test_command: 'npm test',
        timeout_seconds: 10.5,
      });
      expect(result.success).toBe(false);
      expect(result.error?.type).toBe('validation_error');
      expect(result.error?.message).toContain('timeout_seconds');
    });
  });

  describe('validation fails when params is not an object', () => {
    const router = getRouterWithLiveHandlers();

    it.each(ALL_TOOLS)('%s rejects non-object params', async (toolName) => {
      const result = await router.invokeTool(toolName, 'not an object');
      expect(result.success).toBe(false);
      expect(result.error?.type).toBe('validation_error');
      expect(result.error?.message).toContain('Expected object');
    });

    it.each(ALL_TOOLS)('%s rejects null params', async (toolName) => {
      const result = await router.invokeTool(toolName, null);
      expect(result.success).toBe(false);
      expect(result.error?.type).toBe('validation_error');
    });

    it.each(ALL_TOOLS)('%s rejects array params', async (toolName) => {
      const result = await router.invokeTool(toolName, [1, 2, 3]);
      expect(result.success).toBe(false);
      expect(result.error?.type).toBe('validation_error');
    });
  });

  describe('validation passes with optional fields omitted', () => {
    const router = getRouterWithLiveHandlers();

    it('extract_method: optional class_name can be omitted', async () => {
      const result = await router.invokeTool('extract_method', {
        file_path: '/src/main.ts',
        method_name: 'doWork',
      });
      expect(result.success).toBe(true);
    });

    it('extract_tests: optional test_pattern can be omitted', async () => {
      const result = await router.invokeTool('extract_tests', {
        file_path: '/tests/suite.test.ts',
      });
      expect(result.success).toBe(true);
    });

    it('search_codebase: optional file_pattern and max_results can be omitted', async () => {
      const result = await router.invokeTool('search_codebase', {
        query: 'function',
      });
      expect(result.success).toBe(true);
    });

    it('find_similar_api_calls: optional file_pattern and max_results can be omitted', async () => {
      const result = await router.invokeTool('find_similar_api_calls', {
        api_pattern: 'console.log(',
      });
      expect(result.success).toBe(true);
    });

    it('run_tests: optional working_directory and timeout_seconds can be omitted', async () => {
      const result = await router.invokeTool('run_tests', {
        test_command: 'npx vitest --run',
      });
      expect(result.success).toBe(true);
    });
  });
});

// --- 30-second timeout enforcement ---

describe('MCP Middleware - Timeout Enforcement', () => {
  it('terminates tool invocation after 30 seconds and returns timeout_error', async () => {
    vi.useFakeTimers();

    const router = getRouterWithLiveHandlers();
    // Override read_range with a handler that never resolves
    router.registerTool({
      name: 'read_range',
      description: 'Slow handler',
      inputSchema: {
        type: 'object',
        properties: { file_path: { type: 'string' }, start_line: { type: 'integer' }, end_line: { type: 'integer' } },
        required: ['file_path', 'start_line', 'end_line'],
      },
      handler: () => new Promise((resolve) => setTimeout(() => resolve({ success: true }), 60_000)),
    });

    const promise = router.invokeTool('read_range', {
      file_path: '/src/main.ts',
      start_line: 1,
      end_line: 10,
    });

    await vi.advanceTimersByTimeAsync(30_001);
    const result = await promise;

    expect(result.success).toBe(false);
    expect(result.error?.type).toBe('timeout_error');
    expect(result.error?.tool_name).toBe('read_range');
    expect(result.error?.message).toContain('30000ms');

    vi.useRealTimers();
  });

  it('does not trigger timeout when handler resolves before 30 seconds', async () => {
    vi.useFakeTimers();

    const router = getRouterWithLiveHandlers();
    router.registerTool({
      name: 'search_codebase',
      description: 'Fast handler',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
      handler: async () => {
        await new Promise((r) => setTimeout(r, 5_000));
        return { success: true, data: { results: ['found'] } };
      },
    });

    const promise = router.invokeTool('search_codebase', { query: 'test' });
    await vi.advanceTimersByTimeAsync(5_001);
    const result = await promise;

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ results: ['found'] });

    vi.useRealTimers();
  });

  it('timeout applies per-tool invocation independently', async () => {
    vi.useFakeTimers();

    const router = getRouterWithLiveHandlers();

    // Slow tool that times out
    router.registerTool({
      name: 'run_tests',
      description: 'Slow tests',
      inputSchema: {
        type: 'object',
        properties: { test_command: { type: 'string' } },
        required: ['test_command'],
      },
      handler: () => new Promise((resolve) => setTimeout(() => resolve({ success: true }), 60_000)),
    });

    // Fast tool that resolves quickly
    router.registerTool({
      name: 'search_codebase',
      description: 'Fast search',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
      handler: async () => ({ success: true, data: 'fast' }),
    });

    const slowPromise = router.invokeTool('run_tests', { test_command: 'npm test' });
    const fastResult = await router.invokeTool('search_codebase', { query: 'test' });

    // Fast tool completes immediately
    expect(fastResult.success).toBe(true);

    // Advance past timeout for slow tool
    await vi.advanceTimersByTimeAsync(31_000);
    const slowResult = await slowPromise;

    expect(slowResult.success).toBe(false);
    expect(slowResult.error?.type).toBe('timeout_error');
    expect(slowResult.error?.tool_name).toBe('run_tests');

    vi.useRealTimers();
  });
});

// --- Concurrent invocation handling ---

describe('MCP Middleware - Concurrent Invocations', () => {
  it('handles 10 concurrent invocations without data corruption', async () => {
    const router = getRouterWithLiveHandlers();

    // Replace handler with one that introduces small async delay
    router.registerTool({
      name: 'search_codebase',
      description: 'Delayed search',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
      handler: async (params: unknown) => {
        await new Promise((r) => setTimeout(r, Math.random() * 20));
        return { success: true, data: params };
      },
    });

    const invocations = Array.from({ length: 10 }, (_, i) =>
      router.invokeTool('search_codebase', { query: `pattern_${i}` }),
    );

    const results = await Promise.all(invocations);

    for (let i = 0; i < 10; i++) {
      expect(results[i].success).toBe(true);
      expect(results[i].data).toEqual({ query: `pattern_${i}` });
    }
  });

  it('handles concurrent invocations across different tools', async () => {
    const router = getRouterWithLiveHandlers();

    const calls: Array<Promise<McpToolResult>> = [
      router.invokeTool('read_range', { file_path: '/a.ts', start_line: 1, end_line: 5 }),
      router.invokeTool('get_classes_and_methods', { file_path: '/b.ts' }),
      router.invokeTool('extract_method', { file_path: '/c.ts', method_name: 'foo' }),
      router.invokeTool('extract_tests', { file_path: '/d.test.ts' }),
      router.invokeTool('search_codebase', { query: 'import' }),
      router.invokeTool('find_similar_api_calls', { api_pattern: 'db.query(' }),
      router.invokeTool('write_fix', { file_path: '/e.ts', start_line: 1, end_line: 3, new_content: 'fix' }),
      router.invokeTool('run_tests', { test_command: 'vitest --run' }),
    ];

    const results = await Promise.all(calls);

    // All should succeed
    for (const result of results) {
      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
    }

    // Verify data isolation — each result has its own params
    expect(results[0].data).toEqual({ file_path: '/a.ts', start_line: 1, end_line: 5 });
    expect(results[4].data).toEqual({ query: 'import' });
    expect(results[7].data).toEqual({ test_command: 'vitest --run' });
  });

  it('concurrent failures do not corrupt other invocations', async () => {
    const router = getRouterWithLiveHandlers();

    let callCount = 0;
    router.registerTool({
      name: 'run_tests',
      description: 'Alternating handler',
      inputSchema: {
        type: 'object',
        properties: { test_command: { type: 'string' } },
        required: ['test_command'],
      },
      handler: async (params: unknown) => {
        callCount++;
        const p = params as { test_command: string };
        if (p.test_command === 'fail') {
          throw new Error('Test execution failed');
        }
        return { success: true, data: params };
      },
    });

    const calls = [
      router.invokeTool('run_tests', { test_command: 'pass1' }),
      router.invokeTool('run_tests', { test_command: 'fail' }),
      router.invokeTool('run_tests', { test_command: 'pass2' }),
    ];

    const results = await Promise.all(calls);

    expect(results[0].success).toBe(true);
    expect(results[0].data).toEqual({ test_command: 'pass1' });

    expect(results[1].success).toBe(false);
    expect(results[1].error?.type).toBe('execution_error');

    expect(results[2].success).toBe(true);
    expect(results[2].data).toEqual({ test_command: 'pass2' });
  });
});

// --- Structured error response shape ---

describe('MCP Middleware - Structured Error Response Shape', () => {
  const router = getRouterWithLiveHandlers();

  function assertErrorShape(error: McpError | undefined): void {
    expect(error).toBeDefined();
    expect(error).toHaveProperty('type');
    expect(error).toHaveProperty('message');
    expect(error).toHaveProperty('tool_name');
    expect(typeof error!.type).toBe('string');
    expect(typeof error!.message).toBe('string');
    expect(typeof error!.tool_name).toBe('string');
    expect(['validation_error', 'execution_error', 'timeout_error']).toContain(error!.type);
  }

  it('validation_error has correct shape with type, message, and tool_name', async () => {
    const result = await router.invokeTool('write_fix', {});
    expect(result.success).toBe(false);
    assertErrorShape(result.error);
    expect(result.error?.type).toBe('validation_error');
    expect(result.error?.tool_name).toBe('write_fix');
    expect(result.error?.message.length).toBeGreaterThan(0);
  });

  it('execution_error has correct shape with type, message, and tool_name', async () => {
    const testRouter = new McpRouter();
    testRouter.registerTool({
      name: 'extract_tests',
      description: 'Throws an error',
      inputSchema: {
        type: 'object',
        properties: { file_path: { type: 'string' } },
        required: ['file_path'],
      },
      handler: async () => { throw new Error('Disk read failure'); },
    });

    const result = await testRouter.invokeTool('extract_tests', { file_path: '/test.ts' });
    expect(result.success).toBe(false);
    assertErrorShape(result.error);
    expect(result.error?.type).toBe('execution_error');
    expect(result.error?.tool_name).toBe('extract_tests');
    expect(result.error?.message).toBe('Disk read failure');
  });

  it('timeout_error has correct shape with type, message, and tool_name', async () => {
    vi.useFakeTimers();

    const testRouter = new McpRouter();
    testRouter.registerTool({
      name: 'run_tests',
      description: 'Never resolves',
      inputSchema: {
        type: 'object',
        properties: { test_command: { type: 'string' } },
        required: ['test_command'],
      },
      handler: () => new Promise(() => {}), // never resolves
    });

    const promise = testRouter.invokeTool('run_tests', { test_command: 'npm test' });
    await vi.advanceTimersByTimeAsync(31_000);
    const result = await promise;

    expect(result.success).toBe(false);
    assertErrorShape(result.error);
    expect(result.error?.type).toBe('timeout_error');
    expect(result.error?.tool_name).toBe('run_tests');

    vi.useRealTimers();
  });

  it('unregistered tool returns execution_error with correct shape', async () => {
    const emptyRouter = new McpRouter();
    const result = await emptyRouter.invokeTool('write_fix', { file_path: '/x.ts', start_line: 1, end_line: 2, new_content: '' });

    expect(result.success).toBe(false);
    assertErrorShape(result.error);
    expect(result.error?.type).toBe('execution_error');
    expect(result.error?.tool_name).toBe('write_fix');
    expect(result.error?.message).toContain('not registered');
  });

  it('successful result has success=true, data present, no error', async () => {
    const result = await router.invokeTool('get_classes_and_methods', { file_path: '/src/app.ts' });

    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
    expect(result.error).toBeUndefined();
  });

  it('error result has success=false and no data field', async () => {
    const result = await router.invokeTool('read_range', {});

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.data).toBeUndefined();
  });
});
