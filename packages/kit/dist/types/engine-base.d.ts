import type { TransactionEngine } from "./internal/core/index.js";
export { TBC_MAINNET_PROFILE, TBC_TESTNET_PROFILE, type TbcNetworkProfile, } from "./network-profiles.js";
export declare const TBC_ENGINE_METHODS: readonly ["normalizeRequest", "plan", "validate", "finalize"];
export type TbcEngineMethod = (typeof TBC_ENGINE_METHODS)[number];
export interface TbcEngineBackend {
    readonly call: (method: TbcEngineMethod, canonicalInput: string) => string | Promise<string>;
}
export type TbcTransactionEngine = TransactionEngine;
export interface TbcWasmAssetOptions {
    readonly fetch?: typeof globalThis.fetch;
    readonly url?: string | URL;
}
export declare function bundledWasmUrl(): URL;
export declare function createTbcEngineWithBackend(backend: TbcEngineBackend): TbcTransactionEngine;
export declare function createFetchLazyWasmBackend(options?: TbcWasmAssetOptions): TbcEngineBackend;
export declare function createNativeTbcEngineBackend(call: TbcEngineBackend["call"]): TbcEngineBackend;
export declare function createWasmTbcEngineBackend(source: ArrayBuffer | Uint8Array | WebAssembly.Module): Promise<TbcEngineBackend>;
//# sourceMappingURL=engine-base.d.ts.map