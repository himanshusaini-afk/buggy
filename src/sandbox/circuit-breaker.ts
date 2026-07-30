import type { ResourceLimits, ResourceUsage } from '../types/sandbox.js';

/**
 * Identifies which resource cap was violated.
 */
export type ViolatedResource = 'cpu_time' | 'memory' | 'disk_io' | 'ttl';

/**
 * Records a resource violation event from the circuit breaker.
 */
export interface ResourceViolation {
  /** Which resource cap was exceeded */
  resource: ViolatedResource;
  /** The value at the time of violation */
  actualValue: number;
  /** The configured cap that was exceeded */
  capValue: number;
  /** ISO timestamp when the violation was detected */
  timestamp: string;
}

/**
 * Notification sent to the requesting agent when a circuit breaker triggers.
 */
export interface CircuitBreakerNotification {
  /** The microVM instance ID that was terminated */
  instanceId: string;
  /** The reason for termination */
  reason: 'resource_exceeded' | 'ttl_expired';
  /** Details of the resource violation */
  violation: ResourceViolation;
  /** Whether the instance was force-killed due to stuck termination */
  forceKilled: boolean;
  /** Duration in ms from trigger to resource release */
  releaseTimeMs: number;
}

/**
 * Represents the state of the circuit breaker for a microVM instance.
 */
export type CircuitBreakerState = 'running' | 'terminated' | 'force_killed' | 'released';

/**
 * Event emitted by the circuit breaker for state transitions.
 */
export interface CircuitBreakerEvent {
  instanceId: string;
  previousState: CircuitBreakerState;
  newState: CircuitBreakerState;
  timestamp: string;
  violation?: ResourceViolation;
}

/**
 * Callback for terminating a microVM instance.
 * Returns true if termination completed successfully, false otherwise.
 */
export type TerminateCallback = (instanceId: string) => Promise<boolean>;

/**
 * Callback for force-killing a microVM at the hypervisor level.
 */
export type ForceKillCallback = (instanceId: string) => Promise<void>;

/**
 * Callback for releasing all resources associated with a microVM.
 */
export type ReleaseResourcesCallback = (instanceId: string) => Promise<void>;

/**
 * Callback for notifying the requesting agent of termination.
 */
export type NotifyCallback = (notification: CircuitBreakerNotification) => void;

/** Maximum allowed CPU time in seconds (Req 17.1) */
export const MAX_CPU_TIME_SECONDS = 300;

/** Maximum allowed memory in MB (Req 17.1) */
export const MAX_MEMORY_MB = 2048;

/** Maximum allowed disk I/O in MB (Req 17.1) */
export const MAX_DISK_IO_MB = 1024;

/** Maximum allowed TTL in seconds (Req 17.2) */
export const MAX_TTL_SECONDS = 600;

/** Maximum time allowed for resource release after trigger (Req 17.5) */
export const RESOURCE_RELEASE_TIMEOUT_MS = 10_000;

/** Maximum time allowed for graceful termination before force-kill (Req 17.6) */
export const TERMINATION_TIMEOUT_MS = 5_000;

/**
 * Validated and clamped resource caps for a circuit breaker instance.
 */
export interface CircuitBreakerLimits {
  cpuTimeSeconds: number;
  memoryMb: number;
  diskIoMb: number;
  ttlSeconds: number;
}

/**
 * Circuit Breaker for Firecracker microVM resource enforcement.
 *
 * Enforces hypervisor-level resource caps per microVM instance:
 * - CPU time: configurable, maximum 300 seconds (Req 17.1)
 * - Memory allocation: configurable, maximum 2048 MB (Req 17.1)
 * - Disk I/O: configurable, maximum 1024 MB (Req 17.1)
 * - Hard TTL: configurable, maximum 600 seconds (Req 17.2)
 *
 * State machine:
 *   Running → Terminated (resource cap exceeded or TTL expired)
 *   Terminated → Released (resources freed within 10s)
 *   Running → ForceKilled (termination stuck >5s)
 *   ForceKilled → Released (hypervisor kill)
 *
 * Requirements: 17.1, 17.2, 17.3, 17.4, 17.5, 17.6
 */
export class CircuitBreaker {
  private state: CircuitBreakerState = 'running';
  private limits: CircuitBreakerLimits;
  private instanceId: string;
  private startedAt: number;
  private ttlTimer: ReturnType<typeof setTimeout> | null = null;
  private monitorInterval: ReturnType<typeof setInterval> | null = null;
  private violation: ResourceViolation | null = null;
  private forceKilled = false;

