import Database from 'better-sqlite3';

/**
 * Initializes the SQLite graph database with the full schema for the
 * proof-carrying debugger system.
 *
 * Enables WAL mode for concurrent reads and foreign keys for referential integrity.
 * Creates all 11 tables and required indexes.
 *
 * @param dbPath - Path to the SQLite database file (use ':memory:' for in-memory)
 * @returns The initialized Database instance
 */
export function initializeDatabase(dbPath: string): Database.Database {
  const db = new Database(dbPath);

  // Enable WAL mode for concurrent reads
  db.pragma('journal_mode = WAL');

  // Enable foreign key enforcement
  db.pragma('foreign_keys = ON');

  // Create all tables and indexes in a single transaction
  db.exec(SCHEMA_SQL);

  return db;
}

const SCHEMA_SQL = `
-- Core node table for CST nodes and symbols
CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  file_path TEXT NOT NULL,
  start_byte INTEGER NOT NULL,
  end_byte INTEGER NOT NULL,
  start_line INTEGER NOT NULL,
  start_column INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  end_column INTEGER NOT NULL,
  node_kind TEXT,
  text_content TEXT,
  is_error INTEGER DEFAULT 0,
  metadata TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Edge table for relationships
CREATE TABLE IF NOT EXISTS edges (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES nodes(id),
  target_id TEXT NOT NULL REFERENCES nodes(id),
  relationship TEXT NOT NULL,
  metadata TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(source_id, target_id, relationship)
);

-- Symbol resolution table
CREATE TABLE IF NOT EXISTS symbol_resolutions (
  id TEXT PRIMARY KEY,
  usage_node_id TEXT NOT NULL REFERENCES nodes(id),
  definition_node_id TEXT REFERENCES nodes(id),
  symbol_name TEXT NOT NULL,
  type_info TEXT,
  enclosing_scope TEXT,
  resolved INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- TrajSpec behavioral interpretations
CREATE TABLE IF NOT EXISTS behavioral_interpretations (
  id TEXT PRIMARY KEY,
  file_path TEXT NOT NULL,
  function_scope TEXT NOT NULL,
  summary TEXT NOT NULL,
  commit_ids TEXT NOT NULL,
  defect_correlation_score REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- TrajSpec diagnostic assertions
CREATE TABLE IF NOT EXISTS diagnostic_assertions (
  id TEXT PRIMARY KEY,
  interpretation_id TEXT REFERENCES behavioral_interpretations(id),
  function_id TEXT NOT NULL,
  precondition TEXT NOT NULL,
  postcondition TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Specification refinement records
CREATE TABLE IF NOT EXISTS spec_refinements (
  id TEXT PRIMARY KEY,
  function_id TEXT NOT NULL,
  postcondition TEXT NOT NULL,
  alpha_consistency REAL NOT NULL,
  status TEXT NOT NULL,
  disagreeing_tests TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- PROBE loop history
CREATE TABLE IF NOT EXISTS probe_iterations (
  id TEXT PRIMARY KEY,
  property_id TEXT NOT NULL,
  iteration_number INTEGER NOT NULL,
  candidate_property TEXT NOT NULL,
  counter_implementation TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Proof-of-failure certificates
CREATE TABLE IF NOT EXISTS proof_certificates (
  id TEXT PRIMARY KEY,
  investigation_id TEXT NOT NULL,
  test_input TEXT NOT NULL,
  observed_output TEXT NOT NULL,
  violated_postcondition TEXT NOT NULL,
  admissibility_verified_at TEXT NOT NULL,
  soundness_verified_at TEXT NOT NULL,
  uniqueness_verified_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Candidate patches
CREATE TABLE IF NOT EXISTS patches (
  id TEXT PRIMARY KEY,
  proof_certificate_id TEXT NOT NULL REFERENCES proof_certificates(id),
  diff TEXT NOT NULL,
  edit_operations TEXT NOT NULL,
  target_file TEXT NOT NULL,
  target_range TEXT NOT NULL,
  status TEXT NOT NULL,
  overfitting_probability REAL,
  feature_vector TEXT,
  refinement_attempt INTEGER DEFAULT 0,
  failure_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Oracle violations
CREATE TABLE IF NOT EXISTS oracle_violations (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL,
  oracle_type TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  details TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_nodes_file ON nodes(file_path);
CREATE INDEX IF NOT EXISTS idx_nodes_type ON nodes(type);
CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id);
CREATE INDEX IF NOT EXISTS idx_edges_relationship ON edges(relationship);
CREATE INDEX IF NOT EXISTS idx_symbols_resolved ON symbol_resolutions(resolved);
CREATE INDEX IF NOT EXISTS idx_interpretations_file ON behavioral_interpretations(file_path);
CREATE INDEX IF NOT EXISTS idx_patches_status ON patches(status);
`;
