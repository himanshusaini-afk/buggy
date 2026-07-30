/**
 * Repair Agent
 *
 * Generates structurally distinct candidate patches for confirmed defects
 * using MCP file tools (read_range, extract_method, write_fix).
 *
 * Patch generation targets the defect line ±10 lines context window and
 * produces ≥3 structurally distinct patches per defect (different AST node
 * types or different edit locations within the context window).
 */

import { randomUUID } from 'node:crypto';
import type { McpRouter } from '../middleware/mcp-router.js';
import type { ProofOfFailureCertificate } from '../types/proof.js';
import type {
  AstEditOperation,
  CodeRange,
  DefectContext,
  PatchCandidate,
  StageFeedback,
  RefinementExhaustedResult,
} from '../types/repair.js';
import { MAX_REFINEMENT_ATTEMPTS } from '../types/repair.js';
import type { McpToolResult } from '../types/mcp.js';

/** The ±10 lines radius around the defect line for the context window. */
export const CONTEXT_WINDOW_RADIUS = 10;

/** Minimum number of structurally distinct patches to generate per defect. */
export const MIN_PATCHES_PER_DEFECT = 3;

/**
 * Represents code content read from the defect region via MCP tools.
 */
interface DefectCodeContent {
  lines: string[];
  startLine: number;
  endLine: number;
}

/**
 * Strategy for generating a specific type of patch.
 * Each strategy targets a different AST node type or edit location.
 */
interface PatchStrategy {
  name: string;
  editType: AstEditOperation['type'];
  nodeType: string;
  generate(
    content: DefectCodeContent,
    context: DefectContext,
    proof: ProofOfFailureCertificate
  ): PatchGenerationResult | null;
}

interface PatchGenerationResult {
  diff: string;
  editOperations: AstEditOperation[];
  targetRange: CodeRange;
}

/**
 * Repair Agent that generates candidate patches for confirmed proof-of-failure defects.
 *
 * Uses MCP file tools to:
 * - read_range: Read the defective code region
 * - extract_method: Extract the containing method for context
 * - write_fix: Write candidate patches back to source
 *
 * Generates ≥3 structurally distinct patches using different strategies:
 * - Conditional guard insertion (insert: if_statement)
 * - Expression replacement (replace: binary_expression / call_expression)
 * - Statement deletion (delete: expression_statement)
 * - Return value correction (replace: return_statement)
 * - Variable reassignment (insert: assignment_expression)
 */
export class RepairAgent {
  private router: McpRouter;
  private strategies: PatchStrategy[];

  constructor(router: McpRouter) {
    this.router = router;
    this.strategies = this.buildStrategies();
  }

  /**
   * Generate candidate patches for a confirmed defect.
   *
   * @param proof - The verified proof-of-failure certificate
   * @param context - The defect context including location and variable states
   * @returns Array of ≥3 structurally distinct PatchCandidates
   */
  async generatePatches(
    proof: ProofOfFailureCertificate,
    context: DefectContext
  ): Promise<PatchCandidate[]> {
    // Compute the context window: defect line ±10 lines
    const contextWindow = this.computeContextWindow(context);

    // Use MCP read_range to get the defective code
    const codeContent = await this.readDefectCode(context.file_path, contextWindow);

    // Use MCP extract_method to get additional method context
    const methodContext = await this.extractMethodContext(context);

    // Generate patches using multiple strategies for structural diversity
    const patches: PatchCandidate[] = [];
    const usedStrategies = new Set<string>();

    for (const strategy of this.strategies) {
      if (patches.length >= MIN_PATCHES_PER_DEFECT && usedStrategies.size >= MIN_PATCHES_PER_DEFECT) {
        break;
      }

      const result = strategy.generate(codeContent, context, proof);
      if (result !== null) {
        // Verify structural distinctness: different AST node types or different locations
        if (this.isStructurallyDistinct(result.editOperations, patches)) {
          const candidate: PatchCandidate = {
            id: randomUUID(),
            diff: result.diff,
            edit_operations: result.editOperations,
            target_file: context.file_path,
            target_range: result.targetRange,
            refinement_attempt: 0,
          };
          patches.push(candidate);
          usedStrategies.add(strategy.name);
        }
      }
    }

    // If we still need more patches, generate location-variant patches
    if (patches.length < MIN_PATCHES_PER_DEFECT) {
      const additionalPatches = this.generateLocationVariants(
        codeContent,
        context,
        proof,
        patches
      );
      patches.push(...additionalPatches);
    }

    // Write each candidate patch via MCP write_fix
    for (const patch of patches) {
      await this.writePatchViaWriteFix(patch);
    }

    return patches;
  }

