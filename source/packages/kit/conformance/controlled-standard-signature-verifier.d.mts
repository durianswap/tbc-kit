export interface ControlledReviewedVerificationInput {
  readonly request: unknown;
  readonly result: unknown;
  readonly publicKey: string;
}

export interface ControlledReviewedVerificationSummary {
  readonly valid: true;
  readonly kind: "raw" | "associated";
  readonly transactionCount: 1 | 2;
  readonly verifiedInputCount: 1 | 2;
  readonly dependencyCount: 0 | 1;
  readonly outputsMatch: true;
}

export declare class ControlledSignatureVerificationError extends Error {}

export declare function verifyControlledReviewedResult(
  input: ControlledReviewedVerificationInput,
): ControlledReviewedVerificationSummary;
