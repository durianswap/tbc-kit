import { assertValidTws, hashCanonical } from "@tbc-wallet/core";

import type {
  TbcJsonRpcRequest,
  TbcProviderEvent,
  TbcTransportCloseReason,
  TbcTransportDelivery,
} from "./provider-transport.js";
import type {
  TbcKitWebViewNativeHandlers,
  TbcKitWebViewVerifiedNavigation,
} from "./wallet-webview.js";
import {
  LEGACY_CONTRACT_BUNDLE_SHA256,
  LEGACY_CONTRACT_VERSION,
} from "./legacy-webview-contract.js";
import {
  type LegacyBaselineAMethod,
  mapLegacyRequest,
  mapLegacyResult,
} from "./legacy-webview-baseline.js";
import {
  type LegacyStandardWorkflowBatchAdapter,
  type LegacyStandardWorkflowBatchOptions,
} from "./legacy-standard-workflow.js";
import { normalizeLegacyGenericBatchRequests } from "./legacy-generic-batch.js";
import { createLegacyNftIntentResolver } from "./legacy-nft-intent.js";
import {
  type LegacyTbcBalanceReader,
} from "./legacy-generic-capabilities.js";
import {
  LegacyFtCreateParameterError,
  type LegacyFtCreateIntentResolver,
} from "./legacy-ft-create-intent.js";
import type { LegacyFtTransferIntentResolver } from "./legacy-ft-transfer-intent.js";
import {
  isLegacyStablecoinTransferRequest,
  LegacyStablecoinParameterError,
  type LegacyStablecoinTransferIntentResolver,
} from "./legacy-stablecoin-intent.js";
import {
  LegacyPoolParameterError,
  type LegacyPoolIntentResolver,
} from "./legacy-pool-intent.js";
import {
  assertTbcNetworkContext,
  tbcNetworkNameForChainId,
  tbcNetworkProfileForChainId,
  type TbcNetworkContext,
  type TbcNetworkName,
} from "./network-context.js";
import { assertTbcAddress } from "./testnet-validation.js";
import {
  decodeLegacyPageMessage,
  encodeLegacyNativeMessage,
  LEGACY_WEBVIEW_CHANNEL,
  type LegacyMethod,
} from "./legacy-webview-protocol.js";
import type {
  TbcMultiRoundMergeAsset,
  TbcMultiRoundMergeLimits,
  TbcMultiRoundMergeResult,
} from "./multi-round-merge.js";
import type { KitSupportedIntent, KitTransactionRequest } from "./public-types.js";

const BASELINE_METHODS = new Set<LegacyMethod>([
  "connect",
  "disconnect",
  "isConnected",
  "getPubKey",
  "getAddress",
  "getNetwork",
  "getInfo",
]);

export interface TbcKitLegacyBitcoinMessageInput {
  readonly message: string;
  readonly encoding: "utf8" | "hex" | "base64";
}

export interface TbcKitPreparedLegacyBitcoinMessage
  extends TbcKitLegacyBitcoinMessageInput {
  readonly digest: string;
}

export interface TbcKitLegacyBitcoinMessagePreparer {
  /** Wallet-trusted digest preparation backed by the installed native module. */
  readonly prepare: (
    input: TbcKitLegacyBitcoinMessageInput,
  ) => Promise<TbcKitPreparedLegacyBitcoinMessage>;
}

export interface TbcKitLegacyTransactionContext {
  readonly address: string;
  readonly permissions: readonly unknown[];
  /** Required when the controller is bound to a unified network context. */
  readonly networkSourceIdentity?: string;
}

export type TbcKitLegacyTransactionContextReader = (
  navigation: TbcKitWebViewVerifiedNavigation,
) => Promise<TbcKitLegacyTransactionContext | null>;

export interface TbcKitLegacyTransactionOptions {
  /** Canonical FT-create mapping; Host/Engine still construct and submit. */
  readonly ftCreateIntents?: LegacyFtCreateIntentResolver;
  /** Canonical FT-transfer mapping used by the Standard preparation path. */
  readonly ftTransferIntents?: LegacyFtTransferIntentResolver;
  /** Canonical Stablecoin transfer mapping; no network or persistence authority. */
  readonly stablecoinTransferIntents?: LegacyStablecoinTransferIntentResolver;
  /** Canonical Pool create/swap/liquidity mapping; no signing authority. */
  readonly poolIntents?: LegacyPoolIntentResolver;
  /** Optional wallet-private fast path for the current account and grants. */
  readonly readTransactionContext?: TbcKitLegacyTransactionContextReader;
  readonly onBatchProgress?: (
    progress: Readonly<{
      completed: 0 | 1 | 2;
      total: 2;
      stage: "signing" | "finalizing";
    }>,
  ) => void;
}

export type TbcKitLegacyMergeMethod =
  | "mergeUtxos"
  | "mergeFtUtxos"
  | "mergeStableCoinUtxos";

export type TbcKitLegacyMergeAsset = Extract<
  TbcMultiRoundMergeAsset,
  Readonly<{ kind: "tbc" | "ft" | "stablecoin" }>
>;

export interface TbcKitLegacyMultiRoundMergeOptions {
  /**
   * Wallet-owned bounded policy for a historical all-to-one alias. Kit fixes
   * the target to one UTXO and delegates execution to tbc_runMultiRoundMerge.
   */
  readonly createLimits: (input: Readonly<{
    method: TbcKitLegacyMergeMethod;
    asset: TbcKitLegacyMergeAsset;
    navigation: TbcKitWebViewVerifiedNavigation;
  }>) =>
    | Omit<TbcMultiRoundMergeLimits, "targetUtxoCount">
    | Promise<Omit<TbcMultiRoundMergeLimits, "targetUtxoCount">>;
}

export interface TbcKitLegacyWebViewNativeOptions {
  /** Native-verified, top-frame navigation. Never derive this from page JSON. */
  readonly navigation: TbcKitWebViewVerifiedNavigation;
  readonly chainId: string;
  /** Immutable endpoint/source binding. Network switches create a new controller. */
  readonly network?: TbcNetworkContext;
  readonly platform: "ios" | "android";
  readonly walletVersion: string;
  /** Partner policy: reject historical asset creation before Host dispatch. */
  readonly allowHistoricalAssetCreation?: boolean;
  /** Wallet-owned Host/session dispatch and delivery acknowledgment. */
  readonly handlers: TbcKitWebViewNativeHandlers;
  readonly bitcoinMessages?: TbcKitLegacyBitcoinMessagePreparer;
  /** Maps historical 1-5 batches and standalone secure methods into fully reviewed Standard workflows. */
  readonly genericBatch?: LegacyStandardWorkflowBatchAdapter;
  /** TBC-only read bound to the same immutable network context. */
  readonly balances?: Pick<
    LegacyTbcBalanceReader,
    "chainId" | "networkSourceIdentity" | "read"
  >;
  /** Shared transaction orchestration for FT create and Pool business flows. */
  readonly transactions?: TbcKitLegacyTransactionOptions;
  /** Historical merge aliases mapped into the shared bounded public coordinator. */
  readonly multiRoundMerge?: TbcKitLegacyMultiRoundMergeOptions;
  /** Wallet-owned platform string channel post operation. */
  readonly post: (serialized: string) => void | Promise<void>;
}

export interface TbcKitLegacyWebViewNativeController {
  readonly initialize: () => void;
  /** Routes Kit-owned Baseline, message and configured business requests. */
  readonly supportsRequest: (method: LegacyMethod, params: unknown) => boolean;
  readonly acceptPageMessage: (serialized: string) => Promise<void>;
  readonly close: (reason?: TbcTransportCloseReason) => Promise<void>;
}

type LegacyOutcome = Readonly<{
  result: unknown;
  deliveryId?: string;
  events?: readonly TbcProviderEvent[];
}>;

function legacyBusinessError(method: LegacyMethod, message: string): string {
  if (method === "connect") return "User rejected the request";
  if (method === "sendTransaction") return "User cancelled the transaction";
  if (method === "signMessage") return "User cancelled the sign message";
  if (method === "signTransaction") return "User cancelled the sign transaction";
  if (method === "signAssociatedTransaction") {
    return "User cancelled the sign associated transaction";
  }
  if (method === "encrypt" || method === "decrypt") {
    return "User cancelled the crypto operation";
  }
  if (method === "sendBatchRequest") return "User cancelled the batch request";
  return message.length === 0 ? "Unsupported legacy operation" : message;
}