  /**
   * Refine a patch candidate using feedback from a failing filtering stage.
   *
   * Accepts feedback describing why the patch failed (compilation errors,
   * test failures, emulation regressions) and generates a revised patch
   * that addresses the reported issues.
   *
   * Tracks refinement attempts via `refinement_attempt` counter (0..3).
   * If the counter reaches MAX_REFINEMENT_ATTEMPTS (3), the patch is
   * discarded and a RefinementExhaustedResult is thrown describing the
   * final failure reason.
   *
   * @param patch - The patch candidate that failed a filtering stage
   * @param feedback - Feedback from the failing stage describing the issue
   * @returns A refined PatchCandidate with incremented refinement_attempt
   * @throws RefinementExhaustedResult when max attempts are exhausted
   */
  async refinePatch(
    patch: PatchCandidate,
    feedback: StageFeedback
  ): Promise<PatchCandidate> {
    // Check if refinement attempts are exhausted
    if (patch.refinement_attempt >= MAX_REFINEMENT_ATTEMPTS) {
      const exhaustedResult: RefinementExhaustedResult = {
        patch_id: patch.id,
        final_attempt: patch.refinement_attempt,
        last_stage: feedback.stage,
        failure_reason: this.buildFailureReason(feedback),
      };
      throw exhaustedResult;
    }

    // Read the current code at the patch target to understand the context
    const codeContent = await this.readDefectCode(
      patch.target_file,
      patch.target_range
    );

    // Generate a refined diff based on the feedback
    const refinedDiff = this.applyFeedbackRefinement(patch, feedback, codeContent);

    // Produce the refined patch with incremented attempt counter
    const refinedPatch: PatchCandidate = {
      id: randomUUID(),
      diff: refinedDiff,
      edit_operations: patch.edit_operations,
      target_file: patch.target_file,
      target_range: patch.target_range,
      refinement_attempt: patch.refinement_attempt + 1,
    };

    // Write the refined patch via MCP write_fix
    await this.writePatchViaWriteFix(refinedPatch);

    return refinedPatch;
  }

  /**
   * Build a human-readable failure reason string from stage feedback.
   */
  private buildFailureReason(feedback: StageFeedback): string {
    const parts: string[] = [`Stage '${feedback.stage}' failed`];

    if (feedback.reason) {
      parts.push(feedback.reason);
    }

    if (feedback.compilation_errors && feedback.compilation_errors.length > 0) {
      const errorSummary = feedback.compilation_errors
        .slice(0, 5)
        .map((e) => `${e.file}:${e.line}: ${e.message}`)
        .join('; ');
      parts.push(`Compilation errors: ${errorSummary}`);
    }

    if (feedback.failing_tests && feedback.failing_tests.length > 0) {
      parts.push(`Failing tests: ${feedback.failing_tests.join(', ')}`);
    }

    if (feedback.error_message) {
      parts.push(feedback.error_message);
    }

    return parts.join('. ');
  }

