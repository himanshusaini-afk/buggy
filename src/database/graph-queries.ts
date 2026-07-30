import type Database from 'better-sqlite3';
import type { NodeRecord, EdgeRecord } from '../types/graph.js';

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
 * Graph query API for the proof-carrying debugger's SQLite graph database.
 *
 * Provides node lookup, edge traversal, subgraph extraction, and path finding
 * using recursive CTEs. All queries targeting <1000 nodes complete within 50ms.
 */
export class GraphQueries {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /**
   * Looks up a single node by its ID.
   * @returns The matching NodeRecord or null if not found.
   */
  lookupNode(id: string): NodeRecord | null {
    const stmt = this.db.prepare('SELECT * FROM nodes WHERE id = ?');
    const row = stmt.get(id) as NodeRow | undefined;
    if (!row) return null;
    return rowToNodeRecord(row);
  }

  /**
   * Traverses edges from a given node filtered by relationship type.
   * @returns All edges originating from the node with the specified relationship.
   */
  traverseEdges(nodeId: string, relationship: string): EdgeRecord[] {
    const stmt = this.db.prepare(
      'SELECT * FROM edges WHERE source_id = ? AND relationship = ?'
    );
    const rows = stmt.all(nodeId, relationship) as EdgeRecord[];
    return rows;
  }

  /**
   * Extracts the subgraph for a given file path.
   * Returns all nodes in the file and all edges between those nodes.
   */
  extractSubgraph(filePath: string): { nodes: NodeRecord[]; edges: EdgeRecord[] } {
    const nodesStmt = this.db.prepare('SELECT * FROM nodes WHERE file_path = ?');
    const nodeRows = nodesStmt.all(filePath) as NodeRow[];
    const nodes = nodeRows.map(rowToNodeRecord);

    if (nodes.length === 0) {
      return { nodes: [], edges: [] };
    }

    // Build a set of node IDs for fast lookup
    const nodeIds = new Set(nodes.map((n) => n.id));

    // Query edges where both source and target are in this file's nodes
    const edgesStmt = this.db.prepare(
      `SELECT * FROM edges
       WHERE source_id IN (SELECT id FROM nodes WHERE file_path = ?)
         AND target_id IN (SELECT id FROM nodes WHERE file_path = ?)`
    );
    const edges = edgesStmt.all(filePath, filePath) as EdgeRecord[];

    return { nodes, edges };
  }

  /**
   * Finds the shortest path between two nodes using a recursive CTE.
   * Returns the ordered list of nodes on the path, or an empty array if no path exists.
   */
  findPath(sourceId: string, targetId: string): NodeRecord[] {
    if (sourceId === targetId) {
      const node = this.lookupNode(sourceId);
      return node ? [node] : [];
    }

    // Use recursive CTE to find a path from source to target
    const pathStmt = this.db.prepare(`
      WITH RECURSIVE path(node_id, depth, visited) AS (
        SELECT :sourceId, 0, :sourceId
        UNION ALL
        SELECT e.target_id, p.depth + 1, p.visited || ',' || e.target_id
        FROM path p
        JOIN edges e ON e.source_id = p.node_id
        WHERE p.visited NOT LIKE '%' || e.target_id || '%'
          AND p.depth < 50
      )
      SELECT visited FROM path WHERE node_id = :targetId ORDER BY depth LIMIT 1
    `);

    const result = pathStmt.get({ sourceId, targetId }) as { visited: string } | undefined;

    if (!result) {
      return [];
    }

    // Parse the visited path (comma-separated node IDs)
    const nodeIds = result.visited.split(',');

    // Fetch all nodes in the path, preserving order
    const nodes: NodeRecord[] = [];
    for (const id of nodeIds) {
      const node = this.lookupNode(id);
      if (node) {
        nodes.push(node);
      }
    }

    return nodes;
  }
}
