/**
 * Programmatic API for Buggy.
 *
 * Provides a clean, embeddable interface for running the debugger
 * from other tools, scripts, or integrations.
 *
 * @example
 * ```typescript
 * import { ProofDebugger } from 'buggy';
 *
 * const debugger = new ProofDebugger({ projectRoot: '/path/to/project' });
 * await debugger.initialize();
 *
 * const report = await debugger.investigate({
 *   functionId: 'processPayment',
 *   filePath: 'src/payments.ts',
 * });
 *
 * console.log(report.status);
 * await debugger.shutdown();
 * ```
 *
 * @module api
 */

import { resolve, extname } from 'node:path';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import type Database from 'better-sqlite3';

import { loadConfig, ConfigError } from './config/config-loader.js';
import { initializeDatabase } from './database/graph-db.js';
import { GraphQueries } from './database/graph-queries.js';
import { ParserAgent } from './agents/parser-agent.js';
import { BugProvingAgent } from './agents/bug-proving-agent.js';
import { RepairAgent } from './agents/repair-agent.js';
import { ClassifierAgent } from './agents/classifier-agent.js';
import { McpRouter } from './middleware/mcp-router.js';
import { AgentOrchestrator } from './orchestrator/orchestrator.js';
import type { OrchestratorDeps } from './orchestrator/orchestrator.js';
import { WatchlistRecorder } from './watchlist/watchlist-recorder.js';
import { WatchlistStore } from './watchlist/watchlist-store.js';
import type { RecallCriteria, RecallResult, WatchlistStats } from './types/watchlist.js';
import type { DebuggerConfig } from './types/config.js';
import type { ParseResult } from './types/cst.js';
import type { InvestigationReport, InvestigationStatus, InvestigationTarget } from './types/orchestrator.js';
import type { NodeRecord, EdgeRecord } from './types/graph.js';
import type { DefectContext, FunctionSpec, VariableState } from './types/repair.js';
import type { ProofOfFailureCertificate } from './types/proof.js';
import type { McpToolResult } from './types/mcp.js';

// ─── Public Types ────────────────────────────────────────────────────────────

/**
 * Options for creating a ProofDebugger instance.
 */
export interface ProofDebuggerOptions {
  /** Absolute path to the target project root directory. */
  projectRoot: string;
  /** Override the language detection (e.g., 'typescript', 'python'). */
  language?: string;
  /** Override sandbox configuration. */
  sandbox?: Partial<{
    memory_limit_mb: number;
    timeout_seconds: number;
    egress_policy: 'deny' | 'allow_host_only';
  }>;
  /** Override probe configuration. */
  probe?: Partial<{
    search_budget: number;
    max_refinement_iterations: number;
  }>;
  /** Custom path to .debugger.yaml (defaults to projectRoot/.debugger.yaml). */
  configPath?: string;
  /** Custom database path (defaults to projectRoot/.debugger/graph.db). */
  dbPath?: string;
}

/**
 * Options for the investigate command.
 */
export interface InvestigateOptions {
  /** Name or identifier of the function to investigate. */
  functionId: string;
  /** Path to the file containing the function (absolute or relative to projectRoot). */
  filePath: string;
  /** Optional specification for the function under investigation. */
  specification?: {
    preconditions?: string[];
    postconditions?: string[];
    parameters?: Array<{ name: string; type: string }>;
    return_type?: string;
  };
}

/**
 * Options for querying callees in the graph.
 */
export interface QueryCalleesResult {
  /** Nodes representing callee functions. */
  callees: NodeRecord[];
  /** Edges representing call relationships. */
  edges: EdgeRecord[];
}

// ─── ProofDebugger Class ─────────────────────────────────────────────────────

/**
 * Main API class for the Buggy system.
 *
 * Provides methods to parse files, investigate functions,
 * query the semantic graph, and manage investigations.
 */
export class ProofDebugger {
  private options: ProofDebuggerOptions;
  private config: DebuggerConfig | null = null;
  private db: Database.Database | null = null;
  private graphQueries: GraphQueries | null = null;
  private parserAgent: ParserAgent | null = null;
  private orchestrator: AgentOrchestrator | null = null;
  private watchlistRecorder: WatchlistRecorder | null = null;
  private watchlistStore: WatchlistStore | null = null;
  private initialized = false;

