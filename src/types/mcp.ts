/**
 * MCP (Model Context Protocol) middleware types.
 */

export interface JsonSchema {
  type: string;
  properties?: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
}

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  handler: (params: unknown) => Promise<McpToolResult>;
}

export interface McpToolResult {
  success: boolean;
  data?: unknown;
  error?: McpError;
}

export interface McpError {
  type: 'validation_error' | 'execution_error' | 'timeout_error';
  message: string;
  tool_name: string;
}

export type McpToolName =
  | 'read_range'
  | 'get_classes_and_methods'
  | 'extract_method'
  | 'extract_tests'
  | 'search_codebase'
  | 'find_similar_api_calls'
  | 'write_fix'
  | 'run_tests';
