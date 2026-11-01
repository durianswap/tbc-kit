import type {
  CollectionCreateIntent,
  NftMintIntent,
  NftTransferIntent,
  Tbc721StandardCollectionIntent,
  Tbc721StandardMintIntent,
  Tbc721StandardBatchMintIntent,
  Tbc721TransferIntent,
  Tbc721BatchTransferIntent,
  FtCreateIntent,
  FtMergeIntent,
  FtTransferIntent,
  Tbc20StandardCreateIntent,
  Tbc20StandardTransferIntent,
  Tbc20StandardMergeIntent,
  Tbc20TransferIntent,
  Tbc20MergeIntent,
  Tbc20StablecoinTransferIntent,
  Tbc20StablecoinMergeIntent,
  AmmCreateIntent,
  UnifiedAmmAddLiquidityIntent,
  UnifiedAmmRemoveLiquidityIntent,
  UnifiedAmmSwapIntent,
  UnifiedLpTransferIntent,
  UnifiedLpLockIntent,
  UnifiedPoolMaintenanceIntent,
  LpTransferIntent,
  LpLockIntent,
  LpMaintenanceIntent,
  TimelockLockIntent,
  LopCreateIntent,
  LopCancelIntent,
  LopMatchIntent,
  HtlcLockIntent,
  HtlcTokenTarget,
  CoinTransferIntent,
  CoinMergeIntent,
  CoinCreateIntent,
  CoinMintIntent,
  CoinFreezeIntent,
  CoinUnfreezeIntent,
  StablecoinMergeIntent,
  StablecoinTransferIntent,
  KitRequestOptions,
  KitExpiringTransactionConstraints,
  KitProvider,
  KitSupportedIntent,
  KitTransactionConstraints,
  KitTransactionRequest,
  KitWalletCatalogEntry,
  KitWalletDescriptor,
  KitWalletOption,
  PoolCreateIntent,
  PoolFtlpBurnIntent,
  PoolLiquidityIntent,
  PoolMergeIntent,
  PoolSwapIntent,
  TbcMergeIntent,
  TbcTransferIntent,
} from "./public-types.js";
import type {
  TbcPreparedProposal,
  TbcPreparedWorkflowRequest,
  TbcReviewedTransactionInput,
  TbcMessageCryptoAlgorithm,
  TbcWorkflowComposition,
  TbcWorkflowStep,
} from "./prepared.js";
import { createTbcOfficialApi } from "./official-api.js";
import { createTimelockReader, type TimelockReader, type ListTimelockDepositsInput } from "./timelock-query.js";
import { createTbc721Reader, type Tbc721Reader, type GetTbc721MintStatusInput, type CreateTbc721ReaderOptions } from "./nft-query.js";
import { createLazyBundledWasmTbcKeylessEngine } from "./keyless.js";
import type { TbcNftMintJobLimits, TbcNftMintJobResult } from "./nft-mint-job.js";
import type {
  TbcMultiRoundMergeAsset,
  TbcMultiRoundMergeLimits,
  TbcMultiRoundMergeProgress,
  TbcMultiRoundMergeResult,
} from "./multi-round-merge.js";
import {
  signIn as signInWithProvider,
  type TbcMessageSignatureResult,
  type TbcSignInInput,
  type TbcSignInResult,
} from "./sign-in.js";
import {
  TransferVerificationError,
  createTransferVerifier,
  type CreateTransferVerifierOptions,
  type TransferVerificationResult,
  type VerifyTransferInput,
} from "./receipt-verification.js";
import type {
  WorkflowSendResult,
} from "./core-runtime.js";

export type TbcWorkflowSendResult = WorkflowSendResult;

export type Tbc721MintJobInput = Omit<Tbc721StandardBatchMintIntent, "type" | "version"> &
  Readonly<{ limits: TbcNftMintJobLimits; constraints?: never }>;
export type Tbc721SingleBatchMintInput = Omit<Tbc721StandardBatchMintIntent, "type" | "version"> &
  Readonly<{ constraints: Readonly<{ maxFee: string; expiresAt: string }>; limits?: never }>;

export type TbcEncodedMessage = Readonly<{
  encoding: "utf8" | "hex" | "base64";
  data: string;
}>;

export interface TbcTypedDataInput {
  readonly domain: Readonly<{
    name: string;
    version?: string;
    chainId: `tbc:${string}`;
    origin?: string;
    verifyingContract?: string;
    salt?: string;
  }>;
  readonly types: Readonly<Record<string, readonly Readonly<{ name: string; type: string }>[]>>;
  readonly primaryType: string;
  readonly message: Readonly<Record<string, unknown>>;
}

export interface TbcWalletBuildInput<TIntent extends KitSupportedIntent = KitSupportedIntent> {
  readonly intent: TIntent;
  readonly signingRoles?: KitTransactionRequest["signingRoles"];
  readonly constraints?: KitTransactionConstraints;
  readonly clientRequestId?: string;
}

export interface TbcWalletProposalInput<TIntent extends KitSupportedIntent = KitSupportedIntent>
  extends TbcWalletBuildInput<TIntent> {
  readonly proposal: TbcPreparedProposal;
}

export type TbcWorkflowOrderedStepResult<TStep extends TbcWorkflowStep> =
  | Readonly<{
      readonly id: TStep["id"];
      readonly kind: TStep["kind"];
      readonly result: unknown;
    }>
  | Readonly<{
      readonly id: TStep["id"];
      readonly kind: TStep["kind"];
      readonly status: "failed" | "skipped";
      readonly error: Readonly<{ readonly code: string; readonly message: string }>;
    }>;

export type TbcWorkflowOrderedResult<
  TSteps extends readonly TbcWorkflowStep[],
> = Readonly<{
  readonly version: "1.0";
  readonly chainId: `tbc:${string}`;
  readonly from: string;
  readonly requestHash: string;
  readonly workflowPlanHash: string;
  readonly approvalId: string;
  readonly failureMode: "atomic" | "continue-independent";
  readonly steps: Readonly<{
    readonly [K in keyof TSteps]: TSteps[K] extends TbcWorkflowStep
      ? TbcWorkflowOrderedStepResult<TSteps[K]>
      : never;
  }>;
  readonly totalFee: string;
}>;

export interface TbcDappMultiRoundMergeInput {
  readonly asset: TbcMultiRoundMergeAsset;
  readonly limits: TbcMultiRoundMergeLimits;
  readonly clientRequestId?: string;
}

/** A terminal immutable trace. Multi-transaction submission is never atomic. */
export type TbcDappMultiRoundMergeResult = TbcMultiRoundMergeResult & Readonly<{
  readonly atomic: false;
  readonly progress: readonly TbcMultiRoundMergeProgress[];
}>;

export interface CreateTbcClientOptions {
  readonly network: `tbc:${string}` | "mainnet" | "testnet";
  readonly provider?: KitProvider;
  readonly walletCatalog?: readonly KitWalletCatalogEntry[];
  readonly requestIdFactory?: () => string;
  /** HTTP chain API only. RPC configuration remains separate and is never guessed. */
  readonly api?: Omit<CreateTransferVerifierOptions, "network">;
  /** Optional existing Native/WASM instance for local read-only material decoding. */
  readonly materialEngine?: CreateTbc721ReaderOptions["engine"];
}

export interface TbcConnectOptions {
  /** Bind the exact discovered wallet/provider instance selected by the user. */
  readonly wallet?: KitWalletDescriptor;
  /** Legacy convenience only. It fails when more than one discovered wallet has this name. */
  readonly walletName?: string;
  readonly account?: string;
}

type IntentInput<T> = T extends unknown ? Omit<T, "type" | "version"> : never;
type HtlcSpendInput = Readonly<{ inputOutpoints: NonNullable<KitTransactionConstraints["inputOutpoints"]>;
  assetStandard?: never; contractId?: never; targetOutpoints?: never; constraints?: Omit<KitTransactionConstraints, "inputOutpoints"> }> |
  (HtlcTokenTarget & Readonly<{ inputOutpoints?: never; constraints?: KitTransactionConstraints }>);
type Tbc20TransferInput = IntentInput<Tbc20StandardTransferIntent>;

