import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { McpRouter } from '../../src/middleware/mcp-router.js';
import type {
  McpToolDefinition,
  McpToolResult,
  McpToolName,
  JsonSchema,
} from '../../src/types/mcp.js';

/**
 * Property 31: MCP Schema Validation and Error Reporting
 *
 * Generate random MCP tool requests with valid/invalid schemas.
 * Verify:
 *   - valid schema → proceeds to execution
 *   - invalid schema → rejected without execution + structured error with tool_name
 *   - execution failure → structured error with type/message/tool_name
 *
 * **Validates: Requirements 20.3, 20.4, 20.5**
 */

// --- Test tool schemas ---

const TEST_TOOL_SCHEMAS: Array<{
  name: McpToolName;
  inputSchema: JsonSchema;
}> = [
  {
    name: 'read_range',
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
    name: 'search_codebase',
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
    name: 'write_fix',
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
];

// --- Arbitraries ---

const arbToolIndex = fc.integer({ min: 0, max: TEST_TOOL_SCHEMAS.length - 1 });

/**
 * Generate valid params for a given tool schema.
 * Produces an object with all required properties of the correct types.
 */
function arbValidParams(schema: JsonSchema): fc.Arbitrary<Record<string, unknown>> {
  const properties = (schema.properties || {}) as Record<string, { type?: string }>;
  const required = schema.required || [];

  // Build all required properties with correct types
  const entries: Array<[string, fc.Arbitrary<unknown>]> = [];
  for (const key of required) {
    const propSchema = properties[key];
    const propType = propSchema?.type || 'string';
    entries.push([key, arbValueForType(propType)]);
  }

  // Optionally add some optional properties
  const optionalKeys = Object.keys(properties).filter((k) => !required.includes(k));
  for (const key of optionalKeys) {
    const propSchema = properties[key];
    const propType = propSchema?.type || 'string';
    entries.push([key, fc.oneof(fc.constant(undefined), arbValueForType(propType))]);
  }

  if (entries.length === 0) {
    return fc.constant({});
  }

  const arbs = entries.map(([_key, arb]) => arb);
  return fc.tuple(...arbs).map((values) => {
    const obj: Record<string, unknown> = {};
    for (let i = 0; i < entries.length; i++) {
      const val = values[i];
      if (val !== undefined) {
        obj[entries[i][0]] = val;
      }
    }
    return obj;
  });
}

function arbValueForType(type: string): fc.Arbitrary<unknown> {
  switch (type) {
    case 'string':
      return fc.string({ minLength: 1, maxLength: 50 });
    case 'integer':
      return fc.integer({ min: 0, max: 10000 });
    case 'number':
      return fc.double({ min: 0, max: 10000, noNaN: true });
    case 'boolean':
      return fc.boolean();
    case 'array':
      return fc.array(fc.string(), { minLength: 0, maxLength: 3 });
    default:
      return fc.string();
  }
}

/**
 * Generate invalid params for a given tool schema using various strategies.
 */
type InvalidStrategy = 'missing_required' | 'wrong_type' | 'not_object';

const arbInvalidStrategy: fc.Arbitrary<InvalidStrategy> = fc.constantFrom(
  'missing_required',
  'wrong_type',
  'not_object',
);

function arbInvalidParams(
  schema: JsonSchema,
  strategy: InvalidStrategy,
): fc.Arbitrary<unknown> {
  const properties = (schema.properties || {}) as Record<string, { type?: string }>;
  const required = schema.required || [];

  switch (strategy) {
    case 'not_object':
      // Return a non-object value
      return fc.oneof(
        fc.string(),
        fc.integer(),
        fc.constant(null),
        fc.array(fc.string()),
        fc.boolean(),
      );

    case 'missing_required':
      // Return an object missing at least one required property
      if (required.length === 0) {
        // If no required, just return a non-object
        return fc.constant('not_an_object');
      }
      // Pick a random subset of required props to omit (at least one)
      return fc.integer({ min: 0, max: required.length - 1 }).map((omitIdx) => {
        const obj: Record<string, unknown> = {};
        for (let i = 0; i < required.length; i++) {
          if (i === omitIdx) continue; // omit this one
          const key = required[i];
          const propType = properties[key]?.type || 'string';
          // Use deterministic valid values
          obj[key] = propType === 'integer' ? 1 : propType === 'number' ? 1.0 : 'value';
        }
        return obj;
      });

    case 'wrong_type':
      // Return an object with all required properties but one has wrong type
      if (required.length === 0) {
        return fc.constant('not_an_object');
      }
      return fc.integer({ min: 0, max: required.length - 1 }).map((wrongIdx) => {
        const obj: Record<string, unknown> = {};
        for (let i = 0; i < required.length; i++) {
          const key = required[i];
          const propType = properties[key]?.type || 'string';
          if (i === wrongIdx) {
            // Assign wrong type value
            obj[key] = propType === 'string' ? 42 : 'not_a_number';
          } else {
            obj[key] = propType === 'integer' ? 1 : propType === 'number' ? 1.0 : 'value';
          }
        }
        return obj;
      });
  }
}

/**
 * Create a router with a tool registered using a tracking handler.
 */
function createRouterWithTrackedHandler(
  toolDef: { name: McpToolName; inputSchema: JsonSchema },
  handlerBehavior: 'success' | 'throw',
): { router: McpRouter; wasExecuted: () => boolean } {
  let executed = false;

  const handler = async (_params: unknown): Promise<McpToolResult> => {
    executed = true;
    if (handlerBehavior === 'throw') {
      throw new Error('Simulated execution failure');
    }
    return { success: true, data: { executed: true } };
  };

  const router = new McpRouter();
  router.registerTool({
    name: toolDef.name,
    description: `Test tool ${toolDef.name}`,
    inputSchema: toolDef.inputSchema,
    handler,
  });

  return { router, wasExecuted: () => executed };
}

// --- Property Tests ---

describe('Property 31: MCP Schema Validation and Error Reporting', () => {
  it('valid schema params proceed to handler execution', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbToolIndex,
        fc.integer({ min: 0, max: 999 }), // seed for param generation variety
        async (toolIdx, _seed) => {
          const toolDef = TEST_TOOL_SCHEMAS[toolIdx];
          const validParams = generateValidParamsSync(toolDef.inputSchema);

          const { router, wasExecuted } = createRouterWithTrackedHandler(
            toolDef,
            'success',
          );

          const result = await router.invokeTool(toolDef.name, validParams);

          // Handler must have been executed
          expect(wasExecuted()).toBe(true);
          // Result should be successful
          expect(result.success).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('invalid schema params are rejected without executing the handler, with structured error containing tool_name', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbToolIndex,
        arbInvalidStrategy,
        async (toolIdx, strategy) => {
          const toolDef = TEST_TOOL_SCHEMAS[toolIdx];

          // Skip 'missing_required' for tools with no required fields
          if (strategy === 'missing_required' && (!toolDef.inputSchema.required || toolDef.inputSchema.required.length === 0)) {
            return;
          }

          const invalidParams = generateInvalidParamsSync(
            toolDef.inputSchema,
            strategy,
          );

          const { router, wasExecuted } = createRouterWithTrackedHandler(
            toolDef,
            'success',
          );

          const result = await router.invokeTool(toolDef.name, invalidParams);

          // Handler must NOT have been executed
          expect(wasExecuted()).toBe(false);
          // Result must indicate failure
          expect(result.success).toBe(false);
          // Error must be structured with required fields
          expect(result.error).toBeDefined();
          expect(result.error!.type).toBe('validation_error');
          expect(result.error!.tool_name).toBe(toolDef.name);
          expect(typeof result.error!.message).toBe('string');
          expect(result.error!.message.length).toBeGreaterThan(0);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('execution failure produces structured error with type, message, and tool_name', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbToolIndex,
        fc.string({ minLength: 1, maxLength: 100 }),
        async (toolIdx, errorMessage) => {
          const toolDef = TEST_TOOL_SCHEMAS[toolIdx];

          const router = new McpRouter();
          router.registerTool({
            name: toolDef.name,
            description: `Failing tool ${toolDef.name}`,
            inputSchema: toolDef.inputSchema,
            handler: async (_params: unknown): Promise<McpToolResult> => {
              throw new Error(errorMessage);
            },
          });

          const validParams = generateValidParamsSync(toolDef.inputSchema);
          const result = await router.invokeTool(toolDef.name, validParams);

          // Result must indicate failure
          expect(result.success).toBe(false);
          // Error must be structured with required fields
          expect(result.error).toBeDefined();
          expect(result.error!.type).toBe('execution_error');
          expect(result.error!.tool_name).toBe(toolDef.name);
          expect(result.error!.message).toBe(errorMessage);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('all error responses conform to McpError structure (type, message, tool_name)', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbToolIndex,
        fc.constantFrom('validation', 'execution', 'unregistered') as fc.Arbitrary<
          'validation' | 'execution' | 'unregistered'
        >,
        async (toolIdx, errorKind) => {
          const toolDef = TEST_TOOL_SCHEMAS[toolIdx];
          const router = new McpRouter();

          let result: McpToolResult;

          switch (errorKind) {
            case 'validation': {
              // Register tool then call with invalid params
              router.registerTool({
                name: toolDef.name,
                description: 'test',
                inputSchema: toolDef.inputSchema,
                handler: async () => ({ success: true }),
              });
              result = await router.invokeTool(toolDef.name, 'not_an_object');
              break;
            }
            case 'execution': {
              // Register tool with throwing handler + valid params
              router.registerTool({
                name: toolDef.name,
                description: 'test',
                inputSchema: toolDef.inputSchema,
                handler: async () => {
                  throw new Error('boom');
                },
              });
              const validParams = generateValidParamsSync(toolDef.inputSchema);
              result = await router.invokeTool(toolDef.name, validParams);
              break;
            }
            case 'unregistered': {
              // Don't register the tool
              result = await router.invokeTool(toolDef.name, {});
              break;
            }
          }

          // All error cases must have the McpError structure
          expect(result.success).toBe(false);
          expect(result.error).toBeDefined();
          expect(['validation_error', 'execution_error', 'timeout_error']).toContain(
            result.error!.type,
          );
          expect(typeof result.error!.message).toBe('string');
          expect(result.error!.message.length).toBeGreaterThan(0);
          expect(result.error!.tool_name).toBe(toolDef.name);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('valid params with varying optional fields always proceed to execution', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbToolIndex,
        // Control which optional properties to include
        fc.array(fc.boolean(), { minLength: 0, maxLength: 5 }),
        async (toolIdx, optionalFlags) => {
          const toolDef = TEST_TOOL_SCHEMAS[toolIdx];
          const properties = (toolDef.inputSchema.properties || {}) as Record<
            string,
            { type?: string }
          >;
          const required = toolDef.inputSchema.required || [];
          const optionalKeys = Object.keys(properties).filter(
            (k) => !required.includes(k),
          );

          // Build params with all required + varying optionals
          const params: Record<string, unknown> = {};
          for (const key of required) {
            const propType = properties[key]?.type || 'string';
            params[key] =
              propType === 'integer' ? 5 : propType === 'number' ? 3.14 : 'test_value';
          }
          for (let i = 0; i < optionalKeys.length; i++) {
            if (optionalFlags[i % optionalFlags.length]) {
              const key = optionalKeys[i];
              const propType = properties[key]?.type || 'string';
              params[key] =
                propType === 'integer' ? 10 : propType === 'number' ? 2.5 : 'opt_value';
            }
          }

          const { router, wasExecuted } = createRouterWithTrackedHandler(
            toolDef,
            'success',
          );

          const result = await router.invokeTool(toolDef.name, params);

          expect(wasExecuted()).toBe(true);
          expect(result.success).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// --- Sync helpers for generating params inside property callbacks ---

function generateValidParamsSync(schema: JsonSchema): Record<string, unknown> {
  const properties = (schema.properties || {}) as Record<string, { type?: string }>;
  const required = schema.required || [];
  const obj: Record<string, unknown> = {};

  for (const key of required) {
    const propType = properties[key]?.type || 'string';
    switch (propType) {
      case 'string':
        obj[key] = `/test/${key}_value`;
        break;
      case 'integer':
        obj[key] = 42;
        break;
      case 'number':
        obj[key] = 3.14;
        break;
      case 'boolean':
        obj[key] = true;
        break;
      default:
        obj[key] = 'default';
    }
  }

  return obj;
}

function generateInvalidParamsSync(
  schema: JsonSchema,
  strategy: InvalidStrategy,
): unknown {
  const properties = (schema.properties || {}) as Record<string, { type?: string }>;
  const required = schema.required || [];

  switch (strategy) {
    case 'not_object':
      return 'this_is_not_an_object';

    case 'missing_required': {
      // Include all required props except the first one
      const obj: Record<string, unknown> = {};
      for (let i = 1; i < required.length; i++) {
        const key = required[i];
        const propType = properties[key]?.type || 'string';
        obj[key] = propType === 'integer' ? 1 : propType === 'number' ? 1.0 : 'value';
      }
      return obj;
    }

    case 'wrong_type': {
      // Include all required props but give the first one a wrong type
      const obj: Record<string, unknown> = {};
      for (let i = 0; i < required.length; i++) {
        const key = required[i];
        const propType = properties[key]?.type || 'string';
        if (i === 0) {
          // Wrong type: string gets number, number/integer gets string
          obj[key] = propType === 'string' ? 999 : 'wrong_type_string';
        } else {
          obj[key] = propType === 'integer' ? 1 : propType === 'number' ? 1.0 : 'value';
        }
      }
      return obj;
    }
  }
}