  constructor(options: ProofDebuggerOptions) {
    this.options = {
      ...options,
      projectRoot: resolve(options.projectRoot),
    };
  }

  /**
   * Initialize the debugger system.
   *
   * Loads configuration, initializes the SQLite graph database,
   * and boots all agent subsystems.
   *
   * @throws {ConfigError} If .debugger.yaml is missing or invalid
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Load configuration
    this.config = loadConfig(this.options.projectRoot);

    // Apply overrides
    if (this.options.language) {
      this.config.language = this.options.language;
    }
    if (this.options.sandbox) {
      Object.assign(this.config.sandbox, this.options.sandbox);
    }
    if (this.options.probe) {
      Object.assign(this.config.probe, this.options.probe);
    }

    // Ensure .debugger/ directory exists
    const debuggerDir = resolve(this.options.projectRoot, '.debugger');
    if (!existsSync(debuggerDir)) {
      mkdirSync(debuggerDir, { recursive: true });
    }

    // Initialize SQLite graph database
    const dbPath = this.options.dbPath ?? resolve(debuggerDir, 'graph.db');
    this.db = initializeDatabase(dbPath);
    this.graphQueries = new GraphQueries(this.db);

    // Initialize parser agent with LSP config
    this.parserAgent = new ParserAgent({
      command: this.config.lsp.command,
      initializationOptions: this.config.lsp.initialization_options,
    });

    // Initialize the experience-memory recorder (Watchlist). It shares the
    // project graph DB for local episodes and writes team/global steering
    // files according to the configured scope (defaults to 'layered').
    this.watchlistRecorder = new WatchlistRecorder(this.db, {
      projectRoot: this.options.projectRoot,
      scope: this.config.watchlist?.scope,
      enabled: this.config.watchlist?.enabled,
      language: this.config.language,
    });
    this.watchlistStore = new WatchlistStore(this.db);

    // Initialize orchestrator with agent stubs
    // In production, these would be fully initialized agents
    const deps = this.buildOrchestratorDeps();
    this.orchestrator = new AgentOrchestrator(deps, this.watchlistRecorder);

    this.initialized = true;
  }

  /**
   * Parse a file and return the CST with error information.
   *
   * @param filePath - Absolute or relative path to the file to parse
   * @returns ParseResult with CST, errors, timing, and file path
   */
  async parse(filePath: string): Promise<ParseResult> {
    this.ensureInitialized();

    const resolvedPath = this.resolvePath(filePath);
    return this.parserAgent!.parseFile(resolvedPath);
  }

  /**
   * Run a full investigation pipeline on a function.
   *
   * Executes: Parse → Prove → Repair → Classify
   *
   * @param options - Investigation target and optional specification
   * @returns Complete investigation report with proofs and patches
   */
  async investigate(options: InvestigateOptions): Promise<InvestigationReport> {
    this.ensureInitialized();

    const resolvedPath = this.resolvePath(options.filePath);

    const specification: FunctionSpec = {
      name: options.functionId,
      preconditions: options.specification?.preconditions ?? [],
      postconditions: options.specification?.postconditions ?? [],
      parameters: options.specification?.parameters ?? [],
      return_type: options.specification?.return_type ?? 'unknown',
    };

    const target: InvestigationTarget = {
      function_id: options.functionId,
      file_path: resolvedPath,
      specification,
    };

    return this.orchestrator!.startInvestigation(target);
  }

  /**
   * Get the current status of a running investigation.
   *
   * @param id - Investigation identifier
   * @returns Current status or undefined if not found
   */
  getStatus(id: string): InvestigationStatus | undefined {
    this.ensureInitialized();
    return this.orchestrator!.getStatus(id);
  }

  /**
   * Halt a running investigation, preserving intermediate results.
   *
   * @param id - Investigation identifier
   */
  halt(id: string): void {
    this.ensureInitialized();
    this.orchestrator!.halt(id);
  }

  /**
   * Recall relevant prior lessons from the watchlist for code you are about to
   * write or fix. Merges the project-local tier with the cross-project global
   * tier, with project lessons taking precedence on conflict.
   *
   * @param criteria - What you know about the target (function, file, class).
   * @returns Ranked lessons plus whether this exact target was seen before.
   */
  recall(criteria: RecallCriteria): RecallResult {
    this.ensureInitialized();
    const resolved: RecallCriteria = { ...criteria };
    if (criteria.file_path) {
      resolved.file_path = this.resolvePath(criteria.file_path);
    }
    return this.watchlistStore!.recall(resolved);
  }

