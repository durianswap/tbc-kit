import { assertValidTws, hashCanonical } from "@tbc-wallet/core";
import { createDefaultTbcChainDataResolver, type DefaultTbcChainDataResolver } from "./default-chain-data.js";
import { createRequestLedger, type KitRequestLedger } from "./request-ledger.js";
import {
  createPoolTransactionInspector,
  createLazyProductionPoolMaterialSource,
  normalizePoolMaterialConfirmationPolicy,
  type PoolMaterialConfirmationPolicy,
  type PoolMergeIndex,
  type PoolMergeIndexKind,
  type PoolMaterialSource,
  type PoolSnapshotMaterial,
} from "./pool-material.js";
import { createLazyBundledWasmTbcKeylessEngine } from "./keyless.js";
import {
  createDefaultTbcBroadcast,
  type DefaultTbcBroadcast,
} from "./default-broadcast.js";
import type { TbcKitBroadcastJournal } from "./broadcast-journal.js";
import type { TbcKitBroadcastJournalRecord } from "./broadcast-journal.js";
import type { PoolMaterialNativeProviderInput } from "./pool-material-native.js";
import { poolServiceFeeRate } from "./pool-policy.js";
import { createTestnetClient, OFFICIAL_TBC_TESTNET_API_ORIGIN, type TestnetClient, type TestnetFetch } from "./testnet-client.js";
import { assertTbcAddress } from "./testnet-validation.js";
import type { inspectTbcTransaction } from "./testnet-validation.js";
import type { KitHostPortCall, KitWalletAccount } from "./wallet-runtime.js";
import {
  assertTbcNetworkContext,
  createTbcNetworkContext,
  OFFICIAL_TBC_MAINNET_API_ORIGIN,
  type TbcNetworkContext,
} from "./network-context.js";

export const DEFAULT_TBC_TESTNET_POLICY = Object.freeze({
  policyId: "tbc-testnet-kit-r1",
  revision: "1",
  feeRateSatPerKb: "80",
  dustThreshold: "24",
  minConfirmations: "0",
  maxBundleTransactions: 32,
  maximumNativeAmount: "2100000000000000",
  ttlMs: 300_000,
});

export const DEFAULT_TBC_MAINNET_POLICY = Object.freeze({
  ...DEFAULT_TBC_TESTNET_POLICY,
  policyId: "tbc-mainnet-kit-r1",
});

const TBC20_STANDARD_INTENTS = new Set([
  "tbc20-standard-create", "tbc20-standard-transfer", "tbc20-standard-merge",
]);
const TBC20_MAX_SLOT = (1n << 63n) - 1n;
const COIN_INTENTS = new Set(["tbc20-stablecoin-create", "tbc20-stablecoin-transfer", "tbc20-stablecoin-merge",
  "tbc20-stablecoin-mint", "tbc20-stablecoin-freeze", "tbc20-stablecoin-unfreeze"]);
const COIN_CONTRACT_POLICIES = Object.freeze([Object.freeze({ family: "stablecoin", allowedVersions: Object.freeze(["coin"]) })]);
const LOP_INTENTS = new Set(["tbc-lop-create", "tbc-lop-cancel", "tbc-lop-match"]);
const AMM_LP_INTENTS = new Set(["tbc-amm-create", "tbc-amm-add-liquidity", "tbc-amm-remove-liquidity", "tbc-amm-swap",
  "tbc20-lp-transfer", "tbc20-lp-lock", "tbc20-lp-merge", "tbc20-lp-unlock"]);
