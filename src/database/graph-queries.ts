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
   * Finds the shortest path (fewest edges) between two nodes using breadth-first
   * search over the edge set.
   *
   * BFS visits each reachable node at most once, so it runs in O(V + E), is safe
   * on cyclic graphs, and returns a genuine shortest path. This replaces an earlier
   * recursive-CTE implementation that enumerated every simple path (exponential on
   * branching graphs) and used substring matching for cycle detection, which produced
   * false positives on IDs that shared a prefix (e.g. "chain-1" vs "chain-10").
   *
   * @returns The ordered list of nodes on a shortest path, or an empty array if no path exists.
   */
  findPath(sourceId: string, targetId: string): NodeRecord[] {
    if (sourceId === targetId) {
      const node = this.lookupNode(sourceId);
      return node ? [node] : [];
    }

    const neighborsStmt = this.db.prepare(
      'SELECT DISTINCT target_id FROM edges WHERE source_id = ?'
    );

    // BFS from the source, recording each node's predecessor for path reconstruction.
    // The `parent` map doubles as the visited set (a key exists once discovered).
    const parent = new Map<string, string | null>();
    parent.set(sourceId, null);
    const queue: string[] = [sourceId];
    let found = false;

    while (queue.length > 0) {
      const current = queue.shift() as string;
      const rows = neighborsStmt.all(current) as Array<{ target_id: string }>;

      for (const { target_id } of rows) {
        if (parent.has(target_id)) continue; // already discovered → shortest distance already set
        parent.set(target_id, current);
        if (target_id === targetId) {
          found = true;
          break;
        }
        queue.push(target_id);
      }

      if (found) break;
    }

    if (!found) {
      return [];
    }

    // Reconstruct the path from target back to source, then reverse.
    const idPath: string[] = [];
    let cursor: string | null = targetId;
    while (cursor !== null) {
      idPath.unshift(cursor);
      cursor = parent.get(cursor) ?? null;
    }

    // Fetch all nodes in the path, preserving order.
    const nodes: NodeRecord[] = [];
    for (const id of idPath) {
      const node = this.lookupNode(id);
      if (node) {
        nodes.push(node);
      }
    }

    return nodes;
  }
}
