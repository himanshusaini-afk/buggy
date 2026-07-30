/**
 * Plug Registry - Manages extensible plug points with interface validation and fallback.
 *
 * Supports 4 plug types: Parsing, Oracle, Repair, SandboxExecutor.
 * Validates custom implementations against interface contracts.
 * Falls back to default implementations on plug exceptions within 500ms.
 *
 * Requirements: 19.1, 19.2, 19.3, 19.4, 19.5, 19.6
 */

import type {
  ParsingPlug,
  OraclePlug,
  RepairPlug,
  SandboxExecutorPlug,
  ValidationResult,
  ExecutionStep,
} from '../types/plugs.js';
import type { CstNode, TreeSitterEdit } from '../types/cst.js';
import type { OracleViolation, ExecutionRequest, ExecutionResult } from '../types/sandbox.js';
import type { SandboxConfig } from '../types/config.js';
import type { DefectContext, PatchCandidate, StageFeedback } from '../types/repair.js';

// ─── Interface method definitions for validation ─────────────────────────────

interface MethodSpec {
  name: string;
  paramCount: number;
}

const PARSING_PLUG_METHODS: MethodSpec[] = [
  { name: 'parse', paramCount: 2 },
  { name: 'parseIncremental', paramCount: 3 },
];

const ORACLE_PLUG_METHODS: MethodSpec[] = [
  { name: 'monitor', paramCount: 1 },
  { name: 'onFailure', paramCount: 0 },
];

const REPAIR_PLUG_METHODS: MethodSpec[] = [
  { name: 'generateCandidates', paramCount: 1 },
  { name: 'refine', paramCount: 2 },
];

const SANDBOX_EXECUTOR_PLUG_METHODS: MethodSpec[] = [
  { name: 'execute', paramCount: 1 },
  { name: 'configure', paramCount: 1 },
];

const INTERFACE_METHODS: Record<string, MethodSpec[]> = {
  ParsingPlug: PARSING_PLUG_METHODS,
  OraclePlug: ORACLE_PLUG_METHODS,
  RepairPlug: REPAIR_PLUG_METHODS,
  SandboxExecutorPlug: SANDBOX_EXECUTOR_PLUG_METHODS,
};

// Oracle plug also requires a 'name' string property
const ORACLE_PLUG_PROPERTIES: { name: string; type: string }[] = [
  { name: 'name', type: 'string' },
];

// ─── Default implementations ─────────────────────────────────────────────────

export class DefaultParsingPlug implements ParsingPlug {
  async parse(source: string, filePath: string): Promise<CstNode> {
    // Default no-op parsing: returns a root node wrapping the source text
    return {
      id: `root-${filePath}`,
      type: 'program',
      start_byte: 0,
      end_byte: source.length,
      start_position: { row: 0, column: 0 },
      end_position: { row: source.split('\n').length - 1, column: 0 },
      children: [],
      is_error: false,
      text: source,
    };
  }

  async parseIncremental(source: string, _edit: TreeSitterEdit, _previousTree: CstNode): Promise<CstNode> {
    // Default: fall back to full parse
    return this.parse(source, 'incremental');
  }
}

export class DefaultOraclePlug implements OraclePlug {
  name = 'default-oracle';

  async monitor(_executionStep: ExecutionStep): Promise<OracleViolation | null> {
    // Default oracle does not detect any violations
    return null;
  }

  onFailure(): void {
    // No-op
  }
}

export class DefaultRepairPlug implements RepairPlug {
  async generateCandidates(_context: DefectContext): Promise<PatchCandidate[]> {
    // Default: no candidates generated
    return [];
  }

  async refine(patch: PatchCandidate, _feedback: StageFeedback): Promise<PatchCandidate> {
    // Default: return patch unchanged
    return patch;
  }
}

export class DefaultSandboxExecutorPlug implements SandboxExecutorPlug {
  async execute(_request: ExecutionRequest): Promise<ExecutionResult> {
    // Default: return an error result indicating no sandbox configured
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
  }

  async configure(_config: SandboxConfig): Promise<void> {
    // No-op
  }
}

// ─── Maximum oracle registrations ────────────────────────────────────────────

const MAX_ORACLE_REGISTRATIONS = 8;

// ─── Fallback timeout ────────────────────────────────────────────────────────

const FALLBACK_TIMEOUT_MS = 500;

// ─── Plug Registry Implementation ───────────────────────────────────────────

export interface PlugRegistryLog {
  level: 'info' | 'warn' | 'error';
  message: string;
  plugName?: string;
  error?: unknown;
  timestamp: string;
}

export class PlugRegistryImpl {
  private parsingPlug: ParsingPlug;
  private oraclePlugs: OraclePlug[];
  private repairPlug: RepairPlug;
  private sandboxExecutorPlug: SandboxExecutorPlug;

