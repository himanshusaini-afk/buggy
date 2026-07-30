/**
 * Property 30: Plug Interface Validation and Routing
 *
 * For any custom plug implementation:
 *   (a) it is accepted if and only if it exports all methods defined in the
 *       plug's interface contract with matching type signatures;
 *   (b) on acceptance for Parsing_Plug, Repair_Plug, or Sandbox_Executor_Plug,
 *       the default implementation is deactivated and operations route through custom;
 *   (c) on validation failure, the specific missing or mistyped methods are reported.
 *
 * **Validates: Requirements 19.2, 19.3, 19.6**
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  PlugRegistryImpl,
  PlugValidationError,
} from '../../src/plugs/plug-registry.js';
import type {
  ParsingPlug,
  RepairPlug,
  SandboxExecutorPlug,
  OraclePlug,
  ExecutionStep,
} from '../../src/types/plugs.js';
import type { CstNode, TreeSitterEdit } from '../../src/types/cst.js';
import type { ExecutionRequest, ExecutionResult } from '../../src/types/sandbox.js';
import type { SandboxConfig } from '../../src/types/config.js';
import type { DefectContext, PatchCandidate, StageFeedback } from '../../src/types/repair.js';

// ─── Interface method specifications ─────────────────────────────────────────

interface MethodSpec {
  name: string;
  paramCount: number;
  type: 'function';
}

interface PropertySpec {
  name: string;
  type: 'string';
}

interface PlugSpec {
  interfaceName: string;
  methods: MethodSpec[];
  properties?: PropertySpec[];
}

const PLUG_SPECS: PlugSpec[] = [
  {
    interfaceName: 'ParsingPlug',
    methods: [
      { name: 'parse', paramCount: 2, type: 'function' },
      { name: 'parseIncremental', paramCount: 3, type: 'function' },
    ],
  },
  {
    interfaceName: 'OraclePlug',
    methods: [
      { name: 'monitor', paramCount: 1, type: 'function' },
      { name: 'onFailure', paramCount: 0, type: 'function' },
    ],
    properties: [{ name: 'name', type: 'string' }],
  },
  {
    interfaceName: 'RepairPlug',
    methods: [
      { name: 'generateCandidates', paramCount: 1, type: 'function' },
      { name: 'refine', paramCount: 2, type: 'function' },
    ],
  },
  {
    interfaceName: 'SandboxExecutorPlug',
    methods: [
      { name: 'execute', paramCount: 1, type: 'function' },
      { name: 'configure', paramCount: 1, type: 'function' },
    ],
  },
];

// ─── Arbitraries ─────────────────────────────────────────────────────────────

/** Pick a random plug spec. */
const arbPlugSpec = fc.constantFrom(...PLUG_SPECS);

/** Type of defect to inject into a plug implementation. */
type DefectType = 'missing' | 'wrong_type' | 'wrong_param_count';
const arbDefectType: fc.Arbitrary<DefectType> = fc.constantFrom('missing', 'wrong_type', 'wrong_param_count');

/**
 * Generate a fully valid plug implementation for a given spec.
 * All methods are async no-op functions with the correct parameter count.
 */
function buildValidPlug(spec: PlugSpec): Record<string, unknown> {
  const plug: Record<string, unknown> = {};
  for (const method of spec.methods) {
    // Create a function with the correct .length by using a helper
    plug[method.name] = createFunctionWithLength(method.paramCount);
  }
  if (spec.properties) {
    for (const prop of spec.properties) {
      if (prop.type === 'string') {
        plug[prop.name] = `test-${prop.name}`;
      }
    }
  }
  return plug;
}

/**
 * Create a function with a specific parameter count (reflected by .length).
 */
function createFunctionWithLength(paramCount: number): Function {
  switch (paramCount) {
    case 0: return async function() { return null; };
    case 1: return async function(_a: unknown) { return null; };
    case 2: return async function(_a: unknown, _b: unknown) { return null; };
    case 3: return async function(_a: unknown, _b: unknown, _c: unknown) { return null; };
    default: return async function(..._args: unknown[]) { return null; };
  }
}

