import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { RepairAgent, CONTEXT_WINDOW_RADIUS, MIN_PATCHES_PER_DEFECT } from '../../src/agents/repair-agent.js';
import { McpRouter } from '../../src/middleware/mcp-router.js';
import type { ProofOfFailureCertificate } from '../../src/types/proof.js';
import type { DefectContext, PatchCandidate } from '../../src/types/repair.js';
import type { McpToolResult } from '../../src/types/mcp.js';

/**
 * Property 21: Patch Context Window Targeting
 *
 * For any confirmed defect at line L in file F, all generated candidate patches
 * shall target code exclusively within the range [L-10, L+10] of file F.
 *
 * **Validates: Requirements 12.1**
 */

// --- Helpers ---

/**
 * Create a mock MCP router that provides read_range, extract_method, and write_fix
 * tools returning plausible code content for any requested range.
 */
function createMockRouter(): McpRouter {
  const router = new McpRouter();

  router.registerTool({
    name: 'read_range',
    description: 'Read a range of lines from a source file',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        start_line: { type: 'integer' },
        end_line: { type: 'integer' },
      },
      required: ['file_path', 'start_line', 'end_line'],
    },
    handler: async (params: unknown): Promise<McpToolResult> => {
      const { start_line, end_line } = params as { start_line: number; end_line: number };
      const lines: string[] = [];
      for (let i = start_line; i <= end_line; i++) {
        // Produce realistic-looking code lines so strategies can generate patches
        if (i % 3 === 0) {
          lines.push(`  const result = value * factor + ${i};`);
        } else if (i % 3 === 1) {
          lines.push(`  if (input > ${i}) { return input - ${i}; }`);
        } else {
          lines.push(`  const temp = getValue(${i});`);
        }
      }
      return { success: true, data: { lines } };
    },
  });

  router.registerTool({
    name: 'extract_method',
    description: 'Extract a specific method body',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        method_name: { type: 'string' },
      },
      required: ['file_path', 'method_name'],
    },
    handler: async (_params: unknown): Promise<McpToolResult> => {
      return {
        success: true,
        data: {
          content: 'function compute(value: number, input: number): number {\n  const factor = getFactor(input);\n  const result = value * factor;\n  return result;\n}',
        },
      };
    },
  });

  router.registerTool({
    name: 'write_fix',
    description: 'Write a code fix to a source file',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        start_line: { type: 'integer' },
        end_line: { type: 'integer' },
        new_content: { type: 'string' },
      },
      required: ['file_path', 'start_line', 'end_line', 'new_content'],
    },
    handler: async (_params: unknown): Promise<McpToolResult> => {
      return { success: true, data: { written: true } };
    },
  });

  return router;
}

// --- Arbitraries ---

/**
 * Generate a defect line number. We use a range that exercises:
 * - Low line numbers (near 1, where clamping to line 1 applies)
 * - Medium line numbers (typical case)
 * - High line numbers (large files)
 */
const arbDefectLine = fc.integer({ min: 1, max: 5000 });

/**
 * Generate a file path from a variety of realistic paths.
 */
const arbFilePath = fc.constantFrom(
  '/project/src/compute.ts',
  '/project/src/utils/helpers.ts',
  '/project/src/lib/transform.ts',
  '/project/src/services/api.ts',
  '/project/src/index.ts',
  '/project/src/deep/nested/module.ts',
);

/**
 * Generate a proof-of-failure certificate with arbitrary test inputs.
 */
const arbProof: fc.Arbitrary<ProofOfFailureCertificate> = fc.record({
  test_input: fc.oneof(
    fc.integer(),
    fc.record({ value: fc.integer(), input: fc.string({ minLength: 1, maxLength: 10 }) }),
  ),
  observed_output: fc.oneof(fc.integer(), fc.constant(null), fc.string({ minLength: 0, maxLength: 10 })),
  violated_postcondition: fc.constantFrom('result >= 0', 'output !== null', 'length > 0', 'isValid(result)'),
  admissibility_verified_at: fc.constant('2024-01-01T00:00:00Z'),
  soundness_verified_at: fc.constant('2024-01-01T00:00:01Z'),
  uniqueness_verified_at: fc.constant('2024-01-01T00:00:02Z'),
});

/**
 * Generate a DefectContext with a given defect line and file path.
 * The context_window is pre-computed to match what the agent would generate.
 */
