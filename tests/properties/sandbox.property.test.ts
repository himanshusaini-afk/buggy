import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { SandboxAgent, MAX_VCPUS, MAX_MEMORY_MB, MAX_STORAGE_MB, MAX_EXECUTION_SECONDS, MAX_TTL_SECONDS, SandboxCreationError } from '../../src/sandbox/sandbox-agent.js';
import type { FirecrackerApiClient, MachineConfig, DriveConfig, NetworkConfig, VmAction, NetworkManager, TapSubnetAllocation, BlockDeviceManager } from '../../src/sandbox/sandbox-agent.js';
import { CircuitBreaker, MAX_CPU_TIME_SECONDS, MAX_MEMORY_MB as CB_MAX_MEMORY_MB, MAX_DISK_IO_MB, MAX_TTL_SECONDS as CB_MAX_TTL_SECONDS } from '../../src/sandbox/circuit-breaker.js';
import { validateOperation, OapPassportSession } from '../../src/sandbox/oap-passport.js';
import type { ResourceLimits, OapPassport, ExecutionRequest } from '../../src/types/sandbox.js';

/**
 * Property Tests for Resource Limit Enforcement (Property 28)
 *
 * Verifies that enforced resource limits are clamped to hard maximums:
 * - vCPUs ≤ 2 (SandboxAgent)
 * - Memory ≤ 2048 MB (CircuitBreaker)
 * - Disk I/O ≤ 1024 MB (CircuitBreaker)
 * - CPU time ≤ 300s (both SandboxAgent and CircuitBreaker)
 * - Block storage ≤ 10 GB / 10240 MB (SandboxAgent)
 * - TTL ≤ 600s (both SandboxAgent and CircuitBreaker)
 *
 * **Validates: Requirements 15.6, 17.1, 17.2**
 */

// --- Arbitraries ---

/** Generate a random ResourceLimits configuration with values in range 0..10000. */
const arbResourceLimits: fc.Arbitrary<ResourceLimits> = fc.record({
  vcpus: fc.integer({ min: 0, max: 10000 }),
  memory_mb: fc.integer({ min: 0, max: 10000 }),
  disk_mb: fc.integer({ min: 0, max: 10000 }),
  ttl_seconds: fc.integer({ min: 0, max: 10000 }),
  cpu_time_seconds: fc.integer({ min: 0, max: 10000 }),
  disk_io_mb: fc.integer({ min: 0, max: 10000 }),
});

/** Generate a ResourceLimits configuration that is within all valid limits. */
const arbValidResourceLimits: fc.Arbitrary<ResourceLimits> = fc.record({
  vcpus: fc.integer({ min: 1, max: MAX_VCPUS }),
  memory_mb: fc.integer({ min: 1, max: CB_MAX_MEMORY_MB }),
  disk_mb: fc.integer({ min: 1, max: MAX_STORAGE_MB }),
  ttl_seconds: fc.integer({ min: 1, max: CB_MAX_TTL_SECONDS }),
  cpu_time_seconds: fc.integer({ min: 1, max: MAX_CPU_TIME_SECONDS }),
  disk_io_mb: fc.integer({ min: 1, max: MAX_DISK_IO_MB }),
});

// --- Property 28: Resource Limit Enforcement ---

