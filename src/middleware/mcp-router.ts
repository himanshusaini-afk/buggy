/**
 * MCP Tool Router
 *
 * Routes tool invocations between agents with JSON Schema validation,
 * 30-second timeout enforcement, and structured error responses.
 *
 * Supports at least 10 concurrent invocations without data corruption
 * by avoiding global locks — each invocation operates independently.
 */

import type {
  McpToolDefinition,
  McpToolResult,
  McpError,
  McpToolName,
  JsonSchema,
} from '../types/mcp.js';

const TOOL_TIMEOUT_MS = 30_000;

/**
 * Validates a value against a JSON Schema (subset supporting object type with
 * required properties and basic type checking).
 */
function validateAgainstSchema(
  value: unknown,
  schema: JsonSchema,
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (schema.type === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      errors.push(`Expected object, got ${Array.isArray(value) ? 'array' : typeof value}`);
      return { valid: false, errors };
    }

    const obj = value as Record<string, unknown>;

    // Check required properties
    if (schema.required && Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (!(key in obj)) {
          errors.push(`Missing required property: ${key}`);
        }
      }
    }

    // Check property types if properties are defined
    if (schema.properties && typeof schema.properties === 'object') {
      const properties = schema.properties as Record<string, unknown>;
      for (const [key, propSchema] of Object.entries(properties)) {
        if (key in obj && propSchema && typeof propSchema === 'object') {
          const prop = propSchema as { type?: string };
          if (prop.type && obj[key] !== undefined && obj[key] !== null) {
            const actualType = Array.isArray(obj[key]) ? 'array' : typeof obj[key];
            if (prop.type === 'integer') {
              if (typeof obj[key] !== 'number' || !Number.isInteger(obj[key])) {
                errors.push(
                  `Property "${key}" expected integer, got ${actualType}`,
                );
              }
            } else if (prop.type === 'number') {
              if (typeof obj[key] !== 'number') {
                errors.push(
                  `Property "${key}" expected number, got ${actualType}`,
                );
              }
            } else if (prop.type !== actualType) {
              errors.push(
                `Property "${key}" expected ${prop.type}, got ${actualType}`,
              );
            }
          }
        }
      }
    }
  } else if (schema.type === 'string') {
    if (typeof value !== 'string') {
      errors.push(`Expected string, got ${typeof value}`);
    }
  } else if (schema.type === 'number') {
    if (typeof value !== 'number') {
      errors.push(`Expected number, got ${typeof value}`);
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value)) {
      errors.push(`Expected array, got ${typeof value}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * McpRouter routes MCP tool calls between agents with schema validation
 * and timeout enforcement.
 */
export class McpRouter {
  private readonly tools: Map<string, McpToolDefinition> = new Map();

  /**
   * Register a tool definition with the router.
   * If a tool with the same name is already registered, it will be overwritten.
   */
  registerTool(definition: McpToolDefinition): void {
    this.tools.set(definition.name, definition);
  }

  /**
   * Invoke a registered tool by name.
   *
   * - Validates params against the tool's inputSchema
   * - Enforces a 30-second timeout
   * - Returns structured McpError on validation failure, timeout, or execution error
   *
   * Supports concurrent invocations without global locks.
   */
  async invokeTool(name: McpToolName, params: unknown): Promise<McpToolResult> {
    const definition = this.tools.get(name);

    if (!definition) {
      return {
        success: false,
        error: {
          type: 'execution_error',
          message: `Tool "${name}" is not registered`,
          tool_name: name,
        },
      };
    }

    // Schema validation
    const validation = validateAgainstSchema(params, definition.inputSchema);
    if (!validation.valid) {
      return {
        success: false,
        error: {
          type: 'validation_error',
          message: `Schema validation failed: ${validation.errors.join('; ')}`,
          tool_name: name,
        },
      };
    }

    // Execute with timeout
    try {
      const result = await this.executeWithTimeout(definition, params);
      return result;
    } catch (error: unknown) {
      if (error instanceof TimeoutError) {
        return {
          success: false,
          error: {
            type: 'timeout_error',
            message: `Tool "${name}" exceeded ${TOOL_TIMEOUT_MS}ms timeout`,
            tool_name: name,
          },
        };
      }

      const message =
        error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: {
          type: 'execution_error',
          message,
          tool_name: name,
        },
      };
    }
  }

  /**
   * Get a registered tool definition by name.
   */
  getTool(name: string): McpToolDefinition | undefined {
    return this.tools.get(name);
  }

  /**
   * Get all registered tool names.
   */
  getRegisteredTools(): string[] {
    return Array.from(this.tools.keys());
  }

  /**
   * Execute a tool handler with a 30-second timeout using Promise.race.
   */
  private async executeWithTimeout(
    definition: McpToolDefinition,
    params: unknown,
  ): Promise<McpToolResult> {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeoutId = setTimeout(() => {
        reject(new TimeoutError(definition.name));
      }, TOOL_TIMEOUT_MS);
    });

    try {
      const result = await Promise.race([
        definition.handler(params),
        timeoutPromise,
      ]);
      return result;
    } finally {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
    }
  }
}

/**
 * Custom error class for timeout identification.
 */
class TimeoutError extends Error {
  constructor(toolName: string) {
    super(`Tool "${toolName}" timed out after ${TOOL_TIMEOUT_MS}ms`);
    this.name = 'TimeoutError';
  }
}

/**
 * Pre-registers all 8 MCP tools with placeholder schemas and handlers.
 * Handlers return execution errors until wired by individual agents.
 */
export function createMcpRouterWithDefaults(): McpRouter {
  const router = new McpRouter();

  const toolDefinitions: Array<{
    name: McpToolName;
    description: string;
    inputSchema: JsonSchema;
  }> = [
    {
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
    },
    {
      name: 'get_classes_and_methods',
      description: 'Extract class and method declarations from a source file',
      inputSchema: {
        type: 'object',
        properties: {
          file_path: { type: 'string' },
        },
        required: ['file_path'],
      },
    },
    {
      name: 'extract_method',
      description: 'Extract a specific method body from a source file',
      inputSchema: {
        type: 'object',
        properties: {
          file_path: { type: 'string' },
          method_name: { type: 'string' },
          class_name: { type: 'string' },
        },
        required: ['file_path', 'method_name'],
      },
    },
    {
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
    },
    {
      name: 'search_codebase',
      description: 'Search the codebase for patterns or symbols',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          file_pattern: { type: 'string' },
          max_results: { type: 'integer' },
        },
        required: ['query'],
      },
    },
    {
      name: 'find_similar_api_calls',
      description: 'Find similar API call patterns across the codebase',
      inputSchema: {
        type: 'object',
        properties: {
          api_pattern: { type: 'string' },
          file_pattern: { type: 'string' },
          max_results: { type: 'integer' },
        },
        required: ['api_pattern'],
      },
    },
    {
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
    },
    {
      name: 'run_tests',
      description: 'Execute tests in the sandbox environment',
      inputSchema: {
        type: 'object',
        properties: {
          test_command: { type: 'string' },
          working_directory: { type: 'string' },
          timeout_seconds: { type: 'integer' },
        },
        required: ['test_command'],
      },
    },
  ];

  for (const def of toolDefinitions) {
    const toolName = def.name;
    router.registerTool({
      ...def,
      handler: async (_params: unknown): Promise<McpToolResult> => ({
        success: false,
        error: {
          type: 'execution_error',
          message: `Tool "${toolName}" handler not yet wired. Register an agent handler.`,
          tool_name: toolName,
        },
      }),
    });
  }

  return router;
}
