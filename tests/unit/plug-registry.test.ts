/**
 * Unit tests for the PlugRegistry implementation.
 * Requirements: 19.1, 19.2, 19.3, 19.4, 19.5, 19.6
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  PlugRegistryImpl,
  DefaultParsingPlug,
  DefaultOraclePlug,
  DefaultRepairPlug,
  DefaultSandboxExecutorPlug,
  PlugValidationError,
  PlugRegistrationError,
} from '../../src/plugs/plug-registry.js';
import type {
  ParsingPlug,
  OraclePlug,
  RepairPlug,
  SandboxExecutorPlug,
  ExecutionStep,
} from '../../src/types/plugs.js';
import type { CstNode, TreeSitterEdit } from '../../src/types/cst.js';
import type { OracleViolation, ExecutionRequest, ExecutionResult } from '../../src/types/sandbox.js';
import type { SandboxConfig } from '../../src/types/config.js';
import type { DefectContext, PatchCandidate, StageFeedback } from '../../src/types/repair.js';

describe('PlugRegistry', () => {
  let registry: PlugRegistryImpl;

  beforeEach(() => {
    registry = new PlugRegistryImpl();
  });

  // ─── Default implementations (Req 19.1) ─────────────────────────────────

  describe('default implementations', () => {
    it('should have default parsing plug active', () => {
      const parsing = registry.getParsing();
      expect(parsing).toBeDefined();
    });

    it('should have default oracle plug active', () => {
      const oracles = registry.getOracles();
      expect(oracles).toHaveLength(1);
      expect(oracles[0].name).toBe('default-oracle');
    });

    it('should have default repair plug active', () => {
      const repair = registry.getRepair();
      expect(repair).toBeDefined();
    });

    it('should have default sandbox executor plug active', () => {
      const sandbox = registry.getSandboxExecutor();
      expect(sandbox).toBeDefined();
    });

    it('default parsing plug should return a valid CstNode', async () => {
      const parsing = new DefaultParsingPlug();
      const result = await parsing.parse('const x = 1;', 'test.ts');
      expect(result.type).toBe('program');
      expect(result.text).toBe('const x = 1;');
    });

    it('default oracle plug should return null (no violations)', async () => {
      const oracle = new DefaultOraclePlug();
      const step: ExecutionStep = {
        statement_index: 0,
        source_location: { line: 1, column: 0 },
        variables: {},
        call_stack_depth: 0,
      };
      const result = await oracle.monitor(step);
      expect(result).toBeNull();
    });

    it('default repair plug should return empty candidates', async () => {
      const repair = new DefaultRepairPlug();
      const result = await repair.generateCandidates({} as DefectContext);
      expect(result).toEqual([]);
    });

    it('default sandbox executor plug should return error status', async () => {
      const sandbox = new DefaultSandboxExecutorPlug();
      const result = await sandbox.execute({} as ExecutionRequest);
      expect(result.status).toBe('error');
    });
  });

  // ─── Interface validation (Req 19.2, 19.3) ──────────────────────────────

  describe('validate', () => {
    it('should validate a correct ParsingPlug implementation', () => {
      const plug: ParsingPlug = {
        parse: async (_source: string, _filePath: string) => ({} as CstNode),
        parseIncremental: async (_source: string, _edit: TreeSitterEdit, _prev: CstNode) => ({} as CstNode),
      };
      const result = registry.validate(plug, 'ParsingPlug');
      expect(result.valid).toBe(true);
    });

    it('should reject a ParsingPlug missing methods', () => {
      const plug = { parse: async () => ({} as CstNode) };
      const result = registry.validate(plug, 'ParsingPlug');
      expect(result.valid).toBe(false);
      expect(result.missing_methods).toContain('parseIncremental');
    });

    it('should reject a ParsingPlug with wrong types', () => {
      const plug = { parse: 'not a function', parseIncremental: async (_a: string, _b: TreeSitterEdit, _c: CstNode) => ({} as CstNode) };
      const result = registry.validate(plug, 'ParsingPlug');
      expect(result.valid).toBe(false);
      expect(result.type_mismatches).toContainEqual(expect.stringContaining('parse: expected function'));
    });

    it('should reject a ParsingPlug with wrong parameter count', () => {
      const plug = {
        parse: async (_source: string) => ({} as CstNode), // only 1 param, needs 2
        parseIncremental: async (_source: string, _edit: TreeSitterEdit, _prev: CstNode) => ({} as CstNode),
      };
      const result = registry.validate(plug, 'ParsingPlug');
      expect(result.valid).toBe(false);
      expect(result.type_mismatches).toContainEqual(expect.stringContaining('parse: expected 2 parameter(s), got 1'));
    });

    it('should validate a correct OraclePlug with name property', () => {
      const plug: OraclePlug = {
        name: 'test-oracle',
        monitor: async (_step: ExecutionStep) => null,
        onFailure: () => {},
      };
      const result = registry.validate(plug, 'OraclePlug');
      expect(result.valid).toBe(true);
    });

    it('should reject an OraclePlug missing name property', () => {
      const plug = {
        monitor: async (_step: ExecutionStep) => null,
        onFailure: () => {},
      };
      const result = registry.validate(plug, 'OraclePlug');
      expect(result.valid).toBe(false);
      expect(result.missing_methods).toContain('name');
    });

    it('should reject an OraclePlug with non-string name', () => {
      const plug = {
        name: 123,
        monitor: async (_step: ExecutionStep) => null,
        onFailure: () => {},
      };
      const result = registry.validate(plug, 'OraclePlug');
      expect(result.valid).toBe(false);
      expect(result.type_mismatches).toContainEqual(expect.stringContaining('name: expected string'));
    });

    it('should validate a correct RepairPlug implementation', () => {
      const plug: RepairPlug = {
        generateCandidates: async (_ctx: DefectContext) => [],
        refine: async (patch: PatchCandidate, _fb: StageFeedback) => patch,
      };
      const result = registry.validate(plug, 'RepairPlug');
      expect(result.valid).toBe(true);
    });

    it('should validate a correct SandboxExecutorPlug implementation', () => {
      const plug: SandboxExecutorPlug = {
        execute: async (_req: ExecutionRequest) => ({} as ExecutionResult),
        configure: async (_cfg: SandboxConfig) => {},
      };
      const result = registry.validate(plug, 'SandboxExecutorPlug');
      expect(result.valid).toBe(true);
    });

    it('should reject null plug', () => {
      const result = registry.validate(null, 'ParsingPlug');
      expect(result.valid).toBe(false);
      expect(result.missing_methods).toHaveLength(2); // parse, parseIncremental
    });

    it('should reject undefined plug', () => {
      const result = registry.validate(undefined, 'ParsingPlug');
      expect(result.valid).toBe(false);
    });

    it('should report unknown interface', () => {
      const result = registry.validate({}, 'UnknownPlug');
      expect(result.valid).toBe(false);
      expect(result.type_mismatches).toContainEqual(expect.stringContaining('Unknown interface'));
    });
  });

  // ─── Registration (Req 19.2, 19.3, 19.6) ────────────────────────────────

  describe('registration', () => {
    it('should register a valid custom ParsingPlug and deactivate default', () => {
      const customParsing: ParsingPlug = {
        parse: async (_source: string, _filePath: string) => ({
          id: 'custom', type: 'program', start_byte: 0, end_byte: 0,
          start_position: { row: 0, column: 0 }, end_position: { row: 0, column: 0 },
          children: [], is_error: false,
        }),
        parseIncremental: async (_source: string, _edit: TreeSitterEdit, _prev: CstNode) => ({
          id: 'custom', type: 'program', start_byte: 0, end_byte: 0,
          start_position: { row: 0, column: 0 }, end_position: { row: 0, column: 0 },
          children: [], is_error: false,
        }),
      };

      registry.registerParsing(customParsing);
      // Should not throw; logs should show registration
      const logs = registry.getLogs();
      expect(logs.some(l => l.message.includes('Custom ParsingPlug registered'))).toBe(true);
    });

    it('should throw PlugValidationError for invalid ParsingPlug', () => {
      const invalidPlug = { parse: 'not-a-function' };
      expect(() => registry.registerParsing(invalidPlug as any)).toThrow(PlugValidationError);
    });

    it('should register a valid custom RepairPlug and deactivate default', () => {
      const customRepair: RepairPlug = {
        generateCandidates: async (_ctx: DefectContext) => [],
        refine: async (patch: PatchCandidate, _fb: StageFeedback) => patch,
      };
      registry.registerRepair(customRepair);
      const logs = registry.getLogs();
      expect(logs.some(l => l.message.includes('Custom RepairPlug registered'))).toBe(true);
    });

    it('should register a valid custom SandboxExecutorPlug and deactivate default', () => {
      const customSandbox: SandboxExecutorPlug = {
        execute: async (_req: ExecutionRequest) => ({} as ExecutionResult),
        configure: async (_cfg: SandboxConfig) => {},
      };
      registry.registerSandboxExecutor(customSandbox);
      const logs = registry.getLogs();
      expect(logs.some(l => l.message.includes('Custom SandboxExecutorPlug registered'))).toBe(true);
    });

    it('should throw PlugValidationError with details on registration failure', () => {
      try {
        registry.registerRepair({} as any);
      } catch (err) {
        expect(err).toBeInstanceOf(PlugValidationError);
        const pve = err as PlugValidationError;
        expect(pve.interfaceName).toBe('RepairPlug');
        expect(pve.validationResult.missing_methods).toContain('generateCandidates');
        expect(pve.validationResult.missing_methods).toContain('refine');
      }
    });
  });

  // ─── Oracle registration limit (Req 19.4) ───────────────────────────────

  describe('oracle registration limit', () => {
    function createOracle(name: string): OraclePlug {
      return {
        name,
        monitor: async (_step: ExecutionStep) => null,
        onFailure: () => {},
      };
    }

    it('should allow up to 8 oracle registrations', () => {
      for (let i = 0; i < 8; i++) {
        registry.registerOracle(createOracle(`oracle-${i}`));
      }
      const oracles = registry.getOracles();
      expect(oracles).toHaveLength(8);
    });

    it('should reject 9th oracle registration', () => {
      for (let i = 0; i < 8; i++) {
        registry.registerOracle(createOracle(`oracle-${i}`));
      }
      expect(() => registry.registerOracle(createOracle('oracle-9'))).toThrow(PlugRegistrationError);
    });

    it('should remove default oracle when first custom oracle is registered', () => {
      registry.registerOracle(createOracle('custom-oracle'));
      const oracles = registry.getOracles();
      expect(oracles).toHaveLength(1);
      expect(oracles[0].name).toBe('custom-oracle');
    });

    it('should execute all registered oracles on each monitored event', async () => {
      const calls: string[] = [];
      for (let i = 0; i < 3; i++) {
        const oracle: OraclePlug = {
          name: `oracle-${i}`,
          monitor: async (_step: ExecutionStep) => {
            calls.push(`oracle-${i}`);
            return null;
          },
          onFailure: () => {},
        };
        registry.registerOracle(oracle);
      }

      const oracles = registry.getOracles();
      const step: ExecutionStep = {
        statement_index: 0,
        source_location: { line: 1, column: 0 },
        variables: {},
        call_stack_depth: 0,
      };

      for (const oracle of oracles) {
        await oracle.monitor(step);
      }
      expect(calls).toEqual(['oracle-0', 'oracle-1', 'oracle-2']);
    });
  });

  // ─── Fallback on exception (Req 19.5) ───────────────────────────────────

  describe('exception fallback', () => {
    it('should fallback to default parsing when custom plug throws', async () => {
      const throwingPlug: ParsingPlug = {
        parse: async (_source: string, _filePath: string) => {
          throw new Error('Custom parse failed');
        },
        parseIncremental: async (_source: string, _edit: TreeSitterEdit, _prev: CstNode) => {
          throw new Error('Custom incremental failed');
        },
      };

      registry.registerParsing(throwingPlug);
      const parsing = registry.getParsing();
      const result = await parsing.parse('const x = 1;', 'test.ts');
      // Should fallback to default which returns a program node
      expect(result.type).toBe('program');

      // Should have logged the error
      const logs = registry.getLogs();
      expect(logs.some(l => l.level === 'error' && l.message.includes('ParsingPlug threw exception'))).toBe(true);
    });

    it('should fallback to default repair when custom plug throws', async () => {
      const throwingPlug: RepairPlug = {
        generateCandidates: async (_ctx: DefectContext) => {
          throw new Error('Repair failed');
        },
        refine: async (_patch: PatchCandidate, _fb: StageFeedback) => {
          throw new Error('Refine failed');
        },
      };

      registry.registerRepair(throwingPlug);
      const repair = registry.getRepair();
      const result = await repair.generateCandidates({} as DefectContext);
      expect(result).toEqual([]); // default returns empty array
    });

    it('should fallback to default sandbox when custom plug throws', async () => {
      const throwingPlug: SandboxExecutorPlug = {
        execute: async (_req: ExecutionRequest) => {
          throw new Error('Sandbox failed');
        },
        configure: async (_cfg: SandboxConfig) => {
          throw new Error('Configure failed');
        },
      };

      registry.registerSandboxExecutor(throwingPlug);
      const sandbox = registry.getSandboxExecutor();
      const result = await sandbox.execute({} as ExecutionRequest);
      expect(result.status).toBe('error'); // default returns error status
    });

    it('should fallback oracle to default (null) when custom oracle throws', async () => {
      const throwingOracle: OraclePlug = {
        name: 'throwing-oracle',
        monitor: async (_step: ExecutionStep) => {
          throw new Error('Oracle monitoring failed');
        },
        onFailure: () => {},
      };

      registry.registerOracle(throwingOracle);
      const oracles = registry.getOracles();
      const step: ExecutionStep = {
        statement_index: 0,
        source_location: { line: 1, column: 0 },
        variables: {},
        call_stack_depth: 0,
      };

      const result = await oracles[0].monitor(step);
      expect(result).toBeNull(); // fallback to default oracle returns null

      const logs = registry.getLogs();
      expect(logs.some(l => l.level === 'error' && l.message.includes("OraclePlug 'throwing-oracle'"))).toBe(true);
    });

    it('should fallback within 500ms timeout', async () => {
      const slowPlug: ParsingPlug = {
        parse: async (_source: string, _filePath: string) => {
          await new Promise(resolve => setTimeout(resolve, 1000)); // exceeds 500ms
          return {} as CstNode;
        },
        parseIncremental: async (_source: string, _edit: TreeSitterEdit, _prev: CstNode) => ({} as CstNode),
      };

      registry.registerParsing(slowPlug);
      const parsing = registry.getParsing();

      const start = Date.now();
      const result = await parsing.parse('const x = 1;', 'test.ts');
      const elapsed = Date.now() - start;

      // Should fallback to default within ~500ms (allow some tolerance)
      expect(elapsed).toBeLessThan(700);
      expect(result.type).toBe('program'); // default result
    });
  });

  // ─── Routing through custom implementation (Req 19.6) ───────────────────

  describe('custom plug routing', () => {
    it('should route parsing through custom implementation when registered', async () => {
      const customResult: CstNode = {
        id: 'custom-root', type: 'custom_program', start_byte: 0, end_byte: 5,
        start_position: { row: 0, column: 0 }, end_position: { row: 0, column: 5 },
        children: [], is_error: false, text: 'hello',
      };

      const customParsing: ParsingPlug = {
        parse: async (_source: string, _filePath: string) => customResult,
        parseIncremental: async (_source: string, _edit: TreeSitterEdit, _prev: CstNode) => customResult,
      };

      registry.registerParsing(customParsing);
      const parsing = registry.getParsing();
      const result = await parsing.parse('hello', 'test.ts');
      expect(result.type).toBe('custom_program');
      expect(result.id).toBe('custom-root');
    });

    it('should route repair through custom implementation when registered', async () => {
      const customCandidates: PatchCandidate[] = [{
        id: 'custom-patch-1',
        diff: '+ fixed',
        edit_operations: [],
        target_file: 'test.ts',
        target_range: { start_line: 1, end_line: 5 },
        refinement_attempt: 0,
      }];

      const customRepair: RepairPlug = {
        generateCandidates: async (_ctx: DefectContext) => customCandidates,
        refine: async (patch: PatchCandidate, _fb: StageFeedback) => patch,
      };

      registry.registerRepair(customRepair);
      const repair = registry.getRepair();
      const result = await repair.generateCandidates({} as DefectContext);
      expect(result).toEqual(customCandidates);
    });
  });
});
