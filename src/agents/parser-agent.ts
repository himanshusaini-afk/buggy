/**
 * Parser Agent - Tree-sitter CST parsing with fault tolerance and LSP symbol resolution.
 *
 * Parses source files into Concrete Syntax Trees (CSTs) using Tree-sitter,
 * preserving all whitespace, comments, and formatting. Produces error nodes
 * for syntactically invalid regions with byte offset and length.
 *
 * Resolves cross-file symbol references via an attached LSP instance,
 * marking unresolved symbols (LSP failure or 5s timeout) with resolved=false.
 */

import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import Parser from 'tree-sitter';
import TypeScriptLanguage from 'tree-sitter-typescript';

import type { CstNode, ParseResult, Position, SyntaxError as CstSyntaxError, TreeSitterEdit } from '../types/cst.js';
import type { SymbolResolution, SourceLocation } from '../types/graph.js';
import { LspClient, type LspClientConfig, type DefinitionResult } from './lsp-client.js';

/**
 * Result of resolving all symbols in a file.
 */
export interface SymbolResolutionResult {
  file_path: string;
  resolutions: SymbolResolution[];
  total_symbols: number;
  resolved_count: number;
  unresolved_count: number;
  duration_ms: number;
}

/** Node types in the Tree-sitter CST that represent symbol references. */
const IDENTIFIER_NODE_TYPES = new Set([
  'identifier',
  'property_identifier',
  'shorthand_property_identifier',
  'shorthand_property_identifier_pattern',
  'type_identifier',
  'namespace_identifier',
]);

/**
 * ParserAgent handles Tree-sitter CST parsing with fault tolerance.
 * Supports files up to 100,000 lines with sub-millisecond target performance.
 * Resolves cross-file symbol references via an attached LSP client.
 */
export class ParserAgent {
  private parser: Parser;
  private nodeCounter: number = 0;
  private lspClient: LspClient | null = null;

  constructor(lspConfig?: LspClientConfig) {
    this.parser = new Parser();
    this.parser.setLanguage(TypeScriptLanguage.typescript as unknown as Parser.Language);

    if (lspConfig) {
      this.lspClient = new LspClient(lspConfig);
    }
  }

  /**
   * Initialize the LSP client connection. Must be called before resolveSymbols
   * if an LspClientConfig was provided to the constructor.
   */
  async initLsp(): Promise<void> {
    if (this.lspClient) {
      await this.lspClient.start();
    }
  }

  /**
   * Shutdown the LSP client connection. Should be called when the agent is done.
   */
  async shutdownLsp(): Promise<void> {
    if (this.lspClient) {
      await this.lspClient.shutdown();
    }
  }

  /** Map of file path -> last parsed Tree-sitter tree for incremental parsing */
  private treeCache: Map<string, Parser.Tree> = new Map();

  /**
   * Parse a file into a fault-tolerant CST.
   *
   * @param filePath - Absolute path to the source file
   * @returns ParseResult with CST, errors, duration, and file path
   */
  async parseFile(filePath: string): Promise<ParseResult> {
    const source = await readFile(filePath, 'utf-8');
    return this.parseSource(source, filePath);
  }