export interface TbcConnectedWallet {
  readonly provider: KitProvider;
  readonly account: string;
  readonly chainId: `tbc:${string}`;
  readonly request: <T = unknown>(method: string, params?: unknown) => Promise<T>;
  readonly signMessage: (input: Readonly<{
    message: TbcEncodedMessage;
    clientRequestId?: string;
  }>) => Promise<TbcMessageSignatureResult>;
  readonly signTypedData: (input: Readonly<{
    data: TbcTypedDataInput;
    clientRequestId?: string;
  }>) => Promise<unknown>;
  readonly signIn: (
    input: Omit<TbcSignInInput, "provider" | "chainId" | "address">,
  ) => Promise<TbcSignInResult>;
  readonly send: <TIntent extends KitSupportedIntent>(
    intent: TIntent,
    options?: Readonly<{
      constraints?: KitTransactionConstraints;
      clientRequestId?: string;
      broadcast?: boolean;
      signingRoles?: KitTransactionRequest["signingRoles"];
    }>,
  ) => Promise<unknown>;
  /** Canonical native-asset business entry. Uses the existing generic Provider channel. */
  readonly tbc: Readonly<{
    transfer: (input: Omit<TbcTransferIntent, "type" | "version"> & Readonly<{ constraints?: KitTransactionConstraints }>) => Promise<unknown>;
    merge: (input?: Readonly<{ constraints?: KitTransactionConstraints }>) => Promise<unknown>;
  }>;
  /** @deprecated Use tbc.transfer. This is the same function, not a fallback path. */
  readonly sendTbc: (
    input: Omit<TbcTransferIntent, "type" | "version"> & Readonly<{ constraints?: KitTransactionConstraints }>,
  ) => Promise<unknown>;
  /** Latest issuance; holder operations resolve supported templates from bound material. */
  readonly tbc20: Readonly<{
    create: (input: Omit<Tbc20StandardCreateIntent, "type" | "version"> & Readonly<{ constraints?: KitTransactionConstraints }>) => Promise<unknown>;
    transfer: (input: IntentInput<Tbc20TransferIntent> & Readonly<{ constraints?: KitTransactionConstraints }>) => Promise<unknown>;
    merge: (input: IntentInput<Tbc20MergeIntent> & Readonly<{ constraints?: KitTransactionConstraints }>) => Promise<unknown>;
  }>;
  /** Latest administration, shared current/historical holder operations; no mint fallback. */
  readonly tbc20Stablecoin: Readonly<Pick<TbcConnectedWallet["coin"], "create" | "mint" | "freeze" | "unfreeze"> & {
    transfer: (input: IntentInput<Tbc20StablecoinTransferIntent> & Readonly<{ constraints?: KitTransactionConstraints }>) => Promise<unknown>;
    merge: (input: IntentInput<Tbc20StablecoinMergeIntent> & Readonly<{ constraints?: KitTransactionConstraints }>) => Promise<unknown>;
  }>;
  /** @deprecated Use tbc20.create. Both names reference the same implementation. */
  readonly createTbc20: (input: Omit<Tbc20StandardCreateIntent, "type" | "version"> & Readonly<{ constraints?: KitTransactionConstraints }>) => Promise<unknown>;
  readonly transferTbc20: (input: Tbc20TransferInput & Readonly<{ constraints?: KitTransactionConstraints }>) => Promise<unknown>;
  readonly mergeTbc20: (input: Omit<Tbc20StandardMergeIntent, "type" | "version"> & Readonly<{ constraints?: KitTransactionConstraints }>) => Promise<unknown>;
  readonly coin: Readonly<{
    mint: (input: Omit<CoinMintIntent, "type" | "version"> & Readonly<{ constraints?: KitTransactionConstraints; signingRoles?: KitTransactionRequest["signingRoles"] }>) => Promise<unknown>;
    freeze: (input: Omit<CoinFreezeIntent, "type" | "version"> & Readonly<{ constraints?: KitTransactionConstraints; signingRoles?: KitTransactionRequest["signingRoles"] }>) => Promise<unknown>;
    unfreeze: (input: Omit<CoinUnfreezeIntent, "type" | "version"> & Readonly<{ constraints?: KitTransactionConstraints; signingRoles?: KitTransactionRequest["signingRoles"] }>) => Promise<unknown>;
    create: (input: Omit<CoinCreateIntent, "type" | "version"> & Readonly<{ constraints?: KitTransactionConstraints; signingRoles?: KitTransactionRequest["signingRoles"] }>) => Promise<unknown>;
    transfer: (input: IntentInput<CoinTransferIntent> & Readonly<{ constraints?: KitTransactionConstraints }>) => Promise<unknown>;
    merge: (input: Omit<CoinMergeIntent, "type" | "version"> & Readonly<{ constraints?: KitTransactionConstraints }>) => Promise<unknown>;
  }>;
  /** Latest creation and shared current/historical business routing. */
  readonly amm: Readonly<{
    create: (input: IntentInput<AmmCreateIntent> & Readonly<{ constraints?: KitTransactionConstraints }>) => Promise<unknown>;
    addLiquidity: (input: IntentInput<UnifiedAmmAddLiquidityIntent> & Readonly<{ constraints?: KitTransactionConstraints; signingRoles?: KitTransactionRequest["signingRoles"] }>) => Promise<unknown>;
    removeLiquidity: (input: IntentInput<UnifiedAmmRemoveLiquidityIntent> & Readonly<{ constraints?: KitTransactionConstraints; signingRoles?: KitTransactionRequest["signingRoles"] }>) => Promise<unknown>;
    swap: (input: IntentInput<UnifiedAmmSwapIntent> & Readonly<{ constraints?: KitTransactionConstraints; signingRoles?: KitTransactionRequest["signingRoles"] }>) => Promise<unknown>;
    mergeToken: (input: IntentInput<UnifiedPoolMaintenanceIntent> & Readonly<{ constraints?: KitTransactionConstraints }>) => Promise<unknown>;
  }>;
  readonly timelock: Readonly<{
    lock: (input: IntentInput<TimelockLockIntent> & Readonly<{ constraints?: KitTransactionConstraints }>) => Promise<unknown>;
    unlock: (input: Readonly<{ inputOutpoints: NonNullable<KitTransactionConstraints["inputOutpoints"]>; constraints?: Omit<KitTransactionConstraints, "inputOutpoints"> }>) => Promise<unknown>;
  }>;
  readonly lop: Readonly<{
    create: (input: IntentInput<LopCreateIntent> & Readonly<{ constraints?: KitTransactionConstraints }>) => Promise<unknown>;
    cancel: (input: IntentInput<LopCancelIntent> & Readonly<{ constraints?: KitTransactionConstraints }>) => Promise<unknown>;
    match: (input: IntentInput<LopMatchIntent> & Readonly<{ constraints?: KitTransactionConstraints }>) => Promise<unknown>;
  }>;
  /** Native TBC or an explicitly identified TBC20/Coin HTLC. */
  readonly htlc: Readonly<{
    lock: (input: IntentInput<HtlcLockIntent> & Readonly<{ constraints?: KitTransactionConstraints }>) => Promise<unknown>;
    /** The signed transaction discloses this preimage, even before broadcast. */
    claim: (input: HtlcSpendInput & Readonly<{ preimage: string }>) => Promise<unknown>;
    refund: (input: HtlcSpendInput) => Promise<unknown>;
  }>;
  readonly tbc20Lp: Readonly<{
    transfer: (input: IntentInput<UnifiedLpTransferIntent> & Readonly<{ constraints?: KitTransactionConstraints }>) => Promise<unknown>;
    lock: (input: IntentInput<UnifiedLpLockIntent> & Readonly<{ constraints?: KitTransactionConstraints }>) => Promise<unknown>;
    merge: (input: IntentInput<UnifiedPoolMaintenanceIntent> & Readonly<{ constraints?: KitTransactionConstraints }>) => Promise<unknown>;
    unlock: (input: IntentInput<UnifiedPoolMaintenanceIntent> & Readonly<{ constraints?: KitTransactionConstraints }>) => Promise<unknown>;
    burn: (input: IntentInput<UnifiedPoolMaintenanceIntent> & Readonly<{ constraints?: KitTransactionConstraints }>) => Promise<unknown>;
  }>;
  /** @deprecated Explicit current-template helpers; use tbc20Lp for shared routing. */
  readonly lp: Readonly<{
    transfer: (input: IntentInput<LpTransferIntent> & Readonly<{ constraints?: KitTransactionConstraints }>) => Promise<unknown>;
    lock: (input: IntentInput<LpLockIntent> & Readonly<{ constraints?: KitTransactionConstraints }>) => Promise<unknown>;
    merge: (input: IntentInput<LpMaintenanceIntent> & Readonly<{ constraints?: KitTransactionConstraints }>) => Promise<unknown>;
    unlock: (input: IntentInput<LpMaintenanceIntent> & Readonly<{ constraints?: KitTransactionConstraints }>) => Promise<unknown>;
  }>;
  /** Latest issuance; transfer resolves supported current/historical NFT material. */
  readonly tbc721: Readonly<{
    createCollection: (input: Omit<Tbc721StandardCollectionIntent, "type" | "version"> & Readonly<{ constraints?: KitTransactionConstraints }>) => Promise<unknown>;
    mint: (input: Omit<Tbc721StandardMintIntent, "type" | "version"> & Readonly<{ constraints?: KitTransactionConstraints }>) => Promise<unknown>;
    /** Add job limits for automatic resource-bounded sub-batches and one whole-job approval. */
    batchMint: {
      (input: Tbc721MintJobInput, options?: KitRequestOptions): Promise<TbcNftMintJobResult>;
      (input: Tbc721SingleBatchMintInput, options?: KitRequestOptions): Promise<TbcNftMintJobResult>;
    };
    transfer: (input: Omit<Tbc721TransferIntent, "type" | "version"> & Readonly<{ constraints?: KitTransactionConstraints }>) => Promise<unknown>;
    batchTransfer: (input: Omit<Tbc721BatchTransferIntent, "type" | "version"> & Readonly<{ constraints?: KitTransactionConstraints }>) => Promise<unknown>;
  }>;
  readonly maintenance: Readonly<{
    /** @deprecated Use tbc.merge. This is the same function, not a fallback path. */
    mergeTbc: (input?: Readonly<{ constraints?: KitTransactionConstraints }>) => Promise<unknown>;
    mergeFt: (input: Omit<FtMergeIntent, "type" | "version"> & Readonly<{ constraints?: KitTransactionConstraints }>) => Promise<unknown>;
    mergeStablecoin: (input: Omit<StablecoinMergeIntent, "type" | "version"> & Readonly<{ constraints?: KitTransactionConstraints }>) => Promise<unknown>;
    mergePoolFt: (input: Omit<Extract<PoolMergeIntent, { type: "tbc.pool.ft.merge" }>, "type" | "version"> & Readonly<{ constraints?: KitTransactionConstraints }>) => Promise<unknown>;
    mergeFtlp: (input: Omit<Extract<PoolMergeIntent, { type: "tbc.pool.ftlp.merge" }>, "type" | "version"> & Readonly<{ constraints?: KitTransactionConstraints }>) => Promise<unknown>;
    burnFtlp: (input: Omit<PoolFtlpBurnIntent, "type" | "version"> & Readonly<{ constraints?: KitTransactionConstraints }>) => Promise<unknown>;
    multiRoundMerge: (
      input: TbcDappMultiRoundMergeInput,
      options?: KitRequestOptions,
    ) => Promise<TbcDappMultiRoundMergeResult>;
  }>;
  readonly walletBuild: Readonly<{
    sign: <TIntent extends KitSupportedIntent>(input: TbcWalletBuildInput<TIntent>) => Promise<unknown>;
    send: <TIntent extends KitSupportedIntent>(input: TbcWalletBuildInput<TIntent>) => Promise<unknown>;
    signWorkflow: <const TSteps extends readonly TbcWorkflowStep[]>(
      input: TbcWorkflowComposition<TSteps>,
    ) => Promise<TbcWorkflowOrderedResult<TSteps>>;
    sendWorkflow: <const TSteps extends readonly TbcWorkflowStep[]>(
      input: TbcWorkflowComposition<TSteps>,
    ) => Promise<TbcWorkflowSendResult>;
  }>;
  readonly wallet: Readonly<{
    signProposal: <TIntent extends KitSupportedIntent>(input: TbcWalletProposalInput<TIntent>) => Promise<unknown>;
    sendProposal: <TIntent extends KitSupportedIntent>(input: TbcWalletProposalInput<TIntent>) => Promise<unknown>;
    signPreparedWorkflow: (
      input: Omit<TbcPreparedWorkflowRequest, "version" | "chainId" | "from">,
    ) => Promise<unknown>;
    sendPreparedWorkflow: (
      input: Omit<TbcPreparedWorkflowRequest, "version" | "chainId" | "from">,
    ) => Promise<TbcWorkflowSendResult>;
    signReviewedTransaction: (input: Readonly<{
      request: TbcReviewedTransactionInput;
      clientRequestId?: string;
    }>) => Promise<unknown>;
  }>;
  readonly crypto: Readonly<{
    encrypt: (input: Readonly<{
      message: TbcEncodedMessage;
      clientRequestId?: string;
    }>) => Promise<unknown>;
    decrypt: (input: Readonly<{
      ciphertext: string;
      clientRequestId?: string;
    }>) => Promise<unknown>;
  }>;
  readonly ft: Readonly<{
    create: (input: Omit<FtCreateIntent, "type" | "version"> & Readonly<{ constraints?: KitTransactionConstraints }>) => Promise<unknown>;
    transfer: (input: Omit<FtTransferIntent, "type" | "version"> & Readonly<{ constraints?: KitTransactionConstraints }>) => Promise<unknown>;
  }>;
  readonly stablecoin: Readonly<{
    transfer: (input: Omit<StablecoinTransferIntent, "type" | "version"> & Readonly<{ constraints?: KitTransactionConstraints }>) => Promise<unknown>;
  }>;
  readonly collection: Readonly<{
    create: (input: Omit<CollectionCreateIntent, "type" | "version"> & Readonly<{ constraints?: KitTransactionConstraints }>) => Promise<unknown>;
  }>;
  readonly nft: Readonly<{
    mint: (input: Omit<NftMintIntent, "type" | "version"> & Readonly<{ constraints?: KitTransactionConstraints }>) => Promise<unknown>;
    transfer: (input: Omit<NftTransferIntent, "type" | "version"> & Readonly<{ constraints?: KitTransactionConstraints }>) => Promise<unknown>;
  }>;
  readonly pool: Readonly<{
    create: (input: Omit<PoolCreateIntent, "type" | "version"> & Readonly<{ constraints?: KitTransactionConstraints }>) => Promise<unknown>;
    buy: (input: Omit<Extract<PoolSwapIntent, { type: "tbc.pool.swap.exactTbcForToken" }>, "type" | "version"> & Readonly<{ constraints: KitExpiringTransactionConstraints }>) => Promise<unknown>;
    sell: (input: Omit<Extract<PoolSwapIntent, { type: "tbc.pool.swap.exactTokenForTbc" }>, "type" | "version"> & Readonly<{ constraints: KitExpiringTransactionConstraints }>) => Promise<unknown>;
    addLiquidity: (input: Omit<Extract<PoolLiquidityIntent, { type: "tbc.pool.liquidity.add" }>, "type" | "version"> & Readonly<{ constraints?: KitTransactionConstraints }>) => Promise<unknown>;
    removeLiquidity: (input: Omit<Extract<PoolLiquidityIntent, { type: "tbc.pool.liquidity.remove" }>, "type" | "version"> & Readonly<{ constraints?: KitTransactionConstraints }>) => Promise<unknown>;
  }>;
}

