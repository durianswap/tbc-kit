import {
  createTbcEngine as createInternalEngine,
} from "@tbc-wallet/tbc-engine";
import { createNativeTbcEngineBackend as createInternalNativeBackend } from "@tbc-wallet/tbc-engine/native";
import {
  createLazyBundledWasmTbcEngineBackend as createInternalLazyWasmBackend,
  createWasmTbcEngineBackend as createInternalWasmBackend,
} from "@tbc-wallet/tbc-engine/wasm";
import type { TransactionEngine } from "./internal/core/index.js";

export {
  TBC_MAINNET_PROFILE,
  TBC_TESTNET_PROFILE,
  type TbcNetworkProfile,
} from "./network-profiles.js";

export const TBC_ENGINE_METHODS = Object.freeze([
  "normalizeRequest",
  "plan",
  "validate",
  "finalize",
] as const);

export type TbcEngineMethod = (typeof TBC_ENGINE_METHODS)[number];

export interface TbcEngineBackend {
  readonly call: (
    method: TbcEngineMethod,
    canonicalInput: string,
  ) => string | Promise<string>;
}

export type TbcTransactionEngine = TransactionEngine;

export interface TbcWasmAssetOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly url?: string | URL;
}

export function bundledWasmUrl(): URL {
  return new URL("../../artifacts/wasm/tbc_engine_wasm.wasm", import.meta.url);
}

export function createTbcEngineWithBackend(
  backend: TbcEngineBackend,
): TbcTransactionEngine {
  return createInternalEngine({
    backend: backend as Parameters<typeof createInternalEngine>[0]["backend"],
  }) as TbcTransactionEngine;
}

export function createFetchLazyWasmBackend(
  options: TbcWasmAssetOptions = {},
): TbcEngineBackend {
  return createInternalLazyWasmBackend({
    ...options,
    url: options.url ?? bundledWasmUrl(),
  }) as TbcEngineBackend;
}

export function createNativeTbcEngineBackend(
  call: TbcEngineBackend["call"],
): TbcEngineBackend {
  return createInternalNativeBackend(call) as TbcEngineBackend;
}

export async function createWasmTbcEngineBackend(
  source: ArrayBuffer | Uint8Array | WebAssembly.Module,
): Promise<TbcEngineBackend> {
  return await createInternalWasmBackend(source) as TbcEngineBackend;
}
