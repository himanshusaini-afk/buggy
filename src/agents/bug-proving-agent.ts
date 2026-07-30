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
 *
 * Requirements: 4.1–11.6
 */

import type Database from 'better-sqlite3';
import {
  DiffTestGen,
  type Implementation,
  type DiffTestResult,
  type DiffTestGenConfig,
  type SpecificationAssertion,
} from './difftestgen.js';
import type { SourceLocation } from '../types/graph.js';

export type { Implementation, DiffTestResult, DiffTestGenConfig, SpecificationAssertion };

/**
 * Configuration for the Bug_Proving_Agent.
 */
export interface BugProvingAgentConfig {
  /** Configuration for differential test generation. */
  diffTestGen?: Partial<DiffTestGenConfig>;
}

/**
 * Bug_Proving_Agent coordinates all bug-proving subsystems.
 *
 * Provides a unified interface for:
 * - Differential test analysis (DiffTestGen)
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
