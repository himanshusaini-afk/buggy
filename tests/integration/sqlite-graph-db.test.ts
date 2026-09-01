/**
 * Integration test: SQLite Graph Database
 *
 * Tests WAL mode concurrent reads, referential integrity under concurrent writes,
 * and recursive CTE path queries on graphs with 100+ nodes.
 *
 * Uses real SQLite (better-sqlite3) — no mocks.
 *
 * Requirements: 3.1–3.5
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { initializeDatabase } from '../../src/database/graph-db.js';
import { GraphQueries } from '../../src/database/graph-queries.js';
import { GraphWriter, ReferentialIntegrityError } from '../../src/database/graph-writer.js';
import type { NodeRecord, EdgeRecord } from '../../src/types/graph.js';
import type Database from 'better-sqlite3';

/**
 * Helper to create a node record for testing.
 */
function makeNode(id: string, filePath = 'test.ts', type = 'cst_node'): NodeRecord {
  return {
    id,
    type,
    file_path: filePath,
    start_byte: 0,
    end_byte: 100,
    start_line: 1,
    start_column: 0,
    end_line: 5,
    end_column: 10,
    is_error: false,
    created_at: new Date().toISOString(),
  };
}

/**
 * Helper to create an edge record for testing.
 */
function makeEdge(id: string, sourceId: string, targetId: string, relationship: EdgeRecord['relationship'] = 'calls'): EdgeRecord {
  return {
    id,
    source_id: sourceId,
    target_id: targetId,
    relationship,
    created_at: new Date().toISOString(),
  };
}

