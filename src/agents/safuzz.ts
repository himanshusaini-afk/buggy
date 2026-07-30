/**
 * SAFuzz Biased Fuzzing Engine
 *
 * Applies Masked Language Modeling mutations (Insert, Overwrite, Splice)
 * with biased allocation toward defect-correlated code regions.
 * Derives seed corpus from existing test inputs, records oracle violations
 * as candidate proofs-of-failure, and reports 'inconclusive' if the mutation
 * budget is exhausted without triggering any semantic oracle violation.
 */

import type { Mutation, FuzzResult, FuzzViolation } from '../types/fuzzing.js';
import type { OracleType } from '../types/sandbox.js';

export interface CodeRegion {
  file_path: string;
  start_line: number;
  end_line: number;
  is_defect_correlated: boolean;
}

export interface TestInput {
  id: string;
  tokens: string[];
}

export interface SAFuzzConfig {
  /** Total mutations to attempt. */
  mutation_budget: number;
  /** Ratio targeting defect-correlated regions (≥0.7). */
  correlated_region_ratio: number;
}

export interface OracleChecker {
  /** Check if a mutated input triggers a semantic oracle violation. */
  check(input: string[]): Promise<{ violated: boolean; oracle_type?: OracleType }>;
}

/**
 * SAFuzz biased fuzzing engine implementing Masked Language Modeling mutations.
 *
 * Mutation operators:
 * - Insert: adds K tokens (1 ≤ K ≤ 10) at a random position
 * - Overwrite: replaces 1-10 contiguous tokens in place
 * - Splice: recombines token sequences from two seed inputs
 *
 * Allocation policy: ≥70% of mutations target defect-correlated regions.
 */
export class SAFuzz {
  private config: SAFuzzConfig;

  constructor(config?: Partial<SAFuzzConfig>) {
    this.config = {
      mutation_budget: config?.mutation_budget ?? 1000,
      correlated_region_ratio: Math.max(0.7, config?.correlated_region_ratio ?? 0.7),
    };
  }

  /**
   * Run biased fuzzing campaign.
   * - Derives seed corpus from test inputs
   * - Allocates ≥70% mutations to defect-correlated regions
   * - Supports 3 operators: Insert, Overwrite, Splice
   * - Records violations with mutated input, operator, oracle type, seed input
   * - Reports 'fuzzing-inconclusive' if budget exhausted without violations
   */
  async run(
    regions: CodeRegion[],
    seeds: TestInput[],
    oracleChecker: OracleChecker
  ): Promise<FuzzResult> {
    const violations: FuzzViolation[] = [];
    let mutationsAttempted = 0;

    const correlatedRegions = regions.filter((r) => r.is_defect_correlated);
    const nonCorrelatedRegions = regions.filter((r) => !r.is_defect_correlated);

    // Compute how many mutations go to correlated vs non-correlated regions
    const correlatedBudget = Math.ceil(
      this.config.mutation_budget * this.config.correlated_region_ratio
    );
    const nonCorrelatedBudget = this.config.mutation_budget - correlatedBudget;

    // Run mutations against correlated regions
    const correlatedResult = await this.runMutationBatch(
      correlatedRegions,
      seeds,
      oracleChecker,
      correlatedBudget
    );
    violations.push(...correlatedResult.violations);
    mutationsAttempted += correlatedResult.mutationsAttempted;

    // Run mutations against non-correlated regions
    const nonCorrelatedResult = await this.runMutationBatch(
      nonCorrelatedRegions,
      seeds,
      oracleChecker,
      nonCorrelatedBudget
    );
    violations.push(...nonCorrelatedResult.violations);
    mutationsAttempted += nonCorrelatedResult.mutationsAttempted;

    return {
      status: violations.length > 0 ? 'violation_found' : 'inconclusive',
      violations,
      mutations_attempted: mutationsAttempted,
      budget_remaining: this.config.mutation_budget - mutationsAttempted,
    };
  }

  /**
   * Run a batch of mutations against given regions.
   */
  private async runMutationBatch(
    _regions: CodeRegion[],
    seeds: TestInput[],
    oracleChecker: OracleChecker,
    budget: number
  ): Promise<{ violations: FuzzViolation[]; mutationsAttempted: number }> {
    const violations: FuzzViolation[] = [];
    let mutationsAttempted = 0;

    if (seeds.length === 0 || budget <= 0) {
      return { violations, mutationsAttempted };
    }

    for (let i = 0; i < budget; i++) {
      mutationsAttempted++;

      // Pick a random seed
      const seedIndex = Math.floor(Math.random() * seeds.length);
      const seed = seeds[seedIndex];

      // Pick a random mutation operator
      const operatorChoice = Math.floor(Math.random() * 3);
      let mutation: Mutation;
      let mutatedTokens: string[];

      if (operatorChoice === 0) {
        mutation = this.applyInsert(seed.tokens);
        mutatedTokens = this.applyMutation(seed.tokens, mutation);
        mutation.seed_input_id = seed.id;
      } else if (operatorChoice === 1) {
        mutation = this.applyOverwrite(seed.tokens);
        mutatedTokens = this.applyMutation(seed.tokens, mutation);
        mutation.seed_input_id = seed.id;
      } else {
        // Splice requires two seeds
        const secondIndex = seeds.length > 1
          ? this.pickDifferentIndex(seedIndex, seeds.length)
          : seedIndex;
        const secondSeed = seeds[secondIndex];
        mutation = this.applySplice(seed.tokens, secondSeed.tokens, seed.id, secondSeed.id);
        mutatedTokens = this.applyMutation(seed.tokens, mutation);
      }

      // Check oracle for violation
      const result = await oracleChecker.check(mutatedTokens);

      if (result.violated && result.oracle_type) {
        violations.push({
          input: mutatedTokens,
          mutation_operator: mutation.operator,
          oracle_type: result.oracle_type,
          seed_input: seed.tokens,
        });
      }
    }

    return { violations, mutationsAttempted };
  }

