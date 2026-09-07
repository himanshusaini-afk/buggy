/**
 * WatchlistRecorder — writes one experience-memory *episode* per investigation
 * and distills verified episodes into shareable *lessons*.
 *
 * Called from the orchestrator's `buildReport` convergence point with the full
 * investigation state, so it can capture the failure detail the
 * `InvestigationReport` normally drops.
 *
 * Layered scope (default):
 *  - local:  every episode → `watchlist_episodes` table in `.debugger/graph.db`.
 *  - team:   verified lessons → `<project>/.kiro/steering/buggy-watchlist.md`.
 *  - global: generalized + sanitized lessons corroborated across ≥2 projects →
 *            `~/.buggy/watchlist-lessons.json` + `~/.kiro/steering/buggy-watchlist-global.md`.
 *
 * Recording is a non-fatal side-channel: any failure here is swallowed so it
 * can never break an investigation.
 *
 * @module watchlist/watchlist-recorder
 */

import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname } from 'node:path';

import {
  globalDir,
  globalIndexPath,
  globalSteeringPath,
  readJsonFile,
  teamSteeringPath,
} from './watchlist-paths.js';

import type {
  EpisodeFailure,
  EpisodeRecordInput,
  EpisodeRecorder,
  GlobalLessonIndex,
  WatchlistAttempt,
  WatchlistEpisode,
  WatchlistLesson,
  WatchlistScope,
} from '../types/watchlist.js';
import type { InvestigationReport, InvestigationTarget } from '../types/orchestrator.js';

const WATCHLIST_TOOL_VERSION = '0.1.0';

/** Maximum lessons rendered into a steering file. */
const MAX_STEERING_ENTRIES = 50;

/** Distinct projects a lesson must appear in before it is promoted globally. */
const GLOBAL_CORROBORATION_THRESHOLD = 2;

export interface WatchlistRecorderOptions {
  /** Absolute path to the project root (used for the team steering file + hashing). */
  projectRoot: string;
  /** Sharing scope. Defaults to `layered`. */
  scope?: WatchlistScope;
  /** Master on/off switch. Defaults to true. */
  enabled?: boolean;
  /** Tool version stamped into provenance. */
  toolVersion?: string;
  /** Override the user-home directory for the global tier (mainly for tests). */
  globalHome?: string;
  /** Project language, stamped onto episodes when the caller doesn't supply one. */
  language?: string;
}

/** Row shape read back from `watchlist_episodes`. */
interface EpisodeRow {
  lesson_key: string;
  language: string | null;
  file_path: string;
  function_id: string;
  failure_class: string | null;
  defect_class: string | null;
  outcome: string;
  trigger_json: string | null;
  what_worked_json: string | null;
  created_at: string;
}

export class WatchlistRecorder implements EpisodeRecorder {
  private readonly db: Database.Database;
  private readonly projectRoot: string;
  private readonly scope: WatchlistScope;
  private readonly enabled: boolean;
  private readonly toolVersion: string;
  private readonly globalHome: string;
  private readonly language?: string;
  private readonly projectHash: string;

  constructor(db: Database.Database, options: WatchlistRecorderOptions) {
    this.db = db;
    this.projectRoot = options.projectRoot;
    this.scope = options.scope ?? 'layered';
    this.enabled = options.enabled ?? true;
    this.toolVersion = options.toolVersion ?? WATCHLIST_TOOL_VERSION;
    this.globalHome = options.globalHome ?? homedir();
    this.language = options.language;
    this.projectHash = shortHash(this.projectRoot);
  }

  /**
   * Record a single investigation as an episode, then update the team and
   * global tiers as configured. Never throws.
   */
  record(input: EpisodeRecordInput): void {
    if (!this.enabled) return;

    try {
      const episode = this.buildEpisode(input);
      this.persistEpisode(episode);

      const verified = !!input.report.proof;
      if (!verified) return; // only verified episodes are promoted to lessons

      if (this.includesTeam()) {
        this.safely(() => this.regenerateTeamSteering());
      }
      if (this.includesGlobal()) {
        this.safely(() => this.updateGlobalTier(episode));
      }
    } catch {
      // Memory is a non-fatal side-channel — swallow everything.
    }
  }

