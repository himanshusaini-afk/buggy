import type Database from 'better-sqlite3';
import type { NodeRecord, EdgeRecord, CallGraphResult } from '../types/graph.js';

/**
 * Raw node row from SQLite (is_error stored as 0/1 integer).
 */
interface NodeRow {
  id: string;
  type: string;
  file_path: string;
  start_byte: number;
  end_byte: number;
  start_line: number;
  start_column: number;
  end_line: number;
  end_column: number;
  node_kind: string | null;
  text_content: string | null;
  is_error: number;
  metadata: string | null;
  created_at: string;
}

/**
 * Converts a raw SQLite node row to a typed NodeRecord.
 */
function rowToNodeRecord(row: NodeRow): NodeRecord {
  return {
    id: row.id,
    type: row.type,
    file_path: row.file_path,
    start_byte: row.start_byte,
    end_byte: row.end_byte,
    start_line: row.start_line,
    start_column: row.start_column,
    end_line: row.end_line,
    end_column: row.end_column,
    node_kind: row.node_kind ?? undefined,
    text_content: row.text_content ?? undefined,
    is_error: row.is_error === 1,
    metadata: row.metadata ?? undefined,
    created_at: row.created_at,
  };
}

/**
 * Builds a call graph from resolved call edges stored in the graph database.
 *
 * Aggregates all function/method call edges where the corresponding symbol
 * resolution has `resolved = true`, producing a directed graph of caller-callee
 * relationships. Unresolved references are excluded.
 */
export class CallGraphBuilder {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /**
   * Builds a call graph from all resolved call edges in the graph database.
   * Only includes edges where the corresponding symbol resolution has resolved=true.
   * Identifies entry points as nodes with no incoming call edges.
   */
  buildCallGraph(): CallGraphResult {
    // Query all 'calls' edges where the source node has a resolved symbol resolution
    const edges = this.db
      .prepare(
        `SELECT e.*
         FROM edges e
         INNER JOIN symbol_resolutions sr ON sr.usage_node_id = e.source_id
         WHERE e.relationship = 'calls'
           AND sr.resolved = 1`
      )
      .all() as EdgeRecord[];

    // Collect all unique node IDs from valid call edges
    const nodeIdSet = new Set<string>();
    for (const edge of edges) {
      nodeIdSet.add(edge.source_id);
      nodeIdSet.add(edge.target_id);
    }

    // Fetch full NodeRecord for each unique node
    const nodes: NodeRecord[] = [];
    if (nodeIdSet.size > 0) {
      const placeholders = [...nodeIdSet].map(() => '?').join(',');
      const rows = this.db
        .prepare(`SELECT * FROM nodes WHERE id IN (${placeholders})`)
        .all(...nodeIdSet) as NodeRow[];
      for (const row of rows) {
        nodes.push(rowToNodeRecord(row));
      }
    }

    // Identify entry points: nodes that appear as source but never as target
    const targetIds = new Set<string>(edges.map((e) => e.target_id));
    const entry_points: string[] = [];
    for (const nodeId of nodeIdSet) {
      if (!targetIds.has(nodeId)) {
        entry_points.push(nodeId);
      }
    }

    return { nodes, edges, entry_points };
  }
}