describe('Property 28: Resource Limit Enforcement', () => {
  describe('SandboxAgent resource clamping', () => {
    const agent = new SandboxAgent();

    it('clamps vCPUs to maximum of 2', () => {
      fc.assert(
        fc.property(
          arbResourceLimits,
          (limits) => {
            const clamped = agent.clampResourceLimits(limits);
            expect(clamped.vcpus).toBeLessThanOrEqual(MAX_VCPUS);
            expect(clamped.vcpus).toBeGreaterThanOrEqual(1);
          }
        ),
        { numRuns: 200 }
      );
    });

    it('clamps memory to maximum of 512 MB (sandbox-agent level)', () => {
      fc.assert(
        fc.property(
          arbResourceLimits,
          (limits) => {
            const clamped = agent.clampResourceLimits(limits);
            expect(clamped.memory_mb).toBeLessThanOrEqual(MAX_MEMORY_MB);
            expect(clamped.memory_mb).toBeGreaterThanOrEqual(1);
          }
        ),
        { numRuns: 200 }
      );
    });

    it('clamps block storage to maximum of 10240 MB (10 GB)', () => {
      fc.assert(
        fc.property(
          arbResourceLimits,
          (limits) => {
            const clamped = agent.clampResourceLimits(limits);
            expect(clamped.disk_mb).toBeLessThanOrEqual(MAX_STORAGE_MB);
            expect(clamped.disk_mb).toBeGreaterThanOrEqual(1);
          }
        ),
        { numRuns: 200 }
      );
    });

    it('clamps CPU time to maximum of 300 seconds', () => {
      fc.assert(
        fc.property(
          arbResourceLimits,
          (limits) => {
            const clamped = agent.clampResourceLimits(limits);
            expect(clamped.cpu_time_seconds).toBeLessThanOrEqual(MAX_EXECUTION_SECONDS);
            expect(clamped.cpu_time_seconds).toBeGreaterThanOrEqual(1);
          }
        ),
        { numRuns: 200 }
      );
    });

    it('clamps TTL to maximum of 600 seconds', () => {
      fc.assert(
        fc.property(
          arbResourceLimits,
          (limits) => {
            const clamped = agent.clampResourceLimits(limits);
            expect(clamped.ttl_seconds).toBeLessThanOrEqual(MAX_TTL_SECONDS);
            expect(clamped.ttl_seconds).toBeGreaterThanOrEqual(1);
          }
        ),
        { numRuns: 200 }
      );
    });

    it('passes through valid configurations unchanged (within sandbox-agent limits)', () => {
      fc.assert(
        fc.property(
          fc.record({
            vcpus: fc.integer({ min: 1, max: MAX_VCPUS }),
            memory_mb: fc.integer({ min: 1, max: MAX_MEMORY_MB }),
            disk_mb: fc.integer({ min: 1, max: MAX_STORAGE_MB }),
            ttl_seconds: fc.integer({ min: 1, max: MAX_TTL_SECONDS }),
            cpu_time_seconds: fc.integer({ min: 1, max: MAX_EXECUTION_SECONDS }),
            disk_io_mb: fc.integer({ min: 1, max: 10000 }),
          }),
          (limits) => {
            const clamped = agent.clampResourceLimits(limits);
            expect(clamped.vcpus).toBe(limits.vcpus);
            expect(clamped.memory_mb).toBe(limits.memory_mb);
            expect(clamped.disk_mb).toBe(limits.disk_mb);
            expect(clamped.ttl_seconds).toBe(limits.ttl_seconds);
            expect(clamped.cpu_time_seconds).toBe(limits.cpu_time_seconds);
          }
        ),
        { numRuns: 200 }
      );
    });
  });

  describe('CircuitBreaker resource clamping', () => {
    it('clamps CPU time to maximum of 300 seconds', () => {
      fc.assert(
        fc.property(
          arbResourceLimits,
          (limits) => {
            const cb = new CircuitBreaker('test-instance', limits, {
              terminate: async () => true,
              forceKill: async () => {},
              releaseResources: async () => {},
              notify: () => {},
            });
            const clampedLimits = cb.getLimits();
            expect(clampedLimits.cpuTimeSeconds).toBeLessThanOrEqual(MAX_CPU_TIME_SECONDS);
            expect(clampedLimits.cpuTimeSeconds).toBeGreaterThanOrEqual(1);
          }
        ),
        { numRuns: 200 }
      );
    });

    it('clamps memory to maximum of 2048 MB', () => {
      fc.assert(
        fc.property(
          arbResourceLimits,
          (limits) => {
            const cb = new CircuitBreaker('test-instance', limits, {
              terminate: async () => true,
              forceKill: async () => {},
              releaseResources: async () => {},
              notify: () => {},
            });
            const clampedLimits = cb.getLimits();
            expect(clampedLimits.memoryMb).toBeLessThanOrEqual(CB_MAX_MEMORY_MB);
            expect(clampedLimits.memoryMb).toBeGreaterThanOrEqual(1);
          }
        ),
        { numRuns: 200 }
      );
    });

    it('clamps disk I/O to maximum of 1024 MB', () => {
      fc.assert(
        fc.property(
          arbResourceLimits,
          (limits) => {
            const cb = new CircuitBreaker('test-instance', limits, {
              terminate: async () => true,
              forceKill: async () => {},
              releaseResources: async () => {},
              notify: () => {},
            });
            const clampedLimits = cb.getLimits();
            expect(clampedLimits.diskIoMb).toBeLessThanOrEqual(MAX_DISK_IO_MB);
            expect(clampedLimits.diskIoMb).toBeGreaterThanOrEqual(1);
          }
        ),
        { numRuns: 200 }
      );
    });

    it('clamps TTL to maximum of 600 seconds', () => {
      fc.assert(
        fc.property(
          arbResourceLimits,
          (limits) => {
            const cb = new CircuitBreaker('test-instance', limits, {
              terminate: async () => true,
              forceKill: async () => {},
              releaseResources: async () => {},
              notify: () => {},
            });
            const clampedLimits = cb.getLimits();
            expect(clampedLimits.ttlSeconds).toBeLessThanOrEqual(CB_MAX_TTL_SECONDS);
            expect(clampedLimits.ttlSeconds).toBeGreaterThanOrEqual(1);
          }
        ),
        { numRuns: 200 }
      );
    });

    it('passes through valid configurations unchanged', () => {
      fc.assert(
        fc.property(
          arbValidResourceLimits,
          (limits) => {
            const cb = new CircuitBreaker('test-instance', limits, {
              terminate: async () => true,
              forceKill: async () => {},
              releaseResources: async () => {},
              notify: () => {},
            });
            const clampedLimits = cb.getLimits();
            expect(clampedLimits.cpuTimeSeconds).toBe(limits.cpu_time_seconds);
            expect(clampedLimits.memoryMb).toBe(limits.memory_mb);
            expect(clampedLimits.diskIoMb).toBe(limits.disk_io_mb);
            expect(clampedLimits.ttlSeconds).toBe(limits.ttl_seconds);
          }
        ),
        { numRuns: 200 }
      );
    });
  });

  describe('Combined enforcement — all resource limits clamped', () => {
    it('all enforced limits respect hard maximums for any random configuration', () => {
      fc.assert(
        fc.property(
          arbResourceLimits,
          (limits) => {
            // SandboxAgent clamping
            const agent = new SandboxAgent();
            const sandboxClamped = agent.clampResourceLimits(limits);

            // CircuitBreaker clamping
            const cb = new CircuitBreaker('test-instance', limits, {
              terminate: async () => true,
              forceKill: async () => {},
              releaseResources: async () => {},
              notify: () => {},
            });
            const cbLimits = cb.getLimits();

            // Verify all enforced maximums (Requirements 15.6, 17.1, 17.2)
            // vCPUs ≤ 2
            expect(sandboxClamped.vcpus).toBeLessThanOrEqual(2);
            // Memory ≤ 2048 MB (circuit breaker level)
            expect(cbLimits.memoryMb).toBeLessThanOrEqual(2048);
            // Disk I/O ≤ 1024 MB (circuit breaker level)
            expect(cbLimits.diskIoMb).toBeLessThanOrEqual(1024);
            // CPU time ≤ 300s
            expect(sandboxClamped.cpu_time_seconds).toBeLessThanOrEqual(300);
            expect(cbLimits.cpuTimeSeconds).toBeLessThanOrEqual(300);
            // Block storage ≤ 10 GB (10240 MB)
            expect(sandboxClamped.disk_mb).toBeLessThanOrEqual(10240);
            // TTL ≤ 600s
            expect(sandboxClamped.ttl_seconds).toBeLessThanOrEqual(600);
            expect(cbLimits.ttlSeconds).toBeLessThanOrEqual(600);
          }
        ),
        { numRuns: 200 }
      );
    });

    it('values at or below limits are preserved by clamping', () => {
      fc.assert(
        fc.property(
          arbValidResourceLimits,
          (limits) => {
            // SandboxAgent clamping — values within sandbox limits should pass through
            const agent = new SandboxAgent();
            const sandboxClamped = agent.clampResourceLimits(limits);

            expect(sandboxClamped.vcpus).toBe(limits.vcpus);
            expect(sandboxClamped.disk_mb).toBe(limits.disk_mb);
            expect(sandboxClamped.cpu_time_seconds).toBe(limits.cpu_time_seconds);
            expect(sandboxClamped.ttl_seconds).toBe(limits.ttl_seconds);

            // CircuitBreaker clamping — values within CB limits should pass through
            const cb = new CircuitBreaker('test-instance', limits, {
              terminate: async () => true,
              forceKill: async () => {},
              releaseResources: async () => {},
              notify: () => {},
            });
            const cbLimits = cb.getLimits();

            expect(cbLimits.cpuTimeSeconds).toBe(limits.cpu_time_seconds);
            expect(cbLimits.memoryMb).toBe(limits.memory_mb);
            expect(cbLimits.diskIoMb).toBe(limits.disk_io_mb);
            expect(cbLimits.ttlSeconds).toBe(limits.ttl_seconds);
          }
        ),
        { numRuns: 200 }
      );
    });
  });
});


