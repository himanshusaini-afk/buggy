import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeDatabase } from '../../src/database/graph-db.js';
import {
  GraphWriter,
  ReferentialIntegrityError,
  WriteExhaustedError,
} from '../../src/database/graph-writer.js';
import type { NodeRecord, EdgeRecord } from '../../src/types/graph.js';
import type { SymbolResolutionRecord } from '../../src/database/graph-writer.js';

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

function makeSymbolResolution(
  overrides: Partial<SymbolResolutionRecord> = {}
): SymbolResolutionRecord {
  return {
    id: 'sym-1',
    usage_node_id: 'node-1',
    definition_node_id: 'node-2',
    symbol_name: 'myFunction',
    type_info: '() => void',
    enclosing_scope: 'module',
    resolved: true,
    ...overrides,
  };
}

describe('GraphWriter', () => {
  let db: Database.Database;
  let writer: GraphWriter;

  beforeEach(() => {
    db = initializeDatabase(':memory:');
    writer = new GraphWriter(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('writeNode', () => {
    it('should insert a node into the nodes table', async () => {
      const node = makeNode();
      await writer.writeNode(node);

      const row = db.prepare('SELECT * FROM nodes WHERE id = ?').get(node.id) as any;
      expect(row).toBeDefined();
      expect(row.id).toBe('node-1');
      expect(row.type).toBe('cst_node');
      expect(row.file_path).toBe('/src/main.ts');
      expect(row.start_byte).toBe(0);
      expect(row.end_byte).toBe(100);
      expect(row.is_error).toBe(0);
    });

    it('should insert a node with optional fields', async () => {
      const node = makeNode({
        node_kind: 'function_declaration',
        text_content: 'function foo() {}',
        metadata: '{"scope":"global"}',
      });
      await writer.writeNode(node);

      const row = db.prepare('SELECT * FROM nodes WHERE id = ?').get(node.id) as any;
      expect(row.node_kind).toBe('function_declaration');
      expect(row.text_content).toBe('function foo() {}');
      expect(row.metadata).toBe('{"scope":"global"}');
    });

    it('should insert an error node correctly', async () => {
      const node = makeNode({ id: 'error-node', is_error: true });
      await writer.writeNode(node);

      const row = db.prepare('SELECT * FROM nodes WHERE id = ?').get('error-node') as any;
      expect(row.is_error).toBe(1);
    });

    it('should batch multiple writes via microtask scheduling', async () => {
      const node1 = makeNode({ id: 'batch-1' });
      const node2 = makeNode({ id: 'batch-2' });
      const node3 = makeNode({ id: 'batch-3' });

      // All three are enqueued before the microtask flushes
      await Promise.all([
        writer.writeNode(node1),
        writer.writeNode(node2),
        writer.writeNode(node3),
      ]);

      const count = db.prepare('SELECT COUNT(*) as cnt FROM nodes').get() as any;
      expect(count.cnt).toBe(3);
    });
  });

  describe('writeEdge', () => {
    it('should insert an edge when both nodes exist', async () => {
      const source = makeNode({ id: 'node-1' });
      const target = makeNode({ id: 'node-2' });
      await writer.writeNode(source);
      await writer.writeNode(target);

      const edge = makeEdge();
      await writer.writeEdge(edge);

      const row = db.prepare('SELECT * FROM edges WHERE id = ?').get(edge.id) as any;
      expect(row).toBeDefined();
      expect(row.source_id).toBe('node-1');
      expect(row.target_id).toBe('node-2');
      expect(row.relationship).toBe('calls');
    });

    it('should throw ReferentialIntegrityError when source_id does not exist', async () => {
      const target = makeNode({ id: 'node-2' });
      await writer.writeNode(target);

      const edge = makeEdge({ source_id: 'nonexistent' });

      await expect(writer.writeEdge(edge)).rejects.toThrow(ReferentialIntegrityError);
      await expect(writer.writeEdge(edge)).rejects.toMatchObject({
        missingNodeId: 'nonexistent',
      });
    });

    it('should throw ReferentialIntegrityError when target_id does not exist', async () => {
      const source = makeNode({ id: 'node-1' });
      await writer.writeNode(source);

      const edge = makeEdge({ target_id: 'nonexistent' });

      await expect(writer.writeEdge(edge)).rejects.toThrow(ReferentialIntegrityError);
      await expect(writer.writeEdge(edge)).rejects.toMatchObject({
        missingNodeId: 'nonexistent',
      });
    });

    it('should not insert edge into database when referential integrity fails', async () => {
      const edge = makeEdge({ source_id: 'missing-source', target_id: 'missing-target' });

      await expect(writer.writeEdge(edge)).rejects.toThrow(ReferentialIntegrityError);

      const count = db.prepare('SELECT COUNT(*) as cnt FROM edges').get() as any;
      expect(count.cnt).toBe(0);
    });

    it('should store edge metadata as JSON', async () => {
      const source = makeNode({ id: 'node-1' });
      const target = makeNode({ id: 'node-2' });
      await writer.writeNode(source);
      await writer.writeNode(target);

      const edge = makeEdge({ metadata: '{"weight":1}' });
      await writer.writeEdge(edge);

      const row = db.prepare('SELECT * FROM edges WHERE id = ?').get(edge.id) as any;
      expect(row.metadata).toBe('{"weight":1}');
    });
  });

  describe('writeSymbolResolution', () => {
    it('should insert a resolved symbol resolution', async () => {
      const usageNode = makeNode({ id: 'node-1' });
      const defNode = makeNode({ id: 'node-2' });
      await writer.writeNode(usageNode);
      await writer.writeNode(defNode);

      const resolution = makeSymbolResolution();
      await writer.writeSymbolResolution(resolution);

      const row = db
        .prepare('SELECT * FROM symbol_resolutions WHERE id = ?')
        .get(resolution.id) as any;
      expect(row).toBeDefined();
      expect(row.symbol_name).toBe('myFunction');
      expect(row.resolved).toBe(1);
      expect(row.type_info).toBe('() => void');
      expect(row.enclosing_scope).toBe('module');
    });

    it('should insert an unresolved symbol resolution with null definition', async () => {
      const usageNode = makeNode({ id: 'node-1' });
      await writer.writeNode(usageNode);

      const resolution = makeSymbolResolution({
        definition_node_id: null,
        resolved: false,
      });
      await writer.writeSymbolResolution(resolution);

      const row = db
        .prepare('SELECT * FROM symbol_resolutions WHERE id = ?')
        .get(resolution.id) as any;
      expect(row.definition_node_id).toBeNull();
      expect(row.resolved).toBe(0);
    });
  });

  describe('retry logic', () => {
    it('should throw WriteExhaustedError after 3 failed retries', async () => {
      // Insert a node, then try to insert the same node again (UNIQUE constraint violation)
      const node = makeNode({ id: 'duplicate' });
      await writer.writeNode(node);

      // Attempting to insert the same node should trigger retries and then fail
      await expect(writer.writeNode(node)).rejects.toThrow(WriteExhaustedError);
    });

    it('should include affected IDs in WriteExhaustedError', async () => {
      const node = makeNode({ id: 'dup-id' });
      await writer.writeNode(node);

      try {
        await writer.writeNode(node);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(WriteExhaustedError);
        expect((err as WriteExhaustedError).affectedIds).toContain('dup-id');
      }
    });

    it('should not retry ReferentialIntegrityError', async () => {
      const edge = makeEdge({ source_id: 'missing' });

      const start = Date.now();
      await expect(writer.writeEdge(edge)).rejects.toThrow(ReferentialIntegrityError);
      const elapsed = Date.now() - start;

      // ReferentialIntegrityError should not retry (no 300ms delay)
      expect(elapsed).toBeLessThan(50);
    });
  });

  describe('latency', () => {
    it('should complete a write within 5ms latency addition', async () => {
      const node = makeNode();
      const start = performance.now();
      await writer.writeNode(node);
      const elapsed = performance.now() - start;

      // The microtask-based batching should not add more than 5ms
      expect(elapsed).toBeLessThan(10); // generous margin for CI
    });
  });
});
