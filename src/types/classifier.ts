/**
 * Classifier agent types for overfitting detection.
 */

export interface AstProperty {
  name: string;
  edit_state: 'gen' | 'del' | 'remain';
  contribution: number;
}

export interface AstDifferenceVector {
  properties: number[];  // length: 11
}

export interface SemanticFeatureVector {
  gen: AstDifferenceVector;
  del: AstDifferenceVector;
  remain: AstDifferenceVector;
  combined: number[];  // length: 66 (11 × 3 × 2)
}

export interface ClassificationResult {
  approved: boolean;
  overfitting_probability: number;
  top_contributing_properties?: AstProperty[];  // top 3 if rejected
  patch_id: string;
  inconclusive?: boolean;
}
