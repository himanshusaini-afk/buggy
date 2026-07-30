/**
 * PROBE adversarial loop types for property refinement.
 */

export interface CandidateProperty {
  id: string;
  expression: string;
  description?: string;
}

export interface ProbeRefinement {
  iteration: number;
  previous_property: string;
  counter_implementation: string;
  refined_property: string;
}

export interface ProbeResult {
  status: 'verified' | 'inconclusive';
  property: CandidateProperty;
  iterations_completed: number;
  refinement_history: ProbeRefinement[];
  last_counter_implementation?: string;
}
