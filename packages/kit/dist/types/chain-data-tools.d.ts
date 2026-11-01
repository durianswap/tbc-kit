import type { KitRequestLedger } from "./request-ledger.js";
export interface ImmutableTransactionBytes {
    readonly txid: string;
    readonly rawTransaction: string;
}
export interface ImmutableTransactionCache {
    readonly get: (txid: string) => ImmutableTransactionBytes | undefined;
    readonly remember: (value: ImmutableTransactionBytes) => void;
    readonly size: () => Readonly<{
        entries: number;
        hexCharacters: number;
    }>;
}
export declare function createImmutableTransactionCache(options?: Readonly<{
    maxEntries?: number;
    maxHexCharacters?: number;
}>): ImmutableTransactionCache;
export interface SelectedAncestryResult<TCandidate, TParent> {
    readonly selected: readonly TCandidate[];
    readonly parents: readonly TParent[];
}
export declare function selectThenLoadAncestry<TCandidate, TParent>(options: Readonly<{
    candidates: readonly TCandidate[];
    select: (candidates: readonly TCandidate[]) => readonly TCandidate[];
    parentTxid: (candidate: TCandidate) => string;
    loadParent: (txid: string) => Promise<TParent>;
    ledger?: KitRequestLedger;
    concurrencyGroup?: string;
}>): Promise<SelectedAncestryResult<TCandidate, TParent>>;
export declare function loadIndependentGroups<T extends Readonly<Record<string, () => Promise<unknown>>>>(groups: T): Promise<{
    readonly [K in keyof T]: Awaited<ReturnType<T[K]>>;
}>;