function providerResult(
  method: LegacyMethod,
  delivery: TbcTransportDelivery,
): unknown {
  if ("error" in delivery.response) {
    const error = delivery.response.error;
    return Object.freeze({
      error:
        error.code === 4001
          ? legacyBusinessError(method, error.message)
          : error.message || "Wallet request failed",
    });
  }
  return delivery.response.result;
}

function legacyEvent(event: TbcProviderEvent, network: TbcNetworkName):
  | Readonly<{
      event: "TuringAccountChanged" | "TuringNetworkChanged";
      detail: unknown;
    }>
  | undefined {
  if (event.name === "accountsChanged") {
    const address = event.payload[0];
    return Object.freeze({
      event: "TuringAccountChanged",
      detail: Object.freeze({
        addresses:
          address === undefined
            ? Object.freeze({})
            : Object.freeze({ tbcAddress: address }),
      }),
    });
  }
  if (event.name === "chainChanged") {
    return Object.freeze({
      event: "TuringNetworkChanged",
      detail: Object.freeze({ network: "tbc", type: network }),
    });
  }
  if (event.name === "disconnect") {
    return Object.freeze({
      event: "TuringAccountChanged",
      detail: Object.freeze({ addresses: Object.freeze({}) }),
    });
  }
  return undefined;
}

function legacySignMessageResult(delivery: TbcTransportDelivery): unknown {
  const result = providerResult("signMessage", delivery);
  if (
    result === null ||
    typeof result !== "object" ||
    Object.hasOwn(result, "error")
  ) {
    return result;
  }
  const address = Reflect.get(result, "address");
  const publicKey = Reflect.get(result, "publicKey");
  const signature = Reflect.get(result, "signature");
  const envelope = Reflect.get(result, "envelope");
  const message =
    envelope !== null && typeof envelope === "object"
      ? Reflect.get(envelope, "message")
      : undefined;
  const data =
    message !== null && typeof message === "object"
      ? Reflect.get(message, "data")
      : undefined;
  if (
    typeof address !== "string" ||
    typeof publicKey !== "string" ||
    typeof signature !== "string" ||
    typeof data !== "string"
  ) {
    throw new Error("Invalid canonical Legacy signMessage result");
  }
  return Object.freeze({
    address,
    maddress: address,
    pubkey: publicKey,
    pubKey: publicKey,
    message: data,
    sig: signature,
  });
}

function businessError(result: unknown): boolean {
  return (
    result !== null &&
    typeof result === "object" &&
    !Array.isArray(result) &&
    Object.hasOwn(result, "error")
  );
}

function isLegacyFtTransferParams(params: unknown): boolean {
  const candidate =
    Array.isArray(params) &&
    Object.getPrototypeOf(params) === Array.prototype &&
    params.length === 1
      ? params[0]
      : params;
  return (
    candidate !== null &&
    typeof candidate === "object" &&
    !Array.isArray(candidate) &&
    Object.getPrototypeOf(candidate) === Object.prototype &&
    Reflect.get(candidate, "flag") === "FT_TRANSFER" &&
    (Reflect.get(candidate, "broadcastEnabled") === undefined ||
      typeof Reflect.get(candidate, "broadcastEnabled") === "boolean")
  );
}

function isLegacyFtCreateParams(params: unknown): boolean {
  return (
    Array.isArray(params) &&
    Object.getPrototypeOf(params) === Array.prototype &&
    params.length === 1 &&
    params[0] !== null &&
    typeof params[0] === "object" &&
    !Array.isArray(params[0]) &&
    Reflect.get(params[0], "flag") === "FT_MINT"
  );
}

function legacyFlagParams(
  params: unknown,
  flags: ReadonlySet<string>,
): Readonly<Record<string, unknown>> | undefined {
  const candidate = Array.isArray(params)
    ? Object.getPrototypeOf(params) === Array.prototype && params.length === 1
      ? params[0]
      : undefined
    : params;
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    Array.isArray(candidate) ||
    Object.getPrototypeOf(candidate) !== Object.prototype ||
    !flags.has(String(Reflect.get(candidate, "flag")))
  ) {
    return undefined;
  }
  return candidate as Readonly<Record<string, unknown>>;
}

const LEGACY_NFT_FLAGS = new Set([
  "COLLECTION_CREATE",
  "NFT_CREATE",
  "NFT_TRANSFER",
]);
const LEGACY_NFT_CREATION_FLAGS = new Set(["COLLECTION_CREATE", "NFT_CREATE"]);
const LEGACY_POOL_CREATION_FLAGS = new Set(["POOLNFT_MINT", "POOLNFT_INIT"]);

const LEGACY_STABLECOIN_MERGE_FLAGS = new Set(["STABLECOIN_MERGE"]);
const LEGACY_STABLECOIN_TRANSFER_FLAGS = new Set(["STABLECOIN_TRANSFER"]);

function legacyFtMergeParams(
  params: unknown,
): Readonly<Record<string, unknown>> | undefined {
  if (
    !Array.isArray(params) ||
    Object.getPrototypeOf(params) !== Array.prototype ||
    params.length !== 1
  ) return undefined;
  const candidate = params[0];
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    Array.isArray(candidate) ||
    Object.getPrototypeOf(candidate) !== Object.prototype ||
    Reflect.get(candidate, "flag") !== "FT_MERGE"
  ) return undefined;
  return candidate as Readonly<Record<string, unknown>>;
}

function legacyStablecoinMergeParams(
  params: unknown,
): Readonly<Record<string, unknown>> | undefined {
  const candidate = legacyFlagParams(params, LEGACY_STABLECOIN_MERGE_FLAGS);
  if (candidate === undefined) return undefined;
  const keys = Reflect.ownKeys(candidate);
  const contractValue = Reflect.get(candidate, "ft_contract_address");
  if (
    typeof contractValue !== "string" ||
    !/^[0-9a-f]{64}$/u.test(contractValue.toLowerCase()) ||
    !keys.every((key) =>
      typeof key === "string" &&
      ["flag", "ft_contract_address", "domain"].includes(key)
    ) ||
    (Reflect.get(candidate, "domain") !== undefined &&
      typeof Reflect.get(candidate, "domain") !== "string")
  ) {
    return undefined;
  }
  return candidate;
}

function legacyFtMergeRequest(
  params: Readonly<Record<string, unknown>>,
  chainId: string,
  from: string,
): Readonly<Record<string, unknown>> {
  const keys = Reflect.ownKeys(params);
  const contractValue = Reflect.get(params, "ft_contract_address");
  if (
    typeof contractValue !== "string" ||
    !/^[0-9a-f]{64}$/u.test(contractValue.toLowerCase()) ||
    !keys.every((key) =>
      typeof key === "string" &&
      ["flag", "ft_contract_address", "domain"].includes(key)
    )
  ) {
    throw new Error("Invalid Legacy FT merge");
  }
  const profile = tbcNetworkProfileForChainId(chainId);
  const source = assertTbcAddress(from, profile.p2pkhVersion).address;
  const base = Object.freeze({
    version: "1.0" as const,
    chainId,
    from: source,
    intent: Object.freeze({
      version: "1.0" as const,
      type: "tbc.ft.merge" as const,
      contractId: contractValue.toLowerCase(),
    }),
  });
  return Object.freeze({
    ...base,
    clientRequestId: `legacy-ft-merge:${hashCanonical(base)}`,
  });
}

function legacyStablecoinMergeRequest(
  params: Readonly<Record<string, unknown>>,
  chainId: string,
  from: string,
): Readonly<Record<string, unknown>> {
  const contractValue = Reflect.get(params, "ft_contract_address");
  if (
    legacyStablecoinMergeParams(params) === undefined ||
    typeof contractValue !== "string"
  ) {
    throw new Error("Invalid Legacy Stablecoin merge");
  }
  const profile = tbcNetworkProfileForChainId(chainId);
  const source = assertTbcAddress(from, profile.p2pkhVersion).address;
  const base = Object.freeze({
    version: "1.0" as const,
    chainId,
    from: source,
    intent: Object.freeze({
      version: "1.0" as const,
      type: "tbc.stablecoin.merge" as const,
      contractId: contractValue.toLowerCase(),
    }),
  });
  return Object.freeze({
    ...base,
    clientRequestId: `legacy-stablecoin-merge:${hashCanonical(base)}`,
  });
}