/**
 * Generate a plug with a specific defect injected into one or more members.
 * Returns the plug object and the set of expected reported issues.
 */
function buildDefectivePlug(
  spec: PlugSpec,
  defectType: DefectType,
  targetIndex: number
): { plug: Record<string, unknown>; expectedMissing: string[]; expectedMistyped: string[] } {
  const plug = buildValidPlug(spec);
  const expectedMissing: string[] = [];
  const expectedMistyped: string[] = [];

  // Determine which member to corrupt
  const allMembers = [
    ...spec.methods.map(m => ({ kind: 'method' as const, ...m })),
    ...(spec.properties || []).map(p => ({ kind: 'property' as const, ...p })),
  ];

  const idx = targetIndex % allMembers.length;
  const target = allMembers[idx];

  switch (defectType) {
    case 'missing':
      delete plug[target.name];
      expectedMissing.push(target.name);
      break;

    case 'wrong_type':
      if (target.kind === 'method') {
        // Replace function with a non-function value
        plug[target.name] = 42;
        expectedMistyped.push(target.name);
      } else {
        // Replace string property with a non-string value
        plug[target.name] = 123;
        expectedMistyped.push(target.name);
      }
      break;

    case 'wrong_param_count':
      if (target.kind === 'method') {
        // Create function with wrong param count
        const wrongCount = target.paramCount === 0 ? 1 : target.paramCount - 1;
        plug[target.name] = createFunctionWithLength(wrongCount);
        expectedMistyped.push(target.name);
      } else {
        // For properties, wrong_param_count is not applicable; use wrong_type instead
        plug[target.name] = 123;
        expectedMistyped.push(target.name);
      }
      break;
  }

  return { plug, expectedMissing, expectedMistyped };
}

/**
 * Generate a subset of methods to omit (for partial implementations).
 */
const arbSubsetIndices = (maxLen: number) =>
  fc.uniqueArray(fc.nat({ max: maxLen - 1 }), { minLength: 1, maxLength: maxLen });

// ─── Property Tests ──────────────────────────────────────────────────────────

