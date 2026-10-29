import type { CancelInput, CommitAckInput, PortCall, PortError, PortOperation, PortOperationMap, SchemaCoreTransition, SchemaOperationCheckpoint, StartInput, TwsCore } from "../core/index.js";
import type { TwsHostErrorCode, TwsHostErrorMetadata } from "./errors.js";
import type { TwsHostStore } from "./store.js";
export declare const TWS_HOST_PORT_NAMES: readonly ["accounts", "chainData", "policy", "permissionStore", "approval", "signer", "crypto", "reviewedTransaction", "broadcast", "clock", "entropy"];
export type TwsHostPortName = (typeof TWS_HOST_PORT_NAMES)[number];
export declare const TWS_HOST_DRIVER_METHODS: readonly ["cancelOperation", "inspectOperation", "recoverPendingOperations", "resumeOperation", "startOperation"];
export type TwsHostDriverMethod = (typeof TWS_HOST_DRIVER_METHODS)[number];
export type TwsHostPortOutcome<K extends PortOperation> = K extends PortOperation ? PortOperationMap[K]["result"] | Readonly<{
    portError: PortError;
}> : never;
export type TwsHostPortHandler<K extends PortOperation> = (call: PortCall<K>) => TwsHostPortOutcome<K> | Promise<TwsHostPortOutcome<K>>;
export interface TwsHostPorts {
    readonly accounts: TwsHostPortHandler<"accounts.resolve">;
    readonly chainData: TwsHostPortHandler<"chainData.resolve">;
    readonly policy: TwsHostPortHandler<"policy.resolve">;
    readonly permissionStore: TwsHostPortHandler<"permissionStore.load" | "permissionStore.commit">;
    readonly approval: TwsHostPortHandler<"approval.request">;
    readonly signer: TwsHostPortHandler<"signer.sign">;
    readonly crypto?: TwsHostPortHandler<"crypto.execute">;
    readonly reviewedTransaction?: TwsHostPortHandler<"reviewedTransaction.review" | "reviewedTransaction.execute">;
    readonly broadcast: TwsHostPortHandler<"broadcast.submit" | "broadcast.submitBatch" | "broadcast.reconcile">;
    readonly clock: TwsHostPortHandler<"clock.now">;
    readonly entropy: TwsHostPortHandler<"entropy.randomBytes">;
}
export type TwsAuthoritySnapshot = Readonly<{
    currentContext: StartInput["currentContext"];
    currentSession: StartInput["currentSession"];
}>;
export type TwsProviderSessionMutation = Extract<SchemaCoreTransition, {
    readonly kind: "commit";
}>["mutation"];
export type TwsProviderCompletion = Extract<SchemaCoreTransition, {
    readonly kind: "complete";
}>["completion"];
export type TwsProviderSessionCommitAck = CommitAckInput["acknowledgment"];
export interface TwsSessionCommitRequest {
    readonly operationId: string;
    readonly commitId: string;
    readonly mutation: TwsProviderSessionMutation;
    readonly expected: TwsAuthoritySnapshot;
}
export interface TwsSessionCommitResult {
    readonly acknowledgment: TwsProviderSessionCommitAck;
    readonly authority: TwsAuthoritySnapshot;
}
export interface TwsAuthoritySource {
    readonly read: () => Promise<TwsAuthoritySnapshot>;
    readonly compareAndSwapSession: (input: TwsSessionCommitRequest) => Promise<TwsSessionCommitResult>;
}
export type TwsHostLeaseHeartbeatScheduler = (delayMs: number, run: () => void) => () => void;
export interface TwsHostOptions {
    readonly core: TwsCore;
    readonly ports: TwsHostPorts;
    readonly store: TwsHostStore;
    readonly authority: TwsAuthoritySource;
    readonly ownerId: string;
    readonly scheduleLeaseHeartbeat: TwsHostLeaseHeartbeatScheduler;
    readonly leaseTtlMs?: number;
    readonly maxSteps?: number;
    readonly deferDeliveryAcknowledgment?: boolean;
}
export type TwsHostStartInput = Omit<StartInput, "currentContext" | "currentSession"> & Readonly<{
    expectedAuthorityIdentity?: string;
}>;
export type TwsHostFailure = Readonly<{
    code: TwsHostErrorCode;
    message: string;
    retryable: boolean;
    metadata?: TwsHostErrorMetadata;
}>;
export type TwsHostOperationResult = Readonly<{
    status: "waiting";
    operationId: string;
    revision: string;
    state: SchemaOperationCheckpoint["payload"]["state"];
}> | Readonly<{
    status: "complete";
    operationId: string;
    revision: string;
    completion: TwsProviderCompletion;
    deliveryId: string;
}> | Readonly<{
    status: "cancelled";
    operationId: string;
    revision: string;
    completion: TwsProviderCompletion;
    deliveryId: string;
}> | Readonly<{
    status: "busy";
    operationId: string;
    retryable: true;
}> | Readonly<{
    status: "failed";
    operationId: string;
    error: TwsHostFailure;
}>;
export interface TwsHostResumeInput {
    readonly operationId: string;
}
export interface TwsHostRecoverInput {
    readonly limit?: number;
}
export interface TwsHostRecoveryResult {
    readonly operationId: string;
    readonly result: TwsHostOperationResult;
}
export interface TwsHostCancelInput {
    readonly operationId: string;
    readonly reason: CancelInput["reason"];
}
export interface TwsHostInspectInput {
    readonly operationId: string;
}
export interface TwsHostOperationInspection {
    readonly operationId: string;
    readonly revision: string;
    readonly state: SchemaOperationCheckpoint["payload"]["state"];
    readonly transitionKind: SchemaCoreTransition["kind"];
    readonly releaseFingerprint: string;
    readonly terminal: boolean;
    readonly createdAt: string;
    readonly updatedAt: string;
}
export interface TwsHost {
    readonly startOperation: (input: TwsHostStartInput) => Promise<TwsHostOperationResult>;
    readonly resumeOperation: (input: TwsHostResumeInput) => Promise<TwsHostOperationResult>;
    readonly recoverPendingOperations: (input?: TwsHostRecoverInput) => Promise<readonly TwsHostRecoveryResult[]>;
    readonly cancelOperation: (input: TwsHostCancelInput) => Promise<TwsHostOperationResult>;
    readonly inspectOperation: (input: TwsHostInspectInput) => Promise<TwsHostOperationInspection>;
}
//# sourceMappingURL=types.d.ts.map