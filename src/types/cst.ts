/**
 * Concrete Syntax Tree (CST) types for Tree-sitter parsing.
 */

export interface Position {
  row: number;
  column: number;
}

export interface CstNode {
  id: string;
  type: string;
  start_byte: number;
  end_byte: number;
  start_position: Position;
  end_position: Position;
  children: CstNode[];
  is_error: boolean;
  text?: string;
}

export interface SyntaxError {
  message: string;
  location: Position;
  length: number;
}

export interface ParseResult {
  cst: CstNode;
  errors: SyntaxError[];
  duration_ms: number;
  file_path: string;
}

export interface TreeSitterEdit {
  start_byte: number;
  old_end_byte: number;
  new_end_byte: number;
  start_position: Position;
  old_end_position: Position;
  new_end_position: Position;
}