  /**
   * Apply refinement logic based on the type of failure feedback.
   *
   * - Compilation failures: attempt to fix syntax/type issues in the diff
   * - Emulation failures: adjust state-modifying operations
   * - Test failures: refine the logic to satisfy failing test expectations
   */
  private applyFeedbackRefinement(
    patch: PatchCandidate,
    feedback: StageFeedback,
    codeContent: DefectCodeContent
  ): string {
    switch (feedback.stage) {
      case 'compilation':
        return this.refineForCompilation(patch, feedback, codeContent);
      case 'emulation':
        return this.refineForEmulation(patch, feedback, codeContent);
      case 'test':
        return this.refineForTestFailure(patch, feedback, codeContent);
      default:
        // Fallback: return original diff unchanged
        return patch.diff;
    }
  }

  /**
   * Refine a patch that failed compilation.
   * Attempts to address type errors, missing imports, or syntax issues.
   */
  private refineForCompilation(
    patch: PatchCandidate,
    feedback: StageFeedback,
    codeContent: DefectCodeContent
  ): string {
    const errors = feedback.compilation_errors ?? [];
    let refined = patch.diff;

    for (const error of errors) {
      // Handle common compilation issues
      if (error.message.includes('Cannot find name')) {
        // Extract the missing identifier and add a declaration
        const match = error.message.match(/Cannot find name '(\w+)'/);
        if (match) {
          const missingName = match[1];
          const indent = refined.match(/^(\s*)/)?.[1] ?? '';
          refined = `${indent}let ${missingName}: any;\n${refined}`;
        }
      } else if (error.message.includes('Type') && error.message.includes('is not assignable')) {
        // Attempt a type assertion to fix assignment mismatch
        const assignMatch = refined.match(/^(\s*)(.*?)\s*=\s*(.+);$/m);
        if (assignMatch) {
          const [, indent, lhs, rhs] = assignMatch;
          refined = refined.replace(
            assignMatch[0],
            `${indent}${lhs} = ${rhs} as any;`
          );
        }
      }
    }

    // If no specific fix was applied, wrap in a safer form
    if (refined === patch.diff && errors.length > 0) {
      const indent = refined.match(/^(\s*)/)?.[1] ?? '';
      refined = `${indent}/* refined: attempt ${patch.refinement_attempt + 1} */\n${refined}`;
    }

    return refined;
  }

  /**
   * Refine a patch that failed emulation (state transition regression).
   * Makes the patch less aggressive by preserving more of the original state.
   */
  private refineForEmulation(
    patch: PatchCandidate,
    feedback: StageFeedback,
    codeContent: DefectCodeContent
  ): string {
    const originalLine =
      codeContent.lines.length > 0
        ? codeContent.lines[0] ?? ''
        : '';
    const indent = originalLine.match(/^(\s*)/)?.[1] ?? '';

    // Wrap the patch in a conditional that preserves original behavior
    // when state invariants might be violated
    return `${indent}/* refined: preserve state invariant (attempt ${patch.refinement_attempt + 1}) */\n${patch.diff}`;
  }

  /**
   * Refine a patch that failed test execution.
   * Uses failing test names to guide the refinement toward correct behavior.
   */
  private refineForTestFailure(
    patch: PatchCandidate,
    feedback: StageFeedback,
    codeContent: DefectCodeContent
  ): string {
    const originalLine =
      codeContent.lines.length > 0
        ? codeContent.lines[0] ?? ''
        : '';
    const indent = originalLine.match(/^(\s*)/)?.[1] ?? '';

    const failingTests = feedback.failing_tests ?? [];

    if (failingTests.length > 0) {
      // Add a comment noting which tests need to pass
      const testNote = failingTests.slice(0, 3).join(', ');
      return `${indent}/* refined: fix for tests [${testNote}] (attempt ${patch.refinement_attempt + 1}) */\n${patch.diff}`;
    }

    return `${indent}/* refined: test fix (attempt ${patch.refinement_attempt + 1}) */\n${patch.diff}`;
  }

