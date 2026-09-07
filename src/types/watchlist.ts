/**
 * Watchlist types — the experience-memory layer for Buggy.
 *
 * The Watchlist records one *episode* per investigation (what was attempted,
 * what worked, what failed and how), distills verified episodes into portable
 * *lessons*, and surfaces them so future runs — and Kiro itself — can improve.
 *
 * Scope model (default `layered`):
 *  - local:  raw episodes in the project's `.debugger/` database (never shared).
 *  - team:   verified lessons written to `.kiro/steering/buggy-watchlist.md`
 *            (committed → shared with teammates on this repo).
 *  - global: generalized + sanitized lessons corroborated across ≥2 projects,
 *            written to `~/.buggy/` and `~/.kiro/steering/buggy-watchlist-global.md`
 *            (applies to all of the user's projects).
 *  - layered: all of the above.
 *
 * @module types/watchlist
 */

import type { InvestigationReport, InvestigationTarget } from './orchestrator.js';

/** Where a recorded episode originated. */
export type EpisodeSource = 'buggy_investigate' | 'kiro_edit';

/** Final outcome of an episode — mirrors {@link InvestigationReport.status}. */
export type EpisodeOutcome = InvestigationReport['status'];

/** Memory sharing scope. See module docs. */
export type WatchlistScope = 'local' | 'team' | 'global' | 'layered';

/**
 * Structural copy of the orchestrator's `PipelineFailure`. Duplicated here
 * (rather than imported from the orchestrator implementation) to keep this
 * types module free of any dependency on runtime code.
 */
export interface EpisodeFailure {
  agent: string;
  phase: string;
  error: string;
  timestamp: string;
}

/**
 * A single thing that was tried during an investigation and how it turned out.
 * This is the heart of "what worked / what failed / how it failed".
 */
export interface WatchlistAttempt {
  /** Human-readable description of the approach (e.g. a patch id or phase). */
  approach: string;
  /** Whether this approach succeeded. */
  result: 'worked' | 'failed';
  /** If it failed, why — a rejection reason, stage error, or halt error. */
  how_it_failed?: string;
  /** Overfitting probability if this approach was a classified patch. */
  overfitting_probability?: number;
}

/** The concrete counterexample that triggered a proven bug. */
export interface WatchlistTrigger {
  input: unknown;
  observed_output: unknown;
  violated_postcondition?: string;
}

/** Summary of the approach that ultimately worked (an approved patch). */
export interface WatchlistOutcomeSummary {
  patch_id: string;
  overfitting_probability?: number;
  summary: string;
}

/**
 * One recorded episode — the raw, project-local memory of a single change.
 */
export interface WatchlistEpisode {
  id: string;
  investigation_id: string;
  created_at: string;
  source: EpisodeSource;
  language?: string;
  file_path: string;
  function_id: string;
  /** Coarse category of the defect (heuristic). */
  defect_class?: string;
  /** Specific failure signature (heuristic), e.g. `division_by_zero`. */
  failure_class?: string;
  outcome: EpisodeOutcome;
  /** Project-scoped lesson key: `<language>:<failure_class>:<function_id>`. */
  lesson_key: string;
  /** Cross-project generalized key: `<language>:<failure_class>:<signature_shape>`. */
  global_key: string;
  trigger?: WatchlistTrigger;
  attempts: WatchlistAttempt[];
  what_worked?: WatchlistOutcomeSummary;
  /** The failure detail the InvestigationReport drops (agent/phase/error). */
  failure_detail?: EpisodeFailure;
  timeline: unknown;
  intermediate_results: unknown;
  provenance: EpisodeProvenance;
}

/** Where an episode came from, for auditing and later retraction. */
export interface EpisodeProvenance {
  tool_version: string;
  /** Short, non-reversible hash of the project root (no path leaked). */
  project_hash: string;
}

/**
 * A distilled, cross-project lesson stored in the global index. Only lessons
 * corroborated across multiple distinct projects and sanitized of any raw
 * code, paths, or literal values are eligible for global promotion.
 */
export interface WatchlistLesson {
  global_key: string;
  language?: string;
  defect_class?: string;
  failure_class?: string;
  signature_shape?: string;
  title: string;
  /** Generalized, sanitized description. Never contains raw code or values. */
  detail: string;
  verified: boolean;
  occurrences: number;
  /** Distinct project hashes that produced this lesson (corroboration). */
  contexts: string[];
  /** Sanitized example trigger *shapes* (e.g. `<number>`), never real values. */
  example_trigger_shapes: string[];
  first_seen: string;
  last_updated: string;
}

/** On-disk shape of the global lesson index (`~/.buggy/watchlist-lessons.json`). */
export interface GlobalLessonIndex {
  version: number;
  lessons: Record<string, WatchlistLesson>;
}

/**
 * Everything the orchestrator hands to the recorder at the convergence point.
 * `failure` carries the detail that {@link InvestigationReport} discards.
 */
export interface EpisodeRecordInput {
  investigationId: string;
  target: InvestigationTarget;
  report: InvestigationReport;
  failure?: EpisodeFailure;
  source?: EpisodeSource;
  language?: string;
}

/**
 * Minimal interface the orchestrator depends on. Implemented by
 * `WatchlistRecorder`; keeping it here means the orchestrator imports only
 * types, never the recorder's runtime module (no import cycle).
 */
export interface EpisodeRecorder {
  record(input: EpisodeRecordInput): void;
}

// ─── Retrieval (read path) ───────────────────────────────────────────────────

/** What the caller knows about the code they are about to touch. */
export interface RecallCriteria {
  language?: string;
  function_id?: string;
  file_path?: string;
  failure_class?: string;
  defect_class?: string;
  /** Cap on returned lessons (default 10). */
  limit?: number;
}

/** Which memory tier a recalled lesson came from. */
export type RecallTier = 'project' | 'global';

/** A single lesson returned by a recall query, flattened for consumption. */
export interface RecalledLesson {
  tier: RecallTier;
  title: string;
  failure_class?: string;
  defect_class?: string;
  function_id?: string;
  /** Present for project-tier lessons; omitted for sanitized global lessons. */
  file_path?: string;
  /** Summary of the approach that worked, if a fix was approved. */
  what_worked?: string;
  /** How prior attempts failed (rejection reasons, stage/halt errors). */
  what_failed?: string[];
  /** Sanitized shape of the triggering input (e.g. `<number>`). */
  trigger_shape?: string;
  /** Generalized guidance (global tier). */
  detail?: string;
  occurrences: number;
  /** For global lessons: number of distinct projects it was seen in. */
  projects?: number;
  last_seen?: string;
}

/** Result of a recall query. Project-tier lessons precede global ones. */
export interface RecallResult {
  criteria: RecallCriteria;
  lessons: RecalledLesson[];
  /** True when a prior lesson already existed for this exact target. */
  seen_before: boolean;
}

/** Aggregate health/efficacy metrics for the watchlist. */
export interface WatchlistStats {
  total_episodes: number;
  verified_episodes: number;
  distinct_lessons: number;
  /** Episode counts keyed by outcome status. */
  outcomes: Record<string, number>;
  /** Lessons that recurred most — a high count may mean fixes aren't sticking. */
  top_recurring: Array<{ lesson_key: string; occurrences: number }>;
  global_lessons: number;
  global_corroborated: number;
}