const AMM_CONTRACT_POLICIES = Object.freeze([Object.freeze({ family: "pool", allowedVersions: Object.freeze(["pool3"]), createVersion: "pool3" })]);
const AMM_AMOUNT_LIMITS = Object.freeze([
  Object.freeze({ scope: "ft-total" as const, protocolVersion: "tbc20", maximum: (6n * ((1n << 63n) - 1n)).toString() }),
  Object.freeze({ scope: "ft-slot" as const, protocolVersion: "tbc20", maximum: ((1n << 63n) - 1n).toString() }),
  Object.freeze({ scope: "lp-total" as const, protocolVersion: "pool3", maximum: (6n * ((1n << 63n) - 1n)).toString() }),
  Object.freeze({ scope: "lp-slot" as const, protocolVersion: "pool3", maximum: ((1n << 63n) - 1n).toString() }),
]);
const TBC721_STANDARD_INTENTS = new Set([
  "tbc721-standard-create-collection", "tbc721-standard-mint", "tbc721-standard-batch-mint", "tbc721-standard-transfer",
]);
const TBC721_CONTRACT_POLICIES = Object.freeze(["collection", "nft"].map(family => Object.freeze({
  family, allowedVersions: Object.freeze(["tbc721"]), createVersion: "tbc721",
})));
const TBC20_CONTRACT_POLICIES = Object.freeze([Object.freeze({
  family: "ft" as const,
  allowedVersions: Object.freeze(["tbc20"]),
  createVersion: "tbc20",
})]);
const TBC20_AMOUNT_LIMITS = Object.freeze([
  // Six inputs, each with six signed-64 Tape slots; the builder may select fewer.
  Object.freeze({ scope: "ft-total" as const, protocolVersion: "tbc20", maximum: (36n * TBC20_MAX_SLOT).toString() }),
  Object.freeze({ scope: "ft-slot" as const, protocolVersion: "tbc20", maximum: TBC20_MAX_SLOT.toString() }),
]);

export interface DefaultTbcNetworkOptions {
  readonly network: TbcNetworkContext;
  readonly accounts: Readonly<{ current: () => Promise<readonly KitWalletAccount[]> }>;
  readonly fetch: TestnetFetch;
  readonly ledger?: KitRequestLedger;
  readonly requestTimeoutMs?: number;
  readonly now?: () => number;
  readonly snapshotId?: () => string | Promise<string>;
  /** Shared exact-byte parser/cache for client proof and Chain Data material. */
  readonly inspectTransaction?: typeof inspectTbcTransaction;
  /** Keyless Native bridge for canonical Pool descriptors and previews. */
  readonly poolNative?: PoolMaterialNativeProviderInput;
  /** Wallet-owned source shared with approval evidence when already composed. */
  readonly poolMaterial?: PoolMaterialSource;
  /** Wallet-owned construction floor; never accepted from a DApp request. */
  readonly confirmationPolicy?: Readonly<PoolMaterialConfirmationPolicy>;
  /** Retains only the exact short-lived snapshot material for approval review. */
  readonly rememberPoolSnapshotMaterial?: (value: PoolSnapshotMaterial) => void;
  /** Internal/session composition hook; returns a trusted active-account digest without network I/O. */
  readonly broadcastAccountScopeHash?: () => Promise<string>;
  readonly broadcast?:
    | Readonly<{
        journal: TbcKitBroadcastJournal;
        submit?: never;
        reconcile?: never;
      }>
    | Readonly<{
        journal?: never;
        submit: (
          params: unknown,
          client: TestnetClient,
          call: KitHostPortCall | undefined,
        ) => Promise<unknown>;
        submitBatch?: (
          params: unknown,
          client: TestnetClient,
          call: KitHostPortCall | undefined,
        ) => Promise<unknown>;
        reconcile: (
          params: unknown,
          client: TestnetClient,
          call: KitHostPortCall | undefined,
        ) => Promise<unknown>;
      }>;
}

