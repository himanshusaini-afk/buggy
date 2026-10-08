/**
 * Retrospective — asks whether the experience memory is actually working.
 *
 * {@link WatchlistStore} answers "what do we know about this function?".
 * This module answers the harder question: *did knowing it help?*
 *
 * The method is to stop treating episodes as a bag of records and read them as
 * a timeline per lesson. A lesson that was proven, fixed, and then proven again
 * is a **regression**: the memory existed, the agent had access to it, and the
 * defect still came back. That is the single most useful signal the Watchlist
 * can produce, and nothing was reading it.
 *
 * Only verified episodes are analysed. An `unconfirmed` run means the prover
 * found nothing, which teaches nothing about whether a fix held; including them
 * would inflate every denominator with noise.
 *
 * @module watchlist/retrospective
 */

import type Database from 'better-sqlite3';

import type {
  DeadEnd,
  Hotspot,
  LessonOutcome,
  LessonStatus,
  RetrospectiveReport,
} from '../types/advisor.js';
import type { WatchlistAttempt } from '../types/watchlist.js';

/** Outcomes that represent a defect actually proven to exist. */
const VERIFIED_OUTCOMES = "('confirmed_and_repaired', 'confirmed_no_repair')";

/** A failure reason must appear at least this often to count as a dead end. */
const DEAD_END_MIN_OCCURRENCES = 2;

/** Cap on how many dead ends and hotspots are reported. */
const MAX_REPORTED = 20;

/** Milliseconds in a day, for the time-to-fix calculation. */
const MS_PER_DAY = 86_400_000;

/** Row shape read from `watchlist_episodes`. */
interface EpisodeRow {
  lesson_key: string;
  function_id: string;
  file_path: string;
  failure_class: string | null;
  defect_class: string | null;
  outcome: string;
  attempts_json: string | null;
  what_worked_json: string | null;
  created_at: string;
}

export class Retrospective {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /**
   * Analyse the full episode history.
   *
   * Never throws: a malformed or missing table yields an empty report rather
   * than breaking the caller, matching the rest of the Watchlist's behaviour as
   * a non-fatal side-channel.
   */
  analyse(): RetrospectiveReport {
    const generated_at = new Date().toISOString();

    let rows: EpisodeRow[];
    try {
      rows = this.db
        .prepare(
          `SELECT lesson_key, function_id, file_path, failure_class, defect_class,
                  outcome, attempts_json, what_worked_json, created_at
             FROM watchlist_episodes
            WHERE outcome IN ${VERIFIED_OUTCOMES}
            ORDER BY created_at ASC`
        )
        .all() as EpisodeRow[];
    } catch {
      return emptyReport(generated_at);
    }

    if (rows.length === 0) return emptyReport(generated_at);

    const lessons = buildLessonOutcomes(rows);
    const regressions = lessons.filter((l) => l.status === 'regressed');
    const unresolved = lessons.filter((l) => l.status === 'unresolved');
    const held = lessons.filter((l) => l.status === 'held');

    // Judgeable lessons only. `open` has had no fix attempt and `unresolved`
    // never got one, so neither can speak to whether a fix *held*.
    const judgeable = held.length + regressions.length;
    const improvement_score = judgeable > 0 ? held.length / judgeable : null;

    const dead_ends = buildDeadEnds(rows);
    const hotspots = buildHotspots(rows, regressions);

    return {
      generated_at,
      analysed_episodes: rows.length,
      improvement_score,
      lessons,
      regressions,
      unresolved,
      dead_ends,
      hotspots,
      observations: buildObservations({
        total: rows.length,
        held: held.length,
        regressions,
        unresolved,
        dead_ends,
        hotspots,
        improvement_score,
      }),
    };
  }
}

// ─── Lesson timelines ────────────────────────────────────────────────────────

/**
 * Collapse episodes into one outcome per lesson key by reading each key's
 * episodes in chronological order.
 */