/**
 * Property Tests for OAP Passport Permission Enforcement (Property 26)
 *
 * For any operation request and OAP_Passport, the Sandbox_Agent shall allow
 * the operation if and only if it appears in the passport's permitted_operations
 * list; all other operations shall be rejected.
 *
 * **Validates: Requirements 15.4**
 */

// --- Arbitraries for Property 26 ---

/** Generate a random operation name (alphanumeric with underscores/dots). */
const arbOperationName: fc.Arbitrary<string> = fc.stringOf(
  fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz_.:'.split('')),
  { minLength: 1, maxLength: 30 }
);

/** Generate a random non-empty list of permitted operations. */
const arbPermittedOperations: fc.Arbitrary<string[]> = fc.uniqueArray(arbOperationName, {
  minLength: 1,
  maxLength: 20,
});

/** Generate a valid (non-expired) OAP Passport with given permitted operations. */
function arbPassportWithOperations(
  permittedOps: fc.Arbitrary<string[]>
): fc.Arbitrary<OapPassport> {
  return fc.record({
    agent_id: fc.string({ minLength: 1, maxLength: 20 }).map((s) => `agent-${s}`),
    permitted_operations: permittedOps,
    issued_at: fc.constant(new Date(Date.now() - 3600000).toISOString()),
    expires_at: fc.constant(new Date(Date.now() + 3600000).toISOString()),
  });
}

