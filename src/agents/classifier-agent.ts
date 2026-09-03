import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { CstNode } from '../types/cst.js';
import type {
  AstDifferenceVector,
  AstProperty,
  ClassificationResult,
  SemanticFeatureVector,
} from '../types/classifier.js';
import type { PatchCandidate } from '../types/repair.js';

/**
 * The 11 AST properties measured per edit state.
 * These capture structural code features relevant to overfitting detection.
 */
export const AST_PROPERTY_NAMES: readonly string[] = [
  'statement_count',
  'branch_count',
  'loop_count',
  'function_call_count',
  'variable_declaration_count',
  'assignment_count',
  'return_count',
  'literal_count',
  'operator_count',
  'nesting_depth',
  'identifier_count',
] as const;

export const AST_PROPERTY_COUNT = 11;
export const EDIT_STATE_COUNT = 3;
export const FEATURE_VECTOR_DIMENSIONS = AST_PROPERTY_COUNT * EDIT_STATE_COUNT * 2; // 66

/**
 * Configuration for the Classifier Agent.
 */
export interface ClassifierConfig {
  /** Overfitting threshold. Scores above this reject the patch. Default: 0.5 */
  overfitting_threshold: number;
  /** Timeout for Prism APCC model evaluation in milliseconds. Default: 30000 */
  model_timeout_ms: number;
}

const DEFAULT_CONFIG: ClassifierConfig = {
  overfitting_threshold: 0.5,
  model_timeout_ms: 30000,
};

/**
 * Represents the edit state classification of AST nodes between
 * the original and patched code.
 */
export interface EditStateNodes {
  /** Nodes generated (added) by the patch */
  gen: CstNode[];
  /** Nodes deleted by the patch */
  del: CstNode[];
  /** Nodes that remain unchanged */
  remain: CstNode[];
}

/**
 * Classifier Agent that computes 66-dimensional semantic feature vectors
 * and evaluates overfitting probability via the Prism APCC model.
 *
 * The classification pipeline:
 * 1. Extract edit states (Gen, Del, Remain) by comparing original and patched CSTs
 * 2. Compute 11-property AST difference vector per edit state
 * 3. Compose into 66-dimensional feature vector (11 × 3 × 2 = 66)
 * 4. Evaluate via Prism_APCC model → overfitting probability [0.0, 1.0]
 * 5. Decision: approve (score ≤ threshold) or reject (score > threshold)
 */
export class ClassifierAgent {
  private db: Database.Database;
  private config: ClassifierConfig;
  private prismModel: PrismApccModel;

  constructor(
    db: Database.Database,
    config?: Partial<ClassifierConfig>,
    prismModel?: PrismApccModel
  ) {
    this.db = db;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.prismModel = prismModel ?? new DefaultPrismApccModel();
  }

  /**
   * Classify a candidate patch for overfitting risk.
   *
   * @param patch - The candidate patch to classify
   * @param original - The original CST before the patch was applied
   * @returns Classification result with approval/rejection and probability
   */
  async classify(patch: PatchCandidate, original: CstNode): Promise<ClassificationResult> {
    const patchId = patch.id || randomUUID();

    // Step 1: Extract edit states by comparing original CST with patch operations
    const editStates = this.extractEditStates(patch, original);

    // Step 2: Compute 11-property AST difference vector per edit state
    const featureVector = this.computeSemanticFeatureVector(editStates);

    // Step 3: Evaluate via Prism APCC model with timeout
    let overfittingProbability: number;
    try {
      overfittingProbability = await this.evaluateWithTimeout(
        featureVector.combined,
        this.config.model_timeout_ms
      );
    } catch {
      // Model failure: reject as inconclusive, preserve for manual review (Req 14.6)
      this.storePatchClassification(patchId, featureVector, null, 'inconclusive');
      return {
        approved: false,
        overfitting_probability: -1,
        patch_id: patchId,
        inconclusive: true,
      };
    }

    // Step 4: Make classification decision
    if (overfittingProbability > this.config.overfitting_threshold) {
      // Reject: score above threshold — report top 3 contributing properties
      const topProperties = this.getTopContributingProperties(featureVector, 3);
      this.storePatchClassification(patchId, featureVector, overfittingProbability, 'rejected');
      return {
        approved: false,
        overfitting_probability: overfittingProbability,
        top_contributing_properties: topProperties,
        patch_id: patchId,
      };
    }

    // Approve: score at or below threshold
    this.storePatchClassification(patchId, featureVector, overfittingProbability, 'approved');
    return {
      approved: true,
      overfitting_probability: overfittingProbability,
      patch_id: patchId,
    };
  }