  private readonly defaultParsing: ParsingPlug;
  private readonly defaultOracle: OraclePlug;
  private readonly defaultRepair: RepairPlug;
  private readonly defaultSandboxExecutor: SandboxExecutorPlug;

  private customParsingRegistered = false;
  private customRepairRegistered = false;
  private customSandboxExecutorRegistered = false;

  private logs: PlugRegistryLog[] = [];

  constructor() {
    this.defaultParsing = new DefaultParsingPlug();
    this.defaultOracle = new DefaultOraclePlug();
    this.defaultRepair = new DefaultRepairPlug();
    this.defaultSandboxExecutor = new DefaultSandboxExecutorPlug();

    // Start with defaults active (Requirement 19.1)
    this.parsingPlug = this.defaultParsing;
    this.oraclePlugs = [this.defaultOracle];
    this.repairPlug = this.defaultRepair;
    this.sandboxExecutorPlug = this.defaultSandboxExecutor;
  }

  // ─── Registration Methods ──────────────────────────────────────────────────

  /**
   * Register a custom parsing plug. Deactivates the default. (Req 19.6)
   */
  registerParsing(plug: ParsingPlug): void {
    const validation = this.validate(plug, 'ParsingPlug');
    if (!validation.valid) {
      throw new PlugValidationError('ParsingPlug', validation);
    }
    this.parsingPlug = plug;
    this.customParsingRegistered = true;
    this.log('info', `Custom ParsingPlug registered, default deactivated`);
  }

  /**
   * Register a custom oracle plug. Up to 8 can be active simultaneously. (Req 19.4)
   */
  registerOracle(plug: OraclePlug): void {
    const validation = this.validate(plug, 'OraclePlug');
    if (!validation.valid) {
      throw new PlugValidationError('OraclePlug', validation);
    }

    // Remove the default oracle on first custom registration
    if (this.oraclePlugs.length === 1 && this.oraclePlugs[0] === this.defaultOracle) {
      this.oraclePlugs = [];
    }

    if (this.oraclePlugs.length >= MAX_ORACLE_REGISTRATIONS) {
      throw new PlugRegistrationError(
        `Cannot register more than ${MAX_ORACLE_REGISTRATIONS} Oracle_Plug implementations`
      );
    }

    this.oraclePlugs.push(plug);
    this.log('info', `Custom OraclePlug '${plug.name}' registered (${this.oraclePlugs.length}/${MAX_ORACLE_REGISTRATIONS})`);
  }

  /**
   * Register a custom repair plug. Deactivates the default. (Req 19.6)
   */
  registerRepair(plug: RepairPlug): void {
    const validation = this.validate(plug, 'RepairPlug');
    if (!validation.valid) {
      throw new PlugValidationError('RepairPlug', validation);
    }
    this.repairPlug = plug;
    this.customRepairRegistered = true;
    this.log('info', `Custom RepairPlug registered, default deactivated`);
  }

  /**
   * Register a custom sandbox executor plug. Deactivates the default. (Req 19.6)
   */
  registerSandboxExecutor(plug: SandboxExecutorPlug): void {
    const validation = this.validate(plug, 'SandboxExecutorPlug');
    if (!validation.valid) {
      throw new PlugValidationError('SandboxExecutorPlug', validation);
    }
    this.sandboxExecutorPlug = plug;
    this.customSandboxExecutorRegistered = true;
    this.log('info', `Custom SandboxExecutorPlug registered, default deactivated`);
  }

  // ─── Validation (Req 19.2, 19.3) ──────────────────────────────────────────

  /**
   * Validates that a plug implementation exports all required interface methods
   * with matching type signatures (function type and parameter count).
   */
  validate(plug: unknown, interfaceName: string): ValidationResult {
    const methods = INTERFACE_METHODS[interfaceName];
    if (!methods) {
      return { valid: false, missing_methods: [], type_mismatches: [`Unknown interface: ${interfaceName}`] };
    }

    if (plug === null || plug === undefined || typeof plug !== 'object') {
      return { valid: false, missing_methods: methods.map(m => m.name), type_mismatches: [] };
    }

    const missing_methods: string[] = [];
    const type_mismatches: string[] = [];

    for (const method of methods) {
      const value = (plug as Record<string, unknown>)[method.name];
      if (value === undefined) {
        missing_methods.push(method.name);
      } else if (typeof value !== 'function') {
        type_mismatches.push(`${method.name}: expected function, got ${typeof value}`);
      } else if ((value as Function).length !== method.paramCount) {
        type_mismatches.push(
          `${method.name}: expected ${method.paramCount} parameter(s), got ${(value as Function).length}`
        );
      }
    }

    // Check additional properties for OraclePlug
    if (interfaceName === 'OraclePlug') {
      for (const prop of ORACLE_PLUG_PROPERTIES) {
        const value = (plug as Record<string, unknown>)[prop.name];
        if (value === undefined) {
          missing_methods.push(prop.name);
        } else if (typeof value !== prop.type) {
          type_mismatches.push(`${prop.name}: expected ${prop.type}, got ${typeof value}`);
        }
      }
    }

    const valid = missing_methods.length === 0 && type_mismatches.length === 0;
    return { valid, missing_methods, type_mismatches };
  }

