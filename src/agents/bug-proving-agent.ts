/**
 * Bug_Proving_Agent - Orchestrates bug proving capabilities.
 *
 * This agent coordinates the following subsystems:
 * - TrajSpec: behavioral interpretation from repository history
 * - SpecTune: specification refinement via alpha-consistency
 * - PROBE: adversarial refinement loop for property verification
 * - DiffTestGen: differential test analysis for behavioral difference detection
 * - SAFuzz: biased fuzzing guided by defect-correlated regions
 * - ProofVerifier: mathematical proof-of-failure verification
 * - RealFuzzer: execution-based fuzzing with postcondition checking
 *
 * Requirements: 4.1–11.6
 */

import type Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import {
  DiffTestGen,
  type Implementation,
  type DiffTestResult,
  type DiffTestGenConfig,
  type SpecificationAssertion,
} from './difftestgen.js';
import { RealFuzzer, type FuzzTarget, type FuzzConfig, type FuzzReport } from './real-fuzzer.js';
import { SubprocessExecutor, type ExecuteResult } from '../sandbox/subprocess-executor.js';
import { evaluatePrecondition, evaluatePostcondition } from './spec-conditions.js';
import type { SourceLocation } from '../types/graph.js';
import type { InvestigationTarget } from '../types/orchestrator.js';
import type { ProofOfFailureCertificate } from '../types/proof.js';

export type { Implementation, DiffTestResult, DiffTestGenConfig, SpecificationAssertion };

/**
 * Result from Bug_Proving_Agent investigation.
 */
export interface BugProvingResult {
  certified: boolean;
  proof?: ProofOfFailureCertificate;
  intermediate: {
    fuzz_mutations?: number;
    probe_iterations?: number;
    [key: string]: unknown;
  };
}

/**
 * Configuration for the Bug_Proving_Agent.
 */
export interface BugProvingAgentConfig {
  /** Configuration for differential test generation. */
  diffTestGen?: Partial<DiffTestGenConfig>;
  /** Configuration for real fuzzing. */
  fuzz?: FuzzConfig;
}

/**
 * Bug_Proving_Agent coordinates all bug-proving subsystems.
 *
 * Provides a unified interface for:
 * - Differential test analysis (DiffTestGen)
 * - Real execution-based fuzzing (RealFuzzer)
 * - And other proving capabilities (TrajSpec, SpecTune, PROBE, SAFuzz, ProofVerifier)
 */
export class BugProvingAgent {
  private db: Database.Database;
  private config: BugProvingAgentConfig;
  private diffTestGen: DiffTestGen;

  constructor(db: Database.Database, config?: BugProvingAgentConfig) {
    this.db = db;
    this.config = config ?? {};
    this.diffTestGen = new DiffTestGen(this.config.diffTestGen);
  }

  /**
   * Investigate a function target for bugs using real execution-based fuzzing.
   *
   * Pipeline:
   * 1. Extract the function source code from the file
   * 2. Build a FuzzTarget with the specification
   * 3. Run the real fuzzer (edge cases + random inputs)
   * 4. If a violation is found, verify the proof:
   *    - Admissibility: re-check preconditions on the triggering input
   *    - Soundness: confirm the output violates the postcondition
   *    - Reproducibility: re-execute 3 times, confirm the same failure reproduces
   * 5. Return certified proof or unconfirmed
   *
   * Note: this real-execution path verifies Reproducibility as its third pillar
   * (a deterministic, repeatable failure). That is distinct from the formal
   * ProofVerifier, whose third pillar is Feasibility (a spec-satisfying output
   * exists in a declared output domain). This agent has no output domain, so it
   * proves the failure is genuine by reproducing it rather than by exhibiting a
   * correct alternative.
   */
  async investigate(target: InvestigationTarget): Promise<BugProvingResult> {
    // Step 1: Extract function source code
    const sourceCode = this.extractFunctionSource(target.file_path, target.function_id);
    if (!sourceCode) {
      return { certified: false, intermediate: {} };
    }

    // Step 2: Build FuzzTarget
    const fuzzTarget: FuzzTarget = {
      sourceCode,
      functionName: target.function_id,
      postconditions: target.specification.postconditions,
      preconditions: target.specification.preconditions,
      parameterTypes: target.specification.parameters.map((p) => p.type),
      parameterNames: target.specification.parameters.map((p) => p.name),
    };

    // Step 3: Run real fuzzer
    const fuzzer = new RealFuzzer(this.config.fuzz);
    const report = await fuzzer.fuzz(fuzzTarget);

    const intermediate = {
      fuzz_mutations: report.totalAttempts,
      violations_found: report.violations.length,
      total_time_ms: report.totalTime_ms,
    };

    // Step 4: If no violation, return unconfirmed
    if (report.status === 'no_violation' || report.violations.length === 0) {
      return { certified: false, intermediate };
    }

    // Step 5: Verify the proof
    const violation = report.violations[0];
    const proof = await this.verifyAndCertify(fuzzTarget, violation);

    if (proof) {
      return { certified: true, proof, intermediate };
    }

    return { certified: false, intermediate };
  }

