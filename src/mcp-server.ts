#!/usr/bin/env node
/**
 * MCP Server for the Proof-Carrying Debugger.
 *
 * Exposes the debugger's capabilities as MCP tools over stdio transport,
 * allowing AI-enabled IDEs (Cursor, Windsurf, VS Code + Copilot) to invoke
 * proof-carrying debugging directly.
 *
 * @module mcp-server
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { resolve } from 'node:path';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';

import { ProofDebugger } from './api.js';
import type { ParseResult } from './types/cst.js';

// ─── Instance Cache ──────────────────────────────────────────────────────────

const debuggerInstances = new Map<string, ProofDebugger>();

async function getDebuggerInstance(projectPath: string): Promise<ProofDebugger> {
  const resolved = resolve(projectPath);

  if (debuggerInstances.has(resolved)) {
    return debuggerInstances.get(resolved)!;
  }

  const instance = new ProofDebugger({ projectRoot: resolved });
  await instance.initialize();
  debuggerInstances.set(resolved, instance);
  return instance;
}

// ─── Tool Definitions ────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'buggy_init',
    description:
      'Initialize the proof-carrying debugger for a project. Creates .debugger.yaml config if missing and boots all agent subsystems.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        project_path: {
          type: 'string',
          description: 'Absolute path to the project root directory',
        },
      },
      required: ['project_path'],
    },
  },
  {
    name: 'buggy_analyze',
    description:
      'Parse a source file and return CST analysis including syntax errors, function declarations, and node counts.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        file_path: {
          type: 'string',
          description: 'Path to the file to analyze (absolute or relative to project_path)',
        },
        project_path: {
          type: 'string',
          description: 'Project root directory (uses current directory if omitted)',
        },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'buggy_investigate',
    description:
      'Run the full investigation pipeline (Parse → Prove → Repair → Classify) on a function. Returns proof-of-failure certificates, candidate patches, and classification results.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        function_id: {
          type: 'string',
          description: 'Name or identifier of the function to investigate',
        },
        file_path: {
          type: 'string',
          description: 'Path to the file containing the function',
        },
        project_path: {
          type: 'string',
          description: 'Project root directory (uses current directory if omitted)',
        },
        preconditions: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional preconditions for the function specification',
        },
        postconditions: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional postconditions for the function specification',
        },
      },
      required: ['function_id', 'file_path'],
    },
  },
  {
    name: 'buggy_status',
    description:
      'Get the current status of a running or completed investigation, including phase, agent, elapsed time, and intermediate results.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        investigation_id: {
          type: 'string',
          description: 'The investigation ID returned from buggy_investigate',
        },
        project_path: {
          type: 'string',
          description: 'Project root directory (uses current directory if omitted)',
        },
      },
      required: ['investigation_id'],
    },
  },
  {
    name: 'buggy_query_graph',
    description:
      'Query the semantic graph database. Supports querying callees of a function, looking up a specific node, or extracting the full file graph.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query_type: {
          type: 'string',
          enum: ['callees', 'node', 'file_graph'],
          description: 'Type of graph query to execute',
        },
        node_id: {
          type: 'string',
          description: 'Node ID for "callees" or "node" queries',
        },
        file_path: {
          type: 'string',
          description: 'File path for "file_graph" query',
        },
        project_path: {
          type: 'string',
          description: 'Project root directory (uses current directory if omitted)',
        },
      },
      required: ['query_type'],
    },
  },
  {
    name: 'buggy_list_functions',
    description:
      'List all function declarations in a file with their names, line numbers, and types (function, method, arrow function).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        file_path: {
          type: 'string',
          description: 'Path to the file to scan for functions',
        },
        project_path: {
          type: 'string',
          description: 'Project root directory (uses current directory if omitted)',
        },
      },
      required: ['file_path'],
    },
  },
];

// ─── Tool Handlers ───────────────────────────────────────────────────────────

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

function success(data: unknown): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
  };
}

function error(message: string): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
    isError: true,
  };
}

async function handleInit(args: Record<string, unknown>): Promise<ToolResult> {
  const projectPath = args.project_path as string;

  if (!projectPath) {
    return error('project_path is required');
  }

  const resolved = resolve(projectPath);

  // Ensure .debugger.yaml exists
  const configPath = resolve(resolved, '.debugger.yaml');
  if (!existsSync(configPath)) {
    // Create a default config
    const debuggerDir = resolve(resolved, '.debugger');
    if (!existsSync(debuggerDir)) {
      mkdirSync(debuggerDir, { recursive: true });
    }

    const defaultConfig = `language: typescript
parser:
  command: tree-sitter
lsp:
  command: typescript-language-server --stdio
sandbox:
  runtime: firecracker
  memory_limit_mb: 512
  timeout_seconds: 30
  egress_policy: deny
oracles:
  timeout_threshold_seconds: 5
  crash_detection: true
  overflow_detection: true
  determinism_check_count: 3
probe:
  search_budget: 100
  max_refinement_iterations: 5
`;
    writeFileSync(configPath, defaultConfig, 'utf-8');
  }

  try {
    const instance = await getDebuggerInstance(resolved);
    const config = instance.getConfig();

    return success({
      status: 'initialized',
      project_path: resolved,
      language: config.language,
      config_path: configPath,
    });
  } catch (err) {
    return error(`Initialization failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handleAnalyze(args: Record<string, unknown>): Promise<ToolResult> {
  const filePath = args.file_path as string;
  const projectPath = (args.project_path as string) || process.cwd();

  if (!filePath) {
    return error('file_path is required');
  }

  try {
    const instance = await getDebuggerInstance(projectPath);
    const result: ParseResult = await instance.parse(filePath);

    // Extract function declarations from CST
    const functions = extractFunctionDeclarations(result);

    return success({
      file_path: result.file_path,
      duration_ms: result.duration_ms,
      total_nodes: countNodes(result.cst),
      syntax_errors: result.errors.map((e) => ({
        message: e.message,
        line: e.location.row + 1,
        column: e.location.column + 1,
        length: e.length,
      })),
      functions,
      has_errors: result.errors.length > 0,
    });
  } catch (err) {
    return error(`Analysis failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handleInvestigate(args: Record<string, unknown>): Promise<ToolResult> {
  const functionId = args.function_id as string;
  const filePath = args.file_path as string;
  const projectPath = (args.project_path as string) || process.cwd();
  const preconditions = (args.preconditions as string[]) || [];
  const postconditions = (args.postconditions as string[]) || [];

  if (!functionId || !filePath) {
    return error('function_id and file_path are required');
  }

  try {
    const instance = await getDebuggerInstance(projectPath);
    const report = await instance.investigate({
      functionId,
      filePath,
      specification: {
        preconditions,
        postconditions,
      },
    });

    return success({
      investigation_id: report.id,
      status: report.status,
      proof: report.proof
        ? {
            test_input: report.proof.test_input,
            observed_output: report.proof.observed_output,
            violated_postcondition: report.proof.violated_postcondition,
            admissibility_verified_at: report.proof.admissibility_verified_at,
            soundness_verified_at: report.proof.soundness_verified_at,
            uniqueness_verified_at: report.proof.uniqueness_verified_at,
          }
        : null,
      approved_patches: report.approved_patches.length,
      rejected_patches: report.rejected_patches.length,
      timeline: report.timeline.map((t) => ({
        phase: t.phase,
        agent: t.agent,
        started_at: t.started_at,
        completed_at: t.completed_at,
      })),
      intermediate_results: report.intermediate_results,
    });
  } catch (err) {
    return error(`Investigation failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handleStatus(args: Record<string, unknown>): Promise<ToolResult> {
  const investigationId = args.investigation_id as string;
  const projectPath = (args.project_path as string) || process.cwd();

  if (!investigationId) {
    return error('investigation_id is required');
  }

  try {
    const instance = await getDebuggerInstance(projectPath);
    const status = instance.getStatus(investigationId);

    if (!status) {
      return error(`Investigation not found: ${investigationId}`);
    }

    return success({
      id: status.id,
      phase: status.phase,
      current_agent: status.current_agent,
      started_at: status.started_at,
      elapsed_ms: status.elapsed_ms,
      intermediate_results: status.intermediate_results,
    });
  } catch (err) {
    return error(`Status query failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handleQueryGraph(args: Record<string, unknown>): Promise<ToolResult> {
  const queryType = args.query_type as string;
  const nodeId = args.node_id as string | undefined;
  const filePath = args.file_path as string | undefined;
  const projectPath = (args.project_path as string) || process.cwd();

  if (!queryType) {
    return error('query_type is required');
  }

  try {
    const instance = await getDebuggerInstance(projectPath);

    switch (queryType) {
      case 'callees': {
        if (!nodeId) {
          return error('node_id is required for "callees" query');
        }
        const result = await instance.queryCallees(nodeId);
        return success({
          query_type: 'callees',
          node_id: nodeId,
          callees: result.callees.map((n) => ({
            id: n.id,
            type: n.type,
            file_path: n.file_path,
            start_line: n.start_line,
            text_content: n.text_content,
          })),
          edge_count: result.edges.length,
        });
      }

      case 'node': {
        if (!nodeId) {
          return error('node_id is required for "node" query');
        }
        const node = instance.queryNode(nodeId);
        if (!node) {
          return error(`Node not found: ${nodeId}`);
        }
        return success({
          query_type: 'node',
          node,
        });
      }

      case 'file_graph': {
        if (!filePath) {
          return error('file_path is required for "file_graph" query');
        }
        const graph = instance.queryFileGraph(filePath);
        return success({
          query_type: 'file_graph',
          file_path: filePath,
          node_count: graph.nodes.length,
          edge_count: graph.edges.length,
          nodes: graph.nodes.map((n) => ({
            id: n.id,
            type: n.type,
            start_line: n.start_line,
            text_content: n.text_content,
          })),
          edges: graph.edges.map((e) => ({
            source_id: e.source_id,
            target_id: e.target_id,
            relationship: e.relationship,
          })),
        });
      }

      default:
        return error(`Unknown query_type: ${queryType}. Use "callees", "node", or "file_graph".`);
    }
  } catch (err) {
    return error(`Graph query failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handleListFunctions(args: Record<string, unknown>): Promise<ToolResult> {
  const filePath = args.file_path as string;
  const projectPath = (args.project_path as string) || process.cwd();

  if (!filePath) {
    return error('file_path is required');
  }

  try {
    const instance = await getDebuggerInstance(projectPath);
    const result = await instance.parse(filePath);
    const functions = extractFunctionDeclarations(result);

    return success({
      file_path: result.file_path,
      function_count: functions.length,
      functions,
    });
  } catch (err) {
    return error(`List functions failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

interface FunctionInfo {
  name: string;
  line: number;
  type: string;
  start_byte: number;
  end_byte: number;
}

function extractFunctionDeclarations(parseResult: ParseResult): FunctionInfo[] {
  const functions: FunctionInfo[] = [];

  function walk(node: ParseResult['cst']): void {
    // Note: 'arrow_function' is intentionally excluded here. Named arrow functions
    // (const foo = () => {}) are captured by the variable_declarator branch below.
    // Including them here would double-count them — once with their real name and
    // again as '<anonymous>' when walk() recurses into the arrow_function node.
    const isFunctionType =
      node.type === 'function_declaration' ||
      node.type === 'method_definition' ||
      node.type === 'generator_function_declaration';

    if (isFunctionType) {
      // Try to find name from children
      const nameChild = node.children.find(
        (c) => c.type === 'identifier' || c.type === 'property_identifier',
      );
      const name = nameChild?.text ?? '<anonymous>';

      functions.push({
        name,
        line: node.start_position.row + 1,
        type: node.type,
        start_byte: node.start_byte,
        end_byte: node.end_byte,
      });
    }

    // Check for variable declarations with arrow functions (const foo = () => {})
    if (node.type === 'lexical_declaration' || node.type === 'variable_declaration') {
      for (const child of node.children) {
        if (child.type === 'variable_declarator') {
          const nameNode = child.children.find((c) => c.type === 'identifier');
          const valueNode = child.children.find((c) => c.type === 'arrow_function');
          if (nameNode?.text && valueNode) {
            functions.push({
              name: nameNode.text,
              line: node.start_position.row + 1,
              type: 'arrow_function',
              start_byte: valueNode.start_byte,
              end_byte: valueNode.end_byte,
            });
          }
        }
      }
    }

    for (const child of node.children) {
      walk(child);
    }
  }

  walk(parseResult.cst);
  return functions;
}

function countNodes(node: ParseResult['cst']): number {
  let count = 1;
  for (const child of node.children) {
    count += countNodes(child);
  }
  return count;
}

// ─── Server Setup ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const server = new Server(
    { name: 'buggy', version: '0.1.0' },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  // Register tool list handler
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: TOOLS };
  });

  // Register tool call handler
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    const toolArgs = (args ?? {}) as Record<string, unknown>;

    let result: ToolResult;

    switch (name) {
      case 'buggy_init':
        result = await handleInit(toolArgs);
        break;

      case 'buggy_analyze':
        result = await handleAnalyze(toolArgs);
        break;

      case 'buggy_investigate':
        result = await handleInvestigate(toolArgs);
        break;

      case 'buggy_status':
        result = await handleStatus(toolArgs);
        break;

      case 'buggy_query_graph':
        result = await handleQueryGraph(toolArgs);
        break;

      case 'buggy_list_functions':
        result = await handleListFunctions(toolArgs);
        break;

      default:
        result = error(`Unknown tool: ${name}`);
    }

    return {
      content: result.content,
      isError: result.isError,
    };
  });

  // Connect via stdio
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Graceful shutdown
  process.on('SIGINT', async () => {
    for (const [, instance] of debuggerInstances) {
      await instance.shutdown();
    }
    await server.close();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    for (const [, instance] of debuggerInstances) {
      await instance.shutdown();
    }
    await server.close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('MCP Server fatal error:', err);
  process.exit(1);
});
