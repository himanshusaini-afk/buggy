import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resolve } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { loadConfig, ConfigError } from '../../src/config/config-loader.js';

function validConfig(): Record<string, unknown> {
  return {
    language: 'typescript',
    parser: { command: 'tree-sitter parse' },
    lsp: { command: 'typescript-language-server --stdio' },
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

function writeYaml(dir: string, content: string): void {
  writeFileSync(resolve(dir, '.debugger.yaml'), content, 'utf-8');
}

function yamlFromObj(obj: Record<string, unknown>): string {
  // Simple YAML serialization for test fixtures
  return toYaml(obj, 0);
}

function toYaml(value: unknown, indent: number): string {
  const pad = ' '.repeat(indent);
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map(v => `${pad}- ${typeof v === 'object' ? toYaml(v, indent + 2).trimStart() : v}`).join('\n');
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    return entries.map(([k, v]) => {
      if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
        return `${pad}${k}:\n${toYaml(v, indent + 2)}`;
      }
      if (Array.isArray(v)) {
        return `${pad}${k}:\n${toYaml(v, indent + 2)}`;
      }
      return `${pad}${k}: ${toYaml(v, 0)}`;
    }).join('\n');
  }
  return String(value);
}

describe('config-loader', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(resolve(tmpdir(), 'debugger-config-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe('successful loading', () => {
    it('loads a valid config file with all keys', () => {
      writeYaml(tmpDir, yamlFromObj(validConfig()));
      const config = loadConfig(tmpDir);

      expect(config.language).toBe('typescript');
      expect(config.parser.command).toBe('tree-sitter parse');
      expect(config.lsp.command).toBe('typescript-language-server --stdio');
      expect(config.sandbox.memory_limit_mb).toBe(512);
      expect(config.sandbox.timeout_seconds).toBe(60);
      expect(config.sandbox.egress_policy).toBe('deny');
      expect(config.oracles.timeout_threshold_seconds).toBe(30);
      expect(config.oracles.determinism_check_count).toBe(5);
      expect(config.probe.search_budget).toBe(1000);
    });

    it('applies default for lsp.initialization_options when omitted', () => {
      const cfg = validConfig();
      const lsp = cfg['lsp'] as Record<string, unknown>;
      delete lsp['initialization_options'];
      writeYaml(tmpDir, yamlFromObj(cfg));

      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
      const config = loadConfig(tmpDir);

      expect(config.lsp.initialization_options).toEqual({});
      expect(infoSpy).toHaveBeenCalledWith(
        expect.stringContaining('lsp.initialization_options'),
      );
    });

    it('applies default for sandbox.egress_policy when omitted', () => {
      const cfg = validConfig();
      const sandbox = cfg['sandbox'] as Record<string, unknown>;
      delete sandbox['egress_policy'];
      writeYaml(tmpDir, yamlFromObj(cfg));

      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
      const config = loadConfig(tmpDir);

      expect(config.sandbox.egress_policy).toBe('deny');
      expect(infoSpy).toHaveBeenCalledWith(
        expect.stringContaining('sandbox.egress_policy'),
      );
    });

    it('applies default for plugs when omitted and logs informational message', () => {
      const cfg = validConfig();
      // plugs is already not in validConfig by default
      writeYaml(tmpDir, yamlFromObj(cfg));

      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
      const config = loadConfig(tmpDir);

      expect(config.plugs).toBeUndefined();
      expect(infoSpy).toHaveBeenCalledWith(
        expect.stringContaining('plugs'),
      );
    });
  });

  describe('missing file', () => {
    it('throws ConfigError with expected path when file is missing', () => {
      expect(() => loadConfig(tmpDir)).toThrow(ConfigError);
      expect(() => loadConfig(tmpDir)).toThrow(/Configuration file not found/);
      expect(() => loadConfig(tmpDir)).toThrow(
        new RegExp(tmpDir.replace(/\\/g, '\\\\')),
      );
    });
  });

  describe('invalid YAML', () => {
    it('throws ConfigError with line and column for YAML syntax errors', () => {
      writeYaml(tmpDir, 'language: typescript\ninvalid: [broken\n');

      expect(() => loadConfig(tmpDir)).toThrow(ConfigError);
      expect(() => loadConfig(tmpDir)).toThrow(/Invalid YAML syntax/);
    });

    it('includes line number in the error message', () => {
      writeYaml(tmpDir, 'language: typescript\ninvalid: [broken\n');

      try {
        loadConfig(tmpDir);
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigError);
        // Should mention line number (line 2 or 3 depending on parser)
        expect((err as ConfigError).message).toMatch(/line \d+/);
      }
    });

    it('includes column number in the error message', () => {
      writeYaml(tmpDir, 'language: typescript\ninvalid: [broken\n');

      try {
        loadConfig(tmpDir);
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigError);
        expect((err as ConfigError).message).toMatch(/column \d+/);
      }
    });

    it('throws ConfigError when file content is not a YAML mapping', () => {
      writeYaml(tmpDir, '- item1\n- item2\n');

      expect(() => loadConfig(tmpDir)).toThrow(ConfigError);
      // Arrays are valid YAML but not valid config objects — caught by Zod as type error
      expect(() => loadConfig(tmpDir)).toThrow(/Invalid configuration value/);
    });
  });

  describe('invalid values', () => {
    it('throws ConfigError when memory_limit_mb is below minimum', () => {
      const cfg = validConfig();
      (cfg['sandbox'] as Record<string, unknown>)['memory_limit_mb'] = 32;
      writeYaml(tmpDir, yamlFromObj(cfg));

      expect(() => loadConfig(tmpDir)).toThrow(ConfigError);
      expect(() => loadConfig(tmpDir)).toThrow(/sandbox\.memory_limit_mb/);
    });

    it('throws ConfigError when memory_limit_mb is above maximum', () => {
      const cfg = validConfig();
      (cfg['sandbox'] as Record<string, unknown>)['memory_limit_mb'] = 9000;
      writeYaml(tmpDir, yamlFromObj(cfg));

      expect(() => loadConfig(tmpDir)).toThrow(ConfigError);
      expect(() => loadConfig(tmpDir)).toThrow(/sandbox\.memory_limit_mb/);
    });

    it('throws ConfigError when timeout_seconds is out of range', () => {
      const cfg = validConfig();
      (cfg['sandbox'] as Record<string, unknown>)['timeout_seconds'] = 0;
      writeYaml(tmpDir, yamlFromObj(cfg));

      expect(() => loadConfig(tmpDir)).toThrow(ConfigError);
      expect(() => loadConfig(tmpDir)).toThrow(/sandbox\.timeout_seconds/);
    });

    it('throws ConfigError when timeout_threshold_seconds exceeds 300', () => {
      const cfg = validConfig();
      (cfg['oracles'] as Record<string, unknown>)['timeout_threshold_seconds'] = 500;
      writeYaml(tmpDir, yamlFromObj(cfg));

      expect(() => loadConfig(tmpDir)).toThrow(ConfigError);
      expect(() => loadConfig(tmpDir)).toThrow(/oracles\.timeout_threshold_seconds/);
    });

    it('throws ConfigError when determinism_check_count exceeds 100', () => {
      const cfg = validConfig();
      (cfg['oracles'] as Record<string, unknown>)['determinism_check_count'] = 200;
      writeYaml(tmpDir, yamlFromObj(cfg));

      expect(() => loadConfig(tmpDir)).toThrow(ConfigError);
      expect(() => loadConfig(tmpDir)).toThrow(/oracles\.determinism_check_count/);
    });

    it('throws ConfigError when a required key has wrong type', () => {
      const cfg = validConfig();
      (cfg['sandbox'] as Record<string, unknown>)['memory_limit_mb'] = 'big';
      writeYaml(tmpDir, yamlFromObj(cfg));

      expect(() => loadConfig(tmpDir)).toThrow(ConfigError);
      expect(() => loadConfig(tmpDir)).toThrow(/sandbox\.memory_limit_mb/);
    });

    it('throws ConfigError when egress_policy has an invalid enum value', () => {
      const cfg = validConfig();
      (cfg['sandbox'] as Record<string, unknown>)['egress_policy'] = 'allow_all';
      writeYaml(tmpDir, yamlFromObj(cfg));

      expect(() => loadConfig(tmpDir)).toThrow(ConfigError);
      expect(() => loadConfig(tmpDir)).toThrow(/sandbox\.egress_policy/);
    });

    it('includes provided value in the error message', () => {
      const cfg = validConfig();
      (cfg['sandbox'] as Record<string, unknown>)['memory_limit_mb'] = 32;
      writeYaml(tmpDir, yamlFromObj(cfg));

      try {
        loadConfig(tmpDir);
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigError);
        expect((err as ConfigError).message).toContain('32');
      }
    });
  });

  describe('unrecognized keys', () => {
    it('logs a warning for unrecognized top-level keys but does not throw', () => {
      const cfg = validConfig();
      (cfg as Record<string, unknown>)['unknown_key'] = 'value';
      writeYaml(tmpDir, yamlFromObj(cfg));

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(console, 'info').mockImplementation(() => {});

      const config = loadConfig(tmpDir);
      expect(config.language).toBe('typescript');
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('unknown_key'),
      );
    });

    it('logs a warning for unrecognized nested keys', () => {
      const cfg = validConfig();
      (cfg['sandbox'] as Record<string, unknown>)['extra_setting'] = true;
      writeYaml(tmpDir, yamlFromObj(cfg));

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(console, 'info').mockImplementation(() => {});

      const config = loadConfig(tmpDir);
      expect(config).toBeDefined();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('sandbox.extra_setting'),
      );
    });
  });

  describe('boundary values', () => {
    it('accepts memory_limit_mb at minimum (64)', () => {
      const cfg = validConfig();
      (cfg['sandbox'] as Record<string, unknown>)['memory_limit_mb'] = 64;
      writeYaml(tmpDir, yamlFromObj(cfg));
      vi.spyOn(console, 'info').mockImplementation(() => {});

      const config = loadConfig(tmpDir);
      expect(config.sandbox.memory_limit_mb).toBe(64);
    });

    it('accepts memory_limit_mb at maximum (8192)', () => {
      const cfg = validConfig();
      (cfg['sandbox'] as Record<string, unknown>)['memory_limit_mb'] = 8192;
      writeYaml(tmpDir, yamlFromObj(cfg));
      vi.spyOn(console, 'info').mockImplementation(() => {});

      const config = loadConfig(tmpDir);
      expect(config.sandbox.memory_limit_mb).toBe(8192);
    });

    it('accepts timeout_seconds at minimum (1)', () => {
      const cfg = validConfig();
      (cfg['sandbox'] as Record<string, unknown>)['timeout_seconds'] = 1;
      writeYaml(tmpDir, yamlFromObj(cfg));
      vi.spyOn(console, 'info').mockImplementation(() => {});

      const config = loadConfig(tmpDir);
      expect(config.sandbox.timeout_seconds).toBe(1);
    });

    it('accepts timeout_seconds at maximum (300)', () => {
      const cfg = validConfig();
      (cfg['sandbox'] as Record<string, unknown>)['timeout_seconds'] = 300;
      writeYaml(tmpDir, yamlFromObj(cfg));
      vi.spyOn(console, 'info').mockImplementation(() => {});

      const config = loadConfig(tmpDir);
      expect(config.sandbox.timeout_seconds).toBe(300);
    });

    it('accepts determinism_check_count at minimum (1)', () => {
      const cfg = validConfig();
      (cfg['oracles'] as Record<string, unknown>)['determinism_check_count'] = 1;
      writeYaml(tmpDir, yamlFromObj(cfg));
      vi.spyOn(console, 'info').mockImplementation(() => {});

      const config = loadConfig(tmpDir);
      expect(config.oracles.determinism_check_count).toBe(1);
    });

    it('accepts determinism_check_count at maximum (100)', () => {
      const cfg = validConfig();
      (cfg['oracles'] as Record<string, unknown>)['determinism_check_count'] = 100;
      writeYaml(tmpDir, yamlFromObj(cfg));
      vi.spyOn(console, 'info').mockImplementation(() => {});

      const config = loadConfig(tmpDir);
      expect(config.oracles.determinism_check_count).toBe(100);
    });

    it('accepts timeout_threshold_seconds at minimum (1)', () => {
      const cfg = validConfig();
      (cfg['oracles'] as Record<string, unknown>)['timeout_threshold_seconds'] = 1;
      writeYaml(tmpDir, yamlFromObj(cfg));
      vi.spyOn(console, 'info').mockImplementation(() => {});

      const config = loadConfig(tmpDir);
      expect(config.oracles.timeout_threshold_seconds).toBe(1);
    });

    it('accepts timeout_threshold_seconds at maximum (300)', () => {
      const cfg = validConfig();
      (cfg['oracles'] as Record<string, unknown>)['timeout_threshold_seconds'] = 300;
      writeYaml(tmpDir, yamlFromObj(cfg));
      vi.spyOn(console, 'info').mockImplementation(() => {});

      const config = loadConfig(tmpDir);
      expect(config.oracles.timeout_threshold_seconds).toBe(300);
    });
  });
});
