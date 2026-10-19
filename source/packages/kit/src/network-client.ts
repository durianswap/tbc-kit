import {
  createRequestLedger,
  KitRequestCategory,
  KitRequestLedger,
} from "./request-ledger.js";
import { createTbcHttpTransport, type TbcTransportOptions } from "./network-transport.js";
import { createTbcRpcTransport } from "./official-rpc.js";

export interface KitFetchOptions extends Pick<TbcTransportOptions, "totalTimeoutMs" | "retryPolicy" | "onAttempt"> {
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
  readonly ledger?: KitRequestLedger;
}

export interface TbcApiClient {
  readonly getJson: <T = unknown>(
    path: string,
    options?: Readonly<{
      signal?: AbortSignal;
      category?: KitRequestCategory;
      concurrencyGroup?: string;
    }>,
  ) => Promise<T>;
  readonly postJson: <T = unknown>(
    path: string,
    body: unknown,
    options?: Readonly<{
      signal?: AbortSignal;
      category?: KitRequestCategory;
      concurrencyGroup?: string;
    }>,
  ) => Promise<T>;
}

export function createTbcApiClient(
  options: KitFetchOptions & Readonly<{ baseUrl: string }>,
): TbcApiClient {
  const transport = createTbcHttpTransport({
    ...options,
    baseUrl: options.baseUrl,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.ledger === undefined ? {} : { ledger: options.ledger }),
  });

  return Object.freeze({
    getJson: <T>(path: string, callOptions?: Readonly<{ signal?: AbortSignal; category?: KitRequestCategory; concurrencyGroup?: string }>) =>
      transport.requestJson<T>("GET", path, undefined, callOptions),
    postJson: <T>(path: string, body: unknown, callOptions?: Readonly<{ signal?: AbortSignal; category?: KitRequestCategory; concurrencyGroup?: string }>) =>
      transport.requestJson<T>("POST", path, body, { ...callOptions, category: callOptions?.category ?? "broadcast" }),
  });
}

export interface TbcRpcClient {
  readonly call: <T = unknown>(
    method: string,
    params?: readonly unknown[] | Readonly<Record<string, unknown>>,
    options?: Readonly<{
      signal?: AbortSignal;
      concurrencyGroup?: string;
      /** Must be opted into only for an idempotent read RPC method. */
      retry?: "idempotent-read";
    }>,
  ) => Promise<T>;
}

export function createTbcRpcClient(
  options: KitFetchOptions & Readonly<{ url: string; headers?: Readonly<Record<string, string>> }>,
): TbcRpcClient {
  const rpc = createTbcRpcTransport({
    ...options,
    url: options.url,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.ledger === undefined ? {} : { ledger: options.ledger }),
    ...(options.headers === undefined ? {} : { headers: options.headers }),
  });
  return Object.freeze({
    async call<T>(method: string, params: readonly unknown[] | Readonly<Record<string, unknown>> = [], callOptions: Readonly<{ signal?: AbortSignal; concurrencyGroup?: string; retry?: "idempotent-read" }> = {}): Promise<T> {
      return await rpc.callExtension<T & import("./network-transport.js").TbcJsonValue>(
        method,
        params as import("./official-rpc.js").TbcRpcParams,
        callOptions,
      ) as T;
    },
  });
}
