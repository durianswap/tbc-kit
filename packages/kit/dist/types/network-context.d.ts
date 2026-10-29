import { type TbcNetworkProfile } from "./network-profiles.js";
export type TbcNetworkName = "mainnet" | "testnet";
export declare const OFFICIAL_TBC_MAINNET_API_ORIGIN: "https://api.turingbitchain.io";
export declare const OFFICIAL_TBC_TESTNET_API_ORIGIN: "https://api.tbcdev.org";
export interface TbcNetworkContext {
    readonly version: "1.0";
    readonly network: TbcNetworkName;
    readonly chainId: string;
    readonly profile: TbcNetworkProfile;
    readonly endpoint: Readonly<{
        readonly kind: "official" | "trusted-custom";
        readonly apiOrigin: string;
        readonly rpcOrigin?: string;
        readonly trustId: string;
    }>;
    /** Immutable partition key for cache, approval preparation and recovery. */
    readonly sourceIdentity: string;
}
export type CreateTbcNetworkContextOptions = Readonly<{
    network: TbcNetworkName;
    endpoint?: Readonly<{
        kind: "official";
    }> | Readonly<{
        kind: "trusted-custom";
        apiOrigin: string;
        rpcOrigin?: string;
        /** Wallet-owned stable identifier for the audited endpoint source. */
        trustId: string;
    }>;
}>;
export declare function tbcNetworkProfileForChainId(chainId: string): TbcNetworkProfile;
export declare function tbcNetworkNameForChainId(chainId: string): TbcNetworkName;
export declare function createTbcNetworkContext(options: CreateTbcNetworkContextOptions): TbcNetworkContext;
export declare function assertTbcNetworkContext(value: TbcNetworkContext): TbcNetworkContext;
//# sourceMappingURL=network-context.d.ts.map