describe('Property 30: Plug Interface Validation and Routing', () => {
  describe('(a) accepted iff all interface methods present with correct signatures', () => {
    it('valid implementations pass validation for all plug types', () => {
      fc.assert(
        fc.property(
          arbPlugSpec,
          (spec) => {
            const registry = new PlugRegistryImpl();
            const plug = buildValidPlug(spec);
            const result = registry.validate(plug, spec.interfaceName);

            // Must be accepted
            expect(result.valid).toBe(true);
            expect(result.missing_methods || []).toHaveLength(0);
            expect(result.type_mismatches || []).toHaveLength(0);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('invalid implementations fail validation for all plug types', () => {
      fc.assert(
        fc.property(
          arbPlugSpec,
          arbDefectType,
          fc.nat({ max: 100 }),
          (spec, defectType, targetSeed) => {
            const registry = new PlugRegistryImpl();
            const { plug, expectedMissing, expectedMistyped } = buildDefectivePlug(
              spec,
              defectType,
              targetSeed
            );
            const result = registry.validate(plug, spec.interfaceName);

            // Must be rejected
            expect(result.valid).toBe(false);

            // Reported issues must cover the defect we injected
            const allReported = [
              ...(result.missing_methods || []),
              ...(result.type_mismatches || []),
            ];
            expect(allReported.length).toBeGreaterThan(0);

            // The specific defect member must appear in the report
            for (const missing of expectedMissing) {
              expect(result.missing_methods).toContain(missing);
            }
            for (const mistyped of expectedMistyped) {
              const found = (result.type_mismatches || []).some(
                (msg: string) => msg.includes(mistyped)
              );
              expect(found).toBe(true);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('partially implemented plugs are rejected with all missing members reported', () => {
      fc.assert(
        fc.property(
          arbPlugSpec,
          fc.nat({ max: 100 }),
          (spec, seed) => {
            const registry = new PlugRegistryImpl();
            const allMembers = [
              ...spec.methods.map(m => m.name),
              ...(spec.properties || []).map(p => p.name),
            ];

            // Remove a random subset of members
            const plug = buildValidPlug(spec);
            const removeCount = (seed % (allMembers.length - 1)) + 1; // remove at least 1
            const toRemove = allMembers.slice(0, removeCount);
            for (const name of toRemove) {
              delete plug[name];
            }

            const result = registry.validate(plug, spec.interfaceName);

            // Must be rejected
            expect(result.valid).toBe(false);

            // All removed members must be reported as missing
            for (const name of toRemove) {
              expect(result.missing_methods).toContain(name);
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe('(b) Parsing/Repair/SandboxExecutor acceptance → default deactivated, routes through custom', () => {
    it('ParsingPlug acceptance deactivates default and routes through custom', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.string({ minLength: 1, maxLength: 50 }),
          fc.string({ minLength: 1, maxLength: 20 }),
          async (source, filePath) => {
            const registry = new PlugRegistryImpl();

            // Create a custom parsing plug that marks output distinctively
            const customMarker = `custom-${filePath}`;
            const customParsing: ParsingPlug = {
              parse: async (_source: string, _filePath: string): Promise<CstNode> => ({
                id: customMarker,
                type: 'custom_program',
                start_byte: 0,
                end_byte: _source.length,
                start_position: { row: 0, column: 0 },
                end_position: { row: 0, column: 0 },
                children: [],
                is_error: false,
              }),
              parseIncremental: async (_source: string, _edit: TreeSitterEdit, _prev: CstNode): Promise<CstNode> => ({
                id: customMarker,
                type: 'custom_program',
                start_byte: 0,
                end_byte: _source.length,
                start_position: { row: 0, column: 0 },
                end_position: { row: 0, column: 0 },
                children: [],
                is_error: false,
              }),
            };

            registry.registerParsing(customParsing);
            const parsing = registry.getParsing();
            const result = await parsing.parse(source, filePath);

            // Operations should route through custom (not default)
            expect(result.id).toBe(customMarker);
            expect(result.type).toBe('custom_program');
          }
        ),
        { numRuns: 100 }
      );
    });

    it('RepairPlug acceptance deactivates default and routes through custom', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.string({ minLength: 1, maxLength: 20 }),
          async (patchId) => {
            const registry = new PlugRegistryImpl();

            const customRepair: RepairPlug = {
              generateCandidates: async (_ctx: DefectContext): Promise<PatchCandidate[]> => [{
                id: patchId,
                diff: '+ custom',
                edit_operations: [],
                target_file: 'test.ts',
                target_range: { start_line: 1, end_line: 5 },
                refinement_attempt: 0,
              }],
              refine: async (patch: PatchCandidate, _fb: StageFeedback): Promise<PatchCandidate> => patch,
            };

            registry.registerRepair(customRepair);
            const repair = registry.getRepair();
            const result = await repair.generateCandidates({} as DefectContext);

            // Should route through custom (default returns [])
            expect(result.length).toBe(1);
            expect(result[0].id).toBe(patchId);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('SandboxExecutorPlug acceptance deactivates default and routes through custom', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.nat({ max: 10000 }),
          async (duration) => {
            const registry = new PlugRegistryImpl();

            const customSandbox: SandboxExecutorPlug = {
              execute: async (_req: ExecutionRequest): Promise<ExecutionResult> => ({
                status: 'success',
                oracle_violations: [],
                duration_ms: duration,
                resource_usage: {
                  cpu_time_seconds: 0,
                  memory_peak_mb: 0,
                  disk_io_mb: 0,
                  wall_time_ms: duration,
                },
              }),
              configure: async (_cfg: SandboxConfig): Promise<void> => {},
            };

            registry.registerSandboxExecutor(customSandbox);
            const sandbox = registry.getSandboxExecutor();
            const result = await sandbox.execute({} as ExecutionRequest);

            // Should route through custom (default returns 'error' status)
            expect(result.status).toBe('success');
            expect(result.duration_ms).toBe(duration);
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe('(c) failure → specific missing/mistyped methods reported', () => {
    it('registration failure reports exact missing methods in error', () => {
      fc.assert(
        fc.property(
          arbPlugSpec,
          fc.nat({ max: 100 }),
          (spec, seed) => {
            // Only test non-Oracle plugs for registration (Oracle uses registerOracle)
            const registry = new PlugRegistryImpl();
            const allMembers = [
              ...spec.methods.map(m => m.name),
              ...(spec.properties || []).map(p => p.name),
            ];

            // Build a plug missing one or more members
            const plug = buildValidPlug(spec);
            const removeIdx = seed % allMembers.length;
            const removedName = allMembers[removeIdx];
            delete plug[removedName];

            // Attempt registration should throw with details
            let caughtError: PlugValidationError | null = null;
            try {
              switch (spec.interfaceName) {
                case 'ParsingPlug':
                  registry.registerParsing(plug as unknown as ParsingPlug);
                  break;
                case 'OraclePlug':
                  registry.registerOracle(plug as unknown as OraclePlug);
                  break;
                case 'RepairPlug':
                  registry.registerRepair(plug as unknown as RepairPlug);
                  break;
                case 'SandboxExecutorPlug':
                  registry.registerSandboxExecutor(plug as unknown as SandboxExecutorPlug);
                  break;
              }
            } catch (err) {
              if (err instanceof PlugValidationError) {
                caughtError = err;
              }
            }

            // Must have thrown
            expect(caughtError).not.toBeNull();
            expect(caughtError!.interfaceName).toBe(spec.interfaceName);

            // The removed member must be reported
            const result = caughtError!.validationResult;
            expect(result.valid).toBe(false);
            expect(result.missing_methods).toContain(removedName);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('registration failure reports exact type mismatches in error', () => {
      fc.assert(
        fc.property(
          arbPlugSpec,
          fc.nat({ max: 100 }),
          (spec, seed) => {
            const registry = new PlugRegistryImpl();

            // Build a plug with a type mismatch on a method
            const plug = buildValidPlug(spec);
            const methodIdx = seed % spec.methods.length;
            const corruptedMethod = spec.methods[methodIdx].name;
            plug[corruptedMethod] = 'not-a-function'; // wrong type

            // Attempt registration should throw with type mismatch details
            let caughtError: PlugValidationError | null = null;
            try {
              switch (spec.interfaceName) {
                case 'ParsingPlug':
                  registry.registerParsing(plug as unknown as ParsingPlug);
                  break;
                case 'OraclePlug':
                  registry.registerOracle(plug as unknown as OraclePlug);
                  break;
                case 'RepairPlug':
                  registry.registerRepair(plug as unknown as RepairPlug);
                  break;
                case 'SandboxExecutorPlug':
                  registry.registerSandboxExecutor(plug as unknown as SandboxExecutorPlug);
                  break;
              }
            } catch (err) {
              if (err instanceof PlugValidationError) {
                caughtError = err;
              }
            }

            // Must have thrown
            expect(caughtError).not.toBeNull();
            expect(caughtError!.interfaceName).toBe(spec.interfaceName);

            // The corrupted method must be reported as a type mismatch
            const result = caughtError!.validationResult;
            expect(result.valid).toBe(false);
            const hasMismatch = (result.type_mismatches || []).some(
              (msg: string) => msg.includes(corruptedMethod)
            );
            expect(hasMismatch).toBe(true);
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
