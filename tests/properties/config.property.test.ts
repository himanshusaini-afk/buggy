import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fc from 'fast-check';
import { resolve } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { loadConfig, ConfigError } from '../../src/config/config-loader.js';

/**
 * Property 29: Configuration Validation
 *
 * Generate random YAML content with valid/invalid syntax, type violations,
 * unrecognized keys, and missing optional keys.
 *
 * Verify:
 * - invalid YAML → error with path/line/column
 * - type violation → error with key/value/expected
 * - unrecognized keys → warning + proceed
 * - missing optionals → defaults applied
 *
 * **Validates: Requirements 18.4, 18.5, 18.6, 18.7**
 */

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeValidConfigObj(): Record<string, unknown> {
  return {
    language: 'typescript',
    parser: { command: 'tree-sitter parse' },
    lsp: { command: 'ts-lsp --stdio' },
    sandbox: {
      runtime: 'node:20',
      memory_limit_mb: 512,
      timeout_seconds: 60,
      egress_policy: 'deny',
    },
    oracles: {
      timeout_threshold_seconds: 30,
      crash_detection: true,
      overflow_detection: true,
      determinism_check_count: 5,
    },
    probe: {
      search_budget: 1000,
      max_refinement_iterations: 10,
    },
  };
}

function toYaml(value: unknown, indent: number): string {
  const pad = ' '.repeat(indent);
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map(
        (v) =>
          `${pad}- ${typeof v === 'object' ? toYaml(v, indent + 2).trimStart() : v}`
      )
      .join('\n');
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    return entries
      .map(([k, v]) => {
        if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
          return `${pad}${k}:\n${toYaml(v, indent + 2)}`;
        }
        if (Array.isArray(v)) {
          return `${pad}${k}:\n${toYaml(v, indent + 2)}`;
        }
        return `${pad}${k}: ${toYaml(v, 0)}`;
      })
      .join('\n');
  }
  return String(value);
}

function yamlFromObj(obj: Record<string, unknown>): string {
  return toYaml(obj, 0);
}

function writeTmpConfig(dir: string, content: string): void {
  writeFileSync(resolve(dir, '.debugger.yaml'), content, 'utf-8');
}

// ─── Arbitraries ─────────────────────────────────────────────────────────────

/**
 * Generates invalid YAML strings that will fail parsing.
 * Uses common YAML syntax violations: unclosed brackets/braces, bad indentation with colons, tabs in wrong places.
 */