  // ─── Episode construction ──────────────────────────────────────────────────

  private buildEpisode(input: EpisodeRecordInput): WatchlistEpisode {
    const { report, target, failure } = input;
    const failureClass = deriveFailureClass(report, failure);
    const defectClass = deriveDefectClass(failureClass);
    const sigShape = signatureShape(target);
    const language = input.language ?? this.language;

    return {
      id: `ep_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      investigation_id: input.investigationId,
      created_at: new Date().toISOString(),
      source: input.source ?? 'buggy_investigate',
      language,
      file_path: target.file_path,
      function_id: target.function_id,
      defect_class: defectClass,
      failure_class: failureClass,
      outcome: report.status,
      lesson_key: `${language ?? 'unknown'}:${failureClass}:${target.function_id}`,
      global_key: `${language ?? 'unknown'}:${failureClass}:${sigShape}`,
      trigger: report.proof
        ? {
            input: report.proof.test_input,
            observed_output: report.proof.observed_output,
            violated_postcondition: report.proof.violated_postcondition,
          }
        : undefined,
      attempts: buildAttempts(report, failure),
      what_worked: buildWhatWorked(report),
      failure_detail: failure,
      timeline: report.timeline,
      intermediate_results: report.intermediate_results,
      provenance: { tool_version: this.toolVersion, project_hash: this.projectHash },
    };
  }

  private persistEpisode(ep: WatchlistEpisode): void {
    const stmt = this.db.prepare(`
      INSERT INTO watchlist_episodes (
        id, investigation_id, source, language, file_path, function_id,
        defect_class, failure_class, outcome, lesson_key, global_key,
        trigger_json, attempts_json, what_worked_json, failure_detail_json,
        timeline_json, intermediate_results_json, provenance_json
      ) VALUES (
        @id, @investigation_id, @source, @language, @file_path, @function_id,
        @defect_class, @failure_class, @outcome, @lesson_key, @global_key,
        @trigger_json, @attempts_json, @what_worked_json, @failure_detail_json,
        @timeline_json, @intermediate_results_json, @provenance_json
      )
    `);

    stmt.run({
      id: ep.id,
      investigation_id: ep.investigation_id,
      source: ep.source,
      language: ep.language ?? null,
      file_path: ep.file_path,
      function_id: ep.function_id,
      defect_class: ep.defect_class ?? null,
      failure_class: ep.failure_class ?? null,
      outcome: ep.outcome,
      lesson_key: ep.lesson_key,
      global_key: ep.global_key,
      trigger_json: ep.trigger ? safeSerialize(ep.trigger) : null,
      attempts_json: safeSerialize(ep.attempts),
      what_worked_json: ep.what_worked ? safeSerialize(ep.what_worked) : null,
      failure_detail_json: ep.failure_detail ? safeSerialize(ep.failure_detail) : null,
      timeline_json: safeSerialize(ep.timeline),
      intermediate_results_json: safeSerialize(ep.intermediate_results),
      provenance_json: safeSerialize(ep.provenance),
    });
  }

  // ─── Team tier (project-scoped, committed steering) ─────────────────────────

  private regenerateTeamSteering(): void {
    const rows = this.db
      .prepare(
        `SELECT lesson_key, language, file_path, function_id, failure_class, defect_class,
                outcome, trigger_json, what_worked_json, created_at
           FROM watchlist_episodes
          WHERE outcome IN ('confirmed_and_repaired', 'confirmed_no_repair')
          ORDER BY created_at DESC`
      )
      .all() as EpisodeRow[];

    if (rows.length === 0) return;

    // Collapse to one entry per lesson_key (latest wins), counting occurrences.
    const byKey = new Map<string, { row: EpisodeRow; count: number }>();
    for (const row of rows) {
      const existing = byKey.get(row.lesson_key);
      if (existing) existing.count += 1;
      else byKey.set(row.lesson_key, { row, count: 1 });
    }

    const entries = [...byKey.values()].slice(0, MAX_STEERING_ENTRIES);
    const markdown = renderTeamSteering(entries, this.projectRoot);

    const filePath = teamSteeringPath(this.projectRoot);
    ensureDir(dirname(filePath));
    writeFileSync(filePath, markdown, 'utf-8');
  }

  // ─── Global tier (cross-project, sanitized, user-level) ─────────────────────

  private updateGlobalTier(episode: WatchlistEpisode): void {
    ensureDir(globalDir(this.globalHome));
    const indexPath = globalIndexPath(this.globalHome);
    const index = readJsonFile<GlobalLessonIndex>(indexPath) ?? { version: 1, lessons: {} };

    const key = episode.global_key;
    const shape = episode.trigger ? valueShape(episode.trigger.input) : undefined;
    const existing = index.lessons[key];

    if (existing) {
      existing.occurrences += 1;
      if (!existing.contexts.includes(episode.provenance.project_hash)) {
        existing.contexts.push(episode.provenance.project_hash);
      }
      if (shape && !existing.example_trigger_shapes.includes(shape)) {
        existing.example_trigger_shapes.push(shape);
      }
      existing.last_updated = episode.created_at;
      existing.verified = true;
    } else {
      const lesson: WatchlistLesson = {
        global_key: key,
        language: episode.language,
        defect_class: episode.defect_class,
        failure_class: episode.failure_class,
        signature_shape: signatureShapeFromGlobalKey(key),
        title: `${episode.failure_class ?? 'defect'} in ${signatureShapeFromGlobalKey(key)}`,
        detail: generalizedDetail(episode),
        verified: true,
        occurrences: 1,
        contexts: [episode.provenance.project_hash],
        example_trigger_shapes: shape ? [shape] : [],
        first_seen: episode.created_at,
        last_updated: episode.created_at,
      };
      index.lessons[key] = lesson;
    }

    writeJson(indexPath, index);
    this.regenerateGlobalSteering(index);
  }

  private regenerateGlobalSteering(index: GlobalLessonIndex): void {
    const corroborated = Object.values(index.lessons)
      .filter((l) => l.contexts.length >= GLOBAL_CORROBORATION_THRESHOLD)
      .sort((a, b) => b.contexts.length - a.contexts.length || b.occurrences - a.occurrences)
      .slice(0, MAX_STEERING_ENTRIES);

    // Don't create an empty file in the user's home until something is corroborated.
    if (corroborated.length === 0) return;

    const markdown = renderGlobalSteering(corroborated);
    const filePath = globalSteeringPath(this.globalHome);
    ensureDir(dirname(filePath));
    writeFileSync(filePath, markdown, 'utf-8');
  }

  // ─── Scope helpers ──────────────────────────────────────────────────────────

  private includesTeam(): boolean {
    return this.scope === 'team' || this.scope === 'layered';
  }

  private includesGlobal(): boolean {
    return this.scope === 'global' || this.scope === 'layered';
  }

  private safely(fn: () => void): void {
    try {
      fn();
    } catch {
      // Individual tier failure must not block the others.
    }
  }
}

// ─── Pure helpers ──────────────────────────────────────────────────────────────

function buildAttempts(report: InvestigationReport, failure?: EpisodeFailure): WatchlistAttempt[] {
  const attempts: WatchlistAttempt[] = [];

  for (const rejected of report.rejected_patches ?? []) {
    attempts.push({
      approach: `patch ${rejected.patch.id}`,
      result: 'failed',
      how_it_failed: rejected.rejection_reason,
      overfitting_probability: rejected.classification?.overfitting_probability,
    });
  }
  for (const approved of report.approved_patches ?? []) {
    attempts.push({
      approach: `patch ${approved.patch.id}`,
      result: 'worked',
      overfitting_probability: approved.classification?.overfitting_probability,
    });
  }
  if (report.status === 'halted' && failure) {
    attempts.push({
      approach: `${failure.phase} phase (${failure.agent})`,
      result: 'failed',
      how_it_failed: failure.error,
    });
  }
  return attempts;
}

function buildWhatWorked(report: InvestigationReport): WatchlistEpisode['what_worked'] {
  const first = report.approved_patches?.[0];
  if (!first) return undefined;
  const prob = first.classification?.overfitting_probability;
  const pct = typeof prob === 'number' ? `${Math.round(prob * 100)}%` : 'n/a';
  return {
    patch_id: first.patch.id,
    overfitting_probability: prob,
    summary: `Approved fix (overfitting ${pct}): ${truncate(first.patch.diff ?? '', 200)}`,
  };
}

function deriveFailureClass(report: InvestigationReport, failure?: EpisodeFailure): string {
  if (report.status === 'halted') return failure ? `halted_in_${failure.phase}` : 'halted';
  if (report.status === 'unconfirmed') return 'unconfirmed';

  const haystack = [
    report.proof?.violated_postcondition,
    stringifyLoose(report.proof?.observed_output),
    failure?.error,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  if (/divi|\/\s*0|by zero/.test(haystack)) return 'division_by_zero';
  if (/\bnan\b/.test(haystack)) return 'nan_result';
  if (/infinit/.test(haystack)) return 'infinity_result';
  if (/overflow/.test(haystack)) return 'overflow';
  if (/negative|<\s*0|underflow/.test(haystack)) return 'negative_or_underflow';
  if (/undefined|null|cannot read/.test(haystack)) return 'null_or_undefined';
  if (/timeout|timed out|infinite loop/.test(haystack)) return 'timeout';
  if (/determin/.test(haystack)) return 'nondeterminism';
  if (/range|index|out of bounds/.test(haystack)) return 'out_of_bounds';
  return 'postcondition_violation';
}

function deriveDefectClass(failureClass: string): string {
  if (
    failureClass === 'division_by_zero' ||
    failureClass === 'nan_result' ||
    failureClass === 'infinity_result' ||
    failureClass === 'overflow' ||
    failureClass === 'negative_or_underflow'
  ) {
    return 'arithmetic';
  }
  if (failureClass === 'null_or_undefined') return 'null_safety';
  if (failureClass === 'timeout') return 'termination';
  if (failureClass === 'nondeterminism') return 'determinism';
  if (failureClass === 'out_of_bounds') return 'bounds';
  if (failureClass.startsWith('halted')) return 'incomplete';
  return 'contract';
}

function signatureShape(target: InvestigationTarget): string {
  const params = target.specification?.parameters ?? [];
  const types = params.map((p) => p.type || 'unknown').join(',');
  const ret = target.specification?.return_type ?? 'unknown';
  return `(${types})->${ret}`;
}

function signatureShapeFromGlobalKey(globalKey: string): string {
  // global_key = `<language>:<failure_class>:<signature_shape>`
  const parts = globalKey.split(':');
  return parts.slice(2).join(':') || 'unknown';
}

function generalizedDetail(episode: WatchlistEpisode): string {
  const fc = (episode.failure_class ?? 'defect').replace(/_/g, ' ');
  return `A proven ${fc} defect was observed for functions shaped ${signatureShapeFromGlobalKey(
    episode.global_key
  )}. Prefer input clamping / guard clauses over test-specific literal guards, and re-verify with a proof before trusting a fix.`;
}

/** Reduce any value to a type *shape* string — never leaks the value itself. */
function valueShape(v: unknown): string {
  if (v === null) return '<null>';
  if (v === undefined) return '<undefined>';
  if (Array.isArray(v)) return `<array[${v.length}]>`;
  switch (typeof v) {
    case 'number':
      return Number.isNaN(v) ? '<NaN>' : '<number>';
    case 'string':
      return '<string>';
    case 'boolean':
      return '<boolean>';
    case 'bigint':
      return '<bigint>';
    case 'object':
      return '<object>';
    default:
      return '<value>';
  }
}

// ─── Markdown rendering ──────────────────────────────────────────────────────

function renderTeamSteering(
  entries: Array<{ row: EpisodeRow; count: number }>,
  projectRoot: string
): string {
  const lines: string[] = [];
  lines.push('---');
  lines.push('inclusion: auto');
  lines.push('---');
  lines.push('');
  lines.push('# Buggy — Watchlist (Team Memory)');
  lines.push('');
  lines.push(
    '<!-- AUTO-GENERATED by the Buggy Watchlist. Do not edit by hand; this file is rewritten after every proven bug. -->'
  );
  lines.push('');
  lines.push(`_Last updated: ${new Date().toISOString()}_`);
  lines.push('');
  lines.push(
    'Verified, proof-backed lessons from investigations in this project. Kiro: consult these before editing or fixing the listed functions — reuse fixes that worked and avoid approaches that were rejected.'
  );
  lines.push('');
  lines.push('## Lessons');
  lines.push('');

  for (const { row, count } of entries) {
    const trigger = readLoose(row.trigger_json);
    const worked = readLoose(row.what_worked_json);
    const status =
      row.outcome === 'confirmed_and_repaired' ? 'Fixed ✓' : 'Proven, no approved fix yet';
    const file = relativize(row.file_path, projectRoot);

    lines.push(`### ${row.failure_class ?? 'defect'} in \`${row.function_id}\` (${file})`);
    lines.push(`- **Status:** ${status}`);
    if (row.defect_class) lines.push(`- **Class:** ${row.defect_class}`);
    if (trigger && typeof trigger === 'object' && 'violated_postcondition' in trigger) {
      const vp = (trigger as { violated_postcondition?: string }).violated_postcondition;
      if (vp) lines.push(`- **Violated:** ${vp}`);
    }
    if (trigger && typeof trigger === 'object' && 'input' in trigger) {
      lines.push(`- **Trigger:** \`${truncate(stringifyLoose((trigger as { input: unknown }).input), 120)}\``);
    }
    if (worked && typeof worked === 'object' && 'summary' in worked) {
      lines.push(`- **What worked:** ${truncate(String((worked as { summary: string }).summary), 200)}`);
    }
    lines.push(`- **Seen:** ${count} time(s)`);
    lines.push('');
  }

  return lines.join('\n');
}

function renderGlobalSteering(lessons: WatchlistLesson[]): string {
  const lines: string[] = [];
  lines.push('---');
  lines.push('inclusion: auto');
  lines.push('---');
  lines.push('');
  lines.push('# Buggy — Watchlist (Global Memory)');
  lines.push('');
  lines.push(
    '<!-- AUTO-GENERATED across your projects. Sanitized: contains no source code, file paths, or literal values — only generalized patterns. -->'
  );
  lines.push('');
  lines.push(`_Last updated: ${new Date().toISOString()}_`);
  lines.push('');
  lines.push(
    'Generalized lessons corroborated across multiple projects. Kiro: use these as priors when writing or fixing similar code. Project-local lessons always override these on conflict.'
  );
  lines.push('');
  lines.push('## Lessons');
  lines.push('');

  for (const lesson of lessons) {
    lines.push(`### ${lesson.failure_class ?? 'defect'} — \`${lesson.signature_shape ?? 'unknown'}\``);
    lines.push(`- **Pattern:** ${lesson.detail}`);
    lines.push(`- **Seen in:** ${lesson.contexts.length} project(s), ${lesson.occurrences} occurrence(s)`);
    if (lesson.example_trigger_shapes.length > 0) {
      lines.push(`- **Trigger shapes:** ${lesson.example_trigger_shapes.join(', ')}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ─── I/O + serialization utilities ──────────────────────────────────────────

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, safeSerialize(value, 2), 'utf-8');
}

function readLoose(json: string | null): unknown {
  if (!json) return undefined;
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}

/**
 * JSON serialization that tolerates NaN, Infinity, undefined, and bigint —
 * values that can appear in proof counterexamples and would otherwise throw
 * or serialize to invalid JSON.
 */
function safeSerialize(value: unknown, indent?: number): string {
  return JSON.stringify(
    value,
    (_key, val) => {
      if (typeof val === 'number' && !Number.isFinite(val)) {
        return { __nonfinite__: String(val) };
      }
      if (typeof val === 'bigint') return { __bigint__: val.toString() };
      if (val === undefined) return { __undefined__: true };
      return val;
    },
    indent
  );
}

function stringifyLoose(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  try {
    return safeSerialize(value);
  } catch {
    return String(value);
  }
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function relativize(filePath: string, projectRoot: string): string {
  if (filePath.startsWith(projectRoot)) {
    return filePath.slice(projectRoot.length).replace(/^[/\\]+/, '');
  }
  return filePath;
}

function shortHash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 12);
}
