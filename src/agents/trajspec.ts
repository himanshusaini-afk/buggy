/**
 * TrajSpec - Behavioral Interpretation from Repository History.
 *
 * Processes repository commit history into structured behavioral interpretations.
 * Each interpretation includes the associated code region (file path and function/method scope),
 * a natural-language behavioral summary, the set of commit identifiers from which it was derived,
 * and a defect correlation score computed as defect-fixing commits / total commits.
 *
 * Produces diagnostic assertions (precondition-postcondition pairs) derived from
 * historical test patterns and code evolution.
 *
 * Supports incremental updates: when new commits arrive, only the new commits
 * and their affected code regions are processed (target: ≤5s per commit for repos
 * up to 10,000 files).
 *
 * All results are stored in the `behavioral_interpretations` and `diagnostic_assertions`
 * tables of the Graph Database.
 *
 * @module TrajSpec
 * @see Requirements 4.1, 4.2, 4.3, 4.4, 4.5
 */

import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type Database from 'better-sqlite3';

/**
 * A structured behavioral interpretation derived from repository history.
 */
export interface BehavioralInterpretation {
  id: string;
  file_path: string;
  function_scope: string;
  summary: string;
  commit_ids: string[];
  defect_correlation_score: number | null;
}

/**
 * A diagnostic assertion derived from historical test patterns and code evolution.
 * Specifies a precondition-postcondition pair linked to a specific function or method.
 */
export interface DiagnosticAssertion {
  id: string;
  interpretation_id: string;
  function_id: string;
  precondition: string;
  postcondition: string;
}

/**
 * Output produced by TrajSpec processing.
 */
export interface TrajSpecOutput {
  interpretations: BehavioralInterpretation[];
  assertions: DiagnosticAssertion[];
  processing_time_ms: number;
}

/**
 * Information about a single commit from the repository.
 */
export interface CommitInfo {
  id: string;
  message: string;
  files_changed: string[];
  is_defect_fix: boolean;
}

/**
 * Internal structure for grouping commits by code region (file + function scope).
 */
interface RegionCommitGroup {
  file_path: string;
  function_scope: string;
  commits: CommitInfo[];
  defect_fixing_count: number;
}

/**
 * TrajSpec processes historical repository context into structured behavioral
 * interpretations and diagnostic assertions.
 */