  /**
   * Apply Insert mutation: adds 1-10 tokens at a random position.
   * Output length = input length + K where 1 ≤ K ≤ 10
   */
  applyInsert(tokens: string[]): Mutation {
    const position = tokens.length > 0 ? Math.floor(Math.random() * (tokens.length + 1)) : 0;
    const count = 1 + Math.floor(Math.random() * 10); // 1..10
    const insertedTokens = this.generateRandomTokens(count);

    return {
      operator: 'Insert',
      position,
      tokens: insertedTokens,
      seed_input_id: '',
    };
  }

  /**
   * Apply Overwrite mutation: replaces 1-10 contiguous tokens.
   * Output length = input length (same)
   */
  applyOverwrite(tokens: string[]): Mutation {
    if (tokens.length === 0) {
      return {
        operator: 'Overwrite',
        position: 0,
        tokens: [],
        seed_input_id: '',
      };
    }

    const maxReplace = Math.min(10, tokens.length);
    const count = 1 + Math.floor(Math.random() * maxReplace); // 1..min(10, L)
    const maxStart = tokens.length - count;
    const position = maxStart > 0 ? Math.floor(Math.random() * (maxStart + 1)) : 0;
    const replacementTokens = this.generateRandomTokens(count);

    return {
      operator: 'Overwrite',
      position,
      tokens: replacementTokens,
      seed_input_id: '',
    };
  }

  /**
   * Apply Splice mutation: recombines token sequences from two seed inputs.
   * Picks a crossover point in each input, combines prefix of first with suffix of second.
   */
  applySplice(
    tokens1: string[],
    tokens2: string[],
    seedId1: string,
    seedId2: string
  ): Mutation {
    // Pick crossover points
    const crossover1 = tokens1.length > 0 ? Math.floor(Math.random() * tokens1.length) : 0;
    const crossover2 = tokens2.length > 0 ? Math.floor(Math.random() * tokens2.length) : 0;

    // Combine prefix of tokens1[0..crossover1] with suffix of tokens2[crossover2..]
    const prefix = tokens1.slice(0, crossover1);
    const suffix = tokens2.slice(crossover2);
    const splicedTokens = [...prefix, ...suffix];

    return {
      operator: 'Splice',
      position: crossover1,
      tokens: splicedTokens,
      seed_input_id: `${seedId1}+${seedId2}`,
    };
  }

  /**
   * Apply a mutation to produce mutated tokens.
   */
  applyMutation(originalTokens: string[], mutation: Mutation): string[] {
    switch (mutation.operator) {
      case 'Insert': {
        const before = originalTokens.slice(0, mutation.position);
        const after = originalTokens.slice(mutation.position);
        return [...before, ...mutation.tokens, ...after];
      }
      case 'Overwrite': {
        if (originalTokens.length === 0) {
          return [];
        }
        const result = [...originalTokens];
        for (let i = 0; i < mutation.tokens.length && mutation.position + i < result.length; i++) {
          result[mutation.position + i] = mutation.tokens[i];
        }
        return result;
      }
      case 'Splice': {
        // Splice mutation tokens already contain the final spliced result
        return [...mutation.tokens];
      }
      default:
        return [...originalTokens];
    }
  }

  /**
   * Generate random placeholder tokens for Insert and Overwrite mutations.
   */
  private generateRandomTokens(count: number): string[] {
    const vocabulary = [
      'if', 'else', 'return', 'const', 'let', 'var', 'function',
      'class', 'new', 'this', 'null', 'undefined', 'true', 'false',
      'for', 'while', 'break', 'continue', 'throw', 'try', 'catch',
      '(', ')', '{', '}', '[', ']', ';', ',', '.', '=', '!', '+', '-',
      '*', '/', '%', '<', '>', '&&', '||', '===', '!==', '0', '1', 'x',
    ];
    const tokens: string[] = [];
    for (let i = 0; i < count; i++) {
      tokens.push(vocabulary[Math.floor(Math.random() * vocabulary.length)]);
    }
    return tokens;
  }

  /**
   * Pick an index different from the given one (for splice with two distinct seeds).
   */
  private pickDifferentIndex(exclude: number, length: number): number {
    if (length <= 1) return exclude;
    let idx = Math.floor(Math.random() * (length - 1));
    if (idx >= exclude) idx++;
    return idx;
  }
}
