import { canonicalize } from "@tbc-wallet/core";

import { withLegacyDependentTxids } from "./legacy-batch.js";
import { turingTransactionId } from "./testnet-validation.js";

export type LegacyGenericBatchMethod =
  | "sendTransaction"
  | "signTransaction"
  | "signAssociatedTransaction"
  | "signMessage"
  | "encrypt"
  | "decrypt";

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

const METHODS = new Set<LegacyGenericBatchMethod>([
  "sendTransaction",
  "signTransaction",
  "signAssociatedTransaction",
  "signMessage",
  "encrypt",
  "decrypt",
]);

const MERGE_FLAGS = new Set([
  "FT_MERGE",
  "POOLNFT_MERGE",
  "FTLP_MERGE",
  "POOLNFT_LP_BURN",
  "STABLECOIN_MERGE",
]);

function plainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function clone<T>(value: T): T {
  return JSON.parse(canonicalize(value)) as T;
}

function businessError(result: unknown): boolean {
  return plainRecord(result) && Object.hasOwn(result, "error");
}

function sendTransactionParams(params: unknown): Readonly<Record<string, unknown>> | undefined {
  const candidate = Array.isArray(params) && params.length === 1 ? params[0] : params;
  return plainRecord(candidate) ? candidate : undefined;
}

function assertBatchPolicy(request: LegacyGenericBatchRequest): void {
  if (request.method !== "sendTransaction") return;
  const params = sendTransactionParams(request.params);
  if (
    params === undefined ||
    Reflect.get(params, "broadcastEnabled") !== false ||
    MERGE_FLAGS.has(String(Reflect.get(params, "flag")))
  ) {
    throw new TypeError("Legacy batch sendTransaction must be sign-only and cannot merge");
  }
}

export function normalizeLegacyGenericBatchRequests(
  input: unknown,
): readonly LegacyGenericBatchRequest[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > 5) {
    throw new TypeError("Legacy batch must contain 1 to 5 requests");
  }
  const requests = input.map((candidate, index) => {
    if (!plainRecord(candidate)) throw new TypeError(`Invalid Legacy batch request ${index}`);
    const keys = Reflect.ownKeys(candidate);
    if (keys.some((key) =>
      typeof key !== "string" || !["id", "method", "params", "dependsOn"].includes(key)
    )) throw new TypeError(`Invalid Legacy batch request ${index}`);
    const method = Reflect.get(candidate, "method");
    const dependsOn = Reflect.get(candidate, "dependsOn");
    if (
      !METHODS.has(method as LegacyGenericBatchMethod) ||
      !Object.hasOwn(candidate, "params") ||
      (dependsOn !== undefined &&
        (method !== "signMessage" ||
          typeof dependsOn !== "string" ||
          withLegacyDependentTxids(Reflect.get(candidate, "params"), [], dependsOn) === undefined))
    ) throw new TypeError(`Invalid Legacy batch request ${index}`);
    if (dependsOn !== undefined && index === 0) {
      throw new TypeError("Legacy batch dependency requires a previous request");
    }
    const request = Object.freeze({
      method: method as LegacyGenericBatchMethod,
      params: clone(Reflect.get(candidate, "params")),
      ...(dependsOn === undefined ? {} : { dependsOn }),
    });
    assertBatchPolicy(request);
    return request;
  });
  return Object.freeze(requests);
}

function rawTransactions(result: unknown): readonly string[] {
  if (!plainRecord(result)) return Object.freeze([]);
  const many = Reflect.get(result, "txraws");
  if (Array.isArray(many) && many.every((raw) => typeof raw === "string")) {
    return Object.freeze([...many]);
  }
  const raw = Reflect.get(result, "txraw");
  if (typeof raw === "string") {
    return Object.freeze(raw.split(",").map((value) => value.trim()).filter(Boolean));
  }
  return Object.freeze([]);
}

function transactionIds(result: unknown): readonly string[] {
  if (plainRecord(result) && typeof Reflect.get(result, "txid") === "string") {
    return Object.freeze(
      String(Reflect.get(result, "txid")).split(",").map((value) => value.trim()).filter(Boolean),
    );
  }
  return Object.freeze(rawTransactions(result).map(turingTransactionId));
}

/**
 * Historical 1-5 request semantics only. Approval/authentication is performed
 * once by the caller over the normalized list; this executor owns ordering,
 * dependency substitution and result/error preservation, not key access.
 */
export function createLegacyGenericBatchExecutor(options: Readonly<{
  readonly execute: (
    request: LegacyGenericBatchRequest,
    index: number,
  ) => Promise<LegacyGenericBatchExecution>;
  readonly onProgress?: (progress: LegacyGenericBatchProgress) => void;
}>): LegacyGenericBatchExecutor {
  if (typeof options?.execute !== "function") {
    throw new TypeError("Legacy generic batch execute adapter is required");
  }
  const report = (completed: number, total: number, stage: "executing" | "complete") => {
    try {
      options.onProgress?.(Object.freeze({ completed, total, stage }));
    } catch {
      // Presentation diagnostics never change execution semantics.
    }
  };
  return Object.freeze({
    async run(input: unknown): Promise<LegacyGenericBatchOutcome> {
      const requests = normalizeLegacyGenericBatchRequests(input);
      const results: unknown[] = [];
      const executions: unknown[] = [];
      report(0, requests.length, "executing");
      for (let index = 0; index < requests.length; index += 1) {
        const request = requests[index]!;
        let resolved = request;
        if (request.dependsOn !== undefined) {
          const previous = results[index - 1];
          const txids = businessError(previous) ? [] : transactionIds(previous);
          const params = txids.length === 0
            ? undefined
            : withLegacyDependentTxids(request.params, txids, request.dependsOn);
          if (params === undefined) {
            results.push(Object.freeze({ error: "Previous request failed or produced no txids" }));
            executions.push(undefined);
            report(index + 1, requests.length, "executing");
            continue;
          }
          resolved = Object.freeze({ ...request, params });
        }
        try {
          const execution = await options.execute(resolved, index);
          results.push(execution.result);
          executions.push(execution.value);
          await execution.acknowledge?.();
        } catch (error) {
          results.push(Object.freeze({
            error: error instanceof Error && error.message.length > 0
              ? error.message
              : "Unknown error",
          }));
          executions.push(undefined);
        }
        report(index + 1, requests.length, "executing");
      }
      report(requests.length, requests.length, "complete");
      return Object.freeze({
        status: "complete" as const,
        results: Object.freeze(results),
        executions: Object.freeze(executions),
      });
    },
  });
}
