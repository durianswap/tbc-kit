export declare const TWS_VALIDATOR_NAMES: readonly ["signReviewedTransactionRequest", "encryptRequest", "decryptRequest", "startInput", "resumeInput", "commitAckInput", "cancelInput", "operationCheckpoint", "portResponse", "coreTransition", "accountsResolveResult", "chainDataResolveResult", "chainDataResolveParams", "policyResolveResult", "permissionStoreLoadResult", "permissionStoreCommitResult", "approvalRequestResult", "signerSignResult", "cryptoExecuteResult", "reviewedTransactionReviewResult", "reviewedTransactionExecuteResult", "broadcastSubmitResult", "broadcastSubmitBatchResult", "broadcastReconcileResult", "clockNowResult", "entropyRandomBytesResult", "getAccountParams", "getCapabilitiesParams", "switchChainParams", "messageRequest", "typedDataRequest", "transactionRequest", "preparedTransactionRequest", "workflowRequest", "preparedWorkflowRequest", "requestPermissionsParams", "approvalBinding", "approvalPreview", "approvalRequestParams", "approvalReceipt", "normalizeRequestParams", "normalizeRequestResult", "planParams", "planResult", "validateParams", "validationResult", "finalizeParams", "finalizeResult", "signedTransactionBundle", "submittedTransactionBundle"];
export type TwsValidatorName = (typeof TWS_VALIDATOR_NAMES)[number];
export interface TwsValidationIssue {
    readonly instancePath: string;
    readonly schemaPath: string;
    readonly keyword: string;
    readonly message?: string;
}
export declare class TwsValidationError extends TypeError {
    readonly code: "TWS_SCHEMA_INVALID";
    readonly validator: TwsValidatorName;
    readonly issues: readonly TwsValidationIssue[];
    constructor(validator: TwsValidatorName, issues: readonly TwsValidationIssue[]);
}
export declare function isValidTws(name: TwsValidatorName, value: unknown): boolean;
export declare function assertValidTws(name: TwsValidatorName, value: unknown): void;
export declare function assertPortResult(operation: string, value: unknown): void;
export declare function assertTwsMethodParams(method: string, value: unknown): void;
