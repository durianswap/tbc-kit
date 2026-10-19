import { type ImmutableTransactionCache } from "./chain-data-tools.js";
import { type KitRequestLedger } from "./request-ledger.js";
export interface OptimizedChainDataCandidate {
    readonly txid: string;
    readonly [key: string]: unknown;
}
export interface OptimizedChainDataSource<TTip, TNative extends OptimizedChainDataCandidate, TAsset extends OptimizedChainDataCandidate, TContract, TResult> {
    readonly networkKey: string;
    readonly needsTip: (requirement: Readonly<Record<string, unknown>>) => boolean;
    readonly needsNative: (requirement: Readonly<Record<string, unknown>>) => boolean;
    readonly loadTip: () => Promise<TTip>;
    readonly loadNativeCandidates: (input: Readonly<{
        accountId: string;
        chainId: string;
        requirement: Readonly<Record<string, unknown>>;
    }>) => Promise<readonly TNative[]>;
    readonly loadAssetCandidates: (input: Readonly<{
        accountId: string;
        chainId: string;
        asset: Readonly<Record<string, unknown>>;
        requirement: Readonly<Record<string, unknown>>;
    }>) => Promise<readonly TAsset[]>;
    readonly loadContract: (input: Readonly<{
        chainId: string;
        contractId: string;
        requirement: Readonly<Record<string, unknown>>;
    }>) => Promise<TContract>;
    readonly selectNative: (input: Readonly<{
        candidates: readonly TNative[];
        requirement: Readonly<Record<string, unknown>>;
    }>) => readonly TNative[];
    readonly selectAsset: (input: Readonly<{
        asset: Readonly<Record<string, unknown>>;
        candidates: readonly TAsset[];
        requirement: Readonly<Record<string, unknown>>;
    }>) => readonly TAsset[];
    readonly requiredAncestry: (input: Readonly<{
        requirement: Readonly<Record<string, unknown>>;
        selectedNative: readonly TNative[];
        selectedAssets: readonly Readonly<{
            asset: Readonly<Record<string, unknown>>;
            candidates: readonly TAsset[];
        }>[];
        contracts: readonly Readonly<{
            contractId: string;
            value: TContract;
        }>[];
    }>) => readonly string[];
    readonly loadRawTransaction: (txid: string) => Promise<string>;
    readonly buildSnapshot: (input: Readonly<{
        params: Readonly<Record<string, unknown>>;
        tip?: TTip;
        selectedNative: readonly TNative[];
        selectedAssets: readonly Readonly<{
            asset: Readonly<Record<string, unknown>>;
            candidates: readonly TAsset[];
        }>[];
        contracts: readonly Readonly<{
            contractId: string;
            value: TContract;
        }>[];
        parents: readonly Readonly<{
            txid: string;
            rawTransaction: string;
        }>[];
    }>) => TResult | Promise<TResult>;
}
export interface OptimizedChainDataResolver<TResult> {
    readonly resolve: (params: unknown) => Promise<TResult>;
    readonly cacheSize: () => Readonly<{
        entries: number;
        hexCharacters: number;
    }>;
}
export declare function createOptimizedChainDataResolver<TTip, TNative extends OptimizedChainDataCandidate, TAsset extends OptimizedChainDataCandidate, TContract, TResult>(options: Readonly<{
    source: OptimizedChainDataSource<TTip, TNative, TAsset, TContract, TResult>;
    ledger?: KitRequestLedger;
    cache?: ImmutableTransactionCache;
}>): OptimizedChainDataResolver<TResult>;
