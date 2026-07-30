/**
 * Dynamic backward program slicing.
 *
 * Implements Requirements 6.1–6.6: compute backward slices from postcondition
 * violations, capture variable states, identify defect lines, and handle
 * truncation for large traces.
 */

import type {
  BackwardSlice,
  SliceStatement,
  SliceBoundary,
  DefectLine,
  CapturedVariable,
  DivergentVariable,
} from '../types/slicing.js';
import type { SourceLocation } from '../types/graph.js';

/** Maximum number of statements to instrument in a backward slice. */
const MAX_SLICE_STATEMENTS = 10_000;

/**
 * A single statement in an execution trace.
 */
export interface TraceStatement {
  location: SourceLocation;
  /** Variable values captured at this statement. */
  variables: Record<string, unknown>;
  /** Variable names read by this statement. */
  reads: string[];
  /** Variable names written by this statement. */
  writes: string[];
}

/**
 * An execution trace consisting of an ordered sequence of statements.
 */
export interface ExecutionTrace {
  statements: TraceStatement[];
}

/**
 * A postcondition specification describing the expected value of a variable.
 */
export interface PostconditionSpec {
  variable_name: string;
  expected_value: unknown;
  expression: string;
}

/**
 * Result of a slicing operation with structured output.
 * Includes the backward slice and a human-readable summary.
 */
export interface SlicingResult {
  slice: BackwardSlice;
  /** True if a defect line was identified. */
  defect_found: boolean;
  /** Summary message for output. */
  summary: string;
}

/**
 * Performs dynamic backward program slicing from a postcondition violation
 * point. Walks backward through an execution trace, including statements
 * whose writes feed into the reads of already-included statements, then
 * identifies the earliest divergence point (defect line).
 */
export class DynamicSlicer {
  /**
   * Perform dynamic backward slicing and produce structured output.
   *
   * This is the primary entry point that computes the slice, identifies
   * the defect line or reports the slice boundary, and produces a
   * structured result.
   *
   * Requirement 6.4: structured output with line number, file path,
   * divergent variables, actual/expected values.
   * Requirement 6.5: if no divergence, report full slice boundary.
   */
  performSlicing(
    trace: ExecutionTrace,
    violationIndex: number,
    postcondition: PostconditionSpec,
  ): SlicingResult {
    const slice = this.computeSlice(trace, violationIndex, postcondition);

    if (slice.defect_line) {
      return {
        slice,
        defect_found: true,
        summary: `Defect identified at ${slice.defect_line.file_path}:${slice.defect_line.line_number} — ` +
          `divergent variables: ${slice.defect_line.divergent_variables.map((v) => v.name).join(', ')}`,
      };
    }

    return {
      slice,
      defect_found: false,
      summary: slice.slice_boundary
        ? `No single-statement divergence found. Slice boundary: ` +
          `${slice.slice_boundary.first_statement.file_path}:${slice.slice_boundary.first_statement.start_line} ` +
          `to ${slice.slice_boundary.last_statement.file_path}:${slice.slice_boundary.last_statement.start_line}`
        : 'Empty slice — no statements to analyze.',
    };
  }

  /**
   * Perform dynamic backward slicing from a violation point.
   *
   * Starting at the violation index, walks backward through the trace and
   * includes a statement if it writes a variable that is read by any
   * statement already in the slice. Captures variable values at each
   * included statement (up to MAX_SLICE_STATEMENTS).
   *
   * Requirement 6.1: compute the set of statements that influenced violated
   * postcondition variable values.
   * Requirement 6.2: capture values of all local variables and parameters at
   * each statement within the slice (up to 10,000).
   * Requirement 6.6: truncate to 10,000 statements nearest to violation point
   * if slice exceeds the limit.
   */
  computeSlice(
    trace: ExecutionTrace,
    violationIndex: number,
    postcondition: PostconditionSpec,
  ): BackwardSlice {
    const { statements } = trace;

    if (violationIndex < 0 || violationIndex >= statements.length) {
      return {
        violation_point: this.emptyLocation(),
        statements: [],
        truncated: false,
      };
    }

    const violationStmt = statements[violationIndex];

    // The set of variables we are tracking (need to be defined by earlier statements).
    // Seed with the postcondition variable.
    const trackedVariables = new Set<string>([postcondition.variable_name]);

    // Also include all variables read at the violation point (they contribute
    // to the violated variable's value).
    for (const r of violationStmt.reads) {
      trackedVariables.add(r);
    }

    // Collect slice statements walking backward from violation point.
    const sliceStatements: SliceStatement[] = [];
    let truncated = false;

    // Always include the violation point itself.
    sliceStatements.push(
      this.buildSliceStatement(violationStmt, postcondition),
    );

    // Walk backward from violationIndex - 1 to 0.
    for (let i = violationIndex - 1; i >= 0; i--) {
      if (sliceStatements.length >= MAX_SLICE_STATEMENTS) {
        truncated = true;
        break;
      }

      const stmt = statements[i];

      // Include this statement if it writes any tracked variable.
      const writesTracked = stmt.writes.some((w) => trackedVariables.has(w));

      if (writesTracked) {
        sliceStatements.push(
          this.buildSliceStatement(stmt, postcondition),
        );

        // Add variables read by this statement to the tracked set,
        // because they contributed to the written value.
        for (const r of stmt.reads) {
          trackedVariables.add(r);
        }
      }
    }

    const slice: BackwardSlice = {
      violation_point: violationStmt.location,
      statements: sliceStatements,
      truncated,
    };

    // Identify defect line (Requirement 6.3).
    const defectLine = this.identifyDefectLine(slice, postcondition);
    if (defectLine) {
      slice.defect_line = defectLine;
    } else if (sliceStatements.length > 0) {
      // Requirement 6.5: no divergence found → report full slice boundary
      // (first and last statement locations) for manual inspection.
      slice.slice_boundary = this.computeSliceBoundary(sliceStatements);
    }

    return slice;
  }

