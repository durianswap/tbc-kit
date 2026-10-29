import { type TbcEngineBackend, type TbcTransactionEngine, type TbcWasmAssetOptions } from "./engine-base.js";
export { TBC_ENGINE_METHODS, TBC_MAINNET_PROFILE, TBC_TESTNET_PROFILE, createNativeTbcEngineBackend, createWasmTbcEngineBackend, type TbcEngineBackend, type TbcEngineMethod, type TbcNetworkProfile, type TbcTransactionEngine, type TbcWasmAssetOptions, } from "./engine-base.js";
export declare function createTbcEngine(options?: Readonly<{
    backend?: TbcEngineBackend;
    wasm?: TbcWasmAssetOptions;
}>): TbcTransactionEngine;
export declare function createLazyBundledWasmTbcEngineBackend(options?: TbcWasmAssetOptions): TbcEngineBackend;
export type { KitTransactionEngine } from "./public-types.js";
//# sourceMappingURL=engine.node.d.ts.map