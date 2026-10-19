export interface TbcRetryPolicy {
  /** Total attempts including the first request. Default: 4. */
  readonly maxAttempts?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  /** Full jitter never shortens Retry-After. */
  readonly jitter?: "full" | "none";
}

export function normalizeRetryPolicy(policy: TbcRetryPolicy = {}): Required<TbcRetryPolicy> {
  const result = {
    maxAttempts: policy.maxAttempts ?? 4,
    baseDelayMs: policy.baseDelayMs ?? 25,
    maxDelayMs: policy.maxDelayMs ?? 1_000,
    jitter: policy.jitter ?? "full",
  };
  if (!Number.isSafeInteger(result.maxAttempts) || result.maxAttempts < 1 || result.maxAttempts > 10 ||
      !Number.isSafeInteger(result.baseDelayMs) || result.baseDelayMs < 0 ||
      !Number.isSafeInteger(result.maxDelayMs) || result.maxDelayMs < result.baseDelayMs || result.maxDelayMs > 60_000 ||
      (result.jitter !== "full" && result.jitter !== "none")) {
    throw new TypeError("Invalid TBC retry policy");
  }
  return Object.freeze(result);
}

export function retryAfterMs(header: string | null): number | undefined {
  if (header === null || header.trim() === "") return undefined;
  if (/^\d+$/u.test(header.trim())) return Number(header) * 1_000;
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

export function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error("TBC request was aborted");
}

export function waitForRetry(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  if (ms === 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(abortReason(signal));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

/** Parsing and business errors stay outside this loop. */
export async function runIdempotentRead<T>(input: Readonly<{
  execute: (attempt: number) => Promise<T>;
  signal: AbortSignal;
  policy: Required<TbcRetryPolicy>;
  remainingMs: () => number;
  classify: (error: unknown) => Readonly<{ retryAfterMs?: number }> | undefined;
  onRetry?: (attempt: number, delayMs: number) => void;
}>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    if (input.signal.aborted) throw abortReason(input.signal);
    try { return await input.execute(attempt); }
    catch (error) {
      if (input.signal.aborted) throw abortReason(input.signal);
      const retry = input.classify(error);
      if (retry === undefined || attempt >= input.policy.maxAttempts) throw error;
      const backoff = Math.min(input.policy.maxDelayMs, input.policy.baseDelayMs * 2 ** (attempt - 1));
      const delay = Math.max(retry.retryAfterMs ?? 0,
        input.policy.jitter === "full" ? Math.floor(Math.random() * (backoff + 1)) : backoff);
      // Never retry earlier than the server permits to fit our deadline.
      if (delay >= input.remainingMs()) throw error;
      input.onRetry?.(attempt, delay);
      await waitForRetry(delay, input.signal);
    }
  }
}