  /**
   * Aggregate watchlist metrics — episode counts by outcome, the most-recurring
   * lessons (a proxy for whether fixes are sticking), and global coverage.
   */
  watchlistStats(): WatchlistStats {
    this.ensureInitialized();
    return this.watchlistStore!.stats();
  }

  /**
   * Query the semantic graph for callees of a function.
   *
   * @param functionId - The node ID or function name to query
   * @returns Callee nodes and edges
   */
  async queryCallees(functionId: string): Promise<QueryCalleesResult> {
    this.ensureInitialized();

    const edges = this.graphQueries!.traverseEdges(functionId, 'calls');
    const callees: NodeRecord[] = [];

    for (const edge of edges) {
      const node = this.graphQueries!.lookupNode(edge.target_id);
      if (node) {
        callees.push(node);
      }
    }

    return { callees, edges };
  }

  /**
   * Query the semantic graph for a specific node.
   *
   * @param nodeId - The node identifier
   * @returns The node record or null
   */
  queryNode(nodeId: string): NodeRecord | null {
    this.ensureInitialized();
    return this.graphQueries!.lookupNode(nodeId);
  }

  /**
   * Extract the full subgraph for a file.
   *
   * @param filePath - Path to the file
   * @returns All nodes and edges in the file's subgraph
   */
  queryFileGraph(filePath: string): { nodes: NodeRecord[]; edges: EdgeRecord[] } {
    this.ensureInitialized();
    const resolvedPath = this.resolvePath(filePath);
    return this.graphQueries!.extractSubgraph(resolvedPath);
  }

  /**
   * Get the loaded configuration.
   *
   * @returns The active debugger configuration
   */
  getConfig(): DebuggerConfig {
    this.ensureInitialized();
    return { ...this.config! };
  }

  /**
   * Shutdown the debugger, closing database connections and LSP clients.
   */
  async shutdown(): Promise<void> {
    if (!this.initialized) return;

    // Shutdown LSP
    if (this.parserAgent) {
      await this.parserAgent.shutdownLsp();
      this.parserAgent = null;
    }

    // Close database
    if (this.db) {
      this.db.close();
      this.db = null;
    }

    this.graphQueries = null;
    this.orchestrator = null;
    this.watchlistRecorder = null;
    this.watchlistStore = null;
    this.config = null;
    this.initialized = false;
  }

