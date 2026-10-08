import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';

import { initializeDatabase } from '../../src/database/graph-db.js';
import { Retrospective } from '../../src/watchlist/retrospective.js';
import type { WatchlistAttempt } from '../../src/types/watchlist.js';

/**
 * Insert a verified episode. `createdAt` is supplied explicitly because the
 * whole point of the retrospective is reading episodes as an ordered timeline.
 */
function insertEpisode(
  db: Database.Database,
  opts: {
    lessonKey: string;
    functionId: string;
    filePath: string;
    outcome: 'confirmed_and_repaired' | 'confirmed_no_repair' | 'unconfirmed' | 'halted';
    createdAt: string;
    failureClass?: string;
    defectClass?: string;
    attempts?: WatchlistAttempt[];
    overfitting?: number;
  }
): void {
  db.prepare(
    `INSERT INTO watchlist_episodes (
       id, investigation_id, source, language, file_path, function_id,
       defect_class, failure_class, outcome, lesson_key, global_key,
       attempts_json, what_worked_json, created_at
     ) VALUES (?, ?, 'buggy_investigate', 'typescript', ?, ?, ?, ?, ?, ?, 'g', ?, ?, ?)`
  ).run(
    `ep_${Math.random().toString(36).slice(2)}`,
    `inv_${Math.random().toString(36).slice(2)}`,
    opts.filePath,
    opts.functionId,
    opts.defectClass ?? 'arithmetic',
    opts.failureClass ?? 'division_by_zero',
    opts.outcome,
    opts.lessonKey,
    JSON.stringify(opts.attempts ?? []),
    opts.outcome === 'confirmed_and_repaired'
      ? JSON.stringify({
          patch_id: 'p1',
          overfitting_probability: opts.overfitting ?? 0.1,
          summary: 'guard',
        })
      : null,
    opts.createdAt
  );
}

