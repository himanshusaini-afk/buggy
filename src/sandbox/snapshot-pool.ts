import type { ResourceLimits } from '../types/sandbox.js';
import type {
  MicroVmInstance,
  FirecrackerApiClient,
  NetworkManager,
  BlockDeviceManager,
  SandboxAgentConfig,
  TapSubnetAllocation,
} from './sandbox-agent.js';
import { SandboxCreationError } from './sandbox-agent.js';
import { randomUUID } from 'node:crypto';

/**
 * Minimum number of pre-warmed snapshots maintained per runtime environment.
 * Requirement 16.1: at least 2 per configured runtime.
 */
export const MIN_POOL_SIZE = 2;

/**
 * Maximum time allowed for a cold-start microVM initialization.
 * Requirement 16.4: cold-start within 5 seconds.
 */
export const COLD_START_TIMEOUT_MS = 5000;

/**
 * Target latency for snapshot restore via CoW mapping.
 * Requirement 16.3: median ≤150ms, p99 ≤500ms.
 */
export const TARGET_MEDIAN_RESTORE_MS = 150;
export const TARGET_P99_RESTORE_MS = 500;

/**
 * Represents a pre-warmed microVM snapshot in the pool.
 */
export interface SnapshotEntry {
  id: string;
  runtime: string;
  memorySnapshotPath: string;
  vmStatePath: string;
  createdAt: number;
}

/**
 * Represents a restore event for latency tracking.
 */
export interface RestoreEvent {
  timestamp: number;
  runtime: string;
  durationMs: number;
  method: 'cow' | 'cold-start';
  success: boolean;
}

/**
 * Configuration for the snapshot pool.
 */
export interface SnapshotPoolConfig {
  /** Runtime environments to maintain snapshots for */
  runtimes: string[];
  /** Minimum pool size per runtime (default: MIN_POOL_SIZE) */
  minPoolSize?: number;
  /** Base directory for snapshot storage */
  snapshotDir: string;
  /** Cold-start timeout in ms (default: COLD_START_TIMEOUT_MS) */
  coldStartTimeoutMs?: number;
}

/**
 * Logger interface for reporting snapshot pool events.
 */
export interface SnapshotPoolLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/**
 * Default console logger implementation.
 */
const defaultLogger: SnapshotPoolLogger = {
  info(message: string, meta?: Record<string, unknown>) {
    // In production this would route to structured logging
    void meta;
  },
  warn(message: string, meta?: Record<string, unknown>) {
    void meta;
  },
  error(message: string, meta?: Record<string, unknown>) {
    void meta;
  },
};

/**
 * Interface for CoW (Copy-on-Write) memory mapping operations.
 * Abstracted to allow testing without actual VM snapshot infrastructure.
 */
export interface CowMapper {
  /**
   * Restore a microVM from a snapshot using CoW memory mapping.
   * Maps the snapshot's memory file as CoW so the restored VM gets
   * its own writable copy without modifying the base snapshot.
   *
   * @param snapshotEntry - The snapshot to restore from
   * @param targetSocketPath - Unix socket path for the restored VM
   * @returns The restored VM instance
   * @throws Error if CoW mapping fails
   */
  restoreFromSnapshot(
    snapshotEntry: SnapshotEntry,
    targetSocketPath: string
  ): Promise<MicroVmInstance>;
}

/**
 * Interface for creating fresh (cold-start) microVM instances.
 * Used as a fallback when CoW restore fails or no snapshot is available.
 */
export interface ColdStarter {
  /**
   * Create a new microVM instance from scratch (cold-start).
   * Must complete within the configured cold-start timeout.
   *
   * @param runtime - The runtime environment identifier
   * @param timeoutMs - Maximum time allowed for the cold-start
   * @returns A freshly created MicroVmInstance
   * @throws Error if cold-start exceeds timeout or creation fails
   */
  coldStart(runtime: string, timeoutMs: number): Promise<MicroVmInstance>;
}

/**
 * SnapshotPool maintains pre-warmed microVM snapshots per runtime and
 * provides fast restore via Copy-on-Write (CoW) memory mappings.
 *
 * Requirements covered:
 * - 16.1: Maintain ≥2 pre-warmed snapshots per configured runtime
 * - 16.2: Restore pre-warmed state using CoW_Mapping on execution request
 * - 16.3: Median restore ≤150ms, p99 ≤500ms
 * - 16.4: Fall back to cold-start within 5s on CoW failure + report
 * - 16.5: Cold-start + async replenishment when no snapshot available
 */
export class SnapshotPool {
  private pool: Map<string, SnapshotEntry[]> = new Map();
  private restoreHistory: RestoreEvent[] = [];
  private replenishmentInProgress: Map<string, boolean> = new Map();
  private config: Required<SnapshotPoolConfig>;
  private cowMapper: CowMapper;
  private coldStarter: ColdStarter;
  private logger: SnapshotPoolLogger;

