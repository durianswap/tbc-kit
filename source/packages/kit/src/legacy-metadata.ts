import { createRequestLedger, type KitRequestLedger } from "./request-ledger.js";
import { createTbcOfficialApi } from "./official-api.js";
import { TbcTransportError } from "./network-transport.js";
import {
  assertTbcNetworkContext,
  type TbcNetworkContext,
} from "./network-context.js";
import {
  createTbcChainClient,
  type TbcChainFetch,
  type TestnetFtInfo,
} from "./testnet-client.js";
import { assertHash32 } from "./testnet-validation.js";

const DEFAULT_CACHE_TTL_MS = 30_000;
const DEFAULT_CACHE_ENTRIES = 32;
const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

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
  readonly resolvePoolFtIdentity: (
    poolContractId: string,
  ) => Promise<TbcPoolFtIdentity>;
  readonly resolvePoolFtDecimals: (poolContractId: string) => Promise<number>;
}

const ftCreationIdentityLoaders = new WeakMap<
  object,
  (contractId: string) => Promise<TbcFtCreationIdentity>
>();

/** Package-private fast path; arbitrary structural metadata objects remain untrusted. */
export function loadTbcLegacyFtCreationIdentity(
  metadata: Pick<TbcLegacyMetadataResolver, "getFtInfo">,
  contractId: string,
): Promise<TbcFtCreationIdentity> {
  const loader = ftCreationIdentityLoaders.get(metadata);
  return loader === undefined ? metadata.getFtInfo(contractId) : loader(contractId);
}

export interface CreateTbcLegacyMetadataResolverOptions {
  readonly network: TbcNetworkContext;
  readonly fetch: TbcChainFetch;
  /** Optional local Code-template inspection for current FT metadata bounds.
   * This does not grant authority to an API-provided standard label. */
  readonly resolveFtStandard?: (codeScript: string) =>
    "tbc20-standard" | undefined | Promise<"tbc20-standard" | undefined>;
  /** Short-lived for complete API responses that can contain mutable fields. */
  readonly cacheTtlMs?: number;
  readonly maxCacheEntries?: number;
  readonly maxResponseBytes?: number;
  readonly requestTimeoutMs?: number;
  readonly ledger?: KitRequestLedger;
  readonly now?: () => number;
}

export class TbcLegacyMetadataError extends Error {
  override readonly name = "TbcLegacyMetadataError";
}

function fail(message: string): never {
  throw new TbcLegacyMetadataError(message);
}

interface CacheEntry<T> {
  readonly value: T;
  readonly expiresAt: number;
}

/**
 * Default FT and Pool-to-FT metadata path for one immutable network source.
 * Complete responses remain short-lived. The FT creation identity subset is
 * instance-local and bounded but has no TTL because the protocol authenticates
 * those fields against the creation transaction. Concurrent identical reads are
 * single-flighted by the shared request ledger.
 */