  // ─── Private Helpers ─────────────────────────────────────────────────────────

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error('ProofDebugger not initialized. Call initialize() first.');
    }
  }

  private resolvePath(filePath: string): string {
    if (filePath.startsWith('/') || /^[a-zA-Z]:/.test(filePath)) {
      return filePath;
    }
    return resolve(this.options.projectRoot, filePath);
  }

  /**
   * Build orchestrator dependencies. In a minimal setup, the parser agent
   * serves as the orchestrator's parser, while other agents use stubs that
   * throw descriptive errors if the full pipeline is not configured.
   */
  private buildOrchestratorDeps(): OrchestratorDeps {
    const parserAgent = this.parserAgent!;

    // Real repair + classifier agents (replacing the earlier stubs).
    // The repair agent works through an MCP router whose read_range is a
    // read-only filesystem reader and whose write_fix is a deliberate NO-OP,
    // so investigations generate candidate patches WITHOUT ever mutating the
    // user's source files. The classifier is pure in-memory AST analysis over
    // the parsed CST (its only side effect is a harmless patches-table update).
    const repairAgent = new RepairAgent(this.buildRepairRouter());
    const classifierAgent = new ClassifierAgent(this.db!);

    return {
      parserAgent: {
        parseFile: (filePath: string) => parserAgent.parseFile(filePath),
        resolveSymbols: async (filePath: string) => {
          try {
            return await parserAgent.resolveSymbols(filePath);
          } catch {
            // LSP may not be available — symbol resolution is non-fatal
            return { resolutions: [], total_symbols: 0, resolved_count: 0, unresolved_count: 0 };
          }
        },
        buildCallGraph: async () => {
          // Call graph building requires the graph DB to be populated
          // This is handled separately in the full pipeline
          return { nodes: [], edges: [], entry_points: [] };
        },
      },
      bugProvingAgent: {
        investigate: async (target) => {
          // Use the real Bug_Proving_Agent with execution-based fuzzing
          const agent = new BugProvingAgent(this.db!);
          return agent.investigate(target);
        },
      },
      repairAgent: {
        generatePatches: (proof, target) =>
          repairAgent.generatePatches(proof, this.buildDefectContext(proof, target)),
      },
      classifierAgent: {
        classify: (patch, original) => classifierAgent.classify(patch, original),
      },
      sandboxAgent: {
        execute: async (_request) => {
          return {
            status: 'error',
            oracle_violations: [],
            duration_ms: 0,
            resource_usage: {
              cpu_time_seconds: 0,
              memory_peak_mb: 0,
              disk_io_mb: 0,
              wall_time_ms: 0,
            },
          };
        },
        isAvailable: async () => false,
      },
    };
  }

  /**
   * Build an MCP router for the RepairAgent. `read_range` reads the real source
   * file (read-only); `write_fix` is a deliberate NO-OP so patch generation
   * never edits the user's source during an investigation; `extract_method`
   * returns empty context (only used for supplementary context, not required).
   * None of these handlers touch the sandbox.
   */
  private buildRepairRouter(): McpRouter {
    const router = new McpRouter();

    router.registerTool({
      name: 'read_range',
      description: 'Read a range of lines from a source file (read-only).',
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
        const { file_path, start_line, end_line } = params as {
          file_path: string;
          start_line: number;
          end_line: number;
        };
        try {
          const allLines = readFileSync(file_path, 'utf-8').split('\n');
          const from = Math.max(0, start_line - 1);
          const to = Math.min(allLines.length, Math.max(from, end_line));
          return { success: true, data: { lines: allLines.slice(from, to) } };
        } catch {
          // Non-fatal: the agent falls back to empty content.
          return { success: true, data: { lines: [] } };
        }
      },
    });

    router.registerTool({
      name: 'extract_method',
      description: 'Extract a method body for supplementary context.',
      inputSchema: {
        type: 'object',
        properties: {
          file_path: { type: 'string' },
          method_name: { type: 'string' },
        },
        required: ['file_path', 'method_name'],
      },
      handler: async (): Promise<McpToolResult> => ({ success: true, data: { content: '' } }),
    });

    router.registerTool({
      name: 'write_fix',
      description: 'No-op: investigations never write candidate patches to source files.',
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
      handler: async (): Promise<McpToolResult> => ({
        success: true,
        data: { written: false, noop: true },
      }),
    });

    return router;
  }

  /**
   * Translate the orchestrator's `(proof, target)` into the `DefectContext` the
   * RepairAgent expects. The proof carries no line number, so the defect line is
   * located by finding the function in its source (falling back to line 1), and
   * variable states are derived from the proof's triggering input.
   */
  private buildDefectContext(
    proof: ProofOfFailureCertificate,
    target: InvestigationTarget
  ): DefectContext {
    const defectLine = this.locateDefectLine(target);
    return {
      defect_line: defectLine,
      file_path: target.file_path,
      context_window: {
        start_line: Math.max(1, defectLine - 10),
        end_line: defectLine + 10,
      },
      variable_states: deriveVariableStates(proof.test_input),
      specification: target.specification,
    };
  }

  /**
   * Best-effort location of the target function's line within its source file.
   * Falls back to line 1 if the file can't be read or the name isn't found.
   */
  private locateDefectLine(target: InvestigationTarget): number {
    const name = target.specification?.name || target.function_id;
    if (!name) return 1;
    try {
      const lines = readFileSync(target.file_path, 'utf-8').split('\n');
      const pattern = new RegExp(`\\b${escapeRegExp(name)}\\b`);
      for (let i = 0; i < lines.length; i++) {
        if (pattern.test(lines[i])) return i + 1;
      }
    } catch {
      // ignore — fall back to line 1
    }
    return 1;
  }
}

/**
 * Derive variable states from a proof's triggering input. When the input is a
 * plain object, each key becomes a named variable; otherwise there are none.
 */
function deriveVariableStates(testInput: unknown): VariableState[] {
  if (testInput === null || typeof testInput !== 'object' || Array.isArray(testInput)) {
    return [];
  }
  return Object.entries(testInput as Record<string, unknown>).map(([name, value]) => ({
    name,
    value,
    type: typeof value,
  }));
}

/** Escape a string for safe use inside a RegExp. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export default ProofDebugger;