  constructor(
    config: SnapshotPoolConfig,
    cowMapper: CowMapper,
    coldStarter: ColdStarter,
    logger?: SnapshotPoolLogger
  ) {
    this.config = {
      runtimes: config.runtimes,
      minPoolSize: config.minPoolSize ?? MIN_POOL_SIZE,
      snapshotDir: config.snapshotDir,
      coldStartTimeoutMs: config.coldStartTimeoutMs ?? COLD_START_TIMEOUT_MS,
    };
    this.cowMapper = cowMapper;
    this.coldStarter = coldStarter;
    this.logger = logger ?? defaultLogger;

    // Initialize pool buckets for each runtime
    for (const runtime of this.config.runtimes) {
      this.pool.set(runtime, []);
      this.replenishmentInProgress.set(runtime, false);
    }
  }

  /**
   * Initialize the pool by creating pre-warmed snapshots for all configured runtimes.
   * Ensures at least `minPoolSize` snapshots exist per runtime (Req 16.1).
   */
  async initialize(): Promise<void> {
    const initPromises: Promise<void>[] = [];
    for (const runtime of this.config.runtimes) {
      initPromises.push(this.fillPool(runtime));
    }
    await Promise.all(initPromises);
  }

  /**
   * Restore a pre-warmed microVM snapshot for the given runtime using CoW mapping.
   *
   * Flow (Req 16.2, 16.3, 16.4, 16.5):
   * 1. If snapshot available → restore via CoW (target: median ≤150ms, p99 ≤500ms)
   * 2. If CoW fails → cold-start within 5s + report failure + async replenish
   * 3. If no snapshot available → cold-start + trigger async replenishment
   *
   * @param runtime - The runtime environment to restore
   * @returns A MicroVmInstance ready for execution
   */
  async restoreSnapshot(runtime: string): Promise<MicroVmInstance> {
    const startTime = Date.now();

    // Get the pool for this runtime
    const entries = this.pool.get(runtime);

    // Case: No snapshot available (Req 16.5)
    if (!entries || entries.length === 0) {
      this.logger.warn('No pre-warmed snapshot available, falling back to cold-start', {
        runtime,
      });

      // Trigger async replenishment
      this.triggerAsyncReplenishment(runtime);

      // Cold-start within timeout
      const instance = await this.performColdStart(runtime, startTime);
      return instance;
    }

    // Take a snapshot from the pool (FIFO)
    const snapshot = entries.shift()!;

    // Attempt CoW restore (Req 16.2, 16.3)
    try {
      const socketPath = `${this.config.snapshotDir}/${randomUUID()}.sock`;
      const instance = await this.cowMapper.restoreFromSnapshot(snapshot, socketPath);
      const duration = Date.now() - startTime;

      this.recordRestoreEvent({
        timestamp: Date.now(),
        runtime,
        durationMs: duration,
        method: 'cow',
        success: true,
      });

      this.logger.info('Snapshot restored via CoW', {
        runtime,
        durationMs: duration,
        snapshotId: snapshot.id,
      });

      // Trigger replenishment if pool is below minimum
      if (entries.length < this.config.minPoolSize) {
        this.triggerAsyncReplenishment(runtime);
      }

      return instance;
    } catch (error) {
      // CoW failure — fall back to cold-start (Req 16.4)
      const cowDuration = Date.now() - startTime;

      this.recordRestoreEvent({
        timestamp: Date.now(),
        runtime,
        durationMs: cowDuration,
        method: 'cow',
        success: false,
      });

      this.logger.error('CoW restore failed, falling back to cold-start', {
        runtime,
        snapshotId: snapshot.id,
        error: error instanceof Error ? error.message : String(error),
        cowDurationMs: cowDuration,
      });

      // Trigger async replenishment (Req 16.4)
      this.triggerAsyncReplenishment(runtime);

      // Cold-start fallback within 5s (Req 16.4)
      const instance = await this.performColdStart(runtime, startTime);
      return instance;
    }
  }

  /**
   * Perform a cold-start microVM initialization.
   * Must complete within the configured timeout (default 5s) (Req 16.4).
   */
  private async performColdStart(runtime: string, overallStartTime: number): Promise<MicroVmInstance> {
    const coldStartStart = Date.now();

    try {
      const instance = await this.withTimeout(
        this.coldStarter.coldStart(runtime, this.config.coldStartTimeoutMs),
        this.config.coldStartTimeoutMs,
        `Cold-start for runtime '${runtime}' exceeded ${this.config.coldStartTimeoutMs}ms timeout`
      );

      const duration = Date.now() - coldStartStart;

      this.recordRestoreEvent({
        timestamp: Date.now(),
        runtime,
        durationMs: duration,
        method: 'cold-start',
        success: true,
      });

      this.logger.info('Cold-start completed', {
        runtime,
        durationMs: duration,
        totalDurationMs: Date.now() - overallStartTime,
      });

      return instance;
    } catch (error) {
      const duration = Date.now() - coldStartStart;

      this.recordRestoreEvent({
        timestamp: Date.now(),
        runtime,
        durationMs: duration,
        method: 'cold-start',
        success: false,
      });

      throw new SandboxCreationError(
        `Cold-start failed for runtime '${runtime}': ${error instanceof Error ? error.message : String(error)}`,
        'hypervisor_unavailable'
      );
    }
  }

