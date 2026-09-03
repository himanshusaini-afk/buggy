/**
 * Proof-of-failure verification types.
 */

export interface ProofOfFailureCertificate {
  test_input: unknown;
  observed_output: unknown;
  violated_postcondition: string;
  admissibility_verified_at: string;
  soundness_verified_at: string;
  /**
   * Timestamp when the third proof pillar was verified. That pillar is now
   * Feasibility (a spec-satisfying output exists in the declared domain, proving
   * the observed violation is a genuine code failure rather than an unsatisfiable
   * specification). The field keeps its legacy `uniqueness_verified_at` name for
   * backward compatibility with the persisted proof_certificates schema.
   */
  uniqueness_verified_at: string;
}

export interface ProofCandidate {
  test_input: unknown;
  observed_output: unknown;
  postconditions: string[];
  violated_postcondition: string;
}

export interface ProofVerificationResult {
  admissibility: boolean;
  soundness: boolean;
  feasibility: boolean;
  certified: boolean;
  certificate?: ProofOfFailureCertificate;
  failure_reason?: string;
}