export interface DefaultTbcTestnetNetworkOptions {
  readonly accounts: Readonly<{ current: () => Promise<readonly KitWalletAccount[]> }>;
  readonly baseUrl?: string;
  readonly allowedOrigins?: readonly string[];
  readonly fetch: TestnetFetch;
  readonly ledger?: KitRequestLedger;
  readonly requestTimeoutMs?: number;
  readonly now?: () => number;
  readonly snapshotId?: () => string | Promise<string>;
  /** Shared exact-byte parser/cache for client proof and Chain Data material. */
  readonly inspectTransaction?: typeof inspectTbcTransaction;
  /** Keyless Native bridge for canonical Pool descriptors and previews. */
  readonly poolNative?: PoolMaterialNativeProviderInput;
  /** Wallet-owned source shared with approval evidence when already composed. */
  readonly poolMaterial?: PoolMaterialSource;
  /** Wallet-owned construction floor; never accepted from a DApp request. */
  readonly confirmationPolicy?: Readonly<PoolMaterialConfirmationPolicy>;
  /** Retains only the exact short-lived snapshot material for approval review. */
  readonly rememberPoolSnapshotMaterial?: (value: PoolSnapshotMaterial) => void;
  /** Internal/session composition hook; returns a trusted active-account digest without network I/O. */
  readonly broadcastAccountScopeHash?: () => Promise<string>;
  readonly broadcast?:
    | Readonly<{
        /** Kit-owned durable state machine; ordinary wallets use this path. */
        journal: TbcKitBroadcastJournal;
        submit?: never;
        reconcile?: never;
      }>
    | Readonly<{
        /** Advanced wallet override. It must preserve Host identity and durable recovery. */
        journal?: never;
        submit: (
          params: unknown,
          client: TestnetClient,
          call: KitHostPortCall | undefined,
        ) => Promise<unknown>;
        submitBatch?: (
          params: unknown,
          client: TestnetClient,
          call: KitHostPortCall | undefined,
        ) => Promise<unknown>;
        reconcile: (
          params: unknown,
          client: TestnetClient,
          call: KitHostPortCall | undefined,
        ) => Promise<unknown>;
      }>;
}

export interface DefaultTbcTestnetNetwork {
  readonly network: TbcNetworkContext;
  readonly client: TestnetClient;
  readonly chainData: DefaultTbcChainDataResolver;
  /** Initializes wallet-owned Pool native capability without chain reads. */
  readonly warmup: () => Promise<void>;
  /** Wallet-private authoritative Pool asset inventory for bounded maintenance. */
  readonly readPoolMergeIndex: (input: Readonly<{
    address: string;
    poolContractId: string;
    kind: PoolMergeIndexKind;
  }>) => Promise<PoolMergeIndex>;
  readonly resolveChainData: (
    params: unknown,
    accountOrCall?: KitWalletAccount | KitHostPortCall,
    account?: KitWalletAccount,
  ) => Promise<unknown>;
  readonly resolvePolicy: (params: unknown) => Promise<unknown>;
  readonly broadcastSubmit: (params: unknown, call?: KitHostPortCall) => Promise<unknown>;
  readonly broadcastSubmitBatch: (params: unknown, call?: KitHostPortCall) => Promise<unknown>;
  readonly broadcastReconcile: (params: unknown, call?: KitHostPortCall) => Promise<unknown>;
  /** Durable submit-boundary records only; no Core/Signer operation is resumed. */
  readonly listBroadcastRecovery: (limit?: number) => Promise<readonly TbcKitBroadcastJournalRecord[]>;
  /** Explicit status-only reconciliation; never POSTs transaction bytes. */
  readonly recoverBroadcasts: (txids: readonly string[]) => Promise<unknown>;
}

export type DefaultTbcNetwork = DefaultTbcTestnetNetwork;

function isBoundKitAccount(value: unknown): value is KitWalletAccount {
  return value !== null && typeof value === "object" &&
    typeof Reflect.get(value, "accountId") === "string" &&
    typeof Reflect.get(value, "address") === "string" &&
    typeof Reflect.get(value, "chainId") === "string";
}

function failure(name: "INVALID_INPUT" | "UNAUTHORIZED") {
  return Object.freeze({
    portError: Object.freeze({
      name,
      retryable: false,
      message: "TBC transaction policy request is invalid for the configured network",
    }),
  });
}

function broadcastUnavailable() {
  return Object.freeze({
    portError: Object.freeze({
      name: "UNAUTHORIZED" as const,
      retryable: false,
      message: "TBC wallet broadcast is not configured",
    }),
  });
}

function canonicalTime(value: number): string {
  if (!Number.isFinite(value)) throw new TypeError("Invalid policy clock");
  return new Date(value).toISOString();
}

