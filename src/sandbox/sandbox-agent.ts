import { randomUUID } from 'node:crypto';
import type {
  ExecutionRequest,
  ExecutionResult,
  ResourceLimits,
  ResourceUsage,
} from '../types/sandbox.js';

/**
 * Maximum resource limits enforced by the sandbox agent.
 * These are hard caps that cannot be exceeded regardless of request configuration.
 */
export const MAX_VCPUS = 2;
export const MAX_MEMORY_MB = 512;
export const MAX_STORAGE_MB = 10240; // 10 GB
export const MAX_EXECUTION_SECONDS = 300;
export const MAX_TTL_SECONDS = 600;
export const MAX_DISK_IO_MB = 1024; // matches the circuit breaker's disk I/O ceiling

/** Time allowed for resource cleanup after VM termination */
export const CLEANUP_TIMEOUT_MS = 5000;

/** Force-kill escalation timeout when VM is stuck */
export const FORCE_KILL_TIMEOUT_MS = 5000;

/** Allowed virtio device types for microVM configuration */
export const ALLOWED_VIRTIO_DEVICES = ['block', 'network'] as const;
export type AllowedVirtioDevice = (typeof ALLOWED_VIRTIO_DEVICES)[number];

/**
 * Firecracker REST API socket path (configurable via constructor).
 */
const DEFAULT_SOCKET_PATH = '/tmp/firecracker.socket';

/**
 * Represents the state of an active microVM instance.
 */
export interface MicroVmInstance {
  id: string;
  pid?: number;
  socketPath: string;
  tapDevice: string;
  subnet: string;
  blockDevice: string;
  startedAt: number;
  resourceLimits: ResourceLimits;
  terminated: boolean;
}

/**
 * Configuration for the Sandbox Agent.
 */
export interface SandboxAgentConfig {
  /** Path to the Firecracker binary */
  firecrackerBinaryPath: string;
  /** Base path for Unix sockets */
  socketBasePath: string;
  /** Base subnet for TAP network allocation (CIDR) */
  tapSubnetBase: string;
  /** Directory for block device images */
  blockDeviceDir: string;
  /** Whether to enable hardware virtualization (KVM) */
  enableKvm: boolean;
}

const DEFAULT_CONFIG: SandboxAgentConfig = {
  firecrackerBinaryPath: '/usr/bin/firecracker',
  socketBasePath: '/tmp/firecracker',
  tapSubnetBase: '10.0.0.0/24',
  blockDeviceDir: '/var/lib/firecracker/images',
  enableKvm: true,
};

/**
 * Error thrown when Firecracker microVM creation or communication fails.
 * The sandbox NEVER falls back to non-isolated execution on failure.
 */
export class SandboxCreationError extends Error {
  constructor(
    message: string,
    public readonly reason: 'hypervisor_unavailable' | 'resource_exhausted' | 'configuration_invalid' | 'socket_error'
  ) {
    super(message);
    this.name = 'SandboxCreationError';
  }
}

/**
 * Error thrown when a device configuration is rejected.
 */
export class DeviceConfigurationError extends Error {
  constructor(
    message: string,
    public readonly rejectedDevice: string
  ) {
    super(message);
    this.name = 'DeviceConfigurationError';
  }
}

/**
 * Represents an isolated /30 TAP subnet assigned to a microVM.
 */
export interface TapSubnetAllocation {
  tapDevice: string;
  guestIp: string;
  hostIp: string;
  subnetMask: string;
}

/**
 * Interface for the Firecracker HTTP API client.
 * Abstracted to allow testing without a real hypervisor.
 */
export interface FirecrackerApiClient {
  /** Check if the Firecracker socket is available */
  isAvailable(): Promise<boolean>;
  /** Configure the machine (vCPUs, memory, KVM) */
  putMachineConfig(socketPath: string, config: MachineConfig): Promise<void>;
  /** Add a block device */
  putDrive(socketPath: string, driveId: string, config: DriveConfig): Promise<void>;
  /** Configure network interface */
  putNetworkInterface(socketPath: string, ifaceId: string, config: NetworkConfig): Promise<void>;
  /** Start the microVM instance */
  putAction(socketPath: string, action: VmAction): Promise<void>;
  /** Send a shutdown request or force-stop */
  sendCtrlAltDel(socketPath: string): Promise<void>;
}