  /**
   * Verify a fuzzing violation and produce a certified proof.
   *
   * Three checks:
   * - Admissibility: input satisfies all preconditions
   * - Soundness: output genuinely violates the postcondition
   * - Reproducibility: the same failure reproduces consistently across re-runs
   */
  private async verifyAndCertify(
    target: FuzzTarget,
    violation: { input: unknown; output: unknown; violatedPostcondition: string; oracleType: string },
  ): Promise<ProofOfFailureCertificate | null> {
    const now = new Date().toISOString();

    // Admissibility: check that the triggering input satisfies all preconditions
    const admissible = this.checkAdmissibility(
      target.preconditions,
      violation.input,
      target.parameterNames,
    );
    if (!admissible) return null;

    // Determinism violations are special: "the function must be deterministic"
    // is a human-readable string, not a JS postcondition. Feeding it to
    // outputViolatesPostcondition throws (caught → false), so every determinism
    // bug the fuzzer finds was silently dropped at certification. Verify it the
    // only way that makes sense — by observing that repeated executions on the
    // same input do not all agree.
    if (violation.oracleType === 'determinism') {
      const detExecutor = new SubprocessExecutor({ timeout: 3000 });
      const detResults = await detExecutor.executeMultiple(
        {
          functionCode: target.sourceCode,
          functionName: target.functionName,
          input: violation.input,
          timeout: 3000,
        },
        5,
      );
      detExecutor.cleanup();

      // Reproduced non-determinism (more than one distinct outcome) confirms both
      // soundness and reproducibility for this class; otherwise we could not
      // reproduce it, so we do not certify.
      if (!this.outputsVary(detResults)) return null;

      const certifiedAt = new Date().toISOString();
      return {
        test_input: violation.input,
        observed_output: violation.output,
        violated_postcondition: violation.violatedPostcondition,
        admissibility_verified_at: now,
        soundness_verified_at: certifiedAt,
        uniqueness_verified_at: certifiedAt,
      };
    }

    // Soundness: confirm the postcondition is actually violated
    const executor = new SubprocessExecutor({ timeout: 3000 });
    const rerunResult = await executor.execute({
      functionCode: target.sourceCode,
      functionName: target.functionName,
      input: violation.input,
      timeout: 3000,
    });

    let soundnessConfirmed = false;
    if (violation.oracleType === 'crash') {
      soundnessConfirmed = rerunResult.crashed;
    } else if (violation.oracleType === 'timeout') {
      soundnessConfirmed = rerunResult.timedOut;
    } else if (rerunResult.success) {
      // Re-check postcondition
      soundnessConfirmed = this.outputViolatesPostcondition(
        violation.violatedPostcondition,
        rerunResult.output,
        violation.input,
        target.parameterNames,
      );
    }

    if (!soundnessConfirmed) {
      executor.cleanup();
      return null;
    }

    // Reproducibility: run 3 more times and confirm the same failure reproduces.
    const reproducibilityResults = await executor.executeMultiple(
      {
        functionCode: target.sourceCode,
        functionName: target.functionName,
        input: violation.input,
        timeout: 3000,
      },
      3,
    );
    executor.cleanup();

    let reproducedCount = 0;
    for (const result of reproducibilityResults) {
      if (violation.oracleType === 'crash' && result.crashed) {
        reproducedCount++;
      } else if (violation.oracleType === 'timeout' && result.timedOut) {
        reproducedCount++;
      } else if (result.success) {
        const violates = this.outputViolatesPostcondition(
          violation.violatedPostcondition,
          result.output,
          violation.input,
          target.parameterNames,
        );
        if (violates) reproducedCount++;
      }
    }

    // Require at least 2 out of 3 reproductions to consider the failure reproducible.
    if (reproducedCount < 2) return null;

    const certifiedAt = new Date().toISOString();

    return {
      test_input: violation.input,
      observed_output: violation.output,
      violated_postcondition: violation.violatedPostcondition,
      admissibility_verified_at: now,
      soundness_verified_at: certifiedAt,
      uniqueness_verified_at: certifiedAt,
    };
  }

