import type { AccountsResolveParams, AccountsResolveResult, ApprovalRequestParams, ApprovalRequestResult, BroadcastReconcileParams, BroadcastReconcileResult, BroadcastSubmitParams, BroadcastSubmitResult, BroadcastSubmitBatchParams, BroadcastSubmitBatchResult, ChainDataResolveParams, ChainDataResolveResult, ClockNowParams, ClockNowResult, CryptoExecuteParams, CryptoExecuteResult, ReviewedTransactionReviewParams, ReviewedTransactionReviewResult, ReviewedTransactionExecuteParams, ReviewedTransactionExecuteResult, EntropyRandomBytesParams, EntropyRandomBytesResult, PermissionStoreCommitParams, PermissionStoreCommitResult, PermissionStoreLoadParams, PermissionStoreLoadResult, PolicyResolveParams, PolicyResolveResult, PortError, SignerSignParams, SignerSignResult } from "./protocol-types.js";
export interface PortOperationMap {
    readonly "accounts.resolve": {
        readonly params: AccountsResolveParams;
        readonly result: AccountsResolveResult;
    };
    readonly "chainData.resolve": {
        readonly params: ChainDataResolveParams;
        readonly result: ChainDataResolveResult;
    };
    readonly "policy.resolve": {
        readonly params: PolicyResolveParams;
        readonly result: PolicyResolveResult;
    };
    readonly "permissionStore.load": {
        readonly params: PermissionStoreLoadParams;
        readonly result: PermissionStoreLoadResult;
    };
    readonly "permissionStore.commit": {
        readonly params: PermissionStoreCommitParams;
        readonly result: PermissionStoreCommitResult;
    };
    readonly "approval.request": {
        readonly params: ApprovalRequestParams;
        readonly result: ApprovalRequestResult;
    };
    readonly "signer.sign": {
        readonly params: SignerSignParams;
        readonly result: SignerSignResult;
    };
    readonly "crypto.execute": {
        readonly params: CryptoExecuteParams;
        readonly result: CryptoExecuteResult;
    };
    readonly "reviewedTransaction.review": {
        readonly params: ReviewedTransactionReviewParams;
        readonly result: ReviewedTransactionReviewResult;
    };
    readonly "reviewedTransaction.execute": {
        readonly params: ReviewedTransactionExecuteParams;
        readonly result: ReviewedTransactionExecuteResult;
    };
    readonly "broadcast.submit": {
        readonly params: BroadcastSubmitParams;
        readonly result: BroadcastSubmitResult;
    };
    readonly "broadcast.submitBatch": {
        readonly params: BroadcastSubmitBatchParams;
        readonly result: BroadcastSubmitBatchResult;
    };
    readonly "broadcast.reconcile": {
        readonly params: BroadcastReconcileParams;
        readonly result: BroadcastReconcileResult;
    };
    readonly "clock.now": {
        readonly params: ClockNowParams;
        readonly result: ClockNowResult;
    };
    readonly "entropy.randomBytes": {
        readonly params: EntropyRandomBytesParams;
        readonly result: EntropyRandomBytesResult;
    };
}
export declare const TWS_PORT_OPERATIONS: readonly ["accounts.resolve", "chainData.resolve", "policy.resolve", "permissionStore.load", "permissionStore.commit", "approval.request", "signer.sign", "crypto.execute", "reviewedTransaction.review", "reviewedTransaction.execute", "broadcast.submit", "broadcast.submitBatch", "broadcast.reconcile", "clock.now", "entropy.randomBytes"];
export type PortOperation = keyof PortOperationMap;
export type PortCall<K extends PortOperation = PortOperation> = K extends PortOperation ? Readonly<{
    version: "1.0";
    callId: string;
    operation: K;
    params: PortOperationMap[K]["params"];
}> : never;
export type AnyPortCall = PortCall<PortOperation>;
export type PortSuccess<K extends PortOperation = PortOperation> = K extends PortOperation ? Readonly<{
    version: "1.0";
    callId: string;
    result: PortOperationMap[K]["result"];
    error?: never;
}> : never;
export type PortFailure = Readonly<{
    version: "1.0";
    callId: string;
    result?: never;
    error: PortError;
}>;
export type PortResponse<K extends PortOperation = PortOperation> = PortSuccess<K> | PortFailure;
export declare function createPortCall<K extends PortOperation>(input: {
    readonly operationId: string;
    readonly checkpointRevision: string;
    readonly effectOrdinal: number;
    readonly operation: K;
    readonly params: PortOperationMap[K]["params"];
}): PortCall<K>;
