import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  SandboxAgent,
  SandboxCreationError,
  DeviceConfigurationError,
  MAX_VCPUS,
  MAX_MEMORY_MB,
  MAX_STORAGE_MB,
  MAX_EXECUTION_SECONDS,
  MAX_TTL_SECONDS,
  ALLOWED_VIRTIO_DEVICES,
  CLEANUP_TIMEOUT_MS,
  FORCE_KILL_TIMEOUT_MS,
  type FirecrackerApiClient,
  type NetworkManager,
  type BlockDeviceManager,
  type TapSubnetAllocation,
  type MachineConfig,
  type DriveConfig,
  type NetworkConfig,
  type VmAction,
} from '../../src/sandbox/sandbox-agent.js';
import type { ExecutionRequest, ResourceLimits, OapPassport } from '../../src/types/sandbox.js';
import {
  validateOperation,
  enforcePassport,
  OapPassportSession,
} from '../../src/sandbox/oap-passport.js';
import {
  CircuitBreaker,
  TERMINATION_TIMEOUT_MS,
  RESOURCE_RELEASE_TIMEOUT_MS,
} from '../../src/sandbox/circuit-breaker.js';
import {
  SnapshotPool,
  COLD_START_TIMEOUT_MS,
  TARGET_MEDIAN_RESTORE_MS,
  TARGET_P99_RESTORE_MS,
  type CowMapper,
  type ColdStarter,
  type SnapshotEntry,
} from '../../src/sandbox/snapshot-pool.js';

/**
 * Creates a mock Firecracker API client with all methods stubbed.
 */
