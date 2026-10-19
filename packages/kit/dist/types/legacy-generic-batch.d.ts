export type LegacyGenericBatchMethod = "sendTransaction" | "signTransaction" | "signAssociatedTransaction" | "signMessage" | "encrypt" | "decrypt";
export interface LegacyGenericBatchRequest {
    readonly method: LegacyGenericBatchMethod;
    readonly params: unknown;
    readonly dependsOn?: string;
}
export interface LegacyGenericBatchExecution<T = unknown> {
    readonly value: T;
    readonly result: unknown;
    readonly acknowledge?: () => void | Promise<void>;
}
export interface LegacyGenericBatchProgress {
    readonly completed: number;
    readonly total: number;
    readonly stage: "executing" | "complete";
}
export interface LegacyGenericBatchOutcome<T = unknown> {
    readonly status: "complete";
    readonly results: readonly unknown[];
    readonly executions: readonly T[];
}
export interface LegacyGenericBatchExecutor {
    run(input: unknown): Promise<LegacyGenericBatchOutcome>;
}
export declare function normalizeLegacyGenericBatchRequests(input: unknown): readonly LegacyGenericBatchRequest[];
/**
 * Historical 1-5 request semantics only. Approval/authentication is performed
 * once by the caller over the normalized list; this executor owns ordering,
 * dependency substitution and result/error preservation, not key access.
 */
export declare function createLegacyGenericBatchExecutor(options: Readonly<{
    readonly execute: (request: LegacyGenericBatchRequest, index: number) => Promise<LegacyGenericBatchExecution>;
    readonly onProgress?: (progress: LegacyGenericBatchProgress) => void;
}>): LegacyGenericBatchExecutor;
