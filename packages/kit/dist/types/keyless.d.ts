import type { LegacyPoolSigningProductionNativeEngine } from "./pool-signing-loader.js";
import { type KeylessWasmAssetOptions } from "./keyless-wasm-asset.js";
export declare const TBC_KEYLESS_OPERATIONS: readonly ["preparePoolNft", "prepareAssetAncestry", "legacyPoolPreview", "inspectTokenReceipt", "inspectNftReceipt", "prepareReviewedStage", "finalizeReviewedStage", "inspectAmmMaterial", "inspectLopMaterial", "inspectTokenMaterial", "describeMultisig", "decodeMultisigAddress", "prepareMultisig", "inspectMultisig", "reviewMultisig", "verifyMultisigSignatures", "finalizeMultisig"];
export type TbcKeylessOperation = (typeof TBC_KEYLESS_OPERATIONS)[number];
export declare function createWasmTbcKeylessEngine(source: ArrayBuffer | Uint8Array | WebAssembly.Module): Promise<LegacyPoolSigningProductionNativeEngine>;
export declare function createLazyBundledWasmTbcKeylessEngine(input?: typeof globalThis.fetch | KeylessWasmAssetOptions): LegacyPoolSigningProductionNativeEngine;
/** Thin adapter for a platform-owned Native bridge. No key or signing operation is accepted. */
export declare function createNativeTbcKeylessEngine(execute: LegacyPoolSigningProductionNativeEngine["execute"]): LegacyPoolSigningProductionNativeEngine;
