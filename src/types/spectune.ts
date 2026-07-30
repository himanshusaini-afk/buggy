/**
 * SpecTune specification refinement types.
 */

export interface Postcondition {
  id: string;
  expression: string;
  description?: string;
}

export interface AlphaConsistency {
  value: number;
  agreeing_tests: number;
  total_tests: number;
  disagreeing_test_ids: string[];
}

export interface SpecTuneResult {
  postcondition: Postcondition;
  alpha_consistency: AlphaConsistency;
  status: 'fully_consistent' | 'partially_consistent' | 'discarded';
}