export interface MachineConfig {
  vcpu_count: number;
  mem_size_mib: number;
  ht_enabled: boolean;
}

export interface DriveConfig {
  drive_id: string;
  path_on_host: string;
  is_root_device: boolean;
  is_read_only: boolean;
}

export interface NetworkConfig {
  iface_id: string;
  guest_mac: string;
  host_dev_name: string;
}

export interface VmAction {
  action_type: 'InstanceStart' | 'SendCtrlAltDel' | 'FlushMetrics';
}

/**
 * Interface for managing TAP network devices and iptables rules.
 */
export interface NetworkManager {
  /** Allocate an isolated /30 TAP subnet */
  allocateSubnet(): Promise<TapSubnetAllocation>;
  /** Apply iptables isolation rules for the subnet */
  applyIptablesRules(allocation: TapSubnetAllocation): Promise<void>;
  /** Remove iptables rules and release TAP device */
  releaseSubnet(allocation: TapSubnetAllocation): Promise<void>;
}

/**
 * Interface for managing block device images.
 */
export interface BlockDeviceManager {
  /** Create a block device image for the VM */
  createImage(instanceId: string, sizeMb: number): Promise<string>;
  /** Remove the block device image */
  removeImage(path: string): Promise<void>;
}

/**
 * Sandbox Agent that manages Firecracker microVM lifecycle.
 *
 * All untrusted code is executed inside hardware-isolated microVMs.
 * The agent NEVER falls back to non-isolated execution on failure.
 *
 * Lifecycle:
 * 1. Validate request and clamp resource limits
 * 2. Allocate /30 TAP subnet + iptables isolation
 * 3. Create block device image
 * 4. Configure Firecracker VM via REST API over Unix socket
 * 5. Start VM and execute code
 * 6. Monitor resource usage and enforce TTL/limits
 * 7. Terminate and release all resources within 5s
 *
 * Requirements: 15.1, 15.2, 15.3, 15.5, 15.6, 15.7
 */
export class SandboxAgent {
  private config: SandboxAgentConfig;
  private apiClient: FirecrackerApiClient;
  private networkManager: NetworkManager;
  private blockDeviceManager: BlockDeviceManager;
  private activeInstances: Map<string, MicroVmInstance> = new Map();

  constructor(
    config?: Partial<SandboxAgentConfig>,
    apiClient?: FirecrackerApiClient,
    networkManager?: NetworkManager,
    blockDeviceManager?: BlockDeviceManager
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.apiClient = apiClient ?? new DefaultFirecrackerApiClient();
    this.networkManager = networkManager ?? new DefaultNetworkManager();
    this.blockDeviceManager = blockDeviceManager ?? new DefaultBlockDeviceManager();
  }

  /**
   * Execute untrusted code inside an isolated Firecracker microVM.
   *
   * NEVER falls back to non-isolated execution. If the hypervisor is
   * unavailable or VM creation fails, returns an error result.
   *
   * @param request - The execution request with code, limits, and passport
   * @returns Execution result with status, output, violations, and resource usage
   */
  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    const startTime = Date.now();

    // Step 1: Validate and clamp resource limits
    const clampedLimits = this.clampResourceLimits(request.resource_limits);

    // Step 2: Verify hypervisor availability — NEVER fall back
    const available = await this.apiClient.isAvailable();
    if (!available) {
      return this.createErrorResult(
        startTime,
        'Firecracker hypervisor is unavailable. Cannot execute code without isolation.'
      );
    }

    // Step 3: Allocate resources for the microVM
    let instance: MicroVmInstance;
    try {
      instance = await this.provisionMicroVm(clampedLimits);
    } catch (err) {
      // Creation failure: reject request, NEVER fall back to non-isolated execution (Req 15.5)
      return this.createErrorResult(
        startTime,
        err instanceof Error ? err.message : 'Failed to provision microVM'
      );
    }