describe('Retrospective', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initializeDatabase(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('reports nothing judgeable when there is no history', () => {
    const report = new Retrospective(db).analyse();

    expect(report.analysed_episodes).toBe(0);
    expect(report.improvement_score).toBeNull();
    expect(report.lessons).toEqual([]);
    expect(report.observations[0]).toContain('No proven defects');
  });

  it('ignores unconfirmed and halted episodes', () => {
    insertEpisode(db, {
      lessonKey: 'ts:division_by_zero:a',
      functionId: 'a',
      filePath: 'src/a.ts',
      outcome: 'unconfirmed',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    insertEpisode(db, {
      lessonKey: 'ts:division_by_zero:b',
      functionId: 'b',
      filePath: 'src/b.ts',
      outcome: 'halted',
      createdAt: '2026-01-02T00:00:00.000Z',
    });

    const report = new Retrospective(db).analyse();
    expect(report.analysed_episodes).toBe(0);
  });

  it('marks a lesson held when a fix was approved and never recurred', () => {
    insertEpisode(db, {
      lessonKey: 'ts:division_by_zero:split',
      functionId: 'split',
      filePath: 'src/x.ts',
      outcome: 'confirmed_and_repaired',
      createdAt: '2026-01-01T00:00:00.000Z',
      overfitting: 0.12,
    });

    const report = new Retrospective(db).analyse();
    const lesson = report.lessons[0]!;

    expect(lesson.status).toBe('held');
    expect(lesson.recurrences_after_fix).toBe(0);
    expect(lesson.best_overfitting_probability).toBeCloseTo(0.12);
    expect(report.improvement_score).toBe(1);
    expect(report.regressions).toEqual([]);
  });

  it('marks a lesson regressed when the defect is proven again after a fix', () => {
    const key = 'ts:division_by_zero:split';
    insertEpisode(db, {
      lessonKey: key,
      functionId: 'split',
      filePath: 'src/x.ts',
      outcome: 'confirmed_and_repaired',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    insertEpisode(db, {
      lessonKey: key,
      functionId: 'split',
      filePath: 'src/x.ts',
      outcome: 'confirmed_no_repair',
      createdAt: '2026-01-05T00:00:00.000Z',
    });

    const report = new Retrospective(db).analyse();
    const lesson = report.lessons[0]!;

    expect(lesson.status).toBe('regressed');
    expect(lesson.recurrences_after_fix).toBe(1);
    expect(lesson.occurrences).toBe(2);
    expect(report.regressions).toHaveLength(1);
    expect(report.improvement_score).toBe(0);
  });

  it('computes the improvement score over judgeable lessons only', () => {
    // held
    insertEpisode(db, {
      lessonKey: 'k1',
      functionId: 'f1',
      filePath: 'src/a.ts',
      outcome: 'confirmed_and_repaired',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    // regressed
    insertEpisode(db, {
      lessonKey: 'k2',
      functionId: 'f2',
      filePath: 'src/a.ts',
      outcome: 'confirmed_and_repaired',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    insertEpisode(db, {
      lessonKey: 'k2',
      functionId: 'f2',
      filePath: 'src/a.ts',
      outcome: 'confirmed_no_repair',
      createdAt: '2026-01-02T00:00:00.000Z',
    });
    // open — never fixed, seen once. Must not affect the score.
    insertEpisode(db, {
      lessonKey: 'k3',
      functionId: 'f3',
      filePath: 'src/b.ts',
      outcome: 'confirmed_no_repair',
      createdAt: '2026-01-03T00:00:00.000Z',
    });

    const report = new Retrospective(db).analyse();

    // 1 held / (1 held + 1 regressed) — k3 excluded.
    expect(report.improvement_score).toBe(0.5);
    expect(report.lessons.find((l) => l.lesson_key === 'k3')!.status).toBe('open');
  });

  it('marks repeatedly-proven defects with no fix as unresolved', () => {
    const key = 'ts:nan_result:calc';
    for (const day of ['01', '02', '03']) {
      insertEpisode(db, {
        lessonKey: key,
        functionId: 'calc',
        filePath: 'src/calc.ts',
        outcome: 'confirmed_no_repair',
        createdAt: `2026-02-${day}T00:00:00.000Z`,
      });
    }

    const report = new Retrospective(db).analyse();
    expect(report.unresolved).toHaveLength(1);
    expect(report.unresolved[0]!.occurrences).toBe(3);
    expect(report.unresolved[0]!.status).toBe('unresolved');
  });

  it('records days to first fix', () => {
    const key = 'k';
    insertEpisode(db, {
      lessonKey: key,
      functionId: 'f',
      filePath: 'src/a.ts',
      outcome: 'confirmed_no_repair',
      createdAt: '2026-03-01T00:00:00.000Z',
    });
    insertEpisode(db, {
      lessonKey: key,
      functionId: 'f',
      filePath: 'src/a.ts',
      outcome: 'confirmed_and_repaired',
      createdAt: '2026-03-06T00:00:00.000Z',
    });

    const report = new Retrospective(db).analyse();
    expect(report.lessons[0]!.days_to_first_fix).toBe(5);
  });

  it('collapses equivalent failure reasons into one dead end', () => {
    // The same rejection, but each carries a distinct patch UUID. Without
    // normalisation these would never reach the recurrence threshold.
    const attempts = (uuid: string): WatchlistAttempt[] => [
      {
        approach: `patch ${uuid}`,
        result: 'failed',
        how_it_failed: `Overfitting risk: top factors - literal_count, branch_count (patch ${uuid} at src/a.ts:42)`,
      },
    ];

    insertEpisode(db, {
      lessonKey: 'k1',
      functionId: 'f1',
      filePath: 'src/a.ts',
      outcome: 'confirmed_no_repair',
      createdAt: '2026-04-01T00:00:00.000Z',
      attempts: attempts('11111111-2222-3333-4444-555555555555'),
    });
    insertEpisode(db, {
      lessonKey: 'k2',
      functionId: 'f2',
      filePath: 'src/a.ts',
      outcome: 'confirmed_no_repair',
      createdAt: '2026-04-02T00:00:00.000Z',
      attempts: attempts('66666666-7777-8888-9999-000000000000'),
    });

    const report = new Retrospective(db).analyse();

    expect(report.dead_ends).toHaveLength(1);
    expect(report.dead_ends[0]!.occurrences).toBe(2);
    expect(report.dead_ends[0]!.affected_functions).toEqual(['f1', 'f2']);
  });

  it('does not report a one-off failure as a dead end', () => {
    insertEpisode(db, {
      lessonKey: 'k1',
      functionId: 'f1',
      filePath: 'src/a.ts',
      outcome: 'confirmed_no_repair',
      createdAt: '2026-04-01T00:00:00.000Z',
      attempts: [{ approach: 'p', result: 'failed', how_it_failed: 'only once' }],
    });

    expect(new Retrospective(db).analyse().dead_ends).toEqual([]);
  });

  it('ranks hotspots with regressions above those with more raw defects', () => {
    // quiet.ts: three separate one-off defects, no regression.
    for (const [i, fn] of ['a', 'b', 'c'].entries()) {
      insertEpisode(db, {
        lessonKey: `quiet:${fn}`,
        functionId: fn,
        filePath: 'src/quiet.ts',
        outcome: 'confirmed_and_repaired',
        createdAt: `2026-05-0${i + 1}T00:00:00.000Z`,
      });
    }
    // risky.ts: one defect that came back after being fixed.
    insertEpisode(db, {
      lessonKey: 'risky:x',
      functionId: 'x',
      filePath: 'src/risky.ts',
      outcome: 'confirmed_and_repaired',
      createdAt: '2026-05-10T00:00:00.000Z',
    });
    insertEpisode(db, {
      lessonKey: 'risky:x',
      functionId: 'x',
      filePath: 'src/risky.ts',
      outcome: 'confirmed_no_repair',
      createdAt: '2026-05-11T00:00:00.000Z',
    });

    const report = new Retrospective(db).analyse();

    expect(report.hotspots[0]!.file_path).toBe('src/risky.ts');
    expect(report.hotspots[0]!.regressions).toBe(1);
  });

  it('survives a malformed attempts payload', () => {
    insertEpisode(db, {
      lessonKey: 'k',
      functionId: 'f',
      filePath: 'src/a.ts',
      outcome: 'confirmed_and_repaired',
      createdAt: '2026-06-01T00:00:00.000Z',
    });
    db.prepare(`UPDATE watchlist_episodes SET attempts_json = '{not json'`).run();

    const report = new Retrospective(db).analyse();
    expect(report.analysed_episodes).toBe(1);
    expect(report.dead_ends).toEqual([]);
  });
});