  /**
   * Extract edit states (Gen, Del, Remain) by comparing the original CST
   * with the patch's edit operations.
   */
  extractEditStates(patch: PatchCandidate, original: CstNode): EditStateNodes {
    const originalNodes = this.flattenCstNodes(original);

    const gen: CstNode[] = [];
    const del: CstNode[] = [];
    const remain: CstNode[] = [];

    // Classify nodes based on edit operations
    const deletedNodeTypes = new Set<string>();

    for (const op of patch.edit_operations) {
      if (op.type === 'delete') {
        deletedNodeTypes.add(`${op.node_type}:${op.location.file_path}:${op.location.start_line}`);
      } else if (op.type === 'replace') {
        deletedNodeTypes.add(`${op.node_type}:${op.location.file_path}:${op.location.start_line}`);
      }
    }

    // Categorize original nodes into Del or Remain.
    // Edit-operation locations use 1-indexed source lines (start_line), while
    // Tree-sitter CST rows are 0-indexed. Normalize the CST row to a 1-indexed
    // line before comparing; otherwise the keys never match, `del` stays empty
    // for every delete/replace patch, and the classifier under-counts deletions
    // — biasing the overfitting score DOWN and toward APPROVING overfit patches.
    for (const node of originalNodes) {
      const nodeLine = node.start_position.row + 1;
      const nodeKey = `${node.type}:${patch.target_file}:${nodeLine}`;
      if (deletedNodeTypes.has(nodeKey)) {
        del.push(node);
      } else {
        remain.push(node);
      }
    }

    // Generate synthetic Gen nodes from insert operations. Convert the 1-indexed
    // edit-op line back to a 0-indexed CST row so these synthetic nodes carry the
    // same coordinate convention as real CST nodes.
    for (const op of patch.edit_operations) {
      if (op.type === 'insert' || op.type === 'replace') {
        gen.push({
          id: randomUUID(),
          type: op.node_type,
          start_byte: 0,
          end_byte: 0,
          start_position: { row: Math.max(0, op.location.start_line - 1), column: op.location.start_column },
          end_position: { row: Math.max(0, op.location.end_line - 1), column: op.location.end_column },
          children: [],
          is_error: false,
        });
      }
    }

    return { gen, del, remain };
  }

  /**
   * Compute the 66-dimensional semantic feature vector from edit states.
   * The vector is composed as: 11 properties × 3 states × 2 (raw + normalized) = 66
   */
  computeSemanticFeatureVector(editStates: EditStateNodes): SemanticFeatureVector {
    const genVector = this.computeAstDifferenceVector(editStates.gen);
    const delVector = this.computeAstDifferenceVector(editStates.del);
    const remainVector = this.computeAstDifferenceVector(editStates.remain);

    // Compose into 66-dimensional vector: raw values followed by normalized values
    // Layout: [gen_raw(11), del_raw(11), remain_raw(11), gen_norm(11), del_norm(11), remain_norm(11)]
    const rawValues = [
      ...genVector.properties,
      ...delVector.properties,
      ...remainVector.properties,
    ];

    const normalizedValues = this.normalizeVector(rawValues);
    const combined = [...rawValues, ...normalizedValues];

    return {
      gen: genVector,
      del: delVector,
      remain: remainVector,
      combined,
    };
  }

