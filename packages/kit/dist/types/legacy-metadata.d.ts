import { type KitRequestLedger } from "./request-ledger.js";
import { type TbcNetworkContext } from "./network-context.js";
import { type TbcChainFetch, type TestnetFtInfo } from "./testnet-client.js";
export type TbcFtContractMetadata = TestnetFtInfo;
export type TbcFtCreationIdentity = Readonly<{
    contractId: string;
    decimals: number;
    name: string;
    symbol: string;
}>;
export type TbcPoolFtIdentity = Readonly<{
    poolContractId: string;
    ftContractId: string;
    sourceIdentity: string;
}>;
export interface TbcLegacyMetadataResolver {
    readonly network: TbcNetworkContext;
    readonly sourceIdentity: string;
    readonly getFtInfo: (contractId: string) => Promise<TbcFtContractMetadata>;
    readonly resolveStablecoinDecimals: (contractId: string) => Promise<number>;
    readonly resolvePoolFtIdentity: (poolContractId: string) => Promise<TbcPoolFtIdentity>;
    readonly resolvePoolFtDecimals: (poolContractId: string) => Promise<number>;
}
/** Package-private fast path; arbitrary structural metadata objects remain untrusted. */
export declare function loadTbcLegacyFtCreationIdentity(metadata: Pick<TbcLegacyMetadataResolver, "getFtInfo">, contractId: string): Promise<TbcFtCreationIdentity>;
export interface CreateTbcLegacyMetadataResolverOptions {
    readonly network: TbcNetworkContext;
    readonly fetch: TbcChainFetch;
    /** Optional local Code-template inspection for current FT metadata bounds.
     * This does not grant authority to an API-provided standard label. */
    readonly resolveFtStandard?: (codeScript: string) => "tbc20-standard" | undefined | Promise<"tbc20-standard" | undefined>;
    /** Short-lived for complete API responses that can contain mutable fields. */
    readonly cacheTtlMs?: number;
    readonly maxCacheEntries?: number;
    readonly maxResponseBytes?: number;
    readonly requestTimeoutMs?: number;
    readonly ledger?: KitRequestLedger;
    readonly now?: () => number;
}
export declare class TbcLegacyMetadataError extends Error {
    readonly name = "TbcLegacyMetadataError";
}
/**
 * Default FT and Pool-to-FT metadata path for one immutable network source.
 * Complete responses remain short-lived. The FT creation identity subset is
 * instance-local and bounded but has no TTL because the protocol authenticates
 * those fields against the creation transaction. Concurrent identical reads are
 * single-flighted by the shared request ledger.
 */
export declare function createTbcLegacyMetadataResolver(options: CreateTbcLegacyMetadataResolverOptions): TbcLegacyMetadataResolver;
//# sourceMappingURL=legacy-metadata.d.ts.map