  /**
   * Perform incremental re-parsing limited to the changed region.
   * Uses Tree-sitter's edit API to re-parse only the changed portion,
   * producing a CST structurally equivalent to a full re-parse of the edited file.
   *
   * @param filePath - Path to the source file (or identifier for caching)
   * @param edit - The edit descriptor specifying what changed
   * @param newSource - The full source text after the edit has been applied
   * @returns ParseResult with CST, errors, duration, and file path
   */
  parseIncremental(filePath: string, edit: TreeSitterEdit, newSource: string): ParseResult {
    this.nodeCounter = 0;

    const start = performance.now();

    // Get the previous tree from cache (if available)
    const previousTree = this.treeCache.get(filePath);

    let tree: Parser.Tree;

    if (previousTree) {
      // Apply the edit to the old tree to inform Tree-sitter what changed
      previousTree.edit({
        startIndex: edit.start_byte,
        oldEndIndex: edit.old_end_byte,
        newEndIndex: edit.new_end_byte,
        startPosition: { row: edit.start_position.row, column: edit.start_position.column },
        oldEndPosition: { row: edit.old_end_position.row, column: edit.old_end_position.column },
        newEndPosition: { row: edit.new_end_position.row, column: edit.new_end_position.column },
      });

      // Incrementally parse with the edited old tree
      tree = this.parser.parse(newSource, previousTree);
    } else {
      // No previous tree, fall back to full parse
      tree = this.parser.parse(newSource);
    }

    const duration_ms = performance.now() - start;

    // Cache the new tree for future incremental parses
    this.treeCache.set(filePath, tree);

    const errors: CstSyntaxError[] = [];
    const cst = this.convertNode(tree.rootNode, errors);

    return {
      cst,
      errors,
      duration_ms,
      file_path: filePath,
    };
  }

  /**
   * Parse source code string into a fault-tolerant CST.
   * Exposed for direct use without file I/O (useful for testing).
   *
   * @param source - The source code string to parse
   * @param filePath - The file path to associate with the result
   * @returns ParseResult with CST, errors, duration, and file path
   */
  parseSource(source: string, filePath: string): ParseResult {
    this.nodeCounter = 0;

    const start = performance.now();
    const tree = this.parser.parse(source);
    const duration_ms = performance.now() - start;

    // Cache the tree for future incremental parses
    this.treeCache.set(filePath, tree);

    const errors: CstSyntaxError[] = [];
    const cst = this.convertNode(tree.rootNode, errors);

    if (duration_ms > 1) {
      // Requirement 1.5: report actual duration if exceeding 1ms threshold
      // Duration is always returned; this branch is for logging/observability
    }

    return {
      cst,
      errors,
      duration_ms,
      file_path: filePath,
    };
  }

  /**
   * Recursively converts a Tree-sitter SyntaxNode into a CstNode,
   * collecting error nodes along the way.
   */
  private convertNode(node: Parser.SyntaxNode, errors: CstSyntaxError[]): CstNode {
    const id = this.generateId();
    const isError = node.isError || node.isMissing;

    // Collect errors for the ParseResult errors array
    if (isError) {
      const errorMessage = node.isMissing
        ? `Missing node: expected ${node.type}`
        : `Syntax error at byte ${node.startIndex}`;

      errors.push({
        message: errorMessage,
        location: {
          row: node.startPosition.row,
          column: node.startPosition.column,
        },
        length: node.endIndex - node.startIndex,
      });
    }

    const startPosition: Position = {
      row: node.startPosition.row,
      column: node.startPosition.column,
    };

    const endPosition: Position = {
      row: node.endPosition.row,
      column: node.endPosition.column,
    };

    // Build children recursively
    const children: CstNode[] = [];
    for (const child of node.children) {
      children.push(this.convertNode(child, errors));
    }

    const cstNode: CstNode = {
      id,
      type: node.type,
      start_byte: node.startIndex,
      end_byte: node.endIndex,
      start_position: startPosition,
      end_position: endPosition,
      children,
      is_error: isError,
    };

    // For leaf nodes (no children), include the text property
    // This preserves whitespace, comments, and formatting
    if (node.childCount === 0) {
      cstNode.text = node.text;
    }

    return cstNode;
  }

  /**
   * Generates a unique ID for each CST node using a monotonic counter.
   */
  private generateId(): string {
    return `node_${++this.nodeCounter}`;
  }

