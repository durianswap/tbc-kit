import type { AnyPortCall } from "./ports.js";
export interface ProtocolReleaseIdentity {
    readonly version: string;
    readonly schemaBundleSha256: string;
    readonly registryBundleSha256: string;
}
export interface OperationCheckpointPayload {
    readonly release: ProtocolReleaseIdentity;
    readonly releaseFingerprint: string;
    readonly operationId: string;
    readonly revision: string;
    readonly previousCheckpointHash?: string;
    readonly requestId: unknown;
    readonly operation: unknown;
    readonly context: unknown;
    readonly contextHash: string;
    readonly session: unknown;
    readonly createdAt?: string;
    readonly updatedAt?: string;
    readonly expiresAt?: string;
    readonly pendingCalls: readonly AnyPortCall[];
    readonly memory: Readonly<Record<string, unknown>>;
    readonly [key: string]: unknown;
}
export interface OperationCheckpoint {
    readonly payload: OperationCheckpointPayload;
    readonly checkpointHash: string;
}
export declare function createCheckpoint(payload: OperationCheckpointPayload): OperationCheckpoint;
export declare function verifyCheckpoint(checkpoint: OperationCheckpoint, expectedRelease?: ProtocolReleaseIdentity): OperationCheckpoint;
export declare function advanceCheckpoint(previousCheckpoint: OperationCheckpoint, nextPayload: OperationCheckpointPayload, expectedRelease?: ProtocolReleaseIdentity): OperationCheckpoint;
