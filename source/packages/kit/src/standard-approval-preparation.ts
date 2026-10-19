import type { StandardWorkflowPreparationContext } from "./standard-workflow-preparation.js";

export type StandardApprovalPreparationMethod =
  | "tbc_requestAccounts"
  | "wallet_requestPermissions"
  | "tbc_switchChain"
  | "tbc_signMessage"
  | "tbc_signTypedData"
  | "tbc_signTransaction"
  | "tbc_signPreparedTransaction"
  | "tbc_sendTransaction"
  | "tbc_sendPreparedTransaction"
  | "tbc_signWorkflow"
  | "tbc_signPreparedWorkflow"
  | "tbc_signReviewedTransaction"
  | "tbc_encrypt"
  | "tbc_decrypt";

export type StandardApprovalPreparationOperationKind =
  | "permission"
  | "switchChain"
  | "message"
  | "typedData"
  | "transaction"
  | "workflow"
  | "crypto";

export type StandardApprovalPreparationOutcome =
  | "complete"
  | "rejected"
  | "cancelled"
  | "failed"
  | "expired";

export type StandardApprovalPreparationDecision =
  | Readonly<{
      readonly status: "approved";
      /** Required for transaction/workflow approval if the request has no explicit fee cap. */
      readonly feeCapAtomic?: string;
    }>
  | Readonly<{ readonly status: "rejected" }>;

/** Exact public reviewed-request shape already visible before chain review. */
export interface StandardApprovalPreparationReviewedTransactionScope {
  readonly format: "raw" | "associated";
  readonly transactionCount: number;
  readonly dependencyCount: number;
  readonly warnings: readonly "MULTI_TRANSACTION"[];
}

export interface StandardApprovalPreparationStart {
  readonly requestId: string | number;
  readonly method: StandardApprovalPreparationMethod;
  readonly requestCount: number;
  /** Hash of the immutable input currently available to the wallet. */
  readonly inputHash: string;
}

/** Opaque, session-owned UI correlation. It grants no authority. */
export interface StandardApprovalPreparationHandle {
  readonly preparationId: string;
  readonly cancel: (outcome?: Extract<
    StandardApprovalPreparationOutcome,
    "cancelled" | "failed"
  >) => void;
}

export interface StandardApprovalPreparationPresentation {
  readonly begin: (input: Readonly<{
    preparationId: string;
    method: StandardApprovalPreparationMethod;
    requestCount: number;
    inputHash: string;
    startedAt: number;
    expiresAt: number;
    context: StandardWorkflowPreparationContext;
  }>) => void;
  /**
   * Shows the exact canonical request scope while non-authorizing material work
   * continues. Returning approved records bounded consent only; Core still
   * creates the formal approval binding and Kit rechecks the final preview.
   */
  readonly review: (input: Readonly<{
    preparationId: string;
    method: StandardApprovalPreparationMethod;
    operationKind: StandardApprovalPreparationOperationKind;
    requestHash: string;
    chainId?: string;
    accountId?: string;
    suggestedFeeCapAtomic?: string;
    requiresFeeCap: boolean;
    /** Fixed preview warnings derivable from this exact canonical request. */
    warningScope: readonly string[];
    /** Present only when the exact reviewed request safely determines this scope. */
    reviewedTransactionScope?: StandardApprovalPreparationReviewedTransactionScope;
    expiresAt: number;
    context: StandardWorkflowPreparationContext;
    request: unknown;
  }>) => Promise<StandardApprovalPreparationDecision>;
  readonly finish?: (input: Readonly<{
    preparationId: string;
    outcome: StandardApprovalPreparationOutcome;
  }>) => void;
}

/** Present only on the exact later formal approval Port call. */
export interface StandardApprovalPreparationApproval {
  readonly preparationId: string;
  readonly method: StandardApprovalPreparationMethod;
  readonly operationKind: StandardApprovalPreparationOperationKind;
  readonly requestHash: string;
  readonly startedAt: number;
  readonly state: "ready";
  readonly earlyConsent?: Readonly<{
    readonly status: "approved" | "rejected";
    readonly feeCapAtomic?: string;
  }>;
}
