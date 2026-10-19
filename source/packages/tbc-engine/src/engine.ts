import type { TransactionEngine } from "@tbc-wallet/core";
import type { TbcEngineBackend } from "./backend.js";
import { TbcEngineError } from "./errors.js";
import { createTbcEngine } from "./facade.js";
import { createLazyBundledWasmTbcEngineBackend } from "./wasm.js";

export interface TbcTransferEngineOptions {
  readonly backend?: TbcEngineBackend;
  readonly coinSelection?: "canonical";
}

export function createTbcTransferEngine(
  options: TbcTransferEngineOptions = {},
): TransactionEngine {
  if (
    options === null ||
    typeof options !== "object" ||
    Array.isArray(options) ||
    Reflect.ownKeys(options).some((key) => !["backend", "coinSelection"].includes(String(key))) ||
    (options.coinSelection !== undefined && options.coinSelection !== "canonical")
  ) {
    throw new TbcEngineError("INVALID_REQUEST", "invalid TBC Engine options");
  }
  return createTbcEngine({ backend: options.backend ?? createLazyBundledWasmTbcEngineBackend() });
}
