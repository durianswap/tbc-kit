import {
  createFetchLazyWasmBackend,
  createTbcEngineWithBackend,
  type TbcEngineBackend,
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

export function createTbcEngine(options: Readonly<{
  backend?: TbcEngineBackend;
  wasm?: TbcWasmAssetOptions;
}> = {}): TbcTransactionEngine {
  return createTbcEngineWithBackend(
    options.backend ?? createLazyBundledWasmTbcEngineBackend(options.wasm),
  );
}

/** Browser/React Native-safe loader. Native wallets normally inject their backend. */
export function createLazyBundledWasmTbcEngineBackend(
  options: TbcWasmAssetOptions = {},
): TbcEngineBackend {
  return createFetchLazyWasmBackend(options);
}

export type { KitTransactionEngine } from "./public-types.js";
