import { KitRequestCategory, KitRequestLedger } from "./request-ledger.js";
import { type TbcTransportOptions } from "./network-transport.js";
export interface KitFetchOptions extends Pick<TbcTransportOptions, "totalTimeoutMs" | "retryPolicy" | "onAttempt"> {
    readonly fetch?: typeof globalThis.fetch;
    readonly timeoutMs?: number;
    readonly ledger?: KitRequestLedger;
}
export interface TbcApiClient {
    readonly getJson: <T = unknown>(path: string, options?: Readonly<{
        signal?: AbortSignal;
        category?: KitRequestCategory;
        concurrencyGroup?: string;
    }>) => Promise<T>;
    readonly postJson: <T = unknown>(path: string, body: unknown, options?: Readonly<{
        signal?: AbortSignal;
        category?: KitRequestCategory;
        concurrencyGroup?: string;
    }>) => Promise<T>;
}
export declare function createTbcApiClient(options: KitFetchOptions & Readonly<{
    baseUrl: string;
}>): TbcApiClient;
export interface TbcRpcClient {
    readonly call: <T = unknown>(method: string, params?: readonly unknown[] | Readonly<Record<string, unknown>>, options?: Readonly<{
        signal?: AbortSignal;
        concurrencyGroup?: string;
        /** Must be opted into only for an idempotent read RPC method. */
        retry?: "idempotent-read";
    }>) => Promise<T>;
}
export declare function createTbcRpcClient(options: KitFetchOptions & Readonly<{
    url: string;
    headers?: Readonly<Record<string, string>>;
}>): TbcRpcClient;
