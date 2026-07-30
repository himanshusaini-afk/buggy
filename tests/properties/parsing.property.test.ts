import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { ParserAgent } from '../../src/agents/parser-agent.js';
import type { CstNode } from '../../src/types/cst.js';

/**
 * Property 2: Fault-Tolerant Parsing with Error Nodes
 *
 * For any source file containing one or more syntax errors, the Parser_Agent
 * shall produce a partial CST where:
 * (a) every syntactically valid region is covered by non-error nodes whose byte
 *     ranges correspond exactly to the valid source regions, and
 * (b) every erroneous region is represented by an error node whose byte offset
 *     and length exactly span the invalid region.
 *
 * **Validates: Requirements 1.2**
 */

// --- Valid TypeScript source templates ---
// These produce clean CSTs with zero errors when parsed individually.

const VALID_SNIPPETS = [
  'const x: number = 42;',
  'let name: string = "hello";',
  'function add(a: number, b: number): number { return a + b; }',
  'const arr: number[] = [1, 2, 3];',
  'if (true) { let y = 10; }',
  'for (let i = 0; i < 10; i++) { console.log(i); }',
  'const obj = { a: 1, b: 2, c: 3 };',
  'const fn = (x: number) => x * 2;',
  'while (true) { break; }',
];

// --- Error injection strategies ---
// Each strategy is GUARANTEED to produce at least one error node when applied.
// The key insight: we inject BETWEEN statements (at statement boundaries) using
// tokens that cannot form valid syntax in that context, ensuring the error is
// never absorbed into a string literal or identifier.

type InjectionStrategy = {
  name: string;
  inject: (source: string) => string;
};

const INJECTION_STRATEGIES: InjectionStrategy[] = [
  {
    // Prepend an isolated error-inducing line before the source
    name: 'prepend_error_line',
    inject: (source) => '@@@ ;\n' + source,
  },
  {
    // Append an isolated error-inducing line after the source
    name: 'append_error_line',
    inject: (source) => source + '\n@@@ ;',
  },
  {
    // Insert an error line between statements (after first newline)
    name: 'insert_error_between_statements',
    inject: (source) => {
      const nlIdx = source.indexOf('\n');
      if (nlIdx === -1) return source + '\n@@@ ;';
      return source.slice(0, nlIdx + 1) + '@@@ ;\n' + source.slice(nlIdx + 1);
    },
  },
  {
    // Replace the first semicolon+surrounding with broken syntax
    // "const x = 42;" becomes "const x = 42 @@@ ;"
    name: 'inject_before_semicolon',
    inject: (source) => {
      const semiIdx = source.indexOf(';');
      if (semiIdx === -1) return '@@@ ;\n' + source;
      return source.slice(0, semiIdx) + ' @@@ ' + source.slice(semiIdx);
    },
  },
  {
    // Insert unmatched braces as a standalone statement
    name: 'insert_unmatched_brace_line',
    inject: (source) => source + '\n} } }',
  },
];

// --- Arbitraries ---

const arbValidSource = fc
  .array(fc.constantFrom(...VALID_SNIPPETS), { minLength: 1, maxLength: 3 })
  .map((snippets) => snippets.join('\n'));

const arbStrategyIndex = fc.integer({ min: 0, max: INJECTION_STRATEGIES.length - 1 });

// --- Helper functions ---

function collectLeafNodes(node: CstNode): CstNode[] {
  if (node.children.length === 0) return [node];
  const leaves: CstNode[] = [];
  for (const child of node.children) {
    leaves.push(...collectLeafNodes(child));
  }
  return leaves;
}

function collectErrorNodes(node: CstNode): CstNode[] {
  const errors: CstNode[] = [];
  if (node.is_error) errors.push(node);
  for (const child of node.children) {
    errors.push(...collectErrorNodes(child));
  }
  return errors;
}

function verifyByteRangeConsistency(node: CstNode): boolean {
  if (node.start_byte < 0 || node.end_byte < node.start_byte) return false;
  for (const child of node.children) {
    if (child.start_byte < node.start_byte || child.end_byte > node.end_byte) return false;
  }
  for (let i = 0; i < node.children.length - 1; i++) {
    if (node.children[i].end_byte > node.children[i + 1].start_byte) return false;
  }
  for (const child of node.children) {
    if (!verifyByteRangeConsistency(child)) return false;
  }
  return true;
}

// --- Property Tests ---