export interface TbcClient {
  readonly verifyTransfer: (input: VerifyTransferInput) => Promise<TransferVerificationResult>;
  /** Public chain query, no wallet connection or permission required. */
  readonly timelock: TimelockReader;
  readonly tbc721: Tbc721Reader;
  readonly wallets: () => readonly KitWalletDescriptor[];
  readonly subscribeWallets: (listener: (wallets: readonly KitWalletDescriptor[]) => void) => () => void;
  readonly walletOptions: () => readonly KitWalletOption[];
  readonly subscribeWalletOptions: (listener: (wallets: readonly KitWalletOption[]) => void) => () => void;
  readonly connect: (options?: TbcConnectOptions) => Promise<TbcConnectedWallet>;
}

interface TbcDiscoveredWallet {
  readonly name: string;
  readonly icon: `data:${string}`;
  readonly accounts: readonly Readonly<{
    address: string;
    publicKey: ArrayLike<number>;
    chains: readonly string[];
  }>[];
  readonly features: Readonly<{
    "tbc:provider": Readonly<{
      productId?: string;
      provider: unknown;
    }>;
  }>;
}

interface TbcWalletDiscoveryAdapter {
  readonly get: () => readonly TbcDiscoveredWallet[];
  readonly subscribe: (listener: () => void) => () => void;
}

