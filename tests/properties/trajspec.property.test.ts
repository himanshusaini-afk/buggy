import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fc from 'fast-check';
import Database from 'better-sqlite3';
import { initializeDatabase } from '../../src/database/graph-db.js';
import { TrajSpec } from '../../src/agents/trajspec.js';

/**
 * Property 8: Defect Correlation Score Computation
 *
 * For any code region with N total commits and D defect-fixing commits
 * (where N > 0), the TrajSpec defect_correlation_score shall equal D/N,
 * yielding a value in [0.0, 1.0].
 *
 * **Validates: Requirements 4.3**
 */

describe('Property 8: Defect Correlation Score Computation', () => {
  let db: Database.Database;
  let trajSpec: TrajSpec;

  beforeEach(() => {
    db = initializeDatabase(':memory:');
    trajSpec = new TrajSpec(db);
  });

  afterEach(() => {
    db.close();
  });

  it('defect_correlation_score equals D/N and is in [0.0, 1.0] for random N > 0 and 0 <= D <= N', () => {
    fc.assert(
      fc.property(
        // N: total commits, must be > 0
        fc.integer({ min: 1, max: 100_000 }),
        // D: defect-fixing commits, must be 0 <= D <= N
        fc.integer({ min: 0, max: 100_000 }),
        (totalCommits, defectFixingRaw) => {
          // Ensure D <= N
          const defectFixingCommits = Math.min(defectFixingRaw, totalCommits);

          const score = trajSpec.computeDefectCorrelation(totalCommits, defectFixingCommits);

          // Score must equal D/N
          const expectedScore = defectFixingCommits / totalCommits;
          expect(score).toBeCloseTo(expectedScore, 10);

          // Score must be in [0.0, 1.0]
          expect(score).toBeGreaterThanOrEqual(0.0);
          expect(score).toBeLessThanOrEqual(1.0);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('defect_correlation_score is exactly 0.0 when D = 0', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100_000 }),
        (totalCommits) => {
          const score = trajSpec.computeDefectCorrelation(totalCommits, 0);
          expect(score).toBe(0.0);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('defect_correlation_score is exactly 1.0 when D = N', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100_000 }),
        (totalCommits) => {
          const score = trajSpec.computeDefectCorrelation(totalCommits, totalCommits);
          expect(score).toBe(1.0);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('defect_correlation_score is 0 when N = 0 (edge case guard)', () => {
    // Although the property states N > 0, the implementation handles N = 0 gracefully
    const score = trajSpec.computeDefectCorrelation(0, 0);
    expect(score).toBe(0);
  });

  it('defect_correlation_score is monotonically non-decreasing as D increases for fixed N', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 10_000 }),
        fc.integer({ min: 0, max: 9_999 }),
        (totalCommits, d1Raw) => {
          const d1 = Math.min(d1Raw, totalCommits - 1);
          const d2 = d1 + 1; // d2 > d1, both <= N

          const score1 = trajSpec.computeDefectCorrelation(totalCommits, d1);
          const score2 = trajSpec.computeDefectCorrelation(totalCommits, d2);

          expect(score2).toBeGreaterThanOrEqual(score1);
        }
      ),
      { numRuns: 100 }
    );
  });
});