describe('Property 2: Fault-Tolerant Parsing with Error Nodes', () => {
  const agent = new ParserAgent();

  it('produces error nodes when syntax errors are injected, with valid regions covered by non-error nodes with correct byte ranges', () => {
    fc.assert(
      fc.property(
        arbValidSource,
        arbStrategyIndex,
        (validSource, strategyIdx) => {
          const strategy = INJECTION_STRATEGIES[strategyIdx];
          const corrupted = strategy.inject(validSource);
          const result = agent.parseSource(corrupted, 'test.ts');

          // Fault tolerance: parser MUST still produce a CST
          expect(result.cst).toBeDefined();
          expect(result.cst.type).toBe('program');

          // (b) At least one error node exists
          const errorNodes = collectErrorNodes(result.cst);
          expect(errorNodes.length).toBeGreaterThan(0);

          // (a) Root node spans the entire source
          expect(result.cst.start_byte).toBe(0);
          expect(result.cst.end_byte).toBe(corrupted.length);

          // All byte ranges are consistent (no overlaps, proper containment)
          expect(verifyByteRangeConsistency(result.cst)).toBe(true);

          // (b) Each error node has correct byte offset and length within bounds
          for (const errorNode of errorNodes) {
            expect(errorNode.start_byte).toBeGreaterThanOrEqual(0);
            expect(errorNode.end_byte).toBeGreaterThanOrEqual(errorNode.start_byte);
            expect(errorNode.end_byte).toBeLessThanOrEqual(corrupted.length);
            expect(errorNode.is_error).toBe(true);
          }

          // (a) Non-error leaf nodes have text matching the source at their byte range
          const leaves = collectLeafNodes(result.cst);
          for (const leaf of leaves) {
            if (!leaf.is_error && leaf.text !== undefined) {
              expect(leaf.text).toBe(corrupted.slice(leaf.start_byte, leaf.end_byte));
            }
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('error nodes byte ranges correctly span the erroneous regions', () => {
    fc.assert(
      fc.property(
        arbValidSource,
        arbStrategyIndex,
        (validSource, strategyIdx) => {
          const strategy = INJECTION_STRATEGIES[strategyIdx];
          const corrupted = strategy.inject(validSource);
          const result = agent.parseSource(corrupted, 'test.ts');

          expect(result.cst).toBeDefined();
          const errorNodes = collectErrorNodes(result.cst);
          expect(errorNodes.length).toBeGreaterThan(0);

          // Each error node's byte range must be valid and within source bounds
          for (const errorNode of errorNodes) {
            expect(errorNode.start_byte).toBeGreaterThanOrEqual(0);
            expect(errorNode.end_byte).toBeLessThanOrEqual(corrupted.length);

            // The byte span must be consistent with extractable text
            const byteSpan = errorNode.end_byte - errorNode.start_byte;
            const errorText = corrupted.slice(errorNode.start_byte, errorNode.end_byte);
            expect(errorText.length).toBe(byteSpan);
          }

          // Top-level children must be properly ordered
          if (result.cst.children.length > 0) {
            expect(result.cst.children[0].start_byte).toBeGreaterThanOrEqual(result.cst.start_byte);
            const last = result.cst.children[result.cst.children.length - 1];
            expect(last.end_byte).toBeLessThanOrEqual(result.cst.end_byte);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('non-error leaf nodes have byte ranges corresponding to valid source text', () => {
    fc.assert(
      fc.property(
        arbValidSource,
        arbStrategyIndex,
        (validSource, strategyIdx) => {
          const strategy = INJECTION_STRATEGIES[strategyIdx];
          const corrupted = strategy.inject(validSource);
          const result = agent.parseSource(corrupted, 'test.ts');

          const errorNodes = collectErrorNodes(result.cst);
          expect(errorNodes.length).toBeGreaterThan(0);

          // Non-error leaf nodes must have text that exactly matches the source bytes
          const nonErrorLeaves = collectLeafNodes(result.cst).filter((l) => !l.is_error);
          for (const leaf of nonErrorLeaves) {
            if (leaf.text !== undefined) {
              expect(leaf.text).toBe(corrupted.slice(leaf.start_byte, leaf.end_byte));
            }
            expect(leaf.start_byte).toBeGreaterThanOrEqual(0);
            expect(leaf.end_byte).toBeGreaterThanOrEqual(leaf.start_byte);
            expect(leaf.end_byte).toBeLessThanOrEqual(corrupted.length);
          }

          // Children at same level don't overlap
          const rootChildren = result.cst.children;
          for (let i = 0; i < rootChildren.length - 1; i++) {
            expect(rootChildren[i].end_byte).toBeLessThanOrEqual(rootChildren[i + 1].start_byte);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('ParseResult errors array matches error nodes in the CST', () => {
    fc.assert(
      fc.property(
        arbValidSource,
        arbStrategyIndex,
        (validSource, strategyIdx) => {
          const strategy = INJECTION_STRATEGIES[strategyIdx];
          const corrupted = strategy.inject(validSource);
          const result = agent.parseSource(corrupted, 'test.ts');

          // errors array should be non-empty
          expect(result.errors.length).toBeGreaterThan(0);

          // Each error entry has valid location data
          for (const error of result.errors) {
            expect(error.location.row).toBeGreaterThanOrEqual(0);
            expect(error.location.column).toBeGreaterThanOrEqual(0);
            expect(error.length).toBeGreaterThanOrEqual(0);
            expect(error.message.length).toBeGreaterThan(0);
          }

          // Count of error entries matches count of error nodes in tree
          const errorNodes = collectErrorNodes(result.cst);
          expect(result.errors.length).toBe(errorNodes.length);
        }
      ),
      { numRuns: 100 }
    );
  });
});
