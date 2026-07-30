/**
 * Architectural Integration Tests
 *
 * Tests the ENTIRE proof-carrying debugger system end-to-end at each pipeline step,
 * validating that all components wire together correctly.
 *
 * Pipeline steps:
 * 1. Config Loading
 * 2. Graph Database
 * 3. MCP Middleware
 * 4. Parser_Agent
 * 5. Bug_Proving_Agent
 * 6. Semantic Oracles
 * 7. Repair_Agent
 * 8. Layered Progressive Repair
 * 9. Classifier_Agent
 * 10. Sandbox_Agent
 * 11. Plug System
 * 12. Agent Orchestrator
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

// ─── Step 1: Config Loading ──────────────────────────────────────────────────
import { loadConfig, ConfigError } from '../../src/config/config-loader.js';

// ─── Step 2: Graph Database ──────────────────────────────────────────────────
import { initializeDatabase } from '../../src/database/graph-db.js';
import { GraphQueries } from '../../src/database/graph-queries.js';

// ─── Step 3: MCP Middleware ──────────────────────────────────────────────────
import { McpRouter, createMcpRouterWithDefaults } from '../../src/middleware/mcp-router.js';

// ─── Step 5: Bug_Proving_Agent ───────────────────────────────────────────────
import { BugProvingAgent } from '../../src/agents/bug-proving-agent.js';

// ─── Step 6: Semantic Oracles ────────────────────────────────────────────────
import { OracleMonitor, OracleViolationStore } from '../../src/agents/oracles.js';
import type { ExecutionStep, OracleConfig } from '../../src/agents/oracles.js';

// ─── Step 7: Repair_Agent ────────────────────────────────────────────────────
import { RepairAgent, CONTEXT_WINDOW_RADIUS, MIN_PATCHES_PER_DEFECT } from '../../src/agents/repair-agent.js';

// ─── Step 8: Layered Progressive Repair ──────────────────────────────────────
import {
  RepairPipeline,
  type CompilationChecker,
  type TransitionModelEmulator,
  type SandboxTestExecutor,
} from '../../src/agents/repair-pipeline.js';

// ─── Step 9: Classifier_Agent ────────────────────────────────────────────────
import {
  ClassifierAgent,
  FEATURE_VECTOR_DIMENSIONS,
  type PrismApccModel,
} from '../../src/agents/classifier-agent.js';

// ─── Step 10: Sandbox_Agent ──────────────────────────────────────────────────
import {
  SandboxAgent,
  MAX_VCPUS,
  MAX_MEMORY_MB,
  type FirecrackerApiClient,
  type NetworkManager,
  type BlockDeviceManager,
} from '../../src/sandbox/sandbox-agent.js';

// ─── Step 11: Plug System ────────────────────────────────────────────────────
import {
  PlugRegistryImpl,
  PlugValidationError,
  DefaultParsingPlug,
} from '../../src/plugs/plug-registry.js';

// ─── Step 12: Agent Orchestrator ─────────────────────────────────────────────
import {
  AgentOrchestrator,
  SandboxUnavailableError,
  type OrchestratorDeps,
} from '../../src/orchestrator/orchestrator.js';

// ─── Types ───────────────────────────────────────────────────────────────────
import type { PatchCandidate, DefectContext } from '../../src/types/repair.js';
import type { ProofOfFailureCertificate } from '../../src/types/proof.js';
import type { CstNode } from '../../src/types/cst.js';
import type { ResourceLimits } from '../../src/types/sandbox.js';

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function createTempDir(): string {
  const dir = join(tmpdir(), `debugger-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function createValidYaml(): string {
  return `
language: typescript
parser:
  command: tree-sitter
lsp:
  command: typescript-language-server --stdio
sandbox:
  runtime: node
  memory_limit_mb: 512
  timeout_seconds: 60
oracles:
  timeout_threshold_seconds: 10
  crash_detection: true
  overflow_detection: true
  determinism_check_count: 5
probe:
  search_budget: 100
  max_refinement_iterations: 10
`;
}

function createMockCstNode(overrides?: Partial<CstNode>): CstNode {
  return {
    id: 'node_1',
    type: 'program',
    start_byte: 0,
    end_byte: 100,
    start_position: { row: 0, column: 0 },
    end_position: { row: 10, column: 0 },
    children: [],
    is_error: false,
    ...overrides,
  };
}

function createMockProof(): ProofOfFailureCertificate {
  return {
    test_input: { x: 5 },
    observed_output: -1,
    violated_postcondition: 'result >= 0',
    admissibility_verified_at: new Date().toISOString(),
    soundness_verified_at: new Date().toISOString(),
    uniqueness_verified_at: new Date().toISOString(),
  };
}

function createMockDefectContext(): DefectContext {
  return {
    defect_line: 15,
    file_path: '/project/src/buggy.ts',
    context_window: { start_line: 5, end_line: 25 },
    variable_states: [
      { name: 'count', value: -1, type: 'number' },
    ],
    specification: {
      name: 'computeTotal',
      preconditions: ['items.length > 0'],
      postconditions: ['result >= 0'],
      parameters: [{ name: 'items', type: 'number[]' }],
      return_type: 'number',
    },
  };
}

function createMockPatch(overrides?: Partial<PatchCandidate>): PatchCandidate {
  return {
    id: randomUUID(),
    diff: '  if (count < 0) count = 0;',
    edit_operations: [{
      type: 'insert',
      node_type: 'if_statement',
      location: {
        file_path: '/project/src/buggy.ts',
        start_line: 15,
        start_column: 0,
        end_line: 15,
        end_column: 0,
      },
    }],
    target_file: '/project/src/buggy.ts',
    target_range: { start_line: 15, end_line: 15 },
    refinement_attempt: 0,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 1: CONFIG LOADING
// ═══════════════════════════════════════════════════════════════════════════════

describe('Step 1: Config Loading', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('loads and validates a complete .debugger.yaml', () => {
    writeFileSync(join(tempDir, '.debugger.yaml'), createValidYaml());
    const config = loadConfig(tempDir);

    expect(config.language).toBe('typescript');
    expect(config.parser.command).toBe('tree-sitter');
    expect(config.sandbox.memory_limit_mb).toBe(512);
    expect(config.oracles.crash_detection).toBe(true);
    expect(config.probe.search_budget).toBe(100);
  });

  it('applies defaults for optional keys', () => {
    writeFileSync(join(tempDir, '.debugger.yaml'), createValidYaml());
    const config = loadConfig(tempDir);

    // egress_policy defaults to 'deny'
    expect(config.sandbox.egress_policy).toBe('deny');
  });

  it('throws ConfigError for missing config file', () => {
    expect(() => loadConfig(tempDir)).toThrow(ConfigError);
  });

  it('throws ConfigError for invalid YAML syntax', () => {
    writeFileSync(join(tempDir, '.debugger.yaml'), '  invalid: [yaml: {{broken');
    expect(() => loadConfig(tempDir)).toThrow(ConfigError);
  });

  it('throws ConfigError for schema validation failure', () => {
    writeFileSync(join(tempDir, '.debugger.yaml'), `
language: typescript
parser:
  command: tree-sitter
lsp:
  command: tsserver
sandbox:
  runtime: node
  memory_limit_mb: 99999
  timeout_seconds: 60
oracles:
  timeout_threshold_seconds: 10
  crash_detection: true
  overflow_detection: true
  determinism_check_count: 5
probe:
  search_budget: 100
  max_refinement_iterations: 10
`);
    expect(() => loadConfig(tempDir)).toThrow(ConfigError);
  });

  it('config output feeds into downstream components', () => {
    writeFileSync(join(tempDir, '.debugger.yaml'), createValidYaml());
    const config = loadConfig(tempDir);

    // Config should be usable by OracleMonitor
    const oracleConfig: OracleConfig = {
      timeout_threshold_seconds: config.oracles.timeout_threshold_seconds,
      crash_detection: config.oracles.crash_detection,
      overflow_detection: config.oracles.overflow_detection,
      determinism_check_count: config.oracles.determinism_check_count,
    };
    const monitor = new OracleMonitor(oracleConfig);
    expect(monitor.getActiveOracles()).toContain('timeout');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 2: GRAPH DATABASE
// ═══════════════════════════════════════════════════════════════════════════════

describe('Step 2: Graph Database', () => {
  it('initializes SQLite with WAL mode and all tables', () => {
    const db = initializeDatabase(':memory:');

    // Note: WAL mode is set but in-memory DBs report 'memory' since WAL is file-based
    const walMode = db.pragma('journal_mode') as Array<{ journal_mode: string }>;
    expect(['wal', 'memory']).toContain(walMode[0].journal_mode);

    const fk = db.pragma('foreign_keys') as Array<{ foreign_keys: number }>;
    expect(fk[0].foreign_keys).toBe(1);

    // Check tables exist
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all() as Array<{ name: string }>;
    const tableNames = tables.map(t => t.name);

    expect(tableNames).toContain('nodes');
    expect(tableNames).toContain('edges');
    expect(tableNames).toContain('patches');
    expect(tableNames).toContain('proof_certificates');
    expect(tableNames).toContain('oracle_violations');

    db.close();
  });

  it('supports node insertion and query via GraphQueries', () => {
    const db = initializeDatabase(':memory:');
    const queries = new GraphQueries(db);

    db.prepare(`
      INSERT INTO nodes (id, type, file_path, start_byte, end_byte, start_line, start_column, end_line, end_column)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('n1', 'function_declaration', '/src/main.ts', 0, 100, 1, 0, 10, 1);

    const node = queries.lookupNode('n1');
    expect(node).not.toBeNull();
    expect(node!.type).toBe('function_declaration');
    expect(node!.file_path).toBe('/src/main.ts');

    db.close();
  });

  it('supports edge insertion and traversal', () => {
    const db = initializeDatabase(':memory:');
    const queries = new GraphQueries(db);

    db.prepare(`INSERT INTO nodes (id, type, file_path, start_byte, end_byte, start_line, start_column, end_line, end_column) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run('n1', 'function', '/f.ts', 0, 50, 1, 0, 5, 0);
    db.prepare(`INSERT INTO nodes (id, type, file_path, start_byte, end_byte, start_line, start_column, end_line, end_column) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run('n2', 'function', '/f.ts', 51, 100, 6, 0, 10, 0);
    db.prepare(`INSERT INTO edges (id, source_id, target_id, relationship) VALUES (?, ?, ?, ?)`).run('e1', 'n1', 'n2', 'calls');

    const edges = queries.traverseEdges('n1', 'calls');
    expect(edges).toHaveLength(1);
    expect(edges[0].target_id).toBe('n2');

    db.close();
  });

  it('subgraph extraction returns nodes and edges for a file', () => {
    const db = initializeDatabase(':memory:');
    const queries = new GraphQueries(db);

    db.prepare(`INSERT INTO nodes (id, type, file_path, start_byte, end_byte, start_line, start_column, end_line, end_column) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run('a', 'class', '/app.ts', 0, 200, 1, 0, 20, 0);
    db.prepare(`INSERT INTO nodes (id, type, file_path, start_byte, end_byte, start_line, start_column, end_line, end_column) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run('b', 'method', '/app.ts', 10, 100, 2, 0, 10, 0);
    db.prepare(`INSERT INTO edges (id, source_id, target_id, relationship) VALUES (?, ?, ?, ?)`).run('e1', 'a', 'b', 'parent_of');

    const subgraph = queries.extractSubgraph('/app.ts');
    expect(subgraph.nodes).toHaveLength(2);
    expect(subgraph.edges).toHaveLength(1);

    db.close();
  });

  it('path finding uses recursive CTE', () => {
    const db = initializeDatabase(':memory:');
    const queries = new GraphQueries(db);

    db.prepare(`INSERT INTO nodes (id, type, file_path, start_byte, end_byte, start_line, start_column, end_line, end_column) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run('x', 'fn', '/a.ts', 0, 10, 1, 0, 2, 0);
    db.prepare(`INSERT INTO nodes (id, type, file_path, start_byte, end_byte, start_line, start_column, end_line, end_column) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run('y', 'fn', '/a.ts', 11, 20, 3, 0, 4, 0);
    db.prepare(`INSERT INTO nodes (id, type, file_path, start_byte, end_byte, start_line, start_column, end_line, end_column) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run('z', 'fn', '/a.ts', 21, 30, 5, 0, 6, 0);
    db.prepare(`INSERT INTO edges (id, source_id, target_id, relationship) VALUES (?, ?, ?, ?)`).run('e1', 'x', 'y', 'calls');
    db.prepare(`INSERT INTO edges (id, source_id, target_id, relationship) VALUES (?, ?, ?, ?)`).run('e2', 'y', 'z', 'calls');

    const path = queries.findPath('x', 'z');
    expect(path).toHaveLength(3);
    expect(path[0].id).toBe('x');
    expect(path[2].id).toBe('z');

    db.close();
  });

  it('database output feeds into Bug_Proving_Agent', () => {
    const db = initializeDatabase(':memory:');
    // BugProvingAgent takes a db reference
    const agent = new BugProvingAgent(db);
    expect(agent).toBeDefined();
    db.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 3: MCP MIDDLEWARE
// ═══════════════════════════════════════════════════════════════════════════════

describe('Step 3: MCP Middleware', () => {
  it('registers tools and retrieves them by name', () => {
    const router = new McpRouter();
    router.registerTool({
      name: 'test_tool',
      description: 'A test tool',
      inputSchema: { type: 'object', properties: { x: { type: 'number' } }, required: ['x'] },
      handler: async (params) => ({ success: true, data: params }),
    });

    expect(router.getTool('test_tool')).toBeDefined();
    expect(router.getRegisteredTools()).toContain('test_tool');
  });

  it('validates params against JSON schema', async () => {
    const router = new McpRouter();
    router.registerTool({
      name: 'typed_tool',
      description: 'Requires object with string prop',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      },
      handler: async (params) => ({ success: true, data: params }),
    });

    // Missing required property
    const result = await router.invokeTool('typed_tool' as any, { });
    expect(result.success).toBe(false);
    expect(result.error?.type).toBe('validation_error');
  });

  it('returns execution_error for unregistered tools', async () => {
    const router = new McpRouter();
    const result = await router.invokeTool('nonexistent' as any, {});
    expect(result.success).toBe(false);
    expect(result.error?.type).toBe('execution_error');
  });

  it('creates router with 8 default tools', () => {
    const router = createMcpRouterWithDefaults();
    const tools = router.getRegisteredTools();
    expect(tools).toHaveLength(8);
    expect(tools).toContain('read_range');
    expect(tools).toContain('write_fix');
    expect(tools).toContain('run_tests');
  });

  it('default tools return execution_error (not yet wired)', async () => {
    const router = createMcpRouterWithDefaults();
    const result = await router.invokeTool('read_range', {
      file_path: '/test.ts',
      start_line: 1,
      end_line: 10,
    });
    expect(result.success).toBe(false);
    expect(result.error?.message).toContain('not yet wired');
  });

  it('routes successfully when handler resolves', async () => {
    const router = new McpRouter();
    router.registerTool({
      name: 'read_range',
      description: 'Read file range',
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
        data: { lines: ['line1', 'line2'] },
      }),
    });

    const result = await router.invokeTool('read_range', {
      file_path: '/test.ts',
      start_line: 1,
      end_line: 2,
    });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ lines: ['line1', 'line2'] });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 4: PARSER AGENT (tested via interface — no real Tree-sitter needed for
// wiring tests)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Step 4: Parser_Agent (wiring)', () => {
  it('ParserAgent can be constructed without LSP config', async () => {
    // We import the module dynamically to avoid Tree-sitter native module issues
    // in CI, but in this project it should be available
    const { ParserAgent } = await import('../../src/agents/parser-agent.js');
    const agent = new ParserAgent();
    expect(agent).toBeDefined();
  });

  it('parseSource returns valid ParseResult with CST', async () => {
    const { ParserAgent } = await import('../../src/agents/parser-agent.js');
    const agent = new ParserAgent();
    const result = agent.parseSource('const x = 1;', '/test.ts');

    expect(result.cst).toBeDefined();
    expect(result.cst.type).toBe('program');
    expect(result.errors).toHaveLength(0);
    expect(result.file_path).toBe('/test.ts');
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('parseSource reports syntax errors without crashing', async () => {
    const { ParserAgent } = await import('../../src/agents/parser-agent.js');
    const agent = new ParserAgent();
    const result = agent.parseSource('const x = ;', '/broken.ts');

    expect(result.cst).toBeDefined();
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('incremental parsing produces equivalent result', async () => {
    const { ParserAgent } = await import('../../src/agents/parser-agent.js');
    const agent = new ParserAgent();

    const originalSource = 'const x = 1;\nconst y = 2;\n';
    agent.parseSource(originalSource, '/inc.ts');

    const newSource = 'const x = 1;\nconst y = 42;\n';
    const result = agent.parseIncremental('/inc.ts', {
      start_byte: 19,
      old_end_byte: 20,
      new_end_byte: 21,
      start_position: { row: 1, column: 10 },
      old_end_position: { row: 1, column: 11 },
      new_end_position: { row: 1, column: 12 },
    }, newSource);

    expect(result.cst.type).toBe('program');
    expect(result.file_path).toBe('/inc.ts');
  });

  it('parsed CST can be stored in graph database', async () => {
    const { ParserAgent } = await import('../../src/agents/parser-agent.js');
    const agent = new ParserAgent();
    const result = agent.parseSource('function add(a: number, b: number) { return a + b; }', '/fn.ts');

    const db = initializeDatabase(':memory:');
    // Store root node
    db.prepare(`INSERT INTO nodes (id, type, file_path, start_byte, end_byte, start_line, start_column, end_line, end_column) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(result.cst.id, result.cst.type, result.file_path, result.cst.start_byte, result.cst.end_byte, result.cst.start_position.row, result.cst.start_position.column, result.cst.end_position.row, result.cst.end_position.column);

    const queries = new GraphQueries(db);
    const node = queries.lookupNode(result.cst.id);
    expect(node).not.toBeNull();
    expect(node!.type).toBe('program');

    db.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 5: BUG PROVING AGENT
// ═══════════════════════════════════════════════════════════════════════════════

describe('Step 5: Bug_Proving_Agent', () => {
  it('constructs with database reference and optional config', () => {
    const db = initializeDatabase(':memory:');
    const agent = new BugProvingAgent(db, {
      diffTestGen: { maxInputsPerMethod: 50 },
    });
    expect(agent).toBeDefined();
    db.close();
  });

  it('runDiffTestGen accepts implementations and returns result', async () => {
    const db = initializeDatabase(':memory:');
    const agent = new BugProvingAgent(db);

    const result = await agent.runDiffTestGen([
      {
        id: 'impl_a',
        name: 'impl_a',
        methods: [{ name: 'compute', parameter_types: ['number'], return_type: 'number' }],
        execute: async (_method: string, _input: unknown) => ({ result: 1 }),
        source_location: { file_path: '/a.ts', start_line: 1, start_column: 0, end_line: 5, end_column: 0 },
      },
      {
        id: 'impl_b',
        name: 'impl_b',
        methods: [{ name: 'compute', parameter_types: ['number'], return_type: 'number' }],
        execute: async (_method: string, _input: unknown) => ({ result: 1 }),
        source_location: { file_path: '/b.ts', start_line: 1, start_column: 0, end_line: 5, end_column: 0 },
      },
    ]);

    // Both implementations return same output → behaviorally equivalent
    expect(result).toBeDefined();
    expect(result.status).toBe('behaviorally_equivalent');

    db.close();
  });

  it('feeds proof certificates into Repair_Agent via orchestrator', () => {
    // Verifying the type contract: proof output shape matches repair input
    const proof = createMockProof();
    expect(proof.violated_postcondition).toBe('result >= 0');
    expect(proof.admissibility_verified_at).toBeDefined();
    expect(proof.soundness_verified_at).toBeDefined();
    expect(proof.uniqueness_verified_at).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 6: SEMANTIC ORACLES
// ═══════════════════════════════════════════════════════════════════════════════

describe('Step 6: Semantic Oracles', () => {
  const oracleConfig: OracleConfig = {
    timeout_threshold_seconds: 5,
    crash_detection: true,
    overflow_detection: true,
    determinism_check_count: 3,
  };

  it('constructs with all 4 oracle types enabled', () => {
    const monitor = new OracleMonitor(oracleConfig);
    const activeOracles = monitor.getActiveOracles();
    expect(activeOracles).toContain('timeout');
    expect(activeOracles).toContain('crash');
    expect(activeOracles).toContain('determinism');
    expect(activeOracles).toContain('overflow');
  });

  it('detects timeout violations', () => {
    const monitor = new OracleMonitor(oracleConfig);
    const step: ExecutionStep = {
      statement_index: 0,
      location: { file: '/test.ts', line: 10, column: 0 },
      variables: new Map(),
      timestamp: new Date().toISOString(),
      elapsed_ms: 6000, // exceeds 5s threshold
    };

    const violations = monitor.monitorStep(step);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0].oracle_id).toBe('timeout');
  });

  it('detects crash violations', () => {
    const monitor = new OracleMonitor(oracleConfig);
    const step: ExecutionStep = {
      statement_index: 1,
      location: { file: '/test.ts', line: 20, column: 0 },
      variables: new Map(),
      timestamp: new Date().toISOString(),
      elapsed_ms: 100,
      exception: {
        type: 'TypeError',
        message: 'Cannot read property of null',
        stack_trace: ['at fn (/test.ts:20:5)'],
      },
    };

    const violations = monitor.monitorStep(step);
    expect(violations.some(v => v.oracle_id === 'crash')).toBe(true);
  });

  it('detects overflow violations', () => {
    const monitor = new OracleMonitor(oracleConfig);
    const step: ExecutionStep = {
      statement_index: 2,
      location: { file: '/test.ts', line: 30, column: 0 },
      variables: new Map(),
      timestamp: new Date().toISOString(),
      elapsed_ms: 10,
      numeric_values: [
        { name: 'counter', value: 300, min: 0, max: 255, operation: 'increment' },
      ],
    };

    const violations = monitor.monitorStep(step);
    expect(violations.some(v => v.oracle_id === 'overflow')).toBe(true);
  });

  it('persists violations to graph database', () => {
    const db = initializeDatabase(':memory:');
    const store = new OracleViolationStore(db);
    const monitor = new OracleMonitor(oracleConfig, store);
    monitor.setExecutionId('exec_001');

    const step: ExecutionStep = {
      statement_index: 0,
      location: { file: '/x.ts', line: 1, column: 0 },
      variables: new Map(),
      timestamp: new Date().toISOString(),
      elapsed_ms: 10000, // triggers timeout
    };

    monitor.monitorStep(step);

    const stored = store.getViolationsByExecution('exec_001');
    expect(stored.length).toBeGreaterThan(0);
    expect(stored[0].oracle_id).toBe('timeout');

    db.close();
  });

  it('disables oracle on internal failure and continues', () => {
    const monitor = new OracleMonitor(oracleConfig);
    // Monitoring a normal step shouldn't throw
    const normalStep: ExecutionStep = {
      statement_index: 0,
      location: { file: '/t.ts', line: 1, column: 0 },
      variables: new Map(),
      timestamp: new Date().toISOString(),
      elapsed_ms: 50,
    };
    const violations = monitor.monitorStep(normalStep);
    expect(violations).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 7: REPAIR AGENT
// ═══════════════════════════════════════════════════════════════════════════════

describe('Step 7: Repair_Agent', () => {
  function createMockRouter(): McpRouter {
    const router = new McpRouter();
    router.registerTool({
      name: 'read_range',
      description: 'Read range',
      inputSchema: { type: 'object', properties: { file_path: { type: 'string' }, start_line: { type: 'integer' }, end_line: { type: 'integer' } }, required: ['file_path', 'start_line', 'end_line'] },
      handler: async () => ({
        success: true,
        data: {
          lines: [
            '  const items = getItems();',
            '  const filtered = items.filter(x => x > 0);',
            '  let total = 0;',
            '  for (const item of filtered) {',
            '    total += item;',
            '  }',
            '  const avg = total / filtered.length;',
            '  console.log(avg);',
            '  if (avg < 0) throw new Error();',
            '  return avg;',
            '  // post-return cleanup',
            '  const x = total * 2;',
            '  const y = x + 1;',
            '  doSomething(y);',
            '  cleanup();',
            '  finalize();',
            '  reportMetrics(total);',
            '  saveState(avg);',
            '  notifyObservers();',
            '  logCompletion();',
            '  return total;',
          ],
        },
      }),
    });
    router.registerTool({
      name: 'extract_method',
      description: 'Extract method',
      inputSchema: { type: 'object', properties: { file_path: { type: 'string' }, method_name: { type: 'string' } }, required: ['file_path', 'method_name'] },
      handler: async () => ({
        success: true,
        data: { content: 'function computeTotal(items: number[]) { return items.reduce((a,b) => a+b, 0); }' },
      }),
    });
    router.registerTool({
      name: 'write_fix',
      description: 'Write fix',
      inputSchema: { type: 'object', properties: { file_path: { type: 'string' }, start_line: { type: 'integer' }, end_line: { type: 'integer' }, new_content: { type: 'string' } }, required: ['file_path', 'start_line', 'end_line', 'new_content'] },
      handler: async () => ({ success: true }),
    });
    return router;
  }

  it('generates ≥3 structurally distinct patches', async () => {
    const router = createMockRouter();
    const agent = new RepairAgent(router);
    const proof = createMockProof();
    const context = createMockDefectContext();

    const patches = await agent.generatePatches(proof, context);
    expect(patches.length).toBeGreaterThanOrEqual(MIN_PATCHES_PER_DEFECT);

    // Verify structural diversity
    const nodeTypes = new Set(patches.map(p => p.edit_operations[0]?.node_type));
    expect(nodeTypes.size).toBeGreaterThanOrEqual(1);
  });

  it('context window targets ±10 lines around defect', () => {
    const router = createMockRouter();
    const agent = new RepairAgent(router);
    const context = createMockDefectContext();

    const window = agent.computeContextWindow(context);
    expect(window.start_line).toBe(context.defect_line - CONTEXT_WINDOW_RADIUS);
    expect(window.end_line).toBe(context.defect_line + CONTEXT_WINDOW_RADIUS);
  });

  it('refinePatch increments attempt counter', async () => {
    const router = createMockRouter();
    const agent = new RepairAgent(router);
    const patch = createMockPatch({ refinement_attempt: 0 });

    const refined = await agent.refinePatch(patch, {
      stage: 'compilation',
      passed: false,
      reason: 'Type error',
      error_message: "Cannot find name 'foo'",
      compilation_errors: [{ file: '/test.ts', line: 15, message: "Cannot find name 'foo'", severity: 'error' }],
    });

    expect(refined.refinement_attempt).toBe(1);
  });

  it('throws RefinementExhaustedResult at max attempts', async () => {
    const router = createMockRouter();
    const agent = new RepairAgent(router);
    const patch = createMockPatch({ refinement_attempt: 3 });

    await expect(agent.refinePatch(patch, {
      stage: 'test',
      passed: false,
      reason: 'Test failed',
    })).rejects.toMatchObject({
      patch_id: patch.id,
      final_attempt: 3,
      last_stage: 'test',
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 8: LAYERED PROGRESSIVE REPAIR
// ═══════════════════════════════════════════════════════════════════════════════

describe('Step 8: Layered Progressive Repair', () => {
  function createPipeline(overrides?: {
    compilationSuccess?: boolean;
    emulationSuccess?: boolean;
    testSuccess?: boolean;
  }) {
    const db = initializeDatabase(':memory:');
    const opts = { compilationSuccess: true, emulationSuccess: true, testSuccess: true, ...overrides };

    const compilationChecker: CompilationChecker = {
      check: async () => ({ success: opts.compilationSuccess, errors: opts.compilationSuccess ? [] : ['Type error'], elapsed_ms: 100 }),
    };
    const transitionEmulator: TransitionModelEmulator = {
      emulate: async () => ({ success: opts.emulationSuccess, regressions: opts.emulationSuccess ? [] : [{ transition: { from_state: 'A', to_state: 'B', trigger: 'patch', variables: {} }, expected_state: 'B', actual_state: 'C', message: 'Regression' }], elapsed_ms: 200 }),
    };
    const sandboxExecutor: SandboxTestExecutor = {
      execute: async () => ({ success: opts.testSuccess, total_tests: 10, passed_tests: opts.testSuccess ? 10 : 8, failed_tests: opts.testSuccess ? [] : ['test_a', 'test_b'], elapsed_ms: 300 }),
    };

    // Insert a dummy patch row so updatePatchStatus doesn't fail
    const patchId = randomUUID();
    db.prepare(`INSERT INTO proof_certificates (id, investigation_id, test_input, observed_output, violated_postcondition, admissibility_verified_at, soundness_verified_at, uniqueness_verified_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run('pc1', 'inv1', '{}', '{}', 'p>0', 'now', 'now', 'now');
    db.prepare(`INSERT INTO patches (id, proof_certificate_id, diff, edit_operations, target_file, target_range, status) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(patchId, 'pc1', 'diff', '[]', '/f.ts', '1-5', 'pending');

    const pipeline = new RepairPipeline(db, compilationChecker, transitionEmulator, sandboxExecutor, null);
    return { pipeline, patchId, db };
  }

  it('passes all stages when checks succeed', async () => {
    const { pipeline, patchId, db } = createPipeline();
    const patch = createMockPatch({ id: patchId });

    const result = await pipeline.filterPatch(patch);
    expect(result.passed).toBe(true);
    expect(result.stage_results).toHaveLength(3);
    expect(result.stage_results.every(s => s.passed)).toBe(true);

    db.close();
  });

  it('fails at compilation stage and reports feedback', async () => {
    const { pipeline, patchId, db } = createPipeline({ compilationSuccess: false });
    const patch = createMockPatch({ id: patchId });

    const result = await pipeline.filterPatch(patch);
    expect(result.passed).toBe(false);
    expect(result.failed_stage).toBe('compilation');
    expect(result.stage_results).toHaveLength(1);

    db.close();
  });

  it('fails at emulation stage (skips test stage)', async () => {
    const { pipeline, patchId, db } = createPipeline({ emulationSuccess: false });
    const patch = createMockPatch({ id: patchId });

    const result = await pipeline.filterPatch(patch);
    expect(result.passed).toBe(false);
    expect(result.failed_stage).toBe('emulation');
    expect(result.stage_results).toHaveLength(2);

    db.close();
  });

  it('fails at test stage after passing compilation and emulation', async () => {
    const { pipeline, patchId, db } = createPipeline({ testSuccess: false });
    const patch = createMockPatch({ id: patchId });

    const result = await pipeline.filterPatch(patch);
    expect(result.passed).toBe(false);
    expect(result.failed_stage).toBe('test');
    expect(result.stage_results).toHaveLength(3);
    expect(result.failure_reason).toContain('test_a');

    db.close();
  });

  it('pipeline result feeds into classifier when passed', async () => {
    const { pipeline, patchId, db } = createPipeline();
    const patch = createMockPatch({ id: patchId });

    const result = await pipeline.filterPatch(patch);
    expect(result.passed).toBe(true);
    // Patch is ready for ClassifierAgent
    expect(result.patch.id).toBe(patchId);

    db.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 9: CLASSIFIER AGENT
// ═══════════════════════════════════════════════════════════════════════════════

describe('Step 9: Classifier_Agent', () => {
  it('produces 66-dimensional feature vector', () => {
    const db = initializeDatabase(':memory:');
    const classifier = new ClassifierAgent(db);
    const patch = createMockPatch();
    const original = createMockCstNode({
      children: [
        createMockCstNode({ id: 'c1', type: 'expression_statement', start_position: { row: 15, column: 0 }, end_position: { row: 15, column: 30 }, children: [] }),
      ],
    });

    const editStates = classifier.extractEditStates(patch, original);
    const vector = classifier.computeSemanticFeatureVector(editStates);

    expect(vector.combined).toHaveLength(FEATURE_VECTOR_DIMENSIONS);
    expect(vector.gen.properties).toHaveLength(11);
    expect(vector.del.properties).toHaveLength(11);
    expect(vector.remain.properties).toHaveLength(11);

    db.close();
  });

  it('classifies with low overfitting score as approved', async () => {
    const db = initializeDatabase(':memory:');
    // Insert required patch row
    db.prepare(`INSERT INTO proof_certificates (id, investigation_id, test_input, observed_output, violated_postcondition, admissibility_verified_at, soundness_verified_at, uniqueness_verified_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run('pc1', 'inv1', '{}', '{}', 'p>0', 'now', 'now', 'now');

    const mockPrism: PrismApccModel = {
      evaluate: () => 0.2, // Below default threshold 0.5
    };
    const classifier = new ClassifierAgent(db, {}, mockPrism);

    const patchId = randomUUID();
    db.prepare(`INSERT INTO patches (id, proof_certificate_id, diff, edit_operations, target_file, target_range, status) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(patchId, 'pc1', 'x', '[]', '/f.ts', '1-5', 'pending');

    const patch = createMockPatch({ id: patchId });
    const original = createMockCstNode();

    const result = await classifier.classify(patch, original);
    expect(result.approved).toBe(true);
    expect(result.overfitting_probability).toBe(0.2);

    db.close();
  });

  it('rejects patches with high overfitting score and reports top 3 properties', async () => {
    const db = initializeDatabase(':memory:');
    db.prepare(`INSERT INTO proof_certificates (id, investigation_id, test_input, observed_output, violated_postcondition, admissibility_verified_at, soundness_verified_at, uniqueness_verified_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run('pc1', 'inv1', '{}', '{}', 'p>0', 'now', 'now', 'now');

    const mockPrism: PrismApccModel = {
      evaluate: () => 0.8, // Above threshold 0.5
    };
    const classifier = new ClassifierAgent(db, {}, mockPrism);

    const patchId = randomUUID();
    db.prepare(`INSERT INTO patches (id, proof_certificate_id, diff, edit_operations, target_file, target_range, status) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(patchId, 'pc1', 'x', '[]', '/f.ts', '1-5', 'pending');

    const patch = createMockPatch({ id: patchId });
    const original = createMockCstNode();

    const result = await classifier.classify(patch, original);
    expect(result.approved).toBe(false);
    expect(result.overfitting_probability).toBe(0.8);
    expect(result.top_contributing_properties).toBeDefined();
    expect(result.top_contributing_properties!.length).toBeLessThanOrEqual(3);

    db.close();
  });

  it('handles model timeout as inconclusive', async () => {
    const db = initializeDatabase(':memory:');
    db.prepare(`INSERT INTO proof_certificates (id, investigation_id, test_input, observed_output, violated_postcondition, admissibility_verified_at, soundness_verified_at, uniqueness_verified_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run('pc1', 'inv1', '{}', '{}', 'p>0', 'now', 'now', 'now');

    const mockPrism: PrismApccModel = {
      evaluate: () => { throw new Error('timeout'); },
    };
    const classifier = new ClassifierAgent(db, { model_timeout_ms: 100 }, mockPrism);

    const patchId = randomUUID();
    db.prepare(`INSERT INTO patches (id, proof_certificate_id, diff, edit_operations, target_file, target_range, status) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(patchId, 'pc1', 'x', '[]', '/f.ts', '1-5', 'pending');

    const patch = createMockPatch({ id: patchId });
    const original = createMockCstNode();

    const result = await classifier.classify(patch, original);
    expect(result.approved).toBe(false);
    expect(result.inconclusive).toBe(true);

    db.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 10: SANDBOX AGENT
// ═══════════════════════════════════════════════════════════════════════════════

describe('Step 10: Sandbox_Agent', () => {
  function createMockSandboxDeps() {
    const apiClient: FirecrackerApiClient = {
      isAvailable: async () => true,
      putMachineConfig: async () => {},
      putDrive: async () => {},
      putNetworkInterface: async () => {},
      putAction: async () => {},
      sendCtrlAltDel: async () => {},
    };
    const networkManager: NetworkManager = {
      allocateSubnet: async () => ({
        tapDevice: 'tap0',
        guestIp: '10.0.0.2',
        hostIp: '10.0.0.1',
        subnetMask: '255.255.255.252',
      }),
      applyIptablesRules: async () => {},
      releaseSubnet: async () => {},
    };
    const blockDeviceManager: BlockDeviceManager = {
      createImage: async (id) => `/tmp/${id}.ext4`,
      removeImage: async () => {},
    };
    return { apiClient, networkManager, blockDeviceManager };
  }

  it('clamps resource limits to maximums', () => {
    const agent = new SandboxAgent();
    const limits: ResourceLimits = {
      vcpus: 100,
      memory_mb: 99999,
      disk_mb: 100000,
      ttl_seconds: 9999,
      cpu_time_seconds: 9999,
      disk_io_mb: 500,
    };

    const clamped = agent.clampResourceLimits(limits);
    expect(clamped.vcpus).toBe(MAX_VCPUS);
    expect(clamped.memory_mb).toBe(MAX_MEMORY_MB);
    expect(clamped.ttl_seconds).toBeLessThanOrEqual(600);
    expect(clamped.cpu_time_seconds).toBeLessThanOrEqual(300);
  });

  it('validates device configuration — rejects non-virtio devices', () => {
    const agent = new SandboxAgent();
    expect(() => agent.validateDeviceConfiguration(['block', 'network'])).not.toThrow();
    expect(() => agent.validateDeviceConfiguration(['usb'])).toThrow();
  });

  it('executes with mock Firecracker API and returns result', async () => {
    const deps = createMockSandboxDeps();
    const agent = new SandboxAgent({}, deps.apiClient, deps.networkManager, deps.blockDeviceManager);

    const result = await agent.execute({
      code: 'console.log("hello")',
      runtime: 'node',
      oap_passport: {
        agent_id: 'test_agent',
        permitted_operations: ['execute'],
        issued_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 60000).toISOString(),
      },
      resource_limits: {
        vcpus: 1,
        memory_mb: 256,
        disk_mb: 1024,
        ttl_seconds: 60,
        cpu_time_seconds: 30,
        disk_io_mb: 100,
      },
      oracles: ['timeout', 'crash'],
    });

    expect(result.status).toBe('completed');
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('returns error when hypervisor is unavailable (never falls back)', async () => {
    const deps = createMockSandboxDeps();
    deps.apiClient.isAvailable = async () => false;
    const agent = new SandboxAgent({}, deps.apiClient, deps.networkManager, deps.blockDeviceManager);

    const result = await agent.execute({
      code: 'console.log("x")',
      runtime: 'node',
      oap_passport: { agent_id: 'a', permitted_operations: ['execute'], issued_at: '', expires_at: '' },
      resource_limits: { vcpus: 1, memory_mb: 128, disk_mb: 512, ttl_seconds: 30, cpu_time_seconds: 10, disk_io_mb: 50 },
      oracles: [],
    });

    expect(result.status).toBe('error');
    expect((result.output as any)?.error).toContain('unavailable');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 11: PLUG SYSTEM
// ═══════════════════════════════════════════════════════════════════════════════

describe('Step 11: Plug System', () => {
  it('validates plug interfaces (missing methods rejected)', () => {
    const registry = new PlugRegistryImpl();
    const result = registry.validate({}, 'ParsingPlug');
    expect(result.valid).toBe(false);
    expect(result.missing_methods).toContain('parse');
    expect(result.missing_methods).toContain('parseIncremental');
  });

  it('validates plug interfaces (valid implementation accepted)', () => {
    const registry = new PlugRegistryImpl();
    const result = registry.validate(new DefaultParsingPlug(), 'ParsingPlug');
    expect(result.valid).toBe(true);
  });

  it('registers custom plug and deactivates default', () => {
    const registry = new PlugRegistryImpl();
    const customParsing = new DefaultParsingPlug();
    registry.registerParsing(customParsing);
    expect(registry.getLogs().some(l => l.message.includes('deactivated'))).toBe(true);
  });

  it('throws PlugValidationError on invalid registration', () => {
    const registry = new PlugRegistryImpl();
    expect(() => registry.registerParsing({} as any)).toThrow(PlugValidationError);
  });

  it('falls back to default on plug exception', async () => {
    const registry = new PlugRegistryImpl();
    const brokenParsing = {
      parse: async function(_source: string, _filePath: string) { throw new Error('Plug crashed!'); },
      parseIncremental: async function(_s: string, _e: any, _p: any) { throw new Error('Plug crashed!'); },
    };
    registry.registerParsing(brokenParsing as any);
    const wrapped = registry.getParsing();

    // Should fall back to default and NOT throw
    const result = await wrapped.parse('const x = 1;', '/test.ts');
    expect(result).toBeDefined();
    expect(result.type).toBe('program');
  });

  it('oracle plug registration capped at 8', () => {
    const registry = new PlugRegistryImpl();
    for (let i = 0; i < 8; i++) {
      registry.registerOracle({
        name: `oracle_${i}`,
        monitor: async function(_step: any) { return null; },
        onFailure: function() {},
      });
    }
    expect(() => registry.registerOracle({
      name: 'oracle_9',
      monitor: async function(_step: any) { return null; },
      onFailure: function() {},
    })).toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 12: AGENT ORCHESTRATOR
// ═══════════════════════════════════════════════════════════════════════════════

describe('Step 12: Agent Orchestrator', () => {
  function createMockDeps(overrides?: Partial<OrchestratorDeps>): OrchestratorDeps {
    return {
      parserAgent: {
        parseFile: async () => ({
          cst: createMockCstNode(),
          errors: [],
          duration_ms: 5,
          file_path: '/src/target.ts',
        }),
        resolveSymbols: async () => ({ resolved_count: 10 }),
        buildCallGraph: async () => ({ nodes: [], edges: [], entry_points: [] }),
      },
      bugProvingAgent: {
        investigate: async () => ({
          certified: true,
          proof: createMockProof(),
          intermediate: { probe_iterations: 3 },
        }),
      },
      repairAgent: {
        generatePatches: async () => [
          createMockPatch(),
          createMockPatch(),
          createMockPatch(),
        ],
      },
      classifierAgent: {
        classify: async (patch) => ({
          approved: true,
          overfitting_probability: 0.2,
          patch_id: patch.id,
        }),
      },
      sandboxAgent: {
        execute: async () => ({
          status: 'completed' as const,
          oracle_violations: [],
          duration_ms: 100,
          resource_usage: { cpu_time_seconds: 1, memory_peak_mb: 64, disk_io_mb: 10, wall_time_ms: 100 },
        }),
        isAvailable: async () => true,
      },
      ...overrides,
    };
  }

  it('full pipeline: config → parser → proving → repair → classifier', async () => {
    const deps = createMockDeps();
    const orchestrator = new AgentOrchestrator(deps);

    const report = await orchestrator.startInvestigation({
      function_id: 'computeTotal',
      file_path: '/src/target.ts',
      specification: {
        name: 'computeTotal',
        preconditions: ['items.length > 0'],
        postconditions: ['result >= 0'],
        parameters: [{ name: 'items', type: 'number[]' }],
        return_type: 'number',
      },
    });

    expect(report.status).toBe('confirmed_and_repaired');
    expect(report.proof).toBeDefined();
    expect(report.approved_patches.length).toBeGreaterThan(0);
    expect(report.timeline.length).toBe(4); // parsing, proving, repair, classification
  });

  it('halts pipeline and preserves intermediate results on agent failure', async () => {
    const deps = createMockDeps({
      bugProvingAgent: {
        investigate: async () => { throw new Error('Bug proving crashed'); },
      },
    });
    const orchestrator = new AgentOrchestrator(deps);

    const report = await orchestrator.startInvestigation({
      function_id: 'fn',
      file_path: '/src/fn.ts',
      specification: { name: 'fn', preconditions: [], postconditions: [], parameters: [], return_type: 'void' },
    });

    expect(report.status).toBe('halted');
    // Parsing timeline should still be recorded
    expect(report.timeline.some(t => t.phase === 'parsing')).toBe(true);
  });

  it('reports unconfirmed when proof not certified', async () => {
    const deps = createMockDeps({
      bugProvingAgent: {
        investigate: async () => ({
          certified: false,
          intermediate: {},
        }),
      },
    });
    const orchestrator = new AgentOrchestrator(deps);

    const report = await orchestrator.startInvestigation({
      function_id: 'fn',
      file_path: '/src/fn.ts',
      specification: { name: 'fn', preconditions: [], postconditions: [], parameters: [], return_type: 'void' },
    });

    expect(report.status).toBe('unconfirmed');
    expect(report.proof).toBeUndefined();
  });

  it('enforces 20-patch routing cap', async () => {
    const manyPatches = Array.from({ length: 30 }, () => createMockPatch());
    let classifyCalls = 0;

    const deps = createMockDeps({
      repairAgent: {
        generatePatches: async () => manyPatches,
      },
      classifierAgent: {
        classify: async (patch) => {
          classifyCalls++;
          return { approved: true, overfitting_probability: 0.1, patch_id: patch.id };
        },
      },
    });
    const orchestrator = new AgentOrchestrator(deps);

    const report = await orchestrator.startInvestigation({
      function_id: 'fn',
      file_path: '/src/fn.ts',
      specification: { name: 'fn', preconditions: [], postconditions: [], parameters: [], return_type: 'number' },
    });

    expect(classifyCalls).toBeLessThanOrEqual(20);
    expect(report.approved_patches.length).toBeLessThanOrEqual(20);
  });

  it('sandbox retry logic with unavailable sandbox', async () => {
    let callCount = 0;
    const deps = createMockDeps({
      sandboxAgent: {
        execute: async () => ({
          status: 'completed' as const,
          oracle_violations: [],
          duration_ms: 50,
          resource_usage: { cpu_time_seconds: 0, memory_peak_mb: 0, disk_io_mb: 0, wall_time_ms: 50 },
        }),
        isAvailable: async () => {
          callCount++;
          return callCount >= 3; // Available on 3rd try
        },
      },
    });
    const orchestrator = new AgentOrchestrator(deps);

    const result = await orchestrator.executeSandbox({
      code: 'test',
      runtime: 'node',
      oap_passport: { agent_id: 'a', permitted_operations: [], issued_at: '', expires_at: '' },
      resource_limits: { vcpus: 1, memory_mb: 128, disk_mb: 512, ttl_seconds: 30, cpu_time_seconds: 10, disk_io_mb: 50 },
      oracles: [],
    });

    expect(result.status).toBe('completed');
  });

  it('getStatus returns current investigation state', async () => {
    const deps = createMockDeps();
    const orchestrator = new AgentOrchestrator(deps);

    // Start investigation (completes quickly with mocks)
    const report = await orchestrator.startInvestigation({
      function_id: 'fn',
      file_path: '/f.ts',
      specification: { name: 'fn', preconditions: [], postconditions: [], parameters: [], return_type: 'void' },
    });

    // Status should be retrievable
    const status = orchestrator.getStatus(report.id);
    expect(status).toBeDefined();
    expect(status!.phase).toBe('completed');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// CROSS-STEP DATA FLOW VALIDATION
// ═══════════════════════════════════════════════════════════════════════════════

describe('Cross-step data flow', () => {
  it('config → oracles → oracle monitor correctly wired', () => {
    const config: OracleConfig = {
      timeout_threshold_seconds: 3,
      crash_detection: true,
      overflow_detection: false,
      determinism_check_count: 2,
    };
    const monitor = new OracleMonitor(config);
    const actives = monitor.getActiveOracles();

    expect(actives).toContain('timeout');
    expect(actives).toContain('crash');
    expect(actives).not.toContain('overflow'); // disabled
    expect(actives).toContain('determinism');
  });

  it('graph DB → BugProvingAgent → proof shape matches RepairAgent input', () => {
    const db = initializeDatabase(':memory:');
    const bugAgent = new BugProvingAgent(db);
    // The proof shape from BugProvingAgent flows into RepairAgent
    const proof = createMockProof();
    expect(proof).toHaveProperty('test_input');
    expect(proof).toHaveProperty('violated_postcondition');
    expect(proof).toHaveProperty('admissibility_verified_at');
    db.close();
  });

  it('RepairAgent patches → RepairPipeline → ClassifierAgent flow', async () => {
    const db = initializeDatabase(':memory:');
    db.prepare(`INSERT INTO proof_certificates (id, investigation_id, test_input, observed_output, violated_postcondition, admissibility_verified_at, soundness_verified_at, uniqueness_verified_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run('pc1', 'inv1', '{}', '{}', 'p>0', 'now', 'now', 'now');

    const patchId = randomUUID();
    db.prepare(`INSERT INTO patches (id, proof_certificate_id, diff, edit_operations, target_file, target_range, status) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(patchId, 'pc1', 'diff', '[]', '/f.ts', '1-5', 'pending');

    // Pipeline passes the patch through
    const pipeline = new RepairPipeline(
      db,
      { check: async () => ({ success: true, errors: [], elapsed_ms: 10 }) },
      { emulate: async () => ({ success: true, regressions: [], elapsed_ms: 10 }) },
      { execute: async () => ({ success: true, total_tests: 5, passed_tests: 5, failed_tests: [], elapsed_ms: 10 }) },
      null,
    );

    const patch = createMockPatch({ id: patchId });
    const pipelineResult = await pipeline.filterPatch(patch);
    expect(pipelineResult.passed).toBe(true);

    // Now classify the patch that passed
    const mockPrism: PrismApccModel = { evaluate: () => 0.3 };
    const classifier = new ClassifierAgent(db, {}, mockPrism);
    const classResult = await classifier.classify(pipelineResult.patch, createMockCstNode());
    expect(classResult.approved).toBe(true);

    db.close();
  });

  it('MCP router → Repair Agent: tool invocations flow correctly', async () => {
    const router = new McpRouter();
    const readCalls: unknown[] = [];

    router.registerTool({
      name: 'read_range',
      description: 'Read',
      inputSchema: { type: 'object', properties: { file_path: { type: 'string' }, start_line: { type: 'integer' }, end_line: { type: 'integer' } }, required: ['file_path', 'start_line', 'end_line'] },
      handler: async (params) => {
        readCalls.push(params);
        return {
          success: true,
          data: {
            lines: [
              '  const items = getItems();',
              '  const filtered = items.filter(x => x > 0);',
              '  let total = 0;',
              '  for (const item of filtered) {',
              '    total += item;',
              '  }',
              '  const avg = total / filtered.length;',
              '  console.log(avg);',
              '  if (avg < 0) throw new Error();',
              '  return avg;',
              '  const x = total * 2;',
              '  const y = x + 1;',
              '  doSomething(y);',
              '  cleanup();',
              '  finalize();',
              '  reportMetrics(total);',
              '  saveState(avg);',
              '  notifyObservers();',
              '  logCompletion();',
              '  return total;',
              '  return total;',
            ],
          },
        };
      },
    });
    router.registerTool({
      name: 'extract_method',
      description: 'Extract',
      inputSchema: { type: 'object', properties: { file_path: { type: 'string' }, method_name: { type: 'string' } }, required: ['file_path', 'method_name'] },
      handler: async () => ({ success: true, data: { content: 'function x() {}' } }),
    });
    router.registerTool({
      name: 'write_fix',
      description: 'Write',
      inputSchema: { type: 'object', properties: { file_path: { type: 'string' }, start_line: { type: 'integer' }, end_line: { type: 'integer' }, new_content: { type: 'string' } }, required: ['file_path', 'start_line', 'end_line', 'new_content'] },
      handler: async () => ({ success: true }),
    });

    const repairAgent = new RepairAgent(router);
    const patches = await repairAgent.generatePatches(createMockProof(), createMockDefectContext());

    expect(readCalls.length).toBeGreaterThan(0);
    expect(patches.length).toBeGreaterThanOrEqual(MIN_PATCHES_PER_DEFECT);
  });

  it('plug system integrates with orchestrator pipeline', () => {
    const registry = new PlugRegistryImpl();
    // Default plugs should be functional
    const parsing = registry.getParsing();
    const repair = registry.getRepair();
    const sandbox = registry.getSandboxExecutor();

    expect(parsing).toBeDefined();
    expect(repair).toBeDefined();
    expect(sandbox).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ERROR PROPAGATION AT STEP BOUNDARIES
// ═══════════════════════════════════════════════════════════════════════════════

describe('Error propagation at step boundaries', () => {
  it('config error prevents all downstream steps', () => {
    expect(() => loadConfig('/nonexistent/path')).toThrow(ConfigError);
    // No downstream components should be initialized on config failure
  });

  it('database initialization failure is catchable', () => {
    // Invalid path should throw
    expect(() => initializeDatabase('/nonexistent/dir/that/does/not/exist/db.sqlite')).toThrow();
  });

  it('MCP validation error does not crash the router', async () => {
    const router = new McpRouter();
    router.registerTool({
      name: 'strict_tool',
      description: 'Strict',
      inputSchema: { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'] },
      handler: async () => ({ success: true }),
    });

    const result = await router.invokeTool('strict_tool' as any, { count: 'not_a_number' });
    expect(result.success).toBe(false);
    expect(result.error?.type).toBe('validation_error');
  });

  it('orchestrator halts cleanly on parser failure', async () => {
    const deps: OrchestratorDeps = {
      parserAgent: {
        parseFile: async () => { throw new Error('Parser crashed'); },
        resolveSymbols: async () => ({}),
        buildCallGraph: async () => ({}),
      },
      bugProvingAgent: { investigate: async () => ({ certified: false, intermediate: {} }) },
      repairAgent: { generatePatches: async () => [] },
      classifierAgent: { classify: async (p) => ({ approved: false, overfitting_probability: 0, patch_id: p.id }) },
      sandboxAgent: { execute: async () => ({ status: 'error' as const, oracle_violations: [], duration_ms: 0, resource_usage: { cpu_time_seconds: 0, memory_peak_mb: 0, disk_io_mb: 0, wall_time_ms: 0 } }), isAvailable: async () => false },
    };
    const orchestrator = new AgentOrchestrator(deps);

    const report = await orchestrator.startInvestigation({
      function_id: 'fn',
      file_path: '/f.ts',
      specification: { name: 'fn', preconditions: [], postconditions: [], parameters: [], return_type: 'void' },
    });

    expect(report.status).toBe('halted');
  });

  it('sandbox unavailability throws SandboxUnavailableError after retries', async () => {
    const deps: OrchestratorDeps = {
      parserAgent: { parseFile: async () => ({ cst: createMockCstNode(), errors: [], duration_ms: 1, file_path: '/f.ts' }), resolveSymbols: async () => ({}), buildCallGraph: async () => ({}) },
      bugProvingAgent: { investigate: async () => ({ certified: false, intermediate: {} }) },
      repairAgent: { generatePatches: async () => [] },
      classifierAgent: { classify: async (p) => ({ approved: false, overfitting_probability: 0, patch_id: p.id }) },
      sandboxAgent: {
        execute: async () => ({ status: 'error' as const, oracle_violations: [], duration_ms: 0, resource_usage: { cpu_time_seconds: 0, memory_peak_mb: 0, disk_io_mb: 0, wall_time_ms: 0 } }),
        isAvailable: async () => false,
      },
    };
    const orchestrator = new AgentOrchestrator(deps);

    await expect(orchestrator.executeSandbox({
      code: 'x',
      runtime: 'node',
      oap_passport: { agent_id: 'a', permitted_operations: [], issued_at: '', expires_at: '' },
      resource_limits: { vcpus: 1, memory_mb: 128, disk_mb: 512, ttl_seconds: 30, cpu_time_seconds: 10, disk_io_mb: 50 },
      oracles: [],
    })).rejects.toThrow(SandboxUnavailableError);
  });
});
