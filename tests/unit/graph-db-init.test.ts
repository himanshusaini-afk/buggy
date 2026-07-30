import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { initializeDatabase } from '../../src/database/graph-db.js';

describe('initializeDatabase', () => {
  let db: Database.Database;
  let tmpDir: string | undefined;

  afterEach(() => {
    if (db) {
      db.close();
    }
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  it('should create an in-memory database and return a Database instance', () => {
    db = initializeDatabase(':memory:');
    expect(db).toBeDefined();
    expect(db.open).toBe(true);
  });

  it('should enable WAL journal mode for file-backed databases', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'graph-db-test-'));
    const dbPath = join(tmpDir, 'test.db');
    db = initializeDatabase(dbPath);
    const result = db.pragma('journal_mode') as Array<{ journal_mode: string }>;
    expect(result[0].journal_mode).toBe('wal');
  });

  it('should enable foreign keys', () => {
    db = initializeDatabase(':memory:');
    const result = db.pragma('foreign_keys') as Array<{ foreign_keys: number }>;
    expect(result[0].foreign_keys).toBe(1);
  });

  it('should create all 11 tables', () => {
    db = initializeDatabase(':memory:');
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;

    const tableNames = tables.map(t => t.name);
    expect(tableNames).toContain('nodes');
    expect(tableNames).toContain('edges');
    expect(tableNames).toContain('symbol_resolutions');
    expect(tableNames).toContain('behavioral_interpretations');
    expect(tableNames).toContain('diagnostic_assertions');
    expect(tableNames).toContain('spec_refinements');
    expect(tableNames).toContain('probe_iterations');
    expect(tableNames).toContain('proof_certificates');
    expect(tableNames).toContain('patches');
    expect(tableNames).toContain('oracle_violations');
  });

  it('should create all 8 indexes', () => {
    db = initializeDatabase(':memory:');
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%' ORDER BY name")
      .all() as Array<{ name: string }>;

    const indexNames = indexes.map(i => i.name);
    expect(indexNames).toContain('idx_nodes_file');
    expect(indexNames).toContain('idx_nodes_type');
    expect(indexNames).toContain('idx_edges_source');
    expect(indexNames).toContain('idx_edges_target');
    expect(indexNames).toContain('idx_edges_relationship');
    expect(indexNames).toContain('idx_symbols_resolved');
    expect(indexNames).toContain('idx_interpretations_file');
    expect(indexNames).toContain('idx_patches_status');
  });

  it('should enforce foreign key constraints on edges table', () => {
    db = initializeDatabase(':memory:');
    expect(() => {
      db.prepare(`
        INSERT INTO edges (id, source_id, target_id, relationship)
        VALUES ('e1', 'nonexistent_source', 'nonexistent_target', 'calls')
      `).run();
    }).toThrow();
  });
});
