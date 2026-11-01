import type { KitTransactionRequest, Tbc721StandardBatchMintIntent, Tbc721StandardMintItem } from "./public-types.js";
export interface TbcNftMintJobAuthority {
    readonly chainId: `tbc:${string}`;
    readonly accountId: string;
    readonly address: string;
    readonly origin: string;
    readonly sessionId: string;
}
export interface TbcNftMintJobLimits {
    /** Atomic units, across every sub-batch; not a fresh allowance per sub-batch. */
    readonly maxTotalFee: string;
    readonly expiresAt: string;
    readonly maxItemsPerBatch?: number;
    /** Local serialized Engine plan budget. Cannot exceed the Engine's 4 MiB bound. */
    readonly maxPlanBytes?: number;
    readonly maxTotalPlanBytes?: number;
}
export interface TbcNftMintJobScope {
    readonly operationKind: "tbc721.batchMint";
    readonly authority: TbcNftMintJobAuthority;
    readonly collectionId: string;
    /** Ordered, immutable and with every recipient made explicit before consent. */
    readonly items: readonly Tbc721StandardMintItem[];
    readonly limits: Readonly<Required<TbcNftMintJobLimits>>;
}
export type TbcNftMintJobApproval = Readonly<{
    status: "rejected";
    scopeHash: string;
}> | Readonly<{
    status: "approved";
    scopeHash: string;
    approvalId: string;
    approvedAt: string;
    expiresAt: string;
}>;
export interface TbcNftMintJobPreparedBatch {
    readonly status: "ready";
    readonly request: KitTransactionRequest<Tbc721StandardBatchMintIntent>;
    readonly planHash: string;
    readonly totalFee: string;
    readonly transactionCount: number;
    readonly serializedPlanBytes: number;
    /** Opaque, exact, unsigned material owned by the shared executor, never page assertions. */
    readonly prepared: unknown;
}
export type TbcNftMintJobPreparation = TbcNftMintJobPreparedBatch | Readonly<{
    /** Only the shared planner's proven byte/resource excess may produce this result. */
    status: "resource-limit";
    resource: "plan-bytes" | "continuation-bytes" | "inputs" | "outputs";
}>;
export interface TbcNftMintJobTransaction {
    readonly txid: string;
    readonly fee: string;
    readonly status: "accepted" | "known" | "uncertain" | "rejected" | "not-submitted";
}
export interface TbcNftMintJobExecution {
    readonly status: "complete" | "partial" | "uncertain" | "failed" | "pending";
    readonly transactions: readonly TbcNftMintJobTransaction[];
    readonly recoveryId?: string;
    /** Validated signed parents/change, for the next prepare; never refetched from the API. */
    readonly continuation?: unknown;
}
export interface TbcNftMintJobBatchResult {
    readonly offset: number;
    readonly count: number;
    readonly planHash: string;
    readonly status: TbcNftMintJobExecution["status"];
    readonly transactions: readonly TbcNftMintJobTransaction[];
    readonly recoveryId?: string;
}
export type TbcNftMintJobStopReason = "complete" | "rejected" | "cancelled" | "expired" | "authority-changed" | "preparation-failed" | "resource-limit" | "fee-budget" | "execution-failed" | "operation-pending" | "submission-uncertain";
export interface TbcNftMintJobResult {
    readonly status: "complete" | "partial" | "stopped" | "uncertain";
    readonly reason: TbcNftMintJobStopReason;
    readonly scopeHash: string;
    readonly requested: number;
    /** Only accepted/known transactions count as minted, never an unknown POST. */
    readonly minted: number;
    readonly confirmedSubmissionFee: string;
    readonly batches: readonly TbcNftMintJobBatchResult[];
}
export interface TbcNftMintJobAdapter {
    /** The composition must permission-gate the job before this read or the consent UI. */
    readonly begin: (scope: TbcNftMintJobScope) => Promise<unknown>;
    readonly approve: (input: Readonly<{
        scope: TbcNftMintJobScope;
        scopeHash: string;
    }>) => Promise<TbcNftMintJobApproval>;
    /** Wallet-owned live origin/session/account check. Not a network observation. */
    readonly assertAuthority: (scope: TbcNftMintJobScope) => Promise<void>;
    readonly prepare: (input: Readonly<{
        scope: TbcNftMintJobScope;
        scopeHash: string;
        request: KitTransactionRequest<Tbc721StandardBatchMintIntent>;
        offset: number;
        context: unknown;
        continuation?: unknown;
    }>) => Promise<TbcNftMintJobPreparation>;
    /**
     * Reuse Core/Host's exact binding, Signer, Engine validation and broadcaster.
     * This consent is not a signing credential: issue/check the exact per-plan
     * credential without another UI. Unknown effects must retain their journal.
     */
    readonly execute: (input: Readonly<{
        scope: TbcNftMintJobScope;
        scopeHash: string;
        approval: Extract<TbcNftMintJobApproval, {
            status: "approved";
        }>;
        batch: TbcNftMintJobPreparedBatch;
        offset: number;
        context: unknown;
        signal?: AbortSignal;
    }>) => Promise<TbcNftMintJobExecution>;
}
/** Synchronous: take ownership and validate every item before any asynchronous callback. */
export declare function createTbcNftMintJobScope(input: Readonly<{
    authority: TbcNftMintJobAuthority;
    collectionId: string;
    items: readonly Tbc721StandardMintItem[];
    limits: TbcNftMintJobLimits;
}>): TbcNftMintJobScope;
/**
 * Task-scoped coordinator, with no UI, keys, persistence, fetch or automatic
 * retry. It selects exact contiguous slices of a single immutable consent.
 * The default wallet composition supplies the existing shared executor.
 */
export declare function createTbcNftMintJobOrchestrator(adapter: TbcNftMintJobAdapter, options?: Readonly<{
    now?: () => number;
    /** Executor-local work budget; may only narrow the approved per-batch maximum. */
    executionBatchSize?: number;
}>): Readonly<{
    run(input: Parameters<typeof createTbcNftMintJobScope>[0] & Readonly<{
        signal?: AbortSignal;
    }>): Promise<TbcNftMintJobResult>;
}>;
