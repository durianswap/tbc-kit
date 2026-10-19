export type CancellationReason = "USER_REJECTED" | "REQUEST_ABORTED" | "REQUEST_EXPIRED" | "SESSION_REVOKED" | "NAVIGATION_CHANGED" | "ORIGIN_CHANGED" | "CHAIN_CHANGED" | "ACCOUNT_CHANGED" | "TRANSPORT_CLOSED" | "SNAPSHOT_INVALIDATED" | "PROTOCOL_RELEASE_CHANGED";
export type CancellationTerminalState = "completed" | "rejected" | "failed" | "cancelled";
export interface CancellationPolicy {
    readonly terminalState: CancellationTerminalState;
    readonly delivery: "respond" | "suppress";
    readonly providerCode: number | null;
    readonly executionErrorName: "REQUEST_EXPIRED" | "CONFLICT" | null;
    readonly retryable: boolean;
}
export declare function isCancelAuthorityOptional(reason: CancellationReason): boolean;
export declare function cancellationPolicy(reason: CancellationReason, channelReachable: boolean): CancellationPolicy;
export declare function providerCompletionForCancellation(reason: CancellationReason, requestId: unknown, channelReachable: boolean): Readonly<Record<string, unknown>>;
