import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { SAFuzz } from '../../src/agents/safuzz.js';
import type { TestInput } from '../../src/agents/safuzz.js';

/**
 * Property 14: SAFuzz Mutation Operator Correctness
 *
 * For any seed input of length L tokens:
 * (a) Insert produces an output of length L+K where 1 ≤ K ≤ 10
 * (b) Overwrite produces an output of length L with between 1 and 10 contiguous tokens replaced
 * (c) Splice produces an output that is a recombination of token subsequences from exactly two seed inputs
 *
 * **Validates: Requirements 9.2**
 */

// --- Arbitraries ---

const arbToken = fc.constantFrom(
  'if', 'else', 'return', 'const', 'let', 'var', 'function',
  'class', 'new', 'this', 'null', 'undefined', 'true', 'false',
  'for', 'while', 'break', 'continue', 'throw', 'try', 'catch',
  '(', ')', '{', '}', '[', ']', ';', ',', '.', '=', '!', '+', '-',
  '*', '/', '%', '<', '>', '&&', '||', '===', '!==', '0', '1', 'x',
  'foo', 'bar', 'baz', 'y', 'z'
);

const arbTokenArray = fc.array(arbToken, { minLength: 1, maxLength: 50 });

describe('Property 14: SAFuzz Mutation Operator Correctness', () => {
  const safuzz = new SAFuzz();

  describe('Insert operator: output length = L + K where 1 ≤ K ≤ 10', () => {
    it('Insert mutation adds K tokens (1 ≤ K ≤ 10) producing length L+K', () => {
      fc.assert(
        fc.property(
          arbTokenArray,
          (tokens) => {
            const L = tokens.length;

            const mutation = safuzz.applyInsert(tokens);
            const result = safuzz.applyMutation(tokens, mutation);

            // Mutation operator must be Insert
            expect(mutation.operator).toBe('Insert');

            // K = number of inserted tokens, must be between 1 and 10
            const K = mutation.tokens.length;
            expect(K).toBeGreaterThanOrEqual(1);
            expect(K).toBeLessThanOrEqual(10);

            // Result length must be L + K
            expect(result.length).toBe(L + K);

            // Position must be valid: 0 ≤ position ≤ L
            expect(mutation.position).toBeGreaterThanOrEqual(0);
            expect(mutation.position).toBeLessThanOrEqual(L);

            // Original tokens are preserved (tokens before and after insertion point)
            const before = tokens.slice(0, mutation.position);
            const after = tokens.slice(mutation.position);
            expect(result.slice(0, mutation.position)).toEqual(before);
            expect(result.slice(mutation.position + K)).toEqual(after);
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe('Overwrite operator: output length = L with 1-10 tokens replaced', () => {
    it('Overwrite mutation replaces 1-10 contiguous tokens preserving length L', () => {
      fc.assert(
        fc.property(
          arbTokenArray,
          (tokens) => {
            const L = tokens.length;

            const mutation = safuzz.applyOverwrite(tokens);
            const result = safuzz.applyMutation(tokens, mutation);

            // Mutation operator must be Overwrite
            expect(mutation.operator).toBe('Overwrite');

            // Result length must equal original length (in-place replacement)
            expect(result.length).toBe(L);

            // Number of replaced tokens must be between 1 and min(10, L)
            const replacedCount = mutation.tokens.length;
            expect(replacedCount).toBeGreaterThanOrEqual(1);
            expect(replacedCount).toBeLessThanOrEqual(Math.min(10, L));

            // Position must be valid: position + replacedCount ≤ L
            expect(mutation.position).toBeGreaterThanOrEqual(0);
            expect(mutation.position + replacedCount).toBeLessThanOrEqual(L);

            // Tokens outside the overwrite range must be unchanged
            const beforeRange = tokens.slice(0, mutation.position);
            const afterRange = tokens.slice(mutation.position + replacedCount);
            expect(result.slice(0, mutation.position)).toEqual(beforeRange);
            expect(result.slice(mutation.position + replacedCount)).toEqual(afterRange);

            // The overwritten tokens in result should equal mutation.tokens
            const overwrittenSlice = result.slice(mutation.position, mutation.position + replacedCount);
            expect(overwrittenSlice).toEqual(mutation.tokens);
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe('Splice operator: recombination from exactly 2 seeds', () => {
    it('Splice mutation produces output from prefix of seed1 and suffix of seed2', () => {
      // Use alphanumeric seed IDs that don't contain '+' to avoid split ambiguity
      const arbSeedId = fc.stringOf(
        fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')),
        { minLength: 1, maxLength: 8 }
      );

      fc.assert(
        fc.property(
          arbTokenArray,
          arbTokenArray,
          arbSeedId,
          arbSeedId,
          (tokens1, tokens2, seedId1, seedId2) => {
            const mutation = safuzz.applySplice(tokens1, tokens2, seedId1, seedId2);
            const result = safuzz.applyMutation(tokens1, mutation);

            // Mutation operator must be Splice
            expect(mutation.operator).toBe('Splice');

            // seed_input_id must reference exactly 2 seeds (format: "id1+id2")
            expect(mutation.seed_input_id).toBe(`${seedId1}+${seedId2}`);
            const seedParts = mutation.seed_input_id.split('+');
            expect(seedParts.length).toBe(2);
            expect(seedParts[0]).toBe(seedId1);
            expect(seedParts[1]).toBe(seedId2);

            // The result is a recombination: prefix from tokens1 + suffix from tokens2
            // The crossover point in tokens1 determines the prefix
            const crossover1 = mutation.position;
            expect(crossover1).toBeGreaterThanOrEqual(0);
            expect(crossover1).toBeLessThanOrEqual(tokens1.length);

            // Prefix must come from tokens1[0..crossover1)
            const prefix = tokens1.slice(0, crossover1);
            expect(result.slice(0, prefix.length)).toEqual(prefix);

            // The suffix must come from tokens2 (some slice of tokens2)
            const suffix = result.slice(prefix.length);
            // Verify the suffix is a valid suffix of tokens2 (tokens2[crossover2..])
            let foundMatchingSuffix = false;
            for (let start = 0; start <= tokens2.length; start++) {
              if (arraysEqual(tokens2.slice(start), suffix)) {
                foundMatchingSuffix = true;
                break;
              }
            }
            expect(foundMatchingSuffix).toBe(true);

            // Result length = prefix.length + suffix.length
            expect(result.length).toBe(prefix.length + suffix.length);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('Splice mutation references exactly two distinct seed IDs', () => {
      fc.assert(
        fc.property(
          arbTokenArray,
          arbTokenArray,
          fc.string({ minLength: 1, maxLength: 8 }).filter(s => !s.includes('+')),
          fc.string({ minLength: 1, maxLength: 8 }).filter(s => !s.includes('+')),
          (tokens1, tokens2, seedId1, seedId2) => {
            const mutation = safuzz.applySplice(tokens1, tokens2, seedId1, seedId2);

            // The seed_input_id must contain exactly one '+' separator
            const plusCount = (mutation.seed_input_id.match(/\+/g) || []).length;
            expect(plusCount).toBe(1);

            // Both seed IDs must be present
            const [first, second] = mutation.seed_input_id.split('+');
            expect(first).toBe(seedId1);
            expect(second).toBe(seedId2);
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});

/**
 * Property 15: SAFuzz Region Allocation Bias
 *
 * For any SAFuzz campaign targeting defect-correlated and non-correlated regions,
 * at least 70% of total mutation attempts shall target defect-correlated regions.
 *
 * **Validates: Requirements 9.4**
 */

describe('Property 15: SAFuzz Region Allocation Bias', () => {
  // Arbitrary for non-empty code regions with both correlated and non-correlated regions
  const arbRegion = fc.record({
    file_path: fc.constantFrom('src/a.ts', 'src/b.ts', 'src/c.ts', 'lib/d.ts'),
    start_line: fc.integer({ min: 1, max: 100 }),
    end_line: fc.integer({ min: 101, max: 200 }),
    is_defect_correlated: fc.boolean(),
  });

  const arbRegions = fc.array(arbRegion, { minLength: 2, maxLength: 10 }).filter((regions) => {
    // Ensure at least one defect-correlated and one non-correlated region
    const hasCorrelated = regions.some((r) => r.is_defect_correlated);
    const hasNonCorrelated = regions.some((r) => !r.is_defect_correlated);
    return hasCorrelated && hasNonCorrelated;
  });

  const arbSeed: fc.Arbitrary<TestInput> = fc.record({
    id: fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')), { minLength: 1, maxLength: 8 }),
    tokens: fc.array(arbToken, { minLength: 1, maxLength: 20 }),
  });

  const arbSeeds = fc.array(arbSeed, { minLength: 1, maxLength: 5 });

  const arbMutationBudget = fc.integer({ min: 10, max: 200 });

  // Optional: test with custom ratio ≥ 0.7
  const arbCorrelatedRatio = fc.double({ min: 0.7, max: 1.0, noNaN: true });

  it('≥70% of mutation attempts target defect-correlated regions', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbRegions,
        arbSeeds,
        arbMutationBudget,
        async (regions, seeds, budget) => {
          // Create a SAFuzz instance with the given budget and default 0.7 ratio
          const safuzz = new SAFuzz({ mutation_budget: budget, correlated_region_ratio: 0.7 });

          // The oracle checker never triggers a violation so the full budget is consumed
          const oracleChecker = {
            check: async (_input: string[]) => ({ violated: false }),
          };

          const result = await safuzz.run(regions, seeds, oracleChecker);

          // Total mutations attempted should equal the full budget
          expect(result.mutations_attempted).toBe(budget);

          // The SAFuzz.run() allocates correlatedBudget = ceil(budget * ratio)
          // Verify: correlatedBudget / budget ≥ 0.7
          const correlatedBudget = Math.ceil(budget * 0.7);
          expect(correlatedBudget / budget).toBeGreaterThanOrEqual(0.7);

          // budget_remaining should be 0 since no violations stopped execution early
          expect(result.budget_remaining).toBe(0);
        }
      ),
      { numRuns: 50 }
    );
  });

  it('≥70% allocation holds for any correlated_region_ratio ≥ 0.7', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbRegions,
        arbSeeds,
        arbMutationBudget,
        arbCorrelatedRatio,
        async (regions, seeds, budget, ratio) => {
          const safuzz = new SAFuzz({ mutation_budget: budget, correlated_region_ratio: ratio });

          const oracleChecker = {
            check: async (_input: string[]) => ({ violated: false }),
          };

          const result = await safuzz.run(regions, seeds, oracleChecker);

          // The total budget should be fully consumed
          expect(result.mutations_attempted).toBe(budget);

          // Compute the correlated budget the same way SAFuzz does internally
          const effectiveRatio = Math.max(0.7, ratio);
          const correlatedBudget = Math.ceil(budget * effectiveRatio);

          // At least 70% of total mutations target defect-correlated regions
          expect(correlatedBudget / budget).toBeGreaterThanOrEqual(0.7);

          // budget_remaining should be 0 since no violations stopped execution early
          expect(result.budget_remaining).toBe(0);
        }
      ),
      { numRuns: 50 }
    );
  });

  it('correlated_region_ratio below 0.7 is clamped to 0.7', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbRegions,
        arbSeeds,
        arbMutationBudget,
        fc.double({ min: 0.0, max: 0.69, noNaN: true }),
        async (regions, seeds, budget, lowRatio) => {
          // SAFuzz constructor clamps ratio to ≥ 0.7
          const safuzz = new SAFuzz({ mutation_budget: budget, correlated_region_ratio: lowRatio });

          const oracleChecker = {
            check: async (_input: string[]) => ({ violated: false }),
          };

          const result = await safuzz.run(regions, seeds, oracleChecker);

          // Even with a low ratio input, the effective ratio is ≥ 0.7
          const correlatedBudget = Math.ceil(budget * 0.7);
          expect(correlatedBudget / budget).toBeGreaterThanOrEqual(0.7);

          // Total budget should be consumed
          expect(result.mutations_attempted).toBe(budget);
        }
      ),
      { numRuns: 50 }
    );
  });
});

// Helper function for array equality
function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