  /**
   * Identify defect line: the earliest statement in the slice where a
   * captured variable's actual value differs from the expected value.
   *
   * Requirement 6.3: earliest statement where actual diverges from expected.
   * Requirement 6.4: report line_number, file_path, divergent variables,
   * actual/expected values.
   */
  identifyDefectLine(
    slice: BackwardSlice,
    postcondition: PostconditionSpec,
  ): DefectLine | null {
    if (slice.statements.length === 0) {
      return null;
    }

    // Walk through slice statements. The slice is ordered from violation point
    // backward, so the last element is the earliest statement.
    // We want the *earliest* divergent statement.
    let earliestDefect: DefectLine | null = null;

    for (const stmt of slice.statements) {
      const divergentVars: DivergentVariable[] = [];

      for (const captured of stmt.variables) {
        if (captured.diverges && captured.expected_value !== undefined) {
          divergentVars.push({
            name: captured.name,
            actual_value: captured.actual_value,
            expected_value: captured.expected_value,
          });
        }
      }

      if (divergentVars.length > 0) {
        // This is a candidate; keep the earliest (furthest from violation point,
        // which is at the end of our array since we walk backward).
        earliestDefect = {
          line_number: stmt.location.start_line,
          file_path: stmt.location.file_path,
          divergent_variables: divergentVars,
        };
      }
    }

    return earliestDefect;
  }

  /**
   * Compute the slice boundary: first and last statement locations
   * for manual inspection when no divergence is found.
   *
   * Requirement 6.5: provide the full slice boundary.
   */
  computeSliceBoundary(sliceStatements: SliceStatement[]): SliceBoundary {
    // The slice is ordered from violation point (index 0) backward (last index).
    // "First statement" = earliest in execution = last in array.
    // "Last statement" = nearest to violation = first in array.
    const firstStatement = sliceStatements[sliceStatements.length - 1].location;
    const lastStatement = sliceStatements[0].location;

    return {
      first_statement: firstStatement,
      last_statement: lastStatement,
    };
  }

  /**
   * Build a SliceStatement with captured variable information.
   */
  private buildSliceStatement(
    stmt: TraceStatement,
    postcondition: PostconditionSpec,
  ): SliceStatement {
    const variables: CapturedVariable[] = [];

    for (const [name, value] of Object.entries(stmt.variables)) {
      const isPostconditionVar = name === postcondition.variable_name;
      const expectedValue = isPostconditionVar
        ? postcondition.expected_value
        : undefined;
      const diverges = isPostconditionVar
        ? !this.valuesEqual(value, postcondition.expected_value)
        : false;

      variables.push({
        name,
        actual_value: value,
        expected_value: expectedValue,
        diverges,
      });
    }

    return {
      location: stmt.location,
      variables,
    };
  }

  /**
   * Compare two values for equality using deep structural comparison.
   */
  private valuesEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (a === null || b === null) return false;
    if (a === undefined || b === undefined) return false;
    if (typeof a !== typeof b) return false;

    if (typeof a === 'object' && typeof b === 'object') {
      return JSON.stringify(a) === JSON.stringify(b);
    }

    return false;
  }

  /**
   * Create an empty SourceLocation for edge cases.
   */
  private emptyLocation(): SourceLocation {
    return {
      file_path: '',
      start_line: 0,
      start_column: 0,
      end_line: 0,
      end_column: 0,
    };
  }
}