  /**
   * Resolve all symbol references in a file via the attached LSP instance.
   *
   * Walks the CST to find identifier/reference nodes, then queries the LSP
   * for each symbol's definition location, type, and enclosing scope.
   * Symbols that fail to resolve (LSP error or 5s timeout) are marked with
   * resolved=false.
   *
   * @param filePath - Absolute path to the source file
   * @returns SymbolResolutionResult with counts and individual resolutions
   */
  async resolveSymbols(filePath: string): Promise<SymbolResolutionResult> {
    const start = performance.now();
    const source = await readFile(filePath, 'utf-8');

    // Parse the file to get identifier nodes
    const tree = this.parser.parse(source);
    const identifierNodes = this.collectIdentifierNodes(tree.rootNode);

    const resolutions: SymbolResolution[] = [];
    let resolvedCount = 0;
    let unresolvedCount = 0;

    for (const node of identifierNodes) {
      const position = { line: node.startPosition.row, character: node.startPosition.column };
      const usageSite: SourceLocation = {
        file_path: filePath,
        start_line: node.startPosition.row,
        start_column: node.startPosition.column,
        end_line: node.endPosition.row,
        end_column: node.endPosition.column,
      };

      let definitionSite: SourceLocation | null = null;
      let typeInfo: string | null = null;
      let enclosingScope: string | null = null;
      let resolved = false;

      if (this.lspClient) {
        // Query LSP for definition
        const defResult = await this.lspClient.resolveDefinition(filePath, position);
        if (defResult) {
          definitionSite = this.definitionResultToLocation(defResult);
          resolved = true;
        }

        // Query LSP for type info (hover)
        typeInfo = await this.lspClient.getTypeInfo(filePath, position);

        // Determine enclosing scope from CST parent traversal
        enclosingScope = this.findEnclosingScope(node);
      }

      if (resolved) {
        resolvedCount++;
      } else {
        unresolvedCount++;
      }

      resolutions.push({
        usage_site: usageSite,
        definition_site: definitionSite,
        type_info: typeInfo,
        enclosing_scope: enclosingScope,
        resolved,
      });
    }

    const duration_ms = performance.now() - start;

    return {
      file_path: filePath,
      resolutions,
      total_symbols: identifierNodes.length,
      resolved_count: resolvedCount,
      unresolved_count: unresolvedCount,
      duration_ms,
    };
  }

  /**
   * Collect all identifier/reference nodes from the Tree-sitter syntax tree.
   */
  private collectIdentifierNodes(rootNode: Parser.SyntaxNode): Parser.SyntaxNode[] {
    const identifiers: Parser.SyntaxNode[] = [];

    const walk = (node: Parser.SyntaxNode): void => {
      if (IDENTIFIER_NODE_TYPES.has(node.type)) {
        identifiers.push(node);
      }
      for (const child of node.children) {
        walk(child);
      }
    };

    walk(rootNode);
    return identifiers;
  }

  /**
   * Convert a DefinitionResult from the LSP into a SourceLocation.
   */
  private definitionResultToLocation(def: DefinitionResult): SourceLocation {
    // Convert file URI to path, handling both Unix and Windows paths
    let filePath: string;
    try {
      filePath = new URL(def.uri).pathname;
      // On Windows, remove leading slash from /C:/... paths
      if (/^\/[a-zA-Z]:/.test(filePath)) {
        filePath = filePath.slice(1);
      }
    } catch {
      filePath = def.uri;
    }

    return {
      file_path: filePath,
      start_line: def.range.start.line,
      start_column: def.range.start.character,
      end_line: def.range.end.line,
      end_column: def.range.end.character,
    };
  }

  /**
   * Find the enclosing scope (function/method/class name) for a given node
   * by walking up the Tree-sitter syntax tree.
   */
  private findEnclosingScope(node: Parser.SyntaxNode): string | null {
    let current: Parser.SyntaxNode | null = node.parent;

    while (current) {
      if (
        current.type === 'function_declaration' ||
        current.type === 'method_definition' ||
        current.type === 'arrow_function' ||
        current.type === 'class_declaration'
      ) {
        // Try to find the name child
        const nameNode = current.childForFieldName('name');
        if (nameNode) {
          return nameNode.text;
        }
      }
      current = current.parent;
    }

    return null;
  }
}
