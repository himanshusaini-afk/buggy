import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fc from 'fast-check';
import Database from 'better-sqlite3';
import { initializeDatabase } from '../../src/database/graph-db.js';
import {
  GraphWriter,
  ReferentialIntegrityError,
} from '../../src/database/graph-writer.js';
import { GraphQueries } from '../../src/database/graph-queries.js';
import type { NodeRecord, EdgeRecord } from '../../src/types/graph.js';

/**
 * Property 6: Referential Integrity Enforcement
 *
 * For any write operation to the edges table where source_id or target_id
 * does not exist in the nodes table, the Graph_Database shall reject the
 * write and return an error identifying the missing target node, leaving
 * the database state unchanged.
 *
 * **Validates: Requirements 3.4**
 */

// --- Arbitraries ---

const arbNodeId = fc.stringOf(
  fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-_'.split('')),
  { minLength: 1, maxLength: 20 }
);

const arbRelationship = fc.constantFrom(
  'parent_of' as const,
  'calls' as const,
  'references' as const,
  'defines' as const,
  'type_of' as const
);

function makeNodeRecord(id: string): NodeRecord {
  return {
    id,
    type: 'cst_node',
    file_path: '/src/test.ts',
    start_byte: 0,
    end_byte: 100,
    start_line: 1,
    start_column: 0,
    end_line: 5,
    end_column: 10,
    is_error: false,
    created_at: '2024-01-01T00:00:00Z',
  };
}

function makeEdgeRecord(
  id: string,
  sourceId: string,
  targetId: string,
  relationship: EdgeRecord['relationship']
): EdgeRecord {
  return {
    id,
    source_id: sourceId,
    target_id: targetId,
    relationship,
    created_at: '2024-01-01T00:00:00Z',
  };
}