/** Generate a valid OAP Passport with random permitted operations. */
const arbValidPassport: fc.Arbitrary<OapPassport> = arbPassportWithOperations(arbPermittedOperations);

// --- Property 26: OAP Passport Permission Enforcement ---

describe('Property 26: OAP Passport Permission Enforcement', () => {
  describe('validateOperation — permitted operations are allowed', () => {
    it('allows any operation that appears in permitted_operations', () => {
      fc.assert(
        fc.property(
          arbValidPassport,
          (passport) => {
            // Every operation in permitted_operations should be allowed
            for (const op of passport.permitted_operations) {
              const result = validateOperation(passport, op);
              expect(result.allowed).toBe(true);
            }
          }
        ),
        { numRuns: 150 }
      );
    });

    it('operation allowed iff it appears in permitted_operations (random operation from list)', () => {
      fc.assert(
        fc.property(
          arbValidPassport.chain((passport) =>
            fc.integer({ min: 0, max: passport.permitted_operations.length - 1 }).map(
              (idx) => ({ passport, operation: passport.permitted_operations[idx] })
            )
          ),
          ({ passport, operation }) => {
            const result = validateOperation(passport, operation);
            expect(result.allowed).toBe(true);
          }
        ),
        { numRuns: 150 }
      );
    });
  });

  describe('validateOperation — non-permitted operations are rejected', () => {
    it('rejects any operation NOT in permitted_operations', () => {
      fc.assert(
        fc.property(
          arbValidPassport,
          arbOperationName,
          (passport, operation) => {
            // Only test when the operation is NOT in the permitted list
            fc.pre(!passport.permitted_operations.includes(operation));

            const result = validateOperation(passport, operation);
            expect(result.allowed).toBe(false);
            if (!result.allowed) {
              expect(result.rejection.code).toBe('OPERATION_NOT_PERMITTED');
              expect(result.rejection.operation).toBe(operation);
              expect(result.rejection.agent_id).toBe(passport.agent_id);
              expect(result.rejection.permitted_operations).toEqual(passport.permitted_operations);
            }
          }
        ),
        { numRuns: 150 }
      );
    });

    it('rejects a guaranteed-non-permitted operation with structured error', () => {
      fc.assert(
        fc.property(
          arbValidPassport,
          (passport) => {
            // Create an operation guaranteed to not be in the list
            const nonPermittedOp = `__NON_PERMITTED_OP_${Date.now()}__`;
            const result = validateOperation(passport, nonPermittedOp);

            expect(result.allowed).toBe(false);
            if (!result.allowed) {
              expect(result.rejection.code).toBe('OPERATION_NOT_PERMITTED');
              expect(result.rejection.operation).toBe(nonPermittedOp);
              expect(result.rejection.agent_id).toBe(passport.agent_id);
              expect(result.rejection.permitted_operations).toEqual(passport.permitted_operations);
              expect(result.rejection.message).toContain(nonPermittedOp);
            }
          }
        ),
        { numRuns: 150 }
      );
    });
  });

  describe('OapPassportSession — enforces permission via session interface', () => {
    it('isOperationPermitted returns true iff operation is in permitted_operations', () => {
      fc.assert(
        fc.property(
          arbValidPassport,
          arbOperationName,
          (passport, operation) => {
            const session = new OapPassportSession(passport);
            const isPermitted = session.isOperationPermitted(operation);
            const expectedPermitted = passport.permitted_operations.includes(operation);
            expect(isPermitted).toBe(expectedPermitted);
          }
        ),
        { numRuns: 150 }
      );
    });

    it('enforceOperation throws for non-permitted operations', () => {
      fc.assert(
        fc.property(
          arbValidPassport,
          (passport) => {
            const session = new OapPassportSession(passport);
            const nonPermittedOp = `__DENIED_${passport.agent_id}__`;

            expect(() => session.enforceOperation(nonPermittedOp)).toThrow();
          }
        ),
        { numRuns: 150 }
      );
    });

    it('enforceOperation does not throw for permitted operations', () => {
      fc.assert(
        fc.property(
          arbValidPassport.chain((passport) =>
            fc.integer({ min: 0, max: passport.permitted_operations.length - 1 }).map(
              (idx) => ({ passport, operation: passport.permitted_operations[idx] })
            )
          ),
          ({ passport, operation }) => {
            const session = new OapPassportSession(passport);
            expect(() => session.enforceOperation(operation)).not.toThrow();
          }
        ),
        { numRuns: 150 }
      );
    });
  });

  describe('Biconditional enforcement — allowed iff in permitted_operations', () => {
    it('for any random operation, allowed === (operation in permitted_operations)', () => {
      fc.assert(
        fc.property(
          arbValidPassport,
          arbOperationName,
          (passport, operation) => {
            const result = validateOperation(passport, operation);
            const isInPermittedList = passport.permitted_operations.includes(operation);

            // The core biconditional: allowed iff in permitted_operations
            expect(result.allowed).toBe(isInPermittedList);
          }
        ),
        { numRuns: 200 }
      );
    });
  });
});


