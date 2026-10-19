import { KitRequestCategory, KitRequestLedger, createRequestLedger } from "./request-ledger.js";
import { abortReason, normalizeRetryPolicy, retryAfterMs, runIdempotentRead, type TbcRetryPolicy } from "./read-retry.js";
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
}> | Readonly<{ type: "retry"; delayMs: number }>);

export type TbcJsonPrimitive = string | number | boolean | null;
export type TbcJsonValue = TbcJsonPrimitive | readonly TbcJsonValue[] | TbcJsonObject;
export interface TbcJsonObject { readonly [key: string]: TbcJsonValue }

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

export class TbcTransportError extends Error {
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
  }>) {
    super(input.message, input.cause === undefined ? undefined : { cause: input.cause });
    this.name = "TbcTransportError";
    this.code = input.code;
    if (input.status !== undefined) this.status = input.status;
    this.retryable = input.retryable === true;
    if (input.retryAfterMs !== undefined) this.retryAfterMs = input.retryAfterMs;
  }
}

export interface TbcHttpTransport {
  readonly baseUrl: string;
  readonly requestText: (
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    options?: TbcRequestOptions,
  ) => Promise<string>;
  readonly requestJson: <T = unknown>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    options?: TbcRequestOptions & Readonly<{ losslessIntegers?: boolean }>,
  ) => Promise<T>;
}

