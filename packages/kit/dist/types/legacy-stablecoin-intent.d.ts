import type { TbcLegacyMetadataResolver } from "./legacy-metadata.js";
export interface LegacyStablecoinTransferIntentResolver {
    readonly resolve: (request: unknown, addressFrom: string, onMetadata?: (decimals: number) => void) => Promise<Readonly<Record<string, unknown>>>;
}
export interface CreateLegacyStablecoinTransferIntentResolverOptions {
    readonly chainId: string;
    /**
     * Preferred bounded Kit metadata path. It retains network/source identity and
     * short-lived Stablecoin decimals with the existing FT/Pool metadata cache.
     */
    readonly metadata?: Pick<TbcLegacyMetadataResolver, "network" | "resolveStablecoinDecimals">;
    /** Advanced wallet-owned authenticated/cache lookup override. */
    readonly resolveDecimals?: (contractId: string) => number | Promise<number>;
}
export declare class LegacyStablecoinParameterError extends Error {
}
export declare function isLegacyStablecoinTransferRequest(value: unknown): boolean;
export declare function createLegacyStablecoinTransferIntentResolver(options: CreateLegacyStablecoinTransferIntentResolverOptions): LegacyStablecoinTransferIntentResolver;
