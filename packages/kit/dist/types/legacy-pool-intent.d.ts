import type { TbcLegacyMetadataResolver } from "./legacy-metadata.js";
export declare const LEGACY_POOL_REMOVE_MINIMUM_TBC_ATOMIC: "1";
export declare const LEGACY_POOL_REMOVE_MINIMUM_FT_RAW: "1";
export declare const LEGACY_POOL_SWAP_MINIMUM_TBC_ATOMIC: "1";
export declare const LEGACY_POOL_SWAP_MINIMUM_FT_RAW: "1";
export interface LegacyPoolIntentResolver {
    readonly resolve: (request: unknown, addressFrom: string) => Promise<Readonly<Record<string, unknown>>>;
}
export declare class LegacyPoolParameterError extends Error {
}
export declare function createLegacyPoolIntentResolver(options: {
    readonly chainId: string;
    readonly now?: () => Date;
    /** Advanced loader override. Prefer `metadata` for the bounded default path. */
    readonly resolvePoolFtDecimals?: (poolContractId: string) => Promise<number>;
    readonly metadata?: Pick<TbcLegacyMetadataResolver, "network" | "resolvePoolFtDecimals">;
}): LegacyPoolIntentResolver;