const LEGACY_WRAPPED_POOL_FLAGS = new Set([
  "POOLNFT_MINT",
  "POOLNFT_INIT",
  "POOLNFT_LP_INCREASE",
  "POOLNFT_LP_CONSUME",
]);

const LEGACY_BARE_POOL_FLAGS = new Set([
  "POOLNFT_SWAP_TO_TOKEN",
  "POOLNFT_SWAP_TO_TBC",
  "POOLNFT_LP_INCREASE",
  "POOLNFT_LP_CONSUME",
]);

const LEGACY_POOL_MERGE_FLAGS = new Set(["POOLNFT_MERGE", "FTLP_MERGE", "POOLNFT_LP_BURN"]);

function legacyPoolParams(
  params: unknown,
): Readonly<Record<string, unknown>> | undefined {
  const wrapped = Array.isArray(params);
  const candidate = wrapped
    ? Object.getPrototypeOf(params) === Array.prototype && params.length === 1
      ? params[0]
      : undefined
    : params;
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    Array.isArray(candidate) ||
    Object.getPrototypeOf(candidate) !== Object.prototype ||
    !(
      wrapped &&
      LEGACY_POOL_MERGE_FLAGS.has(String(Reflect.get(candidate, "flag")))
    ) &&
    (Reflect.get(candidate, "broadcastEnabled") !== false ||
      !(wrapped ? LEGACY_WRAPPED_POOL_FLAGS : LEGACY_BARE_POOL_FLAGS).has(
        String(Reflect.get(candidate, "flag")),
      ))
  ) {
    return undefined;
  }
  return candidate as Readonly<Record<string, unknown>>;
}

function isHistoricalAssetCreation(params: unknown): boolean {
  if (isLegacyFtCreateParams(params) ||
      legacyFlagParams(params, LEGACY_NFT_CREATION_FLAGS) !== undefined) return true;
  const pool = legacyPoolParams(params);
  return pool !== undefined &&
    LEGACY_POOL_CREATION_FLAGS.has(String(Reflect.get(pool, "flag")));
}

function withStandardApprovalFeeCap(
  request: Readonly<Record<string, unknown>>,
  historicalCap: string,
): Readonly<Record<string, unknown>> {
  const existingConstraints = Reflect.get(request, "constraints");
  const constraints = existingConstraints !== null && typeof existingConstraints === "object"
    ? existingConstraints as Readonly<Record<string, unknown>>
    : Object.freeze({});
  const existingMaxFee = Reflect.get(constraints, "maxFee");
  const maxFee = typeof existingMaxFee === "string" && /^(0|[1-9][0-9]*)$/u.test(existingMaxFee) &&
      BigInt(existingMaxFee) <= BigInt(historicalCap)
    ? existingMaxFee
    : historicalCap;
  return Object.freeze({
    ...request,
    constraints: Object.freeze({ ...constraints, maxFee }),
  });
}

function legacyP2pkhParams(
  params: unknown,
): Readonly<Record<string, unknown>> | undefined {
  const candidate = Array.isArray(params)
    ? Object.getPrototypeOf(params) === Array.prototype && params.length === 1
      ? params[0]
      : undefined
    : params;
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    Array.isArray(candidate) ||
    Object.getPrototypeOf(candidate) !== Object.prototype ||
    Reflect.get(candidate, "flag") !== "P2PKH" ||
    (Reflect.get(candidate, "broadcastEnabled") !== undefined &&
      typeof Reflect.get(candidate, "broadcastEnabled") !== "boolean") ||
    typeof Reflect.get(candidate, "address") !== "string"
  ) {
    return undefined;
  }
  const amount = Reflect.get(candidate, "satoshis");
  if (
    !(
      (typeof amount === "number" && Number.isSafeInteger(amount) && amount > 0) ||
      (typeof amount === "string" && /^[1-9][0-9]*$/u.test(amount))
    )
  ) {
    return undefined;
  }
  return candidate as Readonly<Record<string, unknown>>;
}

function isLegacyP2pkhParams(params: unknown): boolean {
  return legacyP2pkhParams(params) !== undefined;
}

function isLegacyGenericBatchParams(params: unknown): boolean {
  try {
    normalizeLegacyGenericBatchRequests(params);
    return true;
  } catch {
    return false;
  }
}

function legacyP2pkhRequest(
  params: unknown,
  chainId: string,
  from: string,
): Readonly<Record<string, unknown>> {
  if (!isLegacyP2pkhParams(params)) {
    throw new Error("Invalid Legacy P2PKH request");
  }
  const legacy = legacyP2pkhParams(params)!;
  const recipientValue = Reflect.get(legacy, "address");
  const amountValue = Reflect.get(legacy, "satoshis");
  const amount =
    typeof amountValue === "number" && Number.isSafeInteger(amountValue)
      ? String(amountValue)
      : amountValue;
  if (
    typeof recipientValue !== "string" ||
    typeof amount !== "string" ||
    !/^[1-9][0-9]*$/u.test(amount)
  ) {
    throw new Error("Invalid Legacy P2PKH request");
  }
  const profile = tbcNetworkProfileForChainId(chainId);
  const source = assertTbcAddress(from, profile.p2pkhVersion).address;
  const recipient = assertTbcAddress(recipientValue, profile.p2pkhVersion).address;
  const intent = Object.freeze({
    version: "1.0" as const,
    type: "tbc.transfer" as const,
    to: recipient,
    amount,
  });
  const base = Object.freeze({
    version: "1.0" as const,
    chainId,
    from: source,
    intent,
  });
  return Object.freeze({
    ...base,
    clientRequestId: `legacy-p2pkh:${hashCanonical(base)}`,
  });
}

/** One Kit-owned mapper for historical sign-only batch transaction steps. */
export function createTbcKitLegacyBatchSendResolver(options: Readonly<{
  chainId: string;
  transactions: TbcKitLegacyTransactionOptions;
}>): LegacyStandardWorkflowBatchOptions["resolveSendTransaction"] {
  if (options === null || typeof options !== "object" ||
      typeof options.chainId !== "string" ||
      options.transactions === null || typeof options.transactions !== "object") {
    throw new TypeError("Legacy batch transaction resources are required");
  }
  tbcNetworkProfileForChainId(options.chainId);
  const nftIntents = createLegacyNftIntentResolver({chainId: options.chainId});
  const nftTransferFlags = new Set(["NFT_TRANSFER"]);
  return async ({params,chainId,from}) => {
    // The resolver is public to host integrations as well as the batch adapter.
    // Keep its own boundary sign-only without re-canonicalizing the batch.
    const transaction = Array.isArray(params) &&
      Object.getPrototypeOf(params) === Array.prototype && params.length === 1
      ? params[0] : params;
    if (transaction === null || typeof transaction !== "object" ||
        Array.isArray(transaction) || Object.getPrototypeOf(transaction) !== Object.prototype ||
        Reflect.get(transaction, "broadcastEnabled") !== false) {
      throw new TypeError("Legacy batch sendTransaction must be sign-only");
    }
    if (chainId !== options.chainId || isHistoricalAssetCreation(params)) {
      throw new TypeError("Legacy batch network or operation is unsupported");
    }
    let resolved: Readonly<Record<string, unknown>>;
    if (isLegacyP2pkhParams(params)) {
      resolved = legacyP2pkhRequest(params,chainId,from);
    } else if (legacyFlagParams(params,nftTransferFlags) !== undefined) {
      resolved = await nftIntents.resolve(params,from);
    } else if (isLegacyFtTransferParams(params) &&
        options.transactions.ftTransferIntents !== undefined) {
      resolved = await options.transactions.ftTransferIntents.resolve(params,from);
    } else if (isLegacyStablecoinTransferRequest(params) &&
        options.transactions.stablecoinTransferIntents !== undefined) {
      resolved = await options.transactions.stablecoinTransferIntents.resolve(params,from);
    } else {
      const poolParams = legacyPoolParams(params);
      if (poolParams === undefined || options.transactions.poolIntents === undefined) {
        throw new TypeError("Unsupported Legacy batch transaction");
      }
      resolved = await options.transactions.poolIntents.resolve(poolParams,from);
    }
    assertValidTws("transactionRequest",resolved);
    if (resolved.chainId !== chainId || resolved.from !== from) {
      throw new TypeError("Legacy batch transaction changed its bound account or chain");
    }
    return resolved as unknown as KitTransactionRequest<KitSupportedIntent>;
  };
}