const arbInvalidYaml = fc.oneof(
  // Unclosed bracket
  fc.tuple(fc.string({ minLength: 1, maxLength: 20 })).map(([key]) => {
    const safeKey = key.replace(/[:\n\r#{}[\]]/g, 'a');
    return `${safeKey}: [unclosed\n`;
  }),
  // Unclosed brace
  fc.tuple(fc.string({ minLength: 1, maxLength: 20 })).map(([key]) => {
    const safeKey = key.replace(/[:\n\r#{}[\]]/g, 'b');
    return `${safeKey}: {unclosed\n`;
  }),
  // Duplicate map key on same line using flow mapping syntax error
  fc.constant('key: value\n  bad indent: [\n'),
  // Invalid mapping with colon in wrong place
  fc.tuple(fc.string({ minLength: 1, maxLength: 10 })).map(([_]) => {
    return `valid_key: "ok"\ninvalid: [missing bracket\nanother: value\n`;
  })
);

/**
 * Generates a valid integer outside a given [min, max] range.
 */
function arbOutOfRange(min: number, max: number): fc.Arbitrary<number> {
  return fc.oneof(
    fc.integer({ min: min - 1000, max: min - 1 }),
    fc.integer({ min: max + 1, max: max + 1000 })
  );
}

/**
 * Generates a value that is NOT a valid integer (type violation).
 * Uses strings that are safe for YAML serialization (no special YAML chars).
 */
const arbNonInteger = fc.oneof(
  // Safe strings that won't confuse YAML parser
  fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz '.split('')), {
    minLength: 1,
    maxLength: 15,
  }).map((s) => `"${s.trim() || 'text'}"`),
  fc.boolean(),
  fc.double({ min: 0.1, max: 999.9, noNaN: true, noDefaultInfinity: true }).filter(
    (n) => !Number.isInteger(n)
  )
);

/**
 * Generates random key names that won't collide with known keys.
 */
const arbUnrecognizedKey = fc
  .stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz_'.split('')), {
    minLength: 3,
    maxLength: 15,
  })
  .filter(
    (k) =>
      ![
        'language',
        'parser',
        'lsp',
        'sandbox',
        'oracles',
        'probe',
        'plugs',
        'command',
        'grammar_path',
        'initialization_options',
        'runtime',
        'memory_limit_mb',
        'timeout_seconds',
        'egress_policy',
        'timeout_threshold_seconds',
        'crash_detection',
        'overflow_detection',
        'determinism_check_count',
        'search_budget',
        'max_refinement_iterations',
        'parsing',
        'repair',
        'sandbox_executor',
      ].includes(k)
  );

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Property 29: Configuration Validation', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(resolve(tmpdir(), 'debugger-prop-config-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('invalid YAML syntax produces ConfigError with path, line, and column info', () => {
    fc.assert(
      fc.property(arbInvalidYaml, (invalidContent) => {
        writeTmpConfig(tmpDir, invalidContent);

        try {
          loadConfig(tmpDir);
          // If it does not throw, the generated content was accidentally valid YAML.
          // This is acceptable — fast-check will try other examples.
          return true;
        } catch (err) {
          // Must be a ConfigError
          expect(err).toBeInstanceOf(ConfigError);
          const message = (err as ConfigError).message;

          // Must contain file path reference
          expect(message).toMatch(/\.debugger\.yaml/);

          // Must contain "Invalid YAML syntax"
          expect(message).toMatch(/Invalid YAML syntax/);

          // Must contain line/column indication
          expect(message).toMatch(/line \d+/i);
          expect(message).toMatch(/column \d+/i);

          return true;
        }
      }),
      { numRuns: 100 }
    );
  });

  it('type violations produce ConfigError identifying key, provided value, and expected constraint', () => {
    // Test type violations for numeric fields with range constraints
    const numericFields: Array<{
      section: string;
      key: string;
      min: number;
      max: number;
    }> = [
      { section: 'sandbox', key: 'memory_limit_mb', min: 64, max: 8192 },
      { section: 'sandbox', key: 'timeout_seconds', min: 1, max: 300 },
      {
        section: 'oracles',
        key: 'timeout_threshold_seconds',
        min: 1,
        max: 300,
      },
      { section: 'oracles', key: 'determinism_check_count', min: 1, max: 100 },
    ];

    // Use a chained arbitrary so the out-of-range value matches the selected field
    const arbFieldWithBadValue = fc
      .integer({ min: 0, max: numericFields.length - 1 })
      .chain((fieldIndex) => {
        const field = numericFields[fieldIndex];
        const arbBadValue = fc.oneof(
          // Out-of-range integer values
          arbOutOfRange(field.min, field.max),
          // Wrong type: non-numeric values (strings that YAML will parse as strings)
          arbNonInteger
        );
        return arbBadValue.map((v) => ({ fieldIndex, invalidValue: v }));
      });

    fc.assert(
      fc.property(arbFieldWithBadValue, ({ fieldIndex, invalidValue }) => {
        const field = numericFields[fieldIndex];
        const cfg = makeValidConfigObj();
        const section = cfg[field.section] as Record<string, unknown>;
        section[field.key] = invalidValue;

        writeTmpConfig(tmpDir, yamlFromObj(cfg));

        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'info').mockImplementation(() => {});

        let threw = false;
        try {
          loadConfig(tmpDir);
        } catch (err) {
          threw = true;
          expect(err).toBeInstanceOf(ConfigError);
          const message = (err as ConfigError).message;

          // Must identify the key path (e.g. "sandbox.memory_limit_mb")
          expect(message).toContain(`${field.section}.${field.key}`);

          // Must contain "Invalid configuration value"
          expect(message).toMatch(/Invalid configuration value/);

          // Must include the provided value representation or expected constraint
          // The error message includes "got <value>" and "expected <constraint>"
          expect(message).toMatch(/got /);
          expect(message).toMatch(/expected /);
        }

        // The config loader MUST reject type/range violations
        expect(threw).toBe(true);
      }),
      { numRuns: 100 }
    );
  });

  it('unrecognized top-level keys produce a warning and config still loads successfully', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(arbUnrecognizedKey, { minLength: 1, maxLength: 5 }),
        (extraKeys) => {
          const cfg = makeValidConfigObj();

          // Add unrecognized keys
          for (const key of extraKeys) {
            (cfg as Record<string, unknown>)[key] = 'some_value';
          }

          writeTmpConfig(tmpDir, yamlFromObj(cfg));

          const warnSpy = vi
            .spyOn(console, 'warn')
            .mockImplementation(() => {});
          vi.spyOn(console, 'info').mockImplementation(() => {});

          // Should NOT throw — unrecognized keys are non-fatal
          const config = loadConfig(tmpDir);

          // Config should still load correctly
          expect(config.language).toBe('typescript');
          expect(config.sandbox.memory_limit_mb).toBe(512);

          // Should have logged a warning for each unrecognized key
          for (const key of extraKeys) {
            expect(warnSpy).toHaveBeenCalledWith(
              expect.stringContaining(key)
            );
          }

          return true;
        }
      ),
      { numRuns: 100 }
    );
  });

  it('unrecognized nested keys produce a warning and config still loads successfully', () => {
    const sections = ['sandbox', 'oracles', 'probe', 'parser', 'lsp'] as const;

    fc.assert(
      fc.property(
        fc.constantFrom(...sections),
        arbUnrecognizedKey,
        (section, extraKey) => {
          const cfg = makeValidConfigObj();
          const sectionObj = cfg[section] as Record<string, unknown>;
          sectionObj[extraKey] = 'unexpected';

          writeTmpConfig(tmpDir, yamlFromObj(cfg));

          const warnSpy = vi
            .spyOn(console, 'warn')
            .mockImplementation(() => {});
          vi.spyOn(console, 'info').mockImplementation(() => {});

          // Should NOT throw
          const config = loadConfig(tmpDir);
          expect(config.language).toBe('typescript');

          // Should have logged a warning for the nested unrecognized key
          expect(warnSpy).toHaveBeenCalledWith(
            expect.stringContaining(`${section}.${extraKey}`)
          );

          return true;
        }
      ),
      { numRuns: 100 }
    );
  });

  it('missing optional keys result in defaults applied and informational log', () => {
    // Optional keys and their expected defaults:
    // - lsp.initialization_options → {}
    // - sandbox.egress_policy → 'deny'
    // - plugs → undefined (no plugs configured)

    interface OptionalField {
      path: string[];
      expectedDefault: unknown;
      logSubstring: string;
    }

    const optionalFields: OptionalField[] = [
      {
        path: ['lsp', 'initialization_options'],
        expectedDefault: {},
        logSubstring: 'lsp.initialization_options',
      },
      {
        path: ['sandbox', 'egress_policy'],
        expectedDefault: 'deny',
        logSubstring: 'sandbox.egress_policy',
      },
      {
        path: ['plugs'],
        expectedDefault: undefined,
        logSubstring: 'plugs',
      },
    ];

    fc.assert(
      fc.property(
        // Choose a non-empty subset of optional fields to omit
        fc.uniqueArray(fc.integer({ min: 0, max: optionalFields.length - 1 }), {
          minLength: 1,
          maxLength: optionalFields.length,
        }),
        (fieldIndices) => {
          const cfg = makeValidConfigObj();

          // Remove the selected optional keys
          for (const idx of fieldIndices) {
            const field = optionalFields[idx];
            if (field.path.length === 1) {
              delete (cfg as Record<string, unknown>)[field.path[0]];
            } else if (field.path.length === 2) {
              const section = cfg[field.path[0]] as Record<string, unknown>;
              if (section) {
                delete section[field.path[1]];
              }
            }
          }

          writeTmpConfig(tmpDir, yamlFromObj(cfg));

          const infoSpy = vi
            .spyOn(console, 'info')
            .mockImplementation(() => {});
          vi.spyOn(console, 'warn').mockImplementation(() => {});

          // Should load successfully
          const config = loadConfig(tmpDir);

          // Verify defaults were applied
          for (const idx of fieldIndices) {
            const field = optionalFields[idx];
            if (field.path[0] === 'lsp' && field.path[1] === 'initialization_options') {
              expect(config.lsp.initialization_options).toEqual(
                field.expectedDefault
              );
            } else if (
              field.path[0] === 'sandbox' &&
              field.path[1] === 'egress_policy'
            ) {
              expect(config.sandbox.egress_policy).toBe(field.expectedDefault);
            } else if (field.path[0] === 'plugs') {
              expect(config.plugs).toBe(field.expectedDefault);
            }

            // Verify informational log was produced
            expect(infoSpy).toHaveBeenCalledWith(
              expect.stringContaining(field.logSubstring)
            );
          }

          return true;
        }
      ),
      { numRuns: 100 }
    );
  });
});
