import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  CircuitBreaker,
  MAX_CPU_TIME_SECONDS,
  MAX_MEMORY_MB,
  MAX_DISK_IO_MB,
  MAX_TTL_SECONDS,
  TERMINATION_TIMEOUT_MS,
  RESOURCE_RELEASE_TIMEOUT_MS,
  type CircuitBreakerNotification,
  type ResourceViolation,
  type TerminateCallback,
  type ForceKillCallback,
  type ReleaseResourcesCallback,
  type NotifyCallback,
} from '../../src/sandbox/circuit-breaker.js';
import type { ResourceLimits, ResourceUsage } from '../../src/types/sandbox.js';

function createDefaultLimits(overrides: Partial<ResourceLimits> = {}): ResourceLimits {
  return {
    vcpus: 2,
    memory_mb: 512,
    disk_mb: 1024,
    ttl_seconds: 60,
    cpu_time_seconds: 30,
    disk_io_mb: 256,
    ...overrides,
  };
}

function createUsage(overrides: Partial<ResourceUsage> = {}): ResourceUsage {
  return {
    cpu_time_seconds: 0,
    memory_peak_mb: 0,
    disk_io_mb: 0,
    wall_time_ms: 0,
    ...overrides,
  };
}

function createCallbacks(overrides: Partial<{
  terminate: TerminateCallback;
  forceKill: ForceKillCallback;
  releaseResources: ReleaseResourcesCallback;
  notify: NotifyCallback;
}> = {}) {
  return {
    terminate: overrides.terminate ?? vi.fn(async () => true),
    forceKill: overrides.forceKill ?? vi.fn(async () => {}),
    releaseResources: overrides.releaseResources ?? vi.fn(async () => {}),
    notify: overrides.notify ?? vi.fn(),
  };
}

