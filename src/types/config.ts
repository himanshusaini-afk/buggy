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
  watchlist?: WatchlistConfig;
}

/**
 * Experience-memory ("watchlist") configuration.
 *
 * `scope` controls how far lessons travel:
 *  - `local`   — raw episodes only, stored in this project's `.debugger/` DB.
 *  - `team`    — also write verified lessons to `.kiro/steering/buggy-watchlist.md`.
 *  - `global`  — also promote generalized, sanitized lessons (corroborated across
 *                ≥2 projects) to the user-level store shared by all your projects.
 *  - `layered` — all of the above (default).
 */
export interface WatchlistConfig {
  enabled: boolean;
  scope: 'local' | 'team' | 'global' | 'layered';
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
