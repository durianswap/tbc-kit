/**
 * Neutral native capability boundary for canonical Pool material.
 *
 * The current bundled/native ABI still calls the LP preview operation
 * `legacyPoolPreview`. That historical name is translated only here; the
 * canonical Pool material path uses `previewLiquidityAdd`.
 */
export declare const POOL_MATERIAL_NATIVE_OPERATIONS: readonly ["preparePoolNft", "prepareAssetAncestry", "previewLiquidityAdd"];
export type PoolMaterialNativeOperation = (typeof POOL_MATERIAL_NATIVE_OPERATIONS)[number];
export interface PoolMaterialNativeProvider {
    readonly protocolInfo: () => Promise<string>;
    readonly execute: (operation: PoolMaterialNativeOperation, requestJson: string) => Promise<string>;
}
/** Existing platform/native bridge shape accepted only at the compatibility boundary. */
export interface PoolMaterialNativeProviderInput {
    readonly protocolInfo: () => Promise<string>;
    readonly execute: (operation: string, requestJson: string) => Promise<string>;
}
/**
 * Adapts the current wallet/native ABI once, before canonical Pool material
 * resolution. No HTTP, Port, authority, signing or durable state is involved.
 */
export declare function createPoolMaterialNativeProvider(input: PoolMaterialNativeProviderInput): PoolMaterialNativeProvider;
//# sourceMappingURL=pool-material-native.d.ts.map