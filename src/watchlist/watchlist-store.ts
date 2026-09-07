/**
 * WatchlistStore — the retrieval (read) side of the experience memory.
 *
 * Given what the caller knows about the code they're about to touch, it returns
 * the most relevant prior lessons, merging the project-local tier (verified
 * episodes in the graph DB) with the cross-project global tier (the sanitized
 * `~/.buggy` index). Project lessons take precedence over global ones.
 *
 * This is what closes the loop: the recorder writes lessons after each change,
 * the store feeds them back before the next one — via `ProofDebugger.recall`
 * and the `buggy_recall` MCP tool that Kiro consults.
 *
 * @module watchlist/watchlist-store
 */

import type Database from 'better-sqlite3';
import { homedir } from 'node:os';

import type {
  GlobalLessonIndex,
  RecallCriteria,
  RecalledLesson,
  RecallResult,
  WatchlistAttempt,
  WatchlistStats,
} from '../types/watchlist.js';
import { globalIndexPath, readJsonFile } from './watchlist-paths.js';

const DEFAULT_LIMIT = 10;
const VERIFIED_OUTCOMES = "('confirmed_and_repaired', 'confirmed_no_repair')";

/**
 * A global lesson is only surfaced once corroborated across this many distinct
 * projects — the same bar used to promote it into the global steering file.
 * Single-project lessons remain available through the project tier only.
 */
const GLOBAL_MIN_CONTEXTS = 2;

/** Row shape read from `watchlist_episodes` during recall. */
interface RecallRow {
  lesson_key: string;
  function_id: string;
  file_path: string;
  failure_class: string | null;
  defect_class: string | null;
  outcome: string;
  trigger_json: string | null;
  attempts_json: string | null;
  what_worked_json: string | null;
  created_at: string;
}

export interface WatchlistStoreOptions {
  globalHome?: string;
}

export class WatchlistStore {
  private readonly db: Database.Database;
  private readonly globalHome: string;

  constructor(db: Database.Database, options: WatchlistStoreOptions = {}) {
    this.db = db;
    this.globalHome = options.globalHome ?? homedir();
  }

  /**
   * Retrieve relevant prior lessons. Never throws — returns an empty result on
   * any read error so a failed lookup can't disrupt the caller.
   */
  recall(criteria: RecallCriteria): RecallResult {
    const limit = criteria.limit ?? DEFAULT_LIMIT;
    let projectLessons: RecalledLesson[] = [];
    let globalLessons: RecalledLesson[] = [];

    try {
      projectLessons = this.queryProject(criteria);
    } catch {
      projectLessons = [];
    }
    try {
      globalLessons = this.queryGlobal(criteria);
    } catch {
      globalLessons = [];
    }

    // Project precedence: drop global lessons whose failure_class is already
    // covered by a project lesson, so local knowledge wins on conflict.
    const projectFailureClasses = new Set(
      projectLessons.map((l) => l.failure_class).filter(Boolean)
    );
    const dedupedGlobal = globalLessons.filter(
      (g) => !projectFailureClasses.has(g.failure_class)
    );

    const lessons = [...projectLessons, ...dedupedGlobal].slice(0, limit);
    const seenBefore = criteria.function_id
      ? projectLessons.some((l) => l.function_id === criteria.function_id)
      : projectLessons.length > 0;

    return { criteria, lessons, seen_before: seenBefore };
  }

  /** Aggregate metrics for measuring whether the memory is helping over time. */
  stats(): WatchlistStats {
    const empty: WatchlistStats = {
      total_episodes: 0,
      verified_episodes: 0,
      distinct_lessons: 0,
      outcomes: {},
      top_recurring: [],
      global_lessons: 0,
      global_corroborated: 0,
    };

    try {
      const total = this.scalar('SELECT COUNT(*) AS n FROM watchlist_episodes');
      const verified = this.scalar(
        `SELECT COUNT(*) AS n FROM watchlist_episodes WHERE outcome IN ${VERIFIED_OUTCOMES}`
      );
      const distinct = this.scalar(
        'SELECT COUNT(DISTINCT lesson_key) AS n FROM watchlist_episodes'
      );

      const outcomeRows = this.db
        .prepare('SELECT outcome, COUNT(*) AS n FROM watchlist_episodes GROUP BY outcome')
        .all() as Array<{ outcome: string; n: number }>;
      const outcomes: Record<string, number> = {};
      for (const row of outcomeRows) outcomes[row.outcome] = row.n;

      const recurringRows = this.db
        .prepare(
          `SELECT lesson_key, COUNT(*) AS n
             FROM watchlist_episodes
            WHERE outcome IN ${VERIFIED_OUTCOMES}
            GROUP BY lesson_key
            ORDER BY n DESC
            LIMIT 5`
        )
        .all() as Array<{ lesson_key: string; n: number }>;
      const topRecurring = recurringRows.map((r) => ({
        lesson_key: r.lesson_key,
        occurrences: r.n,
      }));

      const index = readJsonFile<GlobalLessonIndex>(globalIndexPath(this.globalHome));
      const globalValues = index ? Object.values(index.lessons) : [];

      return {
        total_episodes: total,
        verified_episodes: verified,
        distinct_lessons: distinct,
        outcomes,
        top_recurring: topRecurring,
        global_lessons: globalValues.length,
        global_corroborated: globalValues.filter((l) => l.contexts.length >= 2).length,
      };
    } catch {
      return empty;
    }
  }

