import type { PoolMaterialNativeProviderInput } from "./pool-material-native.js";
export type LopReviewScripts = Readonly<{
    inputs: readonly string[];
    outputs: readonly string[];
}>;
export type LopOrderInspection = Readonly<{
    verification: "exact-template";
    assetIdentityVerified: false;
    inputs: readonly Readonly<{
        index: number;
        terms: Readonly<Record<string, unknown>>;
    }>[];
    outputs: readonly Readonly<{
        index: number;
        terms: Readonly<Record<string, unknown>>;
    }>[];
}>;
export type LopReviewMaterial = Readonly<{
    orders: LopOrderInspection;
    inputControllers: ReadonlyMap<number, string>;
    outputControllers: ReadonlyMap<number, string>;
}>;
/** One batched local call over already available scripts; no chain reads or
 * approval authority. Exact Rust codec is shared with planning, not a tail-tag
 * recognizer. Token IDs here are committed order terms, not authenticated
 * token issuance identities. Rejected asset flows stay rejected by reviewer. */
export declare function inspectReviewedLopOrders(native: PoolMaterialNativeProviderInput, transactions: readonly LopReviewScripts[]): Promise<readonly LopOrderInspection[]>;
export declare function inspectReviewedLopMaterials(native: PoolMaterialNativeProviderInput, transactions: readonly LopReviewScripts[]): Promise<readonly LopReviewMaterial[]>;
//# sourceMappingURL=reviewed-lop.d.ts.map