function buildLessonOutcomes(rows: EpisodeRow[]): LessonOutcome[] {
  const groups = new Map<string, EpisodeRow[]>();
  for (const row of rows) {
    const list = groups.get(row.lesson_key);
    if (list) list.push(row);
    else groups.set(row.lesson_key, [row]);
  }

  const outcomes: LessonOutcome[] = [];

  for (const [lesson_key, episodes] of groups) {
    // Rows arrive ordered by created_at ASC, so index 0 is the first sighting
    // and the last element is the most recent.
    const first = episodes[0]!;
    const last = episodes[episodes.length - 1]!;

    const firstFixed = episodes.find((e) => e.outcome === 'confirmed_and_repaired');

    // Episodes strictly after the first fix. String comparison is valid here
    // because every timestamp is ISO-8601 UTC, which sorts lexicographically.
    const recurrences_after_fix = firstFixed
      ? episodes.filter((e) => e.created_at > firstFixed.created_at).length
      : 0;

    outcomes.push({
      lesson_key,
      function_id: last.function_id,
      file_path: last.file_path,
      failure_class: last.failure_class ?? undefined,
      defect_class: last.defect_class ?? undefined,
      status: deriveStatus(!!firstFixed, recurrences_after_fix, episodes.length),
      occurrences: episodes.length,
      recurrences_after_fix,
      first_seen: first.created_at,
      last_seen: last.created_at,
      first_fixed_at: firstFixed?.created_at,
      days_to_first_fix: firstFixed
        ? daysBetween(first.created_at, firstFixed.created_at)
        : undefined,
      best_overfitting_probability: bestOverfitting(episodes),
    });
  }

  // Worst first: regressions, then most-recurring, then most recent.
  const rank: Record<LessonStatus, number> = {
    regressed: 0,
    unresolved: 1,
    open: 2,
    held: 3,
  };
  outcomes.sort(
    (a, b) =>
      rank[a.status] - rank[b.status] ||
      b.occurrences - a.occurrences ||
      b.last_seen.localeCompare(a.last_seen)
  );

  return outcomes;
}

function deriveStatus(
  wasFixed: boolean,
  recurrencesAfterFix: number,
  totalOccurrences: number
): LessonStatus {
  if (wasFixed) return recurrencesAfterFix > 0 ? 'regressed' : 'held';
  return totalOccurrences > 1 ? 'unresolved' : 'open';
}

/** Lowest overfitting probability across approved fixes for a lesson. */
function bestOverfitting(episodes: EpisodeRow[]): number | undefined {
  let best: number | undefined;
  for (const episode of episodes) {
    const worked = parseJson<{ overfitting_probability?: number }>(episode.what_worked_json);
    const prob = worked?.overfitting_probability;
    if (typeof prob === 'number' && prob >= 0 && (best === undefined || prob < best)) {
      best = prob;
    }
  }
  return best;
}

function daysBetween(fromIso: string, toIso: string): number | undefined {
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (Number.isNaN(from) || Number.isNaN(to)) return undefined;
  return Math.max(0, Math.round((to - from) / MS_PER_DAY));
}

// ─── Dead ends ───────────────────────────────────────────────────────────────

/**
 * Aggregate repeatedly-failing approaches.
 *
 * Reasons are normalised before counting because the raw strings embed patch
 * UUIDs and line numbers; without normalisation every failure looks unique and
 * nothing ever reaches the recurrence threshold.
 */
function buildDeadEnds(rows: EpisodeRow[]): DeadEnd[] {
  const byReason = new Map<string, { occurrences: number; functions: Set<string> }>();

  for (const row of rows) {
    const attempts = parseJson<WatchlistAttempt[]>(row.attempts_json) ?? [];
    for (const attempt of attempts) {
      if (attempt.result !== 'failed' || !attempt.how_it_failed) continue;

      const reason = normaliseReason(attempt.how_it_failed);
      if (!reason) continue;

      const entry = byReason.get(reason);
      if (entry) {
        entry.occurrences += 1;
        entry.functions.add(row.function_id);
      } else {
        byReason.set(reason, { occurrences: 1, functions: new Set([row.function_id]) });
      }
    }
  }

  return [...byReason.entries()]
    .filter(([, v]) => v.occurrences >= DEAD_END_MIN_OCCURRENCES)
    .sort((a, b) => b[1].occurrences - a[1].occurrences)
    .slice(0, MAX_REPORTED)
    .map(([reason, v]) => ({
      reason,
      occurrences: v.occurrences,
      affected_functions: [...v.functions].sort(),
    }));
}

/**
 * Strip the parts of a failure reason that are unique to one run so equivalent
 * failures collapse together: UUIDs, hex ids, line/column refs and digits.
 */
