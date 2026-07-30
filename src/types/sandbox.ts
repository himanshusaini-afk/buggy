/**
 * Sandbox agent types for isolated code execution.
 */

export interface ResourceLimits {
  vcpus: number;
  memory_mb: number;
  disk_mb: number;
  ttl_seconds: number;
  cpu_time_seconds: number;
  disk_io_mb: number;
}

export interface OapPassport {
  agent_id: string;
  permitted_operations: string[];
  issued_at: string;
  expires_at: string;
}

export type OracleType = 'timeout' | 'crash' | 'determinism' | 'overflow';

export interface ExecutionRequest {
  code: string;
  runtime: string;
  oap_passport: OapPassport;
  resource_limits: ResourceLimits;
  oracles: OracleType[];
}

export interface TimeoutDetails {
  elapsed_duration_ms: number;
  configured_limit_ms: number;
}

export interface CrashDetails {
  exception_type: string;
  stack_trace: string[];  // max 50 frames
  message: string;
}

export interface DeterminismDetails {
  input: unknown;
  output_1: unknown;
  output_2: unknown;
}

export interface OverflowDetails {
  offending_value: number;
  expected_bounds: { min: number; max: number };
  operation: string;
}

export interface OracleViolation {
  oracle_id: OracleType;
  timestamp: string;
  details: TimeoutDetails | CrashDetails | DeterminismDetails | OverflowDetails;
}

export interface ResourceUsage {
  cpu_time_seconds: number;
  memory_peak_mb: number;
  disk_io_mb: number;
  wall_time_ms: number;
}

export interface ExecutionResult {
  status: 'completed' | 'timeout' | 'crashed' | 'resource_exceeded' | 'error';
  output?: unknown;
  oracle_violations: OracleViolation[];
  duration_ms: number;
  resource_usage: ResourceUsage;
}