export function createDefaultTbcNetwork(
  options: DefaultTbcNetworkOptions,
): DefaultTbcNetwork {
  const network = assertTbcNetworkContext(options.network);
  const now = options.now ?? Date.now;
  const ledger = options.ledger ?? createRequestLedger();
  const inspectTransaction = options.inspectTransaction ?? createPoolTransactionInspector();
  const basePolicy = network.network === "mainnet"
    ? DEFAULT_TBC_MAINNET_POLICY
    : DEFAULT_TBC_TESTNET_POLICY;
  const confirmationPolicy = normalizePoolMaterialConfirmationPolicy(
    options.confirmationPolicy ?? {
      minConfirmations: basePolicy.minConfirmations,
    },
  );
  const injectedPoolFloor = options.poolMaterial?.confirmationPolicy;
  if (
    injectedPoolFloor !== undefined &&
    BigInt(
      normalizePoolMaterialConfirmationPolicy(injectedPoolFloor)
        .minConfirmations,
    ) < BigInt(confirmationPolicy.minConfirmations)
  ) {
    throw new TypeError(
      "Pool material confirmation floor is below the wallet policy",
    );
  }
  const client = createTestnetClient({
    baseUrl: network.endpoint.apiOrigin,
    allowedOrigins: [network.endpoint.apiOrigin],
    fetch: options.fetch,
    ledger,
    inspectTransaction,
    ...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
  });
  const materialNative = options.poolNative ?? createLazyBundledWasmTbcKeylessEngine();
  const poolMaterial = options.poolMaterial ?? createLazyProductionPoolMaterialSource({
    native: materialNative,
    fetch: options.fetch,
    baseUrl: network.endpoint.apiOrigin,
    allowedOrigins: [network.endpoint.apiOrigin],
    p2pkhVersion: network.profile.p2pkhVersion,
    confirmationPolicy,
    ...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
  });
  const chainData = createDefaultTbcChainDataResolver({
    accounts: options.accounts,
    client,
    network,
    now,
    inspectTransaction,
    poolMaterial,
    materialNative,
    confirmationPolicy,
    ...(options.rememberPoolSnapshotMaterial === undefined
      ? {}
      : { rememberPoolSnapshotMaterial: options.rememberPoolSnapshotMaterial }),
    ...(options.snapshotId === undefined ? {} : { snapshotId: options.snapshotId }),
  });
  const configuredBroadcast = options.broadcast;
  const defaultBroadcast: DefaultTbcBroadcast | undefined =
    configuredBroadcast !== undefined &&
    "journal" in configuredBroadcast &&
    configuredBroadcast.journal !== undefined
      ? createDefaultTbcBroadcast({
          client,
          journal: configuredBroadcast.journal,
          network,
          accountScopeHash: options.broadcastAccountScopeHash ?? (async () => hashCanonical(Object.freeze({
            version: "1.0",
            chainId: network.chainId,
            accountIds: Object.freeze(
              (await options.accounts.current())
                .filter((account) => account.chainId === network.chainId)
                .map((account) => account.accountId)
                .sort(),
            ),
          }))),
        })
      : undefined;
  const advancedBroadcast =
    configuredBroadcast !== undefined && "submit" in configuredBroadcast
      ? configuredBroadcast
      : undefined;
  const advancedSubmit = advancedBroadcast?.submit;
  const advancedSubmitBatch = advancedBroadcast !== undefined && "submitBatch" in advancedBroadcast
    ? advancedBroadcast.submitBatch
    : undefined;
  const advancedReconcile = advancedBroadcast?.reconcile;

  async function resolvePolicy(rawParams: unknown): Promise<unknown> {
    try {
      if (rawParams === null || typeof rawParams !== "object" || Array.isArray(rawParams)) return failure("INVALID_INPUT");
      const params = rawParams as Readonly<Record<string, unknown>>;
      const request = params.request;
      if (request === null || typeof request !== "object" || Array.isArray(request)) return failure("INVALID_INPUT");
      assertValidTws("transactionRequest", request);
      if (hashCanonical(request) !== params.requestHash || typeof params.snapshotHash !== "string" || !/^[0-9a-f]{64}$/u.test(params.snapshotHash)) {
        return failure("INVALID_INPUT");
      }
      const original = request as Readonly<{ chainId: string; from: string; intent: Readonly<Record<string, unknown>> }>;
      const unifiedPool = String(original.intent.type).startsWith("tbc20Lp.") || ["amm.mergeToken", "amm.swap", "amm.addLiquidity", "amm.removeLiquidity"].includes(String(original.intent.type));
      const unified = unifiedPool || ["tbc721.transfer", "tbc20.transfer", "tbc20.merge", "tbc20Stablecoin.transfer", "tbc20Stablecoin.merge"].includes(String(original.intent.type));
      const resolvedType = unified ? chainData.readUnifiedIntent({
        snapshotHash: params.snapshotHash, chainId: original.chainId, from: original.from,
        contractId: String(unifiedPool ? original.intent.poolContractId : original.intent.contractId), intentType: String(original.intent.type),
      }) : undefined;
      if (unified && resolvedType === undefined) return failure("INVALID_INPUT");
      // Policy selection uses this exact snapshot's already-verified read hint;
      // the canonical generic request/hash and approval are never rewritten.
      const transaction = resolvedType === undefined ? original : { ...original, intent: { ...original.intent, type: resolvedType,
        ...(["amm.swap", "amm.addLiquidity", "amm.removeLiquidity"].includes(String(original.intent.type)) && resolvedType.startsWith("tbc.pool.") && original.intent.receiver === undefined ? { receiver: original.from } : {}) } };
      if (transaction.chainId !== network.chainId || !new Set([
        "tbc.transfer", "tbc.maintenance.merge", "tbc.ft.create", "tbc.ft.transfer", "tbc.ft.merge",
        ...TBC20_STANDARD_INTENTS,
        ...TBC721_STANDARD_INTENTS,
        ...COIN_INTENTS,
        ...AMM_LP_INTENTS,
        "tbc-timelock-lock", "tbc-timelock-unlock",
        "tbc-htlc-lock", "tbc-htlc-claim", "tbc-htlc-refund",
        ...LOP_INTENTS,
        "tbc.stablecoin.transfer", "tbc.stablecoin.merge", "tbc.pool.create",
        "tbc.collection.create", "tbc.nft.mint", "tbc.nft.transfer",
        "tbc.pool.liquidity.add", "tbc.pool.liquidity.remove",
        "tbc.pool.ft.merge", "tbc.pool.ftlp.merge", "tbc.pool.ftlp.burn",
        "tbc.pool.swap.exactTbcForToken", "tbc.pool.swap.exactTokenForTbc",
      ]).has(String(transaction.intent.type))) {
        return failure("UNAUTHORIZED");
      }
      assertTbcAddress(transaction.from, network.profile.p2pkhVersion);
      const htlcToken = String(transaction.intent.type).startsWith("tbc-htlc-") ? transaction.intent.assetStandard : undefined;
      const isTbc20 = TBC20_STANDARD_INTENTS.has(String(transaction.intent.type)) || htlcToken === "tbc20-standard";
      const isTbc721 = TBC721_STANDARD_INTENTS.has(String(transaction.intent.type));
      const isCoin = COIN_INTENTS.has(String(transaction.intent.type)) || htlcToken === "tbc20-stablecoin";
      const isAmmLp = AMM_LP_INTENTS.has(String(transaction.intent.type));
      const isLop = LOP_INTENTS.has(String(transaction.intent.type));
      if (transaction.intent.type === "tbc-lop-create") {
        const order = transaction.intent.order as Readonly<{ feeRecipient: string }>;
        assertTbcAddress(order.feeRecipient, network.profile.p2pkhVersion);
      }
      if (isAmmLp) {
        for (const field of ["to", "receiver"])
          if (typeof transaction.intent[field] === "string") assertTbcAddress(transaction.intent[field], network.profile.p2pkhVersion);
      }
      if ((transaction.intent.type === "tbc.transfer" || transaction.intent.type === "tbc.ft.transfer" || transaction.intent.type === "tbc.stablecoin.transfer" || transaction.intent.type === "tbc.nft.transfer" || isTbc20 || isTbc721 || isCoin) && typeof transaction.intent.to === "string") {
        assertTbcAddress(transaction.intent.to, network.profile.p2pkhVersion);
      }
      if ((unified || transaction.intent.type === "tbc20-standard-transfer" || isCoin) && Array.isArray(transaction.intent.receivers)) {
        for (const receiver of transaction.intent.receivers as readonly Readonly<{ to: string }>[]) {
          assertTbcAddress(receiver.to, network.profile.p2pkhVersion);
        }
      }
      if (isTbc721 && Array.isArray(transaction.intent.items)) {
        for (const item of transaction.intent.items as readonly Readonly<{ to?: string }>[]) {
          if (item.to !== undefined) assertTbcAddress(item.to, network.profile.p2pkhVersion);
        }
      }
      if ((unified || isTbc721 || isCoin) && transaction.intent.payment !== undefined) {
        assertTbcAddress((transaction.intent.payment as Readonly<{ to: string }>).to, network.profile.p2pkhVersion);
      }
      if (new Set([
        "tbc.pool.liquidity.add", "tbc.pool.liquidity.remove",
        "tbc.pool.swap.exactTbcForToken", "tbc.pool.swap.exactTokenForTbc",
      ]).has(String(transaction.intent.type))) {
        assertTbcAddress(String(transaction.intent.receiver), network.profile.p2pkhVersion);
      }
      if (transaction.intent.type === "tbc.pool.create" && transaction.intent.stage === "initialize") {
        const liquidity = transaction.intent.initialLiquidity as Readonly<Record<string, unknown>>;
        assertTbcAddress(String(liquidity.receiver), network.profile.p2pkhVersion);
      }
      const policy = basePolicy;
      let pool: Readonly<{ lpPlan: number; serviceProviderTag: string; serviceFeeRate: number }> | undefined;
      if (transaction.intent.type === "tbc.pool.create" && transaction.intent.stage === "mint") {
        const lpPlan = Number(transaction.intent.lpPlan);
        const serviceFeeRate = poolServiceFeeRate(lpPlan);
        if (serviceFeeRate === undefined || typeof transaction.intent.serviceProviderTag !== "string") return failure("INVALID_INPUT");
        pool = Object.freeze({ lpPlan, serviceProviderTag: transaction.intent.serviceProviderTag, serviceFeeRate });
      } else if (String(transaction.intent.type).startsWith("tbc.pool.")) {
        const poolContractId = transaction.intent.poolContractId;
        if (typeof poolContractId !== "string") return failure("INVALID_INPUT");
        pool = chainData.readPoolPolicy({
          snapshotHash: params.snapshotHash,
          chainId: transaction.chainId,
          sourceIdentity: network.sourceIdentity,
          from: transaction.from,
          poolContractId,
        });
        if (pool === undefined) return failure("INVALID_INPUT");
      }
      const payload = Object.freeze({
        version: "1.0" as const,
        policyId: policy.policyId,
        revision: policy.revision,
        chainId: transaction.chainId,
        feeRateSatPerKb: policy.feeRateSatPerKb,
        dustThreshold: isAmmLp ? "10" : isLop || isTbc20 || isTbc721 || transaction.intent.type === "tbc-timelock-lock" || transaction.intent.type === "tbc-timelock-unlock" || String(transaction.intent.type).startsWith("tbc-htlc-") ? "42" : policy.dustThreshold,
        minConfirmations: confirmationPolicy.minConfirmations,
        maxBundleTransactions: policy.maxBundleTransactions,
        sighashType: 65 as const,
        contractPolicies: isLop ? Object.freeze([...TBC20_CONTRACT_POLICIES, ...COIN_CONTRACT_POLICIES]) : isAmmLp ? AMM_CONTRACT_POLICIES : isCoin ? COIN_CONTRACT_POLICIES : isTbc20 ? TBC20_CONTRACT_POLICIES : isTbc721 ? TBC721_CONTRACT_POLICIES : Object.freeze([]),
        amountLimits: Object.freeze([
          Object.freeze({ scope: "native" as const, maximum: policy.maximumNativeAmount }),
          ...(isTbc20 || isLop ? TBC20_AMOUNT_LIMITS : []),
          ...(isAmmLp ? AMM_AMOUNT_LIMITS : []),
        ]),
        ...(pool === undefined ? {} : { pool }),
        expiresAt: canonicalTime(now() + policy.ttlMs),
      });
      const result = Object.freeze({ payload, policyHash: hashCanonical(payload) });
      assertValidTws("policyResolveResult", result);
      return result;
    } catch {
      return failure("INVALID_INPUT");
    }
  }

  return Object.freeze({
    network,
    client,
    chainData,
    warmup: async () => {
      await poolMaterial.warmup?.();
    },
    readPoolMergeIndex: async (input: Readonly<{
      address: string;
      poolContractId: string;
      kind: PoolMergeIndexKind;
    }>) => {
      if (poolMaterial.readMergeIndex === undefined) {
        throw new Error("Canonical Pool merge index is unavailable");
      }
      return poolMaterial.readMergeIndex(input);
    },
    resolveChainData: (
      params: unknown,
      accountOrCall?: KitWalletAccount | KitHostPortCall,
      account?: KitWalletAccount,
    ) => chainData.resolve(
      params,
      account ?? (isBoundKitAccount(accountOrCall) ? accountOrCall : undefined),
    ),
    rememberFinalizedTransaction: chainData.rememberFinalizedTransaction,
    resolvePolicy,
    broadcastSubmit: (params: unknown, call?: KitHostPortCall) =>
      defaultBroadcast !== undefined
        ? defaultBroadcast.submit(params, call)
        : typeof advancedSubmit === "function"
          ? advancedSubmit(params, client, call)
          : Promise.resolve(broadcastUnavailable()),
    broadcastSubmitBatch: (params: unknown, call?: KitHostPortCall) =>
      defaultBroadcast !== undefined
        ? defaultBroadcast.submitBatch(params, call)
        : typeof advancedSubmitBatch === "function"
          ? advancedSubmitBatch(params, client, call)
          : Promise.resolve(broadcastUnavailable()),
    broadcastReconcile: (params: unknown, call?: KitHostPortCall) =>
      defaultBroadcast !== undefined
        ? defaultBroadcast.reconcile(params, call)
        : typeof advancedReconcile === "function"
          ? advancedReconcile(params, client, call)
          : Promise.resolve(broadcastUnavailable()),
    listBroadcastRecovery: (limit?: number) =>
      defaultBroadcast !== undefined
        ? defaultBroadcast.listRecovery(limit)
        : Promise.resolve(Object.freeze([])),
    recoverBroadcasts: (txids: readonly string[]) =>
      defaultBroadcast !== undefined
        ? defaultBroadcast.recover(txids)
        : Promise.resolve(broadcastUnavailable()),
  });
}