function createMockApiClient(overrides?: Partial<FirecrackerApiClient>): FirecrackerApiClient {
  return {
    isAvailable: vi.fn().mockResolvedValue(true),
    putMachineConfig: vi.fn().mockResolvedValue(undefined),
    putDrive: vi.fn().mockResolvedValue(undefined),
    putNetworkInterface: vi.fn().mockResolvedValue(undefined),
    putAction: vi.fn().mockResolvedValue(undefined),
    sendCtrlAltDel: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

/**
 * Creates a mock network manager.
 */
function createMockNetworkManager(overrides?: Partial<NetworkManager>): NetworkManager {
  return {
    allocateSubnet: vi.fn().mockResolvedValue({
      tapDevice: 'tap0',
      guestIp: '10.0.0.2',
      hostIp: '10.0.0.1',
      subnetMask: '255.255.255.252',
    } satisfies TapSubnetAllocation),
    applyIptablesRules: vi.fn().mockResolvedValue(undefined),
    releaseSubnet: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

/**
 * Creates a mock block device manager.
 */
function createMockBlockDeviceManager(overrides?: Partial<BlockDeviceManager>): BlockDeviceManager {
  return {
    createImage: vi.fn().mockResolvedValue('/var/lib/firecracker/images/test.ext4'),
    removeImage: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

/**
 * Creates a valid execution request for testing.
 */
function createValidRequest(overrides?: Partial<ExecutionRequest>): ExecutionRequest {
  return {
    code: 'console.log("hello")',
    runtime: 'node18',
    oap_passport: {
      agent_id: 'test-agent',
      permitted_operations: ['execute', 'read_fs'],
      issued_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 300000).toISOString(),
    },
    resource_limits: {
      vcpus: 1,
      memory_mb: 256,
      disk_mb: 1024,
      ttl_seconds: 60,
      cpu_time_seconds: 30,
      disk_io_mb: 100,
    },
    oracles: ['timeout', 'crash'],
    ...overrides,
  };
}

describe('SandboxAgent', () => {
  let apiClient: FirecrackerApiClient;
  let networkManager: NetworkManager;
  let blockDeviceManager: BlockDeviceManager;
  let agent: SandboxAgent;

  beforeEach(() => {
    apiClient = createMockApiClient();
    networkManager = createMockNetworkManager();
    blockDeviceManager = createMockBlockDeviceManager();
    agent = new SandboxAgent(
      { socketBasePath: '/tmp/fc-test' },
      apiClient,
      networkManager,
      blockDeviceManager
    );
  });

  describe('execute', () => {
    it('should execute code successfully when hypervisor is available', async () => {
      const request = createValidRequest();
      const result = await agent.execute(request);

      expect(result.status).toBe('completed');
      expect(result.duration_ms).toBeGreaterThanOrEqual(0);
      expect(result.oracle_violations).toEqual([]);
      expect(result.resource_usage).toBeDefined();
    });

    it('should return error when hypervisor is unavailable (never fall back)', async () => {
      apiClient = createMockApiClient({
        isAvailable: vi.fn().mockResolvedValue(false),
      });
      agent = new SandboxAgent({}, apiClient, networkManager, blockDeviceManager);

      const request = createValidRequest();
      const result = await agent.execute(request);

      expect(result.status).toBe('error');
      expect(result.output).toEqual({
        error: expect.stringContaining('unavailable'),
      });
      // Verify code was NEVER executed outside of isolation
      expect(apiClient.putMachineConfig).not.toHaveBeenCalled();
    });

    it('should never fall back to non-isolated execution on VM creation failure', async () => {
      apiClient = createMockApiClient({
        putMachineConfig: vi.fn().mockRejectedValue(
          new SandboxCreationError('KVM not available', 'hypervisor_unavailable')
        ),
      });
      agent = new SandboxAgent({}, apiClient, networkManager, blockDeviceManager);

      const request = createValidRequest();
      const result = await agent.execute(request);

      expect(result.status).toBe('error');
      expect(result.output).toEqual({
        error: expect.stringContaining('Failed to configure/start Firecracker VM'),
      });
    });

    it('should call Firecracker REST API with correct machine config', async () => {
      const request = createValidRequest({
        resource_limits: {
          vcpus: 2,
          memory_mb: 512,
          disk_mb: 5000,
          ttl_seconds: 120,
          cpu_time_seconds: 60,
          disk_io_mb: 200,
        },
      });

      await agent.execute(request);

      expect(apiClient.putMachineConfig).toHaveBeenCalledWith(
        expect.stringContaining('.sock'),
        {
          vcpu_count: 2,
          mem_size_mib: 512,
          ht_enabled: false,
        }
      );
    });

    it('should configure virtio block and network devices only', async () => {
      const request = createValidRequest();
      await agent.execute(request);

      // Verify block device was configured
      expect(apiClient.putDrive).toHaveBeenCalledWith(
        expect.any(String),
        'rootfs',
        expect.objectContaining({
          drive_id: 'rootfs',
          is_root_device: true,
        })
      );

      // Verify network interface was configured
      expect(apiClient.putNetworkInterface).toHaveBeenCalledWith(
        expect.any(String),
        'eth0',
        expect.objectContaining({
          iface_id: 'eth0',
          host_dev_name: 'tap0',
        })
      );
    });

    it('should allocate isolated /30 TAP subnet with iptables rules', async () => {
      const request = createValidRequest();
      await agent.execute(request);

      expect(networkManager.allocateSubnet).toHaveBeenCalled();
      expect(networkManager.applyIptablesRules).toHaveBeenCalledWith({
        tapDevice: 'tap0',
        guestIp: '10.0.0.2',
        hostIp: '10.0.0.1',
        subnetMask: '255.255.255.252',
      });
    });

    it('should release all resources after execution completes', async () => {
      const request = createValidRequest();
      await agent.execute(request);

      expect(networkManager.releaseSubnet).toHaveBeenCalled();
      expect(blockDeviceManager.removeImage).toHaveBeenCalled();
      expect(apiClient.sendCtrlAltDel).toHaveBeenCalled();
    });

    it('should release resources even when execution throws', async () => {
      apiClient = createMockApiClient({
        putAction: vi.fn()
          .mockResolvedValueOnce(undefined) // InstanceStart succeeds
          .mockRejectedValueOnce(new Error('VM crashed')),
      });
      agent = new SandboxAgent({}, apiClient, networkManager, blockDeviceManager);

      const request = createValidRequest();
      await agent.execute(request);

      // Resources should still be released
      expect(networkManager.releaseSubnet).toHaveBeenCalled();
      expect(blockDeviceManager.removeImage).toHaveBeenCalled();
    });

    it('should return error when TAP subnet allocation fails', async () => {
      networkManager = createMockNetworkManager({
        allocateSubnet: vi.fn().mockRejectedValue(new Error('No TAP devices available')),
      });
      agent = new SandboxAgent({}, apiClient, networkManager, blockDeviceManager);

      const request = createValidRequest();
      const result = await agent.execute(request);

      expect(result.status).toBe('error');
      expect(result.output).toEqual({
        error: expect.stringContaining('Failed to allocate TAP subnet'),
      });
    });

    it('should return error when block device creation fails', async () => {
      blockDeviceManager = createMockBlockDeviceManager({
        createImage: vi.fn().mockRejectedValue(new Error('Disk full')),
      });
      agent = new SandboxAgent({}, apiClient, networkManager, blockDeviceManager);

      const request = createValidRequest();
      const result = await agent.execute(request);

      expect(result.status).toBe('error');
      expect(result.output).toEqual({
        error: expect.stringContaining('Failed to create block device'),
      });
    });

    it('should clean up subnet when iptables rules fail', async () => {
      networkManager = createMockNetworkManager({
        applyIptablesRules: vi.fn().mockRejectedValue(new Error('iptables error')),
      });
      agent = new SandboxAgent({}, apiClient, networkManager, blockDeviceManager);

      const request = createValidRequest();
      await agent.execute(request);

      // releaseSubnet should be called during error handling
      expect(networkManager.releaseSubnet).toHaveBeenCalled();
    });

    it('should start the VM instance after configuration', async () => {
      const request = createValidRequest();
      await agent.execute(request);

      expect(apiClient.putAction).toHaveBeenCalledWith(
        expect.any(String),
        { action_type: 'InstanceStart' }
      );
    });
  });

  describe('clampResourceLimits', () => {
    it('should clamp vCPUs to maximum of 2', () => {
      const limits: ResourceLimits = {
        vcpus: 8,
        memory_mb: 256,
        disk_mb: 1024,
        ttl_seconds: 60,
        cpu_time_seconds: 30,
        disk_io_mb: 100,
      };

      const clamped = agent.clampResourceLimits(limits);
      expect(clamped.vcpus).toBe(MAX_VCPUS);
    });

    it('should clamp memory to maximum of 512 MB', () => {
      const limits: ResourceLimits = {
        vcpus: 1,
        memory_mb: 4096,
        disk_mb: 1024,
        ttl_seconds: 60,
        cpu_time_seconds: 30,
        disk_io_mb: 100,
      };

      const clamped = agent.clampResourceLimits(limits);
      expect(clamped.memory_mb).toBe(MAX_MEMORY_MB);
    });

    it('should clamp storage to maximum of 10 GB (10240 MB)', () => {
      const limits: ResourceLimits = {
        vcpus: 1,
        memory_mb: 256,
        disk_mb: 50000,
        ttl_seconds: 60,
        cpu_time_seconds: 30,
        disk_io_mb: 100,
      };

      const clamped = agent.clampResourceLimits(limits);
      expect(clamped.disk_mb).toBe(MAX_STORAGE_MB);
    });

    it('should clamp execution time to maximum of 300 seconds', () => {
      const limits: ResourceLimits = {
        vcpus: 1,
        memory_mb: 256,
        disk_mb: 1024,
        ttl_seconds: 60,
        cpu_time_seconds: 1000,
        disk_io_mb: 100,
      };

      const clamped = agent.clampResourceLimits(limits);
      expect(clamped.cpu_time_seconds).toBe(MAX_EXECUTION_SECONDS);
    });

    it('should clamp TTL to maximum of 600 seconds', () => {
      const limits: ResourceLimits = {
        vcpus: 1,
        memory_mb: 256,
        disk_mb: 1024,
        ttl_seconds: 9999,
        cpu_time_seconds: 30,
        disk_io_mb: 100,
      };

      const clamped = agent.clampResourceLimits(limits);
      expect(clamped.ttl_seconds).toBe(MAX_TTL_SECONDS);
    });

    it('should enforce minimum of 1 for all values', () => {
      const limits: ResourceLimits = {
        vcpus: 0,
        memory_mb: 0,
        disk_mb: 0,
        ttl_seconds: 0,
        cpu_time_seconds: 0,
        disk_io_mb: -5,
      };

      const clamped = agent.clampResourceLimits(limits);
      expect(clamped.vcpus).toBe(1);
      expect(clamped.memory_mb).toBe(1);
      expect(clamped.disk_mb).toBe(1);
      expect(clamped.ttl_seconds).toBe(1);
      expect(clamped.cpu_time_seconds).toBe(1);
    });

    it('should pass through values within allowed range', () => {
      const limits: ResourceLimits = {
        vcpus: 2,
        memory_mb: 512,
        disk_mb: 5000,
        ttl_seconds: 300,
        cpu_time_seconds: 150,
        disk_io_mb: 500,
      };

      const clamped = agent.clampResourceLimits(limits);
      expect(clamped.vcpus).toBe(2);
      expect(clamped.memory_mb).toBe(512);
      expect(clamped.disk_mb).toBe(5000);
      expect(clamped.ttl_seconds).toBe(300);
      expect(clamped.cpu_time_seconds).toBe(150);
    });
  });

  describe('validateDeviceConfiguration', () => {
    it('should accept block and network devices', () => {
      expect(() => agent.validateDeviceConfiguration(['block', 'network'])).not.toThrow();
    });

    it('should accept block device alone', () => {
      expect(() => agent.validateDeviceConfiguration(['block'])).not.toThrow();
    });

    it('should accept network device alone', () => {
      expect(() => agent.validateDeviceConfiguration(['network'])).not.toThrow();
    });

    it('should reject vsock device', () => {
      expect(() => agent.validateDeviceConfiguration(['block', 'vsock'])).toThrow(
        DeviceConfigurationError
      );
    });

    it('should reject balloon device', () => {
      expect(() => agent.validateDeviceConfiguration(['balloon'])).toThrow(
        DeviceConfigurationError
      );
    });

    it('should reject any unknown device type', () => {
      expect(() => agent.validateDeviceConfiguration(['gpu'])).toThrow(DeviceConfigurationError);
    });

    it('should include rejected device name in error', () => {
      try {
        agent.validateDeviceConfiguration(['serial']);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(DeviceConfigurationError);
        expect((err as DeviceConfigurationError).rejectedDevice).toBe('serial');
      }
    });

    it('should accept empty device list', () => {
      expect(() => agent.validateDeviceConfiguration([])).not.toThrow();
    });
  });

  describe('resource cleanup and termination', () => {
    it('should release TAP subnet on cleanup', async () => {
      const request = createValidRequest();
      await agent.execute(request);

      expect(networkManager.releaseSubnet).toHaveBeenCalledWith(
        expect.objectContaining({
          tapDevice: 'tap0',
        })
      );
    });

    it('should release block device on cleanup', async () => {
      const request = createValidRequest();
      await agent.execute(request);

      expect(blockDeviceManager.removeImage).toHaveBeenCalledWith(
        '/var/lib/firecracker/images/test.ext4'
      );
    });

    it('should send shutdown signal before cleanup', async () => {
      const request = createValidRequest();
      await agent.execute(request);

      expect(apiClient.sendCtrlAltDel).toHaveBeenCalled();
    });

    it('should still clean up when shutdown signal fails', async () => {
      apiClient = createMockApiClient({
        sendCtrlAltDel: vi.fn().mockRejectedValue(new Error('VM already dead')),
      });
      agent = new SandboxAgent({}, apiClient, networkManager, blockDeviceManager);

      const request = createValidRequest();
      await agent.execute(request);

      // Cleanup should still proceed
      expect(networkManager.releaseSubnet).toHaveBeenCalled();
      expect(blockDeviceManager.removeImage).toHaveBeenCalled();
    });

    it('should have no active instances after execution completes', async () => {
      const request = createValidRequest();
      await agent.execute(request);

      expect(agent.getActiveInstanceCount()).toBe(0);
    });
  });

  describe('no fallback to non-isolated execution', () => {
    it('should return error status when hypervisor is unavailable', async () => {
      apiClient = createMockApiClient({
        isAvailable: vi.fn().mockResolvedValue(false),
      });
      agent = new SandboxAgent({}, apiClient, networkManager, blockDeviceManager);

      const result = await agent.execute(createValidRequest());

      expect(result.status).toBe('error');
      // No execution should have happened
      expect(apiClient.putAction).not.toHaveBeenCalled();
    });

    it('should return error when socket communication fails', async () => {
      apiClient = createMockApiClient({
        putMachineConfig: vi.fn().mockRejectedValue(new Error('ENOENT: socket not found')),
      });
      agent = new SandboxAgent({}, apiClient, networkManager, blockDeviceManager);

      const result = await agent.execute(createValidRequest());

      expect(result.status).toBe('error');
    });

    it('should never return completed status when VM creation fails', async () => {
      apiClient = createMockApiClient({
        putAction: vi.fn().mockRejectedValue(new Error('InstanceStart failed')),
      });
      agent = new SandboxAgent({}, apiClient, networkManager, blockDeviceManager);

      const result = await agent.execute(createValidRequest());

      expect(result.status).not.toBe('completed');
    });
  });

  describe('error types', () => {
    it('SandboxCreationError should have correct properties', () => {
      const err = new SandboxCreationError('test error', 'hypervisor_unavailable');
      expect(err.name).toBe('SandboxCreationError');
      expect(err.message).toBe('test error');
      expect(err.reason).toBe('hypervisor_unavailable');
      expect(err).toBeInstanceOf(Error);
    });

    it('DeviceConfigurationError should have correct properties', () => {
      const err = new DeviceConfigurationError('bad device', 'gpu');
      expect(err.name).toBe('DeviceConfigurationError');
      expect(err.message).toBe('bad device');
      expect(err.rejectedDevice).toBe('gpu');
      expect(err).toBeInstanceOf(Error);
    });
  });

  describe('constants', () => {
    it('should have correct maximum resource limits', () => {
      expect(MAX_VCPUS).toBe(2);
      expect(MAX_MEMORY_MB).toBe(512);
      expect(MAX_STORAGE_MB).toBe(10240);
      expect(MAX_EXECUTION_SECONDS).toBe(300);
      expect(MAX_TTL_SECONDS).toBe(600);
    });

    it('should only allow block and network virtio devices', () => {
      expect(ALLOWED_VIRTIO_DEVICES).toContain('block');
      expect(ALLOWED_VIRTIO_DEVICES).toContain('network');
      expect(ALLOWED_VIRTIO_DEVICES).toHaveLength(2);
    });

    it('should have cleanup timeout of 5000ms', () => {
      expect(CLEANUP_TIMEOUT_MS).toBe(5000);
    });
  });
});


describe('SandboxAgent - OAP Passport Rejection (Req 15.4)', () => {
  it('should reject operations not listed in the OAP Passport', () => {
    const passport: OapPassport = {
      agent_id: 'repair-agent',
      permitted_operations: ['execute', 'read_fs'],
      issued_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 300_000).toISOString(),
    };

    const result = validateOperation(passport, 'write_fs');
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.rejection.code).toBe('OPERATION_NOT_PERMITTED');
      expect(result.rejection.operation).toBe('write_fs');
      expect(result.rejection.agent_id).toBe('repair-agent');
      expect(result.rejection.permitted_operations).toEqual(['execute', 'read_fs']);
    }
  });

  it('should reject operations when passport is expired', () => {
    const passport: OapPassport = {
      agent_id: 'test-agent',
      permitted_operations: ['execute', 'read_fs', 'write_fs'],
      issued_at: new Date(Date.now() - 7200_000).toISOString(),
      expires_at: new Date(Date.now() - 3600_000).toISOString(), // expired 1 hour ago
    };

    const result = validateOperation(passport, 'execute');
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.rejection.message).toContain('expired');
    }
  });

  it('should allow operations explicitly listed in the passport', () => {
    const passport: OapPassport = {
      agent_id: 'sandbox-agent',
      permitted_operations: ['execute', 'read_fs', 'network_access'],
      issued_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 300_000).toISOString(),
    };

    expect(validateOperation(passport, 'execute').allowed).toBe(true);
    expect(validateOperation(passport, 'read_fs').allowed).toBe(true);
    expect(validateOperation(passport, 'network_access').allowed).toBe(true);
  });

  it('should throw structured rejection when enforcePassport is called with non-permitted op', () => {
    const passport: OapPassport = {
      agent_id: 'agent-x',
      permitted_operations: ['read'],
      issued_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 300_000).toISOString(),
    };

    expect(() => enforcePassport(passport, 'read')).not.toThrow();
    expect(() => enforcePassport(passport, 'delete')).toThrow();

    try {
      enforcePassport(passport, 'write');
    } catch (err: any) {
      expect(err.code).toBe('OPERATION_NOT_PERMITTED');
      expect(err.agent_id).toBe('agent-x');
      expect(err.operation).toBe('write');
    }
  });

  it('should use OapPassportSession for permission checks within sandbox', () => {
    const passport: OapPassport = {
      agent_id: 'session-agent',
      permitted_operations: ['execute', 'read_fs'],
      issued_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 300_000).toISOString(),
    };

    const session = new OapPassportSession(passport);
    expect(session.isOperationPermitted('execute')).toBe(true);
    expect(session.isOperationPermitted('write_fs')).toBe(false);
    expect(session.isOperationPermitted('delete')).toBe(false);
  });
});