function arbDefectContext(defectLine: number, filePath: string): fc.Arbitrary<DefectContext> {
  return fc.record({
    variable_states: fc.array(
      fc.record({
        name: fc.constantFrom('x', 'y', 'result', 'value', 'factor', 'input'),
        value: fc.oneof(fc.integer({ min: -100, max: 100 }), fc.constant(null)) as fc.Arbitrary<unknown>,
        type: fc.constantFrom('number', 'string', 'boolean', 'object'),
      }),
      { minLength: 1, maxLength: 4 },
    ),
    specification: fc.record({
      name: fc.constantFrom('compute', 'transform', 'validate', 'process'),
      preconditions: fc.array(fc.constantFrom('x >= 0', 'input !== null', 'value > 0'), { minLength: 0, maxLength: 2 }),
      postconditions: fc.array(fc.constantFrom('result >= 0', 'output !== null', 'isValid(result)'), { minLength: 1, maxLength: 2 }),
      parameters: fc.constant([{ name: 'value', type: 'number' }]),
      return_type: fc.constantFrom('number', 'string', 'boolean'),
    }),
  }).map(({ variable_states, specification }) => ({
    defect_line: defectLine,
    file_path: filePath,
    context_window: {
      start_line: Math.max(1, defectLine - CONTEXT_WINDOW_RADIUS),
      end_line: defectLine + CONTEXT_WINDOW_RADIUS,
    },
    variable_states,
    specification,
  }));
}

// --- Tests ---

describe('Property 21: Patch Context Window Targeting', () => {
  it('all generated patches target code exclusively within [L-10, L+10] of the defect file', async () => {
    const router = createMockRouter();
    const agent = new RepairAgent(router);

    await fc.assert(
      fc.asyncProperty(
        arbDefectLine,
        arbFilePath,
        arbProof,
        async (defectLine, filePath, proof) => {
          const contextArb = arbDefectContext(defectLine, filePath);
          const context = fc.sample(contextArb, 1)[0];

          const patches = await agent.generatePatches(proof, context);

          // The valid window is [max(1, L-10), L+10]
          const windowStart = Math.max(1, defectLine - CONTEXT_WINDOW_RADIUS);
          const windowEnd = defectLine + CONTEXT_WINDOW_RADIUS;

          // PROPERTY: Every generated patch must target code exclusively within [L-10, L+10]
          for (const patch of patches) {
            // 1. The patch target_range must be within the context window
            expect(patch.target_range.start_line).toBeGreaterThanOrEqual(windowStart);
            expect(patch.target_range.end_line).toBeLessThanOrEqual(windowEnd);

            // 2. The patch must target the correct file
            expect(patch.target_file).toBe(filePath);

            // 3. All edit operations must target lines within the context window
            for (const op of patch.edit_operations) {
              expect(op.location.start_line).toBeGreaterThanOrEqual(windowStart);
              expect(op.location.start_line).toBeLessThanOrEqual(windowEnd);
              expect(op.location.end_line).toBeGreaterThanOrEqual(windowStart);
              expect(op.location.end_line).toBeLessThanOrEqual(windowEnd);
              expect(op.location.file_path).toBe(filePath);
            }
          }
        },
      ),
      { numRuns: 50 },
    );
  });

  it('patches at low line numbers (near line 1) still respect the clamped window [1, L+10]', async () => {
    const router = createMockRouter();
    const agent = new RepairAgent(router);

    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 10 }), // Low line numbers where clamping occurs
        arbFilePath,
        arbProof,
        async (defectLine, filePath, proof) => {
          const contextArb = arbDefectContext(defectLine, filePath);
          const context = fc.sample(contextArb, 1)[0];

          const patches = await agent.generatePatches(proof, context);

          // When defect is near line 1, window start clamps to 1
          const windowStart = Math.max(1, defectLine - CONTEXT_WINDOW_RADIUS);
          const windowEnd = defectLine + CONTEXT_WINDOW_RADIUS;

          expect(windowStart).toBeGreaterThanOrEqual(1);

          for (const patch of patches) {
            expect(patch.target_range.start_line).toBeGreaterThanOrEqual(1);
            expect(patch.target_range.start_line).toBeGreaterThanOrEqual(windowStart);
            expect(patch.target_range.end_line).toBeLessThanOrEqual(windowEnd);
            expect(patch.target_file).toBe(filePath);
          }
        },
      ),
      { numRuns: 30 },
    );
  });

  it('no patch edit operation targets a line outside the ±10 radius', async () => {
    const router = createMockRouter();
    const agent = new RepairAgent(router);

    await fc.assert(
      fc.asyncProperty(
        arbDefectLine,
        arbFilePath,
        arbProof,
        async (defectLine, filePath, proof) => {
          const contextArb = arbDefectContext(defectLine, filePath);
          const context = fc.sample(contextArb, 1)[0];

          const patches = await agent.generatePatches(proof, context);

          const windowStart = Math.max(1, defectLine - CONTEXT_WINDOW_RADIUS);
          const windowEnd = defectLine + CONTEXT_WINDOW_RADIUS;

          // PROPERTY: No edit operation should reference a line outside the window
          for (const patch of patches) {
            for (const op of patch.edit_operations) {
              // Start line must be within bounds
              const startInBounds = op.location.start_line >= windowStart && op.location.start_line <= windowEnd;
              expect(startInBounds).toBe(true);

              // End line must be within bounds
              const endInBounds = op.location.end_line >= windowStart && op.location.end_line <= windowEnd;
              expect(endInBounds).toBe(true);
            }
          }
        },
      ),
      { numRuns: 50 },
    );
  });
});


