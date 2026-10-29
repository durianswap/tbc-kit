import type { TbcOfficialApiClient } from "./official-api.js";
import { type ImmutableTransactionCache } from "./chain-data-tools.js";
export interface GetTbc721MintStatusInput {
    readonly collectionId: string;
    readonly address: string;
}
export interface Tbc721Collection {
    readonly collectionId: string;
    readonly ownerAddress: string;
    readonly supply: number;
}
type Observation = Readonly<{
    collectionId: string;
    address: string;
    source: "trusted-api";
}>;
/** Current API observation, not a slot reservation, mint authorization or consensus proof. */
export type Tbc721MintStatus = Observation & (Readonly<{
    status: "available" | "exhausted";
    collection: Tbc721Collection;
    availableSlots: readonly number[];
    availableCount: number;
    spentCount: number;
}> | Readonly<{
    status: "not-owner";
    collection: Tbc721Collection;
}> | Readonly<{
    status: "unknown";
    reason: "collection-unavailable" | "status-unavailable" | "incomplete-status";
    collection?: Tbc721Collection;
    availableSlots: readonly number[];
    unknownSlots?: readonly number[];
}>);
export interface Tbc721Reader {
    readonly getMintStatus: (input: GetTbc721MintStatusInput) => Promise<Tbc721MintStatus>;
}
export interface CreateTbc721ReaderOptions {
    /** Reuse the configured network/source; no API-domain switching. */
    readonly api: Pick<TbcOfficialApiClient, "rawTransaction" | "utxosByScriptHash" | "txoStatus">;
    /** Reuse the application's keyless Native/WASM codec; no signing or custody. */
    readonly engine: Readonly<{
        execute(operation: string, requestJson: string): Promise<string>;
    }>;
    readonly cache?: ImmutableTransactionCache;
}
export declare function createTbc721Reader(options: CreateTbc721ReaderOptions): Tbc721Reader;
export {};
//# sourceMappingURL=nft-query.d.ts.map