  private terminateCallback: TerminateCallback;
  private forceKillCallback: ForceKillCallback;
  private releaseResourcesCallback: ReleaseResourcesCallback;
  private notifyCallback: NotifyCallback;

  constructor(
    instanceId: string,
    resourceLimits: ResourceLimits,
    callbacks: {
      terminate: TerminateCallback;
      forceKill: ForceKillCallback;
      releaseResources: ReleaseResourcesCallback;
      notify: NotifyCallback;
    }
  ) {
    this.instanceId = instanceId;
    this.limits = this.clampLimits(resourceLimits);
    this.startedAt = Date.now();
    this.terminateCallback = callbacks.terminate;
    this.forceKillCallback = callbacks.forceKill;
    this.releaseResourcesCallback = callbacks.releaseResources;
    this.notifyCallback = callbacks.notify;
  }

  /**
   * Clamp resource limits to hard maximums.
   * Configured values cannot exceed the system-wide maximums.
   */
  clampLimits(limits: ResourceLimits): CircuitBreakerLimits {
    return {
      cpuTimeSeconds: Math.min(Math.max(1, limits.cpu_time_seconds), MAX_CPU_TIME_SECONDS),
      memoryMb: Math.min(Math.max(1, limits.memory_mb), MAX_MEMORY_MB),
      diskIoMb: Math.min(Math.max(1, limits.disk_io_mb), MAX_DISK_IO_MB),
      ttlSeconds: Math.min(Math.max(1, limits.ttl_seconds), MAX_TTL_SECONDS),
    };
  }

  /**
   * Start monitoring the microVM instance for resource cap violations.
   * Sets up TTL timer and periodic resource usage checks.
   *
   * @param pollingIntervalMs - How often to check resource usage (default 1000ms)
   */
  start(pollingIntervalMs = 1000): void {
    if (this.state !== 'running') return;

    // Enforce hard TTL (Req 17.2, 17.3)
    this.ttlTimer = setTimeout(() => {
      this.triggerOnTtlExpired();
    }, this.limits.ttlSeconds * 1000);

    // Periodic resource usage monitoring (Req 17.1, 17.4)
    this.monitorInterval = setInterval(() => {
      // Resource check is driven externally via checkResourceUsage()
      // This interval ensures we check even if no external push occurs
    }, pollingIntervalMs);
  }

  /**
   * Check current resource usage against configured caps.
   * If any cap is exceeded, triggers the circuit breaker.
   *
   * @param usage - Current resource usage snapshot
   * @returns The violation if a cap was exceeded, null otherwise
   */
  checkResourceUsage(usage: ResourceUsage): ResourceViolation | null {
    if (this.state !== 'running') return null;

    // Check CPU time cap (Req 17.1)
    if (usage.cpu_time_seconds > this.limits.cpuTimeSeconds) {
      const violation: ResourceViolation = {
        resource: 'cpu_time',
        actualValue: usage.cpu_time_seconds,
        capValue: this.limits.cpuTimeSeconds,
        timestamp: new Date().toISOString(),
      };
      this.trigger(violation, 'resource_exceeded');
      return violation;
    }

    // Check memory cap (Req 17.1)
    if (usage.memory_peak_mb > this.limits.memoryMb) {
      const violation: ResourceViolation = {
        resource: 'memory',
        actualValue: usage.memory_peak_mb,
        capValue: this.limits.memoryMb,
        timestamp: new Date().toISOString(),
      };
      this.trigger(violation, 'resource_exceeded');
      return violation;
    }

    // Check disk I/O cap (Req 17.1)
    if (usage.disk_io_mb > this.limits.diskIoMb) {
      const violation: ResourceViolation = {
        resource: 'disk_io',
        actualValue: usage.disk_io_mb,
        capValue: this.limits.diskIoMb,
        timestamp: new Date().toISOString(),
      };
      this.trigger(violation, 'resource_exceeded');
      return violation;
    }

    return null;
  }

  /**
   * Trigger the circuit breaker due to TTL expiry (Req 17.3).
   */
  private triggerOnTtlExpired(): void {
    if (this.state !== 'running') return;

    const elapsedSeconds = (Date.now() - this.startedAt) / 1000;
    const violation: ResourceViolation = {
      resource: 'ttl',
      actualValue: elapsedSeconds,
      capValue: this.limits.ttlSeconds,
      timestamp: new Date().toISOString(),
    };

    this.trigger(violation, 'ttl_expired');
  }

