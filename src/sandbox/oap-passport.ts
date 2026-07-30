/**
 * OAP (Open Agent Policy) Passport permission enforcement.
 *
 * Attaches an OAP Passport to each agent session and enforces that only
 * operations explicitly listed in the passport's `permitted_operations`
 * are allowed. Any operation not in the list is rejected with a structured error.
 *
 * Requirements: 15.4
 */

import { OapPassport } from '../types/sandbox.js';

/**
 * Structured error returned when an operation is rejected by the OAP Passport.
 */
export interface OapPassportRejection {
  code: 'OPERATION_NOT_PERMITTED';
  agent_id: string;
  operation: string;
  permitted_operations: string[];
  message: string;
}

/**
 * Result of a passport validation check.
 */
export type PassportValidationResult =
  | { allowed: true }
  | { allowed: false; rejection: OapPassportRejection };

/**
 * Validates whether an operation is permitted under the given OAP Passport.
 *
 * @param passport - The OAP Passport attached to the agent session
 * @param operation - The operation being requested
 * @returns A result indicating whether the operation is allowed or rejected
 */
export function validateOperation(
  passport: OapPassport,
  operation: string
): PassportValidationResult {
  const now = new Date();
  const expiresAt = new Date(passport.expires_at);

  if (now > expiresAt) {
    return {
      allowed: false,
      rejection: {
        code: 'OPERATION_NOT_PERMITTED',
        agent_id: passport.agent_id,
        operation,
        permitted_operations: passport.permitted_operations,
        message: `OAP Passport for agent '${passport.agent_id}' has expired (expired at ${passport.expires_at}). Operation '${operation}' rejected.`,
      },
    };
  }

  if (!passport.permitted_operations.includes(operation)) {
    return {
      allowed: false,
      rejection: {
        code: 'OPERATION_NOT_PERMITTED',
        agent_id: passport.agent_id,
        operation,
        permitted_operations: passport.permitted_operations,
        message: `Operation '${operation}' is not permitted for agent '${passport.agent_id}'. Permitted operations: [${passport.permitted_operations.join(', ')}].`,
      },
    };
  }

  return { allowed: true };
}

/**
 * Enforces OAP Passport permissions for an operation.
 * Throws if the operation is not permitted.
 *
 * @param passport - The OAP Passport attached to the agent session
 * @param operation - The operation being requested
 * @throws OapPassportRejection when the operation is not permitted
 */
export function enforcePassport(
  passport: OapPassport,
  operation: string
): void {
  const result = validateOperation(passport, operation);
  if (!result.allowed) {
    throw result.rejection;
  }
}

/**
 * OAP Passport session manager.
 * Manages a passport for an agent session and enforces permissions on each operation.
 */
export class OapPassportSession {
  private readonly passport: OapPassport;

  constructor(passport: OapPassport) {
    this.passport = passport;
  }

  /**
   * Returns the agent ID associated with this passport session.
   */
  get agentId(): string {
    return this.passport.agent_id;
  }

  /**
   * Returns the list of permitted operations for this session.
   */
  get permittedOperations(): string[] {
    return [...this.passport.permitted_operations];
  }

  /**
   * Checks whether an operation is permitted without throwing.
   */
  isOperationPermitted(operation: string): boolean {
    const result = validateOperation(this.passport, operation);
    return result.allowed;
  }

  /**
   * Validates an operation and returns the full result.
   */
  validateOperation(operation: string): PassportValidationResult {
    return validateOperation(this.passport, operation);
  }

  /**
   * Enforces the passport for the given operation.
   * Throws OapPassportRejection if not permitted.
   */
  enforceOperation(operation: string): void {
    enforcePassport(this.passport, operation);
  }
}