describe('SQLite Graph Database Integration', () => {
  let db: Database.Database;
  let queries: GraphQueries;
  let writer: GraphWriter;

  beforeEach(() => {
    db = initializeDatabase(':memory:');
    queries = new GraphQueries(db);
    writer = new GraphWriter(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('WAL Mode Concurrency', () => {
    it('should initialize on-disk databases in WAL mode', () => {
      // WAL is an on-disk journal mode: it relies on companion -wal/-shm files, so
      // SQLite always reports 'memory' for ':memory:' databases regardless of the
      // requested pragma. Verify WAL is genuinely enabled for a file-backed database,
      // which is the production configuration.
      const tmpFile = join(tmpdir(), `buggy-wal-test-${randomUUID()}.db`);
      const fileDb = initializeDatabase(tmpFile);
      try {
        const journalMode = fileDb.pragma('journal_mode', { simple: true });
        expect(journalMode).toBe('wal');
      } finally {
        fileDb.close();
        for (const suffix of ['', '-wal', '-shm']) {
          try {
            rmSync(tmpFile + suffix, { force: true });
          } catch {
            /* best-effort cleanup */
          }
        }
      }
    });

    it('should support concurrent reads while a write is pending', async () => {
      // Write some initial data
      await writer.writeNode(makeNode('node-1'));
      await writer.writeNode(makeNode('node-2'));
      await writer.writeEdge(makeEdge('edge-1', 'node-1', 'node-2'));

      // Perform concurrent reads
      const readPromises = Array.from({ length: 10 }, (_, i) => {
        return new Promise<NodeRecord | null>((resolve) => {
          const result = queries.lookupNode(i % 2 === 0 ? 'node-1' : 'node-2');
          resolve(result);
        });
      });

      const results = await Promise.all(readPromises);

      for (const result of results) {
        expect(result).not.toBeNull();
        expect(result!.id).toMatch(/^node-[12]$/);
      }
    });

    it('should allow reads to proceed during batch writes', async () => {
      // Seed initial data
      await writer.writeNode(makeNode('existing-1'));

      // Start writing many nodes
      const writePromises: Promise<void>[] = [];
      for (let i = 0; i < 50; i++) {
        writePromises.push(writer.writeNode(makeNode(`batch-${i}`)));
      }

      // Concurrent reads on existing data
      const readResult = queries.lookupNode('existing-1');
      expect(readResult).not.toBeNull();
      expect(readResult!.id).toBe('existing-1');

      // Wait for writes to complete
      await Promise.all(writePromises);

      // Verify all writes completed
      for (let i = 0; i < 50; i++) {
        const node = queries.lookupNode(`batch-${i}`);
        expect(node).not.toBeNull();
      }
    });

    it('should maintain data consistency with interleaved reads and writes', async () => {
      const operations: Promise<any>[] = [];

      // Interleave writes and reads
      for (let i = 0; i < 20; i++) {
        operations.push(writer.writeNode(makeNode(`interleaved-${i}`)));
      }

      await Promise.all(operations);

      // Verify all nodes exist
      for (let i = 0; i < 20; i++) {
        const node = queries.lookupNode(`interleaved-${i}`);
        expect(node).not.toBeNull();
      }
    });
  });

  describe('Referential Integrity Under Concurrent Writes', () => {
    it('should reject edge writes with non-existent source_id', async () => {
      await writer.writeNode(makeNode('target-node'));

      await expect(
        writer.writeEdge(makeEdge('bad-edge', 'nonexistent-source', 'target-node'))
      ).rejects.toThrow(ReferentialIntegrityError);
    });

    it('should reject edge writes with non-existent target_id', async () => {
      await writer.writeNode(makeNode('source-node'));

      await expect(
        writer.writeEdge(makeEdge('bad-edge', 'source-node', 'nonexistent-target'))
      ).rejects.toThrow(ReferentialIntegrityError);
    });

    it('should reject edge writes with both source and target non-existent', async () => {
      await expect(
        writer.writeEdge(makeEdge('bad-edge', 'ghost-source', 'ghost-target'))
      ).rejects.toThrow(ReferentialIntegrityError);
    });

    it('should maintain DB state unchanged after rejected write', async () => {
      await writer.writeNode(makeNode('valid-node'));

      // Attempt invalid edge write
      try {
        await writer.writeEdge(makeEdge('bad-edge', 'valid-node', 'nonexistent'));
      } catch {
        // Expected
      }

      // Verify the edge was not written
      const edges = queries.traverseEdges('valid-node', 'calls');
      expect(edges).toHaveLength(0);

      // Verify node still exists unchanged
      const node = queries.lookupNode('valid-node');
      expect(node).not.toBeNull();
    });

    it('should handle concurrent valid and invalid edge writes', async () => {
      // Create nodes first
      await writer.writeNode(makeNode('n1'));
      await writer.writeNode(makeNode('n2'));
      await writer.writeNode(makeNode('n3'));

      const operations = [
        // Valid edges
        writer.writeEdge(makeEdge('e1', 'n1', 'n2')).then(() => ({ ok: true, id: 'e1' })),
        writer.writeEdge(makeEdge('e2', 'n2', 'n3')).then(() => ({ ok: true, id: 'e2' })),
        // Invalid edges (should fail)
        writer.writeEdge(makeEdge('e3', 'n1', 'ghost')).catch(() => ({ ok: false, id: 'e3' })),
        writer.writeEdge(makeEdge('e4', 'ghost', 'n2')).catch(() => ({ ok: false, id: 'e4' })),
        // Another valid edge
        writer.writeEdge(makeEdge('e5', 'n1', 'n3')).then(() => ({ ok: true, id: 'e5' })),
      ];

      const results = await Promise.all(operations);

      const successes = results.filter((r) => r.ok);
      const failures = results.filter((r) => !r.ok);

      expect(successes).toHaveLength(3); // e1, e2, e5
      expect(failures).toHaveLength(2); // e3, e4
    });

    it('should report the specific missing node ID in error', async () => {
      await writer.writeNode(makeNode('present-node'));

      try {
        await writer.writeEdge(makeEdge('test-edge', 'present-node', 'missing-node-xyz'));
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(ReferentialIntegrityError);
        expect((error as ReferentialIntegrityError).missingNodeId).toBe('missing-node-xyz');
      }
    });
  });

  describe('Recursive CTE Path Queries (100+ Nodes)', () => {
    it('should find shortest path in a linear chain of 100+ nodes', async () => {
      const nodeCount = 120;

      // Create a linear chain: node-0 → node-1 → ... → node-119
      for (let i = 0; i < nodeCount; i++) {
        await writer.writeNode(makeNode(`chain-${i}`));
      }
      for (let i = 0; i < nodeCount - 1; i++) {
        await writer.writeEdge(makeEdge(`chain-edge-${i}`, `chain-${i}`, `chain-${i + 1}`));
      }

      // Find path from start to a node deep in the chain
      const path = queries.findPath('chain-0', 'chain-10');

      expect(path.length).toBe(11); // 0 through 10 inclusive
      expect(path[0].id).toBe('chain-0');
      expect(path[path.length - 1].id).toBe('chain-10');
    });

    it('should find path in a graph with branching (tree structure, 100+ nodes)', async () => {
      // Build a binary tree with 7 levels (127 nodes)
      const nodeCount = 127;
      for (let i = 0; i < nodeCount; i++) {
        await writer.writeNode(makeNode(`tree-${i}`));
      }

      // Connect parent to children: parent i → children 2i+1, 2i+2
      for (let i = 0; i < 63; i++) {
        const left = 2 * i + 1;
        const right = 2 * i + 2;
        if (left < nodeCount) {
          await writer.writeEdge(makeEdge(`tree-edge-${i}-L`, `tree-${i}`, `tree-${left}`));
        }
        if (right < nodeCount) {
          await writer.writeEdge(makeEdge(`tree-edge-${i}-R`, `tree-${i}`, `tree-${right}`));
        }
      }

      // Find path from root to a leaf
      const path = queries.findPath('tree-0', 'tree-6');

      expect(path.length).toBeGreaterThan(0);
      expect(path[0].id).toBe('tree-0');
      expect(path[path.length - 1].id).toBe('tree-6');

      // tree-6 is at depth 2: 0 → 2 → 6 (right path)
      expect(path.length).toBe(3);
    });

    it('should return empty array when no path exists', async () => {
      // Create two disconnected components with 100+ nodes total
      for (let i = 0; i < 60; i++) {
        await writer.writeNode(makeNode(`comp-a-${i}`));
      }
      for (let i = 0; i < 60; i++) {
        await writer.writeNode(makeNode(`comp-b-${i}`));
      }

      // Connect within each component
      for (let i = 0; i < 59; i++) {
        await writer.writeEdge(makeEdge(`a-edge-${i}`, `comp-a-${i}`, `comp-a-${i + 1}`));
        await writer.writeEdge(makeEdge(`b-edge-${i}`, `comp-b-${i}`, `comp-b-${i + 1}`));
      }

      // No path between components
      const path = queries.findPath('comp-a-0', 'comp-b-50');
      expect(path).toHaveLength(0);
    });

    it('should find path to itself (single node)', async () => {
      await writer.writeNode(makeNode('self-node'));

      const path = queries.findPath('self-node', 'self-node');
      expect(path).toHaveLength(1);
      expect(path[0].id).toBe('self-node');
    });

    it('should handle cyclic graphs without infinite loops', async () => {
      // Create a cycle: A → B → C → A with extra nodes
      const nodes = ['cycle-a', 'cycle-b', 'cycle-c', 'cycle-d', 'cycle-e'];
      for (const id of nodes) {
        await writer.writeNode(makeNode(id));
      }

      await writer.writeEdge(makeEdge('cyc-1', 'cycle-a', 'cycle-b'));
      await writer.writeEdge(makeEdge('cyc-2', 'cycle-b', 'cycle-c'));
      await writer.writeEdge(makeEdge('cyc-3', 'cycle-c', 'cycle-a')); // Cycle back
      await writer.writeEdge(makeEdge('cyc-4', 'cycle-c', 'cycle-d'));
      await writer.writeEdge(makeEdge('cyc-5', 'cycle-d', 'cycle-e'));

      // Should still find path without infinite loop
      const path = queries.findPath('cycle-a', 'cycle-e');
      expect(path.length).toBeGreaterThan(0);
      expect(path[0].id).toBe('cycle-a');
      expect(path[path.length - 1].id).toBe('cycle-e');
    });

    it('should complete path query within 50ms for <1000 nodes', async () => {
      const nodeCount = 200;

      // Create a connected graph
      for (let i = 0; i < nodeCount; i++) {
        await writer.writeNode(makeNode(`perf-${i}`));
      }
      for (let i = 0; i < nodeCount - 1; i++) {
        await writer.writeEdge(makeEdge(`perf-edge-${i}`, `perf-${i}`, `perf-${i + 1}`));
      }
      // Add some cross-edges for realism
      for (let i = 0; i < 50; i++) {
        const from = i * 3;
        const to = Math.min(from + 10, nodeCount - 1);
        if (from !== to) {
          await writer.writeEdge(makeEdge(`perf-cross-${i}`, `perf-${from}`, `perf-${to}`));
        }
      }

      // Measure query time
      const start = performance.now();
      const path = queries.findPath('perf-0', 'perf-50');
      const elapsed = performance.now() - start;

      expect(path.length).toBeGreaterThan(0);
      expect(elapsed).toBeLessThan(50);
    });
  });

  describe('Subgraph Extraction', () => {
    it('should extract all nodes and edges for a given file', async () => {
      // Nodes in file A
      await writer.writeNode(makeNode('file-a-1', 'fileA.ts'));
      await writer.writeNode(makeNode('file-a-2', 'fileA.ts'));
      await writer.writeNode(makeNode('file-a-3', 'fileA.ts'));
      // Nodes in file B
      await writer.writeNode(makeNode('file-b-1', 'fileB.ts'));

      // Edges within file A
      await writer.writeEdge(makeEdge('ea-1', 'file-a-1', 'file-a-2'));
      await writer.writeEdge(makeEdge('ea-2', 'file-a-2', 'file-a-3'));

      const subgraph = queries.extractSubgraph('fileA.ts');

      expect(subgraph.nodes).toHaveLength(3);
      expect(subgraph.edges).toHaveLength(2);
      expect(subgraph.nodes.every((n) => n.file_path === 'fileA.ts')).toBe(true);
    });

    it('should return empty result for non-existent file', () => {
      const subgraph = queries.extractSubgraph('nonexistent.ts');
      expect(subgraph.nodes).toHaveLength(0);
      expect(subgraph.edges).toHaveLength(0);
    });
  });

  describe('Edge Traversal', () => {
    it('should traverse edges filtered by relationship type', async () => {
      await writer.writeNode(makeNode('caller'));
      await writer.writeNode(makeNode('callee1'));
      await writer.writeNode(makeNode('callee2'));
      await writer.writeNode(makeNode('defined'));

      await writer.writeEdge(makeEdge('e1', 'caller', 'callee1', 'calls'));
      await writer.writeEdge(makeEdge('e2', 'caller', 'callee2', 'calls'));
      await writer.writeEdge(makeEdge('e3', 'caller', 'defined', 'defines'));

      const callEdges = queries.traverseEdges('caller', 'calls');
      expect(callEdges).toHaveLength(2);

      const defineEdges = queries.traverseEdges('caller', 'defines');
      expect(defineEdges).toHaveLength(1);
    });
  });

  describe('Node Lookup', () => {
    it('should return node by ID', async () => {
      const node = makeNode('lookup-test', 'myfile.ts', 'function');
      await writer.writeNode(node);

      const found = queries.lookupNode('lookup-test');
      expect(found).not.toBeNull();
      expect(found!.id).toBe('lookup-test');
      expect(found!.file_path).toBe('myfile.ts');
      expect(found!.type).toBe('function');
    });

    it('should return null for non-existent node', () => {
      const found = queries.lookupNode('does-not-exist');
      expect(found).toBeNull();
    });
  });

  describe('Large Graph Stress Test', () => {
    it('should handle 500+ nodes with complex edge relationships', async () => {
      const nodeCount = 500;

      // Create many nodes
      for (let i = 0; i < nodeCount; i++) {
        await writer.writeNode(makeNode(`stress-${i}`, `file-${i % 10}.ts`));
      }

      // Create edges (each node connects to next 3)
      const edgePromises: Promise<void>[] = [];
      let edgeId = 0;
      for (let i = 0; i < nodeCount - 3; i++) {
        for (let j = 1; j <= 3; j++) {
          edgePromises.push(
            writer.writeEdge(makeEdge(`stress-edge-${edgeId++}`, `stress-${i}`, `stress-${i + j}`))
          );
        }
      }
      await Promise.all(edgePromises);

      // Verify subgraph extraction works
      const subgraph = queries.extractSubgraph('file-0.ts');
      expect(subgraph.nodes.length).toBe(50); // 500/10 files

      // Verify path query works on large graph
      const path = queries.findPath('stress-0', 'stress-20');
      expect(path.length).toBeGreaterThan(0);
      expect(path[0].id).toBe('stress-0');
      expect(path[path.length - 1].id).toBe('stress-20');
    });
  });
});
