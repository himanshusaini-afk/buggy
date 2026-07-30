import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { initializeDatabase } from '../../src/database/graph-db.js';
import { GraphQueries } from '../../src/database/graph-queries.js';
import {
  GraphWriter,
  ReferentialIntegrityError,
  WriteExhaustedError,
} from '../../src/database/graph-writer.js';
import type { NodeRecord, EdgeRecord } from '../../src/types/graph.js';

function makeNode(overrides: Partial<NodeRecord> = {}): NodeRecord {
  return {
    id: 'node-1',
    type: 'cst_node',
    file_path: '/src/main.ts',
    start_byte: 0,
    end_byte: 100,
    start_line: 1,
    start_column: 0,
    end_line: 5,
    end_column: 10,
    is_error: false,
    created_at: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeEdge(overrides: Partial<EdgeRecord> = {}): EdgeRecord {
  return {
    id: 'edge-1',
    source_id: 'node-1',
    target_id: 'node-2',
    relationship: 'calls',
    created_at: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('GraphQueries', () => {
  let db: Database.Database;
  let queries: GraphQueries;

  beforeEach(() => {
    db = initializeDatabase(':memory:');
    queries = new GraphQueries(db);

    // Insert sample nodes
    const insertNode = db.prepare(`
      INSERT INTO nodes (id, type, file_path, start_byte, end_byte, start_line, start_column, end_line, end_column, node_kind, text_content, is_error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insertNode.run('n1', 'function', 'src/main.ts', 0, 100, 1, 0, 5, 1, 'function_declaration', 'function main() {}', 0);
    insertNode.run('n2', 'function', 'src/main.ts', 101, 200, 6, 0, 10, 1, 'function_declaration', 'function helper() {}', 0);
    insertNode.run('n3', 'function', 'src/utils.ts', 0, 50, 1, 0, 3, 1, 'function_declaration', 'function util() {}', 0);
    insertNode.run('n4', 'class', 'src/main.ts', 201, 300, 11, 0, 20, 1, 'class_declaration', 'class App {}', 0);
    insertNode.run('n5', 'cst_node', 'src/utils.ts', 51, 100, 4, 0, 6, 1, 'identifier', 'error_node', 1);

    // Insert sample edges
    const insertEdge = db.prepare(`
      INSERT INTO edges (id, source_id, target_id, relationship)
      VALUES (?, ?, ?, ?)
    `);

    insertEdge.run('e1', 'n1', 'n2', 'calls');
    insertEdge.run('e2', 'n1', 'n3', 'calls');
    insertEdge.run('e3', 'n2', 'n4', 'references');
    insertEdge.run('e4', 'n4', 'n3', 'calls');
  });

  afterEach(() => {
    db.close();
  });

  describe('lookupNode', () => {
    it('should return a node by its ID', () => {
      const node = queries.lookupNode('n1');
      expect(node).not.toBeNull();
      expect(node!.id).toBe('n1');
      expect(node!.type).toBe('function');
      expect(node!.file_path).toBe('src/main.ts');
      expect(node!.start_byte).toBe(0);
      expect(node!.end_byte).toBe(100);
      expect(node!.is_error).toBe(false);
    });

    it('should return null for a non-existent node', () => {
      const node = queries.lookupNode('nonexistent');
      expect(node).toBeNull();
    });

    it('should correctly convert is_error from integer to boolean', () => {
      const errorNode = queries.lookupNode('n5');
      expect(errorNode).not.toBeNull();
      expect(errorNode!.is_error).toBe(true);
    });

    it('should handle optional fields as undefined', () => {
      // Insert a node without optional fields
      db.prepare(`
        INSERT INTO nodes (id, type, file_path, start_byte, end_byte, start_line, start_column, end_line, end_column, is_error)
        VALUES ('n_bare', 'symbol', 'src/bare.ts', 0, 10, 1, 0, 1, 10, 0)
      `).run();

      const node = queries.lookupNode('n_bare');
      expect(node).not.toBeNull();
      expect(node!.node_kind).toBeUndefined();
      expect(node!.text_content).toBeUndefined();
      expect(node!.metadata).toBeUndefined();
    });
  });

  describe('traverseEdges', () => {
    it('should return edges from a node with the specified relationship', () => {
      const edges = queries.traverseEdges('n1', 'calls');
      expect(edges).toHaveLength(2);
      expect(edges.map(e => e.target_id).sort()).toEqual(['n2', 'n3']);
    });

    it('should return an empty array when no edges match', () => {
      const edges = queries.traverseEdges('n1', 'defines');
      expect(edges).toHaveLength(0);
    });

    it('should return an empty array for a non-existent node', () => {
      const edges = queries.traverseEdges('nonexistent', 'calls');
      expect(edges).toHaveLength(0);
    });

    it('should filter by relationship type', () => {
      const refs = queries.traverseEdges('n2', 'references');
      expect(refs).toHaveLength(1);
      expect(refs[0].target_id).toBe('n4');

      const calls = queries.traverseEdges('n2', 'calls');
      expect(calls).toHaveLength(0);
    });
  });

  describe('extractSubgraph', () => {
    it('should return all nodes and internal edges for a file', () => {
      const subgraph = queries.extractSubgraph('src/main.ts');
      expect(subgraph.nodes).toHaveLength(3); // n1, n2, n4
      expect(subgraph.nodes.map(n => n.id).sort()).toEqual(['n1', 'n2', 'n4']);

      // Only edges where both source and target are in src/main.ts
      // e1: n1->n2 (both in main.ts) ✓
      // e3: n2->n4 (both in main.ts) ✓
      // e2: n1->n3 (n3 in utils.ts) ✗
      // e4: n4->n3 (n3 in utils.ts) ✗
      expect(subgraph.edges).toHaveLength(2);
      expect(subgraph.edges.map(e => e.id).sort()).toEqual(['e1', 'e3']);
    });

    it('should return empty arrays for a non-existent file', () => {
      const subgraph = queries.extractSubgraph('src/nonexistent.ts');
      expect(subgraph.nodes).toHaveLength(0);
      expect(subgraph.edges).toHaveLength(0);
    });

    it('should return nodes with no internal edges if all edges cross file boundaries', () => {
      const subgraph = queries.extractSubgraph('src/utils.ts');
      expect(subgraph.nodes).toHaveLength(2); // n3, n5
      expect(subgraph.edges).toHaveLength(0); // no edges between n3 and n5
    });
  });

  describe('findPath', () => {
    it('should find a direct path between connected nodes', () => {
      const path = queries.findPath('n1', 'n2');
      expect(path).toHaveLength(2);
      expect(path[0].id).toBe('n1');
      expect(path[1].id).toBe('n2');
    });

    it('should find a multi-hop path', () => {
      // n1 -> n2 -> n4 -> n3 (via calls and references edges)
      // Actually: n1->n3 directly via e2, so shortest path is length 2
      const path = queries.findPath('n1', 'n3');
      expect(path.length).toBeGreaterThanOrEqual(2);
      expect(path[0].id).toBe('n1');
      expect(path[path.length - 1].id).toBe('n3');
    });

    it('should return an empty array when no path exists', () => {
      const path = queries.findPath('n3', 'n1');
      // n3 has no outgoing edges to n1
      expect(path).toHaveLength(0);
    });

    it('should return a single-node path when source equals target', () => {
      const path = queries.findPath('n1', 'n1');
      expect(path).toHaveLength(1);
      expect(path[0].id).toBe('n1');
    });

    it('should return an empty array for non-existent source', () => {
      const path = queries.findPath('nonexistent', 'n1');
      expect(path).toHaveLength(0);
    });

    it('should find the shortest path', () => {
      // n1 can reach n3 directly (e2: n1->n3) or via n2->n4->n3
      // Shortest is direct: n1->n3 (depth 1, path length 2)
      const path = queries.findPath('n1', 'n3');
      expect(path).toHaveLength(2);
      expect(path[0].id).toBe('n1');
      expect(path[1].id).toBe('n3');
    });

    it('should handle longer paths when no direct edge exists', () => {
      // n2 -> n4 -> n3 (via references then calls)
      const path = queries.findPath('n2', 'n3');
      expect(path).toHaveLength(3);
      expect(path[0].id).toBe('n2');
      expect(path[1].id).toBe('n4');
      expect(path[2].id).toBe('n3');
    });
  });
});

describe('WAL mode concurrent reads', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'graph-db-wal-'));
    dbPath = join(tmpDir, 'test.db');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should initialize database with WAL journal mode', () => {
    const db = initializeDatabase(dbPath);
    const result = db.pragma('journal_mode') as Array<{ journal_mode: string }>;
    expect(result[0].journal_mode).toBe('wal');
    db.close();
  });

  it('should allow concurrent read access from multiple connections', () => {
    const db1 = initializeDatabase(dbPath);
    // Insert test data through the first connection
    db1.prepare(`
      INSERT INTO nodes (id, type, file_path, start_byte, end_byte, start_line, start_column, end_line, end_column, is_error)
      VALUES ('node-a', 'function', 'src/a.ts', 0, 100, 1, 0, 5, 1, 0)
    `).run();

    // Open a second read connection
    const db2 = new Database(dbPath, { readonly: true });

    // Both connections can read concurrently
    const queries1 = new GraphQueries(db1);
    const queries2 = new GraphQueries(db2);

    const node1 = queries1.lookupNode('node-a');
    const node2 = queries2.lookupNode('node-a');

    expect(node1).not.toBeNull();
    expect(node2).not.toBeNull();
    expect(node1!.id).toBe('node-a');
    expect(node2!.id).toBe('node-a');

    db2.close();
    db1.close();
  });

  it('should allow reads while a write transaction is in progress', () => {
    const dbWriter = initializeDatabase(dbPath);
    // Insert initial data
    dbWriter.prepare(`
      INSERT INTO nodes (id, type, file_path, start_byte, end_byte, start_line, start_column, end_line, end_column, is_error)
      VALUES ('node-init', 'function', 'src/init.ts', 0, 50, 1, 0, 3, 1, 0)
    `).run();

    // Open a second read-only connection
    const dbReader = new Database(dbPath, { readonly: true });
    const readerQueries = new GraphQueries(dbReader);

    // Start a write transaction (but don't commit yet)
    const transaction = dbWriter.transaction(() => {
      dbWriter.prepare(`
        INSERT INTO nodes (id, type, file_path, start_byte, end_byte, start_line, start_column, end_line, end_column, is_error)
        VALUES ('node-new', 'function', 'src/new.ts', 0, 50, 1, 0, 3, 1, 0)
      `).run();

      // Reader can still read the pre-existing data while write transaction is open
      const existing = readerQueries.lookupNode('node-init');
      expect(existing).not.toBeNull();
      expect(existing!.id).toBe('node-init');
    });

    transaction();

    dbReader.close();
    dbWriter.close();
  });
});

describe('Referential integrity rejection', () => {
  let db: Database.Database;
  let writer: GraphWriter;

  beforeEach(() => {
    db = initializeDatabase(':memory:');
    writer = new GraphWriter(db);
  });

  afterEach(() => {
    db.close();
  });

  it('should reject edge write when source_id does not exist', async () => {
    // Insert target node only
    await writer.writeNode(makeNode({ id: 'target-node' }));

    await expect(
      writer.writeEdge(makeEdge({
        id: 'bad-edge',
        source_id: 'nonexistent-source',
        target_id: 'target-node',
      }))
    ).rejects.toThrow(ReferentialIntegrityError);

    // Verify the error identifies the missing node
    try {
      await writer.writeEdge(makeEdge({
        id: 'bad-edge-2',
        source_id: 'missing-source',
        target_id: 'target-node',
      }));
    } catch (err) {
      expect(err).toBeInstanceOf(ReferentialIntegrityError);
      expect((err as ReferentialIntegrityError).missingNodeId).toBe('missing-source');
    }
  });

  it('should reject edge write when target_id does not exist', async () => {
    // Insert source node only
    await writer.writeNode(makeNode({ id: 'source-node' }));

    await expect(
      writer.writeEdge(makeEdge({
        id: 'bad-edge',
        source_id: 'source-node',
        target_id: 'nonexistent-target',
      }))
    ).rejects.toThrow(ReferentialIntegrityError);

    try {
      await writer.writeEdge(makeEdge({
        id: 'bad-edge-2',
        source_id: 'source-node',
        target_id: 'missing-target',
      }));
    } catch (err) {
      expect(err).toBeInstanceOf(ReferentialIntegrityError);
      expect((err as ReferentialIntegrityError).missingNodeId).toBe('missing-target');
    }
  });

  it('should leave database state unchanged after referential integrity rejection', async () => {
    await writer.writeNode(makeNode({ id: 'existing-node' }));

    const edgeCountBefore = (db.prepare('SELECT COUNT(*) as cnt FROM edges').get() as { cnt: number }).cnt;

    await expect(
      writer.writeEdge(makeEdge({
        id: 'rejected-edge',
        source_id: 'existing-node',
        target_id: 'ghost-node',
      }))
    ).rejects.toThrow(ReferentialIntegrityError);

    const edgeCountAfter = (db.prepare('SELECT COUNT(*) as cnt FROM edges').get() as { cnt: number }).cnt;
    expect(edgeCountAfter).toBe(edgeCountBefore);
  });

  it('should allow edge write when both source_id and target_id exist', async () => {
    await writer.writeNode(makeNode({ id: 'src-node' }));
    await writer.writeNode(makeNode({ id: 'tgt-node' }));

    await expect(
      writer.writeEdge(makeEdge({
        id: 'valid-edge',
        source_id: 'src-node',
        target_id: 'tgt-node',
      }))
    ).resolves.toBeUndefined();

    const edge = db.prepare('SELECT * FROM edges WHERE id = ?').get('valid-edge');
    expect(edge).toBeDefined();
  });
});

describe('Retry exhaustion reporting', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initializeDatabase(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('should throw WriteExhaustedError after 3 failed retries', async () => {
    const writer = new GraphWriter(db);

    // Insert the same node to cause a unique constraint violation on retry
    await writer.writeNode(makeNode({ id: 'dup-node' }));

    // Trying to write the same node again will fail all 3 retries
    await expect(
      writer.writeNode(makeNode({ id: 'dup-node' }))
    ).rejects.toThrow(WriteExhaustedError);
  });

  it('should include affected node IDs in WriteExhaustedError', async () => {
    const writer = new GraphWriter(db);
    await writer.writeNode(makeNode({ id: 'existing-node' }));

    try {
      await writer.writeNode(makeNode({ id: 'existing-node' }));
    } catch (err) {
      expect(err).toBeInstanceOf(WriteExhaustedError);
      expect((err as WriteExhaustedError).affectedIds).toContain('existing-node');
    }
  });

  it('should preserve the original cause in WriteExhaustedError', async () => {
    const writer = new GraphWriter(db);
    await writer.writeNode(makeNode({ id: 'cause-node' }));

    try {
      await writer.writeNode(makeNode({ id: 'cause-node' }));
    } catch (err) {
      expect(err).toBeInstanceOf(WriteExhaustedError);
      expect((err as WriteExhaustedError).cause).toBeDefined();
    }
  });
});

describe('Query performance (<1000 nodes within 50ms)', () => {
  let db: Database.Database;
  let queries: GraphQueries;

  beforeEach(() => {
    db = initializeDatabase(':memory:');
    queries = new GraphQueries(db);

    // Insert 999 nodes (just under 1000) to test performance boundary
    const insertNode = db.prepare(`
      INSERT INTO nodes (id, type, file_path, start_byte, end_byte, start_line, start_column, end_line, end_column, is_error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertEdge = db.prepare(`
      INSERT INTO edges (id, source_id, target_id, relationship)
      VALUES (?, ?, ?, ?)
    `);

    const insertAll = db.transaction(() => {
      for (let i = 0; i < 999; i++) {
        insertNode.run(
          `node-${i}`,
          'function',
          `src/file-${i % 10}.ts`,
          i * 100,
          (i + 1) * 100,
          i + 1,
          0,
          i + 5,
          1,
          0
        );
      }
      // Create a chain of edges: node-0 -> node-1 -> ... -> node-998
      for (let i = 0; i < 998; i++) {
        insertEdge.run(`edge-${i}`, `node-${i}`, `node-${i + 1}`, 'calls');
      }
    });
    insertAll();
  });

  afterEach(() => {
    db.close();
  });

  it('should complete node lookup within 50ms', () => {
    const start = performance.now();
    queries.lookupNode('node-500');
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(50);
  });

  it('should complete edge traversal within 50ms', () => {
    const start = performance.now();
    queries.traverseEdges('node-0', 'calls');
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(50);
  });

  it('should complete subgraph extraction within 50ms for files with <1000 nodes', () => {
    // Each file has ~100 nodes (999 / 10 files)
    const start = performance.now();
    queries.extractSubgraph('src/file-0.ts');
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(50);
  });

  it('should complete path query within 50ms for short paths in a <1000 node graph', () => {
    const start = performance.now();
    // Find a short path (node-0 -> node-1 -> node-2)
    queries.findPath('node-0', 'node-2');
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(50);
  });
});

describe('Recursive CTE path queries', () => {
  let db: Database.Database;
  let queries: GraphQueries;

  beforeEach(() => {
    db = initializeDatabase(':memory:');
    queries = new GraphQueries(db);
  });

  afterEach(() => {
    db.close();
  });

  it('should traverse a linear chain via recursive CTE', () => {
    const insertNode = db.prepare(`
      INSERT INTO nodes (id, type, file_path, start_byte, end_byte, start_line, start_column, end_line, end_column, is_error)
      VALUES (?, 'function', 'src/chain.ts', 0, 10, 1, 0, 1, 10, 0)
    `);
    const insertEdge = db.prepare(`
      INSERT INTO edges (id, source_id, target_id, relationship) VALUES (?, ?, ?, 'calls')
    `);

    // Create a 5-node chain: A -> B -> C -> D -> E
    for (const id of ['A', 'B', 'C', 'D', 'E']) {
      insertNode.run(id);
    }
    insertEdge.run('e-ab', 'A', 'B');
    insertEdge.run('e-bc', 'B', 'C');
    insertEdge.run('e-cd', 'C', 'D');
    insertEdge.run('e-de', 'D', 'E');

    const path = queries.findPath('A', 'E');
    expect(path).toHaveLength(5);
    expect(path.map(n => n.id)).toEqual(['A', 'B', 'C', 'D', 'E']);
  });

  it('should handle diamond-shaped graphs (multiple paths) and return shortest', () => {
    const insertNode = db.prepare(`
      INSERT INTO nodes (id, type, file_path, start_byte, end_byte, start_line, start_column, end_line, end_column, is_error)
      VALUES (?, 'function', 'src/diamond.ts', 0, 10, 1, 0, 1, 10, 0)
    `);
    const insertEdge = db.prepare(`
      INSERT INTO edges (id, source_id, target_id, relationship) VALUES (?, ?, ?, 'calls')
    `);

    // Diamond: A -> B -> D, A -> C -> D
    for (const id of ['A', 'B', 'C', 'D']) {
      insertNode.run(id);
    }
    insertEdge.run('e-ab', 'A', 'B');
    insertEdge.run('e-ac', 'A', 'C');
    insertEdge.run('e-bd', 'B', 'D');
    insertEdge.run('e-cd', 'C', 'D');

    const path = queries.findPath('A', 'D');
    // Shortest path has 3 nodes (A -> B -> D or A -> C -> D)
    expect(path).toHaveLength(3);
    expect(path[0].id).toBe('A');
    expect(path[path.length - 1].id).toBe('D');
  });

  it('should avoid cycles in path traversal', () => {
    const insertNode = db.prepare(`
      INSERT INTO nodes (id, type, file_path, start_byte, end_byte, start_line, start_column, end_line, end_column, is_error)
      VALUES (?, 'function', 'src/cycle.ts', 0, 10, 1, 0, 1, 10, 0)
    `);
    const insertEdge = db.prepare(`
      INSERT INTO edges (id, source_id, target_id, relationship) VALUES (?, ?, ?, 'calls')
    `);

    // Cycle: A -> B -> C -> A, with separate edge C -> D
    for (const id of ['A', 'B', 'C', 'D']) {
      insertNode.run(id);
    }
    insertEdge.run('e-ab', 'A', 'B');
    insertEdge.run('e-bc', 'B', 'C');
    insertEdge.run('e-ca', 'C', 'A');
    insertEdge.run('e-cd', 'C', 'D');

    // Should find path A -> B -> C -> D without getting stuck in the cycle
    const path = queries.findPath('A', 'D');
    expect(path).toHaveLength(4);
    expect(path.map(n => n.id)).toEqual(['A', 'B', 'C', 'D']);
  });

  it('should handle disconnected graphs returning empty path', () => {
    const insertNode = db.prepare(`
      INSERT INTO nodes (id, type, file_path, start_byte, end_byte, start_line, start_column, end_line, end_column, is_error)
      VALUES (?, 'function', 'src/disconnected.ts', 0, 10, 1, 0, 1, 10, 0)
    `);
    const insertEdge = db.prepare(`
      INSERT INTO edges (id, source_id, target_id, relationship) VALUES (?, ?, ?, 'calls')
    `);

    // Two disconnected components: A -> B, C -> D
    for (const id of ['A', 'B', 'C', 'D']) {
      insertNode.run(id);
    }
    insertEdge.run('e-ab', 'A', 'B');
    insertEdge.run('e-cd', 'C', 'D');

    const path = queries.findPath('A', 'D');
    expect(path).toHaveLength(0);
  });

  it('should traverse paths across different relationship types', () => {
    const insertNode = db.prepare(`
      INSERT INTO nodes (id, type, file_path, start_byte, end_byte, start_line, start_column, end_line, end_column, is_error)
      VALUES (?, 'function', 'src/multi.ts', 0, 10, 1, 0, 1, 10, 0)
    `);
    const insertEdge = db.prepare(`
      INSERT INTO edges (id, source_id, target_id, relationship) VALUES (?, ?, ?, ?)
    `);

    // Path uses mixed relationship types: A -calls-> B -references-> C
    for (const id of ['A', 'B', 'C']) {
      insertNode.run(id);
    }
    insertEdge.run('e-ab', 'A', 'B', 'calls');
    insertEdge.run('e-bc', 'B', 'C', 'references');

    const path = queries.findPath('A', 'C');
    expect(path).toHaveLength(3);
    expect(path.map(n => n.id)).toEqual(['A', 'B', 'C']);
  });
});