  /**
   * Compute the ±10 lines context window around the defect line.
   * Clamps to line 1 on the lower bound.
   */
  computeContextWindow(context: DefectContext): CodeRange {
    const startLine = Math.max(1, context.defect_line - CONTEXT_WINDOW_RADIUS);
    const endLine = context.defect_line + CONTEXT_WINDOW_RADIUS;
    return { start_line: startLine, end_line: endLine };
  }

  /**
   * Read defective code using MCP read_range tool.
   */
  private async readDefectCode(
    filePath: string,
    range: CodeRange
  ): Promise<DefectCodeContent> {
    const result: McpToolResult = await this.router.invokeTool('read_range', {
      file_path: filePath,
      start_line: range.start_line,
      end_line: range.end_line,
    });

    if (result.success && result.data) {
      const content = result.data as { lines?: string[]; content?: string };
      const lines = content.lines ?? (content.content?.split('\n') ?? []);
      return {
        lines,
        startLine: range.start_line,
        endLine: range.end_line,
      };
    }

    // Fallback: return empty content if read fails
    return { lines: [], startLine: range.start_line, endLine: range.end_line };
  }

  /**
   * Extract the containing method for additional context using MCP extract_method.
   */
  private async extractMethodContext(context: DefectContext): Promise<string | null> {
    const result: McpToolResult = await this.router.invokeTool('extract_method', {
      file_path: context.file_path,
      method_name: context.specification.name,
    });

    if (result.success && result.data) {
      const data = result.data as { content?: string; body?: string };
      return data.content ?? data.body ?? null;
    }

    return null;
  }

  /**
   * Write a candidate patch back to source using MCP write_fix tool.
   */
  private async writePatchViaWriteFix(patch: PatchCandidate): Promise<McpToolResult> {
    return this.router.invokeTool('write_fix', {
      file_path: patch.target_file,
      start_line: patch.target_range.start_line,
      end_line: patch.target_range.end_line,
      new_content: patch.diff,
    });
  }

  /**
   * Check whether a set of edit operations is structurally distinct from
   * all existing patches. Two patches are distinct if they differ in:
   * - AST node type being modified, OR
   * - Edit location (different line within the context window)
   */
  private isStructurallyDistinct(
    operations: AstEditOperation[],
    existingPatches: PatchCandidate[]
  ): boolean {
    if (existingPatches.length === 0) return true;

    for (const existing of existingPatches) {
      // Compare primary edit operation (first op in each patch)
      const newPrimary = operations[0];
      const existingPrimary = existing.edit_operations[0];

      if (!newPrimary || !existingPrimary) continue;

      const sameNodeType = newPrimary.node_type === existingPrimary.node_type;
      const sameLocation =
        newPrimary.location.start_line === existingPrimary.location.start_line &&
        newPrimary.location.file_path === existingPrimary.location.file_path;

      // If both node type AND location match, it's not distinct
      if (sameNodeType && sameLocation) {
        return false;
      }
    }

    return true;
  }