describe('CircuitBreaker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('clampLimits', () => {
    it('should clamp CPU time to MAX_CPU_TIME_SECONDS (300)', () => {
      const callbacks = createCallbacks();
      const cb = new CircuitBreaker('test-1', createDefaultLimits({ cpu_time_seconds: 500 }), callbacks);
      expect(cb.getLimits().cpuTimeSeconds).toBe(MAX_CPU_TIME_SECONDS);
    });

    it('should clamp memory to MAX_MEMORY_MB (2048)', () => {
      const callbacks = createCallbacks();
      const cb = new CircuitBreaker('test-1', createDefaultLimits({ memory_mb: 4096 }), callbacks);
      expect(cb.getLimits().memoryMb).toBe(MAX_MEMORY_MB);
    });

    it('should clamp disk I/O to MAX_DISK_IO_MB (1024)', () => {
      const callbacks = createCallbacks();
      const cb = new CircuitBreaker('test-1', createDefaultLimits({ disk_io_mb: 2000 }), callbacks);
      expect(cb.getLimits().diskIoMb).toBe(MAX_DISK_IO_MB);
    });

    it('should clamp TTL to MAX_TTL_SECONDS (600)', () => {
      const callbacks = createCallbacks();
      const cb = new CircuitBreaker('test-1', createDefaultLimits({ ttl_seconds: 1000 }), callbacks);
      expect(cb.getLimits().ttlSeconds).toBe(MAX_TTL_SECONDS);
    });

    it('should preserve values within allowed range', () => {
      const callbacks = createCallbacks();
      const limits = createDefaultLimits({
        cpu_time_seconds: 100,
        memory_mb: 1024,
        disk_io_mb: 512,
        ttl_seconds: 300,
      });
      const cb = new CircuitBreaker('test-1', limits, callbacks);
      const clamped = cb.getLimits();
      expect(clamped.cpuTimeSeconds).toBe(100);
      expect(clamped.memoryMb).toBe(1024);
      expect(clamped.diskIoMb).toBe(512);
      expect(clamped.ttlSeconds).toBe(300);
    });

    it('should enforce minimum of 1 for all limits', () => {
      const callbacks = createCallbacks();
      const limits = createDefaultLimits({
        cpu_time_seconds: 0,
        memory_mb: -5,
        disk_io_mb: 0,
        ttl_seconds: -1,
      });
      const cb = new CircuitBreaker('test-1', limits, callbacks);
      const clamped = cb.getLimits();
      expect(clamped.cpuTimeSeconds).toBe(1);
      expect(clamped.memoryMb).toBe(1);
      expect(clamped.diskIoMb).toBe(1);
      expect(clamped.ttlSeconds).toBe(1);
    });
  });

  describe('checkResourceUsage', () => {
    it('should return null when usage is within caps', () => {
      const callbacks = createCallbacks();
      const cb = new CircuitBreaker('test-1', createDefaultLimits({ cpu_time_seconds: 30 }), callbacks);
      cb.start();

      const violation = cb.checkResourceUsage(createUsage({ cpu_time_seconds: 10 }));
      expect(violation).toBeNull();
      expect(cb.getState()).toBe('running');
      cb.stop();
    });

    it('should detect CPU time cap exceeded (Req 17.1, 17.4)', () => {
      const callbacks = createCallbacks();
      const cb = new CircuitBreaker('test-1', createDefaultLimits({ cpu_time_seconds: 30 }), callbacks);
      cb.start();

      const violation = cb.checkResourceUsage(createUsage({ cpu_time_seconds: 31 }));
      expect(violation).not.toBeNull();
      expect(violation!.resource).toBe('cpu_time');
      expect(violation!.actualValue).toBe(31);
      expect(violation!.capValue).toBe(30);
      expect(cb.getState()).toBe('terminated');
      cb.stop();
    });

    it('should detect memory cap exceeded (Req 17.1, 17.4)', () => {
      const callbacks = createCallbacks();
      const cb = new CircuitBreaker('test-1', createDefaultLimits({ memory_mb: 512 }), callbacks);
      cb.start();

      const violation = cb.checkResourceUsage(createUsage({ memory_peak_mb: 600 }));
      expect(violation).not.toBeNull();
      expect(violation!.resource).toBe('memory');
      expect(violation!.actualValue).toBe(600);
      expect(violation!.capValue).toBe(512);
    });

    it('should detect disk I/O cap exceeded (Req 17.1, 17.4)', () => {
      const callbacks = createCallbacks();
      const cb = new CircuitBreaker('test-1', createDefaultLimits({ disk_io_mb: 256 }), callbacks);
      cb.start();

      const violation = cb.checkResourceUsage(createUsage({ disk_io_mb: 300 }));
      expect(violation).not.toBeNull();
      expect(violation!.resource).toBe('disk_io');
      expect(violation!.actualValue).toBe(300);
      expect(violation!.capValue).toBe(256);
    });

    it('should not trigger again after already terminated', () => {
      const callbacks = createCallbacks();
      const cb = new CircuitBreaker('test-1', createDefaultLimits({ cpu_time_seconds: 30 }), callbacks);
      cb.start();

      // First trigger
      cb.checkResourceUsage(createUsage({ cpu_time_seconds: 31 }));
      expect(cb.getState()).toBe('terminated');

      // Second check should not trigger again
      const secondViolation = cb.checkResourceUsage(createUsage({ memory_peak_mb: 9999 }));
      expect(secondViolation).toBeNull();
    });

    it('should record violation with ISO timestamp', () => {
      const callbacks = createCallbacks();
      const cb = new CircuitBreaker('test-1', createDefaultLimits({ cpu_time_seconds: 10 }), callbacks);
      cb.start();

      const violation = cb.checkResourceUsage(createUsage({ cpu_time_seconds: 15 }));
      expect(violation!.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  describe('TTL enforcement (Req 17.2, 17.3)', () => {
    it('should terminate instance when TTL expires', async () => {
      const callbacks = createCallbacks();
      const cb = new CircuitBreaker('test-ttl', createDefaultLimits({ ttl_seconds: 10 }), callbacks);
      cb.start();

      expect(cb.getState()).toBe('running');

      // Advance time past the TTL
      vi.advanceTimersByTime(10_000);

      // Allow async operations to settle
      await vi.advanceTimersByTimeAsync(0);

      expect(cb.getState()).not.toBe('running');
      expect(cb.getViolation()).not.toBeNull();
      expect(cb.getViolation()!.resource).toBe('ttl');
      expect(cb.getViolation()!.capValue).toBe(10);
    });

    it('should not trigger TTL if stopped before expiry', () => {
      const callbacks = createCallbacks();
      const cb = new CircuitBreaker('test-ttl', createDefaultLimits({ ttl_seconds: 60 }), callbacks);
      cb.start();

      vi.advanceTimersByTime(30_000);
      cb.stop();

      vi.advanceTimersByTime(60_000);

      expect(cb.getState()).toBe('released');
      expect(cb.getViolation()).toBeNull();
    });
  });

  describe('termination and force-kill (Req 17.6)', () => {
    it('should call terminate callback on trigger', async () => {
      const terminate = vi.fn(async () => true);
      const callbacks = createCallbacks({ terminate });
      const cb = new CircuitBreaker('test-fk', createDefaultLimits({ cpu_time_seconds: 10 }), callbacks);
      cb.start();

      cb.checkResourceUsage(createUsage({ cpu_time_seconds: 15 }));

      // Allow termination promise to resolve
      await vi.advanceTimersByTimeAsync(0);

      expect(terminate).toHaveBeenCalledWith('test-fk');
    });

    it('should force-kill if termination takes longer than 5 seconds', async () => {
      // Terminate callback never resolves within 5s
      const terminate = vi.fn(() => new Promise<boolean>((resolve) => {
        setTimeout(() => resolve(true), 8000); // Takes 8s (exceeds 5s budget)
      }));
      const forceKill = vi.fn(async () => {});
      const releaseResources = vi.fn(async () => {});
      const notify = vi.fn();
      const callbacks = { terminate, forceKill, releaseResources, notify };

      const cb = new CircuitBreaker('test-fk', createDefaultLimits({ cpu_time_seconds: 10 }), callbacks);
      cb.start();

      cb.checkResourceUsage(createUsage({ cpu_time_seconds: 15 }));

      // Advance past the TERMINATION_TIMEOUT_MS (5s)
      await vi.advanceTimersByTimeAsync(TERMINATION_TIMEOUT_MS + 100);

      expect(forceKill).toHaveBeenCalledWith('test-fk');
      expect(cb.wasForceKilled()).toBe(true);
    });

    it('should not force-kill if termination completes within 5s', async () => {
      const terminate = vi.fn(async () => true);
      const forceKill = vi.fn(async () => {});
      const releaseResources = vi.fn(async () => {});
      const notify = vi.fn();
      const callbacks = { terminate, forceKill, releaseResources, notify };

      const cb = new CircuitBreaker('test-nfk', createDefaultLimits({ cpu_time_seconds: 10 }), callbacks);
      cb.start();

      cb.checkResourceUsage(createUsage({ cpu_time_seconds: 15 }));

      // Allow immediate resolution
      await vi.advanceTimersByTimeAsync(100);

      expect(forceKill).not.toHaveBeenCalled();
      expect(cb.wasForceKilled()).toBe(false);
    });
  });

  describe('resource release within 10s (Req 17.5)', () => {
    it('should call releaseResources callback after termination', async () => {
      const releaseResources = vi.fn(async () => {});
      const notify = vi.fn();
      const callbacks = createCallbacks({ releaseResources, notify });
      const cb = new CircuitBreaker('test-rel', createDefaultLimits({ cpu_time_seconds: 10 }), callbacks);
      cb.start();

      cb.checkResourceUsage(createUsage({ cpu_time_seconds: 15 }));

      await vi.advanceTimersByTimeAsync(100);

      expect(releaseResources).toHaveBeenCalledWith('test-rel');
    });

    it('should still transition to released state if release times out', async () => {
      // Release callback that takes longer than 10s
      const releaseResources = vi.fn(() => new Promise<void>((resolve) => {
        setTimeout(resolve, 15_000);
      }));
      const notify = vi.fn();
      const terminate = vi.fn(async () => true);
      const callbacks = createCallbacks({ terminate, releaseResources, notify });
      const cb = new CircuitBreaker('test-rto', createDefaultLimits({ cpu_time_seconds: 10 }), callbacks);
      cb.start();

      cb.checkResourceUsage(createUsage({ cpu_time_seconds: 15 }));

      // Advance past RESOURCE_RELEASE_TIMEOUT_MS (10s)
      await vi.advanceTimersByTimeAsync(RESOURCE_RELEASE_TIMEOUT_MS + 100);

      expect(cb.getState()).toBe('released');
    });
  });

  describe('notification to requesting agent (Req 17.5)', () => {
    it('should notify with violated resource and cap value on resource exceeded', async () => {
      const notify = vi.fn<[CircuitBreakerNotification], void>();
      const callbacks = createCallbacks({ notify });
      const cb = new CircuitBreaker('test-notify', createDefaultLimits({ cpu_time_seconds: 30 }), callbacks);
      cb.start();

      cb.checkResourceUsage(createUsage({ cpu_time_seconds: 35 }));

      await vi.advanceTimersByTimeAsync(100);

      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({
          instanceId: 'test-notify',
          reason: 'resource_exceeded',
          violation: expect.objectContaining({
            resource: 'cpu_time',
            actualValue: 35,
            capValue: 30,
          }),
          forceKilled: false,
        })
      );
    });

    it('should notify with TTL reason on TTL expiry', async () => {
      const notify = vi.fn<[CircuitBreakerNotification], void>();
      const callbacks = createCallbacks({ notify });
      const cb = new CircuitBreaker('test-ttl-notify', createDefaultLimits({ ttl_seconds: 5 }), callbacks);
      cb.start();

      // Advance past TTL
      await vi.advanceTimersByTimeAsync(5_000 + 100);

      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({
          instanceId: 'test-ttl-notify',
          reason: 'ttl_expired',
          violation: expect.objectContaining({
            resource: 'ttl',
            capValue: 5,
          }),
        })
      );
    });

    it('should include forceKilled=true when termination was stuck', async () => {
      const terminate = vi.fn(() => new Promise<boolean>((resolve) => {
        setTimeout(() => resolve(true), 8000);
      }));
      const forceKill = vi.fn(async () => {});
      const notify = vi.fn<[CircuitBreakerNotification], void>();
      const releaseResources = vi.fn(async () => {});
      const callbacks = { terminate, forceKill, releaseResources, notify };

      const cb = new CircuitBreaker('test-fk-notify', createDefaultLimits({ memory_mb: 256 }), callbacks);
      cb.start();

      cb.checkResourceUsage(createUsage({ memory_peak_mb: 300 }));

      // Advance past termination timeout and release
      await vi.advanceTimersByTimeAsync(TERMINATION_TIMEOUT_MS + 1000);

      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({
          forceKilled: true,
          violation: expect.objectContaining({
            resource: 'memory',
          }),
        })
      );
    });

    it('should include releaseTimeMs in notification', async () => {
      const notify = vi.fn<[CircuitBreakerNotification], void>();
      const callbacks = createCallbacks({ notify });
      const cb = new CircuitBreaker('test-time', createDefaultLimits({ disk_io_mb: 100 }), callbacks);
      cb.start();

      cb.checkResourceUsage(createUsage({ disk_io_mb: 150 }));

      await vi.advanceTimersByTimeAsync(100);

      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({
          releaseTimeMs: expect.any(Number),
        })
      );
      const notification = notify.mock.calls[0][0];
      expect(notification.releaseTimeMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('state management', () => {
    it('should start in running state', () => {
      const callbacks = createCallbacks();
      const cb = new CircuitBreaker('test-state', createDefaultLimits(), callbacks);
      expect(cb.getState()).toBe('running');
    });

    it('should transition to released on stop()', () => {
      const callbacks = createCallbacks();
      const cb = new CircuitBreaker('test-state', createDefaultLimits(), callbacks);
      cb.start();
      cb.stop();
      expect(cb.getState()).toBe('released');
    });

    it('should return instance ID', () => {
      const callbacks = createCallbacks();
      const cb = new CircuitBreaker('my-instance-123', createDefaultLimits(), callbacks);
      expect(cb.getInstanceId()).toBe('my-instance-123');
    });

    it('should track elapsed time', () => {
      const callbacks = createCallbacks();
      const cb = new CircuitBreaker('test-elapsed', createDefaultLimits(), callbacks);
      cb.start();

      vi.advanceTimersByTime(5000);
      expect(cb.getElapsedMs()).toBeGreaterThanOrEqual(5000);
      cb.stop();
    });
  });

  describe('priority checking order', () => {
    it('should check CPU time before memory before disk I/O', () => {
      const callbacks = createCallbacks();
      const cb = new CircuitBreaker(
        'test-priority',
        createDefaultLimits({ cpu_time_seconds: 10, memory_mb: 100, disk_io_mb: 50 }),
        callbacks
      );
      cb.start();

      // All exceeded at once — CPU time should be reported first
      const violation = cb.checkResourceUsage(createUsage({
        cpu_time_seconds: 15,
        memory_peak_mb: 200,
        disk_io_mb: 100,
      }));

      expect(violation!.resource).toBe('cpu_time');
      cb.stop();
    });
  });
});