describe('SandboxAgent - Snapshot Restore Timing (Req 16.1–16.5)', () => {
  it('should define correct target latency constants', () => {
    expect(TARGET_MEDIAN_RESTORE_MS).toBe(150);
    expect(TARGET_P99_RESTORE_MS).toBe(500);
    expect(COLD_START_TIMEOUT_MS).toBe(5000);
  });

  it('should restore from snapshot via CoW mapping and track latency', async () => {
    const mockInstance = {
      id: 'restored-vm-1',
      socketPath: '/tmp/restored.sock',
      tapDevice: 'tap0',
      subnet: '10.0.0.2/30',
      blockDevice: '/images/restored.ext4',
      startedAt: Date.now(),
      resourceLimits: { vcpus: 1, memory_mb: 256, disk_mb: 1024, ttl_seconds: 60, cpu_time_seconds: 30, disk_io_mb: 100 },
      terminated: false,
    };

    const cowMapper: CowMapper = {
      restoreFromSnapshot: vi.fn().mockResolvedValue(mockInstance),
    };
    const coldStarter: ColdStarter = {
      coldStart: vi.fn().mockResolvedValue(mockInstance),
    };

    const pool = new SnapshotPool(
      { runtimes: ['node18'], snapshotDir: '/tmp/snapshots' },
      cowMapper,
      coldStarter
    );

    // Add a pre-warmed snapshot
    pool.addSnapshot({
      id: 'snap-1',
      runtime: 'node18',
      memorySnapshotPath: '/tmp/snapshots/node18/snap-1.mem',
      vmStatePath: '/tmp/snapshots/node18/snap-1.state',
      createdAt: Date.now(),
    });

    const instance = await pool.restoreSnapshot('node18');
    expect(instance).toBe(mockInstance);
    expect(cowMapper.restoreFromSnapshot).toHaveBeenCalled();

    // Verify latency is tracked
    const stats = pool.getRestoreLatencyStats();
    expect(stats.totalRestores).toBe(1);
    expect(stats.median).toBeGreaterThanOrEqual(0);
  });

  it('should fall back to cold-start within 5s when CoW mapping fails (Req 16.4)', async () => {
    const mockInstance = {
      id: 'cold-start-vm',
      socketPath: '/tmp/cold.sock',
      tapDevice: 'tap1',
      subnet: '10.0.0.6/30',
      blockDevice: '/images/cold.ext4',
      startedAt: Date.now(),
      resourceLimits: { vcpus: 1, memory_mb: 256, disk_mb: 1024, ttl_seconds: 60, cpu_time_seconds: 30, disk_io_mb: 100 },
      terminated: false,
    };

    const cowMapper: CowMapper = {
      restoreFromSnapshot: vi.fn().mockRejectedValue(new Error('CoW mapping failed: corrupted snapshot')),
    };
    const coldStarter: ColdStarter = {
      coldStart: vi.fn().mockResolvedValue(mockInstance),
    };

    const pool = new SnapshotPool(
      { runtimes: ['node18'], snapshotDir: '/tmp/snapshots' },
      cowMapper,
      coldStarter
    );

    // Add a snapshot that will fail CoW restore
    pool.addSnapshot({
      id: 'bad-snap',
      runtime: 'node18',
      memorySnapshotPath: '/tmp/snapshots/node18/bad.mem',
      vmStatePath: '/tmp/snapshots/node18/bad.state',
      createdAt: Date.now(),
    });

    const instance = await pool.restoreSnapshot('node18');
    expect(instance).toBe(mockInstance);
    expect(cowMapper.restoreFromSnapshot).toHaveBeenCalled();
    expect(coldStarter.coldStart).toHaveBeenCalledWith('node18', COLD_START_TIMEOUT_MS);

    // Verify failure is recorded in history
    const history = pool.getRestoreHistory();
    const cowFailure = history.find(e => e.method === 'cow' && !e.success);
    expect(cowFailure).toBeDefined();
  });

  it('should cold-start when no snapshot is available and trigger replenishment (Req 16.5)', async () => {
    const mockInstance = {
      id: 'cold-start-no-snap',
      socketPath: '/tmp/cold2.sock',
      tapDevice: 'tap2',
      subnet: '10.0.0.10/30',
      blockDevice: '/images/cold2.ext4',
      startedAt: Date.now(),
      resourceLimits: { vcpus: 1, memory_mb: 256, disk_mb: 1024, ttl_seconds: 60, cpu_time_seconds: 30, disk_io_mb: 100 },
      terminated: false,
    };

    const cowMapper: CowMapper = {
      restoreFromSnapshot: vi.fn(),
    };
    const coldStarter: ColdStarter = {
      coldStart: vi.fn().mockResolvedValue(mockInstance),
    };

    const pool = new SnapshotPool(
      { runtimes: ['python3'], snapshotDir: '/tmp/snapshots' },
      cowMapper,
      coldStarter
    );

    // Pool is empty — no snapshots available
    expect(pool.getPoolSize('python3')).toBe(0);

    const instance = await pool.restoreSnapshot('python3');
    expect(instance).toBe(mockInstance);

    // CoW should NOT have been called (no snapshot to restore from)
    expect(cowMapper.restoreFromSnapshot).not.toHaveBeenCalled();
    // Cold start should have been called
    expect(coldStarter.coldStart).toHaveBeenCalled();
  });

  it('should maintain minimum pool size of 2 per runtime (Req 16.1)', async () => {
    const cowMapper: CowMapper = {
      restoreFromSnapshot: vi.fn(),
    };
    const coldStarter: ColdStarter = {
      coldStart: vi.fn(),
    };

    const pool = new SnapshotPool(
      { runtimes: ['node18', 'python3'], snapshotDir: '/tmp/snapshots', minPoolSize: 2 },
      cowMapper,
      coldStarter
    );

    await pool.initialize();

    // After initialization, each runtime should have at least 2 snapshots
    expect(pool.getPoolSize('node18')).toBeGreaterThanOrEqual(2);
    expect(pool.getPoolSize('python3')).toBeGreaterThanOrEqual(2);
    expect(pool.isPoolHealthy()).toBe(true);
  });
});

