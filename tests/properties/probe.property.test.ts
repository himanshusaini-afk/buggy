import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fc from 'fast-check';
import Database from 'better-sqlite3';
import { initializeDatabase } from '../../src/database/graph-db.js';
import { ProbeLoop } from '../../src/agents/probe-loop.js';
import type { GeneratorAgent, ValidatorAgent } from '../../src/agents/probe-loop.js';
import type { CandidateProperty } from '../../src/types/probe.js';

/**
 * Property 12: PROBE Refinement Excludes Counter-Implementations
 *
 * For any candidate property P and counter-implementation C that satisfies P,
 * the refined property P' produced by the Generator Agent shall not admit C
 * (i.e., C shall violate P').
 *
 * **Validates: Requirements 7.3**
 *
 * Strategy:
 * - Model properties as predicates over numeric inputs/outputs (e.g., "output > 5")
 * - Generate counter-implementations as (input, output) pairs that satisfy P
 * - The Generator refines P to exclude C by adding constraints
 * - Verify: the refined property P' rejects the counter-implementation C
 */

// --- Property Predicate Model ---

/**
 * A property predicate modeled as a set of numeric constraints.
 * Each constraint is of the form: "output <op> <threshold>"
 * A counter-implementation must satisfy ALL constraints to "satisfy" the property.
 * Refinement adds a new constraint that explicitly excludes the counter-implementation.
 */
interface NumericConstraint {
  op: '>' | '<' | '>=' | '<=' | '===' | '!==';
  threshold: number;
}

function evaluateConstraint(constraint: NumericConstraint, value: number): boolean {
  switch (constraint.op) {
    case '>': return value > constraint.threshold;
    case '<': return value < constraint.threshold;
    case '>=': return value >= constraint.threshold;
    case '<=': return value <= constraint.threshold;
    case '===': return value === constraint.threshold;
    case '!==': return value !== constraint.threshold;
  }
}

function evaluateAllConstraints(constraints: NumericConstraint[], value: number): boolean {
  return constraints.every(c => evaluateConstraint(c, value));
}

function constraintsToExpression(constraints: NumericConstraint[]): string {
  return constraints.map(c => `output ${c.op} ${c.threshold}`).join(' && ');
}

/**
 * Given a set of constraints and a counter-implementation value that satisfies them,
 * produce a refined constraint set that excludes the counter-implementation.
 * The refinement adds: output !== counterValue
 */
function refineConstraints(constraints: NumericConstraint[], counterValue: number): NumericConstraint[] {
  return [...constraints, { op: '!==', threshold: counterValue }];
}

// --- Arbitraries ---

/**
 * Generate a property (set of constraints) and a counter-implementation value
 * that satisfies all constraints.
 *
 * Strategy: generate a counter-value FIRST, then derive constraints that it satisfies.
 * This avoids slow filter-based search for satisfying values.
 */
const arbPropertyAndCounter: fc.Arbitrary<{ constraints: NumericConstraint[]; counterValue: number }> = fc
  .integer({ min: -100, max: 100 })
  .chain((counterValue) => {
    // Generate constraints that the counterValue is guaranteed to satisfy
    // by deriving thresholds from the counterValue
    const arbSatisfiedConstraint: fc.Arbitrary<NumericConstraint> = fc.oneof(
      // output > threshold where threshold < counterValue
      fc.integer({ min: counterValue - 50, max: counterValue - 1 }).map(t => ({ op: '>' as const, threshold: t })),
      // output < threshold where threshold > counterValue
      fc.integer({ min: counterValue + 1, max: counterValue + 50 }).map(t => ({ op: '<' as const, threshold: t })),
      // output >= threshold where threshold <= counterValue
      fc.integer({ min: counterValue - 50, max: counterValue }).map(t => ({ op: '>=' as const, threshold: t })),
      // output <= threshold where threshold >= counterValue
      fc.integer({ min: counterValue, max: counterValue + 50 }).map(t => ({ op: '<=' as const, threshold: t })),
    );

    return fc.array(arbSatisfiedConstraint, { minLength: 1, maxLength: 4 }).map(constraints => ({
      constraints,
      counterValue,
    }));
  });

// --- Generator and Validator Implementations for Testing ---

/**
 * A deterministic Generator that refines properties by adding a !== constraint
 * to exclude the counter-implementation value.
 */
