import { type TbcEngineBackend, type TbcTransactionEngine, type TbcWasmAssetOptions } from "./engine-base.js";
export { TBC_ENGINE_METHODS, TBC_MAINNET_PROFILE, TBC_TESTNET_PROFILE, createNativeTbcEngineBackend, createWasmTbcEngineBackend, type TbcEngineBackend, type TbcEngineMethod, type TbcNetworkProfile, type TbcTransactionEngine, type TbcWasmAssetOptions, } from "./engine-base.js";
export declare function createTbcEngine(options?: Readonly<{
    backend?: TbcEngineBackend;
    wasm?: TbcWasmAssetOptions;
}>): TbcTransactionEngine;
/** Browser/React Native-safe loader. Native wallets normally inject their backend. */
export declare function createLazyBundledWasmTbcEngineBackend(options?: TbcWasmAssetOptions): TbcEngineBackend;
export type { KitTransactionEngine } from "./public-types.js";
//# sourceMappingURL=engine.d.ts.map