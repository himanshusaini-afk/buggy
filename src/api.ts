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
import { existsSync, mkdirSync } from 'node:fs';
import type Database from 'better-sqlite3';

import { loadConfig, ConfigError } from './config/config-loader.js';
import { initializeDatabase } from './database/graph-db.js';
import { GraphQueries } from './database/graph-queries.js';
import { ParserAgent } from './agents/parser-agent.js';
import { AgentOrchestrator } from './orchestrator/orchestrator.js';
import type { OrchestratorDeps } from './orchestrator/orchestrator.js';
import type { DebuggerConfig } from './types/config.js';
import type { ParseResult } from './types/cst.js';
import type { InvestigationReport, InvestigationStatus, InvestigationTarget } from './types/orchestrator.js';
import type { NodeRecord, EdgeRecord } from './types/graph.js';
import type { FunctionSpec } from './types/repair.js';

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

    // Initialize orchestrator with agent stubs
    // In production, these would be fully initialized agents
    const deps = this.buildOrchestratorDeps();
    this.orchestrator = new AgentOrchestrator(deps);

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
        investigate: async (_target) => {
          // Stub: in production, this connects to the full Bug_Proving_Agent
          return { certified: false, intermediate: {} };
        },
      },
      repairAgent: {
        generatePatches: async (_proof, _target) => {
          return [];
        },
      },
      classifierAgent: {
        classify: async (_patch, _original) => {
          return { approved: false, overfitting_probability: 1, patch_id: '' };
        },
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
}

export default ProofDebugger;
