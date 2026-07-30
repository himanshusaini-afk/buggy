/**
 * PROBE Adversarial Loop - Generator vs. Validator refinement.
 *
 * Implements the PROBE (Property Refinement via Opposition-Based Exploration)
 * adversarial loop that pairs a Generator Agent (drafts/refines candidate
 * properties) with a Validator Agent (generates counter-implementations).
 *
 * The loop iterates until:
 * - The Validator exhausts its search budget → property accepted as verified
 * - Max refinement iterations reached → property marked inconclusive
 *
 * Each iteration is recorded in the `probe_iterations` table.
 *
 * Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6
 */

import type Database from 'better-sqlite3';
import type { CandidateProperty, ProbeResult, ProbeRefinement } from '../types/probe.js';

export interface ProbeConfig {
  /** Maximum counter-implementations to evaluate per validator invocation. */
  search_budget: number;
  /** Maximum number of refinement loop iterations before declaring inconclusive. */
  max_refinement_iterations: number;
}

export interface GeneratorAgent {
  /** Draft or refine a candidate property to exclude a counter-implementation. */
  refineProperty(property: CandidateProperty, counterImpl?: string): Promise<CandidateProperty>;
}

export interface ValidatorAgent {
  /** Attempt to generate a counter-implementation that satisfies property but differs from reference. */
  generateCounterImpl(property: CandidateProperty, budget: number): Promise<string | null>;
}

/**
 * Runs the PROBE adversarial refinement loop.
 *
 * The Generator drafts/refines properties while the Validator attempts to
 * generate counter-implementations that satisfy the property but produce
 * different outputs from the reference implementation.
 */
export class ProbeLoop {
  private db: Database.Database;
  private config: ProbeConfig;
  private generator: GeneratorAgent;
  private validator: ValidatorAgent;

  constructor(
    db: Database.Database,
    config: ProbeConfig,
    generator: GeneratorAgent,
    validator: ValidatorAgent
  ) {
    this.db = db;
    this.config = config;
    this.generator = generator;
    this.validator = validator;
  }

  /**
   * Run the PROBE adversarial refinement loop.
   *
   * - Generator drafts/refines properties
   * - Validator generates counter-implementations
   * - Loop until: validator exhausts budget (→ verified) or max iterations reached (→ inconclusive)
   * - Records each refinement iteration in probe_iterations table
   */
  async run(initialProperty: CandidateProperty): Promise<ProbeResult> {
    const refinementHistory: ProbeRefinement[] = [];
    let currentProperty = initialProperty;
    let lastCounterImpl: string | undefined;

    for (let iteration = 1; iteration <= this.config.max_refinement_iterations; iteration++) {
      // Validator attempts to generate a counter-implementation within search budget
      const counterImpl = await this.validator.generateCounterImpl(
        currentProperty,
        this.config.search_budget
      );

      if (counterImpl === null) {
        // Validator failed to find a counter-implementation (budget exhausted) → verified
        this.recordIteration(
          currentProperty.id,
          iteration,
          currentProperty.expression,
          null,
          'verified'
        );

        return {
          status: 'verified',
          property: currentProperty,
          iterations_completed: iteration,
          refinement_history: refinementHistory,
        };
      }

      // Validator succeeded: Generator refines property to exclude the counter-implementation
      lastCounterImpl = counterImpl;
      const previousExpression = currentProperty.expression;

      currentProperty = await this.generator.refineProperty(currentProperty, counterImpl);

      // Record the refinement
      const refinement: ProbeRefinement = {
        iteration,
        previous_property: previousExpression,
        counter_implementation: counterImpl,
        refined_property: currentProperty.expression,
      };
      refinementHistory.push(refinement);

      // Store iteration in the database
      this.recordIteration(
        currentProperty.id,
        iteration,
        currentProperty.expression,
        counterImpl,
        'refined'
      );
    }

    // Max iterations reached without budget exhaustion → inconclusive
    this.recordIteration(
      currentProperty.id,
      this.config.max_refinement_iterations,
      currentProperty.expression,
      lastCounterImpl ?? null,
      'inconclusive'
    );

    return {
      status: 'inconclusive',
      property: currentProperty,
      iterations_completed: this.config.max_refinement_iterations,
      refinement_history: refinementHistory,
      last_counter_implementation: lastCounterImpl,
    };
  }

  /**
   * Records a single iteration to the probe_iterations table.
   */
  private recordIteration(
    propertyId: string,
    iterationNumber: number,
    candidateProperty: string,
    counterImplementation: string | null,
    status: 'refined' | 'verified' | 'inconclusive'
  ): void {
    const id = `probe_${propertyId}_iter_${iterationNumber}_${Date.now()}`;

    const stmt = this.db.prepare(`
      INSERT INTO probe_iterations (id, property_id, iteration_number, candidate_property, counter_implementation, status)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    stmt.run(id, propertyId, iterationNumber, candidateProperty, counterImplementation, status);
  }
}