/**
 * Property 27: No Fallback to Non-Isolated Execution
 *
 * For any Firecracker_MicroVM creation or start failure, the Sandbox_Agent shall
 * reject the execution request with an error and shall never execute code outside
 * of a microVM, regardless of the failure type.
 *
 * **Validates: Requirements 15.5**
 */

// --- Failure Scenario Types ---

type FailureScenario =
  | 'hypervisor_unavailable'
  | 'subnet_allocation_failure'
  | 'iptables_failure'
  | 'block_device_failure'
  | 'machine_config_failure'
  | 'drive_config_failure'
  | 'network_config_failure'
  | 'vm_start_failure';

// --- Arbitraries for Property 27 ---

/** Generate a random failure scenario type. */
const arbFailureScenario: fc.Arbitrary<FailureScenario> = fc.constantFrom(
  'hypervisor_unavailable',
  'subnet_allocation_failure',
  'iptables_failure',
  'block_device_failure',
  'machine_config_failure',
  'drive_config_failure',
  'network_config_failure',
  'vm_start_failure'
);

/** Generate a random error message string. */
const arbErrorMessage: fc.Arbitrary<string> = fc.stringOf(
  fc.char().filter((c) => c !== '\0'),
  { minLength: 1, maxLength: 100 }
);

/** Generate a valid OAP passport for testing. */
const arbOapPassport: fc.Arbitrary<OapPassport> = fc.record({
  agent_id: fc.uuid(),
  permitted_operations: fc.array(fc.constantFrom('read', 'write', 'execute', 'network'), { minLength: 1, maxLength: 4 }),
  issued_at: fc.constant(new Date().toISOString()),
  expires_at: fc.constant(new Date(Date.now() + 3600000).toISOString()),
});

