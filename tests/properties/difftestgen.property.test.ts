import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  DiffTestGen,
  type BehavioralDifference,
  type DifferenceSeverity,
} from '../../src/agents/difftestgen.js';

/**
 * Property 13: Behavioral Difference Severity Prioritization
 *
 * For any set of detected behavioral differences containing both
 * specification-violating and unspecified-behavior differences, the reported
 * results shall order all specification-violating differences before
 * unspecified-behavior differences.
 *
 * **Validates: Requirements 8.3**
 */

// --- Arbitraries ---

const arbSeverity: fc.Arbitrary<DifferenceSeverity> = fc.constantFrom(
  'specification-violating' as const,
  'unspecified-behavior' as const
);

const arbMethodName = fc.constantFrom(
  'add',
  'subtract',
  'multiply',
  'divide',
  'transform',
  'validate',
  'process',
  'compute'
);

const arbTriggeringInput = fc.oneof(
  fc.integer(),
  fc.string(),
  fc.array(fc.integer(), { minLength: 0, maxLength: 5 }),
  fc.record({ x: fc.integer(), y: fc.integer() })
);

const arbSourceLocation = fc.record({
  file_path: fc.constantFrom('/src/a.ts', '/src/b.ts', '/src/c.ts'),
  start_line: fc.integer({ min: 1, max: 200 }),
  start_column: fc.nat({ max: 80 }),
  end_line: fc.integer({ min: 1, max: 200 }),
  end_column: fc.nat({ max: 80 }),
});

function arbBehavioralDifference(index: number): fc.Arbitrary<BehavioralDifference> {
  return fc
    .record({
      method_name: arbMethodName,
      triggering_input: arbTriggeringInput,
      severity: arbSeverity,
      output_a: fc.oneof(fc.integer(), fc.string(), fc.constant(null)),
      output_b: fc.oneof(fc.integer(), fc.string(), fc.constant(null)),
      loc_a: arbSourceLocation,
      loc_b: arbSourceLocation,
    })
    .map((data) => ({
      id: `diff-${index}-${Date.now()}`,
      method_name: data.method_name,
      triggering_input: data.triggering_input,
      outputs: { 'impl-a': data.output_a, 'impl-b': data.output_b },
      code_locations: { 'impl-a': data.loc_a, 'impl-b': data.loc_b },
      severity: data.severity,
      ...(data.severity === 'specification-violating'
        ? { violated_assertion_id: `assertion-${index}` }
        : {}),
    }));
}

/**
 * Generate an array of behavioral differences with mixed severities,
 * ensuring at least one of each type is present.
 */
const arbMixedDifferences: fc.Arbitrary<BehavioralDifference[]> = fc
  .integer({ min: 2, max: 30 })
  .chain((size) =>
    fc.array(
      fc.integer({ min: 0, max: 1000 }).chain((idx) => arbBehavioralDifference(idx)),
      { minLength: size, maxLength: size }
    )
  )
  .filter((diffs) => {
    // Ensure we have at least one of each severity type
    const hasSpecViolating = diffs.some(
      (d) => d.severity === 'specification-violating'
    );
    const hasUnspecified = diffs.some(
      (d) => d.severity === 'unspecified-behavior'
    );
    return hasSpecViolating && hasUnspecified;
  });

