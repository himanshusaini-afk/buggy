/**
 * Proof-of-failure verification types.
 */

export interface ProofOfFailureCertificate {
  test_input: unknown;
  observed_output: unknown;
  violated_postcondition: string;
  admissibility_verified_at: string;
  soundness_verified_at: string;
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
  uniqueness: boolean;
  certified: boolean;
  certificate?: ProofOfFailureCertificate;
  failure_reason?: string;
}