  /**
   * Compute an 11-property AST difference vector for a set of nodes.
   * Each property counts occurrences of specific AST patterns.
   */
  computeAstDifferenceVector(nodes: CstNode[]): AstDifferenceVector {
    const properties = new Array(AST_PROPERTY_COUNT).fill(0);

    for (const node of nodes) {
      // 0: statement_count
      if (this.isStatement(node)) properties[0]++;
      // 1: branch_count
      if (this.isBranch(node)) properties[1]++;
      // 2: loop_count
      if (this.isLoop(node)) properties[2]++;
      // 3: function_call_count
      if (this.isFunctionCall(node)) properties[3]++;
      // 4: variable_declaration_count
      if (this.isVariableDeclaration(node)) properties[4]++;
      // 5: assignment_count
      if (this.isAssignment(node)) properties[5]++;
      // 6: return_count
      if (this.isReturn(node)) properties[6]++;
      // 7: literal_count
      if (this.isLiteral(node)) properties[7]++;
      // 8: operator_count
      if (this.isOperator(node)) properties[8]++;
      // 9: nesting_depth (max across all nodes)
      const depth = this.computeNestingDepth(node);
      if (depth > properties[9]) properties[9] = depth;
      // 10: identifier_count
      if (this.isIdentifier(node)) properties[10]++;
    }

    return { properties };
  }

  /**
   * Get the top N contributing AST properties based on their contribution
   * to the overfitting probability (highest absolute feature values).
   */
  getTopContributingProperties(
    featureVector: SemanticFeatureVector,
    topN: number
  ): AstProperty[] {
    const contributions: { name: string; edit_state: 'gen' | 'del' | 'remain'; contribution: number }[] = [];

    // Calculate contribution score for each property across all states
    for (let i = 0; i < AST_PROPERTY_COUNT; i++) {
      const genValue = featureVector.gen.properties[i] ?? 0;
      const delValue = featureVector.del.properties[i] ?? 0;
      const remainValue = featureVector.remain.properties[i] ?? 0;

      // Determine which edit state contributes most for this property
      const stateValues: { state: 'gen' | 'del' | 'remain'; value: number }[] = [
        { state: 'gen', value: Math.abs(genValue) * 2 },
        { state: 'del', value: Math.abs(delValue) * 2 },
        { state: 'remain', value: Math.abs(remainValue) },
      ];
      stateValues.sort((a, b) => b.value - a.value);
      const topState = stateValues[0];

      // Total contribution score: weighted sum of deviations
      const score = Math.abs(genValue) * 2 + Math.abs(delValue) * 2 + Math.abs(remainValue);

      contributions.push({
        name: AST_PROPERTY_NAMES[i],
        edit_state: topState.state,
        contribution: score,
      });
    }

    // Sort by contribution score descending and return top N
    contributions.sort((a, b) => b.contribution - a.contribution);
    return contributions.slice(0, topN);
  }