/**
 * Property 22: Patch Structural Diversity
 *
 * For any confirmed defect, the Repair_Agent shall produce at least 3 candidate
 * patches where no two patches modify the same AST node type at the same location
 * (structurally distinct edits).
 *
 * **Validates: Requirements 12.3**
 */
describe('Property 22: Patch Structural Diversity', () => {
  /**
   * Helper to check structural distinctness: no two patches share the same
   * AST node type at the same location.
   *
   * Two patches "modify the same AST node type at the same location" if their
   * primary edit operation has both the same node_type AND the same start_line
   * in the same file.
   */
  function allPatchesStructurallyDistinct(patches: PatchCandidate[]): boolean {
    const seen = new Set<string>();
    for (const patch of patches) {
      for (const op of patch.edit_operations) {
        // A signature representing the (node_type, file, start_line) tuple
        const key = `${op.node_type}@${op.location.file_path}:${op.location.start_line}`;
        if (seen.has(key)) {
          return false;
        }
        seen.add(key);
      }
    }
    return true;
  }

  it('generates ≥3 patches per defect with no two modifying the same AST node type at the same location', async () => {
    const router = createMockRouter();
    const agent = new RepairAgent(router);

    await fc.assert(
      fc.asyncProperty(
        arbDefectLine,
        arbFilePath,
        arbProof,
        async (defectLine, filePath, proof) => {
          const contextArb = arbDefectContext(defectLine, filePath);
          const context = fc.sample(contextArb, 1)[0];

          const patches = await agent.generatePatches(proof, context);

          // PROPERTY 1: At least 3 patches produced
          expect(patches.length).toBeGreaterThanOrEqual(MIN_PATCHES_PER_DEFECT);

          // PROPERTY 2: No two patches modify the same AST node type at the same location
          expect(allPatchesStructurallyDistinct(patches)).toBe(true);
        },
      ),
      { numRuns: 50 },
    );
  });

  it('each patch has a unique combination of node_type and location among all generated patches', async () => {
    const router = createMockRouter();
    const agent = new RepairAgent(router);

    await fc.assert(
      fc.asyncProperty(
        arbDefectLine,
        arbFilePath,
        arbProof,
        async (defectLine, filePath, proof) => {
          const contextArb = arbDefectContext(defectLine, filePath);
          const context = fc.sample(contextArb, 1)[0];

          const patches = await agent.generatePatches(proof, context);

          // Collect all (node_type, location) tuples across all patches
          const signatures: string[] = [];
          for (const patch of patches) {
            for (const op of patch.edit_operations) {
              const sig = `${op.node_type}@${op.location.file_path}:${op.location.start_line}`;
              signatures.push(sig);
            }
          }

          // No duplicate signatures
          const uniqueSignatures = new Set(signatures);
          expect(uniqueSignatures.size).toBe(signatures.length);
        },
      ),
      { numRuns: 50 },
    );
  });

  it('patches use diverse AST node types (not all the same type)', async () => {
    const router = createMockRouter();
    const agent = new RepairAgent(router);

    await fc.assert(
      fc.asyncProperty(
        arbDefectLine,
        arbFilePath,
        arbProof,
        async (defectLine, filePath, proof) => {
          const contextArb = arbDefectContext(defectLine, filePath);
          const context = fc.sample(contextArb, 1)[0];

          const patches = await agent.generatePatches(proof, context);

          // Collect all distinct node types used across patches
          const nodeTypes = new Set<string>();
          for (const patch of patches) {
            for (const op of patch.edit_operations) {
              nodeTypes.add(op.node_type);
            }
          }

          // With ≥3 structurally distinct patches, we expect diversity in node types
          // The agent uses different strategies targeting different AST node types
          // At minimum we should see more than 1 type (strategies use: if_statement,
          // binary_expression, return_statement, assignment_expression, expression_statement)
          expect(nodeTypes.size).toBeGreaterThanOrEqual(2);
        },
      ),
      { numRuns: 50 },
    );
  });
});