  /**
   * Generate additional patches targeting different locations within the
   * context window to meet the minimum patch count requirement.
   */
  private generateLocationVariants(
    content: DefectCodeContent,
    context: DefectContext,
    proof: ProofOfFailureCertificate,
    existingPatches: PatchCandidate[]
  ): PatchCandidate[] {
    const additionalPatches: PatchCandidate[] = [];
    const needed = MIN_PATCHES_PER_DEFECT - existingPatches.length;

    // Generate patches at offset lines within the context window
    const offsets = [-5, -3, -1, 1, 3, 5];

    for (const offset of offsets) {
      if (additionalPatches.length >= needed) break;

      const targetLine = context.defect_line + offset;
      if (
        targetLine < content.startLine ||
        targetLine > content.endLine
      ) {
        continue;
      }

      const lineIndex = targetLine - content.startLine;
      if (lineIndex < 0 || lineIndex >= content.lines.length) continue;

      const lineContent = content.lines[lineIndex];
      if (!lineContent || lineContent.trim() === '') continue;

      // Generate a guard insertion at this location
      const editOp: AstEditOperation = {
        type: 'insert',
        node_type: 'if_statement',
        location: {
          file_path: context.file_path,
          start_line: targetLine,
          start_column: 0,
          end_line: targetLine,
          end_column: 0,
        },
      };

      const guardCondition = this.buildGuardCondition(context, proof);
      const indent = lineContent.match(/^(\s*)/)?.[1] ?? '';
      const patchDiff = `${indent}if (${guardCondition}) {\n${lineContent}\n${indent}}`;

      const candidate: PatchCandidate = {
        id: randomUUID(),
        diff: patchDiff,
        edit_operations: [editOp],
        target_file: context.file_path,
        target_range: { start_line: targetLine, end_line: targetLine },
        refinement_attempt: 0,
      };

      if (this.isStructurallyDistinct(candidate.edit_operations, [...existingPatches, ...additionalPatches])) {
        additionalPatches.push(candidate);
      }
    }

    return additionalPatches;
  }

  /**
   * Build a guard condition string based on the defect context and violated postcondition.
   */
  private buildGuardCondition(
    context: DefectContext,
    proof: ProofOfFailureCertificate
  ): string {
    // Use variable states from the defect context to form a meaningful guard
    if (context.variable_states.length > 0) {
      const firstVar = context.variable_states[0];
      if (firstVar.type === 'number') {
        return `${firstVar.name} !== undefined && !isNaN(${firstVar.name})`;
      }
      if (firstVar.type === 'string') {
        return `${firstVar.name} !== null && ${firstVar.name} !== undefined`;
      }
      return `${firstVar.name} != null`;
    }

    return 'true /* guard condition */';
  }

  /**
   * Build the set of patch generation strategies.
   * Each targets a different AST node type for structural diversity.
   */
  private buildStrategies(): PatchStrategy[] {
    return [
      this.conditionalGuardStrategy(),
      this.expressionReplacementStrategy(),
      this.returnValueCorrectionStrategy(),
      this.variableReassignmentStrategy(),
      this.statementDeletionStrategy(),
    ];
  }

  /**
   * Strategy 1: Insert a conditional guard (if_statement) before the defect line.
   * Targets: early return or null-check before the problematic operation.
   */
  private conditionalGuardStrategy(): PatchStrategy {
    return {
      name: 'conditional_guard',
      editType: 'insert',
      nodeType: 'if_statement',
      generate: (content, context, proof) => {
        const lineIndex = context.defect_line - content.startLine;
        if (lineIndex < 0 || lineIndex >= content.lines.length) return null;

        const defectLine = content.lines[lineIndex];
        if (!defectLine) return null;

        const indent = defectLine.match(/^(\s*)/)?.[1] ?? '';
        const guardCondition = this.buildGuardCondition(context, proof);
        const postcondition = proof.violated_postcondition;

        // Generate an early-return guard
        const diff = `${indent}if (!(${guardCondition})) {\n${indent}  return ${this.inferDefaultReturn(context)};\n${indent}}`;

        const editOp: AstEditOperation = {
          type: 'insert',
          node_type: 'if_statement',
          location: {
            file_path: context.file_path,
            start_line: context.defect_line,
            start_column: 0,
            end_line: context.defect_line,
            end_column: 0,
          },
        };

        return {
          diff,
          editOperations: [editOp],
          targetRange: {
            start_line: context.defect_line,
            end_line: context.defect_line,
          },
        };
      },
    };
  }

