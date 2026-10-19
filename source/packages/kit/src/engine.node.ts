import { readFile } from "node:fs/promises";
import {
  bundledWasmUrl,
  createFetchLazyWasmBackend,
  createTbcEngineWithBackend,
  createWasmTbcEngineBackend,
  type TbcEngineBackend,
  type TbcEngineMethod,
  type TbcTransactionEngine,
  type TbcWasmAssetOptions,
} from "./engine-base.js";

export {
  TBC_ENGINE_METHODS,
  TBC_MAINNET_PROFILE,
  TBC_TESTNET_PROFILE,
  createNativeTbcEngineBackend,
  createWasmTbcEngineBackend,
  type TbcEngineBackend,
  type TbcEngineMethod,
  type TbcNetworkProfile,
  type TbcTransactionEngine,
  type TbcWasmAssetOptions,
} from "./engine-base.js";

function fileUrl(value: string | URL): URL | undefined {
  if (value instanceof URL) return value.protocol === "file:" ? value : undefined;
  if (!value.startsWith("file:")) return undefined;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "file:" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function createTbcEngine(options: Readonly<{
  backend?: TbcEngineBackend;
  wasm?: TbcWasmAssetOptions;
}> = {}): TbcTransactionEngine {
  return createTbcEngineWithBackend(
    options.backend ?? createLazyBundledWasmTbcEngineBackend(options.wasm),
  );
}

export function createLazyBundledWasmTbcEngineBackend(
  options: TbcWasmAssetOptions = {},
): TbcEngineBackend {
  const url = options.url ?? bundledWasmUrl();
  const local = options.fetch === undefined ? fileUrl(url) : undefined;
  if (local === undefined) return createFetchLazyWasmBackend({ ...options, url });
  let backend: Promise<TbcEngineBackend> | undefined;
  return Object.freeze({
    call(method: TbcEngineMethod, canonicalInput: string) {
      const loading = backend ??= readFile(local)
        .then((bytes) => createWasmTbcEngineBackend(Uint8Array.from(bytes)));
      return loading.then((resolved) => resolved.call(method, canonicalInput));
    },
  });
}

export type { KitTransactionEngine } from "./public-types.js";
