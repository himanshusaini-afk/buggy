import { describe, it, expect } from 'vitest';
import {
  validateOperation,
  enforcePassport,
  OapPassportSession,
  OapPassportRejection,
} from '../../src/sandbox/oap-passport.js';
import { OapPassport } from '../../src/types/sandbox.js';

/**
 * Unit tests for OAP Passport permission enforcement.
 * Validates: Requirements 15.4
 */

function createValidPassport(permittedOps: string[]): OapPassport {
  const now = new Date();
  const future = new Date(now.getTime() + 3600_000); // 1 hour from now
  return {
    agent_id: 'test-agent-001',
    permitted_operations: permittedOps,
    issued_at: now.toISOString(),
    expires_at: future.toISOString(),
  };
}

function createExpiredPassport(permittedOps: string[]): OapPassport {
  const past = new Date(Date.now() - 7200_000); // 2 hours ago
  const expiredAt = new Date(Date.now() - 3600_000); // 1 hour ago
  return {
    agent_id: 'expired-agent',
    permitted_operations: permittedOps,
    issued_at: past.toISOString(),
    expires_at: expiredAt.toISOString(),
  };
}

describe('OAP Passport - validateOperation', () => {
  it('allows an operation that is in the permitted_operations list', () => {
    const passport = createValidPassport(['read', 'write', 'execute']);
    const result = validateOperation(passport, 'read');
    expect(result.allowed).toBe(true);
  });

  it('allows all operations that are in the permitted_operations list', () => {
    const ops = ['read', 'write', 'execute', 'delete'];
    const passport = createValidPassport(ops);

    for (const op of ops) {
      const result = validateOperation(passport, op);
      expect(result.allowed).toBe(true);
    }
  });

  it('rejects an operation not in the permitted_operations list', () => {
    const passport = createValidPassport(['read', 'write']);
    const result = validateOperation(passport, 'delete');

    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.rejection.code).toBe('OPERATION_NOT_PERMITTED');
      expect(result.rejection.agent_id).toBe('test-agent-001');
      expect(result.rejection.operation).toBe('delete');
      expect(result.rejection.permitted_operations).toEqual(['read', 'write']);
      expect(result.rejection.message).toContain('delete');
      expect(result.rejection.message).toContain('not permitted');
    }
  });

  it('rejects any operation when permitted_operations is empty', () => {
    const passport = createValidPassport([]);
    const result = validateOperation(passport, 'read');

    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.rejection.code).toBe('OPERATION_NOT_PERMITTED');
      expect(result.rejection.operation).toBe('read');
    }
  });

  it('rejects operations when the passport is expired', () => {
    const passport = createExpiredPassport(['read', 'write', 'execute']);
    const result = validateOperation(passport, 'read');

    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.rejection.code).toBe('OPERATION_NOT_PERMITTED');
      expect(result.rejection.message).toContain('expired');
    }
  });

  it('returns structured rejection error with all required fields', () => {
    const passport = createValidPassport(['read']);
    const result = validateOperation(passport, 'write');

    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      const rejection = result.rejection;
      expect(rejection).toHaveProperty('code');
      expect(rejection).toHaveProperty('agent_id');
      expect(rejection).toHaveProperty('operation');
      expect(rejection).toHaveProperty('permitted_operations');
      expect(rejection).toHaveProperty('message');
    }
  });

  it('performs exact string matching on operations', () => {
    const passport = createValidPassport(['read_file']);
    
    // Exact match succeeds
    expect(validateOperation(passport, 'read_file').allowed).toBe(true);
    
    // Partial/different cases are rejected
    expect(validateOperation(passport, 'read').allowed).toBe(false);
    expect(validateOperation(passport, 'READ_FILE').allowed).toBe(false);
    expect(validateOperation(passport, 'read_file ').allowed).toBe(false);
  });
});

describe('OAP Passport - enforcePassport', () => {
  it('does not throw for permitted operations', () => {
    const passport = createValidPassport(['execute', 'read']);
    expect(() => enforcePassport(passport, 'execute')).not.toThrow();
    expect(() => enforcePassport(passport, 'read')).not.toThrow();
  });

  it('throws OapPassportRejection for non-permitted operations', () => {
    const passport = createValidPassport(['read']);

    try {
      enforcePassport(passport, 'write');
      expect.fail('Should have thrown');
    } catch (err) {
      const rejection = err as OapPassportRejection;
      expect(rejection.code).toBe('OPERATION_NOT_PERMITTED');
      expect(rejection.agent_id).toBe('test-agent-001');
      expect(rejection.operation).toBe('write');
      expect(rejection.permitted_operations).toEqual(['read']);
    }
  });

  it('throws for expired passport even if operation is in the list', () => {
    const passport = createExpiredPassport(['read', 'write']);

    try {
      enforcePassport(passport, 'read');
      expect.fail('Should have thrown');
    } catch (err) {
      const rejection = err as OapPassportRejection;
      expect(rejection.code).toBe('OPERATION_NOT_PERMITTED');
      expect(rejection.message).toContain('expired');
    }
  });
});

describe('OAP Passport - OapPassportSession', () => {
  it('creates a session from a passport', () => {
    const passport = createValidPassport(['read', 'write']);
    const session = new OapPassportSession(passport);

    expect(session.agentId).toBe('test-agent-001');
    expect(session.permittedOperations).toEqual(['read', 'write']);
  });

  it('isOperationPermitted returns true for permitted operations', () => {
    const passport = createValidPassport(['read', 'write', 'execute']);
    const session = new OapPassportSession(passport);

    expect(session.isOperationPermitted('read')).toBe(true);
    expect(session.isOperationPermitted('write')).toBe(true);
    expect(session.isOperationPermitted('execute')).toBe(true);
  });

  it('isOperationPermitted returns false for non-permitted operations', () => {
    const passport = createValidPassport(['read']);
    const session = new OapPassportSession(passport);

    expect(session.isOperationPermitted('write')).toBe(false);
    expect(session.isOperationPermitted('delete')).toBe(false);
  });

  it('validateOperation returns structured result', () => {
    const passport = createValidPassport(['read']);
    const session = new OapPassportSession(passport);

    const allowed = session.validateOperation('read');
    expect(allowed.allowed).toBe(true);

    const rejected = session.validateOperation('write');
    expect(rejected.allowed).toBe(false);
    if (!rejected.allowed) {
      expect(rejected.rejection.code).toBe('OPERATION_NOT_PERMITTED');
    }
  });

  it('enforceOperation throws for non-permitted operations', () => {
    const passport = createValidPassport(['read']);
    const session = new OapPassportSession(passport);

    expect(() => session.enforceOperation('read')).not.toThrow();
    expect(() => session.enforceOperation('write')).toThrow();
  });

  it('returns a copy of permitted operations (immutable)', () => {
    const passport = createValidPassport(['read', 'write']);
    const session = new OapPassportSession(passport);

    const ops = session.permittedOperations;
    ops.push('delete');

    // Original should not be affected
    expect(session.permittedOperations).toEqual(['read', 'write']);
  });
});