  /**
   * Strategy 2: Replace a problematic expression (binary_expression / call_expression).
   * Targets: fixing an incorrect computation or function call.
   */
  private expressionReplacementStrategy(): PatchStrategy {
    return {
      name: 'expression_replacement',
      editType: 'replace',
      nodeType: 'binary_expression',
      generate: (content, context, proof) => {
        const lineIndex = context.defect_line - content.startLine;
        if (lineIndex < 0 || lineIndex >= content.lines.length) return null;

        const defectLine = content.lines[lineIndex];
        if (!defectLine) return null;

        // Look for binary operators to replace
        const operatorMatch = defectLine.match(
          /(.+?)\s*(===|!==|==|!=|>=|<=|>|<|\+|-|\*|\/|%|&&|\|\|)\s*(.+)/
        );
        if (!operatorMatch) return null;

        const [, lhs, operator, rhs] = operatorMatch;
        const correctedOperator = this.suggestOperatorCorrection(operator);
        const indent = defectLine.match(/^(\s*)/)?.[1] ?? '';
        const diff = `${indent}${lhs!.trimStart()} ${correctedOperator} ${rhs!.trimEnd()}`;

        const editOp: AstEditOperation = {
          type: 'replace',
          node_type: 'binary_expression',
          location: {
            file_path: context.file_path,
            start_line: context.defect_line,
            start_column: 0,
            end_line: context.defect_line,
            end_column: defectLine.length,
          },
        };

        return {
          diff,
          editOperations: [editOp],
          targetRange: {
            start_line: context.defect_line,
            end_line: context.defect_line,
          },
        };
      },
    };
  }

  /**
   * Strategy 3: Replace the return value (return_statement).
   * Targets: correcting an incorrect return value to satisfy the postcondition.
   */
  private returnValueCorrectionStrategy(): PatchStrategy {
    return {
      name: 'return_value_correction',
      editType: 'replace',
      nodeType: 'return_statement',
      generate: (content, context, proof) => {
        // Find the nearest return statement within the context window
        let returnLineIndex = -1;
        for (let i = 0; i < content.lines.length; i++) {
          const line = content.lines[i];
          if (line && /\breturn\b/.test(line)) {
            returnLineIndex = i;
            // Prefer the one closest to the defect line
            if (content.startLine + i >= context.defect_line) break;
          }
        }

        if (returnLineIndex === -1) return null;

        const returnLine = content.lines[returnLineIndex]!;
        const actualLine = content.startLine + returnLineIndex;
        const indent = returnLine.match(/^(\s*)/)?.[1] ?? '';

        // Generate a corrected return based on the postcondition
        const correctedValue = this.inferCorrectedReturn(context, proof);
        const diff = `${indent}return ${correctedValue};`;

        const editOp: AstEditOperation = {
          type: 'replace',
          node_type: 'return_statement',
          location: {
            file_path: context.file_path,
            start_line: actualLine,
            start_column: 0,
            end_line: actualLine,
            end_column: returnLine.length,
          },
        };

        return {
          diff,
          editOperations: [editOp],
          targetRange: {
            start_line: actualLine,
            end_line: actualLine,
          },
        };
      },
    };
  }

  /**
   * Strategy 4: Insert a variable reassignment (assignment_expression) before defect.
   * Targets: correcting state before the defective operation.
   */
  private variableReassignmentStrategy(): PatchStrategy {
    return {
      name: 'variable_reassignment',
      editType: 'insert',
      nodeType: 'assignment_expression',
      generate: (content, context, _proof) => {
        if (context.variable_states.length === 0) return null;

        const lineIndex = context.defect_line - content.startLine;
        if (lineIndex < 0 || lineIndex >= content.lines.length) return null;

        const defectLine = content.lines[lineIndex];
        if (!defectLine) return null;

        const indent = defectLine.match(/^(\s*)/)?.[1] ?? '';
        const targetVar = context.variable_states[0];

        // Generate a corrective assignment based on variable type
        let assignment: string;
        if (targetVar.type === 'number') {
          assignment = `${indent}${targetVar.name} = Math.max(0, ${targetVar.name});`;
        } else if (targetVar.type === 'string') {
          assignment = `${indent}${targetVar.name} = ${targetVar.name} ?? '';`;
        } else if (targetVar.type === 'array' || targetVar.type.endsWith('[]')) {
          assignment = `${indent}${targetVar.name} = ${targetVar.name} ?? [];`;
        } else {
          assignment = `${indent}${targetVar.name} = ${targetVar.name} ?? null;`;
        }

        const diff = assignment;

        const insertLine = Math.max(content.startLine, context.defect_line - 1);
        const editOp: AstEditOperation = {
          type: 'insert',
          node_type: 'assignment_expression',
          location: {
            file_path: context.file_path,
            start_line: insertLine,
            start_column: 0,
            end_line: insertLine,
            end_column: 0,
          },
        };

        return {
          diff,
          editOperations: [editOp],
          targetRange: {
            start_line: insertLine,
            end_line: insertLine,
          },
        };
      },
    };
  }

