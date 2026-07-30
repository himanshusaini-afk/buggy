/**
 * Dynamic backward program slicing types.
 */

import type { SourceLocation } from './graph.js';

export interface CapturedVariable {
  name: string;
  actual_value: unknown;
  expected_value?: unknown;
  diverges: boolean;
}

export interface SliceStatement {
  location: SourceLocation;
  variables: CapturedVariable[];
}

export interface DivergentVariable {
  name: string;
  actual_value: unknown;
  expected_value: unknown;
}

export interface DefectLine {
  line_number: number;
  file_path: string;
  divergent_variables: DivergentVariable[];
}

/**
 * Represents the boundary of a backward slice when no single-statement
 * divergence point was identified (Requirement 6.5).
 * Provides first and last statement locations for manual inspection.
 */
export interface SliceBoundary {
  first_statement: SourceLocation;
  last_statement: SourceLocation;
}

export interface BackwardSlice {
  violation_point: SourceLocation;
  statements: SliceStatement[];
  truncated: boolean;
  defect_line?: DefectLine;
  /**
   * When no divergence is found (defect_line is undefined),
   * the slice boundary provides the first and last statement
   * locations for manual inspection (Requirement 6.5).
   */
  slice_boundary?: SliceBoundary;
}