function createTestGenerator(): GeneratorAgent & { refinedConstraints: NumericConstraint[][] } {
  const state = { refinedConstraints: [] as NumericConstraint[][] };

  return {
    refinedConstraints: state.refinedConstraints,
    async refineProperty(property: CandidateProperty, counterImpl?: string): Promise<CandidateProperty> {
      if (!counterImpl) {
        return property;
      }

      // Parse the counter-implementation value from the string
      const counterValue = parseInt(counterImpl, 10);

      // Parse existing constraints from the property expression
      const existingConstraints = parseConstraints(property.expression);

      // Refine by adding !== constraint
      const refined = refineConstraints(existingConstraints, counterValue);
      state.refinedConstraints.push(refined);

      return {
        id: property.id,
        expression: constraintsToExpression(refined),
        description: `Refined to exclude counter-value ${counterValue}`,
      };
    },
  };
}

function parseConstraints(expression: string): NumericConstraint[] {
  if (!expression || expression === 'true') return [];
  const parts = expression.split(' && ');
  return parts.map((part) => {
    const match = part.match(/output\s+(>|<|>=|<=|===|!==)\s+(-?\d+)/);
    if (!match) return { op: '>' as const, threshold: 0 };
    return {
      op: match[1] as NumericConstraint['op'],
      threshold: parseInt(match[2], 10),
    };
  });
}

/**
 * A Validator that returns counter-implementation values from a pre-determined sequence,
 * then returns null (budget exhausted) when the sequence is depleted.
 */
function createTestValidator(counterValues: number[]): ValidatorAgent {
  let index = 0;
  return {
    async generateCounterImpl(property: CandidateProperty, _budget: number): Promise<string | null> {
      if (index >= counterValues.length) {
        return null; // Budget exhausted
      }
      const value = counterValues[index];
      index++;

      // Only return this value if it satisfies the current property
      const constraints = parseConstraints(property.expression);
      if (evaluateAllConstraints(constraints, value)) {
        return value.toString();
      }
      // If the value doesn't satisfy the current property, budget exhausted
      return null;
    },
  };
}

// --- Property Tests ---