function normaliseReason(raw: string): string {
  const cleaned = raw
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>')
    .replace(/\b[0-9a-f]{7,}\b/gi, '<hash>')
    .replace(/:\d+(:\d+)?\b/g, ':<line>')
    .replace(/\b\d+(\.\d+)?\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim();

  return cleaned.length > 180 ? `${cleaned.slice(0, 180)}…` : cleaned;
}

// ─── Hotspots ────────────────────────────────────────────────────────────────

function buildHotspots(rows: EpisodeRow[], regressions: LessonOutcome[]): Hotspot[] {
  const regressionsByFile = new Map<string, number>();
  for (const r of regressions) {
    regressionsByFile.set(r.file_path, (regressionsByFile.get(r.file_path) ?? 0) + 1);
  }

  const byFile = new Map<
    string,
    { count: number; functions: Set<string>; classes: Map<string, number> }
  >();

  for (const row of rows) {
    let entry = byFile.get(row.file_path);
    if (!entry) {
      entry = { count: 0, functions: new Set(), classes: new Map() };
      byFile.set(row.file_path, entry);
    }
    entry.count += 1;
    entry.functions.add(row.function_id);
    if (row.failure_class) {
      entry.classes.set(row.failure_class, (entry.classes.get(row.failure_class) ?? 0) + 1);
    }
  }

  return [...byFile.entries()]
    .map(([file_path, v]) => ({
      file_path,
      proven_defects: v.count,
      distinct_functions: v.functions.size,
      failure_classes: [...v.classes.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([name]) => name),
      regressions: regressionsByFile.get(file_path) ?? 0,
    }))
    // Regressions dominate the ordering: a file where fixes do not stick is
    // more urgent than a file with more one-off defects.
    .sort(
      (a, b) =>
        b.regressions - a.regressions ||
        b.proven_defects - a.proven_defects ||
        b.distinct_functions - a.distinct_functions
    )
    .slice(0, MAX_REPORTED);
}

// ─── Observations ────────────────────────────────────────────────────────────

function buildObservations(input: {
  total: number;
  held: number;
  regressions: LessonOutcome[];
  unresolved: LessonOutcome[];
  dead_ends: DeadEnd[];
  hotspots: Hotspot[];
  improvement_score: number | null;
}): string[] {
  const out: string[] = [];
  const { total, held, regressions, unresolved, dead_ends, hotspots, improvement_score } = input;

  out.push(`${total} proven defect${total === 1 ? '' : 's'} recorded so far.`);

  if (improvement_score === null) {
    out.push(
      'No fix has been approved yet, so there is nothing to judge. The score appears once a lesson has been fixed and had a chance to recur.'
    );
  } else {
    const pct = Math.round(improvement_score * 100);
    out.push(
      `${pct}% of fixed lessons have held (${held} held, ${regressions.length} came back).`
    );
    if (improvement_score < 0.5 && regressions.length > 0) {
      out.push(
        'More than half of the approved fixes did not stick. That usually points at patches that addressed the triggering input rather than the underlying cause.'
      );
    }
  }

  if (regressions.length > 0) {
    const worst = regressions[0]!;
    out.push(
      `Worst regression: ${worst.failure_class ?? 'defect'} in \`${worst.function_id}\` came back ${worst.recurrences_after_fix} time${worst.recurrences_after_fix === 1 ? '' : 's'} after being fixed.`
    );
  }

  if (unresolved.length > 0) {
    out.push(
      `${unresolved.length} defect${unresolved.length === 1 ? '' : 's'} proven more than once with no approved fix — every candidate patch was rejected.`
    );
  }

  if (dead_ends.length > 0) {
    out.push(
      `${dead_ends.length} repeated dead end${dead_ends.length === 1 ? '' : 's'} identified; the most common failed ${dead_ends[0]!.occurrences} times.`
    );
  }

  const risky = hotspots.filter((h) => h.distinct_functions >= 2);
  if (risky.length > 0) {
    out.push(
      `${risky[0]!.file_path} carries ${risky[0]!.proven_defects} proven defects across ${risky[0]!.distinct_functions} functions.`
    );
  }

  return out;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function emptyReport(generated_at: string): RetrospectiveReport {
  return {
    generated_at,
    analysed_episodes: 0,
    improvement_score: null,
    lessons: [],
    regressions: [],
    unresolved: [],
    dead_ends: [],
    hotspots: [],
    observations: ['No proven defects recorded yet — run an investigation first.'],
  };
}

function parseJson<T>(json: string | null): T | undefined {
  if (!json) return undefined;
  try {
    return JSON.parse(json) as T;
  } catch {
    return undefined;
  }
}