function normalizeBase(value: string, exact: boolean): URL {
  const url = new URL(value);
  if (!/^https?:$/u.test(url.protocol) || url.username !== "" || url.password !== "")
    throw new TypeError("TBC endpoint must be HTTP(S) and must not contain credentials");
  if (!exact) url.pathname = url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`;
  url.search = "";
  url.hash = "";
  return url;
}

function endpoint(base: URL, path: string): URL {
  if (path === "") return new URL(base.href);
  if (path.startsWith("//")) throw new TypeError("Invalid TBC endpoint path");
  const value = new URL(path.replace(/^\//u, ""), base);
  if (value.origin !== base.origin || value.username !== "" || value.password !== "")
    throw new TypeError("TBC endpoint path changed origin");
  return value;
}

function parseLosslessIntegers(text: string): unknown {
  let output = "";
  let string = false;
  let escaped = false;
  for (let index = 0; index < text.length;) {
    const character = text[index]!;
    if (string) {
      output += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') string = false;
      index += 1;
      continue;
    }
    if (character === '"') {
      string = true;
      output += character;
      index += 1;
      continue;
    }
    if (character === "-" || /[0-9]/u.test(character)) {
      const match = text.slice(index).match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u);
      if (match) {
        const token = match[0];
        output += /[.eE]/u.test(token) ? token : JSON.stringify(token);
        index += token.length;
        continue;
      }
    }
    output += character;
    index += 1;
  }
  return JSON.parse(output) as unknown;
}

function size(value: string): number {
  return new TextEncoder().encode(value).length;
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw signal.reason ?? new Error("TBC network request was aborted");
  }
}

function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", abort, { once: true });
    pending.then(
      (value) => { signal.removeEventListener("abort", abort); resolve(value); },
      (error: unknown) => { signal.removeEventListener("abort", abort); reject(error); },
    );
    if (signal.aborted) abort();
  });
}

function discard(response: Response): void {
  // Cleanup must not block cancellation, retries, or a deadline.
  try { void response.body?.cancel().catch(() => {}); } catch {}
}

async function readBody(response: Response, limit: number, signal: AbortSignal): Promise<string> {
  const tooLarge = () => new TbcTransportError({ code: "RESPONSE_TOO_LARGE", message: "TBC response exceeds the configured byte budget" });
  const declared = response.headers.get("content-length");
  if (declared !== null && /^\d+$/u.test(declared) && Number(declared) > limit) {
    discard(response);
    throw tooLarge();
  }
  // Native fetch adapters without ReadableStream still receive deadline/cancel
  // protection; their byte budget is checked when their text() resolves.
  if (typeof response.body?.getReader !== "function" || typeof TextDecoder === "undefined") {
    const text = await response.text();
    assertNotAborted(signal);
    if (size(text) > limit) throw tooLarge();
    return text;
  }
  const reader = response.body.getReader();
  const cancel = () => { try { void reader.cancel().catch(() => {}); } catch {} };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    assertNotAborted(signal);
    for (;;) {
      const { done, value } = await reader.read();
      assertNotAborted(signal);
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) { cancel(); throw tooLarge(); }
      chunks.push(value);
    }
    // Most API replies arrive in one chunk: decode it directly. For multiple
    // chunks, check every byte budget first, then decode UTF-8 once.
    if (chunks.length === 1) return new TextDecoder().decode(chunks[0]);
    const combined = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.byteLength; }
    return new TextDecoder().decode(combined);
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

export function createTbcHttpTransport(options: TbcTransportOptions): TbcHttpTransport {
  const base = normalizeBase(options.baseUrl, options.exactBaseUrl === true);
  const fetcher = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const totalTimeoutMs = options.totalTimeoutMs ?? 30_000;
  const policy = normalizeRetryPolicy(options.retryPolicy);
  const maxResponseBytes = options.maxResponseBytes ?? 10 * 1024 * 1024;
  const ledger = options.ledger ?? createRequestLedger();
  const allowedOrigins = new Set(options.allowedOrigins ?? [base.origin]);
  const headers = Object.freeze({ ...options.headers });
  const provideHeaders = options.provideHeaders;
  const onAttempt = options.onAttempt;
  // Identity is private and instance-local even when observers share a ledger.
  const readScope = {};
  const onceScope = {};
  let nextRequestId = 0;
  if (typeof fetcher !== "function") throw new TypeError("A fetch implementation is required");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000 ||
      !Number.isSafeInteger(totalTimeoutMs) || totalTimeoutMs < 1 || totalTimeoutMs > 300_000)
    throw new TypeError("Invalid TBC request timeout");
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > 64 * 1024 * 1024)
    throw new TypeError("Invalid TBC response budget");
  if (![...allowedOrigins].every((origin) => new URL(origin).origin === origin))
    throw new TypeError("Invalid TBC allowed origin");
  if (!allowedOrigins.has(base.origin)) throw new TypeError("TBC endpoint is not an allowed origin");

  function emit(event: TbcAttemptEvent): void {
    try {
      const returned: unknown = onAttempt?.(Object.freeze(event));
      if (returned instanceof Promise) void returned.catch(() => {});
    } catch { /* Telemetry cannot alter request behavior. */ }
  }

  async function requestText(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    callOptions: TbcRequestOptions = {},
  ): Promise<string> {
    assertNotAborted(callOptions.signal);
    const url = endpoint(base, path);
    const encodedBody = body === undefined ? undefined : JSON.stringify(body);
    const key = `${method} ${url.href}${encodedBody === undefined ? "" : ` ${encodedBody}`}`;
    const retryRead = (method === "GET" && callOptions.retry !== "none") || callOptions.retry === "idempotent-read";
    const category = callOptions.category ?? (method === "POST" ? "other" : "api");
    return ledger.run({
      category,
      key,
      scope: retryRead ? readScope : onceScope,
      // Dynamic credentials may change identity between calls. Such requests
      // cannot share a response based only on URL/body. Ordinary reads still do.
      deduplicate: provideHeaders === undefined && (method === "GET" || retryRead),
      ...(callOptions.signal === undefined ? {} : { signal: callOptions.signal }),
      ...(callOptions.concurrencyGroup === undefined ? {} : { concurrencyGroup: callOptions.concurrencyGroup }),
      responseBytes: size,
      execute: async (sharedSignal) => {
        const operation = new AbortController();
        const abortOperation = () => operation.abort(abortReason(sharedSignal));
        sharedSignal.addEventListener("abort", abortOperation, { once: true });
        if (sharedSignal.aborted) abortOperation();
        const started = performance.now();
        const remainingMs = () => totalTimeoutMs - (performance.now() - started);
        const deadline = setTimeout(() => operation.abort(new TbcTransportError({
          code: "TIMEOUT", message: "TBC operation deadline exceeded",
        })), totalTimeoutMs);
        const requestId = ++nextRequestId;
        const fetchOnce = async (attempt: number): Promise<string> => {
          assertNotAborted(operation.signal);
          if (remainingMs() <= 0) throw new TbcTransportError({ code: "TIMEOUT", message: "TBC operation deadline exceeded" });
          const controller = new AbortController();
          const abort = () => controller.abort(abortReason(operation.signal));
          operation.signal.addEventListener("abort", abort, { once: true });
          const timer = setTimeout(() => controller.abort(new TbcTransportError({
            code: "TIMEOUT", message: "TBC network request timed out", retryable: true,
          })), Math.min(timeoutMs, Math.max(0, remainingMs())));
          const attemptStarted = onAttempt === undefined ? 0 : performance.now();
          let status: number | undefined;
          try {
            const work = async (): Promise<string> => {
              // No await on the ordinary path before fetch: all independent
              // reads continue to start in the same turn.
              const dynamicHeaders = provideHeaders === undefined ? undefined : await provideHeaders();
              assertNotAborted(controller.signal);
              let response: Response;
              try {
                response = await fetcher(url, {
                  method, redirect: "error",
                  headers: {
                    accept: "application/json",
                    ...(method === "POST" ? { "content-type": "application/json" } : {}),
                    ...headers, ...dynamicHeaders,
                  },
                  ...(encodedBody === undefined ? {} : { body: encodedBody }),
                  signal: controller.signal,
                });
              } catch (cause) {
                assertNotAborted(controller.signal);
                throw new TbcTransportError({ code: "NETWORK_ERROR", message: "TBC network request failed", retryable: true, cause });
              }
              status = response.status;
              if (controller.signal.aborted) { discard(response); throw abortReason(controller.signal); }
              if (response.url !== "") {
                let final: URL;
                try { final = new URL(response.url); }
                catch (cause) {
                  discard(response);
                  throw new TbcTransportError({ code: "INVALID_RESPONSE", message: "Invalid TBC response URL", cause });
                }
                if (!allowedOrigins.has(final.origin) || final.username !== "" || final.password !== "") {
                  discard(response);
                  throw new TbcTransportError({ code: "INVALID_RESPONSE", message: "TBC response changed to an unauthorized origin" });
                }
              }
              if (!response.ok) {
                const delay = retryAfterMs(response.headers.get("retry-after"));
                discard(response);
                throw new TbcTransportError({
                  code: "HTTP_ERROR", message: `TBC request failed with HTTP ${response.status}`,
                  status: response.status, retryable: [429, 500, 502, 503, 504].includes(response.status),
                  ...(delay === undefined ? {} : { retryAfterMs: delay }),
                });
              }
              try { return await readBody(response, maxResponseBytes, controller.signal); }
              catch (cause) {
                assertNotAborted(controller.signal);
                if (cause instanceof TbcTransportError) throw cause;
                throw new TbcTransportError({ code: "INVALID_RESPONSE", message: "Unreadable TBC response", cause });
              }
            };
            const result = await abortable(work(), controller.signal);
            if (onAttempt !== undefined) emit({
              type: "attempt", requestId, attempt, category, outcome: "success",
              durationMs: performance.now() - attemptStarted, ...(status === undefined ? {} : { status }),
            });
            return result;
          } catch (error) {
            if (onAttempt !== undefined) emit({
              type: "attempt", requestId, attempt, category, outcome: "error",
              durationMs: performance.now() - attemptStarted, ...(status === undefined ? {} : { status }),
              errorCode: error instanceof TbcTransportError ? error.code : controller.signal.aborted ? "ABORTED" : "HEADER_ERROR",
            });
            throw error;
          } finally {
            clearTimeout(timer);
            operation.signal.removeEventListener("abort", abort);
          }
        };
        try {
          return retryRead ? await runIdempotentRead({
            execute: fetchOnce, signal: operation.signal, policy, remainingMs,
            classify: (error) => error instanceof TbcTransportError && error.retryable
              ? (error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }) : undefined,
            ...(onAttempt === undefined ? {} : {
              onRetry: (attempt: number, delayMs: number) => emit({ type: "retry", requestId, attempt, category, delayMs }),
            }),
          }) : await fetchOnce(1);
        } finally {
          clearTimeout(deadline);
          sharedSignal.removeEventListener("abort", abortOperation);
        }
      },
    });
  }

  return Object.freeze({
    baseUrl: base.href,
    requestText,
    async requestJson<T>(method: "GET" | "POST", path: string, body?: unknown, callOptions: TbcRequestOptions & Readonly<{ losslessIntegers?: boolean }> = {}): Promise<T> {
      const text = await requestText(method, path, body, callOptions);
      assertNotAborted(callOptions.signal);
      try {
        return (callOptions.losslessIntegers === true ? parseLosslessIntegers(text) : JSON.parse(text)) as T;
      } catch (cause) {
        throw new TbcTransportError({ code: "INVALID_RESPONSE", message: "Invalid TBC JSON response", cause });
      }
    },
  });
}