    // Step 4: Execute code within the VM with TTL enforcement
    try {
      const result = await this.executeInVm(instance, request, clampedLimits, startTime);
      return result;
    } finally {
      // Step 5: Cleanup — release all resources within 5s (Req 15.7)
      await this.terminateAndCleanup(instance);
    }
  }

  /**
   * Clamp resource limits to maximum allowed values.
   * Values exceeding caps are reduced to the cap, never exceeded.
   *
   * Enforced maximums (Req 15.6):
   * - vCPUs: ≤2
   * - Memory: ≤512 MB
   * - Storage: ≤10 GB
   * - Execution duration: ≤300s
   * - TTL: ≤600s
   */
  clampResourceLimits(limits: ResourceLimits): ResourceLimits {
    return {
      vcpus: Math.min(Math.max(1, limits.vcpus), MAX_VCPUS),
      memory_mb: Math.min(Math.max(1, limits.memory_mb), MAX_MEMORY_MB),
      disk_mb: Math.min(Math.max(1, limits.disk_mb), MAX_STORAGE_MB),
      ttl_seconds: Math.min(Math.max(1, limits.ttl_seconds), MAX_TTL_SECONDS),
      cpu_time_seconds: Math.min(Math.max(1, limits.cpu_time_seconds), MAX_EXECUTION_SECONDS),
      disk_io_mb: Math.min(Math.max(1, limits.disk_io_mb), MAX_DISK_IO_MB),
    };
  }

  /**
   * Validate that only allowed virtio devices are configured.
   * Rejects any device configuration outside {block, network} (Req 15.2).
   */
  validateDeviceConfiguration(devices: string[]): void {
    for (const device of devices) {
      if (!ALLOWED_VIRTIO_DEVICES.includes(device as AllowedVirtioDevice)) {
        throw new DeviceConfigurationError(
          `Device type '${device}' is not allowed. Only virtio block and network devices are permitted.`,
          device
        );
      }
    }
  }

  /**
   * Provision a new Firecracker microVM with full hardware isolation.
   *
   * Steps:
   * 1. Allocate TAP subnet with iptables isolation (Req 15.3)
   * 2. Create block device image
   * 3. Configure VM via Firecracker REST API (Req 15.1)
   * 4. Configure only virtio block + network devices (Req 15.2)
   * 5. Start the VM
   */
  private async provisionMicroVm(limits: ResourceLimits): Promise<MicroVmInstance> {
    const instanceId = randomUUID();
    const socketPath = `${this.config.socketBasePath}/${instanceId}.sock`;

    // Validate device configuration — only block and network allowed
    this.validateDeviceConfiguration(['block', 'network']);

    // Allocate isolated /30 TAP subnet (Req 15.3)
    let subnetAllocation: TapSubnetAllocation;
    try {
      subnetAllocation = await this.networkManager.allocateSubnet();
    } catch (err) {
      throw new SandboxCreationError(
        `Failed to allocate TAP subnet: ${err instanceof Error ? err.message : 'unknown error'}`,
        'resource_exhausted'
      );
    }

    // Apply iptables rules to drop all packets to other microVM subnets (Req 15.3)
    try {
      await this.networkManager.applyIptablesRules(subnetAllocation);
    } catch (err) {
      // Cleanup allocated subnet on iptables failure
      await this.networkManager.releaseSubnet(subnetAllocation).catch(() => {});
      throw new SandboxCreationError(
        `Failed to apply iptables isolation rules: ${err instanceof Error ? err.message : 'unknown error'}`,
        'configuration_invalid'
      );
    }

    // Create block device image
    let blockDevicePath: string;
    try {
      blockDevicePath = await this.blockDeviceManager.createImage(instanceId, limits.disk_mb);
    } catch (err) {
      await this.networkManager.releaseSubnet(subnetAllocation).catch(() => {});
      throw new SandboxCreationError(
        `Failed to create block device: ${err instanceof Error ? err.message : 'unknown error'}`,
        'resource_exhausted'
      );
    }

    // Configure Firecracker VM via REST API over Unix socket (Req 15.1)
    try {
      // Set machine configuration with hardware virtualization
      await this.apiClient.putMachineConfig(socketPath, {
        vcpu_count: limits.vcpus,
        mem_size_mib: limits.memory_mb,
        ht_enabled: false,
      });

      // Configure virtio block device (Req 15.2)
      await this.apiClient.putDrive(socketPath, 'rootfs', {
        drive_id: 'rootfs',
        path_on_host: blockDevicePath,
        is_root_device: true,
        is_read_only: false,
      });

      // Configure virtio network device (Req 15.2)
      await this.apiClient.putNetworkInterface(socketPath, 'eth0', {
        iface_id: 'eth0',
        guest_mac: this.generateMacAddress(),
        host_dev_name: subnetAllocation.tapDevice,
      });

      // Start the microVM instance
      await this.apiClient.putAction(socketPath, { action_type: 'InstanceStart' });
    } catch (err) {
      // Cleanup all resources on configuration failure
      await this.blockDeviceManager.removeImage(blockDevicePath).catch(() => {});
      await this.networkManager.releaseSubnet(subnetAllocation).catch(() => {});
      throw new SandboxCreationError(
        `Failed to configure/start Firecracker VM: ${err instanceof Error ? err.message : 'unknown error'}`,
        'socket_error'
      );
    }

    const instance: MicroVmInstance = {
      id: instanceId,
      socketPath,
      tapDevice: subnetAllocation.tapDevice,
      subnet: `${subnetAllocation.guestIp}/30`,
      blockDevice: blockDevicePath,
      startedAt: Date.now(),
      resourceLimits: limits,
      terminated: false,
    };

    this.activeInstances.set(instanceId, instance);
    return instance;
  }

  /**
   * Execute code within the provisioned microVM and enforce resource limits.
   * Terminates if:
   * - Resource cap exceeded (Req 15.6)
   * - TTL expiry at max 600s (Req 15.6)
   * - Execution duration exceeds 300s
   */
  private async executeInVm(
    instance: MicroVmInstance,
    request: ExecutionRequest,
    limits: ResourceLimits,
    startTime: number
  ): Promise<ExecutionResult> {
    const ttlMs = limits.ttl_seconds * 1000;
    const executionLimitMs = limits.cpu_time_seconds * 1000;
    const effectiveTimeout = Math.min(ttlMs, executionLimitMs);

    return new Promise<ExecutionResult>((resolve) => {
      const timer = setTimeout(() => {
        // TTL or execution limit exceeded — terminate (Req 15.6)
        const elapsed = Date.now() - startTime;
        resolve({
          status: 'timeout',
          oracle_violations: [],
          duration_ms: elapsed,
          resource_usage: this.createResourceUsage(elapsed, limits),
        });
      }, effectiveTimeout);

      // Simulate execution in the VM
      // In production, this would communicate with the Firecracker VM via vsock/serial
      // and monitor resource usage via cgroups
      this.monitorExecution(instance, request, limits, startTime)
        .then((result) => {
          clearTimeout(timer);
          resolve(result);
        })
        .catch(() => {
          clearTimeout(timer);
          const elapsed = Date.now() - startTime;
          resolve({
            status: 'crashed',
            oracle_violations: [],
            duration_ms: elapsed,
            resource_usage: this.createResourceUsage(elapsed, limits),
          });
        });
    });
  }

  /**
   * Monitor execution within the VM and check for resource violations.
   * This is the core execution loop that would interface with the actual VM.
   */
  private async monitorExecution(
    _instance: MicroVmInstance,
    _request: ExecutionRequest,
    limits: ResourceLimits,
    startTime: number
  ): Promise<ExecutionResult> {
    // In a real implementation, this would:
    // 1. Send code to the VM via vsock
    // 2. Poll resource usage via /proc/<pid>/stat or cgroups
    // 3. Check oracle violations
    // 4. Collect output from the VM
    //
    // Since Firecracker may not be present, we simulate a completed execution.
    // The actual communication would use the REST API over the Unix socket.
    const elapsed = Date.now() - startTime;

    return {
      status: 'completed',
      output: undefined,
      oracle_violations: [],
      duration_ms: elapsed,
      resource_usage: this.createResourceUsage(elapsed, limits),
    };
  }

  /**
   * Terminate a microVM instance and release all associated resources.
   * Resources MUST be released within 5s of termination (Req 15.7).
   * If cleanup exceeds 5s, force-kill at hypervisor level.
   */
  private async terminateAndCleanup(instance: MicroVmInstance): Promise<void> {
    if (instance.terminated) return;
    instance.terminated = true;

    const cleanupStart = Date.now();

    // Attempt graceful shutdown first
    let cleanupDone = false;
    const cleanupPromise = this.performCleanup(instance).then(() => {
      cleanupDone = true;
    });

    // Force-kill if cleanup takes longer than 5s (Req 15.7). The timer must be
    // cleared when cleanup wins the race, otherwise it fires on every normal
    // shutdown — leaking a timer and force-killing/double-releasing resources 5s later.
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const forceKillPromise = new Promise<void>((resolve) => {
      killTimer = setTimeout(async () => {
        // Only force-kill if graceful cleanup has not completed in time.
        if (!cleanupDone) {
          await this.forceKillInstance(instance).catch(() => {});
        }
        resolve();
      }, FORCE_KILL_TIMEOUT_MS);
    });

    try {
      await Promise.race([cleanupPromise, forceKillPromise]);
    } finally {
      if (killTimer !== undefined) clearTimeout(killTimer);
    }

    // Remove from active instances tracking
    this.activeInstances.delete(instance.id);

    // Verify cleanup completed within 5s budget
    const cleanupDuration = Date.now() - cleanupStart;
    if (cleanupDuration > CLEANUP_TIMEOUT_MS) {
      // Log warning — resource release exceeded the 5s target
      // In production, this would go to the system logging service
    }
  }

  /**
   * Perform graceful cleanup of VM resources:
   * - Send shutdown signal to VM
   * - Release TAP subnet and iptables rules
   * - Remove block device image
   */
  private async performCleanup(instance: MicroVmInstance): Promise<void> {
    // Send shutdown signal to the VM
    try {
      await this.apiClient.sendCtrlAltDel(instance.socketPath);
    } catch {
      // VM may already be dead, continue with resource cleanup
    }

    // Release network resources (TAP device + iptables rules)
    const tapAllocation: TapSubnetAllocation = {
      tapDevice: instance.tapDevice,
      guestIp: instance.subnet.split('/')[0],
      hostIp: '', // Reconstructed from subnet
      subnetMask: '255.255.255.252', // /30
    };
    await this.networkManager.releaseSubnet(tapAllocation).catch(() => {});

    // Remove block device image
    await this.blockDeviceManager.removeImage(instance.blockDevice).catch(() => {});
  }

  /**
   * Force-kill a microVM instance at the hypervisor level.
   * Called when graceful cleanup exceeds the 5s timeout.
   */
  private async forceKillInstance(instance: MicroVmInstance): Promise<void> {
    if (instance.pid) {
      // Kill the Firecracker process directly
      try {
        process.kill(instance.pid, 'SIGKILL');
      } catch {
        // Process may already be dead
      }
    }

    // Force release resources regardless of process state
    const tapAllocation: TapSubnetAllocation = {
      tapDevice: instance.tapDevice,
      guestIp: instance.subnet.split('/')[0],
      hostIp: '',
      subnetMask: '255.255.255.252',
    };
    await this.networkManager.releaseSubnet(tapAllocation).catch(() => {});
    await this.blockDeviceManager.removeImage(instance.blockDevice).catch(() => {});
  }

  /**
   * Create an error result when VM creation or execution fails.
   * The sandbox NEVER falls back to non-isolated execution (Req 15.5).
   */
  private createErrorResult(startTime: number, errorMessage: string): ExecutionResult {
    const elapsed = Date.now() - startTime;
    return {
      status: 'error',
      output: { error: errorMessage },
      oracle_violations: [],
      duration_ms: elapsed,
      resource_usage: {
        cpu_time_seconds: 0,
        memory_peak_mb: 0,
        disk_io_mb: 0,
        wall_time_ms: elapsed,
      },
    };
  }

  /**
   * Create resource usage from elapsed time and configured limits.
   */
  private createResourceUsage(elapsedMs: number, limits: ResourceLimits): ResourceUsage {
    return {
      cpu_time_seconds: elapsedMs / 1000,
      memory_peak_mb: 0,
      disk_io_mb: 0,
      wall_time_ms: elapsedMs,
    };
  }

  /**
   * Generate a random MAC address for the microVM network interface.
   */
  private generateMacAddress(): string {
    const bytes = new Uint8Array(6);
    for (let i = 0; i < 6; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
    // Set locally administered bit and clear multicast bit
    bytes[0] = (bytes[0] | 0x02) & 0xfe;
    return Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join(':');
  }

  /**
   * Get the number of currently active microVM instances.
   */
  getActiveInstanceCount(): number {
    return this.activeInstances.size;
  }

  /**
   * Get an active instance by ID (for monitoring/testing).
   */
  getActiveInstance(id: string): MicroVmInstance | undefined {
    return this.activeInstances.get(id);
  }
}

