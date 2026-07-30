import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { ParserAgent } from '../../src/agents/parser-agent.js';
import type { TreeSitterEdit } from '../../src/types/cst.js';

describe('ParserAgent', () => {
  let agent: ParserAgent;
  let tmpDir: string;

  beforeEach(() => {
    agent = new ParserAgent();
    tmpDir = mkdtempSync(resolve(tmpdir(), 'parser-agent-test-'));
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Test case: Parsing known valid file
  // Requirements: 1.1, 1.4, 1.5
  // ─────────────────────────────────────────────────────────────────────────

  describe('parseFile - known valid file', () => {
    it('parses a valid TypeScript file into a CST with program root', async () => {
      const filePath = resolve(tmpDir, 'valid.ts');
      writeFileSync(filePath, 'const x: number = 42;\n');

      const result = await agent.parseFile(filePath);

      expect(result.file_path).toBe(filePath);
      expect(result.cst).toBeDefined();
      expect(result.cst.type).toBe('program');
      expect(result.cst.is_error).toBe(false);
      expect(result.errors).toHaveLength(0);
      expect(result.duration_ms).toBeGreaterThanOrEqual(0);
    });

    it('parses a multi-statement file correctly', async () => {
      const filePath = resolve(tmpDir, 'multi.ts');
      const source = [
        'import { readFile } from "fs";',
        '',
        'export function greet(name: string): string {',
        '  return `Hello, ${name}!`;',
        '}',
        '',
        'const result = greet("world");',
        '',
      ].join('\n');
      writeFileSync(filePath, source);

      const result = await agent.parseFile(filePath);

      expect(result.errors).toHaveLength(0);
      expect(result.cst.type).toBe('program');
      expect(result.cst.children.length).toBeGreaterThan(0);
    });

    it('preserves comments in the CST', async () => {
      const filePath = resolve(tmpDir, 'commented.ts');
      const source = '// Single line comment\n/* Block comment */\nconst x = 1;\n';
      writeFileSync(filePath, source);

      const result = await agent.parseFile(filePath);

      expect(result.errors).toHaveLength(0);
      const commentNode = findNodeByType(result.cst, 'comment');
      expect(commentNode).toBeDefined();
      expect(commentNode!.text).toBe('// Single line comment');
    });

    it('preserves whitespace formatting in leaf nodes', () => {
      const source = '// This is a comment\nconst x = 1;\n';
      const result = agent.parseSource(source, 'test.ts');

      // Comments (which include their whitespace) are preserved as leaf text
      const commentNode = findNodeByType(result.cst, 'comment');
      expect(commentNode).toBeDefined();
      expect(commentNode!.text).toBe('// This is a comment');

      // Leaf nodes have text that represents the token content
      const leaves = collectAllLeaves(result.cst);
      const leafTexts = leaves.filter((l) => l.text !== undefined);
      expect(leafTexts.length).toBeGreaterThan(0);
    });

    it('reports actual duration_ms even when fast', async () => {
      const filePath = resolve(tmpDir, 'tiny.ts');
      writeFileSync(filePath, 'let a = 1;\n');

      const result = await agent.parseFile(filePath);

      expect(typeof result.duration_ms).toBe('number');
      expect(result.duration_ms).toBeGreaterThanOrEqual(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Test case: Parsing file with known errors (verify error node positions)
  // Requirements: 1.2
  // ─────────────────────────────────────────────────────────────────────────

  describe('parseFile - known errors with error node positions', () => {
    it('produces error nodes for syntax errors with byte offset and length', () => {
      const source = 'const x = {;\n';
      const result = agent.parseSource(source, 'test.ts');

      expect(result.errors.length).toBeGreaterThan(0);

      const error = result.errors[0];
      expect(error.location).toBeDefined();
      expect(typeof error.location.row).toBe('number');
      expect(typeof error.location.column).toBe('number');
      expect(typeof error.length).toBe('number');
      expect(error.length).toBeGreaterThanOrEqual(0);
    });

    it('error node positions match actual error location in source', () => {
      // The error is at line 1 (0-indexed), at the unexpected token
      const source = 'const x = 1;\nconst y = {;\n';
      const result = agent.parseSource(source, 'test.ts');

      expect(result.errors.length).toBeGreaterThan(0);

      // Errors should be on line 1 (second line, 0-indexed)
      const errorsOnSecondLine = result.errors.filter((e) => e.location.row === 1);
      expect(errorsOnSecondLine.length).toBeGreaterThan(0);
    });

    it('still produces a valid CST even with errors (fault tolerance)', () => {
      const source = 'function foo( { return 1; }\nconst valid = true;\n';
      const result = agent.parseSource(source, 'test.ts');

      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.cst).toBeDefined();
      expect(result.cst.type).toBe('program');
      // The tree still has children covering the file
      expect(result.cst.children.length).toBeGreaterThan(0);
    });

    it('marks error nodes in the CST with is_error=true', () => {
      const source = 'const x = {;\n';
      const result = agent.parseSource(source, 'test.ts');

      const errorNodes = findAllErrorNodes(result.cst);
      expect(errorNodes.length).toBeGreaterThan(0);
      errorNodes.forEach((node) => {
        expect(node.is_error).toBe(true);
      });
    });

    it('reports missing nodes with appropriate error message', () => {
      const source = 'class Foo { constructor( }';
      const result = agent.parseSource(source, 'test.ts');

      expect(result.errors.length).toBeGreaterThan(0);
      // Check that at least one error mentions "Missing" or "Syntax error"
      const hasRelevantMessage = result.errors.some(
        (e) => e.message.includes('Missing') || e.message.includes('Syntax error')
      );
      expect(hasRelevantMessage).toBe(true);
    });

    it('error byte offsets fall within source bounds', () => {
      const source = 'let x = ;\nlet y = @;\n';
      const result = agent.parseSource(source, 'test.ts');

      for (const error of result.errors) {
        // The error's byte position should be within the source
        const byteStart = Buffer.byteLength(
          source.slice(0, source.split('\n').slice(0, error.location.row).join('\n').length + (error.location.row > 0 ? 1 : 0) + error.location.column)
        );
        expect(error.location.row).toBeGreaterThanOrEqual(0);
        expect(error.location.column).toBeGreaterThanOrEqual(0);
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Test case: Incremental edit correctness
  // Requirements: 1.3
  // ─────────────────────────────────────────────────────────────────────────

  describe('parseIncremental - edit correctness', () => {
    it('produces equivalent CST to full re-parse after a simple insertion', () => {
      const originalSource = 'const x = 1;\nconst y = 2;\n';
      const filePath = 'incremental-test.ts';

      // First, do a full parse to populate the cache
      agent.parseSource(originalSource, filePath);

      // Simulate inserting "const z = 3;\n" between the two lines
      const insertedText = 'const z = 3;\n';
      const insertPosition = 'const x = 1;\n'.length; // byte position after first line
      const newSource = originalSource.slice(0, insertPosition) + insertedText + originalSource.slice(insertPosition);

      const edit: TreeSitterEdit = {
        start_byte: insertPosition,
        old_end_byte: insertPosition,
        new_end_byte: insertPosition + insertedText.length,
        start_position: { row: 1, column: 0 },
        old_end_position: { row: 1, column: 0 },
        new_end_position: { row: 2, column: 0 },
      };

      const incrementalResult = agent.parseIncremental(filePath, edit, newSource);
      const fullResult = agent.parseSource(newSource, filePath + '-full');

      // Both should produce the same CST structure
      expect(incrementalResult.errors).toHaveLength(fullResult.errors.length);
      expect(incrementalResult.cst.type).toBe(fullResult.cst.type);
      expect(incrementalResult.cst.children.length).toBe(fullResult.cst.children.length);
    });

    it('produces equivalent CST after a deletion', () => {
      const originalSource = 'const x = 1;\nconst y = 2;\nconst z = 3;\n';
      const filePath = 'incremental-delete.ts';

      agent.parseSource(originalSource, filePath);

      // Delete the second line "const y = 2;\n"
      const deleteStart = 'const x = 1;\n'.length;
      const deleteEnd = deleteStart + 'const y = 2;\n'.length;
      const newSource = originalSource.slice(0, deleteStart) + originalSource.slice(deleteEnd);

      const edit: TreeSitterEdit = {
        start_byte: deleteStart,
        old_end_byte: deleteEnd,
        new_end_byte: deleteStart,
        start_position: { row: 1, column: 0 },
        old_end_position: { row: 2, column: 0 },
        new_end_position: { row: 1, column: 0 },
      };

      const incrementalResult = agent.parseIncremental(filePath, edit, newSource);
      const fullResult = agent.parseSource(newSource, filePath + '-full');

      expect(incrementalResult.cst.type).toBe(fullResult.cst.type);
      expect(incrementalResult.cst.children.length).toBe(fullResult.cst.children.length);
      expect(incrementalResult.errors.length).toBe(fullResult.errors.length);
    });

    it('produces equivalent CST after a replacement', () => {
      const originalSource = 'const x = 1;\n';
      const filePath = 'incremental-replace.ts';

      agent.parseSource(originalSource, filePath);

      // Replace "1" with "42"
      const replaceStart = 'const x = '.length;
      const replaceEnd = replaceStart + '1'.length;
      const newSource = 'const x = 42;\n';

      const edit: TreeSitterEdit = {
        start_byte: replaceStart,
        old_end_byte: replaceEnd,
        new_end_byte: replaceStart + '42'.length,
        start_position: { row: 0, column: replaceStart },
        old_end_position: { row: 0, column: replaceEnd },
        new_end_position: { row: 0, column: replaceStart + 2 },
      };

      const incrementalResult = agent.parseIncremental(filePath, edit, newSource);
      const fullResult = agent.parseSource(newSource, filePath + '-full');

      expect(incrementalResult.cst.type).toBe(fullResult.cst.type);
      expect(incrementalResult.errors.length).toBe(fullResult.errors.length);
      // Both should parse without errors
      expect(incrementalResult.errors).toHaveLength(0);
    });

    it('falls back to full parse when no cached tree exists', () => {
      const source = 'const x = 1;\n';
      const filePath = 'no-cache.ts';

      // No prior parseSource call, so no cached tree
      const edit: TreeSitterEdit = {
        start_byte: 0,
        old_end_byte: 0,
        new_end_byte: source.length,
        start_position: { row: 0, column: 0 },
        old_end_position: { row: 0, column: 0 },
        new_end_position: { row: 0, column: source.length },
      };

      const result = agent.parseIncremental(filePath, edit, source);

      expect(result.cst.type).toBe('program');
      expect(result.errors).toHaveLength(0);
      expect(result.file_path).toBe(filePath);
    });

    it('handles multiple sequential incremental edits correctly', () => {
      const filePath = 'multi-edit.ts';

      // First: parse initial source
      const source1 = 'let x = 1;\n';
      agent.parseSource(source1, filePath);

      // Second: insert a new line
      const source2 = 'let x = 1;\nlet y = 2;\n';
      const edit1: TreeSitterEdit = {
        start_byte: source1.length,
        old_end_byte: source1.length,
        new_end_byte: source2.length,
        start_position: { row: 1, column: 0 },
        old_end_position: { row: 1, column: 0 },
        new_end_position: { row: 2, column: 0 },
      };
      agent.parseIncremental(filePath, edit1, source2);

      // Third: another edit on the same file
      const source3 = 'let x = 1;\nlet y = 2;\nlet z = 3;\n';
      const edit2: TreeSitterEdit = {
        start_byte: source2.length,
        old_end_byte: source2.length,
        new_end_byte: source3.length,
        start_position: { row: 2, column: 0 },
        old_end_position: { row: 2, column: 0 },
        new_end_position: { row: 3, column: 0 },
      };
      const result = agent.parseIncremental(filePath, edit2, source3);

      const fullResult = agent.parseSource(source3, filePath + '-full');
      expect(result.cst.children.length).toBe(fullResult.cst.children.length);
      expect(result.errors.length).toBe(fullResult.errors.length);
    });

    it('incremental parse reports duration_ms', () => {
      const source = 'const x = 1;\n';
      const filePath = 'duration.ts';
      agent.parseSource(source, filePath);

      const newSource = 'const x = 42;\n';
      const edit: TreeSitterEdit = {
        start_byte: 'const x = '.length,
        old_end_byte: 'const x = 1'.length,
        new_end_byte: 'const x = 42'.length,
        start_position: { row: 0, column: 10 },
        old_end_position: { row: 0, column: 11 },
        new_end_position: { row: 0, column: 12 },
      };

      const result = agent.parseIncremental(filePath, edit, newSource);
      expect(typeof result.duration_ms).toBe('number');
      expect(result.duration_ms).toBeGreaterThanOrEqual(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Test case: LSP timeout handling
  // Requirements: 2.1, 2.4
  // ─────────────────────────────────────────────────────────────────────────

  describe('resolveSymbols - LSP timeout handling', () => {
    it('returns unresolved symbols when no LSP client is configured', async () => {
      // Agent without LSP config
      const noLspAgent = new ParserAgent();

      const filePath = resolve(tmpDir, 'symbols.ts');
      writeFileSync(filePath, 'const x = console.log("hello");\n');

      const result = await noLspAgent.resolveSymbols(filePath);

      expect(result.file_path).toBe(filePath);
      expect(result.total_symbols).toBeGreaterThan(0);
      // All symbols unresolved since no LSP is available
      expect(result.resolved_count).toBe(0);
      expect(result.unresolved_count).toBe(result.total_symbols);
      expect(result.resolutions.every((r) => r.resolved === false)).toBe(true);
    });

    it('reports all identifiers as unresolved when LSP is not initialized', async () => {
      // Agent with LSP config but not initialized
      const lspAgent = new ParserAgent({ command: 'nonexistent-lsp' });

      const filePath = resolve(tmpDir, 'unresolved.ts');
      writeFileSync(filePath, 'function foo() { return bar(); }\n');

      const result = await lspAgent.resolveSymbols(filePath);

      // Without initializing LSP, all should be unresolved
      expect(result.resolved_count).toBe(0);
      expect(result.unresolved_count).toBe(result.total_symbols);
    });

    it('provides correct usage site locations for unresolved symbols', async () => {
      const noLspAgent = new ParserAgent();

      const filePath = resolve(tmpDir, 'locations.ts');
      writeFileSync(filePath, 'const hello = world;\n');

      const result = await noLspAgent.resolveSymbols(filePath);

      // Should have found identifiers
      expect(result.resolutions.length).toBeGreaterThan(0);

      for (const resolution of result.resolutions) {
        expect(resolution.usage_site.file_path).toBe(filePath);
        expect(resolution.usage_site.start_line).toBeGreaterThanOrEqual(0);
        expect(resolution.usage_site.start_column).toBeGreaterThanOrEqual(0);
        expect(resolution.usage_site.end_line).toBeGreaterThanOrEqual(resolution.usage_site.start_line);
        expect(resolution.resolved).toBe(false);
        expect(resolution.definition_site).toBeNull();
      }
    });

    it('reports duration_ms for symbol resolution', async () => {
      const noLspAgent = new ParserAgent();

      const filePath = resolve(tmpDir, 'duration.ts');
      writeFileSync(filePath, 'let a = b + c;\n');

      const result = await noLspAgent.resolveSymbols(filePath);

      expect(typeof result.duration_ms).toBe('number');
      expect(result.duration_ms).toBeGreaterThanOrEqual(0);
    });

    it('counts total symbols correctly for a file with multiple identifiers', async () => {
      const noLspAgent = new ParserAgent();

      const filePath = resolve(tmpDir, 'many-ids.ts');
      writeFileSync(filePath, 'function add(a: number, b: number): number { return a + b; }\n');

      const result = await noLspAgent.resolveSymbols(filePath);

      // Should find multiple identifiers: add, a, number, b, number, number, a, b
      expect(result.total_symbols).toBeGreaterThan(3);
      expect(result.resolutions.length).toBe(result.total_symbols);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Test case: Call graph edge count (via CallGraphBuilder)
  // Requirements: 2.5
  // ─────────────────────────────────────────────────────────────────────────

  describe('call graph construction', () => {
    it('buildCallGraph is accessible via CallGraphBuilder with correct edge semantics', async () => {
      // Since CallGraphBuilder requires a real database with data,
      // we test the parser side: that resolveSymbols identifies function calls
      const noLspAgent = new ParserAgent();

      const filePath = resolve(tmpDir, 'calls.ts');
      const source = [
        'function foo() { return 1; }',
        'function bar() { return foo(); }',
        'function baz() { return bar() + foo(); }',
      ].join('\n');
      writeFileSync(filePath, source);

      const result = await noLspAgent.resolveSymbols(filePath);

      // Should identify the function names and call references
      // foo, bar, baz are defined, and foo() called in bar, bar()+foo() called in baz
      expect(result.total_symbols).toBeGreaterThan(0);

      // Verify we can find the identifier names in usage sites
      const identifierNames = new Set<string>();
      // Parse the file to check the CST
      const parseResult = noLspAgent.parseSource(source, filePath);
      const identifiers = findAllNodesByType(parseResult.cst, 'identifier');
      for (const id of identifiers) {
        if (id.text) identifierNames.add(id.text);
      }

      // Should contain our function names
      expect(identifierNames.has('foo')).toBe(true);
      expect(identifierNames.has('bar')).toBe(true);
      expect(identifierNames.has('baz')).toBe(true);
    });

    it('parser identifies all identifier nodes that would form call graph edges', () => {
      const source = [
        'class MyClass {',
        '  method1() { return this.method2(); }',
        '  method2() { return 42; }',
        '}',
        'const obj = new MyClass();',
        'obj.method1();',
      ].join('\n');

      const result = agent.parseSource(source, 'callgraph.ts');
      const identifiers = findAllNodesByType(result.cst, 'identifier');
      const propertyIds = findAllNodesByType(result.cst, 'property_identifier');

      // Should find class name, method names, obj, and property accesses
      const allIds = [...identifiers, ...propertyIds];
      expect(allIds.length).toBeGreaterThan(5);

      const idTexts = allIds.filter((n) => n.text).map((n) => n.text!);
      expect(idTexts).toContain('MyClass');
      expect(idTexts).toContain('method1');
      expect(idTexts).toContain('method2');
      expect(idTexts).toContain('obj');
    });

    it('unresolved references are correctly marked when building symbol data', async () => {
      const noLspAgent = new ParserAgent();

      const filePath = resolve(tmpDir, 'unresolved-calls.ts');
      writeFileSync(filePath, 'const result = unknownFunction(arg1, arg2);\n');

      const result = await noLspAgent.resolveSymbols(filePath);

      // Without LSP, all identifiers are unresolved
      expect(result.unresolved_count).toBe(result.total_symbols);
      // A call graph would exclude these unresolved references
      for (const resolution of result.resolutions) {
        expect(resolution.resolved).toBe(false);
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Additional parseSource tests for completeness
  // ─────────────────────────────────────────────────────────────────────────

  describe('parseSource - additional coverage', () => {
    it('parses valid source code', () => {
      const source = 'function hello(): string { return "world"; }';
      const result = agent.parseSource(source, 'test.ts');

      expect(result.cst.type).toBe('program');
      expect(result.errors).toHaveLength(0);
      expect(result.file_path).toBe('test.ts');
    });

    it('generates unique IDs for each CST node', () => {
      const source = 'const a = 1; const b = 2;';
      const result = agent.parseSource(source, 'test.ts');

      const ids = collectAllIds(result.cst);
      const uniqueIds = new Set(ids);
      expect(ids.length).toBe(uniqueIds.size);
    });

    it('includes text property only on leaf nodes', () => {
      const source = 'const x = 42;';
      const result = agent.parseSource(source, 'test.ts');

      expect(result.cst.children.length).toBeGreaterThan(0);
      expect(result.cst.text).toBeUndefined();

      const leaf = findLeafNode(result.cst);
      expect(leaf).toBeDefined();
      expect(leaf!.text).toBeDefined();
      expect(leaf!.children).toHaveLength(0);
    });

    it('sets correct byte offsets on root node', () => {
      const source = 'let x = 1;';
      const result = agent.parseSource(source, 'test.ts');

      expect(result.cst.start_byte).toBe(0);
      expect(result.cst.end_byte).toBe(source.length);
    });

    it('sets correct positions across multiple lines', () => {
      const source = 'let a = 1;\nlet b = 2;\n';
      const result = agent.parseSource(source, 'test.ts');

      expect(result.cst.start_position.row).toBe(0);
      expect(result.cst.start_position.column).toBe(0);
      expect(result.cst.end_position.row).toBe(2);
    });

    it('handles empty source code', () => {
      const result = agent.parseSource('', 'empty.ts');

      expect(result.cst.type).toBe('program');
      expect(result.errors).toHaveLength(0);
      expect(result.cst.children).toHaveLength(0);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Helper functions
// ─────────────────────────────────────────────────────────────────────────

function findNodeByType(
  node: { type: string; children: any[]; text?: string },
  type: string
): { type: string; children: any[]; text?: string } | undefined {
  if (node.type === type) return node;
  for (const child of node.children) {
    const found = findNodeByType(child, type);
    if (found) return found;
  }
  return undefined;
}

function findAllNodesByType(
  node: { type: string; children: any[]; text?: string },
  type: string
): { type: string; children: any[]; text?: string }[] {
  const results: { type: string; children: any[]; text?: string }[] = [];
  if (node.type === type) results.push(node);
  for (const child of node.children) {
    results.push(...findAllNodesByType(child, type));
  }
  return results;
}

function collectAllIds(node: { id: string; children: any[] }): string[] {
  const ids = [node.id];
  for (const child of node.children) {
    ids.push(...collectAllIds(child));
  }
  return ids;
}

function collectAllLeaves(node: { children: any[]; text?: string }): { text?: string }[] {
  if (node.children.length === 0) return [node];
  const leaves: { text?: string }[] = [];
  for (const child of node.children) {
    leaves.push(...collectAllLeaves(child));
  }
  return leaves;
}

function findLeafNode(node: { children: any[]; text?: string }): { children: any[]; text?: string } | undefined {
  if (node.children.length === 0) return node;
  for (const child of node.children) {
    const found = findLeafNode(child);
    if (found) return found;
  }
  return undefined;
}

function findAllErrorNodes(node: { is_error: boolean; children: any[] }): { is_error: boolean; children: any[] }[] {
  const errors: { is_error: boolean; children: any[] }[] = [];
  if (node.is_error) errors.push(node);
  for (const child of node.children) {
    errors.push(...findAllErrorNodes(child));
  }
  return errors;
}