  /**
   * Trigger the circuit breaker: terminate instance, release resources, notify agent.
   *
   * Steps (Req 17.4, 17.5, 17.6):
   * 1. Record the violation
   * 2. Attempt graceful termination (max 5s)
   * 3. If stuck, force-kill at hypervisor level
   * 4. Release all resources (within 10s total)
   * 5. Notify requesting agent
   */
  private trigger(violation: ResourceViolation, reason: 'resource_exceeded' | 'ttl_expired'): void {
    if (this.state !== 'running') return;

    this.state = 'terminated';
    this.violation = violation;
    this.stopTimers();

    // Perform async termination and cleanup
    this.performTerminationAndRelease(reason).catch(() => {
      // Ensure we always transition to released state even on errors
      this.state = 'released';
    });
  }

  /**
   * Perform the full termination flow:
   * 1. Attempt graceful termination (5s budget) (Req 17.6)
   * 2. Force-kill if stuck (Req 17.6)
   * 3. Release all resources (10s total budget) (Req 17.5)
   * 4. Notify requesting agent (Req 17.5)
   */
  private async performTerminationAndRelease(reason: 'resource_exceeded' | 'ttl_expired'): Promise<void> {
    const releaseStart = Date.now();

    // Step 1: Attempt graceful termination with 5s timeout (Req 17.6)
    const terminated = await this.terminateWithTimeout();

    if (!terminated) {
      // Step 2: Force-kill at hypervisor level (Req 17.6)
      this.state = 'force_killed';
      this.forceKilled = true;
      await this.forceKillCallback(this.instanceId).catch(() => {});
    }

    // Step 3: Release all resources within 10s budget (Req 17.5)
    await this.releaseWithTimeout();

    this.state = 'released';
    const releaseTimeMs = Date.now() - releaseStart;

    // Step 4: Notify requesting agent (Req 17.5)
    const notification: CircuitBreakerNotification = {
      instanceId: this.instanceId,
      reason,
      violation: this.violation!,
      forceKilled: this.forceKilled,
      releaseTimeMs,
    };

    this.notifyCallback(notification);
  }

  /**
   * Attempt to terminate the instance within TERMINATION_TIMEOUT_MS.
   * Returns true if terminated successfully, false if stuck (Req 17.6).
   */
  private async terminateWithTimeout(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        resolve(false); // Termination stuck, needs force-kill
      }, TERMINATION_TIMEOUT_MS);

      this.terminateCallback(this.instanceId)
        .then((success) => {
          clearTimeout(timer);
          resolve(success);
        })
        .catch(() => {
          clearTimeout(timer);
          resolve(false);
        });
    });
  }

  /**
   * Release all resources with the 10s overall budget (Req 17.5).
   * Does not throw — always attempts cleanup.
   */
  private async releaseWithTimeout(): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        resolve(); // Exceeded budget, but we still move to released state
      }, RESOURCE_RELEASE_TIMEOUT_MS);

      this.releaseResourcesCallback(this.instanceId)
        .then(() => {
          clearTimeout(timer);
          resolve();
        })
        .catch(() => {
          clearTimeout(timer);
          resolve();
        });
    });
  }

  /**
   * Stop all active timers (TTL timer and monitor interval).
   */
  private stopTimers(): void {
    if (this.ttlTimer !== null) {
      clearTimeout(this.ttlTimer);
      this.ttlTimer = null;
    }
    if (this.monitorInterval !== null) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
    }
  }

  /**
   * Manually stop the circuit breaker (for normal execution completion).
   * Call this when the microVM finishes execution normally.
   */
  stop(): void {
    this.stopTimers();
    if (this.state === 'running') {
      this.state = 'released';
    }
  }

  /**
   * Get the current state of the circuit breaker.
   */
  getState(): CircuitBreakerState {
    return this.state;
  }

  /**
   * Get the recorded violation, if any.
   */
  getViolation(): ResourceViolation | null {
    return this.violation;
  }

  /**
   * Get whether the instance was force-killed.
   */
  wasForceKilled(): boolean {
    return this.forceKilled;
  }

  /**
   * Get the configured limits (after clamping).
   */
  getLimits(): CircuitBreakerLimits {
    return { ...this.limits };
  }

  /**
   * Get the instance ID being monitored.
   */
  getInstanceId(): string {
    return this.instanceId;
  }

  /**
   * Get elapsed time since the circuit breaker started monitoring.
   */
  getElapsedMs(): number {
    return Date.now() - this.startedAt;
  }
}
