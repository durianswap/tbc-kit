export type KitRequestCategory = "rpc" | "api" | "tip" | "native-index" | "asset-index" | "pool" | "txraw" | "decode" | "broadcast" | "other";
export interface KitRequestLedgerEntry {
    readonly id: number;
    readonly category: KitRequestCategory;
    readonly key: string;
    readonly concurrencyGroup?: string;
    readonly startedAt: number;
    readonly finishedAt?: number;
    readonly durationMs?: number;
    readonly responseBytes?: number;
    readonly status: "pending" | "fulfilled" | "rejected" | "deduplicated";
}
export interface KitRequestLedgerSnapshot {
    readonly requests: readonly KitRequestLedgerEntry[];
    readonly counts: Readonly<Record<KitRequestCategory, number>>;
    readonly deduplicated: number;
    readonly responseBytes: number;
}
export interface KitRequestLedger {
    readonly run: <T>(input: Readonly<{
        category: KitRequestCategory;
        key: string;
        concurrencyGroup?: string;
        /** Private identity scope, excluded from observation. */
        scope?: object;
        deduplicate?: boolean;
        signal?: AbortSignal;
        responseBytes?: (value: T) => number | undefined;
        execute: (signal: AbortSignal) => Promise<T>;
    }>) => Promise<T>;
    readonly snapshot: () => KitRequestLedgerSnapshot;
    readonly clear: () => void;
}
export declare function createRequestLedger(options?: Readonly<{
    enabled?: boolean;
    now?: () => number;
}>): KitRequestLedger;