describe('SandboxAgent - Circuit Breaker Trigger (Req 17.1–17.4)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should terminate VM when CPU time cap is exceeded', () => {
    const notify = vi.fn();
    const callbacks = {
      terminate: vi.fn(async () => true),
      forceKill: vi.fn(async () => {}),
      releaseResources: vi.fn(async () => {}),
      notify,
    };

    const cb = new CircuitBreaker('vm-cpu-test', {
      vcpus: 2,
      memory_mb: 512,
      disk_mb: 1024,
      ttl_seconds: 300,
      cpu_time_seconds: 60,
      disk_io_mb: 256,
    }, callbacks);
    cb.start();

    const violation = cb.checkResourceUsage({
      cpu_time_seconds: 65,
      memory_peak_mb: 100,
      disk_io_mb: 50,
      wall_time_ms: 65000,
    });

    expect(violation).not.toBeNull();
    expect(violation!.resource).toBe('cpu_time');
    expect(violation!.actualValue).toBe(65);
    expect(violation!.capValue).toBe(60);
    expect(cb.getState()).toBe('terminated');
  });

  it('should terminate VM when memory cap is exceeded', () => {
    const callbacks = {
      terminate: vi.fn(async () => true),
      forceKill: vi.fn(async () => {}),
      releaseResources: vi.fn(async () => {}),
      notify: vi.fn(),
    };

    const cb = new CircuitBreaker('vm-mem-test', {
      vcpus: 2,
      memory_mb: 512,
      disk_mb: 1024,
      ttl_seconds: 300,
      cpu_time_seconds: 300,
      disk_io_mb: 256,
    }, callbacks);
    cb.start();

    const violation = cb.checkResourceUsage({
      cpu_time_seconds: 10,
      memory_peak_mb: 600,
      disk_io_mb: 50,
      wall_time_ms: 10000,
    });

    expect(violation).not.toBeNull();
    expect(violation!.resource).toBe('memory');
    expect(violation!.actualValue).toBe(600);
    expect(violation!.capValue).toBe(512);
  });

  it('should terminate VM and notify requesting agent on TTL expiry (Req 17.3)', async () => {
    const notify = vi.fn();
    const callbacks = {
      terminate: vi.fn(async () => true),
      forceKill: vi.fn(async () => {}),
      releaseResources: vi.fn(async () => {}),
      notify,
    };

    const cb = new CircuitBreaker('vm-ttl-test', {
      vcpus: 2,
      memory_mb: 512,
      disk_mb: 1024,
      ttl_seconds: 10,
      cpu_time_seconds: 300,
      disk_io_mb: 256,
    }, callbacks);
    cb.start();

    // Advance past TTL
    await vi.advanceTimersByTimeAsync(10_000 + 100);

    expect(cb.getState()).not.toBe('running');
    expect(cb.getViolation()).not.toBeNull();
    expect(cb.getViolation()!.resource).toBe('ttl');
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        instanceId: 'vm-ttl-test',
        reason: 'ttl_expired',
      })
    );
  });

  it('should record violation with resource type and value at time of violation (Req 17.4)', () => {
    const callbacks = {
      terminate: vi.fn(async () => true),
      forceKill: vi.fn(async () => {}),
      releaseResources: vi.fn(async () => {}),
      notify: vi.fn(),
    };

    const cb = new CircuitBreaker('vm-record', {
      vcpus: 2,
      memory_mb: 512,
      disk_mb: 1024,
      ttl_seconds: 300,
      cpu_time_seconds: 100,
      disk_io_mb: 200,
    }, callbacks);
    cb.start();

    cb.checkResourceUsage({
      cpu_time_seconds: 50,
      memory_peak_mb: 100,
      disk_io_mb: 250, // exceeds 200 cap
      wall_time_ms: 50000,
    });

    const violation = cb.getViolation();
    expect(violation).not.toBeNull();
    expect(violation!.resource).toBe('disk_io');
    expect(violation!.actualValue).toBe(250);
    expect(violation!.capValue).toBe(200);
    expect(violation!.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe('SandboxAgent - Force-Kill Escalation (Req 17.6)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should force-kill at hypervisor level if termination stuck >5s', async () => {
    // Terminate callback that never resolves within 5s
    const terminate = vi.fn(() => new Promise<boolean>((resolve) => {
      setTimeout(() => resolve(true), 8000); // Takes 8s
    }));
    const forceKill = vi.fn(async () => {});
    const releaseResources = vi.fn(async () => {});
    const notify = vi.fn();

    const cb = new CircuitBreaker('vm-force-kill', {
      vcpus: 2,
      memory_mb: 512,
      disk_mb: 1024,
      ttl_seconds: 300,
      cpu_time_seconds: 50,
      disk_io_mb: 256,
    }, { terminate, forceKill, releaseResources, notify });
    cb.start();

    // Trigger circuit breaker
    cb.checkResourceUsage({
      cpu_time_seconds: 55,
      memory_peak_mb: 100,
      disk_io_mb: 50,
      wall_time_ms: 55000,
    });

    // Advance past the TERMINATION_TIMEOUT_MS (5000ms)
    await vi.advanceTimersByTimeAsync(TERMINATION_TIMEOUT_MS + 500);

    expect(forceKill).toHaveBeenCalledWith('vm-force-kill');
    expect(cb.wasForceKilled()).toBe(true);
  });

  it('should NOT force-kill if termination completes within 5s', async () => {
    // Terminate callback resolves quickly
    const terminate = vi.fn(async () => true);
    const forceKill = vi.fn(async () => {});
    const releaseResources = vi.fn(async () => {});
    const notify = vi.fn();

    const cb = new CircuitBreaker('vm-no-force', {
      vcpus: 2,
      memory_mb: 512,
      disk_mb: 1024,
      ttl_seconds: 300,
      cpu_time_seconds: 50,
      disk_io_mb: 256,
    }, { terminate, forceKill, releaseResources, notify });
    cb.start();

    cb.checkResourceUsage({
      cpu_time_seconds: 55,
      memory_peak_mb: 100,
      disk_io_mb: 50,
      wall_time_ms: 55000,
    });

    // Allow immediate resolution
    await vi.advanceTimersByTimeAsync(100);

    expect(terminate).toHaveBeenCalledWith('vm-no-force');
    expect(forceKill).not.toHaveBeenCalled();
    expect(cb.wasForceKilled()).toBe(false);
  });

  it('should force-kill when terminate callback rejects', async () => {
    const terminate = vi.fn(async () => { throw new Error('Cannot terminate'); });
    const forceKill = vi.fn(async () => {});
    const releaseResources = vi.fn(async () => {});
    const notify = vi.fn();

    const cb = new CircuitBreaker('vm-reject', {
      vcpus: 2,
      memory_mb: 512,
      disk_mb: 1024,
      ttl_seconds: 300,
      cpu_time_seconds: 50,
      disk_io_mb: 256,
    }, { terminate, forceKill, releaseResources, notify });
    cb.start();

    cb.checkResourceUsage({
      cpu_time_seconds: 55,
      memory_peak_mb: 100,
      disk_io_mb: 50,
      wall_time_ms: 55000,
    });

    await vi.advanceTimersByTimeAsync(100);

    // Terminate failed, so force-kill should be called
    expect(forceKill).toHaveBeenCalledWith('vm-reject');
    expect(cb.wasForceKilled()).toBe(true);
  });

  it('should include forceKilled=true in notification when force-kill occurs', async () => {
    const terminate = vi.fn(() => new Promise<boolean>((resolve) => {
      setTimeout(() => resolve(true), 8000);
    }));
    const forceKill = vi.fn(async () => {});
    const releaseResources = vi.fn(async () => {});
    const notify = vi.fn();

    const cb = new CircuitBreaker('vm-fk-notify', {
      vcpus: 2,
      memory_mb: 512,
      disk_mb: 1024,
      ttl_seconds: 300,
      cpu_time_seconds: 50,
      disk_io_mb: 256,
    }, { terminate, forceKill, releaseResources, notify });
    cb.start();

    cb.checkResourceUsage({
      cpu_time_seconds: 55,
      memory_peak_mb: 100,
      disk_io_mb: 50,
      wall_time_ms: 55000,
    });

    await vi.advanceTimersByTimeAsync(TERMINATION_TIMEOUT_MS + 1000);

    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        instanceId: 'vm-fk-notify',
        forceKilled: true,
        reason: 'resource_exceeded',
      })
    );
  });
});

