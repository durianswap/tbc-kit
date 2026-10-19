export interface TbcRetryPolicy {
    /** Total attempts including the first request. Default: 4. */
    readonly maxAttempts?: number;
    readonly baseDelayMs?: number;
    readonly maxDelayMs?: number;
    /** Full jitter never shortens Retry-After. */
    readonly jitter?: "full" | "none";
}
export declare function normalizeRetryPolicy(policy?: TbcRetryPolicy): Required<TbcRetryPolicy>;
export declare function retryAfterMs(header: string | null): number | undefined;
export declare function abortReason(signal: AbortSignal): unknown;
export declare function waitForRetry(ms: number, signal: AbortSignal): Promise<void>;
/** Parsing and business errors stay outside this loop. */
export declare function runIdempotentRead<T>(input: Readonly<{
    execute: (attempt: number) => Promise<T>;
    signal: AbortSignal;
    policy: Required<TbcRetryPolicy>;
    remainingMs: () => number;
    classify: (error: unknown) => Readonly<{
        retryAfterMs?: number;
    }> | undefined;
    onRetry?: (attempt: number, delayMs: number) => void;
}>): Promise<T>;
