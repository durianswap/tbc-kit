export interface LegacyDependentBatchProgress {
    readonly completed: 0 | 1 | 2;
    readonly total: 2;
    readonly stage: "signing" | "finalizing";
}
export interface LegacyDependentBatchFirstStep<T> {
    readonly value: T;
    readonly result: unknown;
    readonly rawTransactions: readonly string[];
    readonly acknowledge?: () => void | Promise<void>;
}
export interface LegacyDependentBatchSecondStep<T> {
    readonly value: T;
    readonly result: unknown;
}
export type LegacyDependentBatchOutcome<TFirst, TSecond> = Readonly<{
    readonly status: "invalid-template";
}> | Readonly<{
    readonly status: "first-error";
    readonly first: LegacyDependentBatchFirstStep<TFirst>;
}> | Readonly<{
    readonly status: "second-error";
    readonly first: LegacyDependentBatchFirstStep<TFirst>;
    readonly second: LegacyDependentBatchSecondStep<TSecond>;
}> | Readonly<{
    readonly status: "complete";
    readonly first: LegacyDependentBatchFirstStep<TFirst>;
    readonly second: LegacyDependentBatchSecondStep<TSecond>;
}>;
export interface LegacyDependentBatchCoordinator {
    run<TFirst, TSecond>(input: Readonly<{
        readonly messageTemplate: unknown;
        readonly executeFirst: () => Promise<LegacyDependentBatchFirstStep<TFirst>>;
        readonly executeSecond: (message: Readonly<{
            readonly message: string;
            readonly encoding: "utf8";
        }>) => Promise<LegacyDependentBatchSecondStep<TSecond>>;
    }>): Promise<LegacyDependentBatchOutcome<TFirst, TSecond>>;
}
/** Fixed two-step Legacy dependency coordination; all authority stays injected. */
export declare function createLegacyDependentBatchCoordinator(options?: Readonly<{
    readonly onProgress?: (progress: LegacyDependentBatchProgress) => void;
}>): LegacyDependentBatchCoordinator;
//# sourceMappingURL=legacy-dependent-batch.d.ts.map