  // ─── Internals ───────────────────────────────────────────────────────────────

  private queryProject(criteria: RecallCriteria): RecalledLesson[] {
    const clauses: string[] = [`outcome IN ${VERIFIED_OUTCOMES}`];
    const params: Record<string, unknown> = {};

    if (criteria.function_id) {
      clauses.push('function_id = @function_id');
      params.function_id = criteria.function_id;
    }
    if (criteria.file_path) {
      clauses.push('file_path = @file_path');
      params.file_path = criteria.file_path;
    }
    if (criteria.language) {
      clauses.push('language = @language');
      params.language = criteria.language;
    }
    if (criteria.failure_class) {
      clauses.push('failure_class = @failure_class');
      params.failure_class = criteria.failure_class;
    }
    if (criteria.defect_class) {
      clauses.push('defect_class = @defect_class');
      params.defect_class = criteria.defect_class;
    }

    const rows = this.db
      .prepare(
        `SELECT lesson_key, function_id, file_path, failure_class, defect_class, outcome,
                trigger_json, attempts_json, what_worked_json, created_at
           FROM watchlist_episodes
          WHERE ${clauses.join(' AND ')}
          ORDER BY created_at DESC
          LIMIT 500`
      )
      .all(params) as RecallRow[];

    // Collapse to one lesson per lesson_key (latest wins), counting occurrences.
    const byKey = new Map<string, { row: RecallRow; count: number }>();
    for (const row of rows) {
      const existing = byKey.get(row.lesson_key);
      if (existing) existing.count += 1;
      else byKey.set(row.lesson_key, { row, count: 1 });
    }

    return [...byKey.values()]
      .sort((a, b) => b.count - a.count || b.row.created_at.localeCompare(a.row.created_at))
      .map(({ row, count }) => this.toProjectLesson(row, count));
  }

  private toProjectLesson(row: RecallRow, count: number): RecalledLesson {
    const worked = parseJson<{ summary?: string }>(row.what_worked_json);
    const attempts = parseJson<WatchlistAttempt[]>(row.attempts_json) ?? [];
    const trigger = parseJson<{ input?: unknown }>(row.trigger_json);

    const whatFailed = attempts
      .filter((a) => a.result === 'failed' && a.how_it_failed)
      .map((a) => a.how_it_failed as string);

    return {
      tier: 'project',
      title: `${row.failure_class ?? 'defect'} in ${row.function_id}`,
      failure_class: row.failure_class ?? undefined,
      defect_class: row.defect_class ?? undefined,
      function_id: row.function_id,
      file_path: row.file_path,
      what_worked: worked?.summary,
      what_failed: whatFailed.length > 0 ? whatFailed : undefined,
      trigger_shape: trigger ? truncate(stringify(trigger.input), 120) : undefined,
      occurrences: count,
      last_seen: row.created_at,
    };
  }

  private queryGlobal(criteria: RecallCriteria): RecalledLesson[] {
    const index = readJsonFile<GlobalLessonIndex>(globalIndexPath(this.globalHome));
    if (!index) return [];

    return Object.values(index.lessons)
      .filter((l) => {
        // Only surface lessons corroborated across multiple projects.
        if (l.contexts.length < GLOBAL_MIN_CONTEXTS) return false;
        if (criteria.failure_class && l.failure_class !== criteria.failure_class) return false;
        if (criteria.defect_class && l.defect_class !== criteria.defect_class) return false;
        if (criteria.language && l.language && l.language !== criteria.language) return false;
        return true;
      })
      .sort((a, b) => b.contexts.length - a.contexts.length || b.occurrences - a.occurrences)
      .map((l) => ({
        tier: 'global' as const,
        title: l.title,
        failure_class: l.failure_class,
        defect_class: l.defect_class,
        detail: l.detail,
        trigger_shape:
          l.example_trigger_shapes.length > 0 ? l.example_trigger_shapes.join(', ') : undefined,
        occurrences: l.occurrences,
        projects: l.contexts.length,
        last_seen: l.last_updated,
      }));
  }

  private scalar(sql: string): number {
    const row = this.db.prepare(sql).get() as { n: number } | undefined;
    return row?.n ?? 0;
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function parseJson<T>(json: string | null): T | undefined {
  if (!json) return undefined;
  try {
    return JSON.parse(json) as T;
  } catch {
    return undefined;
  }
}

function stringify(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}
