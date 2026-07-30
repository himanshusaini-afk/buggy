/**
 * Configuration types for the Proof-Carrying Debugger system.
 * Loaded from `.debugger.yaml` at startup.
 */

export interface DebuggerConfig {
  language: string;
  parser: ParserConfig;
  lsp: LspConfig;
  sandbox: SandboxConfig;
  oracles: OracleConfig;
  probe: ProbeConfig;
  plugs?: PlugConfig;
}

export interface ParserConfig {
  command: string;
  grammar_path?: string;
}

export interface LspConfig {
  command: string;
  initialization_options?: Record<string, unknown>;
}

export interface SandboxConfig {
  runtime: string;
  memory_limit_mb: number;
  timeout_seconds: number;
  egress_policy: 'deny' | 'allow_host_only';
}

export interface OracleConfig {
  timeout_threshold_seconds: number;
  crash_detection: boolean;
  overflow_detection: boolean;
  determinism_check_count: number;
}

export interface ProbeConfig {
  search_budget: number;
  max_refinement_iterations: number;
}

export interface PlugConfig {
  parsing?: string;
  oracles?: string[];
  repair?: string;
  sandbox_executor?: string;
}