export class TrajSpec {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /**
   * Process all commits on the default branch to produce behavioral interpretations.
   *
   * Groups commits by affected function/file, generates summaries, computes D/N
   * defect correlation scores, and produces diagnostic assertions.
   *
   * Stores results in the `behavioral_interpretations` and `diagnostic_assertions` tables.
   *
   * @param commits - All commits on the default branch
   * @returns TrajSpecOutput with interpretations, assertions, and processing time
   */
  async processRepository(commits: CommitInfo[]): Promise<TrajSpecOutput> {
    const startTime = performance.now();

    // Group commits by code region (file + function scope)
    const regionGroups = this.groupCommitsByRegion(commits);

    const interpretations: BehavioralInterpretation[] = [];
    const assertions: DiagnosticAssertion[] = [];

    // Process each region group in a transaction for atomicity
    const processAll = this.db.transaction(() => {
      for (const group of regionGroups.values()) {
        const totalCommits = group.commits.length;
        const defectFixingCommits = group.defect_fixing_count;
        const defectCorrelation = this.computeDefectCorrelation(totalCommits, defectFixingCommits);

        const interpretation: BehavioralInterpretation = {
          id: randomUUID(),
          file_path: group.file_path,
          function_scope: group.function_scope,
          summary: this.generateSummary(group),
          commit_ids: group.commits.map(c => c.id),
          defect_correlation_score: defectCorrelation,
        };

        // Store in database
        this.db.prepare(`
          INSERT INTO behavioral_interpretations (id, file_path, function_scope, summary, commit_ids, defect_correlation_score)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          interpretation.id,
          interpretation.file_path,
          interpretation.function_scope,
          interpretation.summary,
          JSON.stringify(interpretation.commit_ids),
          interpretation.defect_correlation_score,
        );

        interpretations.push(interpretation);

        // Generate diagnostic assertions from the region's commit history
        const regionAssertions = this.generateDiagnosticAssertions(interpretation, group);
        for (const assertion of regionAssertions) {
          this.db.prepare(`
            INSERT INTO diagnostic_assertions (id, interpretation_id, function_id, precondition, postcondition)
            VALUES (?, ?, ?, ?, ?)
          `).run(
            assertion.id,
            assertion.interpretation_id,
            assertion.function_id,
            assertion.precondition,
            assertion.postcondition,
          );
          assertions.push(assertion);
        }
      }
    });

    processAll();

    const processingTime = performance.now() - startTime;

    return {
      interpretations,
      assertions,
      processing_time_ms: processingTime,
    };
  }

  /**
   * Incrementally update behavioral interpretations from new commits only.
   *
   * Only processes new commits and their affected code regions. Updates existing
   * interpretations where regions overlap, or creates new ones for previously
   * unseen regions.
   *
   * Should complete within 5 seconds per commit for repos up to 10,000 files.
   *
   * @param newCommits - The new commits to process incrementally
   * @returns TrajSpecOutput with updated/new interpretations and assertions
   */
  async processIncrementalCommits(newCommits: CommitInfo[]): Promise<TrajSpecOutput> {
    const startTime = performance.now();

    const regionGroups = this.groupCommitsByRegion(newCommits);

    const interpretations: BehavioralInterpretation[] = [];
    const assertions: DiagnosticAssertion[] = [];

    const processIncremental = this.db.transaction(() => {
      for (const group of regionGroups.values()) {
        // Check if an interpretation already exists for this region
        const existing = this.db.prepare(`
          SELECT id, file_path, function_scope, summary, commit_ids, defect_correlation_score
          FROM behavioral_interpretations
          WHERE file_path = ? AND function_scope = ?
        `).get(
          group.file_path,
          group.function_scope,
        ) as { id: string; file_path: string; function_scope: string; summary: string; commit_ids: string; defect_correlation_score: number | null } | undefined;

        if (existing) {
          // Update existing interpretation with new commits
          const existingCommitIds: string[] = JSON.parse(existing.commit_ids);
          const mergedCommitIds = [...existingCommitIds, ...group.commits.map(c => c.id)];

          // Recompute defect correlation with merged data
          const existingDefectCount = this.countDefectCommitsFromIds(existingCommitIds, newCommits);
          const totalDefects = existingDefectCount + group.defect_fixing_count;
          const totalCommits = mergedCommitIds.length;
          const defectCorrelation = this.computeDefectCorrelation(totalCommits, totalDefects);

          const updatedSummary = this.generateIncrementalSummary(existing.summary, group);

          this.db.prepare(`
            UPDATE behavioral_interpretations
            SET summary = ?, commit_ids = ?, defect_correlation_score = ?
            WHERE id = ?
          `).run(
            updatedSummary,
            JSON.stringify(mergedCommitIds),
            defectCorrelation,
            existing.id,
          );

          const interpretation: BehavioralInterpretation = {
            id: existing.id,
            file_path: group.file_path,
            function_scope: group.function_scope,
            summary: updatedSummary,
            commit_ids: mergedCommitIds,
            defect_correlation_score: defectCorrelation,
          };

          interpretations.push(interpretation);

          // Generate new diagnostic assertions for the updated interpretation
          const regionAssertions = this.generateDiagnosticAssertions(interpretation, group);
          for (const assertion of regionAssertions) {
            this.db.prepare(`
              INSERT INTO diagnostic_assertions (id, interpretation_id, function_id, precondition, postcondition)
              VALUES (?, ?, ?, ?, ?)
            `).run(
              assertion.id,
              assertion.interpretation_id,
              assertion.function_id,
              assertion.precondition,
              assertion.postcondition,
            );
            assertions.push(assertion);
          }
        } else {
          // Create new interpretation for previously unseen region
          const totalCommits = group.commits.length;
          const defectFixingCommits = group.defect_fixing_count;
          const defectCorrelation = this.computeDefectCorrelation(totalCommits, defectFixingCommits);

          const interpretation: BehavioralInterpretation = {
            id: randomUUID(),
            file_path: group.file_path,
            function_scope: group.function_scope,
            summary: this.generateSummary(group),
            commit_ids: group.commits.map(c => c.id),
            defect_correlation_score: defectCorrelation,
          };

          this.db.prepare(`
            INSERT INTO behavioral_interpretations (id, file_path, function_scope, summary, commit_ids, defect_correlation_score)
            VALUES (?, ?, ?, ?, ?, ?)
          `).run(
            interpretation.id,
            interpretation.file_path,
            interpretation.function_scope,
            interpretation.summary,
            JSON.stringify(interpretation.commit_ids),
            interpretation.defect_correlation_score,
          );

          interpretations.push(interpretation);

          const regionAssertions = this.generateDiagnosticAssertions(interpretation, group);
          for (const assertion of regionAssertions) {
            this.db.prepare(`
              INSERT INTO diagnostic_assertions (id, interpretation_id, function_id, precondition, postcondition)
              VALUES (?, ?, ?, ?, ?)
            `).run(
              assertion.id,
              assertion.interpretation_id,
              assertion.function_id,
              assertion.precondition,
              assertion.postcondition,
            );
            assertions.push(assertion);
          }
        }
      }
    });

    processIncremental();

    const processingTime = performance.now() - startTime;

    return {
      interpretations,
      assertions,
      processing_time_ms: processingTime,
    };
  }

  /**
   * Compute defect correlation score for a code region.
   *
   * score = defect_fixing_commits / total_commits
   * Result is clamped to [0.0, 1.0]. Returns 0 if totalCommits is 0.
   *
   * @param totalCommits - Total number of commits touching the code region (N)
   * @param defectFixingCommits - Number of defect-fixing commits touching the region (D)
   * @returns Defect correlation score in [0.0, 1.0]
   */
  computeDefectCorrelation(totalCommits: number, defectFixingCommits: number): number {
    if (totalCommits === 0) {
      return 0;
    }

    const score = defectFixingCommits / totalCommits;
    return Math.max(0.0, Math.min(1.0, score));
  }

  /**
   * Group commits by code region (file path + function scope).
   *
   * Each file changed in a commit creates a region entry. The function scope
   * is derived from the file path (using the filename as a proxy scope when
   * the actual function scope is not available from the commit metadata).
   */
  private groupCommitsByRegion(commits: CommitInfo[]): Map<string, RegionCommitGroup> {
    const groups = new Map<string, RegionCommitGroup>();

    for (const commit of commits) {
      for (const filePath of commit.files_changed) {
        const functionScope = this.deriveFunctionScope(filePath, commit.message);
        const key = `${filePath}::${functionScope}`;

        let group = groups.get(key);
        if (!group) {
          group = {
            file_path: filePath,
            function_scope: functionScope,
            commits: [],
            defect_fixing_count: 0,
          };
          groups.set(key, group);
        }

        group.commits.push(commit);
        if (commit.is_defect_fix) {
          group.defect_fixing_count++;
        }
      }
    }

    return groups;
  }

  /**
   * Derive the function scope from the file path and commit message.
   *
   * Uses heuristics: if the commit message mentions a function name (e.g., "fix foo()"),
   * use that as the scope. Otherwise, use the module-level scope derived from the filename.
   */
  private deriveFunctionScope(filePath: string, commitMessage: string): string {
    // Try to extract function name from commit message patterns like:
    // "fix functionName", "update ClassName.methodName", "refactor handleFoo"
    const functionPattern = /(?:fix|update|refactor|add|implement|change|modify)\s+(\w+(?:\.\w+)?)/i;
    const match = commitMessage.match(functionPattern);

    if (match && match[1]) {
      return match[1];
    }

    // Fall back to module-level scope from filename
    const fileName = filePath.split('/').pop() ?? filePath;
    const baseName = fileName.replace(/\.[^.]+$/, '');
    return `module:${baseName}`;
  }

  /**
   * Generate a natural-language behavioral summary for a code region
   * based on its commit history.
   */
  private generateSummary(group: RegionCommitGroup): string {
    const commitCount = group.commits.length;
    const defectCount = group.defect_fixing_count;
    const featureCommits = commitCount - defectCount;

    const parts: string[] = [];

    parts.push(
      `${group.function_scope} in ${group.file_path} was modified in ${commitCount} commit(s).`,
    );

    if (featureCommits > 0) {
      parts.push(`${featureCommits} feature/enhancement commit(s).`);
    }

    if (defectCount > 0) {
      parts.push(`${defectCount} defect-fixing commit(s).`);
    }

    // Include representative commit messages for context
    const representativeMessages = group.commits
      .slice(0, 3)
      .map(c => c.message.split('\n')[0])
      .filter(m => m.length > 0);

    if (representativeMessages.length > 0) {
      parts.push(`Key changes: ${representativeMessages.join('; ')}.`);
    }

    return parts.join(' ');
  }

  /**
   * Generate an incremental summary update combining existing summary with new commit data.
   */
  private generateIncrementalSummary(existingSummary: string, group: RegionCommitGroup): string {
    const newCommitCount = group.commits.length;
    const newDefectCount = group.defect_fixing_count;

    const newMessages = group.commits
      .slice(0, 2)
      .map(c => c.message.split('\n')[0])
      .filter(m => m.length > 0);

    const incrementalPart = newMessages.length > 0
      ? ` Updated with ${newCommitCount} new commit(s) (${newDefectCount} defect fix(es)): ${newMessages.join('; ')}.`
      : ` Updated with ${newCommitCount} new commit(s) (${newDefectCount} defect fix(es)).`;

    return existingSummary + incrementalPart;
  }

  /**
   * Generate diagnostic assertions from the region's commit history.
   *
   * Produces precondition-postcondition pairs derived from patterns in the
   * commit messages, such as null checks, boundary conditions, and type guards
   * that were added as part of defect fixes.
   */
  private generateDiagnosticAssertions(
    interpretation: BehavioralInterpretation,
    group: RegionCommitGroup,
  ): DiagnosticAssertion[] {
    const assertions: DiagnosticAssertion[] = [];

    // Analyze defect-fixing commits for patterns suggesting assertions
    const defectCommits = group.commits.filter(c => c.is_defect_fix);

    for (const commit of defectCommits) {
      const extractedAssertions = this.extractAssertionsFromCommit(commit, interpretation);
      assertions.push(...extractedAssertions);
    }

    // If no defect-fixing commits, derive a basic assertion from the function scope
    if (assertions.length === 0 && group.commits.length > 0) {
      const basicAssertion: DiagnosticAssertion = {
        id: randomUUID(),
        interpretation_id: interpretation.id,
        function_id: interpretation.function_scope,
        precondition: 'input !== undefined && input !== null',
        postcondition: 'result !== undefined',
      };
      assertions.push(basicAssertion);
    }

    return assertions;
  }

  /**
   * Extract assertion patterns from a defect-fixing commit message.
   *
   * Looks for common patterns in commit messages that suggest preconditions
   * and postconditions (e.g., null checks, boundary validations, type guards).
   */
  private extractAssertionsFromCommit(
    commit: CommitInfo,
    interpretation: BehavioralInterpretation,
  ): DiagnosticAssertion[] {
    const assertions: DiagnosticAssertion[] = [];
    const message = commit.message.toLowerCase();

    // Pattern: null/undefined checks
    if (message.includes('null') || message.includes('undefined') || message.includes('nullable')) {
      assertions.push({
        id: randomUUID(),
        interpretation_id: interpretation.id,
        function_id: interpretation.function_scope,
        precondition: 'input !== null && input !== undefined',
        postcondition: 'result !== null && result !== undefined',
      });
    }

    // Pattern: bounds/range checks
    if (message.includes('bound') || message.includes('range') || message.includes('overflow') || message.includes('index')) {
      assertions.push({
        id: randomUUID(),
        interpretation_id: interpretation.id,
        function_id: interpretation.function_scope,
        precondition: 'index >= 0 && index < array.length',
        postcondition: 'result >= lowerBound && result <= upperBound',
      });
    }

    // Pattern: type checks
    if (message.includes('type') || message.includes('cast') || message.includes('typeof')) {
      assertions.push({
        id: randomUUID(),
        interpretation_id: interpretation.id,
        function_id: interpretation.function_scope,
        precondition: 'typeof input === expectedType',
        postcondition: 'typeof result === expectedOutputType',
      });
    }

    // Pattern: empty/length checks
    if (message.includes('empty') || message.includes('length') || message.includes('size')) {
      assertions.push({
        id: randomUUID(),
        interpretation_id: interpretation.id,
        function_id: interpretation.function_scope,
        precondition: 'input.length > 0',
        postcondition: 'result.length >= 0',
      });
    }

    return assertions;
  }

  /**
   * Helper to count defect-fixing commits from a set of commit IDs,
   * checking against the current batch of new commits.
   *
   * Used during incremental processing to estimate the defect count
   * from previously stored commit IDs when the original CommitInfo
   * objects are not available.
   */
  private countDefectCommitsFromIds(commitIds: string[], availableCommits: CommitInfo[]): number {
    const commitMap = new Map(availableCommits.map(c => [c.id, c]));
    let count = 0;

    for (const id of commitIds) {
      const commit = commitMap.get(id);
      if (commit?.is_defect_fix) {
        count++;
      }
    }

    // For commits not in the available set, we can't determine their defect status
    // so we return only the known count. This is an approximation for incremental updates.
    return count;
  }
}
