import { canonicalize } from "@tbc-wallet/core";

import type { TbcProviderRpcError } from "./types.js";

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function snapshotData(data: unknown): unknown {
  return deepFreeze(JSON.parse(canonicalize(data)) as unknown);
}

export class ProviderRpcError extends Error implements TbcProviderRpcError {
  readonly code: number;
  readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "ProviderRpcError";
    this.code = code;
    if (data !== undefined) this.data = snapshotData(data);
    Object.freeze(this);
  }
}

export function internalProviderError(message = "The Provider request failed.") {
  return new ProviderRpcError(-32603, message);
}

export function disconnectedProviderError() {
  return new ProviderRpcError(4900, "The Provider transport is disconnected.");
}

export function abortedProviderError() {
  return new ProviderRpcError(
    -32603,
    "The Provider request was aborted.",
    { reason: "REQUEST_ABORTED" },
  );
}
