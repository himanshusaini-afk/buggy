import { describe, it, expect } from 'vitest';
import {
  DynamicSlicer,
  ExecutionTrace,
  PostconditionSpec,
  TraceStatement,
} from '../../src/agents/slicing.js';
import type { SourceLocation } from '../../src/types/graph.js';

function makeLocation(file: string, line: number): SourceLocation {
  return {
    file_path: file,
    start_line: line,
    start_column: 0,
    end_line: line,
    end_column: 10,
  };
}

function makeTraceStatement(
  line: number,
  variables: Record<string, unknown>,
  reads: string[],
  writes: string[],
  file = 'test.ts',
): TraceStatement {
  return {
    location: makeLocation(file, line),
    variables,
    reads,
    writes,
  };
}

describe('DynamicSlicer', () => {
  const slicer = new DynamicSlicer();

  describe('computeSlice - Requirement 6.1: backward slice computation', () => {
    it('should include statements that influence the violated postcondition variable', () => {
      const trace: ExecutionTrace = {
        statements: [
          makeTraceStatement(1, { x: 1 }, [], ['x']),
          makeTraceStatement(2, { y: 2 }, ['x'], ['y']),
          makeTraceStatement(3, { z: 3 }, ['y'], ['z']),
          makeTraceStatement(4, { result: 6 }, ['z'], ['result']),
        ],
      };

      const postcondition: PostconditionSpec = {
        variable_name: 'result',
        expected_value: 10,
        expression: 'result === 10',
      };

      const slice = slicer.computeSlice(trace, 3, postcondition);

      expect(slice.violation_point).toEqual(makeLocation('test.ts', 4));
      // Should include all statements in the data-flow chain
      expect(slice.statements.length).toBeGreaterThan(1);
    });

    it('should not include statements that do not influence the violated variable', () => {
      const trace: ExecutionTrace = {
        statements: [
          makeTraceStatement(1, { unrelated: 99 }, [], ['unrelated']),
          makeTraceStatement(2, { x: 5 }, [], ['x']),
          makeTraceStatement(3, { result: 10 }, ['x'], ['result']),
        ],
      };

      const postcondition: PostconditionSpec = {
        variable_name: 'result',
        expected_value: 20,
        expression: 'result === 20',
      };

      const slice = slicer.computeSlice(trace, 2, postcondition);

      // Violation point (line 3) + x write (line 2) should be in slice, but not unrelated (line 1)
      const lines = slice.statements.map((s) => s.location.start_line);
      expect(lines).toContain(3); // violation point
      expect(lines).toContain(2); // writes x which is read by result
      expect(lines).not.toContain(1); // writes unrelated, which is not tracked
    });

    it('should handle empty trace gracefully', () => {
      const trace: ExecutionTrace = { statements: [] };
      const postcondition: PostconditionSpec = {
        variable_name: 'x',
        expected_value: 1,
        expression: 'x === 1',
      };

      const slice = slicer.computeSlice(trace, 0, postcondition);
      expect(slice.statements).toHaveLength(0);
      expect(slice.truncated).toBe(false);
    });

    it('should handle invalid violation index', () => {
      const trace: ExecutionTrace = {
        statements: [makeTraceStatement(1, { x: 1 }, [], ['x'])],
      };
      const postcondition: PostconditionSpec = {
        variable_name: 'x',
        expected_value: 2,
        expression: 'x === 2',
      };

      const sliceNeg = slicer.computeSlice(trace, -1, postcondition);
      expect(sliceNeg.statements).toHaveLength(0);

      const sliceOver = slicer.computeSlice(trace, 5, postcondition);
      expect(sliceOver.statements).toHaveLength(0);
    });
  });

  describe('computeSlice - Requirement 6.2: capture variable values up to 10,000', () => {
    it('should capture variable values at each statement in the slice', () => {
      const trace: ExecutionTrace = {
        statements: [
          makeTraceStatement(1, { x: 1, y: 2 }, [], ['x']),
          makeTraceStatement(2, { x: 1, result: 3 }, ['x'], ['result']),
        ],
      };

      const postcondition: PostconditionSpec = {
        variable_name: 'result',
        expected_value: 5,
        expression: 'result === 5',
      };

      const slice = slicer.computeSlice(trace, 1, postcondition);

      // Violation point statement should have captured variables
      const violationStmt = slice.statements[0];
      expect(violationStmt.variables.length).toBeGreaterThan(0);

      const resultVar = violationStmt.variables.find((v) => v.name === 'result');
      expect(resultVar).toBeDefined();
      expect(resultVar!.actual_value).toBe(3);
      expect(resultVar!.expected_value).toBe(5);
      expect(resultVar!.diverges).toBe(true);
    });
  });

  describe('computeSlice - Requirement 6.6: truncation at 10,000 statements', () => {
    it('should truncate and indicate when slice exceeds 10,000 statements', () => {
      // Generate a large trace where every statement is part of the data dependency chain
      const stmts: TraceStatement[] = [];
      for (let i = 0; i < 11_000; i++) {
        stmts.push(
          makeTraceStatement(
            i + 1,
            { x: i },
            i > 0 ? ['x'] : [],
            ['x'],
          ),
        );
      }

      const trace: ExecutionTrace = { statements: stmts };
      const postcondition: PostconditionSpec = {
        variable_name: 'x',
        expected_value: 999999,
        expression: 'x === 999999',
      };

      // Violation at the last statement
      const slice = slicer.computeSlice(trace, stmts.length - 1, postcondition);

      expect(slice.truncated).toBe(true);
      expect(slice.statements.length).toBe(10_000);
    });

    it('should not truncate when slice is within limit', () => {
      const stmts: TraceStatement[] = [];
      for (let i = 0; i < 100; i++) {
        stmts.push(
          makeTraceStatement(i + 1, { x: i }, i > 0 ? ['x'] : [], ['x']),
        );
      }

      const trace: ExecutionTrace = { statements: stmts };
      const postcondition: PostconditionSpec = {
        variable_name: 'x',
        expected_value: 999,
        expression: 'x === 999',
      };

      const slice = slicer.computeSlice(trace, stmts.length - 1, postcondition);
      expect(slice.truncated).toBe(false);
    });
  });

  describe('identifyDefectLine - Requirement 6.3: earliest divergence', () => {
    it('should identify the earliest statement where actual diverges from expected', () => {
      const trace: ExecutionTrace = {
        statements: [
          makeTraceStatement(1, { result: 10 }, [], ['result']), // matches expected
          makeTraceStatement(2, { result: 7 }, ['result'], ['result']), // diverges
          makeTraceStatement(3, { result: 7 }, ['result'], ['result']), // still diverges
          makeTraceStatement(4, { result: 7 }, ['result'], ['result']), // violation point
        ],
      };

      const postcondition: PostconditionSpec = {
        variable_name: 'result',
        expected_value: 10,
        expression: 'result === 10',
      };

      const slice = slicer.computeSlice(trace, 3, postcondition);

      expect(slice.defect_line).toBeDefined();
      // The earliest divergent statement should be identified
      // In the backward walk, line 2 is where divergence starts
      expect(slice.defect_line!.line_number).toBe(2);
      expect(slice.defect_line!.file_path).toBe('test.ts');
    });

    it('should return null when no statements diverge', () => {
      const trace: ExecutionTrace = {
        statements: [
          makeTraceStatement(1, { result: 10 }, [], ['result']),
          makeTraceStatement(2, { result: 10 }, ['result'], ['result']),
        ],
      };

      const postcondition: PostconditionSpec = {
        variable_name: 'result',
        expected_value: 10,
        expression: 'result === 10',
      };

      const slice = slicer.computeSlice(trace, 1, postcondition);
      expect(slice.defect_line).toBeUndefined();
    });
  });

  describe('Structured output - Requirement 6.4', () => {
    it('should produce structured output with line number, file path, divergent variables, actual/expected', () => {
      const trace: ExecutionTrace = {
        statements: [
          makeTraceStatement(5, { counter: 3 }, [], ['counter'], 'src/math.ts'),
          makeTraceStatement(10, { counter: 3 }, ['counter'], ['counter'], 'src/math.ts'),
        ],
      };

      const postcondition: PostconditionSpec = {
        variable_name: 'counter',
        expected_value: 5,
        expression: 'counter === 5',
      };

      const slice = slicer.computeSlice(trace, 1, postcondition);

      expect(slice.defect_line).toBeDefined();
      expect(slice.defect_line!.line_number).toBeTypeOf('number');
      expect(slice.defect_line!.file_path).toBe('src/math.ts');
      expect(slice.defect_line!.divergent_variables.length).toBeGreaterThan(0);

      const dv = slice.defect_line!.divergent_variables[0];
      expect(dv.name).toBe('counter');
      expect(dv.actual_value).toBe(3);
      expect(dv.expected_value).toBe(5);
    });
  });

  describe('Slice boundary - Requirement 6.5: no divergence found', () => {
    it('should report slice boundary when no divergence found', () => {
      const trace: ExecutionTrace = {
        statements: [
          makeTraceStatement(1, { x: 10, y: 20 }, [], ['x']),
          makeTraceStatement(5, { x: 10, result: 10 }, ['x'], ['result']),
        ],
      };

      const postcondition: PostconditionSpec = {
        variable_name: 'result',
        expected_value: 10,
        expression: 'result === 10',
      };

      const slice = slicer.computeSlice(trace, 1, postcondition);

      // No divergence since actual equals expected
      expect(slice.defect_line).toBeUndefined();
      expect(slice.slice_boundary).toBeDefined();
      expect(slice.slice_boundary!.first_statement.start_line).toBe(1);
      expect(slice.slice_boundary!.last_statement.start_line).toBe(5);
    });
  });

  describe('performSlicing - full structured result', () => {
    it('should return defect_found=true with summary when defect is identified', () => {
      const trace: ExecutionTrace = {
        statements: [
          makeTraceStatement(3, { val: 99 }, [], ['val'], 'app.ts'),
          makeTraceStatement(7, { val: 99 }, ['val'], ['val'], 'app.ts'),
        ],
      };

      const postcondition: PostconditionSpec = {
        variable_name: 'val',
        expected_value: 42,
        expression: 'val === 42',
      };

      const result = slicer.performSlicing(trace, 1, postcondition);

      expect(result.defect_found).toBe(true);
      expect(result.summary).toContain('app.ts');
      expect(result.summary).toContain('val');
      expect(result.slice.defect_line).toBeDefined();
    });

    it('should return defect_found=false with boundary summary when no divergence', () => {
      const trace: ExecutionTrace = {
        statements: [
          makeTraceStatement(1, { x: 5, y: 10 }, [], ['x'], 'lib.ts'),
          makeTraceStatement(4, { x: 5, result: 5 }, ['x'], ['result'], 'lib.ts'),
        ],
      };

      const postcondition: PostconditionSpec = {
        variable_name: 'result',
        expected_value: 5,
        expression: 'result === 5',
      };

      const result = slicer.performSlicing(trace, 1, postcondition);

      expect(result.defect_found).toBe(false);
      expect(result.summary).toContain('No single-statement divergence found');
      expect(result.summary).toContain('lib.ts');
    });

    it('should handle single-statement trace', () => {
      const trace: ExecutionTrace = {
        statements: [
          makeTraceStatement(1, { x: 1 }, [], ['x']),
        ],
      };

      const postcondition: PostconditionSpec = {
        variable_name: 'x',
        expected_value: 2,
        expression: 'x === 2',
      };

      const result = slicer.performSlicing(trace, 0, postcondition);

      expect(result.defect_found).toBe(true);
      expect(result.slice.statements).toHaveLength(1);
      expect(result.slice.truncated).toBe(false);
    });

    it('should produce empty slice summary for empty trace', () => {
      const trace: ExecutionTrace = { statements: [] };
      const postcondition: PostconditionSpec = {
        variable_name: 'x',
        expected_value: 1,
        expression: 'x === 1',
      };

      const result = slicer.performSlicing(trace, 0, postcondition);

      expect(result.defect_found).toBe(false);
      expect(result.summary).toContain('Empty slice');
    });
  });

  describe('computeSliceBoundary', () => {
    it('should report first (earliest) and last (nearest to violation) statement locations', () => {
      const stmts = [
        { location: makeLocation('a.ts', 10), variables: [] },
        { location: makeLocation('a.ts', 5), variables: [] },
        { location: makeLocation('a.ts', 1), variables: [] },
      ];

      const boundary = slicer.computeSliceBoundary(stmts);

      // First in execution (earliest) = last in array
      expect(boundary.first_statement.start_line).toBe(1);
      // Last (nearest to violation) = first in array
      expect(boundary.last_statement.start_line).toBe(10);
    });
  });

  describe('value comparison edge cases', () => {
    it('should detect divergence with object values', () => {
      const trace: ExecutionTrace = {
        statements: [
          makeTraceStatement(1, { obj: { a: 1, b: 2 } }, [], ['obj']),
          makeTraceStatement(2, { obj: { a: 1, b: 2 } }, ['obj'], ['obj']),
        ],
      };

      const postcondition: PostconditionSpec = {
        variable_name: 'obj',
        expected_value: { a: 1, b: 3 },
        expression: 'obj.b === 3',
      };

      const slice = slicer.computeSlice(trace, 1, postcondition);
      expect(slice.defect_line).toBeDefined();
    });

    it('should not diverge when object values match', () => {
      const trace: ExecutionTrace = {
        statements: [
          makeTraceStatement(1, { obj: { a: 1 } }, [], ['obj']),
          makeTraceStatement(2, { obj: { a: 1 } }, ['obj'], ['obj']),
        ],
      };

      const postcondition: PostconditionSpec = {
        variable_name: 'obj',
        expected_value: { a: 1 },
        expression: 'obj.a === 1',
      };

      const slice = slicer.computeSlice(trace, 1, postcondition);
      expect(slice.defect_line).toBeUndefined();
    });

    it('should detect divergence with null vs non-null', () => {
      const trace: ExecutionTrace = {
        statements: [
          makeTraceStatement(1, { x: null }, [], ['x']),
          makeTraceStatement(2, { x: null }, ['x'], ['x']),
        ],
      };

      const postcondition: PostconditionSpec = {
        variable_name: 'x',
        expected_value: 5,
        expression: 'x === 5',
      };

      const slice = slicer.computeSlice(trace, 1, postcondition);
      expect(slice.defect_line).toBeDefined();
    });
  });
});
