/**
 * Demo: Proof-Carrying Debugger vs. a Buggy Shopping Cart
 *
 * This integration test demonstrates the full pipeline running against
 * intentionally buggy e-commerce code. It exercises:
 *
 * 1. Parsing the buggy cart.ts via the real ParserAgent (tree-sitter)
 * 2. Running investigations via the AgentOrchestrator with realistic mock agents
 * 3. Producing proof-of-failure certificates for each bug
 * 4. Generating and classifying repair patches
 * 5. Printing a detailed human-readable report
 *
 * The mock agents simulate the full pipeline behavior: proving bugs,
 * generating patches, and classifying them for overfitting.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';

import { ParserAgent } from '../../src/agents/parser-agent.js';
import { AgentOrchestrator } from '../../src/orchestrator/orchestrator.js';
import type {
  OrchestratorParserAgent,
  OrchestratorBugProvingAgent,
  OrchestratorRepairAgent,
  OrchestratorClassifierAgent,
  OrchestratorSandboxAgent,
  OrchestratorDeps,
  BugProvingResult,
} from '../../src/orchestrator/orchestrator.js';
import type { InvestigationTarget, InvestigationReport } from '../../src/types/orchestrator.js';
import type { ParseResult, CstNode } from '../../src/types/cst.js';
import type { ProofOfFailureCertificate } from '../../src/types/proof.js';
import type { PatchCandidate } from '../../src/types/repair.js';
import type { ClassificationResult } from '../../src/types/classifier.js';
import type { ExecutionRequest, ExecutionResult } from '../../src/types/sandbox.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const FIXTURE_ROOT = resolve(import.meta.dirname, 'fixtures', 'demo-buggy-app');
const CART_FILE = resolve(FIXTURE_ROOT, 'src', 'cart.ts');

// ─── Bug-Specific Proofs ─────────────────────────────────────────────────────

/**
 * Bug 1: calculateSubtotal produces negative results when price < 2 and quantity > 10
 */
function createSubtotalProof(): ProofOfFailureCertificate {
  return {
    test_input: {
      items: [{ id: 'item-1', name: 'Sticker', price: 0.5, quantity: 15 }],
    },
    observed_output: -22.5, // (0.5 - 2) * 15 = -22.5
    violated_postcondition: 'result >= 0',
    admissibility_verified_at: new Date().toISOString(),
    soundness_verified_at: new Date().toISOString(),
    uniqueness_verified_at: new Date().toISOString(),
  };
}

/**
 * Bug 2: calculateAveragePrice returns NaN for empty cart (0 / 0)
 */
function createAveragePriceProof(): ProofOfFailureCertificate {
  return {
    test_input: { items: [] },
    observed_output: NaN,
    violated_postcondition: '!isNaN(result) && isFinite(result)',
    admissibility_verified_at: new Date().toISOString(),
    soundness_verified_at: new Date().toISOString(),
    uniqueness_verified_at: new Date().toISOString(),
  };
}

/**
 * Bug 4: applyDiscount with discountPercent > 100 produces negative total
 */
function createDiscountProof(): ProofOfFailureCertificate {
  return {
    test_input: { subtotal: 100, discountPercent: 150 },
    observed_output: -50, // 100 - (100 * 150 / 100) = -50
    violated_postcondition: 'result >= 0',
    admissibility_verified_at: new Date().toISOString(),
    soundness_verified_at: new Date().toISOString(),
    uniqueness_verified_at: new Date().toISOString(),
  };
}

/**
 * Bug 5: calculateLoyaltyPoints is non-deterministic
 */
function createLoyaltyPointsProof(): ProofOfFailureCertificate {
  return {
    test_input: { total: 100 },
    observed_output: '10 OR 20 (non-deterministic)',
    violated_postcondition: 'result === calculateLoyaltyPoints(total) [determinism]',
    admissibility_verified_at: new Date().toISOString(),
    soundness_verified_at: new Date().toISOString(),
    uniqueness_verified_at: new Date().toISOString(),
  };
}