export function createTbcLegacyMetadataResolver(
  options: CreateTbcLegacyMetadataResolverOptions,
): TbcLegacyMetadataResolver {
  if (
    options === null ||
    typeof options !== "object" ||
    typeof options.fetch !== "function" ||
    (options.resolveFtStandard !== undefined &&
      typeof options.resolveFtStandard !== "function")
  ) {
    throw new TypeError("TBC Legacy metadata fetch is required");
  }
  const network = assertTbcNetworkContext(options.network);
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const maxCacheEntries = options.maxCacheEntries ?? DEFAULT_CACHE_ENTRIES;
  const maxResponseBytes =
    options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const requestTimeoutMs =
    options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(cacheTtlMs) ||
    cacheTtlMs < 0 ||
    cacheTtlMs > 5 * 60_000 ||
    !Number.isSafeInteger(maxCacheEntries) ||
    maxCacheEntries < 1 ||
    maxCacheEntries > 128 ||
    !Number.isSafeInteger(maxResponseBytes) ||
    maxResponseBytes < 512 ||
    maxResponseBytes > 16 * 1024 * 1024 ||
    !Number.isSafeInteger(requestTimeoutMs) ||
    requestTimeoutMs < 100 ||
    requestTimeoutMs > 60_000
  ) {
    throw new TypeError("Invalid TBC Legacy metadata limits");
  }
  const now = options.now ?? Date.now;
  const ledger = options.ledger ?? createRequestLedger();
  const client = createTbcChainClient({
    baseUrl: network.endpoint.apiOrigin,
    allowedOrigins: [network.endpoint.apiOrigin],
    fetch: options.fetch,
    maxResponseBytes,
    requestTimeoutMs,
    ledger,
  });
  const api = createTbcOfficialApi({
    baseUrl: network.endpoint.apiOrigin,
    allowedOrigins: [network.endpoint.apiOrigin],
    fetch: options.fetch,
    maxResponseBytes,
    timeoutMs: requestTimeoutMs,
    ledger,
  });
  const ftCache = new Map<string, CacheEntry<TbcFtContractMetadata>>();
  const ftCreationIdentityCache = new Map<string, TbcFtCreationIdentity>();
  const poolCache = new Map<string, CacheEntry<TbcPoolFtIdentity>>();
  const stablecoinDecimalsCache = new Map<string, CacheEntry<number>>();

  const stamp = (): number => {
    const value = now();
    if (!Number.isFinite(value)) return fail("Invalid TBC metadata clock");
    return value;
  };

  function cached<T>(map: Map<string, CacheEntry<T>>, key: string): T | undefined {
    const entry = map.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= stamp()) {
      map.delete(key);
      return undefined;
    }
    map.delete(key);
    map.set(key, entry);
    return entry.value;
  }

  function remember<T>(map: Map<string, CacheEntry<T>>, key: string, value: T): T {
    if (cacheTtlMs === 0) return value;
    map.delete(key);
    while (map.size >= maxCacheEntries) {
      const oldest = map.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
    map.set(key, Object.freeze({ value, expiresAt: stamp() + cacheTtlMs }));
    return value;
  }

  function cachedFtCreationIdentity(
    key: string,
  ): TbcFtCreationIdentity | undefined {
    const identity = ftCreationIdentityCache.get(key);
    if (identity === undefined) return undefined;
    ftCreationIdentityCache.delete(key);
    ftCreationIdentityCache.set(key, identity);
    return identity;
  }

  function rememberFtCreationIdentity(
    key: string,
    metadata: TbcFtCreationIdentity,
  ): TbcFtCreationIdentity {
    const candidate = Object.freeze({
      contractId: metadata.contractId,
      decimals: metadata.decimals,
      name: metadata.name,
      symbol: metadata.symbol,
    });
    const existing = ftCreationIdentityCache.get(key);
    if (existing !== undefined) {
      if (
        existing.contractId !== candidate.contractId ||
        existing.decimals !== candidate.decimals ||
        existing.name !== candidate.name ||
        existing.symbol !== candidate.symbol
      ) {
        return fail("FT creation metadata identity changed");
      }
      ftCreationIdentityCache.delete(key);
      ftCreationIdentityCache.set(key, existing);
      return existing;
    }
    while (ftCreationIdentityCache.size >= maxCacheEntries) {
      const oldest = ftCreationIdentityCache.keys().next().value as
        | string
        | undefined;
      if (oldest === undefined) break;
      ftCreationIdentityCache.delete(oldest);
    }
    ftCreationIdentityCache.set(key, candidate);
    return candidate;
  }

  async function getFtInfo(contractInput: string): Promise<TbcFtContractMetadata> {
    const contractId = assertHash32(contractInput.toLowerCase());
    const key = `${network.sourceIdentity}:ft:${contractId}`;
    const reuse = cached(ftCache, key);
    if (reuse !== undefined) return reuse;
    const metadata = await client.getFtInfo(
      contractId,
      options.resolveFtStandard === undefined
        ? undefined
        : { resolveStandard: options.resolveFtStandard },
    );
    if (metadata.contractId !== contractId) {
      return fail("FT metadata identity mismatch");
    }
    rememberFtCreationIdentity(key, metadata);
    return remember(ftCache, key, metadata);
  }

  async function getFtCreationIdentity(
    contractInput: string,
  ): Promise<TbcFtCreationIdentity> {
    const contractId = assertHash32(contractInput.toLowerCase());
    const key = `${network.sourceIdentity}:ft:${contractId}`;
    const reuse = cachedFtCreationIdentity(key);
    if (reuse !== undefined) return reuse;
    const metadata = await getFtInfo(contractId);
    return rememberFtCreationIdentity(key, metadata);
  }

  async function resolveStablecoinDecimals(contractInput: string): Promise<number> {
    const contractId = assertHash32(contractInput.toLowerCase());
    const key = `${network.sourceIdentity}:stablecoin:${contractId}`;
    const reuse = cached(stablecoinDecimalsCache, key);
    if (reuse !== undefined) return reuse;
    const data = await api.stablecoinInfo({ stablecoin_id: contractId });
    const responseContract = data.stablecoin_id;
    const rawDecimals = data.decimal;
    const decimals = typeof rawDecimals === "number"
      ? rawDecimals
      : typeof rawDecimals === "string" && /^(?:0|[1-9][0-9]*)$/u.test(rawDecimals)
        ? Number(rawDecimals)
        : Number.NaN;
    if (
      typeof responseContract !== "string" ||
      responseContract.toLowerCase() !== contractId ||
      !Number.isSafeInteger(decimals) ||
      decimals < 0 ||
      decimals > 18
    ) {
      return fail("Stablecoin metadata identity mismatch");
    }
    return remember(stablecoinDecimalsCache, key, decimals);
  }

  async function loadPoolFtIdentity(
    poolContractId: string,
  ): Promise<TbcPoolFtIdentity> {
    let ftContractId: string;
    try {
      const data = await api.poolInfo(
        { pool_id: poolContractId },
        { category: "pool" },
      );
      ftContractId = assertHash32(data.ft_contract_id.toLowerCase());
    } catch (error) {
      if (
        error instanceof TbcTransportError &&
        /unauthorized origin/u.test(error.message)
      ) {
        return fail("Pool FT metadata response changed source");
      }
      return fail("Pool FT metadata request failed");
    }
    return Object.freeze({
      poolContractId,
      ftContractId,
      sourceIdentity: network.sourceIdentity,
    });
  }

  async function resolvePoolFtIdentity(
    poolInput: string,
  ): Promise<TbcPoolFtIdentity> {
    const poolContractId = assertHash32(poolInput.toLowerCase());
    const key = `${network.sourceIdentity}:pool:${poolContractId}`;
    const reuse = cached(poolCache, key);
    if (reuse !== undefined) return reuse;
    const identity = await loadPoolFtIdentity(poolContractId);
    if (
      identity.poolContractId !== poolContractId ||
      identity.sourceIdentity !== network.sourceIdentity
    ) {
      return fail("Pool FT metadata identity mismatch");
    }
    return remember(poolCache, key, identity);
  }

  async function resolvePoolFtDecimals(poolContractId: string): Promise<number> {
    const identity = await resolvePoolFtIdentity(poolContractId);
    const metadata = await getFtCreationIdentity(identity.ftContractId);
    if (metadata.contractId !== identity.ftContractId) {
      return fail("Pool FT metadata identity mismatch");
    }
    return metadata.decimals;
  }

  const resolver = Object.freeze({
    network,
    sourceIdentity: network.sourceIdentity,
    getFtInfo,
    resolveStablecoinDecimals,
    resolvePoolFtIdentity,
    resolvePoolFtDecimals,
  });
  ftCreationIdentityLoaders.set(resolver, getFtCreationIdentity);
  return resolver;
}
