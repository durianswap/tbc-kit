import type { TwsProtocolSchema } from "./generated/protocol-types.js";

export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer U)[]
    ? readonly DeepReadonly<U>[]
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T;

export type ProtocolType<K extends keyof TwsProtocolSchema> = DeepReadonly<
  TwsProtocolSchema[K]
>;

export type TransactionRequest = ProtocolType<"transactionRequest">;
export type SignedTransactionBundle = ProtocolType<"signedTransactionBundle">;
export type SchemaOperationCheckpoint = ProtocolType<"operationCheckpoint">;
export type SchemaCoreTransition = ProtocolType<"coreTransition">;
export type StartInput = ProtocolType<"startInput">;
export type ResumeInput = ProtocolType<"resumeInput">;
export type CommitAckInput = ProtocolType<"commitAckInput">;
export type CancelInput = ProtocolType<"cancelInput">;
export type PortError = ProtocolType<"portError">;
export type NormalizeRequestParams = ProtocolType<"normalizeRequestParams">;
export type NormalizeRequestResult = ProtocolType<"normalizeRequestResult">;
export type PlanParams = ProtocolType<"planParams">;
export type PlanResult = ProtocolType<"planResult">;
export type ValidateParams = ProtocolType<"validateParams">;
export type ValidationResult = ProtocolType<"validationResult">;
export type FinalizeParams = ProtocolType<"finalizeParams">;
export type FinalizeResult = ProtocolType<"finalizeResult">;
export type AccountsResolveParams = ProtocolType<"accountsResolveParams">;
export type AccountsResolveResult = ProtocolType<"accountsResolveResult">;
export type ChainDataResolveParams = ProtocolType<"chainDataResolveParams">;
export type ChainDataResolveResult = ProtocolType<"chainDataResolveResult">;
export type PolicyResolveParams = ProtocolType<"policyResolveParams">;
export type PolicyResolveResult = ProtocolType<"policyResolveResult">;
export type PermissionStoreLoadParams = ProtocolType<"permissionStoreLoadParams">;
export type PermissionStoreLoadResult = ProtocolType<"permissionStoreLoadResult">;
export type PermissionStoreCommitParams = ProtocolType<"permissionStoreCommitParams">;
export type PermissionStoreCommitResult = ProtocolType<"permissionStoreCommitResult">;
export type ApprovalRequestParams = ProtocolType<"approvalRequestParams">;
export type ApprovalRequestResult = ProtocolType<"approvalRequestResult">;
export type SignerSignParams = ProtocolType<"signerSignParams">;
export type SignerSignResult = ProtocolType<"signerSignResult">;
export type CryptoExecuteParams = ProtocolType<"cryptoExecuteParams">;
export type CryptoExecuteResult = ProtocolType<"cryptoExecuteResult">;
export type ReviewedTransactionReviewParams = ProtocolType<"reviewedTransactionReviewParams">;
export type ReviewedTransactionReviewResult = ProtocolType<"reviewedTransactionReviewResult">;
export type ReviewedTransactionExecuteParams = ProtocolType<"reviewedTransactionExecuteParams">;
export type ReviewedTransactionExecuteResult = ProtocolType<"reviewedTransactionExecuteResult">;
export type BroadcastSubmitParams = ProtocolType<"broadcastSubmitParams">;
export type BroadcastSubmitResult = ProtocolType<"broadcastSubmitResult">;
export type BroadcastSubmitBatchParams = ProtocolType<"broadcastSubmitBatchParams">;
export type BroadcastSubmitBatchResult = ProtocolType<"broadcastSubmitBatchResult">;
export type BroadcastReconcileParams = ProtocolType<"broadcastReconcileParams">;
export type BroadcastReconcileResult = ProtocolType<"broadcastReconcileResult">;
export type ClockNowParams = ProtocolType<"clockNowParams">;
export type ClockNowResult = ProtocolType<"clockNowResult">;
export type EntropyRandomBytesParams = ProtocolType<"entropyRandomBytesParams">;
export type EntropyRandomBytesResult = ProtocolType<"entropyRandomBytesResult">;
export type WorkflowResult = ProtocolType<"workflowResult">;
export type WorkflowSendResult = ProtocolType<"workflowSendResult">;