describe('Property 12: PROBE Refinement Excludes Counter-Implementations', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initializeDatabase(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('refined property P\' does not admit counter-implementation C that triggered the refinement', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbPropertyAndCounter,
        fc.integer({ min: 1, max: 10 }), // search budget
        async ({ constraints, counterValue }, searchBudget) => {
          const localDb = initializeDatabase(':memory:');

          try {
            // Initial property expression
            const initialExpression = constraintsToExpression(constraints);
            const initialProperty: CandidateProperty = {
              id: `prop-${Date.now()}-${Math.random().toString(36).slice(2)}`,
              expression: initialExpression,
              description: 'Test property',
            };

            // Precondition: counter-implementation C satisfies P
            expect(evaluateAllConstraints(constraints, counterValue)).toBe(true);

            // Create a validator that returns the counter-value once
            const validator = createTestValidator([counterValue]);
            const generator = createTestGenerator();

            const probeLoop = new ProbeLoop(
              localDb,
              { search_budget: searchBudget, max_refinement_iterations: 5 },
              generator,
              validator
            );

            const result = await probeLoop.run(initialProperty);

            // The loop should have completed (either verified after refinement,
            // or at least one refinement happened)
            expect(result.iterations_completed).toBeGreaterThanOrEqual(1);

            // Verify the core property:
            // The refined property P' should NOT admit C
            if (result.refinement_history.length > 0) {
              const refinedExpression = result.refinement_history[0].refined_property;
              const refinedConstraints = parseConstraints(refinedExpression);

              // PROPERTY: counter-implementation C violates refined property P'
              const cSatisfiesRefined = evaluateAllConstraints(refinedConstraints, counterValue);
              expect(cSatisfiesRefined).toBe(false);
            }
          } finally {
            localDb.close();
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('each successive refinement excludes its corresponding counter-implementation', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Generate initial constraints that admit a wide range of values
        fc.record({
          op: fc.constant('>' as const),
          threshold: fc.integer({ min: -50, max: -10 }),
        }),
        // Generate multiple distinct counter-values that satisfy the initial constraint
        fc.uniqueArray(fc.integer({ min: 0, max: 100 }), { minLength: 2, maxLength: 5 }),
        fc.integer({ min: 5, max: 20 }), // search budget
        async (initialConstraint, counterValues, searchBudget) => {
          // Filter counter-values to only those satisfying the initial constraint
          const validCounters = counterValues.filter(v => evaluateConstraint(initialConstraint, v));
          if (validCounters.length < 2) return; // Skip if not enough valid counters

          const localDb = initializeDatabase(':memory:');

          try {
            const initialProperty: CandidateProperty = {
              id: `prop-multi-${Date.now()}`,
              expression: constraintsToExpression([initialConstraint]),
              description: 'Multi-refinement test',
            };

            const validator = createTestValidator(validCounters);
            const generator = createTestGenerator();

            const probeLoop = new ProbeLoop(
              localDb,
              { search_budget: searchBudget, max_refinement_iterations: validCounters.length + 1 },
              generator,
              validator
            );

            const result = await probeLoop.run(initialProperty);

            // PROPERTY: Each refinement step must exclude the counter-implementation
            // that triggered it
            for (const refinement of result.refinement_history) {
              const counterValue = parseInt(refinement.counter_implementation, 10);
              const refinedConstraints = parseConstraints(refinement.refined_property);

              // The refined property should NOT admit the counter-implementation
              expect(evaluateAllConstraints(refinedConstraints, counterValue)).toBe(false);
            }
          } finally {
            localDb.close();
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('refined property P\' is strictly stronger than original property P (admits fewer values)', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbPropertyAndCounter,
        async ({ constraints, counterValue }) => {
          // The refined constraints include everything in the original PLUS a !== exclusion
          const refinedConstraints = refineConstraints(constraints, counterValue);

          // PROPERTY: Any value that satisfies P' also satisfies P
          // (refinement only adds constraints, never removes them)
          // Test with a sample of values
          for (let testValue = -100; testValue <= 100; testValue += 7) {
            if (evaluateAllConstraints(refinedConstraints, testValue)) {
              // If it satisfies P', it must also satisfy P
              expect(evaluateAllConstraints(constraints, testValue)).toBe(true);
            }
          }

          // PROPERTY: The counter-value satisfies P but NOT P'
          expect(evaluateAllConstraints(constraints, counterValue)).toBe(true);
          expect(evaluateAllConstraints(refinedConstraints, counterValue)).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('PROBE loop records refinement history with correct counter-implementation and updated property', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbPropertyAndCounter,
        async ({ constraints, counterValue }) => {
          const localDb = initializeDatabase(':memory:');

          try {
            const initialExpression = constraintsToExpression(constraints);
            const initialProperty: CandidateProperty = {
              id: `prop-history-${Date.now()}-${Math.random().toString(36).slice(2)}`,
              expression: initialExpression,
            };

            const validator = createTestValidator([counterValue]);
            const generator = createTestGenerator();

            const probeLoop = new ProbeLoop(
              localDb,
              { search_budget: 10, max_refinement_iterations: 5 },
              generator,
              validator
            );

            const result = await probeLoop.run(initialProperty);

            // PROPERTY: refinement history records the counter-implementation
            if (result.refinement_history.length > 0) {
              const firstRefinement = result.refinement_history[0];

              // Counter-implementation is recorded
              expect(firstRefinement.counter_implementation).toBe(counterValue.toString());

              // Previous property is the initial expression
              expect(firstRefinement.previous_property).toBe(initialExpression);

              // Refined property is different from the original
              expect(firstRefinement.refined_property).not.toBe(initialExpression);

              // Refined property contains the exclusion of counter-value
              expect(firstRefinement.refined_property).toContain(`!== ${counterValue}`);
            }

            // PROPERTY: iteration is recorded in the database
            const rows = localDb.prepare(
              'SELECT * FROM probe_iterations WHERE property_id = ?'
            ).all(initialProperty.id) as any[];
            expect(rows.length).toBeGreaterThanOrEqual(1);
          } finally {
            localDb.close();
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('when validator exhausts budget (no counter-impl found), property is accepted as verified', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbPropertyAndCounter,
        fc.integer({ min: 1, max: 20 }), // search budget
        async ({ constraints }, searchBudget) => {
          const localDb = initializeDatabase(':memory:');

          try {
            const initialProperty: CandidateProperty = {
              id: `prop-verified-${Date.now()}-${Math.random().toString(36).slice(2)}`,
              expression: constraintsToExpression(constraints),
            };

            // Validator that immediately returns null (budget exhausted, no counter-impl)
            const validator = createTestValidator([]);
            const generator = createTestGenerator();

            const probeLoop = new ProbeLoop(
              localDb,
              { search_budget: searchBudget, max_refinement_iterations: 10 },
              generator,
              validator
            );

            const result = await probeLoop.run(initialProperty);

            // PROPERTY: status is 'verified' when validator can't find counter-implementation
            expect(result.status).toBe('verified');
            expect(result.refinement_history.length).toBe(0);
            expect(result.property.expression).toBe(constraintsToExpression(constraints));
          } finally {
            localDb.close();
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});
