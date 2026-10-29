import { KitRequestCategory, KitRequestLedger } from "./request-ledger.js";
import { type TbcRetryPolicy } from "./read-retry.js";
export type { TbcRetryPolicy } from "./read-retry.js";
export type TbcAttemptEvent = Readonly<{
    requestId: number;
    attempt: number;
    category: KitRequestCategory;
}> & (Readonly<{
    type: "attempt";
    outcome: "success" | "error";
    durationMs: number;
    status?: number;
    errorCode?: string;
}> | Readonly<{
    type: "retry";
    delayMs: number;
}>);
export type TbcJsonPrimitive = string | number | boolean | null;
export type TbcJsonValue = TbcJsonPrimitive | readonly TbcJsonValue[] | TbcJsonObject;
export interface TbcJsonObject {
    readonly [key: string]: TbcJsonValue;
}
export interface TbcRequestOptions {
    readonly signal?: AbortSignal;
    readonly category?: KitRequestCategory;
    readonly concurrencyGroup?: string;
    readonly retry?: "idempotent-read" | "none";
}
export interface TbcTransportOptions {
    readonly baseUrl: string;
    readonly fetch?: typeof globalThis.fetch;
    readonly timeoutMs?: number;
    /** Whole operation budget including headers, body and retry waits. Default: 30s. */
    readonly totalTimeoutMs?: number;
    readonly retryPolicy?: TbcRetryPolicy;
    /** Opt-in, redacted HTTP attempt observation; observer errors cannot fail a request. */
    readonly onAttempt?: (event: TbcAttemptEvent) => void;
    readonly maxResponseBytes?: number;
    readonly ledger?: KitRequestLedger;
    readonly headers?: Readonly<Record<string, string>>;
    /** Called for each attempt. Keep credentials in the trusted host, not the URL. */
    readonly provideHeaders?: () => Readonly<Record<string, string>> | Promise<Readonly<Record<string, string>>>;
    readonly allowedOrigins?: readonly string[];
    /** Keep the endpoint pathname exact (JSON-RPC, including `/wallet/<name>`). */
    readonly exactBaseUrl?: boolean;
}
export declare class TbcTransportError extends Error {
    readonly code: "INVALID_REQUEST" | "NETWORK_ERROR" | "HTTP_ERROR" | "RESPONSE_TOO_LARGE" | "INVALID_RESPONSE" | "TIMEOUT";
    readonly status?: number;
    readonly retryable: boolean;
    readonly retryAfterMs?: number;
    constructor(input: Readonly<{
        code: TbcTransportError["code"];
        message: string;
        status?: number;
        retryable?: boolean;
        retryAfterMs?: number;
        cause?: unknown;
    }>);
}
export interface TbcHttpTransport {
    readonly baseUrl: string;
    readonly requestText: (method: "GET" | "POST", path: string, body?: unknown, options?: TbcRequestOptions) => Promise<string>;
    readonly requestJson: <T = unknown>(method: "GET" | "POST", path: string, body?: unknown, options?: TbcRequestOptions & Readonly<{
        losslessIntegers?: boolean;
    }>) => Promise<T>;
}
export declare function createTbcHttpTransport(options: TbcTransportOptions): TbcHttpTransport;
//# sourceMappingURL=network-transport.d.ts.map