export interface OperationIdInput {
    readonly releaseFingerprint: string;
    readonly contextHash: string;
    readonly requestId: unknown;
    readonly operation: unknown;
}
export declare function deriveOperationId(input: OperationIdInput): string;
export interface CallIdInput {
    readonly operationId: string;
    readonly checkpointRevision: string;
    readonly effectOrdinal: string;
    readonly operationName: string;
}
export declare function deriveCallId(input: CallIdInput): string;
export interface PermissionIdInput {
    readonly operationId: string;
    readonly chainId: string;
    readonly parentCapability: string;
    readonly ordinal: number;
}
export declare function derivePermissionId(input: PermissionIdInput): string;
export interface BroadcastIdempotencyKeyInput {
    readonly operationId: string;
    readonly txid: string;
}
export declare function deriveBroadcastIdempotencyKey(input: BroadcastIdempotencyKeyInput): string;
export interface ProviderCommitIdInput {
    readonly operationId: string;
    readonly checkpointRevision: string;
    readonly mutationPayload: unknown;
}
export declare function deriveProviderCommitId(input: ProviderCommitIdInput): string;
