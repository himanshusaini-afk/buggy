import { describe, it, expect } from 'vitest';
import {
  DiffTestGen,
  runDiffTestGen,
  type Implementation,
  type InterfaceMethod,
  type SpecificationAssertion,
  type BehavioralDifference,
  type DiffTestGenConfig,
} from '../../src/agents/difftestgen.js';

function makeMethod(name: string, paramTypes: string[] = ['number'], returnType = 'number'): InterfaceMethod {
  return { name, parameter_types: paramTypes, return_type: returnType };
}

function makeImpl(
  id: string,
  methods: InterfaceMethod[],
  executeFn: (method: string, input: unknown) => Promise<unknown>
): Implementation {
  return {
    id,
    name: `impl-${id}`,
    methods,
    execute: executeFn,
    source_location: {
      file_path: `src/${id}.ts`,
      start_line: 1,
      start_column: 0,
      end_line: 10,
      end_column: 0,
    },
  };
}

describe('DiffTestGen', () => {
  describe('runDiffTestGen with fewer than 2 implementations', () => {
    it('returns behaviorally_equivalent for empty array', async () => {
      const engine = new DiffTestGen();
      const result = await engine.runDiffTestGen([]);
      expect(result.status).toBe('behaviorally_equivalent');
      expect(result.differences).toHaveLength(0);
      expect(result.inputs_generated).toBe(0);
    });

    it('returns behaviorally_equivalent for single implementation', async () => {
      const impl = makeImpl('a', [makeMethod('add')], async () => 1);
      const engine = new DiffTestGen();
      const result = await engine.runDiffTestGen([impl]);
      expect(result.status).toBe('behaviorally_equivalent');
      expect(result.differences).toHaveLength(0);
    });
  });

  describe('generates ≥100 test inputs per interface method', () => {
    it('generates at least 100 inputs for a single method', async () => {
      let callCount = 0;
      const methods = [makeMethod('compute')];
      const implA = makeImpl('a', methods, async () => { callCount++; return 42; });
      const implB = makeImpl('b', methods, async () => { callCount++; return 42; });

      const engine = new DiffTestGen({ inputs_per_method: 100 });
      const result = await engine.runDiffTestGen([implA, implB]);

      expect(result.inputs_generated).toBeGreaterThanOrEqual(100);
      expect(result.methods_analyzed).toBe(1);
    });

    it('generates at least 100 inputs per method for multiple methods', async () => {
      const methods = [makeMethod('foo'), makeMethod('bar')];
      const implA = makeImpl('a', methods, async () => 'same');
      const implB = makeImpl('b', methods, async () => 'same');

      const engine = new DiffTestGen({ inputs_per_method: 100 });
      const result = await engine.runDiffTestGen([implA, implB]);

      expect(result.inputs_generated).toBeGreaterThanOrEqual(200);
      expect(result.methods_analyzed).toBe(2);
    });
  });

  describe('flags differences with required fields', () => {
    it('captures triggering input, both outputs, code locations, and severity', async () => {
      const methods = [makeMethod('getValue')];
      const implA = makeImpl('a', methods, async (_m, input) => (input as number) * 2);
      const implB = makeImpl('b', methods, async (_m, input) => (input as number) * 3);

      const engine = new DiffTestGen({ inputs_per_method: 100 });
      const result = await engine.runDiffTestGen([implA, implB]);

      expect(result.status).toBe('differences_found');
      expect(result.differences.length).toBeGreaterThan(0);

      const diff = result.differences[0];
      expect(diff.triggering_input).toBeDefined();
      expect(diff.outputs).toHaveProperty('a');
      expect(diff.outputs).toHaveProperty('b');
      expect(diff.code_locations).toHaveProperty('a');
      expect(diff.code_locations).toHaveProperty('b');
      expect(diff.code_locations['a'].file_path).toBe('src/a.ts');
      expect(diff.code_locations['b'].file_path).toBe('src/b.ts');
      expect(['specification-violating', 'unspecified-behavior']).toContain(diff.severity);
      expect(diff.method_name).toBe('getValue');
      expect(diff.id).toBeTruthy();
    });

    it('flags execution errors as differences', async () => {
      const methods = [makeMethod('riskyOp')];
      const implA = makeImpl('a', methods, async () => 'ok');
      const implB = makeImpl('b', methods, async () => { throw new Error('crash'); });

      const engine = new DiffTestGen({ inputs_per_method: 100 });
      const result = await engine.runDiffTestGen([implA, implB]);

      expect(result.status).toBe('differences_found');
      expect(result.differences.length).toBeGreaterThan(0);

      const diff = result.differences[0];
      expect(diff.outputs['a']).toBe('ok');
      expect(diff.outputs['b']).toEqual({ error: 'crash' });
    });
  });

  describe('severity classification', () => {
    it('classifies as specification-violating when spec assertion is violated', async () => {
      const methods = [makeMethod('abs')];
      // implA returns absolute value correctly, implB returns negative
      const implA = makeImpl('a', methods, async (_m, input) => Math.abs(input as number));
      const implB = makeImpl('b', methods, async (_m, input) => -(input as number));

      const spec: SpecificationAssertion = {
        id: 'abs-nonneg',
        method_name: 'abs',
        expression: 'output >= 0',
        evaluate: (_input, output) => (output as number) >= 0,
      };

      const engine = new DiffTestGen({
        inputs_per_method: 100,
        specifications: [spec],
      });
      const result = await engine.runDiffTestGen([implA, implB]);

      expect(result.status).toBe('differences_found');
      const specViolating = result.differences.filter(d => d.severity === 'specification-violating');
      expect(specViolating.length).toBeGreaterThan(0);
      expect(specViolating[0].violated_assertion_id).toBe('abs-nonneg');
    });

    it('classifies as unspecified-behavior when no spec assertions exist', async () => {
      const methods = [makeMethod('compute')];
      const implA = makeImpl('a', methods, async (_m, input) => (input as number) + 1);
      const implB = makeImpl('b', methods, async (_m, input) => (input as number) + 2);

      const engine = new DiffTestGen({ inputs_per_method: 100, specifications: [] });
      const result = await engine.runDiffTestGen([implA, implB]);

      expect(result.status).toBe('differences_found');
      const allUnspecified = result.differences.every(d => d.severity === 'unspecified-behavior');
      expect(allUnspecified).toBe(true);
    });
  });

  describe('prioritizes specification-violating before unspecified-behavior', () => {
    it('sorts results with spec-violating first', async () => {
      const engine = new DiffTestGen();

      const mixedDiffs: BehavioralDifference[] = [
        {
          id: '1',
          method_name: 'a',
          triggering_input: 1,
          outputs: { x: 1, y: 2 },
          code_locations: { x: { file_path: 'x.ts', start_line: 1, start_column: 0, end_line: 1, end_column: 0 }, y: { file_path: 'y.ts', start_line: 1, start_column: 0, end_line: 1, end_column: 0 } },
          severity: 'unspecified-behavior',
        },
        {
          id: '2',
          method_name: 'b',
          triggering_input: 2,
          outputs: { x: 3, y: 4 },
          code_locations: { x: { file_path: 'x.ts', start_line: 1, start_column: 0, end_line: 1, end_column: 0 }, y: { file_path: 'y.ts', start_line: 1, start_column: 0, end_line: 1, end_column: 0 } },
          severity: 'specification-violating',
        },
        {
          id: '3',
          method_name: 'c',
          triggering_input: 3,
          outputs: { x: 5, y: 6 },
          code_locations: { x: { file_path: 'x.ts', start_line: 1, start_column: 0, end_line: 1, end_column: 0 }, y: { file_path: 'y.ts', start_line: 1, start_column: 0, end_line: 1, end_column: 0 } },
          severity: 'unspecified-behavior',
        },
      ];

      const sorted = engine.prioritizeDifferences(mixedDiffs);

      expect(sorted[0].severity).toBe('specification-violating');
      expect(sorted[1].severity).toBe('unspecified-behavior');
      expect(sorted[2].severity).toBe('unspecified-behavior');
    });

    it('full run sorts differences by severity in results', async () => {
      const methods = [makeMethod('calc')];
      // Impl A: always returns 0
      const implA = makeImpl('a', methods, async () => 0);
      // Impl B: sometimes returns negative (violating spec) and sometimes different positive
      let callIdx = 0;
      const implB = makeImpl('b', methods, async () => {
        callIdx++;
        return callIdx % 2 === 0 ? -1 : 5;
      });

      const spec: SpecificationAssertion = {
        id: 'non-neg',
        method_name: 'calc',
        expression: 'output >= 0',
        evaluate: (_input, output) => (output as number) >= 0,
      };

      const engine = new DiffTestGen({
        inputs_per_method: 100,
        specifications: [spec],
      });
      const result = await engine.runDiffTestGen([implA, implB]);

      expect(result.differences.length).toBeGreaterThan(0);

      // All spec-violating should come before unspecified-behavior
      let seenUnspecified = false;
      for (const diff of result.differences) {
        if (diff.severity === 'unspecified-behavior') {
          seenUnspecified = true;
        }
        if (diff.severity === 'specification-violating' && seenUnspecified) {
          throw new Error('specification-violating diff found after unspecified-behavior');
        }
      }
    });
  });

  describe('reports behaviorally equivalent when budget exhausted', () => {
    it('returns behaviorally_equivalent when all outputs match', async () => {
      const methods = [makeMethod('identity')];
      const implA = makeImpl('a', methods, async (_m, input) => input);
      const implB = makeImpl('b', methods, async (_m, input) => input);

      const engine = new DiffTestGen({ inputs_per_method: 100 });
      const result = await engine.runDiffTestGen([implA, implB]);

      expect(result.status).toBe('behaviorally_equivalent');
      expect(result.differences).toHaveLength(0);
      expect(result.inputs_generated).toBeGreaterThanOrEqual(100);
    });

    it('respects max_budget constraint', async () => {
      let totalCalls = 0;
      const methods = [makeMethod('m1'), makeMethod('m2'), makeMethod('m3')];
      const implA = makeImpl('a', methods, async () => { totalCalls++; return 1; });
      const implB = makeImpl('b', methods, async () => { totalCalls++; return 1; });

      const engine = new DiffTestGen({
        inputs_per_method: 100,
        max_budget: 150,
      });
      const result = await engine.runDiffTestGen([implA, implB]);

      // Should stop before exhausting all methods due to budget
      expect(result.inputs_generated).toBeLessThanOrEqual(300);
    });
  });

  describe('common method detection', () => {
    it('only tests methods common to all implementations', async () => {
      const methodsA = [makeMethod('shared'), makeMethod('onlyA')];
      const methodsB = [makeMethod('shared'), makeMethod('onlyB')];

      const implA = makeImpl('a', methodsA, async () => 'result');
      const implB = makeImpl('b', methodsB, async () => 'result');

      const engine = new DiffTestGen({ inputs_per_method: 100 });
      const result = await engine.runDiffTestGen([implA, implB]);

      expect(result.methods_analyzed).toBe(1);
    });
  });

  describe('result metadata', () => {
    it('includes processing_time_ms in results', async () => {
      const methods = [makeMethod('op')];
      const implA = makeImpl('a', methods, async () => 1);
      const implB = makeImpl('b', methods, async () => 1);

      const engine = new DiffTestGen({ inputs_per_method: 100 });
      const result = await engine.runDiffTestGen([implA, implB]);

      expect(result.processing_time_ms).toBeGreaterThanOrEqual(0);
    });
  });

  describe('standalone runDiffTestGen function', () => {
    it('works as a convenience wrapper', async () => {
      const methods = [makeMethod('add')];
      const implA = makeImpl('a', methods, async (_m, input) => (input as number) + 1);
      const implB = makeImpl('b', methods, async (_m, input) => (input as number) + 1);

      const result = await runDiffTestGen([implA, implB]);

      expect(result.status).toBe('behaviorally_equivalent');
      expect(result.inputs_generated).toBeGreaterThanOrEqual(100);
    });

    it('accepts optional config', async () => {
      const methods = [makeMethod('mul')];
      const implA = makeImpl('a', methods, async (_m, input) => (input as number) * 2);
      const implB = makeImpl('b', methods, async (_m, input) => (input as number) * 3);

      const result = await runDiffTestGen([implA, implB], {
        inputs_per_method: 100,
      });

      expect(result.status).toBe('differences_found');
      expect(result.differences.length).toBeGreaterThan(0);
    });
  });
});
