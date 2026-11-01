import type { ChainDataResolveResult, ChainDataResolveParams } from "./internal/core/index.js";
import type { KitWalletAccount } from "./wallet-runtime.js";
import type { TbcNetworkContext } from "./network-context.js";
import { type TbcNftMintJobScope } from "./nft-mint-job.js";
type Snapshot = Extract<ChainDataResolveResult, {
    snapshotHash: string;
}>;
type Parent = Snapshot["payload"]["parents"][number];
/** One job's authenticated material. Not a global UTXO manager or durable cache. */
export interface TbcNftMintJobMaterial {
    readonly expiresAt: string;
    readonly snapshot: (slots: readonly number[]) => Snapshot;
    /** Only after the shared Engine validated the bundle and every submission is accepted/known. */
    readonly acceptValidatedBatch: (slots: readonly number[], transactions: readonly Parent[]) => void;
}
/** The resolver passed here must use one private preparation read scope. */
export declare function prepareTbcNftMintJobMaterial(input: Readonly<{
    scope: TbcNftMintJobScope;
    account: KitWalletAccount;
    network: TbcNetworkContext;
    resolve: (params: ChainDataResolveParams, account: KitWalletAccount) => Promise<unknown>;
    now?: () => number;
}>): Promise<TbcNftMintJobMaterial>;
export {};