  // ─── Execution with Fallback (Req 19.5) ───────────────────────────────────

  /**
   * Get the active parsing plug, wrapped with exception fallback.
   */
  getParsing(): ParsingPlug {
    if (!this.customParsingRegistered) {
      return this.defaultParsing;
    }
    return this.wrapWithFallback(this.parsingPlug, this.defaultParsing, 'ParsingPlug');
  }

  /**
   * Get active oracle plugs. Each is wrapped with exception handling.
   */
  getOracles(): OraclePlug[] {
    return this.oraclePlugs.map((oracle) =>
      this.wrapOracleWithFallback(oracle)
    );
  }

  /**
   * Get the active repair plug, wrapped with exception fallback.
   */
  getRepair(): RepairPlug {
    if (!this.customRepairRegistered) {
      return this.defaultRepair;
    }
    return this.wrapWithFallback(this.repairPlug, this.defaultRepair, 'RepairPlug');
  }

  /**
   * Get the active sandbox executor plug, wrapped with exception fallback.
   */
  getSandboxExecutor(): SandboxExecutorPlug {
    if (!this.customSandboxExecutorRegistered) {
      return this.defaultSandboxExecutor;
    }
    return this.wrapWithFallback(this.sandboxExecutorPlug, this.defaultSandboxExecutor, 'SandboxExecutorPlug');
  }

  /**
   * Get logs for inspection/testing.
   */
  getLogs(): PlugRegistryLog[] {
    return [...this.logs];
  }

  /**
   * Clear logs.
   */
  clearLogs(): void {
    this.logs = [];
  }

  // ─── Internal Helpers ──────────────────────────────────────────────────────

  private wrapWithFallback<T extends object>(
    customPlug: T,
    defaultPlug: T,
    plugName: string
  ): T {
    const self = this;
    return new Proxy(customPlug, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== 'function') {
          return value;
        }
        return async (...args: unknown[]) => {
          try {
            const result = await Promise.race([
              (value as Function).apply(target, args),
              new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Plug execution timeout')), FALLBACK_TIMEOUT_MS)
              ),
            ]);
            return result;
          } catch (error) {
            self.log('error', `${plugName} threw exception, falling back to default`, plugName, error);
            const fallbackMethod = (defaultPlug as Record<string, unknown>)[prop as string];
            if (typeof fallbackMethod === 'function') {
              return fallbackMethod.apply(defaultPlug, args);
            }
            throw error;
          }
        };
      },
    }) as T;
  }

  private wrapOracleWithFallback(oracle: OraclePlug): OraclePlug {
    const self = this;
    const oracleName = oracle.name;

    return {
      name: oracleName,
      async monitor(executionStep: ExecutionStep): Promise<OracleViolation | null> {
        try {
          const result = await Promise.race([
            oracle.monitor(executionStep),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error('Oracle execution timeout')), FALLBACK_TIMEOUT_MS)
            ),
          ]);
          return result;
        } catch (error) {
          self.log('error', `OraclePlug '${oracleName}' threw exception, terminating invocation`, oracleName, error);
          // For oracles, fallback to default behavior (no violation detected)
          return self.defaultOracle.monitor(executionStep);
        }
      },
      onFailure(): void {
        try {
          oracle.onFailure();
        } catch (error) {
          self.log('error', `OraclePlug '${oracleName}' onFailure threw exception`, oracleName, error);
        }
      },
    };
  }

  private log(level: PlugRegistryLog['level'], message: string, plugName?: string, error?: unknown): void {
    this.logs.push({
      level,
      message,
      plugName,
      error,
      timestamp: new Date().toISOString(),
    });
  }
}

// ─── Error Classes ───────────────────────────────────────────────────────────

export class PlugValidationError extends Error {
  public readonly interfaceName: string;
  public readonly validationResult: ValidationResult;

  constructor(interfaceName: string, result: ValidationResult) {
    const parts: string[] = [];
    if (result.missing_methods && result.missing_methods.length > 0) {
      parts.push(`missing methods: ${result.missing_methods.join(', ')}`);
    }
    if (result.type_mismatches && result.type_mismatches.length > 0) {
      parts.push(`type mismatches: ${result.type_mismatches.join('; ')}`);
    }
    super(`Plug validation failed for ${interfaceName}: ${parts.join('; ')}`);
    this.name = 'PlugValidationError';
    this.interfaceName = interfaceName;
    this.validationResult = result;
  }
}

export class PlugRegistrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlugRegistrationError';
  }
}
