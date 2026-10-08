import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { initializeDatabase } from '../../src/database/graph-db.js';
import { CapabilityAdvisor } from '../../src/advisor/capability-advisor.js';
import type { WatchlistAttempt } from '../../src/types/watchlist.js';

function insertEpisode(
  db: Database.Database,
  opts: {
    lessonKey: string;
    functionId: string;
    filePath: string;
    outcome: 'confirmed_and_repaired' | 'confirmed_no_repair';
    createdAt: string;
    failureClass?: string;
    attempts?: WatchlistAttempt[];
  }
): void {
  db.prepare(
    `INSERT INTO watchlist_episodes (
       id, investigation_id, source, language, file_path, function_id,
       defect_class, failure_class, outcome, lesson_key, global_key,
       attempts_json, what_worked_json, created_at
     ) VALUES (?, ?, 'buggy_investigate', 'typescript', ?, ?, 'arithmetic', ?, ?, ?, 'g', ?, ?, ?)`
  ).run(
    `ep_${Math.random().toString(36).slice(2)}`,
    `inv_${Math.random().toString(36).slice(2)}`,
    opts.filePath,
    opts.functionId,
    opts.failureClass ?? 'division_by_zero',
    opts.outcome,
    opts.lessonKey,
    JSON.stringify(opts.attempts ?? []),
    opts.outcome === 'confirmed_and_repaired'
      ? JSON.stringify({ patch_id: 'p', overfitting_probability: 0.1, summary: 'guard' })
      : null,
    opts.createdAt
  );
}