// ─── Patch Generators ────────────────────────────────────────────────────────

function createSubtotalPatches(): PatchCandidate[] {
  return [
    {
      id: 'patch-subtotal-guard',
      diff: `- subtotal += (item.price - 2) * item.quantity;\n+ const discountedPrice = Math.max(0, item.price - 2);\n+ subtotal += discountedPrice * item.quantity;`,
      edit_operations: [
        {
          type: 'replace',
          node_type: 'expression_statement',
          location: { file_path: 'src/cart.ts', start_line: 38, start_column: 6, end_line: 38, end_column: 52 },
        },
      ],
      target_file: 'src/cart.ts',
      target_range: { start_line: 33, end_line: 44 },
      refinement_attempt: 0,
    },
    {
      id: 'patch-subtotal-skip-discount',
      diff: `- if (item.quantity > 10) {\n-   subtotal += (item.price - 2) * item.quantity;\n- } else {\n+ if (item.quantity > 10 && item.price > 2) {\n+   subtotal += (item.price - 2) * item.quantity;\n+ } else {`,
      edit_operations: [
        {
          type: 'replace',
          node_type: 'if_statement',
          location: { file_path: 'src/cart.ts', start_line: 36, start_column: 4, end_line: 41, end_column: 5 },
        },
      ],
      target_file: 'src/cart.ts',
      target_range: { start_line: 33, end_line: 44 },
      refinement_attempt: 0,
    },
  ];
}

function createAveragePricePatches(): PatchCandidate[] {
  return [
    {
      id: 'patch-avg-guard',
      diff: `- return total / items.length;\n+ if (items.length === 0) return 0;\n+ return total / items.length;`,
      edit_operations: [
        {
          type: 'insert',
          node_type: 'if_statement',
          location: { file_path: 'src/cart.ts', start_line: 52, start_column: 2, end_line: 52, end_column: 2 },
        },
      ],
      target_file: 'src/cart.ts',
      target_range: { start_line: 50, end_line: 53 },
      refinement_attempt: 0,
    },
  ];
}

function createDiscountPatches(): PatchCandidate[] {
  return [
    {
      id: 'patch-discount-clamp',
      diff: `- return subtotal - (subtotal * discountPercent / 100);\n+ const clamped = Math.min(Math.max(discountPercent, 0), 100);\n+ return subtotal - (subtotal * clamped / 100);`,
      edit_operations: [
        {
          type: 'replace',
          node_type: 'return_statement',
          location: { file_path: 'src/cart.ts', start_line: 67, start_column: 2, end_line: 67, end_column: 53 },
        },
      ],
      target_file: 'src/cart.ts',
      target_range: { start_line: 64, end_line: 68 },
      refinement_attempt: 0,
    },
    {
      id: 'patch-discount-floor-zero',
      diff: `- return subtotal - (subtotal * discountPercent / 100);\n+ return Math.max(0, subtotal - (subtotal * discountPercent / 100));`,
      edit_operations: [
        {
          type: 'replace',
          node_type: 'return_statement',
          location: { file_path: 'src/cart.ts', start_line: 67, start_column: 2, end_line: 67, end_column: 53 },
        },
      ],
      target_file: 'src/cart.ts',
      target_range: { start_line: 64, end_line: 68 },
      refinement_attempt: 0,
    },
  ];
}

function createLoyaltyPointsPatches(): PatchCandidate[] {
  return [
    {
      id: 'patch-loyalty-deterministic',
      diff: `- const bonus = Math.random() > 0.5 ? 10 : 0;\n- return Math.floor(total / 10) + bonus;\n+ return Math.floor(total / 10);`,
      edit_operations: [
        {
          type: 'delete',
          node_type: 'variable_declaration',
          location: { file_path: 'src/cart.ts', start_line: 74, start_column: 2, end_line: 74, end_column: 47 },
        },
        {
          type: 'replace',
          node_type: 'return_statement',
          location: { file_path: 'src/cart.ts', start_line: 75, start_column: 2, end_line: 75, end_column: 41 },
        },
      ],
      target_file: 'src/cart.ts',
      target_range: { start_line: 71, end_line: 76 },
      refinement_attempt: 0,
    },
  ];
}

