export type TbcMultiRoundMergeAsset = Readonly<{
    readonly kind: "tbc";
}> | Readonly<{
    readonly kind: "ft";
    readonly contractId: string;
}> | Readonly<{
    readonly kind: "stablecoin";
    readonly contractId: string;
}> | Readonly<{
    readonly kind: "pool-ft";
    readonly poolContractId: string;
}> | Readonly<{
    readonly kind: "ftlp";
    readonly poolContractId: string;
}>;
export interface TbcMultiRoundMergePoolIdentity {
    readonly poolContractId: string;
    readonly ftContractId: string;
    readonly currentPoolTxid: string;
}
export interface TbcMultiRoundMergeImpact {
    readonly custody: "active-account" | "pool-contract";
    readonly resultOwner: "active-account" | "pool-contract";
    readonly maxAssetInputsPerTransaction: number;
    readonly poolIdentity?: TbcMultiRoundMergePoolIdentity;
}
export interface TbcMultiRoundMergeAuthority {
    readonly chainId: `tbc:${string}`;
    readonly accountId: string;
    readonly origin: string;
    readonly sessionId: string;
}
export interface TbcMultiRoundMergeLimits {
    readonly targetUtxoCount: number;
    readonly maxTransactions: number;
    readonly maxTotalFee: string;
    readonly expiresAt: string;
    /** Maximum bounded index refreshes after one accepted transaction. */
    readonly maxIndexRefreshes?: number;
    /** Delay is delegated so React Native and browser hosts retain clock control. */
    readonly indexRefreshDelayMs?: number;
}
export interface TbcMultiRoundMergeState {
    readonly version: "1.0";
    readonly authority: TbcMultiRoundMergeAuthority;
    readonly asset: TbcMultiRoundMergeAsset;
    readonly observedAt: string;
    readonly revision: string;
    readonly utxoCount: number;
    /** Required for Pool assets and derived from the authoritative Pool index. */
    readonly poolIdentity?: TbcMultiRoundMergePoolIdentity;
    /** Stable hash of the authoritative index identity; observation time is excluded. */
    readonly stateHash: string;
    /** Accepted parent transactions actually represented by this index view. */
    readonly observedTransactionIds: readonly string[];
}
/** Derive the stable state identity used across bounded index refreshes. */
export declare function hashTbcMultiRoundMergeState(state: Omit<TbcMultiRoundMergeState, "stateHash">): string;
export interface TbcMultiRoundMergeScope {
    readonly version: "1.0";
    readonly operationKind: "multi-round-merge";
    readonly authority: TbcMultiRoundMergeAuthority;
    readonly asset: TbcMultiRoundMergeAsset;
    /** Approval-display semantics; Pool-held FT remains owned by the Pool. */
    readonly impact: TbcMultiRoundMergeImpact;
    readonly limits: Readonly<Required<TbcMultiRoundMergeLimits>>;
    readonly initialStateHash: string;
    readonly initialUtxoCount: number;
}
export interface TbcMultiRoundMergeApprovalRequest {
    readonly scope: TbcMultiRoundMergeScope;
    readonly scopeHash: string;
}
export type TbcMultiRoundMergeApprovalDecision = Readonly<{
    readonly status: "rejected";
    readonly scopeHash: string;
}> | Readonly<{
    readonly status: "approved";
    readonly scopeHash: string;
    readonly approvalId: string;
    readonly approvedAt: string;
    readonly expiresAt: string;
}>;
export interface TbcMultiRoundMergePreparedStep {
    readonly version: "1.0";
    readonly stepId: string;
    readonly stepIndex: number;
    readonly authority: TbcMultiRoundMergeAuthority;
    readonly asset: TbcMultiRoundMergeAsset;
    readonly stateHash: string;
    readonly materialHash: string;
    readonly inputCount: number;
    readonly outputCount: 1;
    /** Production composition uses a remaining-budget cap until Engine returns the exact fee. */
    readonly feeKind?: "exact" | "maximum";
    readonly fee: string;
    readonly expiresAt: string;
    /** Only earlier transactions in this same approved run may appear here. */
    readonly dependsOn: readonly string[];
    /** Opaque exact prepared material consumed once by the Kit execution adapter. */
    readonly prepared: unknown;
}
export type TbcMultiRoundMergeExecutionResult = Readonly<{
    readonly status: "accepted" | "known" | "uncertain";
    readonly stepId: string;
    readonly materialHash: string;
    readonly txid: string;
    readonly fee: string;
    readonly inputsConsumed: number;
    readonly outputsCreated: 1;
}> | Readonly<{
    readonly status: "rejected" | "failed";
    readonly stepId: string;
    readonly materialHash: string;
    readonly error: string;
}> | Readonly<{
    /** A durable pre-broadcast Host operation still owns this exact step. */
    readonly status: "pending";
    readonly stepId: string;
    readonly materialHash: string;
    readonly recoveryId: string;
    readonly error: string;
}>;
export type TbcMultiRoundMergeReconcileResult = Readonly<{
    readonly txid: string;
    readonly status: "known" | "rejected" | "unknown";
}>;
export interface TbcMultiRoundMergeStepResult {
    readonly stepId: string;
    readonly txid?: string;
    /** Durable Host operation identity retained when submit outcome is uncertain. */
    readonly recoveryId?: string;
    readonly status: "accepted" | "known" | "rejected" | "failed" | "pending" | "uncertain";
    readonly fee: string;
    readonly inputCount: number;
    readonly outputCount: 1;
    readonly dependsOn: readonly string[];
}
export type TbcMultiRoundMergeStopReason = "target-reached" | "already-below-target" | "approval-rejected" | "cancelled" | "expired" | "transaction-budget-exhausted" | "fee-budget-exhausted" | "index-stalled" | "facts-changed" | "step-rejected" | "step-failed" | "operation-pending" | "broadcast-uncertain";
export interface TbcMultiRoundMergeResult {
    readonly version: "1.0";
    readonly status: "complete" | "partial" | "stopped" | "uncertain";
    readonly reason: TbcMultiRoundMergeStopReason;
    readonly scopeHash: string;
    readonly approvalId?: string;
    readonly initialUtxoCount: number;
    readonly finalUtxoCount: number;
    readonly totalFee: string;
    readonly steps: readonly TbcMultiRoundMergeStepResult[];
}
export interface TbcMultiRoundMergeProgress {
    readonly phase: "approval" | "preparing" | "executing" | "reconciling" | "indexing" | "complete";
    readonly stepIndex: number;
    readonly utxoCount: number;
    readonly targetUtxoCount: number;
    readonly transactionCount: number;
    readonly totalFee: string;
}
export interface TbcMultiRoundMergeAdapter {
    /** Must be permission-gated by the wallet before this orchestrator is exposed to a page. */
    readonly readState: (authority: TbcMultiRoundMergeAuthority, asset: TbcMultiRoundMergeAsset) => Promise<TbcMultiRoundMergeState>;
    /** One bounded consent. It is not a reusable wallet permission. */
    readonly approve: (request: TbcMultiRoundMergeApprovalRequest) => Promise<TbcMultiRoundMergeApprovalDecision>;
    /**
     * Uses the existing Kit Chain Data, policy and Engine planning path. The
     * returned exact material is still unsigned and unsubmitted.
     */
    readonly prepareStep: (input: Readonly<{
        scope: TbcMultiRoundMergeScope;
        scopeHash: string;
        approval: Extract<TbcMultiRoundMergeApprovalDecision, {
            status: "approved";
        }>;
        state: TbcMultiRoundMergeState;
        stepIndex: number;
        remainingFee: string;
        acceptedTxids: readonly string[];
    }>) => Promise<TbcMultiRoundMergePreparedStep>;
    /**
     * Must consume `prepared` once through the shared Kit approval/Signer/Engine/
     * broadcast path and bind the formal per-step approval to `materialHash`.
     */
    readonly executePreparedStep: (input: Readonly<{
        scope: TbcMultiRoundMergeScope;
        scopeHash: string;
        approval: Extract<TbcMultiRoundMergeApprovalDecision, {
            status: "approved";
        }>;
        step: TbcMultiRoundMergePreparedStep;
    }>) => Promise<TbcMultiRoundMergeExecutionResult>;
    /** Unknown POST outcomes enter only this path; the step is never re-executed. */
    readonly reconcile: (input: Readonly<{
        scope: TbcMultiRoundMergeScope;
        scopeHash: string;
        approval: Extract<TbcMultiRoundMergeApprovalDecision, {
            status: "approved";
        }>;
        step: TbcMultiRoundMergePreparedStep;
        txid: string;
    }>) => Promise<TbcMultiRoundMergeReconcileResult>;
    readonly waitForIndex?: (input: Readonly<{
        attempt: number;
        delayMs: number;
        txid: string;
    }>) => Promise<void>;
    /** Wallet-owned live authority check performed immediately before execution. */
    readonly assertAuthority?: (input: Readonly<{
        scope: TbcMultiRoundMergeScope;
        scopeHash: string;
        approval: Extract<TbcMultiRoundMergeApprovalDecision, {
            status: "approved";
        }>;
        step: TbcMultiRoundMergePreparedStep;
    }>) => Promise<void>;
}
export interface TbcMultiRoundMergeRunInput {
    readonly authority: TbcMultiRoundMergeAuthority;
    readonly asset: TbcMultiRoundMergeAsset;
    readonly limits: TbcMultiRoundMergeLimits;
    readonly signal?: AbortSignal;
    readonly onProgress?: (progress: TbcMultiRoundMergeProgress) => void;
}
export declare class TbcMultiRoundMergeConflictError extends Error {
    readonly name = "TbcMultiRoundMergeConflictError";
}
export declare class TbcMultiRoundMergeInputError extends TypeError {
    readonly name = "TbcMultiRoundMergeInputError";
}
/** Validate a page-visible bounded request before permission or private index I/O. */
export declare function assertTbcMultiRoundMergeInput(input: Readonly<{
    asset: TbcMultiRoundMergeAsset;
    limits: TbcMultiRoundMergeLimits;
}>, now?: number): void;
export declare function createTbcMultiRoundMergeOrchestrator(adapter: TbcMultiRoundMergeAdapter, options?: Readonly<{
    readonly now?: () => number;
}>): Readonly<{
    readonly run: (input: TbcMultiRoundMergeRunInput) => Promise<TbcMultiRoundMergeResult>;
}>;
//# sourceMappingURL=multi-round-merge.d.ts.map