describe('CapabilityAdvisor', () => {
  let db: Database.Database;
  let root: string;

  beforeEach(() => {
    db = initializeDatabase(':memory:');
    root = mkdtempSync(join(tmpdir(), 'buggy-advisor-'));
  });

  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('suggests nothing when there is no defect history', () => {
    const advice = new CapabilityAdvisor(db, { projectRoot: root }).advise();
    expect(advice.suggestions).toEqual([]);
    expect(advice.signals_summary.total_verified).toBe(0);
  });

  it('proposes a regression guard when a fix did not stick', () => {
    const key = 'ts:division_by_zero:split';
    insertEpisode(db, {
      lessonKey: key,
      functionId: 'split',
      filePath: 'src/money.ts',
      outcome: 'confirmed_and_repaired',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    insertEpisode(db, {
      lessonKey: key,
      functionId: 'split',
      filePath: 'src/money.ts',
      outcome: 'confirmed_no_repair',
      createdAt: '2026-01-09T00:00:00.000Z',
    });

    const advice = new CapabilityAdvisor(db, { projectRoot: root }).advise();
    const guard = advice.suggestions.find((s) => s.id === 'hook-regression-guard');

    expect(guard).toBeDefined();
    expect(guard!.priority).toBe('high');
    expect(guard!.kind).toBe('hook');
    expect(guard!.rationale).toContain('split');
    expect(guard!.evidence).toContain(key);

    // The emitted hook must be valid JSON in the project's existing schema.
    const hook = JSON.parse(guard!.content);
    expect(hook.when.type).toBe('fileEdited');
    expect(hook.when.patterns).toContain('src/money.ts');
    expect(hook.then.type).toBe('askAgent');
    expect(hook.then.prompt).toContain('buggy_recall');
  });

  it('turns repeated rejections into a dead-end steering file', () => {
    const attempts = (uuid: string): WatchlistAttempt[] => [
      {
        approach: `patch ${uuid}`,
        result: 'failed',
        how_it_failed: `Overfitting risk: top factors - literal_count (patch ${uuid})`,
      },
    ];

    insertEpisode(db, {
      lessonKey: 'k1',
      functionId: 'f1',
      filePath: 'src/a.ts',
      outcome: 'confirmed_no_repair',
      createdAt: '2026-02-01T00:00:00.000Z',
      attempts: attempts('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'),
    });
    insertEpisode(db, {
      lessonKey: 'k2',
      functionId: 'f2',
      filePath: 'src/a.ts',
      outcome: 'confirmed_no_repair',
      createdAt: '2026-02-02T00:00:00.000Z',
      attempts: attempts('11111111-2222-3333-4444-555555555555'),
    });

    const advice = new CapabilityAdvisor(db, { projectRoot: root }).advise();
    const deadEnds = advice.suggestions.find((s) => s.id === 'steering-dead-ends');

    expect(deadEnds).toBeDefined();
    expect(deadEnds!.kind).toBe('steering');
    expect(deadEnds!.content).toContain('inclusion: auto');
    expect(deadEnds!.content).toContain('Do not retry these');
    expect(deadEnds!.target_path).toBe('.kiro/steering/buggy-dead-ends.md');
  });

  it('renders the defect-class guide in the configured language', () => {
    for (const [i, fn] of ['a', 'b', 'c'].entries()) {
      insertEpisode(db, {
        lessonKey: `py:division_by_zero:${fn}`,
        functionId: fn,
        filePath: 'src/calc.py',
        outcome: 'confirmed_and_repaired',
        createdAt: `2026-03-0${i + 1}T00:00:00.000Z`,
      });
    }

    const advice = new CapabilityAdvisor(db, {
      projectRoot: root,
      language: 'python',
    }).advise();
    const guide = advice.suggestions.find((s) => s.id === 'steering-division-by-zero');

    expect(guide).toBeDefined();
    expect(guide!.content).toContain('```python');
    // Python dialect: `is None` / `len(x) == 0`, never the TypeScript forms.
    expect(guide!.content).not.toContain('=== 0');
    expect(guide!.content).toContain('len(');
  });

  it('skips a proposal whose file already exists', () => {
    const key = 'k';
    insertEpisode(db, {
      lessonKey: key,
      functionId: 'f',
      filePath: 'src/a.ts',
      outcome: 'confirmed_and_repaired',
      createdAt: '2026-04-01T00:00:00.000Z',
    });
    insertEpisode(db, {
      lessonKey: key,
      functionId: 'f',
      filePath: 'src/a.ts',
      outcome: 'confirmed_no_repair',
      createdAt: '2026-04-02T00:00:00.000Z',
    });

    mkdirSync(join(root, '.kiro', 'hooks'), { recursive: true });
    writeFileSync(join(root, '.kiro', 'hooks', 'buggy-regression-guard.kiro.hook'), '{}', 'utf-8');

    const advice = new CapabilityAdvisor(db, { projectRoot: root }).advise();

    expect(advice.suggestions.find((s) => s.id === 'hook-regression-guard')).toBeUndefined();
    expect(advice.skipped.map((s) => s.id)).toContain('hook-regression-guard');
  });

  it('writes a proposal on apply and refuses to clobber it afterwards', () => {
    insertEpisode(db, {
      lessonKey: 'k',
      functionId: 'f',
      filePath: 'src/a.ts',
      outcome: 'confirmed_and_repaired',
      createdAt: '2026-05-01T00:00:00.000Z',
    });

    const advisor = new CapabilityAdvisor(db, { projectRoot: root });
    const first = advisor.advise().suggestions[0];
    expect(first).toBeDefined();

    const written = advisor.apply(first!.id);
    expect(written.written).toBe(true);
    expect(existsSync(join(root, written.target_path))).toBe(true);
    expect(readFileSync(join(root, written.target_path), 'utf-8').length).toBeGreaterThan(0);

    // Second attempt must refuse rather than overwrite a now-customised file.
    const again = advisor.apply(first!.id);
    expect(again.written).toBe(false);
    expect(again.reason).toContain('already exists');
  });

  it('reports a clear reason for an unknown id', () => {
    const result = new CapabilityAdvisor(db, { projectRoot: root }).apply('does-not-exist');
    expect(result.written).toBe(false);
    expect(result.reason).toContain('No current suggestion');
  });

  it('flags hooks that cannot match the project language', () => {
    insertEpisode(db, {
      lessonKey: 'k',
      functionId: 'f',
      filePath: 'src/a.py',
      outcome: 'confirmed_and_repaired',
      createdAt: '2026-06-01T00:00:00.000Z',
    });

    // An existing save hook that only matches TypeScript.
    mkdirSync(join(root, '.kiro', 'hooks'), { recursive: true });
    writeFileSync(
      join(root, '.kiro', 'hooks', 'existing.kiro.hook'),
      JSON.stringify({ when: { type: 'fileEdited', patterns: ['**/*.ts'] } }),
      'utf-8'
    );

    const advice = new CapabilityAdvisor(db, {
      projectRoot: root,
      language: 'python',
    }).advise();
    const coverage = advice.suggestions.find((s) => s.id === 'hook-language-coverage');

    expect(coverage).toBeDefined();
    expect(coverage!.priority).toBe('high');
    expect(JSON.parse(coverage!.content).when.patterns).toEqual(['**/*.py']);
  });

  it('does not flag language coverage when a matching hook exists', () => {
    insertEpisode(db, {
      lessonKey: 'k',
      functionId: 'f',
      filePath: 'src/a.py',
      outcome: 'confirmed_and_repaired',
      createdAt: '2026-06-01T00:00:00.000Z',
    });

    mkdirSync(join(root, '.kiro', 'hooks'), { recursive: true });
    writeFileSync(
      join(root, '.kiro', 'hooks', 'existing.kiro.hook'),
      JSON.stringify({ when: { type: 'fileEdited', patterns: ['**/*.py'] } }),
      'utf-8'
    );

    const advice = new CapabilityAdvisor(db, {
      projectRoot: root,
      language: 'python',
    }).advise();

    expect(advice.suggestions.find((s) => s.id === 'hook-language-coverage')).toBeUndefined();
  });

  it('every proposal carries evidence and a writable target path', () => {
    const key = 'k';
    insertEpisode(db, {
      lessonKey: key,
      functionId: 'f',
      filePath: 'src/a.ts',
      outcome: 'confirmed_and_repaired',
      createdAt: '2026-07-01T00:00:00.000Z',
    });
    insertEpisode(db, {
      lessonKey: key,
      functionId: 'f',
      filePath: 'src/a.ts',
      outcome: 'confirmed_no_repair',
      createdAt: '2026-07-02T00:00:00.000Z',
    });

    const advice = new CapabilityAdvisor(db, { projectRoot: root }).advise();
    expect(advice.suggestions.length).toBeGreaterThan(0);

    for (const s of advice.suggestions) {
      expect(s.evidence.length).toBeGreaterThan(0);
      expect(s.content.trim().length).toBeGreaterThan(0);
      expect(s.target_path).toMatch(/^\.kiro\/(hooks|steering|skills)\//);
      expect(['high', 'medium', 'low']).toContain(s.priority);
      // Hooks must be parseable JSON; the others are markdown with front matter.
      if (s.kind === 'hook') expect(() => JSON.parse(s.content)).not.toThrow();
      else expect(s.content.startsWith('---')).toBe(true);
    }
  });

  it('ranks high-priority proposals first', () => {
    const key = 'k';
    insertEpisode(db, {
      lessonKey: key,
      functionId: 'f',
      filePath: 'src/a.ts',
      outcome: 'confirmed_and_repaired',
      createdAt: '2026-08-01T00:00:00.000Z',
    });
    insertEpisode(db, {
      lessonKey: key,
      functionId: 'f',
      filePath: 'src/a.ts',
      outcome: 'confirmed_no_repair',
      createdAt: '2026-08-02T00:00:00.000Z',
    });

    const advice = new CapabilityAdvisor(db, { projectRoot: root }).advise();
    const order = { high: 0, medium: 1, low: 2 } as const;
    const ranks = advice.suggestions.map((s) => order[s.priority]);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });
});

describe('CapabilityAdvisor force-overwrite', () => {
  let db: Database.Database;
  let root: string;

  beforeEach(() => {
    db = initializeDatabase(':memory:');
    root = mkdtempSync(join(tmpdir(), 'buggy-advisor-force-'));
    insertEpisode(db, {
      lessonKey: 'k',
      functionId: 'f',
      filePath: 'src/a.ts',
      outcome: 'confirmed_and_repaired',
      createdAt: '2026-09-01T00:00:00.000Z',
    });
  });

  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  /**
   * Regression guard: `apply` used to resolve ids through the filtered
   * `advise()` list, which drops proposals whose target already exists. That
   * made `force` unreachable for precisely the proposals it exists to serve.
   */
  it('force overwrites an already-written proposal', () => {
    const advisor = new CapabilityAdvisor(db, { projectRoot: root });
    const target = advisor.advise().suggestions[0]!;

    expect(advisor.apply(target.id).written).toBe(true);

    // Simulate the user editing the generated file.
    writeFileSync(join(root, target.target_path), 'hand-edited', 'utf-8');

    const refused = advisor.apply(target.id);
    expect(refused.written).toBe(false);
    expect(refused.reason).toContain('already exists');
    expect(readFileSync(join(root, target.target_path), 'utf-8')).toBe('hand-edited');

    const forced = advisor.apply(target.id, true);
    expect(forced.written).toBe(true);
    expect(readFileSync(join(root, target.target_path), 'utf-8')).not.toBe('hand-edited');
  });
});