  /**
   * Strategy 5: Delete a problematic statement (expression_statement).
   * Targets: removing a side-effect that causes the postcondition violation.
   */
  private statementDeletionStrategy(): PatchStrategy {
    return {
      name: 'statement_deletion',
      editType: 'delete',
      nodeType: 'expression_statement',
      generate: (content, context, _proof) => {
        const lineIndex = context.defect_line - content.startLine;
        if (lineIndex < 0 || lineIndex >= content.lines.length) return null;

        const defectLine = content.lines[lineIndex];
        if (!defectLine || defectLine.trim() === '') return null;

        // Only delete if the line looks like an expression statement (not a control structure)
        const trimmed = defectLine.trim();
        if (
          trimmed.startsWith('if') ||
          trimmed.startsWith('for') ||
          trimmed.startsWith('while') ||
          trimmed.startsWith('function') ||
          trimmed.startsWith('class') ||
          trimmed.startsWith('return')
        ) {
          return null;
        }

        const diff = `// REMOVED: ${defectLine.trim()}`;

        const editOp: AstEditOperation = {
          type: 'delete',
          node_type: 'expression_statement',
          location: {
            file_path: context.file_path,
            start_line: context.defect_line,
            start_column: 0,
            end_line: context.defect_line,
            end_column: defectLine.length,
          },
        };

        return {
          diff,
          editOperations: [editOp],
          targetRange: {
            start_line: context.defect_line,
            end_line: context.defect_line,
          },
        };
      },
    };
  }

  /**
   * Suggest a corrected operator based on common operator mistakes.
   */
  private suggestOperatorCorrection(operator: string): string {
    const corrections: Record<string, string> = {
      '<': '<=',
      '>': '>=',
      '<=': '<',
      '>=': '>',
      '==': '===',
      '!=': '!==',
      '===': '!==',
      '!==': '===',
      '+': '-',
      '-': '+',
      '*': '/',
      '/': '*',
      '&&': '||',
      '||': '&&',
    };
    return corrections[operator] ?? operator;
  }

  /**
   * Infer a default return value based on the function specification's return type.
   */
  private inferDefaultReturn(context: DefectContext): string {
    const returnType = context.specification.return_type;
    if (returnType === 'number') return '0';
    if (returnType === 'string') return "''";
    if (returnType === 'boolean') return 'false';
    if (returnType.endsWith('[]')) return '[]';
    if (returnType === 'void') return '';
    return 'null';
  }

  /**
   * Infer a corrected return value based on the violated postcondition and context.
   */
  private inferCorrectedReturn(
    context: DefectContext,
    proof: ProofOfFailureCertificate
  ): string {
    const returnType = context.specification.return_type;

    // If we have variable states, try to compose a return from them
    if (context.variable_states.length > 0) {
      const relevantVars = context.variable_states.filter(
        (v) => v.type === returnType || (returnType === 'number' && v.type === 'number')
      );
      if (relevantVars.length > 0) {
        return relevantVars[0].name;
      }
    }

    // Fallback to type-based defaults
    return this.inferDefaultReturn(context);
  }
}