/** Generate a valid execution request. */
const arbExecutionRequest: fc.Arbitrary<ExecutionRequest> = fc.record({
  code: fc.string({ minLength: 1, maxLength: 500 }),
  runtime: fc.constantFrom('node', 'python', 'ruby', 'go'),
  oap_passport: arbOapPassport,
  resource_limits: fc.record({
    vcpus: fc.integer({ min: 1, max: 4 }),
    memory_mb: fc.integer({ min: 64, max: 2048 }),
    disk_mb: fc.integer({ min: 100, max: 20000 }),
    ttl_seconds: fc.integer({ min: 1, max: 1000 }),
    cpu_time_seconds: fc.integer({ min: 1, max: 600 }),
    disk_io_mb: fc.integer({ min: 1, max: 2048 }),
  }),
  oracles: fc.subarray(['timeout', 'crash', 'determinism', 'overflow'] as const, { minLength: 0, maxLength: 4 }),
});

// --- Mock implementations that simulate failures ---

/**
 * Creates a mock FirecrackerApiClient that fails at the specified scenario.
 * Tracks whether any code execution was attempted (which should never happen on failure).
 */
function createFailingApiClient(scenario: FailureScenario, errorMessage: string): FirecrackerApiClient & { codeExecuted: boolean } {
  const tracker = {
    codeExecuted: false,

    async isAvailable(): Promise<boolean> {
      if (scenario === 'hypervisor_unavailable') {
        return false;
      }
      return true;
    },

    async putMachineConfig(_socketPath: string, _config: MachineConfig): Promise<void> {
      if (scenario === 'machine_config_failure') {
        throw new SandboxCreationError(
          `Machine config failed: ${errorMessage}`,
          'configuration_invalid'
        );
      }
    },

    async putDrive(_socketPath: string, _driveId: string, _config: DriveConfig): Promise<void> {
      if (scenario === 'drive_config_failure') {
        throw new SandboxCreationError(
          `Drive config failed: ${errorMessage}`,
          'configuration_invalid'
        );
      }
    },

    async putNetworkInterface(_socketPath: string, _ifaceId: string, _config: NetworkConfig): Promise<void> {
      if (scenario === 'network_config_failure') {
        throw new SandboxCreationError(
          `Network config failed: ${errorMessage}`,
          'configuration_invalid'
        );
      }
    },

    async putAction(_socketPath: string, _action: VmAction): Promise<void> {
      if (scenario === 'vm_start_failure') {
        throw new SandboxCreationError(
          `VM start failed: ${errorMessage}`,
          'socket_error'
        );
      }
      // If we reach putAction without prior failure scenarios triggering,
      // and the scenario isn't vm_start_failure, it means execution would proceed.
      // Mark that code was "executed" (this shouldn't happen for failure scenarios).
      tracker.codeExecuted = true;
    },

    async sendCtrlAltDel(_socketPath: string): Promise<void> {
      // No-op for cleanup
    },
  };

  return tracker;
}

/**
 * Creates a mock NetworkManager that fails on subnet allocation or iptables.
 */
function createFailingNetworkManager(scenario: FailureScenario, errorMessage: string): NetworkManager {
  return {
    async allocateSubnet(): Promise<TapSubnetAllocation> {
      if (scenario === 'subnet_allocation_failure') {
        throw new Error(`Subnet allocation failed: ${errorMessage}`);
      }
      return {
        tapDevice: 'tap0',
        guestIp: '10.0.0.2',
        hostIp: '10.0.0.1',
        subnetMask: '255.255.255.252',
      };
    },

    async applyIptablesRules(_allocation: TapSubnetAllocation): Promise<void> {
      if (scenario === 'iptables_failure') {
        throw new Error(`Iptables rules failed: ${errorMessage}`);
      }
    },

    async releaseSubnet(_allocation: TapSubnetAllocation): Promise<void> {
      // Always succeeds for cleanup
    },
  };
}