describe('SandboxAgent - Resource Cleanup Within 5s/10s (Req 15.7, 17.5)', () => {
  let apiClient: FirecrackerApiClient;
  let networkManager: NetworkManager;
  let blockDeviceManager: BlockDeviceManager;
  let agent: SandboxAgent;

  beforeEach(() => {
    apiClient = createMockApiClient();
    networkManager = createMockNetworkManager();
    blockDeviceManager = createMockBlockDeviceManager();
    agent = new SandboxAgent(
      { socketBasePath: '/tmp/fc-cleanup-test' },
      apiClient,
      networkManager,
      blockDeviceManager
    );
  });

  it('should release TAP subnet, block device, and send shutdown within cleanup (Req 15.7)', async () => {
    const request = createValidRequest();
    await agent.execute(request);

    // All cleanup actions should have been called
    expect(apiClient.sendCtrlAltDel).toHaveBeenCalled();
    expect(networkManager.releaseSubnet).toHaveBeenCalled();
    expect(blockDeviceManager.removeImage).toHaveBeenCalled();
    // No active instances should remain
    expect(agent.getActiveInstanceCount()).toBe(0);
  });

  it('should clean up resources even if VM execution crashes', async () => {
    // Simulate a crash during execution by rejecting putAction on second call
    let callCount = 0;
    apiClient = createMockApiClient({
      putAction: vi.fn(async (_socketPath: string, action: VmAction) => {
        callCount++;
        if (callCount > 1) throw new Error('VM crashed during execution');
      }),
    });
    agent = new SandboxAgent({}, apiClient, networkManager, blockDeviceManager);

    const request = createValidRequest();
    await agent.execute(request);

    // Resources must still be released
    expect(networkManager.releaseSubnet).toHaveBeenCalled();
    expect(blockDeviceManager.removeImage).toHaveBeenCalled();
  });

  it('should have CLEANUP_TIMEOUT_MS set to 5000ms (5s budget)', () => {
    expect(CLEANUP_TIMEOUT_MS).toBe(5000);
  });

  it('should have FORCE_KILL_TIMEOUT_MS set to 5000ms for escalation', () => {
    expect(FORCE_KILL_TIMEOUT_MS).toBe(5000);
  });

  it('should release resources within 10s when circuit breaker triggers (Req 17.5)', async () => {
    vi.useFakeTimers();

    const releaseResources = vi.fn(async () => {});
    const notify = vi.fn();
    const callbacks = {
      terminate: vi.fn(async () => true),
      forceKill: vi.fn(async () => {}),
      releaseResources,
      notify,
    };

    const cb = new CircuitBreaker('vm-cleanup-10s', {
      vcpus: 2,
      memory_mb: 512,
      disk_mb: 1024,
      ttl_seconds: 300,
      cpu_time_seconds: 100,
      disk_io_mb: 256,
    }, callbacks);
    cb.start();

    // Trigger the circuit breaker
    cb.checkResourceUsage({
      cpu_time_seconds: 110,
      memory_peak_mb: 100,
      disk_io_mb: 50,
      wall_time_ms: 110000,
    });

    // Allow async termination and release to complete
    await vi.advanceTimersByTimeAsync(100);

    // Resources should be released
    expect(releaseResources).toHaveBeenCalledWith('vm-cleanup-10s');
    expect(cb.getState()).toBe('released');

    // The notification should include releaseTimeMs within budget
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        releaseTimeMs: expect.any(Number),
      })
    );

    vi.useRealTimers();
  });

  it('should still transition to released state even if resource release exceeds 10s budget', async () => {
    vi.useFakeTimers();

    // Release takes 15 seconds (exceeds 10s budget)
    const releaseResources = vi.fn(() => new Promise<void>((resolve) => {
      setTimeout(resolve, 15_000);
    }));
    const notify = vi.fn();
    const callbacks = {
      terminate: vi.fn(async () => true),
      forceKill: vi.fn(async () => {}),
      releaseResources,
      notify,
    };

    const cb = new CircuitBreaker('vm-slow-release', {
      vcpus: 2,
      memory_mb: 256,
      disk_mb: 1024,
      ttl_seconds: 60,
      cpu_time_seconds: 30,
      disk_io_mb: 128,
    }, callbacks);
    cb.start();

    cb.checkResourceUsage({
      cpu_time_seconds: 35,
      memory_peak_mb: 100,
      disk_io_mb: 50,
      wall_time_ms: 35000,
    });

    // Advance past the RESOURCE_RELEASE_TIMEOUT_MS (10s)
    await vi.advanceTimersByTimeAsync(RESOURCE_RELEASE_TIMEOUT_MS + 500);

    // Should still reach released state despite timeout
    expect(cb.getState()).toBe('released');

    vi.useRealTimers();
  });
});