  /**
   * Evaluate the feature vector using Prism APCC with a timeout.
   * Throws on timeout (>30s) or model error.
   */
  private async evaluateWithTimeout(
    featureVector: number[],
    timeoutMs: number
  ): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Prism APCC model evaluation timed out'));
      }, timeoutMs);

      try {
        const result = this.prismModel.evaluate(featureVector);

        if (result instanceof Promise) {
          result
            .then((score) => {
              clearTimeout(timer);
              resolve(score);
            })
            .catch((err) => {
              clearTimeout(timer);
              reject(err);
            });
        } else {
          clearTimeout(timer);
          resolve(result);
        }
      } catch (err) {
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  /**
   * Store the classification result (feature vector and probability) in the patches table.
   */
  private storePatchClassification(
    patchId: string,
    featureVector: SemanticFeatureVector,
    probability: number | null,
    status: 'approved' | 'rejected' | 'inconclusive'
  ): void {
    const stmt = this.db.prepare(`
      UPDATE patches
      SET feature_vector = ?,
          overfitting_probability = ?,
          status = ?
      WHERE id = ?
    `);

    stmt.run(
      JSON.stringify(featureVector.combined),
      probability,
      status,
      patchId
    );
  }

  // --- AST node classification helpers ---

  private flattenCstNodes(node: CstNode): CstNode[] {
    const result: CstNode[] = [node];
    for (const child of node.children) {
      result.push(...this.flattenCstNodes(child));
    }
    return result;
  }

  private normalizeVector(values: number[]): number[] {
    const max = Math.max(...values.map(Math.abs), 1);
    return values.map((v) => v / max);
  }

  private isStatement(node: CstNode): boolean {
    return node.type.endsWith('_statement') || node.type === 'expression_statement';
  }

  private isBranch(node: CstNode): boolean {
    return (
      node.type === 'if_statement' ||
      node.type === 'switch_statement' ||
      node.type === 'ternary_expression' ||
      node.type === 'conditional_expression'
    );
  }

  private isLoop(node: CstNode): boolean {
    return (
      node.type === 'for_statement' ||
      node.type === 'for_in_statement' ||
      node.type === 'for_of_statement' ||
      node.type === 'while_statement' ||
      node.type === 'do_statement'
    );
  }

  private isFunctionCall(node: CstNode): boolean {
    return node.type === 'call_expression' || node.type === 'new_expression';
  }

  private isVariableDeclaration(node: CstNode): boolean {
    return (
      node.type === 'variable_declaration' ||
      node.type === 'lexical_declaration' ||
      node.type === 'variable_declarator'
    );
  }

  private isAssignment(node: CstNode): boolean {
    return (
      node.type === 'assignment_expression' ||
      node.type === 'augmented_assignment_expression'
    );
  }

  private isReturn(node: CstNode): boolean {
    return node.type === 'return_statement';
  }

  private isLiteral(node: CstNode): boolean {
    return (
      node.type === 'string' ||
      node.type === 'number' ||
      node.type === 'true' ||
      node.type === 'false' ||
      node.type === 'null' ||
      node.type === 'undefined' ||
      node.type === 'template_string'
    );
  }

  private isOperator(node: CstNode): boolean {
    return (
      node.type === 'binary_expression' ||
      node.type === 'unary_expression' ||
      node.type === 'update_expression'
    );
  }

  private computeNestingDepth(node: CstNode): number {
    if (node.children.length === 0) return 0;
    let maxChildDepth = 0;
    for (const child of node.children) {
      const childDepth = this.computeNestingDepth(child);
      if (childDepth > maxChildDepth) maxChildDepth = childDepth;
    }
    return maxChildDepth + 1;
  }

  private isIdentifier(node: CstNode): boolean {
    return (
      node.type === 'identifier' ||
      node.type === 'property_identifier' ||
      node.type === 'shorthand_property_identifier'
    );
  }
}

/**
 * Interface for the Prism APCC model evaluation.
 * Can be swapped with a real ML model or mock for testing.
 */
export interface PrismApccModel {
  /**
   * Evaluate a 66-dimensional feature vector and produce an
   * overfitting probability score in [0.0, 1.0].
   */
  evaluate(featureVector: number[]): number | Promise<number>;
}

/**
 * Default Prism APCC model implementation.
 * Uses a simple logistic regression approximation over the 66 feature dimensions.
 * In production this would call an external ML service.
 */
export class DefaultPrismApccModel implements PrismApccModel {
  /**
   * Evaluate overfitting probability using a logistic function over
   * weighted feature sums. The weights emphasize Gen/Del states over Remain.
   */
  evaluate(featureVector: number[]): number {
    if (featureVector.length !== FEATURE_VECTOR_DIMENSIONS) {
      throw new Error(
        `Expected ${FEATURE_VECTOR_DIMENSIONS}-dimensional feature vector, got ${featureVector.length}`
      );
    }

    // Compute weighted sum with bias towards Gen and Del features
    let weightedSum = 0;
    for (let i = 0; i < featureVector.length; i++) {
      const stateIndex = Math.floor(i / AST_PROPERTY_COUNT) % EDIT_STATE_COUNT;
      // Gen=0, Del=1 get weight 0.3; Remain=2 gets weight 0.1
      const stateWeight = stateIndex < 2 ? 0.3 : 0.1;
      // Normalized features (second half) get higher weight
      const normalizationWeight = i >= 33 ? 1.5 : 1.0;
      weightedSum += featureVector[i] * stateWeight * normalizationWeight;
    }

    // Apply sigmoid to map to [0.0, 1.0]
    const probability = 1 / (1 + Math.exp(-weightedSum + 3));

    // Clamp to [0.0, 1.0]
    return Math.max(0.0, Math.min(1.0, probability));
  }
}
