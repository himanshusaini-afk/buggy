/**
 * Advisor types — retrospection over the Watchlist, and capability proposals
 * derived from it.
 *
 * The Watchlist already answers "what did we try, what worked, how did it fail".
 * These types cover the two things it could not:
 *
 *  1. **Did the memory actually help?** A lesson that keeps reappearing is a
 *     lesson that is not working. {@link RetrospectiveReport} measures that by
 *     walking each lesson's episode timeline and asking whether the defect came
 *     back *after* a fix was approved for it.
 *
 *  2. **What capability is missing?** When the same defect class recurs in the
 *     same files, the right response is usually a new guardrail — a hook that
 *     fires earlier, or a steering rule that teaches the agent the pattern.
 *     {@link CapabilitySuggestion} carries a ready-to-write proposal so the
 *     answer is actionable rather than advisory.
 *
 * Nothing here writes anything on its own. Proposals are generated, ranked and
 * returned; applying one is always a separate, explicit call.
 *
 * @module types/advisor
 */

// ─── Retrospection ───────────────────────────────────────────────────────────

/**
 * Whether a lesson is doing its job.
 *
 * - `held`      — a fix was approved and the defect has not recurred since.
 * - `regressed` — a fix was approved, then the same defect was proven again.
 *                 The memory existed and did not prevent it.
 * - `unresolved` — proven repeatedly but never had an approved fix.
 * - `open`      — proven once, no fix yet, no recurrence. Too early to judge.
 */
export type LessonStatus = 'held' | 'regressed' | 'unresolved' | 'open';

/**
 * One lesson's trajectory over time, derived from its ordered episodes.
 */
export interface LessonOutcome {
  lesson_key: string;
  function_id: string;
  file_path: string;
  failure_class?: string;
  defect_class?: string;
  status: LessonStatus;
  /** Total verified episodes carrying this key. */
  occurrences: number;
  /** Verified episodes recorded *after* the first approved fix for this key. */
  recurrences_after_fix: number;
  /** ISO timestamp of the first verified episode. */
  first_seen: string;
  /** ISO timestamp of the most recent verified episode. */
  last_seen: string;
  /** When a fix was first approved for this key, if ever. */
  first_fixed_at?: string;
  /** Whole days between first proof and first approved fix. */
  days_to_first_fix?: number;
  /** Lowest overfitting probability among approved fixes — best patch quality. */
  best_overfitting_probability?: number;
}

/**
 * An approach that failed more than once across the project. Recording these is
 * the difference between "here is a fix" and "here is a fix, and here is what
 * not to bother trying again".
 */
export interface DeadEnd {
  /** Normalised description of how the approach failed. */
  reason: string;
  /** How many times an attempt failed this way. */
  occurrences: number;
  /** Distinct functions where it failed. */
  affected_functions: string[];
}

/** A file carrying a disproportionate share of proven defects. */
export interface Hotspot {
  file_path: string;
  /** Verified episodes recorded against this file. */
  proven_defects: number;
  /** Distinct functions in this file with proven defects. */
  distinct_functions: number;
  /** Failure classes seen here, most frequent first. */
  failure_classes: string[];
  /** Lessons in this file that regressed after being fixed. */
  regressions: number;
}

/**
 * The retrospective: what the memory has learned, and whether it is working.
 */
export interface RetrospectiveReport {
  generated_at: string;
  /** Episodes considered (verified only — unproven runs teach nothing). */
  analysed_episodes: number;
  /**
   * Share of judgeable lessons that held, in [0, 1]. Computed over
   * `held + regressed` only: `open` and `unresolved` lessons have no verdict
   * yet, and counting them would dilute the signal in either direction.
   * `null` when nothing is judgeable yet.
   */
  improvement_score: number | null;
  lessons: LessonOutcome[];
  /** Lessons that came back after being fixed. The highest-value signal here. */
  regressions: LessonOutcome[];
  /** Proven defects still carrying no approved fix. */
  unresolved: LessonOutcome[];
  dead_ends: DeadEnd[];
  hotspots: Hotspot[];
  /** Plain-language readings of the above, safe to show a human verbatim. */
  observations: string[];
}

// ─── Capability proposals ────────────────────────────────────────────────────

/** What kind of artefact a proposal would create. */
export type CapabilityKind = 'hook' | 'steering' | 'skill';

/** How strongly the evidence supports acting on a proposal. */
export type CapabilityPriority = 'high' | 'medium' | 'low';

/**
 * Observable facts about the project, gathered once and shared by every
 * advisor rule so they all reason from the same picture.
 */
export interface ProjectSignals {
  project_root: string;
  /** Configured language, which also selects the runtime. */
  language: string;
  /** Hook ids already present in `.kiro/hooks/`. */
  existing_hooks: string[];
  /** Steering file names already present in `.kiro/steering/`. */
  existing_steering: string[];
  /** Skill names already present in `.kiro/skills/`. */
  existing_skills: string[];
  /** Whether a test runner is configured in package.json. */
  has_test_script: boolean;
  /** Failure classes seen in verified episodes, descending by count. */
  failure_classes: Array<{ failure_class: string; occurrences: number }>;
  /** Defect classes seen in verified episodes, descending by count. */
  defect_classes: Array<{ defect_class: string; occurrences: number }>;
  hotspots: Hotspot[];
  regressions: LessonOutcome[];
  unresolved: LessonOutcome[];
  dead_ends: DeadEnd[];
  total_verified: number;
}

/**
 * A concrete, reviewable proposal for a new capability.
 *
 * `content` is the finished file body, so accepting a proposal is a write
 * rather than a design exercise. `target_path` is relative to the project root.
 */
export interface CapabilitySuggestion {
  /** Stable identifier, used to apply a specific proposal later. */
  id: string;
  kind: CapabilityKind;
  title: string;
  /** One sentence on what it does. */
  summary: string;
  /**
   * Why this is being proposed, stated in terms of observed evidence —
   * e.g. "division_by_zero was proven 4 times across 3 files".
   */
  rationale: string;
  priority: CapabilityPriority;
  /** Path the artefact would be written to, relative to the project root. */
  target_path: string;
  /** Finished file content. */
  content: string;
  /** Episode/lesson keys that motivated this proposal, for auditing. */
  evidence: string[];
}

/** Result of asking the advisor what the project is missing. */
export interface CapabilityAdvice {
  generated_at: string;
  signals_summary: {
    language: string;
    total_verified: number;
    top_failure_class?: string;
    hotspot_count: number;
    regression_count: number;
  };
  suggestions: CapabilitySuggestion[];
  /** Why certain obvious proposals were skipped (usually: already present). */
  skipped: Array<{ id: string; reason: string }>;
}

/** Outcome of writing a proposal to disk. */
export interface CapabilityApplyResult {
  id: string;
  written: boolean;
  target_path: string;
  /** Set when `written` is false. */
  reason?: string;
}
