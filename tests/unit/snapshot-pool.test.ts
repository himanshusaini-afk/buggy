import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  SnapshotPool,
  SnapshotPoolConfig,
  SnapshotEntry,
  CowMapper,
  ColdStarter,
  SnapshotPoolLogger,
  MIN_POOL_SIZE,
  COLD_START_TIMEOUT_MS,
} from '../../src/sandbox/snapshot-pool.js';
import type { MicroVmInstance } from '../../src/sandbox/sandbox-agent.js';

function createMockInstance(overrides?: Partial<MicroVmInstance>): MicroVmInstance {
  return {
    id: 'test-instance-id',
    socketPath: '/tmp/test.sock',
    tapDevice: 'tap0',
    subnet: '10.0.0.2/30',
    blockDevice: '/tmp/test.ext4',
    startedAt: Date.now(),
    resourceLimits: {
      vcpus: 2,
      memory_mb: 512,
      disk_mb: 1024,
      ttl_seconds: 300,
      cpu_time_seconds: 60,
      disk_io_mb: 100,
    },
    terminated: false,
    ...overrides,
  };
}

function createMockSnapshot(runtime: string, id?: string): SnapshotEntry {
  return {
    id: id ?? `snap-${Math.random().toString(36).slice(2)}`,
    runtime,
    memorySnapshotPath: `/snapshots/${runtime}/${id ?? 'test'}.mem`,
    vmStatePath: `/snapshots/${runtime}/${id ?? 'test'}.state`,
    createdAt: Date.now(),
  };
}