describe('Property 13: Behavioral Difference Severity Prioritization', () => {
  const engine = new DiffTestGen();

  it('all specification-violating differences appear before unspecified-behavior differences in prioritized results', () => {
    fc.assert(
      fc.property(arbMixedDifferences, (differences) => {
        const prioritized = engine.prioritizeDifferences(differences);

        // Find the index of the last specification-violating difference
        let lastSpecViolatingIdx = -1;
        // Find the index of the first unspecified-behavior difference
        let firstUnspecifiedIdx = prioritized.length;

        for (let i = 0; i < prioritized.length; i++) {
          if (prioritized[i].severity === 'specification-violating') {
            lastSpecViolatingIdx = i;
          }
          if (
            prioritized[i].severity === 'unspecified-behavior' &&
            i < firstUnspecifiedIdx
          ) {
            firstUnspecifiedIdx = i;
          }
        }

        // PROPERTY: All specification-violating must appear before any unspecified-behavior
        expect(lastSpecViolatingIdx).toBeLessThan(firstUnspecifiedIdx);
      }),
      { numRuns: 100 }
    );
  });

  it('prioritized results preserve all original differences (no loss or duplication)', () => {
    fc.assert(
      fc.property(arbMixedDifferences, (differences) => {
        const prioritized = engine.prioritizeDifferences(differences);

        // Same count
        expect(prioritized.length).toBe(differences.length);

        // Same set of IDs (no loss, no duplication)
        const originalIds = differences.map((d) => d.id).sort();
        const prioritizedIds = prioritized.map((d) => d.id).sort();
        expect(prioritizedIds).toEqual(originalIds);
      }),
      { numRuns: 100 }
    );
  });

  it('specification-violating count in output matches input count', () => {
    fc.assert(
      fc.property(arbMixedDifferences, (differences) => {
        const prioritized = engine.prioritizeDifferences(differences);

        const inputSpecCount = differences.filter(
          (d) => d.severity === 'specification-violating'
        ).length;
        const outputSpecCount = prioritized.filter(
          (d) => d.severity === 'specification-violating'
        ).length;

        expect(outputSpecCount).toBe(inputSpecCount);
      }),
      { numRuns: 100 }
    );
  });

  it('prioritization forms a valid partition: first N are spec-violating, rest are unspecified', () => {
    fc.assert(
      fc.property(arbMixedDifferences, (differences) => {
        const prioritized = engine.prioritizeDifferences(differences);

        const specViolatingCount = differences.filter(
          (d) => d.severity === 'specification-violating'
        ).length;

        // First specViolatingCount items must all be 'specification-violating'
        for (let i = 0; i < specViolatingCount; i++) {
          expect(prioritized[i].severity).toBe('specification-violating');
        }

        // Remaining items must all be 'unspecified-behavior'
        for (let i = specViolatingCount; i < prioritized.length; i++) {
          expect(prioritized[i].severity).toBe('unspecified-behavior');
        }
      }),
      { numRuns: 100 }
    );
  });

  it('handles arrays with only specification-violating differences (no unspecified)', () => {
    const arbAllSpecViolating: fc.Arbitrary<BehavioralDifference[]> = fc
      .integer({ min: 1, max: 20 })
      .chain((size) =>
        fc.array(
          fc.integer({ min: 0, max: 1000 }).chain((idx) =>
            arbBehavioralDifference(idx).map((d) => ({
              ...d,
              severity: 'specification-violating' as const,
            }))
          ),
          { minLength: size, maxLength: size }
        )
      );

    fc.assert(
      fc.property(arbAllSpecViolating, (differences) => {
        const prioritized = engine.prioritizeDifferences(differences);

        expect(prioritized.length).toBe(differences.length);
        for (const diff of prioritized) {
          expect(diff.severity).toBe('specification-violating');
        }
      }),
      { numRuns: 100 }
    );
  });

  it('handles arrays with only unspecified-behavior differences (no spec-violating)', () => {
    const arbAllUnspecified: fc.Arbitrary<BehavioralDifference[]> = fc
      .integer({ min: 1, max: 20 })
      .chain((size) =>
        fc.array(
          fc.integer({ min: 0, max: 1000 }).chain((idx) =>
            arbBehavioralDifference(idx).map((d) => ({
              ...d,
              severity: 'unspecified-behavior' as const,
            }))
          ),
          { minLength: size, maxLength: size }
        )
      );

    fc.assert(
      fc.property(arbAllUnspecified, (differences) => {
        const prioritized = engine.prioritizeDifferences(differences);

        expect(prioritized.length).toBe(differences.length);
        for (const diff of prioritized) {
          expect(diff.severity).toBe('unspecified-behavior');
        }
      }),
      { numRuns: 100 }
    );
  });
});