const NO_BROWSER_WALLET_DISCOVERY: TbcWalletDiscoveryAdapter = Object.freeze({
  get: () => Object.freeze([]),
  subscribe: () => () => undefined,
});

const CHAIN_IDS = Object.freeze({
  mainnet: "tbc:mainnet",
  testnet: "tbc:testnet",
} as const);

function asProvider(value: unknown): KitProvider {
  if (value === null || typeof value !== "object" || typeof Reflect.get(value, "request") !== "function") {
    throw new TypeError("TBC wallet did not expose a Provider");
  }
  return value as KitProvider;
}

function descriptors(
  discovery: TbcWalletDiscoveryAdapter,
): readonly KitWalletDescriptor[] {
  return Object.freeze(discovery.get().map((wallet) => Object.freeze({
    productId: wallet.features["tbc:provider"].productId,
    name: wallet.name,
    icon: wallet.icon as `data:${string}`,
    provider: asProvider(wallet.features["tbc:provider"].provider),
    accounts: Object.freeze(wallet.accounts.map((account) => Object.freeze({
      address: account.address,
      publicKey: Uint8Array.from(account.publicKey),
      chains: Object.freeze(account.chains.filter((chain): chain is `tbc:${string}` => chain.startsWith("tbc:"))),
    }))),
  })));
}

const PRODUCT_ID = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;
const DATA_IMAGE = /^data:image\/(?:gif|png|svg\+xml|webp);base64,/;

function catalogEntry(value: KitWalletCatalogEntry): KitWalletCatalogEntry {
  if (value === null || typeof value !== "object") throw new TypeError("Invalid wallet catalog entry");
  if (!PRODUCT_ID.test(value.productId)) throw new TypeError("Invalid wallet catalog productId");
  if (typeof value.name !== "string" || value.name.trim().length === 0) throw new TypeError("Invalid wallet catalog name");
  if (typeof value.icon !== "string" || !DATA_IMAGE.test(value.icon)) throw new TypeError("Invalid wallet catalog icon");
  for (const [field, url] of [["homepageUrl", value.homepageUrl], ["installUrl", value.installUrl]] as const) {
    if (url === undefined) continue;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new TypeError(`Invalid wallet catalog ${field}`);
    }
    if (parsed.protocol !== "https:") throw new TypeError(`Wallet catalog ${field} must use HTTPS`);
  }
  return Object.freeze({
    productId: value.productId,
    name: value.name,
    icon: value.icon,
    ...(value.homepageUrl === undefined ? {} : { homepageUrl: value.homepageUrl }),
    ...(value.installUrl === undefined ? {} : { installUrl: value.installUrl }),
  });
}

function orderedWorkflowResult<const TSteps extends readonly TbcWorkflowStep[]>(
  steps: TSteps,
  value: unknown,
): TbcWorkflowOrderedResult<TSteps> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Wallet returned an invalid workflow result");
  }
  const results = Reflect.get(value, "steps");
  if (
    !Array.isArray(results) || results.length !== steps.length ||
    results.some((result, index) => {
      const step = steps[index];
      return step === undefined || result === null || typeof result !== "object" || Array.isArray(result) ||
        Reflect.get(result, "id") !== step.id || Reflect.get(result, "kind") !== step.kind;
    })
  ) throw new Error("Wallet workflow result order does not match its composed steps");
  return value as TbcWorkflowOrderedResult<TSteps>;
}

function dappMultiRoundMergeResult(value: unknown): TbcDappMultiRoundMergeResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Wallet returned an invalid multi-round merge result");
  }
  const result = value as Readonly<Record<string, unknown>>;
  const progress = result.progress;
  const steps = result.steps;
  if (
    result.version !== "1.0" || result.atomic !== false ||
    !["complete", "partial", "stopped", "uncertain"].includes(String(result.status)) ||
    typeof result.scopeHash !== "string" || !/^[0-9a-f]{64}$/u.test(result.scopeHash) ||
    !Number.isSafeInteger(result.initialUtxoCount) || !Number.isSafeInteger(result.finalUtxoCount) ||
    typeof result.totalFee !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(result.totalFee) ||
    !Array.isArray(steps) || !Array.isArray(progress) ||
    progress.some((entry) => entry === null || typeof entry !== "object" || Array.isArray(entry))
  ) throw new Error("Wallet returned an invalid multi-round merge result");
  return value as TbcDappMultiRoundMergeResult;
}