/**
 * Creates a mock BlockDeviceManager that fails on image creation.
 */
function createFailingBlockDeviceManager(scenario: FailureScenario, errorMessage: string): BlockDeviceManager {
  return {
    async createImage(_instanceId: string, _sizeMb: number): Promise<string> {
      if (scenario === 'block_device_failure') {
        throw new Error(`Block device creation failed: ${errorMessage}`);
      }
      return `/var/lib/firecracker/images/test.ext4`;
    },

    async removeImage(_path: string): Promise<void> {
      // Always succeeds for cleanup
    },
  };
}

// --- Property 27 Tests ---

describe('Property 27: No Fallback to Non-Isolated Execution', () => {
  it('always rejects execution request with error status when Firecracker creation/start fails', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbFailureScenario,
        arbErrorMessage,
        arbExecutionRequest,
        async (scenario, errorMessage, request) => {
          const apiClient = createFailingApiClient(scenario, errorMessage);
          const networkManager = createFailingNetworkManager(scenario, errorMessage);
          const blockDeviceManager = createFailingBlockDeviceManager(scenario, errorMessage);

          const agent = new SandboxAgent(
            undefined,
            apiClient,
            networkManager,
            blockDeviceManager
          );

          const result = await agent.execute(request);

          // The execution request MUST be rejected with 'error' status
          expect(result.status).toBe('error');
        }
      ),
      { numRuns: 100 }
    );
  });

  it('never executes code outside of a microVM on any failure scenario', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbFailureScenario,
        arbErrorMessage,
        arbExecutionRequest,
        async (scenario, errorMessage, request) => {
          const apiClient = createFailingApiClient(scenario, errorMessage);
          const networkManager = createFailingNetworkManager(scenario, errorMessage);
          const blockDeviceManager = createFailingBlockDeviceManager(scenario, errorMessage);

          const agent = new SandboxAgent(
            undefined,
            apiClient,
            networkManager,
            blockDeviceManager
          );

          await agent.execute(request);

          // Code must NEVER be executed outside the microVM
          // The apiClient tracker shows if putAction (VM start) completed successfully
          // For all failure scenarios, either:
          // - isAvailable() returns false (hypervisor_unavailable)
          // - provisioning throws before VM start
          // - VM start itself throws
          // In none of these cases should code execute outside isolation
          expect(apiClient.codeExecuted).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('error result always contains a descriptive error message', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbFailureScenario,
        arbErrorMessage,
        arbExecutionRequest,
        async (scenario, errorMessage, request) => {
          const apiClient = createFailingApiClient(scenario, errorMessage);
          const networkManager = createFailingNetworkManager(scenario, errorMessage);
          const blockDeviceManager = createFailingBlockDeviceManager(scenario, errorMessage);

          const agent = new SandboxAgent(
            undefined,
            apiClient,
            networkManager,
            blockDeviceManager
          );

          const result = await agent.execute(request);

          // Error result must contain output with an error message
          expect(result.status).toBe('error');
          expect(result.output).toBeDefined();
          expect(typeof (result.output as { error: string }).error).toBe('string');
          expect((result.output as { error: string }).error.length).toBeGreaterThan(0);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('error result status is never "completed" regardless of failure type', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbFailureScenario,
        arbErrorMessage,
        arbExecutionRequest,
        async (scenario, errorMessage, request) => {
          const apiClient = createFailingApiClient(scenario, errorMessage);
          const networkManager = createFailingNetworkManager(scenario, errorMessage);
          const blockDeviceManager = createFailingBlockDeviceManager(scenario, errorMessage);

          const agent = new SandboxAgent(
            undefined,
            apiClient,
            networkManager,
            blockDeviceManager
          );

          const result = await agent.execute(request);

          // Must NEVER return 'completed' status when creation/start fails
          expect(result.status).not.toBe('completed');
          // Must also never return 'timeout' or 'resource_exceeded' since VM never started
          expect(result.status).not.toBe('timeout');
          expect(result.status).not.toBe('resource_exceeded');
        }
      ),
      { numRuns: 100 }
    );
  });
});