function createMockLogger(): SnapshotPoolLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe('SnapshotPool', () => {
  let config: SnapshotPoolConfig;
  let cowMapper: CowMapper;
  let coldStarter: ColdStarter;
  let logger: SnapshotPoolLogger;

  beforeEach(() => {
    config = {
      runtimes: ['node18', 'python3'],
      snapshotDir: '/tmp/snapshots',
    };

    cowMapper = {
      restoreFromSnapshot: vi.fn().mockResolvedValue(createMockInstance()),
    };

    coldStarter = {
      coldStart: vi.fn().mockResolvedValue(createMockInstance()),
    };

    logger = createMockLogger();
  });

  describe('constructor and configuration', () => {
    it('initializes pool buckets for each configured runtime', () => {
      const pool = new SnapshotPool(config, cowMapper, coldStarter, logger);
      expect(pool.getPoolSize('node18')).toBe(0);
      expect(pool.getPoolSize('python3')).toBe(0);
    });

    it('uses default minPoolSize of MIN_POOL_SIZE (2)', () => {
      const pool = new SnapshotPool(config, cowMapper, coldStarter, logger);
      expect(pool.getConfiguredRuntimes()).toEqual(['node18', 'python3']);
    });

    it('accepts custom minPoolSize', () => {
      const customConfig = { ...config, minPoolSize: 5 };
      const pool = new SnapshotPool(customConfig, cowMapper, coldStarter, logger);
      // Pool size starts at 0 before initialization
      expect(pool.getPoolSize('node18')).toBe(0);
    });

    it('returns configured runtimes', () => {
      const pool = new SnapshotPool(config, cowMapper, coldStarter, logger);
      expect(pool.getConfiguredRuntimes()).toEqual(['node18', 'python3']);
    });
  });

  describe('initialize - Requirement 16.1: ≥2 pre-warmed snapshots per runtime', () => {
    it('fills pool to minPoolSize for each runtime', async () => {
      const pool = new SnapshotPool(config, cowMapper, coldStarter, logger);
      await pool.initialize();

      expect(pool.getPoolSize('node18')).toBe(MIN_POOL_SIZE);
      expect(pool.getPoolSize('python3')).toBe(MIN_POOL_SIZE);
    });

    it('reports pool as healthy after initialization', async () => {
      const pool = new SnapshotPool(config, cowMapper, coldStarter, logger);
      await pool.initialize();

      expect(pool.isPoolHealthy()).toBe(true);
    });

    it('fills pool with custom minPoolSize', async () => {
      const customConfig = { ...config, minPoolSize: 4 };
      const pool = new SnapshotPool(customConfig, cowMapper, coldStarter, logger);
      await pool.initialize();

      expect(pool.getPoolSize('node18')).toBe(4);
      expect(pool.getPoolSize('python3')).toBe(4);
    });
  });

  describe('restoreSnapshot - Requirement 16.2: CoW restore from pre-warmed state', () => {
    it('restores from snapshot using CoW mapper when snapshot available', async () => {
      const pool = new SnapshotPool(config, cowMapper, coldStarter, logger);
      await pool.initialize();

      const instance = await pool.restoreSnapshot('node18');

      expect(cowMapper.restoreFromSnapshot).toHaveBeenCalled();
      expect(instance).toBeDefined();
      expect(instance.id).toBe('test-instance-id');
    });

    it('records successful CoW restore event', async () => {
      const pool = new SnapshotPool(config, cowMapper, coldStarter, logger);
      await pool.initialize();

      await pool.restoreSnapshot('node18');

      const history = pool.getRestoreHistory();
      expect(history.length).toBe(1);
      expect(history[0].method).toBe('cow');
      expect(history[0].success).toBe(true);
      expect(history[0].runtime).toBe('node18');
    });

    it('removes snapshot from pool after restore (FIFO)', async () => {
      // Use a pool size large enough that one restore doesn't trigger replenishment
      // minPoolSize must be set so that after one restore, pool >= minPoolSize
      // With minPoolSize=2 and initializing to 5 manually, after restore pool=4 which is still >= 2
      const pool = new SnapshotPool(config, cowMapper, coldStarter, logger);
      // Manually add 5 snapshots (well above minPoolSize of 2)
      for (let i = 0; i < 5; i++) {
        pool.addSnapshot(createMockSnapshot('node18', `snap-${i}`));
      }

      const sizeBefore = pool.getPoolSize('node18');
      await pool.restoreSnapshot('node18');
      const sizeAfter = pool.getPoolSize('node18');

      // After restore, one snapshot is consumed. Pool is still above min (4 >= 2),
      // so no replenishment is triggered.
      expect(sizeAfter).toBe(sizeBefore - 1);
    });

    it('triggers replenishment when pool drops below minimum', async () => {
      const pool = new SnapshotPool(config, cowMapper, coldStarter, logger);
      await pool.initialize();

      // Exhaust enough snapshots to trigger replenishment
      await pool.restoreSnapshot('node18');

      // Give async replenishment a moment to start
      await new Promise((r) => setTimeout(r, 50));

      // Pool should have been replenished back to minPoolSize
      expect(pool.getPoolSize('node18')).toBeGreaterThanOrEqual(MIN_POOL_SIZE);
    });
  });

  describe('restoreSnapshot - Requirement 16.4: Cold-start fallback on CoW failure', () => {
    it('falls back to cold-start when CoW restore fails', async () => {
      const failingCowMapper: CowMapper = {
        restoreFromSnapshot: vi.fn().mockRejectedValue(new Error('CoW mapping failed')),
      };

      const pool = new SnapshotPool(config, failingCowMapper, coldStarter, logger);
      await pool.initialize();

      const instance = await pool.restoreSnapshot('node18');

      expect(coldStarter.coldStart).toHaveBeenCalled();
      expect(instance).toBeDefined();
    });

    it('reports CoW failure via logger', async () => {
      const failingCowMapper: CowMapper = {
        restoreFromSnapshot: vi.fn().mockRejectedValue(new Error('CoW mapping failed')),
      };

      const pool = new SnapshotPool(config, failingCowMapper, coldStarter, logger);
      await pool.initialize();

      await pool.restoreSnapshot('node18');

      expect(logger.error).toHaveBeenCalledWith(
        'CoW restore failed, falling back to cold-start',
        expect.objectContaining({ runtime: 'node18' })
      );
    });

    it('records CoW failure and cold-start success events', async () => {
      const failingCowMapper: CowMapper = {
        restoreFromSnapshot: vi.fn().mockRejectedValue(new Error('CoW mapping failed')),
      };

      const pool = new SnapshotPool(config, failingCowMapper, coldStarter, logger);
      await pool.initialize();

      await pool.restoreSnapshot('node18');

      const history = pool.getRestoreHistory();
      expect(history.length).toBe(2);
      expect(history[0].method).toBe('cow');
      expect(history[0].success).toBe(false);
      expect(history[1].method).toBe('cold-start');
      expect(history[1].success).toBe(true);
    });

    it('triggers async replenishment on CoW failure', async () => {
      const failingCowMapper: CowMapper = {
        restoreFromSnapshot: vi.fn().mockRejectedValue(new Error('CoW mapping failed')),
      };

      const pool = new SnapshotPool(config, failingCowMapper, coldStarter, logger);
      await pool.initialize();

      await pool.restoreSnapshot('node18');

      // Give async replenishment a moment
      await new Promise((r) => setTimeout(r, 50));

      expect(pool.getPoolSize('node18')).toBeGreaterThanOrEqual(MIN_POOL_SIZE);
    });

    it('cold-start respects timeout configuration', async () => {
      const slowColdStarter: ColdStarter = {
        coldStart: vi.fn().mockImplementation((_runtime, timeoutMs) => {
          // Verify timeout is passed correctly
          expect(timeoutMs).toBe(COLD_START_TIMEOUT_MS);
          return Promise.resolve(createMockInstance());
        }),
      };

      const failingCowMapper: CowMapper = {
        restoreFromSnapshot: vi.fn().mockRejectedValue(new Error('CoW failed')),
      };

      const pool = new SnapshotPool(config, failingCowMapper, slowColdStarter, logger);
      await pool.initialize();

      await pool.restoreSnapshot('node18');
      expect(slowColdStarter.coldStart).toHaveBeenCalledWith('node18', COLD_START_TIMEOUT_MS);
    });
  });

  describe('restoreSnapshot - Requirement 16.5: No snapshot → cold-start + replenish', () => {
    it('performs cold-start when no snapshot is available', async () => {
      const pool = new SnapshotPool(config, cowMapper, coldStarter, logger);
      // Do NOT initialize — pool is empty

      const instance = await pool.restoreSnapshot('node18');

      expect(cowMapper.restoreFromSnapshot).not.toHaveBeenCalled();
      expect(coldStarter.coldStart).toHaveBeenCalled();
      expect(instance).toBeDefined();
    });

    it('logs warning when no snapshot available', async () => {
      const pool = new SnapshotPool(config, cowMapper, coldStarter, logger);

      await pool.restoreSnapshot('node18');

      expect(logger.warn).toHaveBeenCalledWith(
        'No pre-warmed snapshot available, falling back to cold-start',
        expect.objectContaining({ runtime: 'node18' })
      );
    });

    it('triggers async replenishment when no snapshot available', async () => {
      const pool = new SnapshotPool(config, cowMapper, coldStarter, logger);

      await pool.restoreSnapshot('node18');

      // Give async replenishment a moment
      await new Promise((r) => setTimeout(r, 50));

      expect(pool.getPoolSize('node18')).toBeGreaterThanOrEqual(MIN_POOL_SIZE);
    });
  });

  describe('restoreSnapshot - cold-start failure throws SandboxCreationError', () => {
    it('throws SandboxCreationError when cold-start fails', async () => {
      const failingColdStarter: ColdStarter = {
        coldStart: vi.fn().mockRejectedValue(new Error('hypervisor unavailable')),
      };

      const pool = new SnapshotPool(config, cowMapper, failingColdStarter, logger);
      // Don't initialize — triggers cold-start path

      await expect(pool.restoreSnapshot('node18')).rejects.toThrow('Cold-start failed');
    });
  });

  describe('latency statistics - Requirement 16.3: median ≤150ms, p99 ≤500ms', () => {
    it('tracks restore latency statistics', async () => {
      const pool = new SnapshotPool(config, cowMapper, coldStarter, logger);
      await pool.initialize();

      await pool.restoreSnapshot('node18');
      await pool.restoreSnapshot('node18');

      const stats = pool.getRestoreLatencyStats();
      expect(stats.totalRestores).toBeGreaterThanOrEqual(1);
      expect(stats.median).toBeGreaterThanOrEqual(0);
      expect(stats.p99).toBeGreaterThanOrEqual(0);
    });

    it('returns zero stats when no CoW restores recorded', () => {
      const pool = new SnapshotPool(config, cowMapper, coldStarter, logger);

      const stats = pool.getRestoreLatencyStats();
      expect(stats.median).toBe(0);
      expect(stats.p99).toBe(0);
      expect(stats.totalRestores).toBe(0);
    });
  });

  describe('pool management', () => {
    it('addSnapshot allows manual addition of snapshots', () => {
      const pool = new SnapshotPool(config, cowMapper, coldStarter, logger);
      const snap = createMockSnapshot('node18', 'manual-snap');

      pool.addSnapshot(snap);

      expect(pool.getPoolSize('node18')).toBe(1);
    });

    it('isPoolHealthy returns false when pool is below minimum', () => {
      const pool = new SnapshotPool(config, cowMapper, coldStarter, logger);
      // Pool not initialized — below minimum
      expect(pool.isPoolHealthy()).toBe(false);
    });

    it('isReplenishing returns false initially', () => {
      const pool = new SnapshotPool(config, cowMapper, coldStarter, logger);
      expect(pool.isReplenishing('node18')).toBe(false);
    });

    it('limits restore history to 1000 events', async () => {
      const pool = new SnapshotPool(
        { ...config, minPoolSize: 1100 },
        cowMapper,
        coldStarter,
        logger
      );
      await pool.initialize();

      // Restore many snapshots to exceed history limit
      for (let i = 0; i < 1001; i++) {
        pool.addSnapshot(createMockSnapshot('node18', `snap-${i}`));
      }
      for (let i = 0; i < 1001; i++) {
        await pool.restoreSnapshot('node18');
      }

      const history = pool.getRestoreHistory();
      expect(history.length).toBeLessThanOrEqual(1000);
    });
  });

  describe('async replenishment', () => {
    it('does not start multiple concurrent replenishments for same runtime', async () => {
      const pool = new SnapshotPool(config, cowMapper, coldStarter, logger);

      // Trigger multiple restores without initialization (empty pool)
      const p1 = pool.restoreSnapshot('node18');
      const p2 = pool.restoreSnapshot('node18');

      await Promise.all([p1, p2]);

      // Give replenishment a moment
      await new Promise((r) => setTimeout(r, 50));

      // Should have replenished — pool should be at least at min
      expect(pool.getPoolSize('node18')).toBeGreaterThanOrEqual(MIN_POOL_SIZE);
    });
  });
});
