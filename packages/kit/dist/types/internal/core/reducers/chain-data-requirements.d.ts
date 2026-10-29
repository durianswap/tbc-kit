interface ContractDependency {
    readonly relation: "pool-ft" | "pool-lp";
    readonly contractId: string;
}
interface AssetRequirement {
    readonly kind: "native" | "collection" | "nft" | "ft" | "stablecoin" | "pool" | "ftlp" | "timelock" | "htlc" | "lop";
    readonly contractId?: string;
    readonly contractDependency?: ContractDependency;
    readonly minimumAmount?: string;
}
interface TransactionIntent {
    readonly type: string;
    readonly order?: Readonly<{
        side: "buy" | "sell";
        market: "native-token" | "token-token";
        assetA: Readonly<{
            standard: "tbc20-standard" | "tbc20-stablecoin";
            contractId: string;
        }>;
        assetB?: Readonly<{
            standard: "tbc20-standard" | "tbc20-stablecoin";
            contractId: string;
        }>;
        saleVolume: string;
        unitPrice: string;
    }>;
    readonly stage?: "mint" | "initialize";
    readonly amount?: string;
    readonly to?: string;
    readonly receivers?: readonly Readonly<{
        to: string;
        amount: string;
    }>[];
    readonly slot?: number;
    readonly items?: readonly Readonly<{
        slot: number;
    }>[];
    readonly transfers?: readonly Readonly<{
        contractId: string;
        to: string;
        payment?: Readonly<{
            to: string;
            amount: string;
        }>;
    }>[];
    readonly payment?: Readonly<{
        to: string;
        amount: string;
    }>;
    readonly targetOutpoints?: readonly Readonly<{
        txid: string;
        vout: number;
    }>[];
    readonly certificateOutpoint?: Readonly<{
        txid: string;
        vout: number;
    }>;
    readonly attachedTbcAmount?: string;
    readonly collectionId?: string;
    readonly contractId?: string;
    readonly ftContractId?: string;
    readonly assetStandard?: "tbc20-standard" | "tbc20-stablecoin";
    readonly poolContractId?: string;
    readonly tbcAmount?: string;
    readonly ftAmount?: string;
    readonly lpAmount?: string;
    readonly direction?: "tbc-to-ft" | "ft-to-tbc";
    readonly budgetAsset?: "tbc" | "ft";
    readonly initialFtAmount?: string;
    readonly initialLiquidity?: {
        readonly tbcAmount: string;
        readonly ftAmount: string;
    };
}
export interface TransactionRequestLike {
    readonly intent: TransactionIntent;
    readonly constraints?: {
        readonly inputOutpoints?: readonly Readonly<{
            readonly txid: string;
            readonly vout: number;
        }>[];
    };
}
export interface ChainDataRequirement {
    readonly intentType: string;
    readonly includeAncestry: boolean;
    readonly contractIds?: readonly string[];
    readonly nativeAmount?: string;
    /** Identity-only assets must not trigger account balance/UTXO scans. Order
     * of this list is A then B; it is a read plan, never authorization evidence. */
    readonly lopAssets?: readonly Readonly<{
        standard: "tbc20-standard" | "tbc20-stablecoin";
        contractId: string;
        purpose: "identity" | "escrow";
    }>[];
    readonly collectionSlots?: readonly number[];
    readonly targetOutpoints?: readonly Readonly<{
        txid: string;
        vout: number;
    }>[];
    readonly certificateOutpoint?: Readonly<{
        txid: string;
        vout: number;
    }>;
    readonly inputOutpoints?: readonly Readonly<{
        readonly txid: string;
        readonly vout: number;
    }>[];
    readonly assets: readonly AssetRequirement[];
}
export declare function chainDataRequirement(request: TransactionRequestLike): ChainDataRequirement;
export declare function workflowChainDataRequirement(requests: readonly TransactionRequestLike[]): ChainDataRequirement;
export {};
//# sourceMappingURL=chain-data-requirements.d.ts.map