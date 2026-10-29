import type { KitSupportedIntent, KitTransactionRequest } from "./public-types.js";
interface AssetRequirement {
    readonly kind: "native" | "collection" | "nft" | "ft" | "stablecoin" | "pool" | "ftlp" | "timelock" | "htlc" | "lop";
    readonly contractId?: string;
    readonly contractDependency?: Readonly<{
        relation: "pool-ft" | "pool-lp";
        contractId: string;
    }>;
    readonly minimumAmount?: string;
}
/** Exact projection of Core requirements for the intent families exposed by Kit. */
export declare function preparedChainDataRequirement(request: KitTransactionRequest<KitSupportedIntent>): Readonly<{
    intentType: string;
    includeAncestry: boolean;
    contractIds?: readonly string[];
    nativeAmount?: string;
    lopAssets?: readonly Readonly<{
        standard: "tbc20-standard" | "tbc20-stablecoin";
        contractId: string;
        purpose: "identity" | "escrow";
    }>[];
    collectionSlots?: readonly number[];
    targetOutpoints?: readonly Readonly<{
        txid: string;
        vout: number;
    }>[];
    certificateOutpoint?: Readonly<{
        txid: string;
        vout: number;
    }>;
    inputOutpoints?: readonly Readonly<{
        readonly txid: string;
        readonly vout: number;
    }>[];
    assets: readonly AssetRequirement[];
}>;
export {};
//# sourceMappingURL=prepared-chain-data.d.ts.map