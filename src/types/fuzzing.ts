/**
 * SAFuzz biased fuzzing types.
 */

import type { OracleType } from './sandbox.js';

export interface Mutation {
  operator: 'Insert' | 'Overwrite' | 'Splice';
  position: number;
  tokens: string[];
  seed_input_id: string;
}

export interface FuzzViolation {
  input: unknown;
  mutation_operator: 'Insert' | 'Overwrite' | 'Splice';
  oracle_type: OracleType;
  seed_input: unknown;
}

export interface FuzzResult {
  status: 'violation_found' | 'inconclusive';
  violations: FuzzViolation[];
  mutations_attempted: number;
  budget_remaining: number;
}