export function createDefaultTbcTestnetNetwork(
  options: DefaultTbcTestnetNetworkOptions,
): DefaultTbcTestnetNetwork {
  const baseUrl = options.baseUrl ?? OFFICIAL_TBC_TESTNET_API_ORIGIN;
  const official = baseUrl === OFFICIAL_TBC_TESTNET_API_ORIGIN;
  const network = createTbcNetworkContext({
    network: "testnet",
    endpoint: official
      ? { kind: "official" }
      : {
          kind: "trusted-custom",
          apiOrigin: baseUrl,
          trustId: `legacy-explicit:${hashCanonical({
            baseUrl,
            allowedOrigins: options.allowedOrigins ?? [baseUrl],
          }).slice(0, 32)}`,
        },
  });
  if (baseUrl === OFFICIAL_TBC_MAINNET_API_ORIGIN) {
    throw new TypeError("Official TBC endpoint does not match the selected network");
  }
  return createDefaultTbcNetwork({
    network,
    accounts: options.accounts,
    fetch: options.fetch,
    ...(options.ledger === undefined ? {} : { ledger: options.ledger }),
    ...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.snapshotId === undefined ? {} : { snapshotId: options.snapshotId }),
    ...(options.inspectTransaction === undefined ? {} : { inspectTransaction: options.inspectTransaction }),
    ...(options.poolNative === undefined ? {} : { poolNative: options.poolNative }),
    ...(options.poolMaterial === undefined ? {} : { poolMaterial: options.poolMaterial }),
    ...(options.confirmationPolicy === undefined
      ? {}
      : { confirmationPolicy: options.confirmationPolicy }),
    ...(options.rememberPoolSnapshotMaterial === undefined
      ? {}
      : { rememberPoolSnapshotMaterial: options.rememberPoolSnapshotMaterial }),
    ...(options.broadcastAccountScopeHash === undefined
      ? {}
      : { broadcastAccountScopeHash: options.broadcastAccountScopeHash }),
    ...(options.broadcast === undefined ? {} : { broadcast: options.broadcast }),
  });
}