// ─── Test Suite ──────────────────────────────────────────────────────────────

describe('Demo: Proof-Carrying Debugger vs. Buggy Shopping Cart', () => {
  let parserAgent: ParserAgent;
  let parsedCartCst: CstNode;

  // ─── Setup: Parse the real file with tree-sitter ───────────────────────────

  beforeAll(async () => {
    parserAgent = new ParserAgent();

    // Actually parse the buggy cart.ts with tree-sitter
    const parseResult = await parserAgent.parseFile(CART_FILE);
    parsedCartCst = parseResult.cst;

    // Print header
    console.log('');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('  Proof-Carrying Debugger — Demo Report');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('');
    console.log(`  Project:       ${FIXTURE_ROOT}`);
    console.log(`  Target:        src/cart.ts`);
    console.log(`  Parse time:    ${parseResult.duration_ms.toFixed(2)}ms`);
    console.log(`  CST root type: ${parseResult.cst.type}`);
    console.log(`  Syntax errors: ${parseResult.errors.length}`);
    console.log('');
  });

  afterAll(async () => {
    await parserAgent.shutdownLsp();
  });

  // ─── Helper: Build an orchestrator with mock agents for a specific bug ─────

  function buildOrchestrator(
    proof: ProofOfFailureCertificate,
    patches: PatchCandidate[],
    approvedPatchIds: string[],
  ): AgentOrchestrator {
    const mockParserAgent: OrchestratorParserAgent = {
      parseFile: async (filePath: string): Promise<ParseResult> => ({
        cst: parsedCartCst,
        errors: [],
        duration_ms: 0.5,
        file_path: filePath,
      }),
      resolveSymbols: async () => ({
        resolutions: [],
        total_symbols: 0,
        resolved_count: 0,
        unresolved_count: 0,
      }),
      buildCallGraph: async () => ({
        nodes: [],
        edges: [],
        entry_points: [],
      }),
    };

    const mockBugProvingAgent: OrchestratorBugProvingAgent = {
      investigate: async (): Promise<BugProvingResult> => ({
        certified: true,
        proof,
        intermediate: {
          specifications_refined: 1,
          probe_iterations: 8,
          fuzz_mutations: 200,
        },
      }),
    };

    const mockRepairAgent: OrchestratorRepairAgent = {
      generatePatches: async () => patches,
    };

    const mockClassifierAgent: OrchestratorClassifierAgent = {
      classify: async (patch: PatchCandidate): Promise<ClassificationResult> => {
        if (approvedPatchIds.includes(patch.id)) {
          return {
            approved: true,
            overfitting_probability: 0.08,
            patch_id: patch.id,
          };
        }
        return {
          approved: false,
          overfitting_probability: 0.72,
          top_contributing_properties: [
            { name: 'node_depth_change', edit_state: 'gen', contribution: 0.35 },
            { name: 'token_count_delta', edit_state: 'del', contribution: 0.22 },
            { name: 'scope_boundary_cross', edit_state: 'remain', contribution: 0.15 },
          ],
          patch_id: patch.id,
        };
      },
    };

    const mockSandboxAgent: OrchestratorSandboxAgent = {
      execute: async (): Promise<ExecutionResult> => ({
        status: 'completed',
        output: { passed: true },
        oracle_violations: [],
        duration_ms: 150,
        resource_usage: {
          cpu_time_ms: 80,
          memory_peak_mb: 48,
          disk_io_mb: 1,
        },
      }),
      isAvailable: async () => true,
    };

    return new AgentOrchestrator({
      parserAgent: mockParserAgent,
      bugProvingAgent: mockBugProvingAgent,
      repairAgent: mockRepairAgent,
      classifierAgent: mockClassifierAgent,
      sandboxAgent: mockSandboxAgent,
    });
  }

  // ─── Helper: Print report for a single investigation ───────────────────────

  function printInvestigationReport(functionName: string, report: InvestigationReport) {
    console.log(`  Investigation ID: ${report.id}`);
    console.log(`  Status:           ${report.status}`);

    if (report.proof) {
      console.log('');
      console.log('  ┌─ Proof-of-Failure Certificate ─────────────────────────');
      console.log(`  │ Violated:    ${report.proof.violated_postcondition}`);
      console.log(`  │ Input:       ${JSON.stringify(report.proof.test_input)}`);
      console.log(`  │ Output:      ${JSON.stringify(report.proof.observed_output)}`);
      console.log(`  │ Admissible:  ✓ (${report.proof.admissibility_verified_at})`);
      console.log(`  │ Sound:       ✓ (${report.proof.soundness_verified_at})`);
      console.log(`  │ Unique:      ✓ (${report.proof.uniqueness_verified_at})`);
      console.log('  └────────────────────────────────────────────────────────');
    }

    if (report.approved_patches.length > 0) {
      console.log('');
      console.log(`  Approved Patches (${report.approved_patches.length}):`);
      for (const { patch, classification } of report.approved_patches) {
        console.log(`    ✓ ${patch.id} — overfitting: ${(classification.overfitting_probability * 100).toFixed(1)}%`);
        console.log(`      Edit: ${patch.edit_operations[0]?.type} ${patch.edit_operations[0]?.node_type}`);
        console.log(`      Diff: ${patch.diff.split('\n')[0]}`);
      }
    }

    if (report.rejected_patches.length > 0) {
      console.log('');
      console.log(`  Rejected Patches (${report.rejected_patches.length}):`);
      for (const { patch, classification } of report.rejected_patches) {
        console.log(`    ✗ ${patch.id} — overfitting: ${(classification.overfitting_probability * 100).toFixed(1)}%`);
      }
    }

    if (report.timeline.length > 0) {
      console.log('');
      console.log('  Timeline:');
      for (const phase of report.timeline) {
        console.log(`    ${phase.phase.padEnd(16)} ${phase.agent}`);
      }
    }

    console.log('');
  }

  // ─── Test 1: Parse buggy cart.ts with tree-sitter ──────────────────────────

  it('should parse cart.ts without syntax errors', async () => {
    const result = await parserAgent.parseFile(CART_FILE);

    expect(result.errors).toHaveLength(0);
    expect(result.cst.type).toBe('program');
    expect(result.cst.children.length).toBeGreaterThan(0);
    expect(result.duration_ms).toBeLessThan(5000);

    console.log('');
    console.log('─── STEP 1: Parse & Analyze ────────────────────────────────');
    console.log(`  File:                src/cart.ts`);
    console.log(`  Parse time:          ${result.duration_ms.toFixed(2)}ms`);
    console.log(`  CST root type:       ${result.cst.type}`);
    console.log(`  Top-level children:  ${result.cst.children.length}`);
    console.log(`  Syntax errors:       ${result.errors.length}`);
    console.log('');
  });

  // ─── Test 2: Investigate calculateSubtotal (Bug 1) ─────────────────────────

  it('should prove Bug 1: calculateSubtotal produces negative subtotal', async () => {
    console.log('─── STEP 2: Investigate calculateSubtotal ──────────────────');
    console.log('  Specification:');
    console.log('    Pre:  items.length > 0, items.every(i => i.price >= 0)');
    console.log('    Post: result >= 0');
    console.log('');

    const orchestrator = buildOrchestrator(
      createSubtotalProof(),
      createSubtotalPatches(),
      ['patch-subtotal-skip-discount'], // The better fix
    );

    const target: InvestigationTarget = {
      function_id: 'calculateSubtotal',
      file_path: CART_FILE,
      specification: {
        name: 'calculateSubtotal',
        preconditions: ['items.length > 0', 'items.every(i => i.price >= 0)'],
        postconditions: ['result >= 0'],
        parameters: [{ name: 'items', type: 'CartItem[]' }],
        return_type: 'number',
      },
    };

    const report = await orchestrator.startInvestigation(target);
    printInvestigationReport('calculateSubtotal', report);

    expect(report.proof).toBeDefined();
    expect(report.proof!.violated_postcondition).toBe('result >= 0');
    expect(report.proof!.observed_output).toBe(-22.5);
    expect(report.approved_patches.length).toBeGreaterThanOrEqual(1);
    expect(report.status).toBe('confirmed_and_repaired');
  });

  // ─── Test 3: Investigate calculateAveragePrice (Bug 2) ─────────────────────

  it('should prove Bug 2: calculateAveragePrice returns NaN for empty array', async () => {
    console.log('─── STEP 3: Investigate calculateAveragePrice ──────────────');
    console.log('  Specification:');
    console.log('    Pre:  items.length >= 0');
    console.log('    Post: !isNaN(result) && isFinite(result)');
    console.log('');

    const orchestrator = buildOrchestrator(
      createAveragePriceProof(),
      createAveragePricePatches(),
      ['patch-avg-guard'], // The guard clause fix
    );

    const target: InvestigationTarget = {
      function_id: 'calculateAveragePrice',
      file_path: CART_FILE,
      specification: {
        name: 'calculateAveragePrice',
        preconditions: ['items.length >= 0'],
        postconditions: ['!isNaN(result)', 'isFinite(result)'],
        parameters: [{ name: 'items', type: 'CartItem[]' }],
        return_type: 'number',
      },
    };

    const report = await orchestrator.startInvestigation(target);
    printInvestigationReport('calculateAveragePrice', report);

    expect(report.proof).toBeDefined();
    expect(report.proof!.violated_postcondition).toBe('!isNaN(result) && isFinite(result)');
    expect(report.approved_patches.length).toBe(1);
    expect(report.approved_patches[0].patch.id).toBe('patch-avg-guard');
    expect(report.status).toBe('confirmed_and_repaired');
  });

  // ─── Test 4: Investigate applyDiscount (Bug 4) ─────────────────────────────

  it('should prove Bug 4: applyDiscount allows negative totals', async () => {
    console.log('─── STEP 4: Investigate applyDiscount ──────────────────────');
    console.log('  Specification:');
    console.log('    Pre:  subtotal >= 0, 0 <= discountPercent <= 100');
    console.log('    Post: result >= 0, result <= subtotal');
    console.log('');

    const orchestrator = buildOrchestrator(
      createDiscountProof(),
      createDiscountPatches(),
      ['patch-discount-clamp'], // Clamping is the correct fix
    );

    const target: InvestigationTarget = {
      function_id: 'applyDiscount',
      file_path: CART_FILE,
      specification: {
        name: 'applyDiscount',
        preconditions: ['subtotal >= 0', '0 <= discountPercent <= 100'],
        postconditions: ['result >= 0', 'result <= subtotal'],
        parameters: [
          { name: 'subtotal', type: 'number' },
          { name: 'discountPercent', type: 'number' },
        ],
        return_type: 'number',
      },
    };

    const report = await orchestrator.startInvestigation(target);
    printInvestigationReport('applyDiscount', report);

    expect(report.proof).toBeDefined();
    expect(report.proof!.violated_postcondition).toBe('result >= 0');
    expect(report.proof!.observed_output).toBe(-50);
    expect(report.approved_patches.length).toBe(1);
    expect(report.rejected_patches.length).toBe(1);
    expect(report.status).toBe('confirmed_and_repaired');
  });

  // ─── Test 5: Investigate calculateLoyaltyPoints (Bug 5) ────────────────────

  it('should prove Bug 5: calculateLoyaltyPoints is non-deterministic', async () => {
    console.log('─── STEP 5: Investigate calculateLoyaltyPoints ─────────────');
    console.log('  Specification:');
    console.log('    Pre:  total >= 0');
    console.log('    Post: deterministic (same input → same output)');
    console.log('');

    const orchestrator = buildOrchestrator(
      createLoyaltyPointsProof(),
      createLoyaltyPointsPatches(),
      ['patch-loyalty-deterministic'], // Remove randomness
    );

    const target: InvestigationTarget = {
      function_id: 'calculateLoyaltyPoints',
      file_path: CART_FILE,
      specification: {
        name: 'calculateLoyaltyPoints',
        preconditions: ['total >= 0'],
        postconditions: ['result === calculateLoyaltyPoints(total)'],
        parameters: [{ name: 'total', type: 'number' }],
        return_type: 'number',
      },
    };

    const report = await orchestrator.startInvestigation(target);
    printInvestigationReport('calculateLoyaltyPoints', report);

    expect(report.proof).toBeDefined();
    expect(report.proof!.violated_postcondition).toContain('determinism');
    expect(report.approved_patches.length).toBe(1);
    expect(report.status).toBe('confirmed_and_repaired');
  });

  // ─── Test 6: Summary Report ────────────────────────────────────────────────

  it('should produce complete summary across all investigations', async () => {
    // Run all 4 investigations and collect results
    const investigations = [
      {
        name: 'calculateSubtotal',
        proof: createSubtotalProof(),
        patches: createSubtotalPatches(),
        approved: ['patch-subtotal-skip-discount'],
      },
      {
        name: 'calculateAveragePrice',
        proof: createAveragePriceProof(),
        patches: createAveragePricePatches(),
        approved: ['patch-avg-guard'],
      },
      {
        name: 'applyDiscount',
        proof: createDiscountProof(),
        patches: createDiscountPatches(),
        approved: ['patch-discount-clamp'],
      },
      {
        name: 'calculateLoyaltyPoints',
        proof: createLoyaltyPointsProof(),
        patches: createLoyaltyPointsPatches(),
        approved: ['patch-loyalty-deterministic'],
      },
    ];

    const reports: InvestigationReport[] = [];

    for (const inv of investigations) {
      const orchestrator = buildOrchestrator(inv.proof, inv.patches, inv.approved);
      const target: InvestigationTarget = {
        function_id: inv.name,
        file_path: CART_FILE,
        specification: {
          name: inv.name,
          preconditions: [],
          postconditions: [],
          parameters: [],
          return_type: 'number',
        },
      };
      reports.push(await orchestrator.startInvestigation(target));
    }

    const bugsProven = reports.filter(r => r.proof).length;
    const totalApproved = reports.reduce((sum, r) => sum + r.approved_patches.length, 0);
    const totalRejected = reports.reduce((sum, r) => sum + r.rejected_patches.length, 0);

    console.log('═══════════════════════════════════════════════════════════════');
    console.log('  SUMMARY');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('');
    console.log(`  Functions analyzed:  ${investigations.length}`);
    console.log(`  Bugs proven:         ${bugsProven}`);
    console.log(`  Patches generated:   ${totalApproved + totalRejected}`);
    console.log(`  Patches approved:    ${totalApproved}`);
    console.log(`  Patches rejected:    ${totalRejected}`);
    console.log('');
    console.log('  Per-function results:');
    for (let i = 0; i < investigations.length; i++) {
      const inv = investigations[i];
      const report = reports[i];
      const status = report.proof ? '🐛 BUG PROVEN' : '✓ No bug found';
      const patchStatus = report.approved_patches.length > 0
        ? `🔧 ${report.approved_patches.length} fix(es)`
        : '— no fix';
      console.log(`    ${inv.name.padEnd(28)} ${status}  ${patchStatus}`);
    }
    console.log('');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('');

    // Assertions
    expect(bugsProven).toBe(4);
    expect(totalApproved).toBe(4);
    expect(totalRejected).toBe(2); // subtotal has 1 rejected, discount has 1 rejected
    expect(reports.every(r => r.status === 'confirmed_and_repaired')).toBe(true);
  });
});