function legacyStandaloneMergeAsset(
  method: TbcKitLegacyMergeMethod,
  params: unknown,
): TbcKitLegacyMergeAsset {
  if (method === "mergeUtxos") {
    if (
      params !== undefined &&
      !(params !== null && typeof params === "object" && !Array.isArray(params) && Reflect.ownKeys(params).length === 0)
    ) {
      throw new Error("Invalid Legacy TBC merge");
    }
    return Object.freeze({ kind: "tbc" as const });
  }
  const value = typeof params === "string"
    ? params
    : params !== null && typeof params === "object" && !Array.isArray(params)
      ? Reflect.get(params, "contract_id") ?? Reflect.get(params, "ft_contract_address")
      : undefined;
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value.toLowerCase())) {
    throw new Error(`Invalid Legacy ${method === "mergeFtUtxos" ? "FT" : "Stablecoin"} merge`);
  }
  if (
    params !== null && typeof params === "object" &&
    (Object.getPrototypeOf(params) !== Object.prototype ||
      Reflect.ownKeys(params).length !== 1 ||
      Reflect.ownKeys(params).some((key) => key !== "contract_id" && key !== "ft_contract_address"))
  ) {
    throw new Error(`Invalid Legacy ${method === "mergeFtUtxos" ? "FT" : "Stablecoin"} merge`);
  }
  return Object.freeze({
    kind: method === "mergeFtUtxos" ? "ft" as const : "stablecoin" as const,
    contractId: value.toLowerCase(),
  });
}

function legacyMultiRoundMergeResult(
  method: TbcKitLegacyMergeMethod,
  value: unknown,
  duration: number,
): Readonly<Record<string, unknown>> {
  const stablecoin = method === "mergeStableCoinUtxos";
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return Object.freeze({
      success: false,
      duration,
      ...(stablecoin ? { successCount: 0 } : {}),
    });
  }
  const result = value as Partial<TbcMultiRoundMergeResult>;
  const initial = result.initialUtxoCount;
  const final = result.finalUtxoCount;
  const validCounts = Number.isSafeInteger(initial) && Number.isSafeInteger(final) &&
    Number(initial) >= 0 && Number(final) >= 0 && Number(initial) >= Number(final);
  const successCount = validCounts
    ? Math.max(0, Number(initial) - Number(final))
    : 0;
  const success = validCounts && Number(final) <= 1 && result.status === "complete" &&
    (result.reason === "target-reached" || result.reason === "already-below-target");
  return Object.freeze({
    success,
    duration,
    ...(stablecoin ? { successCount } : {}),
  });
}

function hasExactPermission(
  value: unknown,
  capability: "tbc_signTransaction" | "tbc_sendTransaction",
  origin: string,
  chainId: string,
  accountId: string,
): boolean {
  if (!Array.isArray(value)) return false;
  return value.some((candidate) => {
    if (candidate === null || typeof candidate !== "object") return false;
    const caveats = Reflect.get(candidate, "caveats");
    if (
      Reflect.get(candidate, "parentCapability") !== capability ||
      Reflect.get(candidate, "invoker") !== origin ||
      !Array.isArray(caveats)
    ) {
      return false;
    }
    const caveatValue = (type: string): unknown => {
      const match = caveats.find(
        (caveat) =>
          caveat !== null &&
          typeof caveat === "object" &&
          Reflect.get(caveat, "type") === type,
      );
      return match === undefined ? undefined : Reflect.get(match, "value");
    };
    const chains = caveatValue("restrictChains");
    const accounts = caveatValue("restrictAccounts");
    const methods = caveatValue("restrictMethods");
    return (
      Array.isArray(chains) &&
      chains.length === 1 &&
      chains[0] === chainId &&
      Array.isArray(accounts) &&
      accounts.includes(accountId) &&
      Array.isArray(methods) &&
      methods.includes(capability)
    );
  });
}

function legacyTransactionResult(delivery: TbcTransportDelivery): unknown {
  const result = providerResult("sendTransaction", delivery);
  if (businessError(result)) return result;
  if (result === null || typeof result !== "object") {
    throw new Error("Invalid canonical Legacy transaction result");
  }
  const transactions = Reflect.get(result, "transactions");
  if (!Array.isArray(transactions) || transactions.length === 0) {
    throw new Error("Invalid canonical Legacy transaction result");
  }
  if (
    transactions.every(
      (transaction) =>
        transaction !== null &&
        typeof transaction === "object" &&
        typeof Reflect.get(transaction, "rawTransaction") === "string",
    )
  ) {
    return Object.freeze({
      txraw: transactions
        .map((transaction) => Reflect.get(transaction, "rawTransaction"))
        .join(","),
    });
  }
  if (
    transactions.every(
      (transaction) =>
        transaction !== null &&
        typeof transaction === "object" &&
        typeof Reflect.get(transaction, "txid") === "string",
    )
  ) {
    return Object.freeze({
      txid: transactions
        .map((transaction) => Reflect.get(transaction, "txid"))
        .join(","),
    });
  }
  throw new Error("Invalid canonical Legacy transaction result");
}

function legacyFtCreateResult(delivery: TbcTransportDelivery): unknown {
  const result = providerResult("sendTransaction", delivery);
  if (businessError(result)) return result;
  const transactions =
    result !== null && typeof result === "object"
      ? Reflect.get(result, "transactions")
      : undefined;
  const primary = Array.isArray(transactions)
    ? transactions.filter(
        (transaction) =>
          transaction !== null &&
          typeof transaction === "object" &&
          Reflect.get(transaction, "role") === "primary" &&
          Reflect.get(transaction, "status") === "submitted",
      )
    : [];
  const txid =
    primary.length === 1 ? Reflect.get(primary[0] as object, "txid") : undefined;
  if (typeof txid !== "string" || !/^[0-9a-f]{64}$/u.test(txid)) {
    throw new Error("Invalid canonical Legacy FT create result");
  }
  return Object.freeze({ txid });
}

/**
 * Creates the wallet-native half of the frozen window.Turing bridge for the
 * Baseline-A account/session surface, Bitcoin message signing and the optional
 * sign-only FT-transfer slice. Page data can select only a historical method;
 * this controller constructs every canonical Provider request and leaves
 * account, permission, approval, Host, Signer and platform authority injected.
 */