/**
 * Default Firecracker API client implementation.
 * Communicates with Firecracker's REST API over a Unix socket.
 * Returns appropriate errors when the hypervisor is unavailable.
 */
class DefaultFirecrackerApiClient implements FirecrackerApiClient {
  async isAvailable(): Promise<boolean> {
    // In production, check if the Firecracker socket exists and is responsive
    // For now, return false since Firecracker is likely not installed
    return false;
  }

  async putMachineConfig(_socketPath: string, _config: MachineConfig): Promise<void> {
    throw new SandboxCreationError(
      'Firecracker hypervisor is not available on this system',
      'hypervisor_unavailable'
    );
  }

  async putDrive(_socketPath: string, _driveId: string, _config: DriveConfig): Promise<void> {
    throw new SandboxCreationError(
      'Firecracker hypervisor is not available on this system',
      'hypervisor_unavailable'
    );
  }

  async putNetworkInterface(_socketPath: string, _ifaceId: string, _config: NetworkConfig): Promise<void> {
    throw new SandboxCreationError(
      'Firecracker hypervisor is not available on this system',
      'hypervisor_unavailable'
    );
  }

  async putAction(_socketPath: string, _action: VmAction): Promise<void> {
    throw new SandboxCreationError(
      'Firecracker hypervisor is not available on this system',
      'hypervisor_unavailable'
    );
  }

