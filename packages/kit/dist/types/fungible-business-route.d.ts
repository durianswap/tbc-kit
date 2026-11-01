import type { CoinMergeIntent, CoinTransferIntent, FtMergeIntent, FtTransferIntent, StablecoinMergeIntent, StablecoinTransferIntent, Tbc20StandardMergeIntent, Tbc20StandardTransferIntent } from "./public-types.js";
import { type IdentifyTbcFungibleContractsOptions, type TbcFungibleContractIdentity, type TbcFungibleContractMaterial } from "./contract-identification.js";
/** Internal shared lowering step. Not a new Provider RPC or an authorization. */
export type FungibleBusinessOperation = Readonly<{
    family: "tbc20" | "tbc20Stablecoin";
    contractId: string;
}> & (Readonly<{
    operation: "merge";
}> | (Readonly<{
    operation: "transfer";
    payment?: Readonly<{
        to: string;
        amount: string;
    }>;
}> & (Readonly<{
    to: string;
    amount: string;
    receivers?: never;
}> | Readonly<{
    receivers: readonly Readonly<{
        to: string;
        amount: string;
    }>[];
    to?: never;
    amount?: never;
}>)));
type Intent = CoinMergeIntent | CoinTransferIntent | FtMergeIntent | FtTransferIntent | StablecoinMergeIntent | StablecoinTransferIntent | Tbc20StandardMergeIntent | Tbc20StandardTransferIntent;
/** Existing transaction material only. This chooses a concrete builder intent,
 * not permission to sign it. Caller must bind contractId to its authentic
 * origin, and downstream Engine must independently validate all material.
 * Do this BEFORE request normalization/approval; never replace an approved
 * request or reuse its hash after lowering. No retry, network or cache here. */
export declare function resolveFungibleBusinessIntent(operation: FungibleBusinessOperation, material: readonly TbcFungibleContractMaterial[], options: IdentifyTbcFungibleContractsOptions): Promise<Readonly<{
    intent: Intent;
    recognition: TbcFungibleContractIdentity;
}>>;
export {};