export function createTbcKitLegacyWebViewNativeController(
  options: TbcKitLegacyWebViewNativeOptions,
): TbcKitLegacyWebViewNativeController {
  if (
    options === null ||
    typeof options !== "object" ||
    typeof options.post !== "function" ||
    typeof options.handlers?.send !== "function" ||
    typeof options.handlers.cancel !== "function" ||
    typeof options.handlers.close !== "function"
  ) {
    throw new TypeError("TBC Kit Legacy WebView options are invalid");
  }
  const navigation = options.navigation;
  const selectedNetwork = options.network === undefined
    ? undefined
    : assertTbcNetworkContext(options.network);
  if (selectedNetwork !== undefined && selectedNetwork.chainId !== options.chainId) {
    throw new TypeError("Legacy WebView chainId does not match its TBC network context");
  }
  if (
    options.balances !== undefined &&
    (selectedNetwork === undefined ||
      options.balances.chainId !== selectedNetwork.chainId ||
      options.balances.networkSourceIdentity !== selectedNetwork.sourceIdentity)
  ) {
    throw new TypeError("Legacy balance reader does not match its TBC network context");
  }
  tbcNetworkProfileForChainId(options.chainId);
  const networkName = selectedNetwork?.network ?? tbcNetworkNameForChainId(options.chainId);
  const transactionOptions = options.transactions;
  const nftIntents = createLegacyNftIntentResolver({ chainId: options.chainId });
  if (
    navigation.frame !== "top" ||
    navigation.origin !== navigation.topOrigin ||
    typeof navigation.sessionId !== "string" ||
    typeof navigation.navigationId !== "string"
  ) {
    throw new TypeError("TBC Kit Legacy WebView navigation is invalid");
  }

  const deliveries = new Map<string, string>();
  const used = new Set<string>();
  const inFlight = new Map<string, Promise<void>>();
  let ready = false;
  let closed = false;
  let closePromise: Promise<void> | undefined;

  function matchesNetworkContext(
    context: TbcKitLegacyTransactionContext,
  ): boolean {
    return selectedNetwork === undefined ||
      context.networkSourceIdentity === selectedNetwork.sourceIdentity;
  }

  function supportsRequest(method: LegacyMethod, params: unknown): boolean {
    if (method === "sendTransaction" && options.allowHistoricalAssetCreation === false &&
        isHistoricalAssetCreation(params)) return false;
    return (
      BASELINE_METHODS.has(method) ||
      (method === "getBalance" && options.balances !== undefined) ||
      method === "signMessage" ||
      ((method === "signTransaction" ||
        method === "signAssociatedTransaction" ||
        method === "encrypt" ||
        method === "decrypt") && options.genericBatch !== undefined) ||
      (method === "sendTransaction" &&
        ((transactionOptions !== undefined &&
          legacyFlagParams(params, LEGACY_NFT_FLAGS) !== undefined) ||
          (transactionOptions?.ftCreateIntents !== undefined &&
          isLegacyFtCreateParams(params)) ||
          (transactionOptions?.ftTransferIntents !== undefined &&
            isLegacyFtTransferParams(params)) ||
          (transactionOptions?.stablecoinTransferIntents !== undefined &&
            isLegacyStablecoinTransferRequest(params)) ||
          (transactionOptions !== undefined &&
            isLegacyP2pkhParams(params)) ||
          (transactionOptions !== undefined &&
            legacyFtMergeParams(params) !== undefined) ||
          (transactionOptions !== undefined &&
            legacyStablecoinMergeParams(params) !== undefined) ||
          (transactionOptions?.poolIntents !== undefined &&
            legacyPoolParams(params) !== undefined))) ||
      (method === "sendBatchRequest" &&
        options.genericBatch !== undefined &&
        isLegacyGenericBatchParams(params))
      || ((method === "mergeUtxos" || method === "mergeFtUtxos" ||
        method === "mergeStableCoinUtxos") && options.multiRoundMerge !== undefined)
    );
  }

  function post(message: Parameters<typeof encodeLegacyNativeMessage>[0]): void {
    if (closed && message.type !== "close") return;
    const sent = options.post(encodeLegacyNativeMessage(message));
    if (sent !== undefined) {
      void Promise.resolve(sent).catch(() => {
        void close();
      });
    }
  }

  function initialize(): void {
    if (closed) return;
    post({
      channel: LEGACY_WEBVIEW_CHANNEL,
      type: "initialize",
      sessionId: navigation.sessionId,
      navigationId: navigation.navigationId,
      origin: navigation.origin,
      chainId: options.chainId,
      platform: options.platform,
      walletVersion: options.walletVersion,
      contractVersion: LEGACY_CONTRACT_VERSION,
      contractBundleSha256: LEGACY_CONTRACT_BUNDLE_SHA256,
    });
  }

  async function dispatch(
    requestId: string,
    step: number,
    method: TbcJsonRpcRequest["method"],
    params: TbcJsonRpcRequest["params"],
    ftDecimals?: number,
  ): Promise<TbcTransportDelivery | undefined> {
    const request: TbcJsonRpcRequest = {
      jsonrpc: "2.0",
      id: `${requestId}:${String(step)}`,
      method,
      ...(params === undefined ? {} : { params }),
    };
    const result = await options.handlers.send(request, navigation);
    return "status" in result ? undefined : result;
  }

  async function acknowledgeInternal(
    delivery: TbcTransportDelivery,
  ): Promise<void> {
    await options.handlers.acknowledgeDelivery?.(
      delivery.deliveryId,
      navigation,
    );
  }

  async function baseline(
    requestId: string,
    method: LegacyBaselineAMethod,
    params: unknown,
  ): Promise<LegacyOutcome> {
    if (method === "getInfo") {
      return Object.freeze({
        result: mapLegacyResult(method, null, {
          chainId: options.chainId,
          platform: options.platform,
          walletVersion: options.walletVersion,
        }),
      });
    }
    if (method === "connect") {
      const permission = mapLegacyRequest({
        method,
        params,
        chainId: options.chainId,
      });
      if (permission === undefined) throw new Error("Invalid Legacy mapping");
      const permissionDelivery = await dispatch(
        requestId,
        1,
        permission.method,
        permission.params,
      );
      if (permissionDelivery === undefined) {
        return Object.freeze({
          result: { error: "Legacy wallet session closed" },
        });
      }
      const permissionResult = providerResult(method, permissionDelivery);
      if (
        permissionResult !== null &&
        typeof permissionResult === "object" &&
        Object.hasOwn(permissionResult, "error")
      ) {
        return Object.freeze({
          deliveryId: permissionDelivery.deliveryId,
          events: permissionDelivery.events,
          result: permissionResult,
        });
      }
      await acknowledgeInternal(permissionDelivery);
      const accounts = mapLegacyRequest({
        method: "getAddress",
        params,
        chainId: options.chainId,
      });
      if (accounts === undefined) throw new Error("Invalid Legacy mapping");
      const accountsDelivery = await dispatch(
        requestId,
        2,
        accounts.method,
        accounts.params,
      );
      if (accountsDelivery === undefined) {
        return Object.freeze({
          result: { error: "Legacy wallet session closed" },
        });
      }
      const accountResult = providerResult(method, accountsDelivery);
      return Object.freeze({
        deliveryId: accountsDelivery.deliveryId,
        events: Object.freeze([
          ...permissionDelivery.events,
          ...accountsDelivery.events,
        ]),
        result:
          accountResult !== null &&
          typeof accountResult === "object" &&
          Object.hasOwn(accountResult, "error")
            ? accountResult
            : mapLegacyResult(method, accountResult, {
                chainId: options.chainId,
              }),
      });
    }
    if (method === "getPubKey") {
      const accounts = mapLegacyRequest({
        method: "getAddress",
        params,
        chainId: options.chainId,
      });
      if (accounts === undefined) throw new Error("Invalid Legacy mapping");
      const accountsDelivery = await dispatch(
        requestId,
        1,
        accounts.method,
        accounts.params,
      );
      if (accountsDelivery === undefined) {
        return Object.freeze({ result: { error: "User not connected" } });
      }
      const accountResult = providerResult(method, accountsDelivery);
      await acknowledgeInternal(accountsDelivery);
      const address =
        Array.isArray(accountResult) && typeof accountResult[0] === "string"
          ? accountResult[0]
          : undefined;
      if (address === undefined) {
        return Object.freeze({ result: { error: "User not connected" } });
      }
      const mapped = mapLegacyRequest({
        method,
        params,
        chainId: options.chainId,
        address,
      });
      if (mapped === undefined) throw new Error("Invalid Legacy mapping");
      const delivery = await dispatch(
        requestId,
        2,
        mapped.method,
        mapped.params,
      );
      if (delivery === undefined) {
        return Object.freeze({
          result: { error: "Legacy wallet session closed" },
        });
      }
      const result = providerResult(method, delivery);
      return Object.freeze({
        deliveryId: delivery.deliveryId,
        events: delivery.events,
        result:
          result !== null &&
          typeof result === "object" &&
          Object.hasOwn(result, "error")
            ? result
            : mapLegacyResult(method, result, { chainId: options.chainId }),
      });
    }
    const mapped = mapLegacyRequest({
      method,
      params,
      chainId: options.chainId,
    });
    if (mapped === undefined) throw new Error("Invalid Legacy mapping");
    const delivery = await dispatch(requestId, 1, mapped.method, mapped.params);
    if (delivery === undefined) {
      return Object.freeze({
        result: { error: "Legacy wallet session closed" },
      });
    }
    const result = providerResult(method, delivery);
    return Object.freeze({
      deliveryId: delivery.deliveryId,
      events: delivery.events,
      result:
        result !== null &&
        typeof result === "object" &&
        Object.hasOwn(result, "error")
          ? result
          : mapLegacyResult(method, result, { chainId: options.chainId }),
    });
  }

  async function signMessage(
    requestId: string,
    params: unknown,
    pinnedAddress?: string,
  ): Promise<LegacyOutcome> {
    if (options.bitcoinMessages === undefined) {
      return Object.freeze({
        result: { error: "Unsupported legacy operation" },
      });
    }
    const normalizedParams =
      params !== null &&
      typeof params === "object" &&
      !Array.isArray(params) &&
      Object.getPrototypeOf(params) === Object.prototype &&
      Reflect.get(params, "encoding") === "utf-8"
        ? Object.freeze({
            ...(params as Readonly<Record<string, unknown>>),
            encoding: "utf8" as const,
          })
        : params;
    const prepared = await options.bitcoinMessages.prepare(
      normalizedParams as TbcKitLegacyBitcoinMessageInput,
    );
    if (!/^[0-9a-f]{64}$/u.test(prepared.digest)) {
      throw new Error("Invalid trusted Legacy Bitcoin message digest");
    }
    const accountsDelivery =
      pinnedAddress === undefined
        ? await dispatch(requestId, 1, "tbc_accounts", [])
        : undefined;
    if (pinnedAddress === undefined && accountsDelivery === undefined) {
      return Object.freeze({ result: { error: "User not connected" } });
    }
    const accounts =
      accountsDelivery === undefined
        ? undefined
        : providerResult("signMessage", accountsDelivery);
    const address =
      pinnedAddress ??
      (Array.isArray(accounts) && typeof accounts[0] === "string"
        ? accounts[0]
        : undefined);
    if (address === undefined) {
      return Object.freeze({
        ...(accountsDelivery === undefined
          ? {}
          : {
              deliveryId: accountsDelivery.deliveryId,
              events: accountsDelivery.events,
            }),
        result:
          accounts !== null &&
          typeof accounts === "object" &&
          Object.hasOwn(accounts, "error")
            ? accounts
            : { error: "User not connected" },
      });
    }
    if (accountsDelivery !== undefined) {
      await acknowledgeInternal(accountsDelivery);
    }
    const delivery = await dispatch(requestId, 2, "tbc_signMessage", {
      version: "1.0",
      chainId: options.chainId,
      from: address,
      clientRequestId: `legacy-bitcoin:${prepared.digest}`,
      message: {
        encoding: prepared.encoding,
        data: prepared.message,
      },
    });
    if (delivery === undefined) {
      return Object.freeze({
        result: { error: "Legacy wallet session closed" },
      });
    }
    return Object.freeze({
      deliveryId: delivery.deliveryId,
      events: delivery.events,
      result: legacySignMessageResult(delivery),
    });
  }

  async function currentSecureAccount(
    requestId: string,
    method:
      | "getBalance"
      | "signTransaction"
      | "signAssociatedTransaction"
      | "encrypt"
      | "decrypt",
  ): Promise<
    | Readonly<{
        address: string;
        events: readonly TbcProviderEvent[];
      }>
    | Readonly<{ failure: LegacyOutcome }>
  > {
    const delivery = await dispatch(requestId, 1, "tbc_accounts", []);
    if (delivery === undefined) {
      return Object.freeze({
        failure: Object.freeze({ result: { error: "User not connected" } }),
      });
    }
    const accounts = providerResult(method, delivery);
    const address = Array.isArray(accounts) && typeof accounts[0] === "string"
      ? accounts[0]
      : undefined;
    if (address === undefined) {
      return Object.freeze({
        failure: Object.freeze({
          deliveryId: delivery.deliveryId,
          events: delivery.events,
          result: businessError(accounts) ? accounts : { error: "User not connected" },
        }),
      });
    }
    await acknowledgeInternal(delivery);
    return Object.freeze({ address, events: delivery.events });
  }

  async function getBalance(
    requestId: string,
    params: unknown,
  ): Promise<LegacyOutcome> {
    if (
      options.balances === undefined ||
      !(params === undefined ||
        (Array.isArray(params) && params.length === 0) ||
        (params !== null &&
          typeof params === "object" &&
          !Array.isArray(params) &&
          Reflect.ownKeys(params).length === 0))
    ) {
      return Object.freeze({ result: { error: "Unsupported legacy operation" } });
    }
    const account = await currentSecureAccount(requestId, "getBalance");
    if ("failure" in account) return account.failure;
    return Object.freeze({
      events: account.events,
      result: await options.balances.read(account.address),
    });
  }

  async function transactionContext(requestId: string): Promise<
    | Readonly<{
        context: TbcKitLegacyTransactionContext & {
          readonly events: readonly TbcProviderEvent[];
        };
      }>
    | Readonly<{ failure: LegacyOutcome }>
  > {
    const configured = transactionOptions?.readTransactionContext;
    if (configured !== undefined) {
      const context = await configured(navigation);
      return context === null || closed || !matchesNetworkContext(context)
        ? Object.freeze({
            failure: Object.freeze({ result: { error: "User not connected" } }),
          })
        : Object.freeze({
            context: Object.freeze({ ...context, events: Object.freeze([]) }),
          });
    }
    const accountsDelivery = await dispatch(requestId, 1, "tbc_accounts", []);
    if (accountsDelivery === undefined) {
      return Object.freeze({
        failure: Object.freeze({ result: { error: "User not connected" } }),
      });
    }
    const accounts = providerResult("sendTransaction", accountsDelivery);
    const address =
      Array.isArray(accounts) && typeof accounts[0] === "string"
        ? accounts[0]
        : undefined;
    if (address === undefined) {
      return Object.freeze({
        failure: Object.freeze({
          deliveryId: accountsDelivery.deliveryId,
          events: accountsDelivery.events,
          result: businessError(accounts)
            ? accounts
            : { error: "User not connected" },
        }),
      });
    }
    await acknowledgeInternal(accountsDelivery);
    const permissionsDelivery = await dispatch(
      requestId,
      2,
      "wallet_getPermissions",
      undefined,
    );
    if (permissionsDelivery === undefined) {
      return Object.freeze({
        failure: Object.freeze({
          result: { error: "Legacy wallet session closed" },
        }),
      });
    }
    const permissions = providerResult("sendTransaction", permissionsDelivery);
    if (businessError(permissions)) {
      return Object.freeze({
        failure: Object.freeze({
          deliveryId: permissionsDelivery.deliveryId,
          events: permissionsDelivery.events,
          result: permissions,
        }),
      });
    }
    await acknowledgeInternal(permissionsDelivery);
    return Object.freeze({
      context: Object.freeze({
        address,
        permissions: permissions as readonly unknown[],
        events: Object.freeze([
          ...accountsDelivery.events,
          ...permissionsDelivery.events,
        ]),
      }),
    });
  }

  async function sendSharedBusinessTransaction(
    requestId: string,
    params: unknown,
  ): Promise<LegacyOutcome> {
    const nftParams = legacyFlagParams(params, LEGACY_NFT_FLAGS);
    const ftCreate = isLegacyFtCreateParams(params);
    const ftTransfer = isLegacyFtTransferParams(params);
    const stablecoinTransfer = isLegacyStablecoinTransferRequest(params);
    const stablecoinParams = stablecoinTransfer
      ? legacyFlagParams(params, LEGACY_STABLECOIN_TRANSFER_FLAGS)
      : undefined;
    const ftMerge = legacyFtMergeParams(params);
    const stablecoinMerge = legacyStablecoinMergeParams(params);
    const poolParams = legacyPoolParams(params);
    let ftDecimals: number | undefined;
    if (
      transactionOptions === undefined ||
      (ftCreate && transactionOptions.ftCreateIntents === undefined) ||
      (ftTransfer && transactionOptions.ftTransferIntents === undefined) ||
      (stablecoinTransfer && transactionOptions.stablecoinTransferIntents === undefined) ||
      (nftParams === undefined && !ftCreate && ftMerge === undefined &&
        stablecoinMerge === undefined && !ftTransfer && !stablecoinTransfer &&
        (poolParams === undefined || transactionOptions.poolIntents === undefined))
    ) {
      return Object.freeze({ result: { error: "Unsupported legacy operation" } });
    }
    const contextResult = await transactionContext(requestId);
    if ("failure" in contextResult) return contextResult.failure;
    const { address, permissions, events } = contextResult.context;
    let canonical: Readonly<Record<string, unknown>>;
    try {
      canonical = nftParams !== undefined
        ? await nftIntents.resolve(params, address)
        : ftCreate
        ? await transactionOptions.ftCreateIntents!.resolve(params, address)
        : ftTransfer
          ? await transactionOptions.ftTransferIntents!.resolve(params, address, (value) => {
              ftDecimals = value;
            })
        : stablecoinTransfer
          ? await transactionOptions.stablecoinTransferIntents!.resolve(params, address, (value) => {
              ftDecimals = value;
            })
        : ftMerge !== undefined
          ? legacyFtMergeRequest(ftMerge, options.chainId, address)
        : stablecoinMerge !== undefined
          ? legacyStablecoinMergeRequest(stablecoinMerge, options.chainId, address)
        : await transactionOptions.poolIntents!.resolve(poolParams, address);
    } catch (error) {
      if (stablecoinTransfer && !(error instanceof LegacyStablecoinParameterError)) {
        return Object.freeze({ result: { error: "Stablecoin metadata unavailable" } });
      }
      if (
        nftParams === undefined &&
        !stablecoinTransfer &&
        stablecoinMerge === undefined &&
        !(error instanceof LegacyFtCreateParameterError) &&
        !(error instanceof LegacyPoolParameterError)
      ) {
        throw error;
      }
      return Object.freeze({ result: { error: "Missing required parameters" } });
    }
    canonical = withStandardApprovalFeeCap(canonical, "10000");
    const ftTransferParams = ftTransfer
      ? legacyFlagParams(params, new Set(["FT_TRANSFER"]))
      : undefined;
    const broadcastEnabled =
      nftParams !== undefined || ftTransfer || stablecoinTransfer
        ? Reflect.get(nftParams ?? ftTransferParams ?? stablecoinParams!, "broadcastEnabled") !== false
        : undefined;
    const capability = ftCreate || ftMerge !== undefined || stablecoinMerge !== undefined
      ? "tbc_sendTransaction" as const
      : broadcastEnabled === true
        ? "tbc_sendTransaction" as const
      : LEGACY_POOL_MERGE_FLAGS.has(String(poolParams?.flag))
        ? "tbc_sendTransaction" as const
        : "tbc_signTransaction" as const;
    const granted = hasExactPermission(
      permissions,
      capability,
      navigation.origin,
      options.chainId,
      `${options.chainId}:${address}`,
    );
    const permissionDelivery = granted
      ? undefined
      : await dispatch(requestId, 3, "wallet_requestPermissions", [
          { [capability]: { chains: [options.chainId] } },
        ]);
    if (!granted && permissionDelivery === undefined) {
      return Object.freeze({ result: { error: "Legacy wallet session closed" } });
    }
    const permissionResult = permissionDelivery === undefined
      ? undefined
      : providerResult("sendTransaction", permissionDelivery);
    if (permissionDelivery !== undefined && businessError(permissionResult)) {
      return Object.freeze({
        deliveryId: permissionDelivery.deliveryId,
        events: Object.freeze([...events, ...permissionDelivery.events]),
        result: permissionResult,
      });
    }
    if (permissionDelivery !== undefined) {
      await acknowledgeInternal(permissionDelivery);
    }
    const delivery = await dispatch(
      requestId,
      permissionDelivery === undefined ? 3 : 4,
      capability,
      canonical,
      ftDecimals,
    );
    if (delivery === undefined) {
      return Object.freeze({ result: { error: "Legacy wallet session closed" } });
    }
    return Object.freeze({
      deliveryId: delivery.deliveryId,
      events: Object.freeze([
        ...events,
        ...(permissionDelivery?.events ?? []),
        ...delivery.events,
      ]),
      result: ftCreate
        ? legacyFtCreateResult(delivery)
        : legacyTransactionResult(delivery),
    });
  }

  async function sendStandaloneMerge(
    requestId: string,
    method: TbcKitLegacyMergeMethod,
    params: unknown,
  ): Promise<LegacyOutcome> {
    if (options.multiRoundMerge === undefined) {
      return Object.freeze({ result: { error: "Unsupported legacy operation" } });
    }
    const startedAt = Date.now();
    let asset: TbcKitLegacyMergeAsset;
    let limits: Omit<TbcMultiRoundMergeLimits, "targetUtxoCount">;
    try {
      asset = legacyStandaloneMergeAsset(method, params);
      limits = await options.multiRoundMerge.createLimits(Object.freeze({
        method,
        asset,
        navigation,
      }));
    } catch {
      return Object.freeze({ result: { error: "Missing required parameters" } });
    }
    let address: string | undefined;
    let events: readonly TbcProviderEvent[] = Object.freeze([]);
    const fastContext = transactionOptions?.readTransactionContext === undefined
      ? undefined
      : await transactionOptions.readTransactionContext(navigation);
    if (fastContext !== undefined && fastContext !== null && !matchesNetworkContext(fastContext)) {
      return Object.freeze({
        result: legacyMultiRoundMergeResult(method, undefined, Math.max(0, Date.now() - startedAt)),
      });
    }
    if (fastContext !== undefined && fastContext !== null && matchesNetworkContext(fastContext)) {
      address = fastContext.address;
    }
    let accountsDelivery: TbcTransportDelivery | undefined;
    if (address === undefined) {
      accountsDelivery = await dispatch(requestId, 1, "tbc_accounts", undefined);
      if (accountsDelivery === undefined) {
        return Object.freeze({ result: { error: "Legacy wallet session closed" } });
      }
      const accounts = providerResult(method, accountsDelivery);
      if (!Array.isArray(accounts) || typeof accounts[0] !== "string") {
        return Object.freeze({
          deliveryId: accountsDelivery.deliveryId,
          events: accountsDelivery.events,
          result: legacyMultiRoundMergeResult(method, accounts, Math.max(0, Date.now() - startedAt)),
        });
      }
      address = accounts[0];
      events = accountsDelivery.events;
      await acknowledgeInternal(accountsDelivery);
    }
    try {
      address = assertTbcAddress(
        address,
        tbcNetworkProfileForChainId(options.chainId).p2pkhVersion,
      ).address;
    } catch {
      return Object.freeze({
        result: legacyMultiRoundMergeResult(method, undefined, Math.max(0, Date.now() - startedAt)),
      });
    }
    const publicRequest = Object.freeze({
      version: "1.0" as const,
      chainId: options.chainId,
      from: address,
      clientRequestId: `legacy-merge:${hashCanonical({
        method,
        navigationId: navigation.navigationId,
        requestId,
        asset,
      })}`,
      asset,
      limits: Object.freeze({ targetUtxoCount: 1, ...limits }),
    });
    const delivery = await dispatch(
      requestId,
      accountsDelivery === undefined ? 1 : 2,
      "tbc_runMultiRoundMerge",
      publicRequest,
    );
    if (delivery === undefined) {
      return Object.freeze({ result: { error: "Legacy wallet session closed" } });
    }
    const publicResult = providerResult(method, delivery);
    return Object.freeze({
      deliveryId: delivery.deliveryId,
      events: Object.freeze([
        ...events,
        ...delivery.events,
      ]),
      result: legacyMultiRoundMergeResult(
        method,
        publicResult,
        Math.max(0, Date.now() - startedAt),
      ),
    });
  }

  async function sendP2pkhTransfer(
    requestId: string,
    params: unknown,
  ): Promise<LegacyOutcome> {
    if (transactionOptions === undefined || !isLegacyP2pkhParams(params)) {
      return Object.freeze({ result: { error: "Unsupported legacy operation" } });
    }
    const contextResult = await transactionContext(requestId);
    if ("failure" in contextResult) return contextResult.failure;
    const { address, permissions, events } = contextResult.context;
    const canonical = withStandardApprovalFeeCap(
      legacyP2pkhRequest(params, options.chainId, address),
      "1000",
    );
    const capability = Reflect.get(legacyP2pkhParams(params)!, "broadcastEnabled") === false
      ? "tbc_signTransaction" as const
      : "tbc_sendTransaction" as const;
    const granted = hasExactPermission(
      permissions,
      capability,
      navigation.origin,
      options.chainId,
      `${options.chainId}:${address}`,
    );
    const permissionDelivery = granted
      ? undefined
      : await dispatch(requestId, 3, "wallet_requestPermissions", [
          { [capability]: { chains: [options.chainId] } },
        ]);
    if (!granted && permissionDelivery === undefined) {
      return Object.freeze({ result: { error: "Legacy wallet session closed" } });
    }
    const permissionResult = permissionDelivery === undefined
      ? undefined
      : providerResult("sendTransaction", permissionDelivery);
    if (permissionDelivery !== undefined && businessError(permissionResult)) {
      return Object.freeze({
        deliveryId: permissionDelivery.deliveryId,
        events: Object.freeze([...events, ...permissionDelivery.events]),
        result: permissionResult,
      });
    }
    if (permissionDelivery !== undefined) await acknowledgeInternal(permissionDelivery);
    const delivery = await dispatch(
      requestId,
      granted ? 3 : 4,
      capability,
      canonical,
    );
    if (delivery === undefined) {
      return Object.freeze({ result: { error: "Legacy wallet session closed" } });
    }
    return Object.freeze({
      deliveryId: delivery.deliveryId,
      events: Object.freeze([
        ...events,
        ...(permissionDelivery?.events ?? []),
        ...delivery.events,
      ]),
      result: legacyTransactionResult(delivery),
    });
  }

  async function sendGenericBatch(
    requestId: string,
    params: unknown,
  ): Promise<LegacyOutcome> {
    if (options.genericBatch !== undefined) {
      if (options.genericBatch.supports?.("sendBatchRequest") === false) {
        return Object.freeze({ result: { error: "Unsupported legacy operation" } });
      }
      const outcome = await options.genericBatch.execute({
        requestId,
        requests: params,
        context: Object.freeze({
          origin: navigation.origin,
          sessionId: navigation.sessionId,
          navigationId: navigation.navigationId,
          chainId: options.chainId,
        }),
      });
      return Object.freeze({
        deliveryId: outcome.deliveryId,
        events: outcome.events,
        result: outcome.results,
      });
    }
    return Object.freeze({ result: { error: "Unsupported legacy operation" } });
  }

  async function sendStandaloneStandardWorkflow(
    requestId: string,
    method: "signTransaction" | "signAssociatedTransaction" | "encrypt" | "decrypt",
    params: unknown,
  ): Promise<LegacyOutcome> {
    if (options.genericBatch === undefined) {
      return Object.freeze({ result: { error: "Unsupported legacy operation" } });
    }
    if (options.genericBatch.supports?.(method) === false) {
      return Object.freeze({ result: { error: "Unsupported legacy operation" } });
    }
    const outcome = await options.genericBatch.execute({
      requestId,
      requests: Object.freeze([Object.freeze({ method, params })]),
      context: Object.freeze({
        origin: navigation.origin,
        sessionId: navigation.sessionId,
        navigationId: navigation.navigationId,
        chainId: options.chainId,
      }),
    });
    const result = outcome.results[0];
    const normalizedResult = businessError(result) &&
        Reflect.get(result as Readonly<Record<string, unknown>>, "error") ===
          "User cancelled the batch request"
      ? Object.freeze({ error: legacyBusinessError(method, "") })
      : result;
    return Object.freeze({
      deliveryId: outcome.deliveryId,
      events: outcome.events,
      result: normalizedResult,
    });
  }

  async function handleRequest(
    requestId: string,
    method: LegacyMethod,
    params: unknown,
  ): Promise<void> {
    const outcome: LegacyOutcome = method === "sendTransaction" &&
        options.allowHistoricalAssetCreation === false &&
        isHistoricalAssetCreation(params)
      ? Object.freeze({ result: { error: "Unsupported legacy operation" } })
      : BASELINE_METHODS.has(method)
      ? await baseline(requestId, method as LegacyBaselineAMethod, params)
      : method === "getBalance"
        ? await getBalance(requestId, params)
      : method === "signMessage"
        ? await signMessage(requestId, params)
        : method === "signTransaction"
          ? await sendStandaloneStandardWorkflow(requestId, method, params)
        : method === "signAssociatedTransaction"
          ? await sendStandaloneStandardWorkflow(requestId, method, params)
          : method === "encrypt" || method === "decrypt"
            ? await sendStandaloneStandardWorkflow(requestId, method, params)
        : method === "sendTransaction"
          ? isLegacyP2pkhParams(params)
            ? await sendP2pkhTransfer(requestId, params)
          : legacyFlagParams(params, LEGACY_NFT_FLAGS) !== undefined ||
            (transactionOptions?.ftTransferIntents !== undefined && isLegacyFtTransferParams(params)) ||
            (transactionOptions?.stablecoinTransferIntents !== undefined &&
              isLegacyStablecoinTransferRequest(params)) ||
            isLegacyFtCreateParams(params) ||
            legacyFtMergeParams(params) !== undefined ||
            legacyStablecoinMergeParams(params) !== undefined ||
            legacyPoolParams(params) !== undefined
            ? await sendSharedBusinessTransaction(requestId, params)
            : Object.freeze({ result: { error: "Unsupported legacy operation" } })
          : method === "mergeUtxos" || method === "mergeFtUtxos" ||
            method === "mergeStableCoinUtxos"
            ? await sendStandaloneMerge(requestId, method, params)
          : method === "sendBatchRequest"
            ? await sendGenericBatch(requestId, params)
        : Object.freeze({
            result: { error: "Unsupported legacy operation" },
          });
    if (closed) return;
    if (outcome.deliveryId !== undefined) {
      deliveries.set(requestId, outcome.deliveryId);
    }
    post({
      channel: LEGACY_WEBVIEW_CHANNEL,
      type: "response",
      sessionId: navigation.sessionId,
      navigationId: navigation.navigationId,
      requestId,
      method,
      ...(outcome.deliveryId === undefined
        ? {}
        : { deliveryId: outcome.deliveryId }),
      result: outcome.result,
    });
    const mappedEvents = (outcome.events ?? [])
      .map((event) => legacyEvent(event, networkName))
      .filter(
        (value): value is NonNullable<typeof value> => value !== undefined,
      )
      .filter(
        (value, index, values) =>
          values.findIndex(
            (candidate) =>
              candidate.event === value.event &&
              JSON.stringify(candidate.detail) === JSON.stringify(value.detail),
          ) === index,
      );
    if (
      method === "connect" &&
      mappedEvents.every(({ event }) => event !== "TuringAccountChanged") &&
      outcome.result !== null &&
      typeof outcome.result === "object" &&
      typeof Reflect.get(outcome.result, "tbcAddress") === "string"
    ) {
      mappedEvents.push({
        event: "TuringAccountChanged",
        detail: Object.freeze({
          addresses: Object.freeze({
            tbcAddress: Reflect.get(outcome.result, "tbcAddress") as string,
          }),
        }),
      });
    }
    if (
      method === "disconnect" &&
      outcome.result === true &&
      mappedEvents.every(({ event }) => event !== "TuringAccountChanged")
    ) {
      mappedEvents.push({
        event: "TuringAccountChanged",
        detail: Object.freeze({ addresses: Object.freeze({}) }),
      });
    }
    for (const mapped of mappedEvents) {
      post({
        channel: LEGACY_WEBVIEW_CHANNEL,
        type: "event",
        sessionId: navigation.sessionId,
        navigationId: navigation.navigationId,
        event: mapped.event,
        detail: mapped.detail,
      });
    }
  }

  async function acceptPageMessage(serialized: string): Promise<void> {
    if (closed) return;
    let message: ReturnType<typeof decodeLegacyPageMessage>;
    try {
      message = decodeLegacyPageMessage(serialized);
    } catch {
      await close("TRANSPORT_CLOSED");
      return;
    }
    if (
      message.sessionId !== navigation.sessionId ||
      message.navigationId !== navigation.navigationId
    ) {
      await close("TRANSPORT_CLOSED");
      return;
    }
    if (message.type === "ready") {
      if (!ready) ready = true;
      return;
    }
    if (!ready) {
      await close("TRANSPORT_CLOSED");
      return;
    }
    if (message.type === "ack") {
      const expected = deliveries.get(message.requestId);
      if (expected !== message.deliveryId) {
        await close("TRANSPORT_CLOSED");
        return;
      }
      deliveries.delete(message.requestId);
      await options.handlers.acknowledgeDelivery?.(
        message.deliveryId,
        navigation,
      );
      return;
    }
    if (used.has(message.requestId)) {
      await close("TRANSPORT_CLOSED");
      return;
    }
    used.add(message.requestId);
    const work = handleRequest(
      message.requestId,
      message.method,
      message.params,
    ).catch(async () => close("TRANSPORT_CLOSED"));
    inFlight.set(message.requestId, work);
    try {
      await work;
    } finally {
      if (inFlight.get(message.requestId) === work) {
        inFlight.delete(message.requestId);
      }
    }
  }

  function close(
    reason: TbcTransportCloseReason = "TRANSPORT_CLOSED",
  ): Promise<void> {
    if (closePromise !== undefined) return closePromise;
    closed = true;
    closePromise = (async () => {
      const sent = options.post(
        encodeLegacyNativeMessage({
          channel: LEGACY_WEBVIEW_CHANNEL,
          type: "close",
          sessionId: navigation.sessionId,
          navigationId: navigation.navigationId,
          reason,
        }),
      );
      if (sent !== undefined) await sent;
      await options.handlers.close(reason, navigation);
    })();
    return closePromise;
  }

  return Object.freeze({
    initialize,
    supportsRequest,
    acceptPageMessage,
    close,
  });
}
