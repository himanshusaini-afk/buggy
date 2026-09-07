/**
 * Canonical filesystem locations for the Watchlist tiers.
 *
 * Both the recorder (writer) and the store (reader) import these so the two
 * can never drift out of sync — a path mismatch would silently break recall.
 *
 * @module watchlist/watchlist-paths
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Team-tier steering file, committed with the repo. */
export function teamSteeringPath(projectRoot: string): string {
  return join(projectRoot, '.kiro', 'steering', 'buggy-watchlist.md');
}

/** User-level directory for the cross-project global tier. */
export function globalDir(home: string): string {
  return join(home, '.buggy');
}

/** JSON index of generalized, sanitized global lessons. */
export function globalIndexPath(home: string): string {
  return join(globalDir(home), 'watchlist-lessons.json');
}

/** User-level global steering file, applied across all the user's projects. */
export function globalSteeringPath(home: string): string {
  return join(home, '.kiro', 'steering', 'buggy-watchlist-global.md');
}

/** Read and parse a JSON file, returning null on any error (missing/corrupt). */
export function readJsonFile<T>(path: string): T | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf-8')) as T;
  } catch {
    return null;
  }
}