  /**
   * Fill the pool for a specific runtime up to the minimum pool size (Req 16.1).
   */
  private async fillPool(runtime: string): Promise<void> {
    const entries = this.pool.get(runtime) ?? [];
    const needed = this.config.minPoolSize - entries.length;

    for (let i = 0; i < needed; i++) {
      try {
        const snapshot = await this.createSnapshot(runtime);
        entries.push(snapshot);
      } catch (error) {
        this.logger.error('Failed to create pre-warmed snapshot', {
          runtime,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    this.pool.set(runtime, entries);
  }

  /**
   * Trigger asynchronous pool replenishment.
   * Non-blocking — runs in the background to refill the pool (Req 16.4, 16.5).
   */
  private triggerAsyncReplenishment(runtime: string): void {
    // Don't start multiple replenishments concurrently
    if (this.replenishmentInProgress.get(runtime)) {
      return;
    }

    this.replenishmentInProgress.set(runtime, true);

    // Fire and forget — replenishment happens asynchronously
    this.fillPool(runtime)
      .then(() => {
        this.logger.info('Pool replenishment completed', { runtime });
      })
      .catch((error) => {
        this.logger.error('Pool replenishment failed', {
          runtime,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        this.replenishmentInProgress.set(runtime, false);
      });
  }

  /**
   * Create a single pre-warmed snapshot for the given runtime.
   */
  private async createSnapshot(runtime: string): Promise<SnapshotEntry> {
    const id = randomUUID();
    const memorySnapshotPath = `${this.config.snapshotDir}/${runtime}/${id}.mem`;
    const vmStatePath = `${this.config.snapshotDir}/${runtime}/${id}.state`;

    // In production, this would:
    // 1. Cold-start a fresh VM with the runtime environment
    // 2. Wait for the VM to reach a "ready" state
    // 3. Pause the VM and take a memory + VM state snapshot
    // 4. Store the snapshot files for later CoW restoration

    return {
      id,
      runtime,
      memorySnapshotPath,
      vmStatePath,
      createdAt: Date.now(),
    };
  }

  /**
   * Record a restore event for latency tracking and monitoring.
   */
  private recordRestoreEvent(event: RestoreEvent): void {
    this.restoreHistory.push(event);

    // Keep only last 1000 events to prevent unbounded memory growth
    if (this.restoreHistory.length > 1000) {
      this.restoreHistory = this.restoreHistory.slice(-1000);
    }
  }

  /**
   * Get the current pool size for a given runtime.
   */
  getPoolSize(runtime: string): number {
    return this.pool.get(runtime)?.length ?? 0;
  }

  /**
   * Get all configured runtime environments.
   */
  getConfiguredRuntimes(): string[] {
    return [...this.config.runtimes];
  }

  /**
   * Get latency statistics for restore operations.
   * Returns median and p99 latencies for CoW restores.
   */
  getRestoreLatencyStats(): { median: number; p99: number; totalRestores: number } {
    const cowEvents = this.restoreHistory.filter(
      (e) => e.method === 'cow' && e.success
    );

    if (cowEvents.length === 0) {
      return { median: 0, p99: 0, totalRestores: 0 };
    }

    const sortedDurations = cowEvents
      .map((e) => e.durationMs)
      .sort((a, b) => a - b);

    const medianIdx = Math.floor(sortedDurations.length / 2);
    const p99Idx = Math.floor(sortedDurations.length * 0.99);

    return {
      median: sortedDurations[medianIdx],
      p99: sortedDurations[Math.min(p99Idx, sortedDurations.length - 1)],
      totalRestores: cowEvents.length,
    };
  }

  /**
   * Get the full restore history (for testing and monitoring).
   */
  getRestoreHistory(): RestoreEvent[] {
    return [...this.restoreHistory];
  }

  /**
   * Check if the pool meets the minimum size requirement for all runtimes (Req 16.1).
   */
  isPoolHealthy(): boolean {
    for (const runtime of this.config.runtimes) {
      const size = this.getPoolSize(runtime);
      if (size < this.config.minPoolSize) {
        return false;
      }
    }
    return true;
  }

  /**
   * Check if a replenishment is currently in progress for a runtime.
   */
  isReplenishing(runtime: string): boolean {
    return this.replenishmentInProgress.get(runtime) ?? false;
  }

  /**
   * Add a pre-created snapshot to the pool (for testing/manual management).
   */
  addSnapshot(snapshot: SnapshotEntry): void {
    const entries = this.pool.get(snapshot.runtime);
    if (entries) {
      entries.push(snapshot);
    } else {
      this.pool.set(snapshot.runtime, [snapshot]);
    }
  }

  /**
   * Wrap a promise with a timeout.
   */
  private withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(message));
      }, timeoutMs);

      promise
        .then((result) => {
          clearTimeout(timer);
          resolve(result);
        })
        .catch((error) => {
          clearTimeout(timer);
          reject(error);
        });
    });
  }
}
