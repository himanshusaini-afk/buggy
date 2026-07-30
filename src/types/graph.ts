/**
 * Graph database types for symbol resolution and call graphs.
 */

export interface SourceLocation {
  file_path: string;
  start_line: number;
  start_column: number;
  end_line: number;
  end_column: number;
}

export interface SymbolResolution {
  usage_site: SourceLocation;
  definition_site: SourceLocation | null;
  type_info: string | null;
  enclosing_scope: string | null;
  resolved: boolean;
}

export interface NodeRecord {
  id: string;
  type: string;
  file_path: string;
  start_byte: number;
  end_byte: number;
  start_line: number;
  start_column: number;
  end_line: number;
  end_column: number;
  node_kind?: string;
  text_content?: string;
  is_error: boolean;
  metadata?: string;
  created_at: string;
}

export interface EdgeRecord {
  id: string;
  source_id: string;
  target_id: string;
  relationship: 'parent_of' | 'calls' | 'references' | 'defines' | 'type_of';
  metadata?: string;
  created_at: string;
}

export interface CallGraphResult {
  nodes: NodeRecord[];
  edges: EdgeRecord[];
  entry_points: string[];
}
