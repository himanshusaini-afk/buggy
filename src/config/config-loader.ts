/**
 * Configuration loader for `.debugger.yaml`.
 *
 * Validates the YAML file against a Zod schema and applies defaults
 * for omitted optional keys.
 *
 * @module config/config-loader
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml, YAMLParseError } from 'yaml';
import { z, ZodError } from 'zod';
import type { DebuggerConfig } from '../types/config.js';

// ─── Error Class ─────────────────────────────────────────────────────────────

/**
 * Represents a fatal configuration error that terminates startup.
 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

// ─── Zod Schema ──────────────────────────────────────────────────────────────

const parserSchema = z.object({
  command: z.string(),
  grammar_path: z.string().optional(),
});

const lspSchema = z.object({
  command: z.string(),
  initialization_options: z.record(z.unknown()).optional().default({}),
});

const sandboxSchema = z.object({
  runtime: z.string(),
  memory_limit_mb: z.number().int().min(64).max(8192),
  timeout_seconds: z.number().int().min(1).max(300),
  egress_policy: z.enum(['deny', 'allow_host_only']).optional().default('deny'),
});

const oracleSchema = z.object({
  timeout_threshold_seconds: z.number().int().min(1).max(300),
  crash_detection: z.boolean(),
  overflow_detection: z.boolean(),
  determinism_check_count: z.number().int().min(1).max(100),
});

const probeSchema = z.object({
  search_budget: z.number().int().positive(),
  max_refinement_iterations: z.number().int().positive(),
});

const plugsSchema = z.object({
  parsing: z.string().optional(),
  oracles: z.array(z.string()).optional(),
  repair: z.string().optional(),
  sandbox_executor: z.string().optional(),
}).optional();

const configSchema = z.object({
  language: z.string(),
  parser: parserSchema,
  lsp: lspSchema,
  sandbox: sandboxSchema,
  oracles: oracleSchema,
  probe: probeSchema,
  plugs: plugsSchema,
});

// Known top-level and nested keys for unrecognized-key detection
const KNOWN_TOP_LEVEL_KEYS = new Set([
  'language', 'parser', 'lsp', 'sandbox', 'oracles', 'probe', 'plugs',
]);

const KNOWN_NESTED_KEYS: Record<string, Set<string>> = {
  parser: new Set(['command', 'grammar_path']),
  lsp: new Set(['command', 'initialization_options']),
  sandbox: new Set(['runtime', 'memory_limit_mb', 'timeout_seconds', 'egress_policy']),
  oracles: new Set(['timeout_threshold_seconds', 'crash_detection', 'overflow_detection', 'determinism_check_count']),
  probe: new Set(['search_budget', 'max_refinement_iterations']),
  plugs: new Set(['parsing', 'oracles', 'repair', 'sandbox_executor']),
};

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Loads and validates the `.debugger.yaml` configuration file.
 *
 * @param projectRoot - Absolute path to the project root directory
 * @returns A fully validated and defaulted {@link DebuggerConfig}
 * @throws {ConfigError} When the file is missing, has invalid YAML syntax, or contains invalid values
 */
export function loadConfig(projectRoot: string): DebuggerConfig {
  const configPath = resolve(projectRoot, '.debugger.yaml');

  // 1. Read file — missing file is fatal
  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf-8');
  } catch {
    throw new ConfigError(
      `Configuration file not found: ${configPath}`,
    );
  }

  // 2. Parse YAML — syntax errors are fatal
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err: unknown) {
    if (err instanceof YAMLParseError) {
      const pos = err.linePos?.[0];
      const line = pos?.line ?? 'unknown';
      const col = pos?.col ?? 'unknown';
      throw new ConfigError(
        `Invalid YAML syntax in ${configPath} at line ${line}, column ${col}: ${err.message}`,
      );
    }
    throw new ConfigError(
      `Invalid YAML syntax in ${configPath}: ${String(err)}`,
    );
  }

  if (parsed === null || parsed === undefined || typeof parsed !== 'object') {
    throw new ConfigError(
      `Invalid YAML syntax in ${configPath}: file does not contain a mapping`,
    );
  }

  const rawObj = parsed as Record<string, unknown>;

  // 3. Warn about unrecognized keys (non-fatal — proceed)
  warnUnrecognizedKeys(rawObj);

  // 4. Validate with Zod schema — invalid values are fatal
  let validated: z.infer<typeof configSchema>;
  try {
    validated = configSchema.parse(rawObj);
  } catch (err: unknown) {
    if (err instanceof ZodError) {
      const issue = err.issues[0];
      const key = issue.path.join('.');
      const message = formatZodIssue(issue, rawObj);
      throw new ConfigError(message);
    }
    throw new ConfigError(`Configuration validation failed: ${String(err)}`);
  }

  // 5. Log defaults for optional keys that were omitted
  logAppliedDefaults(rawObj);

  return validated as DebuggerConfig;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function warnUnrecognizedKeys(obj: Record<string, unknown>): void {
  for (const key of Object.keys(obj)) {
    if (!KNOWN_TOP_LEVEL_KEYS.has(key)) {
      console.warn(`[config] Warning: unrecognized configuration key "${key}"`);
    }
  }

  // Check nested keys within known sections
  for (const [section, knownKeys] of Object.entries(KNOWN_NESTED_KEYS)) {
    const sectionObj = obj[section];
    if (sectionObj && typeof sectionObj === 'object' && !Array.isArray(sectionObj)) {
      for (const key of Object.keys(sectionObj as Record<string, unknown>)) {
        if (!knownKeys.has(key)) {
          console.warn(`[config] Warning: unrecognized configuration key "${section}.${key}"`);
        }
      }
    }
  }
}

function logAppliedDefaults(rawObj: Record<string, unknown>): void {
  const lsp = rawObj['lsp'] as Record<string, unknown> | undefined;
  if (lsp && !('initialization_options' in lsp)) {
    console.info('[config] Applied default for "lsp.initialization_options": {}');
  }

  const sandbox = rawObj['sandbox'] as Record<string, unknown> | undefined;
  if (sandbox && !('egress_policy' in sandbox)) {
    console.info('[config] Applied default for "sandbox.egress_policy": "deny"');
  }

  if (!('plugs' in rawObj)) {
    console.info('[config] Applied default for "plugs": undefined (no plugs configured)');
  }
}

function formatZodIssue(issue: z.ZodIssue, rawObj: Record<string, unknown>): string {
  const key = issue.path.join('.');
  const providedValue = getNestedValue(rawObj, issue.path as string[]);
  const providedStr = providedValue === undefined ? 'undefined' : JSON.stringify(providedValue);

  switch (issue.code) {
    case 'too_small':
      return `Invalid configuration value for "${key}": got ${providedStr}, expected minimum ${(issue as z.ZodTooSmallIssue).minimum}`;
    case 'too_big':
      return `Invalid configuration value for "${key}": got ${providedStr}, expected maximum ${(issue as z.ZodTooBigIssue).maximum}`;
    case 'invalid_type':
      return `Invalid configuration value for "${key}": got ${providedStr}, expected type ${issue.expected}`;
    case 'invalid_enum_value':
      return `Invalid configuration value for "${key}": got ${providedStr}, expected one of ${JSON.stringify((issue as z.ZodInvalidEnumValueIssue).options)}`;
    default:
      return `Invalid configuration value for "${key}": got ${providedStr}. ${issue.message}`;
  }
}

function getNestedValue(obj: Record<string, unknown>, path: string[]): unknown {
  let current: unknown = obj;
  for (const segment of path) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}