  /**
   * Check if a given input satisfies all preconditions.
   */
  private checkAdmissibility(
    preconditions: string[],
    input: unknown,
    parameterNames: string[],
  ): boolean {
    if (preconditions.length === 0) return true;

    for (const precondition of preconditions) {
      try {
        if (!evaluatePrecondition(precondition, input, parameterNames)) return false;
      } catch {
        // Prose or otherwise unevaluable precondition — can't judge admissibility
        // from it, so don't let it block certification.
        continue;
      }
    }
    return true;
  }

  /**
   * Returns true if the executions produced more than one distinct outcome,
   * i.e. the function did not behave deterministically. Used to confirm
   * determinism violations, which have no expressible JS postcondition form.
   */
  private outputsVary(results: ExecuteResult[]): boolean {
    const outcomes = new Set<string>();
    for (const r of results) {
      if (r.success) {
        outcomes.add('ok:' + JSON.stringify(r.output ?? null));
      } else if (r.timedOut) {
        outcomes.add('timeout');
      } else if (r.crashed) {
        outcomes.add('crash:' + (r.exceptionType ?? ''));
      }
    }
    return outcomes.size > 1;
  }

  /**
   * Check if a function output violates a postcondition.
   */
  private outputViolatesPostcondition(
    postcondition: string,
    output: unknown,
    input: unknown,
    parameterNames: string[],
  ): boolean {
    try {
      return !evaluatePostcondition(postcondition, input, output, parameterNames);
    } catch {
      return false;
    }
  }

  /**
   * Extract function source code from a file.
   *
   * Looks for common patterns:
   * - `function name(...)` declarations
   * - `const/let/var name = function(...)` or arrow functions
   * - `export function name(...)`
   * - Class methods via `name(...)` inside a class body
   *
   * Falls back to reading the entire file content if the function
   * cannot be isolated (the executor wraps it appropriately).
   */
  private extractFunctionSource(filePath: string, functionId: string): string | null {
    try {
      const content = readFileSync(filePath, 'utf-8');
      
      // Try to find and extract the specific function
      const extracted = this.findFunctionInSource(content, functionId);
      if (extracted) return extracted;

      // Fallback: return the entire file content — the executor
      // will try to resolve the function name from it
      return content;
    } catch {
      return null;
    }
  }

  /**
   * Find and extract a function's source from file content using regex patterns.
   * Handles: function declarations, arrow functions, exported functions.
   */
  private findFunctionInSource(content: string, functionId: string): string | null {
    const escapedName = functionId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // Pattern 1: function declaration (with or without export)
    const funcDeclPattern = new RegExp(
      `(?:export\\s+)?(?:async\\s+)?function\\s+${escapedName}\\s*\\(`,
    );
    // Pattern 2: const/let/var arrow or function expression
    const varDeclPattern = new RegExp(
      `(?:export\\s+)?(?:const|let|var)\\s+${escapedName}\\s*=\\s*(?:async\\s+)?(?:function)?\\s*[\\(]`,
    );
    // Pattern 3: const/let/var arrow function
    const arrowPattern = new RegExp(
      `(?:export\\s+)?(?:const|let|var)\\s+${escapedName}\\s*=\\s*(?:async\\s+)?\\(`,
    );

    const patterns = [funcDeclPattern, varDeclPattern, arrowPattern];

    for (const pattern of patterns) {
      const match = pattern.exec(content);
      if (match) {
        // Find the balanced braces starting from the match
        const startIdx = match.index;
        const extracted = this.extractBalancedBlock(content, startIdx);
        if (extracted) return extracted;
      }
    }

    return null;
  }

