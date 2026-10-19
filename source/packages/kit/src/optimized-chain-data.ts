import {
  createImmutableTransactionCache,
  type ImmutableTransactionCache,
} from "./chain-data-tools.js";
import { createRequestLedger, type KitRequestLedger } from "./request-ledger.js";

export interface OptimizedChainDataCandidate {
  readonly txid: string;
  readonly [key: string]: unknown;
}

export interface OptimizedChainDataSource<
  TTip,
  TNative extends OptimizedChainDataCandidate,
  TAsset extends OptimizedChainDataCandidate,
  TContract,
  TResult,
> {
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
    contracts: readonly Readonly<{ contractId: string; value: TContract }>[];
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
    contracts: readonly Readonly<{ contractId: string; value: TContract }>[];
    parents: readonly Readonly<{ txid: string; rawTransaction: string }>[];
  }>) => TResult | Promise<TResult>;
}

export interface OptimizedChainDataResolver<TResult> {
  readonly resolve: (params: unknown) => Promise<TResult>;
  readonly cacheSize: () => Readonly<{ entries: number; hexCharacters: number }>;
}

function record(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`Invalid ${label}`);
  return value as Readonly<Record<string, unknown>>;
}

function bytes(value: unknown): number | undefined {
  try { return new TextEncoder().encode(JSON.stringify(value)).length; } catch { return undefined; }
}

export function createOptimizedChainDataResolver<
  TTip,
  TNative extends OptimizedChainDataCandidate,
  TAsset extends OptimizedChainDataCandidate,
  TContract,
  TResult,
>(options: Readonly<{
  source: OptimizedChainDataSource<TTip, TNative, TAsset, TContract, TResult>;
  ledger?: KitRequestLedger;
  cache?: ImmutableTransactionCache;
}>): OptimizedChainDataResolver<TResult> {
  const { source } = options;
  if (source.networkKey.length === 0) throw new TypeError("Chain Data network key is required");
  const cache = options.cache ?? createImmutableTransactionCache();
  const ledger = options.ledger ?? createRequestLedger();
  const run = <T>(input: Readonly<{
    category: "tip" | "native-index" | "asset-index" | "pool" | "txraw";
    key: string;
    group: string;
    execute: () => Promise<T>;
  }>) => ledger.run({
        category: input.category,
        key: `${source.networkKey}:${input.key}`,
        concurrencyGroup: input.group,
        responseBytes: bytes,
        execute: input.execute,
      });

  return Object.freeze({
    async resolve(rawParams: unknown): Promise<TResult> {
      const params = record(rawParams, "Chain Data parameters");
      const accountId = params.accountId;
      const chainId = params.chainId;
      const requirement = record(params.requirement, "Chain Data requirement");
      if (typeof accountId !== "string" || accountId.length === 0 || typeof chainId !== "string" || chainId.length === 0) {
        throw new TypeError("Invalid Chain Data account or chain");
      }
      const assetsValue = requirement.assets ?? [];
      const contractIdsValue = requirement.contractIds ?? [];
      if (!Array.isArray(assetsValue) || !Array.isArray(contractIdsValue) || contractIdsValue.some((value) => typeof value !== "string")) {
        throw new TypeError("Invalid Chain Data assets or contracts");
      }
      const assets = Object.freeze(assetsValue.map((asset) => record(asset, "Chain Data asset")));
      const contractIds = Object.freeze([...new Set(contractIdsValue as string[])]);
      const group = `indexes:${accountId}`;
      const tipPromise = source.needsTip(requirement)
        ? run({ category: "tip", key: chainId, group, execute: source.loadTip })
        : Promise.resolve(undefined);
      const nativePromise = source.needsNative(requirement)
        ? run({
            category: "native-index",
            key: accountId,
            group,
            execute: () => source.loadNativeCandidates({ accountId, chainId, requirement }),
          })
        : Promise.resolve(Object.freeze([]) as readonly TNative[]);
      const assetPromises = assets.map((asset, index) => run({
        category: "asset-index",
        key: `${accountId}:${index}:${String(asset.kind ?? "asset")}:${String(asset.contractId ?? "")}`,
        group,
        execute: () => source.loadAssetCandidates({ accountId, chainId, asset, requirement }),
      }));
      const contractPromises = contractIds.map((contractId) => run({
        category: "pool",
        key: contractId,
        group,
        execute: () => source.loadContract({ chainId, contractId, requirement }),
      }));
      const [tip, nativeCandidates, assetCandidates, contractValues] = await Promise.all([
        tipPromise,
        nativePromise,
        Promise.all(assetPromises),
        Promise.all(contractPromises),
      ]);
      const selectedNative = Object.freeze([...source.selectNative({ candidates: nativeCandidates, requirement })]);
      const selectedAssets = Object.freeze(assets.map((asset, index) => Object.freeze({
        asset,
        candidates: Object.freeze([...source.selectAsset({ asset, candidates: assetCandidates[index] ?? [], requirement })]),
      })));
      const contracts = Object.freeze(contractIds.map((contractId, index) => Object.freeze({ contractId, value: contractValues[index]! })));
      const ancestry = Object.freeze([...new Set(source.requiredAncestry({ requirement, selectedNative, selectedAssets, contracts }))]);
      const parents = Object.freeze(await Promise.all(ancestry.map(async (txid) => {
        if (!/^[0-9a-f]{64}$/u.test(txid)) throw new TypeError("Invalid ancestry transaction ID");
        const cached = cache.get(txid);
        if (cached !== undefined) return cached;
        const rawTransaction = await run({
          category: "txraw",
          key: txid,
          group: `ancestry:${accountId}`,
          execute: () => source.loadRawTransaction(txid),
        });
        const value = Object.freeze({ txid, rawTransaction });
        cache.remember(value);
        return value;
      })));
      return await source.buildSnapshot({
        params,
        ...(tip === undefined ? {} : { tip }),
        selectedNative,
        selectedAssets,
        contracts,
        parents,
      });
    },
    cacheSize: cache.size,
  });
}