export function createTbcClientWithWalletDiscovery(
  options: CreateTbcClientOptions,
  discovery: TbcWalletDiscoveryAdapter,
): TbcClient {
  if (options === null || typeof options !== "object") throw new TypeError("TBC client options are required");
  const chainId = options.network === "mainnet" || options.network === "testnet"
    ? CHAIN_IDS[options.network]
    : options.network;
  if (!/^tbc:[0-9a-z][0-9a-z._:-]{0,127}$/u.test(chainId)) throw new TypeError("Invalid TBC network");
  const receiptNetwork = chainId === CHAIN_IDS.mainnet
    ? "mainnet" as const
    : chainId === CHAIN_IDS.testnet
      ? "testnet" as const
      : undefined;
  const receiptVerifier = receiptNetwork === undefined
    ? undefined
    : createTransferVerifier({
        ...(options.api ?? {}),
        network: receiptNetwork,
      });
  function verifyTransfer(input: VerifyTransferInput): Promise<TransferVerificationResult> {
    if (receiptVerifier === undefined) {
      throw new TransferVerificationError(
        "UNSUPPORTED_NETWORK",
        "Transfer verification requires a built-in TBC mainnet or testnet chain ID",
      );
    }
    return receiptVerifier.verify(input);
  }
  let timelockReader: TimelockReader | undefined;
  const timelock = Object.freeze({ listDeposits(input: ListTimelockDepositsInput) {
    if (receiptNetwork === undefined) throw new TypeError("Timelock queries require a configured mainnet or testnet chain ID");
    timelockReader ??= createTimelockReader({ api: createTbcOfficialApi({
      network: receiptNetwork,
      ...(options.api?.baseUrl === undefined ? {} : { baseUrl: options.api.baseUrl }),
      ...(options.api?.fetch === undefined ? {} : { fetch: options.api.fetch }),
      ...(options.api?.allowedOrigins === undefined ? {} : { allowedOrigins: options.api.allowedOrigins }),
      ...(options.api?.requestTimeoutMs === undefined ? {} : { timeoutMs: options.api.requestTimeoutMs }),
    }) });
    return timelockReader.listDeposits(input);
  } });
  const walletCatalog = Object.freeze((options.walletCatalog ?? []).map(catalogEntry));
  let nftReader: Tbc721Reader | undefined;
  const tbc721 = Object.freeze({ getMintStatus(input: GetTbc721MintStatusInput) {
    if (receiptNetwork === undefined) throw new TypeError("NFT queries require a configured mainnet or testnet chain ID");
    nftReader ??= createTbc721Reader({ engine: options.materialEngine ?? createLazyBundledWasmTbcKeylessEngine(),
      api: createTbcOfficialApi({ network: receiptNetwork,
        ...(options.api?.baseUrl === undefined ? {} : { baseUrl: options.api.baseUrl }),
        ...(options.api?.fetch === undefined ? {} : { fetch: options.api.fetch }),
        ...(options.api?.allowedOrigins === undefined ? {} : { allowedOrigins: options.api.allowedOrigins }),
        ...(options.api?.requestTimeoutMs === undefined ? {} : { timeoutMs: options.api.requestTimeoutMs }),
      }) });
    return nftReader.getMintStatus(input);
  } });
  if (new Set(walletCatalog.map(({ productId }) => productId)).size !== walletCatalog.length) {
    throw new TypeError("Wallet catalog productId values must be unique");
  }
  let sequence = 0;
  const nextRequestId = options.requestIdFactory ?? (() => `kit-${Date.now().toString(36)}-${(++sequence).toString(36)}`);

  function walletOptions(): readonly KitWalletOption[] {
    const discovered = descriptors(discovery);
    const catalogIds = new Set(walletCatalog.map(({ productId }) => productId));
    const configured: KitWalletOption[] = [];
    for (const catalog of walletCatalog) {
      const matches = discovered.filter(({ productId }) => productId === catalog.productId);
      if (matches.length === 0) {
        configured.push(Object.freeze({
          status: "not-detected" as const,
          productId: catalog.productId,
          catalog,
          wallet: undefined,
        }));
        continue;
      }
      for (const wallet of matches) {
        configured.push(Object.freeze({
          status: "detected" as const,
          productId: wallet.productId,
          catalog,
          wallet,
        }));
      }
    }
    const unconfigured: KitWalletOption[] = discovered
      .filter(({ productId }) => productId === undefined || !catalogIds.has(productId))
      .map((wallet) => Object.freeze({
        status: "detected" as const,
        productId: wallet.productId,
        catalog: undefined,
        wallet,
      }));
    return Object.freeze([...configured, ...unconfigured]);
  }

  async function connect(connectOptions: TbcConnectOptions = {}): Promise<TbcConnectedWallet> {
    const discovered = descriptors(discovery);
    if (connectOptions.wallet !== undefined && connectOptions.walletName !== undefined) {
      throw new TypeError("Select a wallet descriptor or walletName, not both");
    }
    if (options.provider !== undefined && (connectOptions.wallet !== undefined || connectOptions.walletName !== undefined)) {
      throw new TypeError("A client with an explicit provider cannot select a discovered wallet");
    }
    let selected: KitWalletDescriptor | undefined;
    if (options.provider === undefined) {
      if (connectOptions.wallet !== undefined) {
        selected = connectOptions.wallet;
      } else if (connectOptions.walletName !== undefined) {
        const matches = discovered.filter((wallet) => wallet.name === connectOptions.walletName);
        if (matches.length > 1) throw new Error("Multiple TBC wallets have this display name; select a wallet descriptor");
        selected = matches[0];
      } else if (discovered.length === 1) {
        selected = discovered[0];
      } else if (discovered.length > 1) {
        throw new Error("Multiple TBC wallets are available; select a wallet descriptor");
      }
    }
    const provider = options.provider ?? selected?.provider;
    if (provider === undefined) throw new Error("No compatible TBC wallet is available");
    const accounts = await provider.request<readonly string[]>({ method: "tbc_requestAccounts" });
    const account = connectOptions.account ?? accounts[0];
    if (account === undefined || !accounts.includes(account)) throw new Error("The requested TBC account was not authorized");

    const request = <T = unknown>(method: string, params?: unknown) => provider.request<T>({ method, ...(params === undefined ? {} : { params }) });
    const send = async <TIntent extends KitSupportedIntent>(intent: TIntent, sendOptions: Readonly<{
      constraints?: KitTransactionConstraints;
      clientRequestId?: string;
      broadcast?: boolean;
      signingRoles?: KitTransactionRequest["signingRoles"];
    }> = {}) => {
      const transaction: KitTransactionRequest<TIntent> = Object.freeze({
        version: "1.0",
        chainId,
        from: account,
        clientRequestId: sendOptions.clientRequestId ?? nextRequestId(),
        intent: Object.freeze(intent),
        ...(sendOptions.signingRoles === undefined ? {} : { signingRoles: sendOptions.signingRoles }),
        ...(sendOptions.constraints === undefined ? {} : { constraints: Object.freeze(sendOptions.constraints) }),
      });
      return request(sendOptions.broadcast === false ? "tbc_signTransaction" : "tbc_sendTransaction", transaction);
    };
    const split = <T extends object>(input: T & Readonly<{ constraints?: KitTransactionConstraints }>) => {
      const { constraints, ...intent } = input;
      return { intent, constraints };
    };
    function batchMint(input: Tbc721MintJobInput, requestOptions?: KitRequestOptions): Promise<TbcNftMintJobResult>;
    function batchMint(input: Tbc721SingleBatchMintInput, requestOptions?: KitRequestOptions): Promise<TbcNftMintJobResult>;
    function batchMint(input: Tbc721MintJobInput | Tbc721SingleBatchMintInput, requestOptions?: KitRequestOptions): Promise<TbcNftMintJobResult> {
      const invalid = (message: string): never => { throw Object.assign(new TypeError(message), { code: -32602 }); };
      if (!input || Object.keys(input).some(k => !["collectionId", "items", "limits", "constraints"].includes(k))) {
        return invalid("Unknown NFT batch field");
      }
      if (input.limits !== undefined && input.constraints !== undefined) return invalid("Use whole-job limits, not per-batch constraints");
      const constraints = input.constraints;
      if (constraints !== undefined && (!constraints || Object.keys(constraints).some(k => !["maxFee", "expiresAt"].includes(k)))) {
        return invalid("NFT job constraints support only whole-job maxFee and expiresAt; exact inputs and feePreference are not silently ignored");
      }
      const limits = input.limits ?? (constraints && typeof constraints.maxFee === "string" && typeof constraints.expiresAt === "string"
        ? { maxTotalFee: constraints.maxFee, expiresAt: constraints.expiresAt } : undefined);
      if (!limits) return invalid("NFT batchMint requires whole-job limits.maxTotalFee and limits.expiresAt (or constraints.maxFee and constraints.expiresAt)");
      // Every public batch size uses one bounded consent and the same executor.
      // Never invent a fee allowance/deadline or fall back to a monolithic send.
      return provider!.request({ method: "tbc_runNftMintJob", params: {
        version: "1.0", chainId, from: account, collectionId: input.collectionId, items: input.items, limits,
      } }, requestOptions);
    }
    const splitPoolSwap = <T extends object>(input: T & Readonly<{ constraints?: KitTransactionConstraints }>) => {
      const separated = split(input);
      if (
        separated.constraints === undefined ||
        typeof separated.constraints.expiresAt !== "string" ||
        separated.constraints.expiresAt.length === 0
      ) {
        throw new TypeError("Pool swap constraints.expiresAt is required");
      }
      const expiryText = separated.constraints.expiresAt;
      const expiry = parseProtocolTimestamp(expiryText);
      if (expiry <= Date.now()) {
        throw new TypeError("Pool swap constraints.expiresAt must be a future UTC time with second or millisecond precision");
      }
      return {
        intent: separated.intent,
        constraints: separated.constraints as KitExpiringTransactionConstraints,
      };
    };
    const prepared = <TIntent extends KitSupportedIntent>(
      method: "tbc_signPreparedTransaction" | "tbc_sendPreparedTransaction",
      input: TbcWalletProposalInput<TIntent>,
    ) => request(method, Object.freeze({
      version: "1.0",
      chainId,
      from: account,
      clientRequestId: input.clientRequestId ?? nextRequestId(),
      intent: Object.freeze(input.intent),
      proposal: input.proposal,
      ...(input.signingRoles === undefined ? {} : { signingRoles: input.signingRoles }),
      ...(input.constraints === undefined ? {} : { constraints: Object.freeze(input.constraints) }),
    }));
    const tbc: TbcConnectedWallet["tbc"] = Object.freeze({
      transfer(input: Parameters<TbcConnectedWallet["tbc"]["transfer"]>[0]) {
        const { intent, constraints } = split(input);
        return send({ ...intent, type: "tbc.transfer", version: "1.0" } as TbcTransferIntent,
          constraints === undefined ? {} : { constraints });
      },
      merge(input: Parameters<TbcConnectedWallet["tbc"]["merge"]>[0] = {}) {
        const { intent, constraints } = split(input);
        return send({ ...intent, type: "tbc.maintenance.merge", version: "1.0" } as TbcMergeIntent,
          constraints === undefined ? {} : { constraints });
      },
    });
    const tbc20: TbcConnectedWallet["tbc20"] = Object.freeze({
      transfer(input: Parameters<TbcConnectedWallet["tbc20"]["transfer"]>[0]) {
        const { intent, constraints } = split(input);
        return send({ ...intent, type: "tbc20.transfer", version: "1.0" } as Tbc20TransferIntent,
          constraints === undefined ? {} : { constraints });
      },
      merge(input: Parameters<TbcConnectedWallet["tbc20"]["merge"]>[0]) {
        const { intent, constraints } = split(input);
        return send({ ...intent, type: "tbc20.merge", version: "1.0" } as Tbc20MergeIntent,
          constraints === undefined ? {} : { constraints });
      },
      create(input: Parameters<TbcConnectedWallet["tbc20"]["create"]>[0]) {
        const { intent, constraints } = split(input);
        return send({ ...intent, type: "tbc20-standard-create", version: "1.0" } as Tbc20StandardCreateIntent,
          constraints === undefined ? {} : { constraints });
      },
    });
    const tbc20Stablecoin: TbcConnectedWallet["tbc20Stablecoin"] = Object.freeze({
      transfer(input: Parameters<TbcConnectedWallet["tbc20Stablecoin"]["transfer"]>[0]) {
        const { intent, constraints } = split(input);
        return send({ ...intent, type: "tbc20Stablecoin.transfer", version: "1.0" } as Tbc20StablecoinTransferIntent,
          constraints === undefined ? {} : { constraints });
      },
      merge(input: Parameters<TbcConnectedWallet["tbc20Stablecoin"]["merge"]>[0]) {
        const { intent, constraints } = split(input);
        return send({ ...intent, type: "tbc20Stablecoin.merge", version: "1.0" } as Tbc20StablecoinMergeIntent,
          constraints === undefined ? {} : { constraints });
      },
      create(input: Parameters<TbcConnectedWallet["coin"]["create"]>[0]) {
        const { constraints, signingRoles, ...intent } = input;
        return send({ ...intent, type: "tbc20-stablecoin-create", version: "1.0" } as CoinCreateIntent, {
          ...(constraints === undefined ? {} : { constraints }), ...(signingRoles === undefined ? {} : { signingRoles }) });
      },
      mint(input: Parameters<TbcConnectedWallet["coin"]["mint"]>[0]) {
        const { constraints, signingRoles, ...intent } = input;
        return send({ ...intent, type: "tbc20-stablecoin-mint", version: "1.0" }, {
          ...(constraints === undefined ? {} : { constraints }), ...(signingRoles === undefined ? {} : { signingRoles }) });
      },
      freeze(input: Parameters<TbcConnectedWallet["coin"]["freeze"]>[0]) {
        const { constraints, signingRoles, ...intent } = input;
        return send({ ...intent, type: "tbc20-stablecoin-freeze", version: "1.0" }, {
          ...(constraints === undefined ? {} : { constraints }), ...(signingRoles === undefined ? {} : { signingRoles }) });
      },
      unfreeze(input: Parameters<TbcConnectedWallet["coin"]["unfreeze"]>[0]) {
        const { constraints, signingRoles, ...intent } = input;
        return send({ ...intent, type: "tbc20-stablecoin-unfreeze", version: "1.0" }, {
          ...(constraints === undefined ? {} : { constraints }), ...(signingRoles === undefined ? {} : { signingRoles }) });
      },
    });
    return Object.freeze({
      provider,
      account,
      chainId,
      request,
      signMessage(input: Readonly<{ message: TbcEncodedMessage; clientRequestId?: string }>) {
        return request<TbcMessageSignatureResult>("tbc_signMessage", Object.freeze({
          version: "1.0",
          chainId,
          from: account,
          message: Object.freeze(input.message),
          ...(input.clientRequestId === undefined ? {} : { clientRequestId: input.clientRequestId }),
        }));
      },
      signTypedData(input: Readonly<{ data: TbcTypedDataInput; clientRequestId?: string }>) {
        return request("tbc_signTypedData", Object.freeze({
          version: "1.0",
          chainId,
          from: account,
          data: Object.freeze(input.data),
          ...(input.clientRequestId === undefined ? {} : { clientRequestId: input.clientRequestId }),
        }));
      },
      signIn(input: Omit<TbcSignInInput, "provider" | "chainId" | "address">) {
        return signInWithProvider({ ...input, provider, chainId, address: account });
      },
      send,
      walletBuild: Object.freeze({
        sign<TIntent extends KitSupportedIntent>(input: TbcWalletBuildInput<TIntent>) {
          return send(input.intent, {
            broadcast: false,
            ...(input.signingRoles === undefined ? {} : { signingRoles: input.signingRoles }),
            ...(input.constraints === undefined ? {} : { constraints: input.constraints }),
            ...(input.clientRequestId === undefined ? {} : { clientRequestId: input.clientRequestId }),
          });
        },
        send<TIntent extends KitSupportedIntent>(input: TbcWalletBuildInput<TIntent>) {
          return send(input.intent, {
            broadcast: true,
            ...(input.signingRoles === undefined ? {} : { signingRoles: input.signingRoles }),
            ...(input.constraints === undefined ? {} : { constraints: input.constraints }),
            ...(input.clientRequestId === undefined ? {} : { clientRequestId: input.clientRequestId }),
          });
        },
        async signWorkflow<const TSteps extends readonly TbcWorkflowStep[]>(
          input: TbcWorkflowComposition<TSteps>,
        ) {
          const result = await request("tbc_signWorkflow", Object.freeze({
            version: "1.0",
            chainId,
            from: account,
            ...input,
          }));
          return orderedWorkflowResult(input.steps, result);
        },
        sendWorkflow<const TSteps extends readonly TbcWorkflowStep[]>(
          input: TbcWorkflowComposition<TSteps>,
        ) {
          return request("tbc_sendWorkflow", Object.freeze({
            version: "1.0",
            chainId,
            from: account,
            ...input,
          })) as Promise<TbcWorkflowSendResult>;
        },
      }),
      wallet: Object.freeze({
        signProposal<TIntent extends KitSupportedIntent>(input: TbcWalletProposalInput<TIntent>) {
          return prepared("tbc_signPreparedTransaction", input);
        },
        sendProposal<TIntent extends KitSupportedIntent>(input: TbcWalletProposalInput<TIntent>) {
          return prepared("tbc_sendPreparedTransaction", input);
        },
        signPreparedWorkflow(
          input: Omit<TbcPreparedWorkflowRequest, "version" | "chainId" | "from">,
        ) {
          return request("tbc_signPreparedWorkflow", Object.freeze({
            version: "1.0",
            chainId,
            from: account,
            ...input,
          }));
        },
        sendPreparedWorkflow(
          input: Omit<TbcPreparedWorkflowRequest, "version" | "chainId" | "from">,
        ) {
          return request("tbc_sendPreparedWorkflow", Object.freeze({
            version: "1.0",
            chainId,
            from: account,
            ...input,
          })) as Promise<TbcWorkflowSendResult>;
        },
        signReviewedTransaction(input: Readonly<{
          request: TbcReviewedTransactionInput;
          clientRequestId?: string;
        }>) {
          return request("tbc_signReviewedTransaction", Object.freeze({
            version: "1.0", chainId, from: account,
            ...(input.clientRequestId === undefined ? {} : { clientRequestId: input.clientRequestId }),
            request: input.request,
          }));
        },
      }),
      crypto: Object.freeze({
        encrypt(input: Readonly<{ message: TbcEncodedMessage; clientRequestId?: string }>) {
          const algorithm: TbcMessageCryptoAlgorithm =
            "tbc-bie1-secp256k1-aes128-cbc-hmac-sha256-v1";
          return request("tbc_encrypt", Object.freeze({
            version: "1.0",
            chainId,
            from: account,
            ...(input.clientRequestId === undefined ? {} : { clientRequestId: input.clientRequestId }),
            algorithm,
            message: Object.freeze(input.message),
          }));
        },
        decrypt(input: Readonly<{ ciphertext: string; clientRequestId?: string }>) {
          const algorithm: TbcMessageCryptoAlgorithm =
            "tbc-bie1-secp256k1-aes128-cbc-hmac-sha256-v1";
          return request("tbc_decrypt", Object.freeze({
            version: "1.0",
            chainId,
            from: account,
            ...(input.clientRequestId === undefined ? {} : { clientRequestId: input.clientRequestId }),
            algorithm,
            ciphertext: input.ciphertext,
          }));
        },
      }),
      tbc,
      sendTbc: tbc.transfer,
      tbc20,
      tbc20Stablecoin,
      createTbc20: tbc20.create,
      transferTbc20(input: Parameters<TbcConnectedWallet["transferTbc20"]>[0]) {
        const { intent, constraints } = split(input);
        return send({ ...intent, type: "tbc20-standard-transfer", version: "1.0" } as Tbc20StandardTransferIntent, constraints === undefined ? {} : { constraints });
      },
      mergeTbc20(input: Parameters<TbcConnectedWallet["mergeTbc20"]>[0]) {
        const { intent, constraints } = split(input);
        return send({ ...intent, type: "tbc20-standard-merge", version: "1.0" } as Tbc20StandardMergeIntent, constraints === undefined ? {} : { constraints });
      },
      amm: Object.freeze({
        create(input: Parameters<TbcConnectedWallet["amm"]["create"]>[0]) {
          const { constraints, ...intent } = input;
          return send({ ...intent, type: "tbc-amm-create", version: "1.0" }, constraints === undefined ? {} : { constraints });
        },
        addLiquidity(input: Parameters<TbcConnectedWallet["amm"]["addLiquidity"]>[0]) {
          const { constraints, signingRoles, ...intent } = input;
          return send({ ...intent, type: "amm.addLiquidity", version: "1.0" }, {
            ...(constraints === undefined ? {} : { constraints }), ...(signingRoles === undefined ? {} : { signingRoles }) });
        },
        removeLiquidity(input: Parameters<TbcConnectedWallet["amm"]["removeLiquidity"]>[0]) {
          const { constraints, signingRoles, ...intent } = input;
          return send({ ...intent, type: "amm.removeLiquidity", version: "1.0" }, {
            ...(constraints === undefined ? {} : { constraints }), ...(signingRoles === undefined ? {} : { signingRoles }) });
        },
        swap(input: Parameters<TbcConnectedWallet["amm"]["swap"]>[0]) {
          const { constraints, signingRoles, ...intent } = input;
          return send({ ...intent, type: "amm.swap", version: "1.0" }, {
            ...(constraints === undefined ? {} : { constraints }), ...(signingRoles === undefined ? {} : { signingRoles }) });
        },
        mergeToken(input: Parameters<TbcConnectedWallet["amm"]["mergeToken"]>[0]) {
          const { constraints, ...intent } = input;
          return send({ ...intent, type: "amm.mergeToken", version: "1.0" }, constraints === undefined ? {} : { constraints });
        },
      }),
      timelock: Object.freeze({
        lock(input: IntentInput<TimelockLockIntent> & Readonly<{ constraints?: KitTransactionConstraints }>) {
          const { constraints, ...intent } = input;
          return send({ ...intent, type: "tbc-timelock-lock", version: "1.0" }, constraints === undefined ? {} : { constraints });
        },
        unlock(input: Readonly<{ inputOutpoints: NonNullable<KitTransactionConstraints["inputOutpoints"]>; constraints?: Omit<KitTransactionConstraints, "inputOutpoints"> }>) {
          return send({ type: "tbc-timelock-unlock", version: "1.0" }, { constraints: { ...input.constraints, inputOutpoints: input.inputOutpoints } });
        },
      }),
      lop: Object.freeze({
        create(input: Parameters<TbcConnectedWallet["lop"]["create"]>[0]) {
          const { constraints, ...intent } = input;
          return send({ ...intent, type: "tbc-lop-create", version: "1.0" }, constraints === undefined ? {} : { constraints });
        },
        cancel(input: Parameters<TbcConnectedWallet["lop"]["cancel"]>[0]) {
          const { constraints, ...intent } = input;
          return send({ ...intent, type: "tbc-lop-cancel", version: "1.0" }, constraints === undefined ? {} : { constraints });
        },
        match(input: Parameters<TbcConnectedWallet["lop"]["match"]>[0]) {
          const { constraints, ...intent } = input;
          return send({ ...intent, type: "tbc-lop-match", version: "1.0" }, constraints === undefined ? {} : { constraints });
        },
      }),
      htlc: Object.freeze({
        lock(input: Parameters<TbcConnectedWallet["htlc"]["lock"]>[0]) {
          const { constraints, ...intent } = input;
          return send({ ...intent, type: "tbc-htlc-lock", version: "1.0" }, constraints === undefined ? {} : { constraints });
        },
        claim(input: Parameters<TbcConnectedWallet["htlc"]["claim"]>[0]) {
          const { constraints, inputOutpoints, ...intent } = input;
          return send({ ...intent, type: "tbc-htlc-claim", version: "1.0" },
            inputOutpoints === undefined ? constraints === undefined ? {} : { constraints }
              : { constraints: { ...constraints, inputOutpoints } });
        },
        refund(input: Parameters<TbcConnectedWallet["htlc"]["refund"]>[0]) {
          const { constraints, inputOutpoints, ...intent } = input;
          return send({ ...intent, type: "tbc-htlc-refund", version: "1.0" },
            inputOutpoints === undefined ? constraints === undefined ? {} : { constraints }
              : { constraints: { ...constraints, inputOutpoints } });
        },
      }),
      tbc20Lp: Object.freeze({
        transfer(input: Parameters<TbcConnectedWallet["tbc20Lp"]["transfer"]>[0]) {
          const { constraints, ...intent } = input;
          return send({ ...intent, type: "tbc20Lp.transfer", version: "1.0" }, constraints === undefined ? {} : { constraints });
        },
        lock(input: Parameters<TbcConnectedWallet["tbc20Lp"]["lock"]>[0]) {
          const { constraints, ...intent } = input;
          return send({ ...intent, type: "tbc20Lp.lock", version: "1.0" }, constraints === undefined ? {} : { constraints });
        },
        merge(input: Parameters<TbcConnectedWallet["tbc20Lp"]["merge"]>[0]) {
          const { constraints, ...intent } = input;
          return send({ ...intent, type: "tbc20Lp.merge", version: "1.0" }, constraints === undefined ? {} : { constraints });
        },
        unlock(input: Parameters<TbcConnectedWallet["tbc20Lp"]["unlock"]>[0]) {
          const { constraints, ...intent } = input;
          return send({ ...intent, type: "tbc20Lp.unlock", version: "1.0" }, constraints === undefined ? {} : { constraints });
        },
        burn(input: Parameters<TbcConnectedWallet["tbc20Lp"]["burn"]>[0]) {
          const { constraints, ...intent } = input;
          return send({ ...intent, type: "tbc20Lp.burn", version: "1.0" }, constraints === undefined ? {} : { constraints });
        },
      }),
      lp: Object.freeze({
        transfer(input: Parameters<TbcConnectedWallet["lp"]["transfer"]>[0]) {
          const { constraints, ...intent } = input;
          return send({ ...intent, type: "tbc20-lp-transfer", version: "1.0" }, constraints === undefined ? {} : { constraints });
        },
        lock(input: Parameters<TbcConnectedWallet["lp"]["lock"]>[0]) {
          const { constraints, ...intent } = input;
          return send({ ...intent, type: "tbc20-lp-lock", version: "1.0" }, constraints === undefined ? {} : { constraints });
        },
        merge(input: Parameters<TbcConnectedWallet["lp"]["merge"]>[0]) {
          const { constraints, ...intent } = input;
          return send({ ...intent, type: "tbc20-lp-merge", version: "1.0" }, constraints === undefined ? {} : { constraints });
        },
        unlock(input: Parameters<TbcConnectedWallet["lp"]["unlock"]>[0]) {
          const { constraints, ...intent } = input;
          return send({ ...intent, type: "tbc20-lp-unlock", version: "1.0" }, constraints === undefined ? {} : { constraints });
        },
      }),
      coin: Object.freeze({
        create: tbc20Stablecoin.create,
        mint: tbc20Stablecoin.mint,
        freeze: tbc20Stablecoin.freeze,
        unfreeze: tbc20Stablecoin.unfreeze,
        transfer(input: Parameters<TbcConnectedWallet["coin"]["transfer"]>[0]) {
          const { constraints, ...intent } = input;
          return send({ ...intent, type: "tbc20-stablecoin-transfer", version: "1.0" } as CoinTransferIntent, constraints === undefined ? {} : { constraints });
        },
        merge(input: Parameters<TbcConnectedWallet["coin"]["merge"]>[0]) {
          const { constraints, ...intent } = input;
          return send({ ...intent, type: "tbc20-stablecoin-merge", version: "1.0" } as CoinMergeIntent, constraints === undefined ? {} : { constraints });
        },
      }),
      tbc721: Object.freeze({
        createCollection(input: Parameters<TbcConnectedWallet["tbc721"]["createCollection"]>[0]) {
          const { intent, constraints } = split(input);
          return send({ ...intent, type: "tbc721-standard-create-collection", version: "1.0" } as Tbc721StandardCollectionIntent, constraints === undefined ? {} : { constraints });
        },
        mint(input: Parameters<TbcConnectedWallet["tbc721"]["mint"]>[0]) {
          const { intent, constraints } = split(input);
          return send({ ...intent, type: "tbc721-standard-mint", version: "1.0" } as Tbc721StandardMintIntent, constraints === undefined ? {} : { constraints });
        },
        batchMint,
        transfer(input: Parameters<TbcConnectedWallet["tbc721"]["transfer"]>[0]) {
          const { intent, constraints } = split(input);
          return send({ ...intent, type: "tbc721.transfer", version: "1.0" } as Tbc721TransferIntent, constraints === undefined ? {} : { constraints });
        },
        batchTransfer(input: Parameters<TbcConnectedWallet["tbc721"]["batchTransfer"]>[0]) {
          const { intent, constraints } = split(input);
          return send({ ...intent, type: "tbc721.batchTransfer", version: "1.0" } as Tbc721BatchTransferIntent, constraints === undefined ? {} : { constraints });
        },
      }),
      maintenance: Object.freeze({
        mergeTbc: tbc.merge,
        mergeFt(input: Parameters<TbcConnectedWallet["maintenance"]["mergeFt"]>[0]) {
          const { intent, constraints } = split(input);
          return send({ type: "tbc.ft.merge", version: "1.0", ...intent } as FtMergeIntent, constraints === undefined ? {} : { constraints });
        },
        mergeStablecoin(input: Parameters<TbcConnectedWallet["maintenance"]["mergeStablecoin"]>[0]) {
          const { intent, constraints } = split(input);
          return send({ type: "tbc.stablecoin.merge", version: "1.0", ...intent } as StablecoinMergeIntent, constraints === undefined ? {} : { constraints });
        },
        mergePoolFt(input: Parameters<TbcConnectedWallet["maintenance"]["mergePoolFt"]>[0]) {
          const { intent, constraints } = split(input);
          return send({ type: "tbc.pool.ft.merge", version: "1.0", ...intent } as Extract<PoolMergeIntent, { type: "tbc.pool.ft.merge" }>, constraints === undefined ? {} : { constraints });
        },
        mergeFtlp(input: Parameters<TbcConnectedWallet["maintenance"]["mergeFtlp"]>[0]) {
          const { intent, constraints } = split(input);
          return send({ type: "tbc.pool.ftlp.merge", version: "1.0", ...intent } as Extract<PoolMergeIntent, { type: "tbc.pool.ftlp.merge" }>, constraints === undefined ? {} : { constraints });
        },
        burnFtlp(input: Parameters<TbcConnectedWallet["maintenance"]["burnFtlp"]>[0]) {
          const { intent, constraints } = split(input);
          return send({ type: "tbc.pool.ftlp.burn", version: "1.0", ...intent } as PoolFtlpBurnIntent, constraints === undefined ? {} : { constraints });
        },
        async multiRoundMerge(
          input: TbcDappMultiRoundMergeInput,
          requestOptions?: KitRequestOptions,
        ) {
          const result = await provider.request({
            method: "tbc_runMultiRoundMerge",
            params: Object.freeze({
              version: "1.0" as const,
              chainId,
              from: account,
              clientRequestId: input.clientRequestId ?? nextRequestId(),
              asset: input.asset,
              limits: input.limits,
            }),
          }, requestOptions);
          return dappMultiRoundMergeResult(result);
        },
      }),
      collection: Object.freeze({
        create(input: Parameters<TbcConnectedWallet["collection"]["create"]>[0]) {
          const { intent, constraints } = split(input);
          return send({ type: "tbc.collection.create", version: "1.0", ...intent } as CollectionCreateIntent, constraints === undefined ? {} : { constraints });
        },
      }),
      nft: Object.freeze({
        mint(input: Parameters<TbcConnectedWallet["nft"]["mint"]>[0]) {
          const { intent, constraints } = split(input);
          return send({ type: "tbc.nft.mint", version: "1.0", ...intent } as NftMintIntent, constraints === undefined ? {} : { constraints });
        },
        transfer(input: Parameters<TbcConnectedWallet["nft"]["transfer"]>[0]) {
          const { intent, constraints } = split(input);
          return send({ type: "tbc.nft.transfer", version: "1.0", ...intent } as NftTransferIntent, constraints === undefined ? {} : { constraints });
        },
      }),
      ft: Object.freeze({
        create(input: Parameters<TbcConnectedWallet["ft"]["create"]>[0]) {
          const { intent, constraints } = split(input);
          return send({ type: "tbc.ft.create", version: "1.0", ...intent } as FtCreateIntent, constraints === undefined ? {} : { constraints });
        },
        transfer(input: Parameters<TbcConnectedWallet["ft"]["transfer"]>[0]) {
          const { intent, constraints } = split(input);
          return send({ type: "tbc.ft.transfer", version: "1.0", ...intent } as FtTransferIntent, constraints === undefined ? {} : { constraints });
        },
      }),
      stablecoin: Object.freeze({
        transfer(input: Parameters<TbcConnectedWallet["stablecoin"]["transfer"]>[0]) {
          const { intent, constraints } = split(input);
          return send({ type: "tbc.stablecoin.transfer", version: "1.0", ...intent } as StablecoinTransferIntent, constraints === undefined ? {} : { constraints });
        },
      }),
      pool: Object.freeze({
        create(input: Parameters<TbcConnectedWallet["pool"]["create"]>[0]) {
          const { intent, constraints } = split(input);
          return send({ type: "tbc.pool.create", version: "1.0", ...intent } as PoolCreateIntent, constraints === undefined ? {} : { constraints });
        },
        buy(input: Parameters<TbcConnectedWallet["pool"]["buy"]>[0]) {
          const { intent, constraints } = splitPoolSwap(input);
          return send({ type: "tbc.pool.swap.exactTbcForToken", version: "1.0", ...intent } as Extract<PoolSwapIntent, { type: "tbc.pool.swap.exactTbcForToken" }>, { constraints });
        },
        sell(input: Parameters<TbcConnectedWallet["pool"]["sell"]>[0]) {
          const { intent, constraints } = splitPoolSwap(input);
          return send({ type: "tbc.pool.swap.exactTokenForTbc", version: "1.0", ...intent } as Extract<PoolSwapIntent, { type: "tbc.pool.swap.exactTokenForTbc" }>, { constraints });
        },
        addLiquidity(input: Parameters<TbcConnectedWallet["pool"]["addLiquidity"]>[0]) {
          const { intent, constraints } = split(input);
          return send({ type: "tbc.pool.liquidity.add", version: "1.0", ...intent } as Extract<PoolLiquidityIntent, { type: "tbc.pool.liquidity.add" }>, constraints === undefined ? {} : { constraints });
        },
        removeLiquidity(input: Parameters<TbcConnectedWallet["pool"]["removeLiquidity"]>[0]) {
          const { intent, constraints } = split(input);
          return send({ type: "tbc.pool.liquidity.remove", version: "1.0", ...intent } as Extract<PoolLiquidityIntent, { type: "tbc.pool.liquidity.remove" }>, constraints === undefined ? {} : { constraints });
        },
      }),
    });
  }

  return Object.freeze({
    verifyTransfer,
    timelock,
    tbc721,
    wallets: () => descriptors(discovery),
    subscribeWallets(listener: (wallets: readonly KitWalletDescriptor[]) => void) {
      if (typeof listener !== "function") throw new TypeError("A wallet listener is required");
      return discovery.subscribe(() => listener(descriptors(discovery)));
    },
    walletOptions,
    subscribeWalletOptions(listener: (wallets: readonly KitWalletOption[]) => void) {
      if (typeof listener !== "function") throw new TypeError("A wallet option listener is required");
      return discovery.subscribe(() => listener(walletOptions()));
    },
    connect,
  });
}

/** React Native-safe client. Browser discovery is supplied by the browser root. */
export function createTbcClient(options: CreateTbcClientOptions): TbcClient {
  return createTbcClientWithWalletDiscovery(options, NO_BROWSER_WALLET_DISCOVERY);
}
import { parseProtocolTimestamp } from "./core-runtime.js";