  /**
   * Extract a balanced block of code starting from the given index.
   * Tracks braces `{}` to find the complete function body.
   * Skips braces that appear in return type annotations (between `)` and function body `{`).
   */
  private extractBalancedBlock(content: string, startIdx: number): string | null {
    let braceCount = 0;
    let foundFirstBrace = false;
    let endIdx = startIdx;
    let inReturnType = false;
    let parenCount = 0;
    let passedParamList = false;
    // Last non-whitespace character seen. Used to disambiguate an object *type*
    // literal in a return annotation (e.g. `): { x: number } {`) from the body brace.
    let lastMeaningful = '';

    // A '{' following one of these characters (in return-type position) starts an
    // object type literal rather than the function body.
    const typePositionChars = new Set([':', '|', '&', ',', '<', '(', '=']);

    // Skip a balanced { ... } block starting at index `open`. Returns the index of
    // the matching '}'.
    const skipBalancedBraces = (open: number): number => {
      let depth = 1;
      let j = open + 1;
      while (j < content.length && depth > 0) {
        if (content[j] === '{') depth++;
        else if (content[j] === '}') depth--;
        j++;
      }
      return j - 1;
    };

    for (let i = startIdx; i < content.length; i++) {
      const char = content[i];

      if (char === '(') {
        parenCount++;
        lastMeaningful = char;
      } else if (char === ')') {
        parenCount--;
        lastMeaningful = char;
        if (parenCount === 0 && !passedParamList) {
          passedParamList = true;
          // A ':' immediately after the parameter list indicates a return type annotation.
          const afterParen = content.slice(i + 1, i + 200).trimStart();
          if (afterParen.startsWith(':')) {
            inReturnType = true;
          }
        }
      } else if (char === '{') {
        if (parenCount > 0) {
          // Inside the parameter list: a destructuring pattern or object default value.
          // Skip it wholesale so it is never mistaken for the function body.
          i = skipBalancedBraces(i);
          lastMeaningful = '}';
          continue;
        }
        if (!foundFirstBrace && inReturnType && typePositionChars.has(lastMeaningful)) {
          // Object type literal within the return annotation — skip it and stay in the type.
          i = skipBalancedBraces(i);
          lastMeaningful = '}';
          continue;
        }
        // This '{' opens the function body.
        braceCount++;
        foundFirstBrace = true;
        inReturnType = false;
        lastMeaningful = char;
      } else if (char === '}') {
        braceCount--;
        lastMeaningful = char;
        if (foundFirstBrace && braceCount === 0) {
          endIdx = i + 1;
          break;
        }
      } else if (!/\s/.test(char)) {
        lastMeaningful = char;
      }
    }

    if (!foundFirstBrace || braceCount !== 0) return null;

    // Also handle arrow functions that end with a semicolon after the block
    let result = content.slice(startIdx, endIdx);
    if (endIdx < content.length && content[endIdx] === ';') {
      result = content.slice(startIdx, endIdx + 1);
    }

    return result;
  }

  /**
   * Run DiffTestGen differential test analysis across multiple implementations.
   *
   * Generates ≥100 test inputs per interface method, executes them against all
   * implementations, and flags behavioral differences with severity classification.
   *
   * Behavior:
   * 1. Accepts 2+ implementations of the same interface
   * 2. Generates test inputs (≥100 per method)
   * 3. Runs each input through all implementations
   * 4. Compares outputs — flags any differences
   * 5. Classifies severity based on whether verified specification assertions are violated
   * 6. Sorts results: specification-violating before unspecified-behavior
   * 7. If budget exhausted with no differences, returns 'behaviorally_equivalent'
   *
   * Requirements: 8.1, 8.2, 8.3, 8.4
   *
   * @param implementations - Two or more implementations to compare
   * @returns DiffTestResult with differences sorted by severity
   */
  async runDiffTestGen(implementations: Implementation[]): Promise<DiffTestResult> {
    return this.diffTestGen.runDiffTestGen(implementations);
  }
}