describe('Property 6: Referential Integrity Enforcement', () => {
  let db: Database.Database;
  let writer: GraphWriter;

  beforeEach(() => {
    db = initializeDatabase(':memory:');
    writer = new GraphWriter(db);
  });

  afterEach(() => {
    db.close();
  });

  it('should reject edge writes with non-existent source_id and identify the missing node', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Generate a set of valid node IDs to insert
        fc.uniqueArray(arbNodeId, { minLength: 1, maxLength: 5 }),
        // Generate the invalid source_id (guaranteed not in valid set)
        arbNodeId,
        // Generate an edge ID
        arbNodeId,
        arbRelationship,
        async (validNodeIds, invalidSourceBase, edgeId, relationship) => {
          // Ensure the invalid source ID is NOT in the valid set
          const invalidSourceId = `invalid-src-${invalidSourceBase}`;
          const validIds = validNodeIds.map((id) => `valid-${id}`);

          // Recreate fresh DB state for each property run
          const localDb = initializeDatabase(':memory:');
          const localWriter = new GraphWriter(localDb);

          try {
            // Insert valid nodes
            for (const nodeId of validIds) {
              await localWriter.writeNode(makeNodeRecord(nodeId));
            }

            // Pick a valid target_id from the inserted nodes
            const targetId = validIds[0];

            // Attempt edge write with invalid source_id
            const edge = makeEdgeRecord(
              `edge-${edgeId}`,
              invalidSourceId,
              targetId,
              relationship
            );

            const edgeCountBefore = (
              localDb.prepare('SELECT COUNT(*) as cnt FROM edges').get() as any
            ).cnt;

            // Should throw ReferentialIntegrityError identifying the missing source node
            await expect(localWriter.writeEdge(edge)).rejects.toThrow(
              ReferentialIntegrityError
            );

            try {
              await localWriter.writeEdge(edge);
            } catch (err) {
              expect(err).toBeInstanceOf(ReferentialIntegrityError);
              expect((err as ReferentialIntegrityError).missingNodeId).toBe(
                invalidSourceId
              );
            }

            // DB state unchanged
            const edgeCountAfter = (
              localDb.prepare('SELECT COUNT(*) as cnt FROM edges').get() as any
            ).cnt;
            expect(edgeCountAfter).toBe(edgeCountBefore);
          } finally {
            localDb.close();
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should reject edge writes with non-existent target_id and identify the missing node', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Generate a set of valid node IDs to insert
        fc.uniqueArray(arbNodeId, { minLength: 1, maxLength: 5 }),
        // Generate the invalid target_id (guaranteed not in valid set)
        arbNodeId,
        // Generate an edge ID
        arbNodeId,
        arbRelationship,
        async (validNodeIds, invalidTargetBase, edgeId, relationship) => {
          // Ensure the invalid target ID is NOT in the valid set
          const invalidTargetId = `invalid-tgt-${invalidTargetBase}`;
          const validIds = validNodeIds.map((id) => `valid-${id}`);

          const localDb = initializeDatabase(':memory:');
          const localWriter = new GraphWriter(localDb);

          try {
            // Insert valid nodes
            for (const nodeId of validIds) {
              await localWriter.writeNode(makeNodeRecord(nodeId));
            }

            // Pick a valid source_id from the inserted nodes
            const sourceId = validIds[0];

            // Attempt edge write with invalid target_id
            const edge = makeEdgeRecord(
              `edge-${edgeId}`,
              sourceId,
              invalidTargetId,
              relationship
            );

            const edgeCountBefore = (
              localDb.prepare('SELECT COUNT(*) as cnt FROM edges').get() as any
            ).cnt;

            // Should throw ReferentialIntegrityError identifying the missing target node
            await expect(localWriter.writeEdge(edge)).rejects.toThrow(
              ReferentialIntegrityError
            );

            try {
              await localWriter.writeEdge(edge);
            } catch (err) {
              expect(err).toBeInstanceOf(ReferentialIntegrityError);
              expect((err as ReferentialIntegrityError).missingNodeId).toBe(
                invalidTargetId
              );
            }

            // DB state unchanged
            const edgeCountAfter = (
              localDb.prepare('SELECT COUNT(*) as cnt FROM edges').get() as any
            ).cnt;
            expect(edgeCountAfter).toBe(edgeCountBefore);
          } finally {
            localDb.close();
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should reject edge writes where both source_id and target_id are non-existent', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbNodeId,
        arbNodeId,
        arbNodeId,
        arbRelationship,
        async (invalidSourceBase, invalidTargetBase, edgeId, relationship) => {
          const invalidSourceId = `nosrc-${invalidSourceBase}`;
          const invalidTargetId = `notgt-${invalidTargetBase}`;

          const localDb = initializeDatabase(':memory:');
          const localWriter = new GraphWriter(localDb);

          try {
            const edge = makeEdgeRecord(
              `edge-${edgeId}`,
              invalidSourceId,
              invalidTargetId,
              relationship
            );

            const edgeCountBefore = (
              localDb.prepare('SELECT COUNT(*) as cnt FROM edges').get() as any
            ).cnt;

            // Should throw ReferentialIntegrityError (source checked first)
            await expect(localWriter.writeEdge(edge)).rejects.toThrow(
              ReferentialIntegrityError
            );

            try {
              await localWriter.writeEdge(edge);
            } catch (err) {
              expect(err).toBeInstanceOf(ReferentialIntegrityError);
              // The error should identify the source_id as missing (checked first)
              expect((err as ReferentialIntegrityError).missingNodeId).toBe(
                invalidSourceId
              );
            }

            // DB state unchanged - no edge inserted
            const edgeCountAfter = (
              localDb.prepare('SELECT COUNT(*) as cnt FROM edges').get() as any
            ).cnt;
            expect(edgeCountAfter).toBe(edgeCountBefore);
          } finally {
            localDb.close();
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should accept edge writes where both source_id and target_id exist', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(arbNodeId, { minLength: 2, maxLength: 10 }),
        arbNodeId,
        arbRelationship,
        async (nodeIds, edgeId, relationship) => {
          const validIds = nodeIds.map((id) => `node-${id}`);

          const localDb = initializeDatabase(':memory:');
          const localWriter = new GraphWriter(localDb);

          try {
            // Insert all nodes
            for (const nodeId of validIds) {
              await localWriter.writeNode(makeNodeRecord(nodeId));
            }

            const sourceId = validIds[0];
            const targetId = validIds[1];

            const edge = makeEdgeRecord(
              `edge-valid-${edgeId}`,
              sourceId,
              targetId,
              relationship
            );

            // Should succeed without throwing
            await localWriter.writeEdge(edge);

            // Verify edge was inserted
            const row = localDb
              .prepare('SELECT * FROM edges WHERE id = ?')
              .get(edge.id) as any;
            expect(row).toBeDefined();
            expect(row.source_id).toBe(sourceId);
            expect(row.target_id).toBe(targetId);
            expect(row.relationship).toBe(relationship);
          } finally {
            localDb.close();
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should leave DB state unchanged after any rejected edge write (mixed valid/invalid batch)', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Generate valid nodes (enough to create unique edges)
        fc.uniqueArray(arbNodeId, { minLength: 2, maxLength: 8 }),
        // Generate a sequence of edge writes: each is { valid: boolean }
        fc.array(fc.boolean(), { minLength: 3, maxLength: 8 }),
        async (nodeIdBases, edgeValidityFlags) => {
          const validIds = nodeIdBases.map((id) => `n-${id}`);

          const localDb = initializeDatabase(':memory:');
          const localWriter = new GraphWriter(localDb);

          try {
            // Insert valid nodes
            for (const nodeId of validIds) {
              await localWriter.writeNode(makeNodeRecord(nodeId));
            }

            let expectedEdgeCount = 0;
            // Track used (source, target, relationship) combos to avoid UNIQUE constraint issues
            const usedEdges = new Set<string>();

            for (let i = 0; i < edgeValidityFlags.length; i++) {
              const isValid = edgeValidityFlags[i];

              if (isValid) {
                // Valid edge: pick a unique (source, target, relationship) combo
                const sourceIdx = i % validIds.length;
                const targetIdx = (i + 1) % validIds.length;
                const sourceId = validIds[sourceIdx];
                const targetId = validIds[targetIdx];
                // Use unique edge ID as the only relationship differentiator
                const relationship = 'parent_of' as const;
                const key = `${sourceId}:${targetId}:${relationship}`;

                if (usedEdges.has(key)) {
                  // Skip to avoid UNIQUE constraint collision (not testing integrity here)
                  continue;
                }
                usedEdges.add(key);

                const edge = makeEdgeRecord(
                  `edge-batch-${i}`,
                  sourceId,
                  targetId,
                  relationship
                );

                await localWriter.writeEdge(edge);
                expectedEdgeCount++;
              } else {
                // Invalid edge: non-existent source — tests referential integrity
                const edge = makeEdgeRecord(
                  `edge-batch-${i}`,
                  `nonexistent-${i}`,
                  validIds[0],
                  'parent_of'
                );

                await expect(localWriter.writeEdge(edge)).rejects.toThrow(
                  ReferentialIntegrityError
                );
              }
            }

            // Verify final edge count matches expected
            const edgeCount = (
              localDb.prepare('SELECT COUNT(*) as cnt FROM edges').get() as any
            ).cnt;
            expect(edgeCount).toBe(expectedEdgeCount);
          } finally {
            localDb.close();
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});


/**
 * Property 5: Call Graph Completeness
 *
 * For any set of resolved function/method call edges stored in the Graph_Database,
 * the constructed call graph shall contain a directed edge for every unique
 * caller-callee pair and no edges for unresolved references.
 *
 * **Validates: Requirements 2.5**
 */

describe('Property 5: Call Graph Completeness', () => {
  /**
   * Each call edge is modeled with a unique source node (representing the call site)
   * and a target node (representing the callee function). Each call site has exactly
   * one symbol resolution indicating whether the reference was resolved.
   *
   * This reflects the CallGraphBuilder's SQL join:
   *   edges e INNER JOIN symbol_resolutions sr ON sr.usage_node_id = e.source_id
   *   WHERE e.relationship = 'calls' AND sr.resolved = 1
   */

  interface CallSiteSpec {
    resolved: boolean;
    calleeIdx: number; // index into callee nodes array
  }

  /**
   * Arbitrary: generates a scenario with call sites (some resolved, some not)
   * pointing to shared callee nodes.
   */
  const arbCallScenario = fc
    .integer({ min: 1, max: 6 })
    .chain((calleeCount) => {
      return fc
        .array(
          fc.record({
            resolved: fc.boolean(),
            calleeIdx: fc.integer({ min: 0, max: calleeCount - 1 }),
          }),
          { minLength: 1, maxLength: 15 }
        )
        .map((callSites) => ({ calleeCount, callSites }));
    });

  function makeCallSiteNode(index: number): NodeRecord {
    return {
      id: `callsite-${index}`,
      type: 'function',
      file_path: '/src/callers.ts',
      start_byte: index * 100,
      end_byte: index * 100 + 80,
      start_line: index * 5 + 1,
      start_column: 0,
      end_line: index * 5 + 4,
      end_column: 1,
      is_error: false,
      created_at: '2024-01-01T00:00:00Z',
    };
  }

  function makeCalleeNode(index: number): NodeRecord {
    return {
      id: `callee-${index}`,
      type: 'function',
      file_path: '/src/callees.ts',
      start_byte: index * 100,
      end_byte: index * 100 + 80,
      start_line: index * 5 + 1,
      start_column: 0,
      end_line: index * 5 + 4,
      end_column: 1,
      is_error: false,
      created_at: '2024-01-01T00:00:00Z',
    };
  }

  it('call graph contains a directed edge for every resolved caller-callee pair and no edges for unresolved references', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbCallScenario,
        async ({ calleeCount, callSites }) => {
          const localDb = initializeDatabase(':memory:');
          const localWriter = new GraphWriter(localDb);

          try {
            // Create callee nodes
            for (let i = 0; i < calleeCount; i++) {
              await localWriter.writeNode(makeCalleeNode(i));
            }

            // Create one unique source node per call site and corresponding edge + resolution
            const resolvedEdgeKeys = new Set<string>();
            const unresolvedEdgeKeys = new Set<string>();

            for (let i = 0; i < callSites.length; i++) {
              const { resolved, calleeIdx } = callSites[i];
              const callSiteNode = makeCallSiteNode(i);
              const calleeId = `callee-${calleeIdx}`;

              await localWriter.writeNode(callSiteNode);

              // Write the call edge
              await localWriter.writeEdge({
                id: `call-edge-${i}`,
                source_id: callSiteNode.id,
                target_id: calleeId,
                relationship: 'calls',
                created_at: '2024-01-01T00:00:00Z',
              });

              // Write symbol resolution for this call site
              await localWriter.writeSymbolResolution({
                id: `sr-${i}`,
                usage_node_id: callSiteNode.id,
                definition_node_id: resolved ? calleeId : null,
                symbol_name: `func_${i}`,
                type_info: null,
                enclosing_scope: null,
                resolved,
              });

              const key = `${callSiteNode.id}:${calleeId}`;
              if (resolved) {
                resolvedEdgeKeys.add(key);
              } else {
                unresolvedEdgeKeys.add(key);
              }
            }

            // Build the call graph
            const { CallGraphBuilder } = await import(
              '../../src/agents/call-graph-builder.js'
            );
            const builder = new CallGraphBuilder(localDb);
            const callGraph = builder.buildCallGraph();

            // Collect actual result edge keys
            const resultEdgeKeys = new Set(
              callGraph.edges.map(
                (e: EdgeRecord) => `${e.source_id}:${e.target_id}`
              )
            );

            // PROPERTY: every resolved caller-callee pair has a directed edge
            for (const key of resolvedEdgeKeys) {
              expect(resultEdgeKeys.has(key)).toBe(true);
            }

            // PROPERTY: no edges for unresolved references
            for (const key of unresolvedEdgeKeys) {
              expect(resultEdgeKeys.has(key)).toBe(false);
            }

            // PROPERTY: total edges equals resolved count
            expect(callGraph.edges.length).toBe(resolvedEdgeKeys.size);

            // PROPERTY: all edges have relationship 'calls'
            for (const edge of callGraph.edges) {
              expect(edge.relationship).toBe('calls');
            }
          } finally {
            localDb.close();
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('call graph has no edges when all symbol resolutions are unresolved', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 5 }),
        fc.integer({ min: 1, max: 10 }),
        async (calleeCount, callSiteCount) => {
          const localDb = initializeDatabase(':memory:');
          const localWriter = new GraphWriter(localDb);

          try {
            // Create callee nodes
            for (let i = 0; i < calleeCount; i++) {
              await localWriter.writeNode(makeCalleeNode(i));
            }

            // Create call sites with ALL unresolved symbol resolutions
            for (let i = 0; i < callSiteCount; i++) {
              const callSiteNode = makeCallSiteNode(i);
              const calleeId = `callee-${i % calleeCount}`;

              await localWriter.writeNode(callSiteNode);

              await localWriter.writeEdge({
                id: `edge-unresolved-${i}`,
                source_id: callSiteNode.id,
                target_id: calleeId,
                relationship: 'calls',
                created_at: '2024-01-01T00:00:00Z',
              });

              await localWriter.writeSymbolResolution({
                id: `sr-unresolved-${i}`,
                usage_node_id: callSiteNode.id,
                definition_node_id: null,
                symbol_name: `unresolved_${i}`,
                type_info: null,
                enclosing_scope: null,
                resolved: false,
              });
            }

            // Build call graph
            const { CallGraphBuilder } = await import(
              '../../src/agents/call-graph-builder.js'
            );
            const builder = new CallGraphBuilder(localDb);
            const callGraph = builder.buildCallGraph();

            // PROPERTY: no edges when all are unresolved
            expect(callGraph.edges.length).toBe(0);
            expect(callGraph.nodes.length).toBe(0);
            expect(callGraph.entry_points.length).toBe(0);
          } finally {
            localDb.close();
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('call graph contains all edges when all symbol resolutions are resolved', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 5 }),
        fc.integer({ min: 1, max: 10 }),
        async (calleeCount, callSiteCount) => {
          const localDb = initializeDatabase(':memory:');
          const localWriter = new GraphWriter(localDb);

          try {
            // Create callee nodes
            for (let i = 0; i < calleeCount; i++) {
              await localWriter.writeNode(makeCalleeNode(i));
            }

            // Create call sites with ALL resolved symbol resolutions
            for (let i = 0; i < callSiteCount; i++) {
              const callSiteNode = makeCallSiteNode(i);
              const calleeId = `callee-${i % calleeCount}`;

              await localWriter.writeNode(callSiteNode);

              await localWriter.writeEdge({
                id: `edge-resolved-${i}`,
                source_id: callSiteNode.id,
                target_id: calleeId,
                relationship: 'calls',
                created_at: '2024-01-01T00:00:00Z',
              });

              await localWriter.writeSymbolResolution({
                id: `sr-resolved-${i}`,
                usage_node_id: callSiteNode.id,
                definition_node_id: calleeId,
                symbol_name: `resolved_${i}`,
                type_info: 'Function',
                enclosing_scope: 'module',
                resolved: true,
              });
            }

            // Build call graph
            const { CallGraphBuilder } = await import(
              '../../src/agents/call-graph-builder.js'
            );
            const builder = new CallGraphBuilder(localDb);
            const callGraph = builder.buildCallGraph();

            // PROPERTY: all edges present when all are resolved
            expect(callGraph.edges.length).toBe(callSiteCount);

            // PROPERTY: every edge in the call graph references existing nodes
            const nodeIdSet = new Set(callGraph.nodes.map((n: NodeRecord) => n.id));
            for (const edge of callGraph.edges) {
              expect(nodeIdSet.has(edge.source_id)).toBe(true);
              expect(nodeIdSet.has(edge.target_id)).toBe(true);
            }
          } finally {
            localDb.close();
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});


/**
 * Property 4: Symbol Resolution Graph Correctness
 *
 * For any symbol reference in a parsed file, if the LSP resolves the symbol
 * then the Graph_Database shall contain an edge from the usage node to the
 * definition node with correct type; if the LSP fails to resolve it, the
 * symbol_resolutions table shall contain a record with resolved=false and
 * the correct source location.
 *
 * **Validates: Requirements 2.2, 2.3**
 */

// --- Arbitraries for Property 4 ---

const arbSymbolName = fc.stringOf(
  fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_'.split('')),
  { minLength: 1, maxLength: 15 }
);

const arbTypeInfo = fc.oneof(
  fc.constant(null as string | null),
  fc.constantFrom('string', 'number', 'boolean', 'void', 'any', 'object', 'Function')
);

const arbEnclosingScope = fc.oneof(
  fc.constant(null as string | null),
  fc.constantFrom('main', 'handleRequest', 'processData', 'MyClass', 'render')
);

const arbSourceLocation = fc.record({
  file_path: fc.constantFrom('/src/a.ts', '/src/b.ts', '/src/c.ts', '/lib/utils.ts'),
  start_line: fc.integer({ min: 1, max: 200 }),
  start_column: fc.nat({ max: 80 }),
  end_line: fc.integer({ min: 1, max: 200 }),
  end_column: fc.nat({ max: 80 }),
}).map((loc) => ({
  ...loc,
  end_line: Math.max(loc.end_line, loc.start_line),
}));

interface SymbolResolutionInput {
  resolved: boolean;
  symbolName: string;
  typeInfo: string | null;
  enclosingScope: string | null;
  usageLocation: {
    file_path: string;
    start_line: number;
    start_column: number;
    end_line: number;
    end_column: number;
  };
  definitionLocation: {
    file_path: string;
    start_line: number;
    start_column: number;
    end_line: number;
    end_column: number;
  } | null;
}

const arbSymbolResolution: fc.Arbitrary<SymbolResolutionInput> = fc.record({
  resolved: fc.boolean(),
  symbolName: arbSymbolName,
  typeInfo: arbTypeInfo,
  enclosingScope: arbEnclosingScope,
  usageLocation: arbSourceLocation,
  definitionLocation: arbSourceLocation,
}).map((data) => ({
  ...data,
  // If unresolved, definition location should be null
  definitionLocation: data.resolved ? data.definitionLocation : null,
}));

describe('Property 4: Symbol Resolution Graph Correctness', () => {
  it('resolved symbols produce an edge from usage to definition with correct type, and unresolved symbols produce a record with resolved=false and correct location', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(arbSymbolResolution, { minLength: 1, maxLength: 10 }),
        async (symbolResolutions) => {
          const localDb = initializeDatabase(':memory:');
          const localWriter = new GraphWriter(localDb);

          try {
            // For each symbol resolution, create usage nodes (and definition nodes for resolved ones),
            // write symbol resolutions and edges, then verify storage correctness.
            for (let i = 0; i < symbolResolutions.length; i++) {
              const sym = symbolResolutions[i];
              const usageNodeId = `usage-node-${i}`;
              const definitionNodeId = `def-node-${i}`;
              const resolutionId = `resolution-${i}`;
              const edgeId = `edge-res-${i}`;

              // Create usage node in the database
              await localWriter.writeNode({
                id: usageNodeId,
                type: 'cst_node',
                file_path: sym.usageLocation.file_path,
                start_byte: sym.usageLocation.start_column,
                end_byte: sym.usageLocation.end_column + 10,
                start_line: sym.usageLocation.start_line,
                start_column: sym.usageLocation.start_column,
                end_line: sym.usageLocation.end_line,
                end_column: sym.usageLocation.end_column,
                is_error: false,
                created_at: '2024-01-01T00:00:00Z',
              });

              if (sym.resolved && sym.definitionLocation) {
                // Create definition node for resolved symbols
                await localWriter.writeNode({
                  id: definitionNodeId,
                  type: 'symbol_def',
                  file_path: sym.definitionLocation.file_path,
                  start_byte: sym.definitionLocation.start_column,
                  end_byte: sym.definitionLocation.end_column + 10,
                  start_line: sym.definitionLocation.start_line,
                  start_column: sym.definitionLocation.start_column,
                  end_line: sym.definitionLocation.end_line,
                  end_column: sym.definitionLocation.end_column,
                  is_error: false,
                  created_at: '2024-01-01T00:00:00Z',
                });

                // Write the edge from usage to definition
                await localWriter.writeEdge({
                  id: edgeId,
                  source_id: usageNodeId,
                  target_id: definitionNodeId,
                  relationship: 'references',
                  created_at: '2024-01-01T00:00:00Z',
                });

                // Write the symbol resolution record
                await localWriter.writeSymbolResolution({
                  id: resolutionId,
                  usage_node_id: usageNodeId,
                  definition_node_id: definitionNodeId,
                  symbol_name: sym.symbolName,
                  type_info: sym.typeInfo,
                  enclosing_scope: sym.enclosingScope,
                  resolved: true,
                });
              } else {
                // Write the unresolved symbol resolution record (no edge, no definition node)
                await localWriter.writeSymbolResolution({
                  id: resolutionId,
                  usage_node_id: usageNodeId,
                  definition_node_id: null,
                  symbol_name: sym.symbolName,
                  type_info: sym.typeInfo,
                  enclosing_scope: sym.enclosingScope,
                  resolved: false,
                });
              }
            }

            // --- Verification ---
            for (let i = 0; i < symbolResolutions.length; i++) {
              const sym = symbolResolutions[i];
              const usageNodeId = `usage-node-${i}`;
              const definitionNodeId = `def-node-${i}`;
              const resolutionId = `resolution-${i}`;
              const edgeId = `edge-res-${i}`;

              if (sym.resolved && sym.definitionLocation) {
                // VERIFY: resolved → edge from usage to definition with correct type
                const edgeRow = localDb
                  .prepare('SELECT * FROM edges WHERE id = ?')
                  .get(edgeId) as any;
                expect(edgeRow).toBeDefined();
                expect(edgeRow.source_id).toBe(usageNodeId);
                expect(edgeRow.target_id).toBe(definitionNodeId);
                expect(edgeRow.relationship).toBe('references');

                // VERIFY: symbol_resolutions record is resolved with correct data
                const resRow = localDb
                  .prepare('SELECT * FROM symbol_resolutions WHERE id = ?')
                  .get(resolutionId) as any;
                expect(resRow).toBeDefined();
                expect(resRow.resolved).toBe(1);
                expect(resRow.usage_node_id).toBe(usageNodeId);
                expect(resRow.definition_node_id).toBe(definitionNodeId);
                expect(resRow.symbol_name).toBe(sym.symbolName);
                if (sym.typeInfo !== null) {
                  expect(resRow.type_info).toBe(sym.typeInfo);
                }
              } else {
                // VERIFY: unresolved → record with resolved=false and correct location
                const resRow = localDb
                  .prepare('SELECT * FROM symbol_resolutions WHERE id = ?')
                  .get(resolutionId) as any;
                expect(resRow).toBeDefined();
                expect(resRow.resolved).toBe(0);
                expect(resRow.usage_node_id).toBe(usageNodeId);
                expect(resRow.definition_node_id).toBeNull();
                expect(resRow.symbol_name).toBe(sym.symbolName);

                // VERIFY: no edge exists for unresolved symbols
                const edgeRow = localDb
                  .prepare('SELECT * FROM edges WHERE id = ?')
                  .get(edgeId) as any;
                expect(edgeRow).toBeUndefined();

                // VERIFY: usage node has correct source location
                const usageNode = localDb
                  .prepare('SELECT * FROM nodes WHERE id = ?')
                  .get(usageNodeId) as any;
                expect(usageNode).toBeDefined();
                expect(usageNode.file_path).toBe(sym.usageLocation.file_path);
                expect(usageNode.start_line).toBe(sym.usageLocation.start_line);
                expect(usageNode.start_column).toBe(sym.usageLocation.start_column);
                expect(usageNode.end_line).toBe(sym.usageLocation.end_line);
                expect(usageNode.end_column).toBe(sym.usageLocation.end_column);
              }
            }
          } finally {
            localDb.close();
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('resolved symbols always have a corresponding definition node in the nodes table', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(arbSymbolResolution.filter((s) => s.resolved), { minLength: 1, maxLength: 10 }),
        async (resolvedSymbols) => {
          const localDb = initializeDatabase(':memory:');
          const localWriter = new GraphWriter(localDb);

          try {
            for (let i = 0; i < resolvedSymbols.length; i++) {
              const sym = resolvedSymbols[i];
              const usageNodeId = `usage-${i}`;
              const defNodeId = `def-${i}`;

              await localWriter.writeNode({
                id: usageNodeId,
                type: 'cst_node',
                file_path: sym.usageLocation.file_path,
                start_byte: 0,
                end_byte: 50,
                start_line: sym.usageLocation.start_line,
                start_column: sym.usageLocation.start_column,
                end_line: sym.usageLocation.end_line,
                end_column: sym.usageLocation.end_column,
                is_error: false,
                created_at: '2024-01-01T00:00:00Z',
              });

              await localWriter.writeNode({
                id: defNodeId,
                type: 'symbol_def',
                file_path: sym.definitionLocation!.file_path,
                start_byte: 0,
                end_byte: 50,
                start_line: sym.definitionLocation!.start_line,
                start_column: sym.definitionLocation!.start_column,
                end_line: sym.definitionLocation!.end_line,
                end_column: sym.definitionLocation!.end_column,
                is_error: false,
                created_at: '2024-01-01T00:00:00Z',
              });

              await localWriter.writeEdge({
                id: `edge-${i}`,
                source_id: usageNodeId,
                target_id: defNodeId,
                relationship: 'references',
                created_at: '2024-01-01T00:00:00Z',
              });

              await localWriter.writeSymbolResolution({
                id: `res-${i}`,
                usage_node_id: usageNodeId,
                definition_node_id: defNodeId,
                symbol_name: sym.symbolName,
                type_info: sym.typeInfo,
                enclosing_scope: sym.enclosingScope,
                resolved: true,
              });
            }

            // Verify: every resolved symbol has a definition node that exists
            for (let i = 0; i < resolvedSymbols.length; i++) {
              const sym = resolvedSymbols[i];
              const defNodeId = `def-${i}`;

              const defNode = localDb
                .prepare('SELECT * FROM nodes WHERE id = ?')
                .get(defNodeId) as any;
              expect(defNode).toBeDefined();
              expect(defNode.type).toBe('symbol_def');
              expect(defNode.file_path).toBe(sym.definitionLocation!.file_path);
              expect(defNode.start_line).toBe(sym.definitionLocation!.start_line);
              expect(defNode.start_column).toBe(sym.definitionLocation!.start_column);
              expect(defNode.end_line).toBe(sym.definitionLocation!.end_line);
              expect(defNode.end_column).toBe(sym.definitionLocation!.end_column);
            }
          } finally {
            localDb.close();
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('unresolved symbols never produce edges in the edges table', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(arbSymbolResolution.filter((s) => !s.resolved), { minLength: 1, maxLength: 15 }),
        async (unresolvedSymbols) => {
          const localDb = initializeDatabase(':memory:');
          const localWriter = new GraphWriter(localDb);

          try {
            for (let i = 0; i < unresolvedSymbols.length; i++) {
              const sym = unresolvedSymbols[i];
              const usageNodeId = `unresolved-usage-${i}`;

              await localWriter.writeNode({
                id: usageNodeId,
                type: 'cst_node',
                file_path: sym.usageLocation.file_path,
                start_byte: 0,
                end_byte: 50,
                start_line: sym.usageLocation.start_line,
                start_column: sym.usageLocation.start_column,
                end_line: sym.usageLocation.end_line,
                end_column: sym.usageLocation.end_column,
                is_error: false,
                created_at: '2024-01-01T00:00:00Z',
              });

              await localWriter.writeSymbolResolution({
                id: `unres-${i}`,
                usage_node_id: usageNodeId,
                definition_node_id: null,
                symbol_name: sym.symbolName,
                type_info: sym.typeInfo,
                enclosing_scope: sym.enclosingScope,
                resolved: false,
              });
            }

            // Verify: no edges exist at all (none should be created for unresolved symbols)
            const edgeCount = (
              localDb.prepare('SELECT COUNT(*) as cnt FROM edges').get() as any
            ).cnt;
            expect(edgeCount).toBe(0);

            // Verify: all symbol_resolutions have resolved=0
            const resolutions = localDb
              .prepare('SELECT * FROM symbol_resolutions')
              .all() as any[];
            expect(resolutions.length).toBe(unresolvedSymbols.length);
            for (const row of resolutions) {
              expect(row.resolved).toBe(0);
              expect(row.definition_node_id).toBeNull();
            }
          } finally {
            localDb.close();
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('mixed resolved/unresolved sets: edge count equals resolved count, resolution count equals total', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(arbSymbolResolution, { minLength: 2, maxLength: 12 }),
        async (symbolResolutions) => {
          const localDb = initializeDatabase(':memory:');
          const localWriter = new GraphWriter(localDb);

          try {
            let resolvedCount = 0;

            for (let i = 0; i < symbolResolutions.length; i++) {
              const sym = symbolResolutions[i];
              const usageNodeId = `mix-usage-${i}`;
              const defNodeId = `mix-def-${i}`;

              await localWriter.writeNode({
                id: usageNodeId,
                type: 'cst_node',
                file_path: sym.usageLocation.file_path,
                start_byte: 0,
                end_byte: 50,
                start_line: sym.usageLocation.start_line,
                start_column: sym.usageLocation.start_column,
                end_line: sym.usageLocation.end_line,
                end_column: sym.usageLocation.end_column,
                is_error: false,
                created_at: '2024-01-01T00:00:00Z',
              });

              if (sym.resolved && sym.definitionLocation) {
                resolvedCount++;

                await localWriter.writeNode({
                  id: defNodeId,
                  type: 'symbol_def',
                  file_path: sym.definitionLocation.file_path,
                  start_byte: 0,
                  end_byte: 50,
                  start_line: sym.definitionLocation.start_line,
                  start_column: sym.definitionLocation.start_column,
                  end_line: sym.definitionLocation.end_line,
                  end_column: sym.definitionLocation.end_column,
                  is_error: false,
                  created_at: '2024-01-01T00:00:00Z',
                });

                await localWriter.writeEdge({
                  id: `mix-edge-${i}`,
                  source_id: usageNodeId,
                  target_id: defNodeId,
                  relationship: 'references',
                  created_at: '2024-01-01T00:00:00Z',
                });

                await localWriter.writeSymbolResolution({
                  id: `mix-res-${i}`,
                  usage_node_id: usageNodeId,
                  definition_node_id: defNodeId,
                  symbol_name: sym.symbolName,
                  type_info: sym.typeInfo,
                  enclosing_scope: sym.enclosingScope,
                  resolved: true,
                });
              } else {
                await localWriter.writeSymbolResolution({
                  id: `mix-res-${i}`,
                  usage_node_id: usageNodeId,
                  definition_node_id: null,
                  symbol_name: sym.symbolName,
                  type_info: sym.typeInfo,
                  enclosing_scope: sym.enclosingScope,
                  resolved: false,
                });
              }
            }

            // VERIFY: edge count equals resolved symbol count
            const edgeCount = (
              localDb.prepare('SELECT COUNT(*) as cnt FROM edges').get() as any
            ).cnt;
            expect(edgeCount).toBe(resolvedCount);

            // VERIFY: total resolution records equal total symbols
            const resCount = (
              localDb.prepare('SELECT COUNT(*) as cnt FROM symbol_resolutions').get() as any
            ).cnt;
            expect(resCount).toBe(symbolResolutions.length);

            // VERIFY: resolved count in DB matches
            const resolvedDbCount = (
              localDb.prepare('SELECT COUNT(*) as cnt FROM symbol_resolutions WHERE resolved = 1').get() as any
            ).cnt;
            expect(resolvedDbCount).toBe(resolvedCount);

            const unresolvedDbCount = (
              localDb.prepare('SELECT COUNT(*) as cnt FROM symbol_resolutions WHERE resolved = 0').get() as any
            ).cnt;
            expect(unresolvedDbCount).toBe(symbolResolutions.length - resolvedCount);
          } finally {
            localDb.close();
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});


/**
 * Property 7: Graph Query Correctness
 *
 * For any valid graph state and query (node lookup, edge traversal, subgraph
 * extraction, or path query), the Graph_Database shall return exactly the set
 * of nodes and edges matching the query criteria — no more, no less.
 *
 * **Validates: Requirements 3.2**
 */

// --- Arbitraries for Property 7 ---

const RELATIONSHIPS: EdgeRecord['relationship'][] = [
  'parent_of',
  'calls',
  'references',
  'defines',
  'type_of',
];

const FILE_PATHS = ['/src/a.ts', '/src/b.ts', '/src/c.ts', '/lib/d.ts'];

const arbNodeType = fc.constantFrom(
  'cst_node',
  'symbol_def',
  'function',
  'class',
  'method'
);

const arbFilePath = fc.constantFrom(...FILE_PATHS);

const arbRelationshipP7 = fc.constantFrom(...RELATIONSHIPS);

/**
 * Generate a unique node record with a given index for ID uniqueness.
 */
function arbNodeRecordWithIndex(index: number) {
  return fc.record({
    type: arbNodeType,
    file_path: arbFilePath,
    start_byte: fc.nat({ max: 1000 }),
    start_line: fc.integer({ min: 1, max: 100 }),
    start_column: fc.nat({ max: 80 }),
  }).map(({ type, file_path, start_byte, start_line, start_column }) => ({
    id: `node-${index}`,
    type,
    file_path,
    start_byte,
    end_byte: start_byte + 50,
    start_line,
    start_column,
    end_line: start_line + 2,
    end_column: start_column + 10,
    is_error: false,
    created_at: '2024-01-01T00:00:00Z',
  } as NodeRecord));
}

/**
 * Generate a graph with N nodes and M edges (edges reference valid nodes).
 */
function arbGraph(minNodes: number, maxNodes: number) {
  return fc.integer({ min: minNodes, max: maxNodes }).chain((nodeCount) => {
    const nodeArbs = Array.from({ length: nodeCount }, (_, i) =>
      arbNodeRecordWithIndex(i)
    );
    return fc.tuple(fc.tuple(...nodeArbs), fc.nat({ max: 50 })).chain(([nodes, edgeSeed]) => {
      // Generate edges: random pairs from existing nodes
      const maxEdges = Math.min(nodeCount * (nodeCount - 1), 20);
      const edgeCount = Math.min(edgeSeed % (maxEdges + 1), maxEdges);
      
      const edgeArbs: fc.Arbitrary<EdgeRecord>[] = [];
      const usedPairs = new Set<string>();
      
      // We'll generate potential edges and filter for uniqueness
      for (let i = 0; i < edgeCount; i++) {
        edgeArbs.push(
          fc.tuple(
            fc.integer({ min: 0, max: nodeCount - 1 }),
            fc.integer({ min: 0, max: nodeCount - 1 }),
            arbRelationshipP7
          ).map(([srcIdx, tgtIdx, rel]) => ({
            id: `edge-${i}`,
            source_id: nodes[srcIdx].id,
            target_id: nodes[tgtIdx === srcIdx ? (tgtIdx + 1) % nodeCount : tgtIdx].id,
            relationship: rel,
            created_at: '2024-01-01T00:00:00Z',
          } as EdgeRecord))
        );
      }

      if (edgeArbs.length === 0) {
        return fc.constant({ nodes: [...nodes], edges: [] as EdgeRecord[] });
      }

      return fc.tuple(...edgeArbs).map((edges) => {
        // Deduplicate edges by (source_id, target_id, relationship) to avoid unique constraint violations
        const seen = new Set<string>();
        const uniqueEdges: EdgeRecord[] = [];
        for (const edge of edges) {
          const key = `${edge.source_id}|${edge.target_id}|${edge.relationship}`;
          if (!seen.has(key)) {
            seen.add(key);
            uniqueEdges.push({ ...edge, id: `edge-${uniqueEdges.length}` });
          }
        }
        return { nodes: [...nodes], edges: uniqueEdges };
      });
    });
  });
}

/**
 * Helper to set up a test database with given nodes and edges.
 */
async function setupGraph(
  nodes: NodeRecord[],
  edges: EdgeRecord[]
): Promise<{ db: Database.Database; queries: GraphQueries }> {
  const db = initializeDatabase(':memory:');
  const writer = new GraphWriter(db);

  for (const node of nodes) {
    await writer.writeNode(node);
  }
  for (const edge of edges) {
    await writer.writeEdge(edge);
  }

  const queries = new GraphQueries(db);
  return { db, queries };
}

describe('Property 7: Graph Query Correctness', () => {
  it('node lookup returns the exact node when it exists and null when it does not', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbGraph(2, 10),
        fc.integer({ min: 0, max: 19 }),
        async ({ nodes, edges }, lookupIdx) => {
          const { db, queries } = await setupGraph(nodes, edges);

          try {
            // Query for an existing node
            const existingNode = nodes[lookupIdx % nodes.length];
            const result = queries.lookupNode(existingNode.id);

            // Should return exactly the matching node — no false negatives
            expect(result).not.toBeNull();
            expect(result!.id).toBe(existingNode.id);
            expect(result!.type).toBe(existingNode.type);
            expect(result!.file_path).toBe(existingNode.file_path);
            expect(result!.start_byte).toBe(existingNode.start_byte);
            expect(result!.end_byte).toBe(existingNode.end_byte);
            expect(result!.start_line).toBe(existingNode.start_line);
            expect(result!.start_column).toBe(existingNode.start_column);
            expect(result!.end_line).toBe(existingNode.end_line);
            expect(result!.end_column).toBe(existingNode.end_column);

            // Query for a non-existent node — no false positives
            const nonExistent = queries.lookupNode('does-not-exist-xyz');
            expect(nonExistent).toBeNull();
          } finally {
            db.close();
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('edge traversal returns exactly the edges matching source and relationship', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbGraph(3, 10),
        fc.integer({ min: 0, max: 9 }),
        arbRelationshipP7,
        async ({ nodes, edges }, nodeIdx, queryRelationship) => {
          const { db, queries } = await setupGraph(nodes, edges);

          try {
            const queryNodeId = nodes[nodeIdx % nodes.length].id;
            const result = queries.traverseEdges(queryNodeId, queryRelationship);

            // Compute expected: edges where source_id === queryNodeId AND relationship === queryRelationship
            const expected = edges.filter(
              (e) => e.source_id === queryNodeId && e.relationship === queryRelationship
            );

            // No false negatives: every expected edge is present in result
            expect(result.length).toBe(expected.length);

            const resultIds = new Set(result.map((e) => e.id));
            for (const exp of expected) {
              expect(resultIds.has(exp.id)).toBe(true);
            }

            // No false positives: every returned edge matches the query criteria
            for (const r of result) {
              expect(r.source_id).toBe(queryNodeId);
              expect(r.relationship).toBe(queryRelationship);
            }
          } finally {
            db.close();
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('subgraph extraction returns exactly nodes in file and edges between them', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbGraph(4, 12),
        arbFilePath,
        async ({ nodes, edges }, queryFilePath) => {
          const { db, queries } = await setupGraph(nodes, edges);

          try {
            const result = queries.extractSubgraph(queryFilePath);

            // Expected nodes: those in the queried file
            const expectedNodes = nodes.filter((n) => n.file_path === queryFilePath);
            const expectedNodeIds = new Set(expectedNodes.map((n) => n.id));

            // No false negatives and no false positives for nodes
            expect(result.nodes.length).toBe(expectedNodes.length);
            for (const node of result.nodes) {
              expect(node.file_path).toBe(queryFilePath);
              expect(expectedNodeIds.has(node.id)).toBe(true);
            }

            // Expected edges: both source and target are in file's nodes
            const expectedEdges = edges.filter(
              (e) => expectedNodeIds.has(e.source_id) && expectedNodeIds.has(e.target_id)
            );

            // No false negatives and no false positives for edges
            expect(result.edges.length).toBe(expectedEdges.length);
            const resultEdgeIds = new Set(result.edges.map((e) => e.id));
            for (const exp of expectedEdges) {
              expect(resultEdgeIds.has(exp.id)).toBe(true);
            }
            for (const edge of result.edges) {
              expect(expectedNodeIds.has(edge.source_id)).toBe(true);
              expect(expectedNodeIds.has(edge.target_id)).toBe(true);
            }
          } finally {
            db.close();
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('path query returns a valid path with no false positives (all nodes connected by edges)', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbGraph(3, 8),
        fc.integer({ min: 0, max: 7 }),
        fc.integer({ min: 0, max: 7 }),
        async ({ nodes, edges }, srcIdx, tgtIdx) => {
          const { db, queries } = await setupGraph(nodes, edges);

          try {
            const sourceId = nodes[srcIdx % nodes.length].id;
            const targetId = nodes[tgtIdx % nodes.length].id;

            const pathResult = queries.findPath(sourceId, targetId);

            if (sourceId === targetId) {
              // Path from a node to itself should return that node
              if (pathResult.length > 0) {
                expect(pathResult[0].id).toBe(sourceId);
              }
            } else if (pathResult.length > 0) {
              // Path must start with source and end with target
              expect(pathResult[0].id).toBe(sourceId);
              expect(pathResult[pathResult.length - 1].id).toBe(targetId);

              // Each consecutive pair must be connected by an edge (no false positives in path)
              const edgeSet = new Set(
                edges.map((e) => `${e.source_id}->${e.target_id}`)
              );
              for (let i = 0; i < pathResult.length - 1; i++) {
                const from = pathResult[i].id;
                const to = pathResult[i + 1].id;
                expect(edgeSet.has(`${from}->${to}`)).toBe(true);
              }

              // All nodes in path must be real nodes in the graph (no fabricated nodes)
              const nodeIdSet = new Set(nodes.map((n) => n.id));
              for (const pNode of pathResult) {
                expect(nodeIdSet.has(pNode.id)).toBe(true);
              }
            } else {
              // Empty path means no path exists — verify by BFS
              const reachable = new Set<string>();
              const queue = [sourceId];
              reachable.add(sourceId);
              while (queue.length > 0) {
                const current = queue.shift()!;
                for (const edge of edges) {
                  if (edge.source_id === current && !reachable.has(edge.target_id)) {
                    reachable.add(edge.target_id);
                    queue.push(edge.target_id);
                  }
                }
              }
              // Target should not be reachable — confirming no false negatives
              expect(reachable.has(targetId)).toBe(false);
            }
          } finally {
            db.close();
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});