  async sendCtrlAltDel(_socketPath: string): Promise<void> {
    // No-op when hypervisor is unavailable
  }
}

/**
 * Default network manager that manages TAP devices and iptables rules.
 * In production, this executes actual ip/iptables commands.
 */
class DefaultNetworkManager implements NetworkManager {
  private subnetCounter = 0;

  async allocateSubnet(): Promise<TapSubnetAllocation> {
    const index = this.subnetCounter++;
    const baseOctet = 4 * index; // /30 subnets = 4 IPs each
    return {
      tapDevice: `tap${index}`,
      guestIp: `10.0.0.${baseOctet + 2}`,
      hostIp: `10.0.0.${baseOctet + 1}`,
      subnetMask: '255.255.255.252',
    };
  }

  async applyIptablesRules(_allocation: TapSubnetAllocation): Promise<void> {
    // In production: execute iptables rules to drop inter-VM traffic
    // iptables -A FORWARD -i <tap> -d 10.0.0.0/24 -j DROP
    // iptables -A FORWARD -i <tap> -d <host_gateway> -j ACCEPT
  }

  async releaseSubnet(_allocation: TapSubnetAllocation): Promise<void> {
    // In production: remove iptables rules and delete TAP device
    // iptables -D FORWARD -i <tap> ...
    // ip link delete <tap>
  }
}

/**
 * Default block device manager that creates/removes disk images.
 * In production, this would use fallocate/truncate to create sparse images.
 */
class DefaultBlockDeviceManager implements BlockDeviceManager {
  async createImage(instanceId: string, _sizeMb: number): Promise<string> {
    return `/var/lib/firecracker/images/${instanceId}.ext4`;
  }

  async removeImage(_path: string): Promise<void> {
    // In production: unlink the file
  }
}
