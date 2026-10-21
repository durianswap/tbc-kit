export interface KitRequestOptions {
  readonly signal?: AbortSignal;
}

export interface KitProvider {
  readonly request: <T = unknown>(
    request: Readonly<{ method: string; params?: unknown }>,
    options?: KitRequestOptions,
  ) => Promise<T>;
  readonly on: (event: string, listener: (payload: unknown) => void) => void;
  readonly removeListener: (
    event: string,
    listener: (payload: unknown) => void,
  ) => void;
  readonly destroy: () => void;
}

export interface KitTransactionConstraints {
  readonly expiresAt?: string;
  readonly maxFee?: string;
  readonly feePreference?: "economy" | "standard" | "priority";
  /** Optional bounded candidate set. For native transfers the Engine may spend only these outpoints. */
  readonly inputOutpoints?: readonly Readonly<{ readonly txid: string; readonly vout: number }>[];
}

export interface KitExpiringTransactionConstraints extends KitTransactionConstraints {
  readonly expiresAt: string;
}

export interface KitTransactionRequest<TIntent extends object = Record<string, unknown>> {
  readonly version: "1.0";
  readonly chainId: `tbc:${string}`;
  readonly from: string;
  /** Explicit additional contract authority; never grants wallet permission. */
  readonly signingRoles?: readonly Readonly<{ role: "pool-controller" | "coin-admin"; accountId: string }>[];
  readonly clientRequestId?: string;
  readonly intent: TIntent;
  readonly constraints?: KitTransactionConstraints;
}

export type TbcTransferIntent = Readonly<{
  type: "tbc.transfer";
  version: "1.0";
  to: string;
  amount: string;
}>;

export type TbcMergeIntent = Readonly<{
  type: "tbc.maintenance.merge";
  version: "1.0";
}>;

export type FtCreateIntent = Readonly<{
  type: "tbc.ft.create";
  version: "1.0";
  name: string;
  symbol: string;
  decimals: number;
  initialSupply: string;
}>;

/** New TBC20 template; amounts are canonical raw smallest-unit strings. */
export type Tbc20StandardCreateIntent = Readonly<{
  type: "tbc20-standard-create";
  version: "1.0";
  name: string;
  symbol: string;
  decimals: number;
  initialSupply: string;
  to?: string;
}>;

export type Tbc20StandardTransferIntent = Readonly<{
  type: "tbc20-standard-transfer";
  version: "1.0";
  contractId: string;
  /** Separate non-dust native payment in atomic units; not automatic change. */
  payment?: Readonly<{ to: string; amount: string }>;
}> & (
  | Readonly<{ to: string; amount: string; receivers?: never }>
  | Readonly<{ receivers: readonly Readonly<{ to: string; amount: string }>[]; to?: never; amount?: never }>
);

export type Tbc20StandardMergeIntent = Readonly<{
  type: "tbc20-standard-merge";
  version: "1.0";
  contractId: string;
}>;

/** Coin contractId is the official issuer-source asset ID, not a mint txid. */
export type CoinCreateIntent = Readonly<Omit<Tbc20StandardCreateIntent, "type"> & {
  type: "tbc20-stablecoin-create";
}>;
export type CoinTransferIntent = Readonly<{
  type: "tbc20-stablecoin-transfer"; version: "1.0"; contractId: string;
  payment?: Readonly<{ to: string; amount: string }>;
}> & (
  | Readonly<{ to: string; amount: string; receivers?: never }>
  | Readonly<{ receivers: readonly Readonly<{ to: string; amount: string }>[]; to?: never; amount?: never }>
);
export type CoinMergeIntent = Readonly<{
  type: "tbc20-stablecoin-merge"; version: "1.0"; contractId: string;
}>;

/** Shared business intent; the bound template determines supported recipients
 * and native payment combinations. No client-selected contract generation. */
type UnifiedFungibleTransferIntent<T extends string> = Readonly<{
  type: T; version: "1.0"; contractId: string;
  payment?: Readonly<{ to: string; amount: string }>;
}> & (
  | Readonly<{ to: string; amount: string; receivers?: never }>
  | Readonly<{ receivers: readonly Readonly<{ to: string; amount: string }>[]; to?: never; amount?: never }>
);
export type Tbc20TransferIntent = UnifiedFungibleTransferIntent<"tbc20.transfer">;
export type Tbc20StablecoinTransferIntent = UnifiedFungibleTransferIntent<"tbc20Stablecoin.transfer">;
export type Tbc20MergeIntent = Readonly<{ type: "tbc20.merge"; version: "1.0"; contractId: string }>;
export type Tbc20StablecoinMergeIntent = Readonly<{ type: "tbc20Stablecoin.merge"; version: "1.0"; contractId: string }>;

export type CoinMintIntent = Readonly<{
  type: "tbc20-stablecoin-mint"; version: "1.0"; contractId: string;
  /** Optional pin; otherwise Kit resolves and binds the current certificate. */
  certificateOutpoint?: Readonly<{ txid: string; vout: 0 }>;
  amount: string; to: string;
}>;
export type CoinFreezeIntent = Readonly<{
  type: "tbc20-stablecoin-freeze"; version: "1.0"; contractId: string;
  /** Exact Coin targets, distinct from optional whole-transaction input constraints. */
  targetOutpoints: readonly Readonly<{ txid: string; vout: number }>[];
  /** Positive uint32, canonical decimal; absolute height/time, not a duration. */
  lockTime: string;
}>;
export type CoinUnfreezeIntent = Readonly<{
  type: "tbc20-stablecoin-unfreeze"; version: "1.0"; contractId: string;
  targetOutpoints: readonly Readonly<{ txid: string; vout: number }>[];
}>;

export type NftMedia =
  | Readonly<{ kind: "uri"; uri: string; sha256?: string }>
  | Readonly<{ kind: "base64"; mediaType: string; data: string; sha256: string }>;
export type CollectionCreateIntent = Readonly<{
  type: "tbc.collection.create"; version: "1.0";
  name: string; description: string; supply: string; media: NftMedia;
}>;
export type NftMintIntent = Readonly<{
  type: "tbc.nft.mint"; version: "1.0";
  collectionId: string; name: string; symbol: string; description: string;
  attributes: readonly Readonly<{ traitType: string; value: string | number | boolean }>[];
  media?: NftMedia;
}>;
export type NftTransferIntent = Readonly<{
  type: "tbc.nft.transfer"; version: "1.0"; contractId: string; to: string;
}>;

export type Tbc721StandardCollectionIntent = Readonly<Omit<CollectionCreateIntent, "type"> & {
  type: "tbc721-standard-create-collection"; to?: string;
}>;
export type Tbc721StandardMintItem = Readonly<Omit<NftMintIntent, "type" | "version" | "collectionId"> & {
  slot: number; to?: string;
}>;
export type Tbc721StandardMintIntent = Readonly<Tbc721StandardMintItem & {
  type: "tbc721-standard-mint"; version: "1.0"; collectionId: string;
}>;
export type Tbc721StandardBatchMintIntent = Readonly<{
  type: "tbc721-standard-batch-mint"; version: "1.0"; collectionId: string;
  items: readonly Tbc721StandardMintItem[];
}>;
export type Tbc721StandardTransferIntent = Readonly<{
  type: "tbc721-standard-transfer"; version: "1.0"; contractId: string; to: string;
  /** Same-transaction TBC payment in raw atomic units. */
  payment?: Readonly<{ to: string; amount: string }>;
}>;
/** Shared route over supported current/historical NFT material. Not minting. */
export type Tbc721TransferIntent = Readonly<Omit<Tbc721StandardTransferIntent, "type"> & {
  type: "tbc721.transfer";
}>;

export type FtTransferIntent = Readonly<{
  type: "tbc.ft.transfer";
  version: "1.0";
  contractId: string;
}> & (
  | Readonly<{ to: string; amount: string; receivers?: never; attachedTbcAmount?: string }>
  | Readonly<{ receivers: readonly Readonly<{ to: string; amount: string }>[]; to?: never; amount?: never; attachedTbcAmount?: never }>
);

export type FtMergeIntent = Readonly<{
  type: "tbc.ft.merge";
  version: "1.0";
  contractId: string;
}>;

export type StablecoinTransferIntent = Readonly<{
  type: "tbc.stablecoin.transfer";
  version: "1.0";
  contractId: string;
  to: string;
  amount: string;
  attachedTbcAmount?: string;
}>;

export type StablecoinMergeIntent = Readonly<{
  type: "tbc.stablecoin.merge";
  version: "1.0";
  contractId: string;
}>;

export type PoolCreateIntent = Readonly<{
  type: "tbc.pool.create";
  version: "1.0";
  ftContractId?: string;
  poolContractId?: string;
  lpPlan?: number;
  stage?: "mint" | "initialize";
  serviceProviderTag?: string;
  initialLiquidity?: Readonly<{
    receiver: string;
    tbcAmount: string;
    ftAmount: string;
  }>;
  lock?: Readonly<{
    publicKeys: readonly string[];
    costRecipient: string;
    costAmount: string;
    untilHeight?: string;
  }>;
}>;

export type PoolSwapIntent =
  | Readonly<{
      type: "tbc.pool.swap.exactTbcForToken";
      version: "1.0";
      poolContractId: string;
      receiver: string;
      tbcAmount: string;
      minimumFtAmount: string;
    }>
  | Readonly<{
      type: "tbc.pool.swap.exactTokenForTbc";
      version: "1.0";
      poolContractId: string;
      receiver: string;
      ftAmount: string;
      minimumTbcAmount: string;
    }>;

export type PoolLiquidityIntent =
  | Readonly<{
      type: "tbc.pool.liquidity.add";
      version: "1.0";
      poolContractId: string;
      receiver: string;
      tbcAmount: string;
      minimumLpAmount: string;
      lockUntilHeight?: string;
    }>
  | Readonly<{
      type: "tbc.pool.liquidity.remove";
      version: "1.0";
      poolContractId: string;
      receiver: string;
      lpAmount: string;
      minimumTbcAmount: string;
      minimumFtAmount: string;
    }>;

export type PoolMergeIntent =
  | Readonly<{
      type: "tbc.pool.ft.merge";
      version: "1.0";
      poolContractId: string;
    }>
  | Readonly<{
      type: "tbc.pool.ftlp.merge";
      version: "1.0";
      poolContractId: string;
    }>;

export type PoolFtlpBurnIntent = Readonly<{
  type: "tbc.pool.ftlp.burn";
  version: "1.0";
  poolContractId: string;
}>;

export type KitSupportedIntent =
  | LopCreateIntent
  | LopCancelIntent
  | LopMatchIntent
  | HtlcLockIntent
  | HtlcClaimIntent
  | HtlcRefundIntent
  | TimelockLockIntent
  | TimelockUnlockIntent
  | AmmCreateIntent
  | AmmAddLiquidityIntent
  | AmmRemoveLiquidityIntent
  | AmmSwapIntent
  | UnifiedAmmSwapIntent
  | UnifiedAmmAddLiquidityIntent
  | UnifiedAmmRemoveLiquidityIntent
  | LpTransferIntent
  | LpLockIntent
  | LpMaintenanceIntent
  | UnifiedLpTransferIntent
  | UnifiedLpLockIntent
  | UnifiedPoolMaintenanceIntent
  | TbcTransferIntent
  | TbcMergeIntent
  | CollectionCreateIntent
  | NftMintIntent
  | NftTransferIntent
  | Tbc721StandardCollectionIntent
  | Tbc721StandardMintIntent
  | Tbc721StandardBatchMintIntent
  | Tbc721StandardTransferIntent
  | Tbc721TransferIntent
  | FtCreateIntent
  | FtTransferIntent
  | FtMergeIntent
  | Tbc20StandardCreateIntent
  | Tbc20StandardTransferIntent
  | Tbc20StandardMergeIntent
  | Tbc20TransferIntent
  | Tbc20MergeIntent
  | Tbc20StablecoinTransferIntent
  | Tbc20StablecoinMergeIntent
  | CoinTransferIntent
  | CoinMergeIntent
  | CoinCreateIntent
  | CoinMintIntent
  | CoinFreezeIntent
  | CoinUnfreezeIntent
  | StablecoinTransferIntent
  | StablecoinMergeIntent
  | PoolCreateIntent
  | PoolSwapIntent
  | PoolLiquidityIntent
  | PoolMergeIntent
  | PoolFtlpBurnIntent;

/** New AMM immutable fee configuration. Four integer basis-point rates must
 * total less than 10000; the non-LP components share one P2PKH recipient.
 * Upstream swaps additionally require a positive retained fee after rounding. */
export type AmmFeePolicy = Readonly<{
  lpFeeRate: number; taxFeeRate: number; serviceProviderFeeRate: number;
  protocolFeeRate: number; feeAddress: string;
}>;
/** Creates the explicit-fee 1.7.3 template, never a historical preset pool. */
export type AmmCreateIntent = Readonly<{
  type: "tbc-amm-create"; version: "1.0"; ftContractId: string;
  feePolicy: AmmFeePolicy; lpTimelock: boolean;
  controllers?: readonly string[];
  /** UTF-8 label, at most 256 Unicode characters. Defaults to NULL; empty is allowed. */
  serviceProviderTag?: string;
}>;
type AmmStateIntent = Readonly<{ version: "1.0"; poolContractId: string; receiver?: string; poolStateHash?: string }>;
export type AmmAddLiquidityIntent = AmmStateIntent & Readonly<{
  type: "tbc-amm-add-liquidity"; amount: string; minimumLpAmount: string;
  maximumTbcAmount?: string; maximumFtAmount?: string; lockTime?: string;
}> & (Readonly<{ budgetAsset: "tbc"; initialFtAmount?: string }> | Readonly<{ budgetAsset: "ft"; initialFtAmount?: never }>);
export type AmmRemoveLiquidityIntent = AmmStateIntent & Readonly<{
  type: "tbc-amm-remove-liquidity"; lpAmount: string; minimumTbcAmount: string; minimumFtAmount: string;
}>;
export type AmmSwapIntent = AmmStateIntent & Readonly<{
  type: "tbc-amm-swap"; direction: "tbc-to-ft" | "ft-to-tbc"; amount: string; minimumOutput: string;
}>;
/** Shared operation; authenticated Pool material selects the supported builder.
 * Historical pools explicitly reject new-only options instead of ignoring them.
 * The default AMM loader migration is tracked separately from these wire types. */
export type UnifiedAmmSwapIntent = Readonly<Omit<AmmSwapIntent, "type"> & { type: "amm.swap" }>;
export type UnifiedAmmRemoveLiquidityIntent = Readonly<Omit<AmmRemoveLiquidityIntent, "type"> & { type: "amm.removeLiquidity" }>;
type ReplaceAmmAddType<T> = T extends unknown ? Readonly<Omit<T, "type"> & { type: "amm.addLiquidity" }> : never;
export type UnifiedAmmAddLiquidityIntent = ReplaceAmmAddType<AmmAddLiquidityIntent>;
export type TimelockLockIntent = Readonly<{ type: "tbc-timelock-lock"; version: "1.0"; amount: string; lockTime: string }>;
export type TimelockUnlockIntent = Readonly<{ type: "tbc-timelock-unlock"; version: "1.0" }>;

export type LopAsset = Readonly<{ standard: "tbc20-standard" | "tbc20-stablecoin"; contractId: string }>;
/** Native market: assetA is the Token; volume is native atomic units. Token
 * market: A is base, B is quote. Price and fee use integer scale 1,000,000. */
export type LopOrder = Readonly<{
  side: "buy" | "sell"; assetA: LopAsset; saleVolume: string;
  unitPrice: string; feeRate: string; feeRecipient: string;
}> & (Readonly<{ market: "native-token"; assetB?: never }> | Readonly<{ market: "token-token"; assetB: LopAsset }>);
export type LopCreateIntent = Readonly<{ type: "tbc-lop-create"; version: "1.0"; order: LopOrder }>;
export type LopCancelIntent = Readonly<{ type: "tbc-lop-cancel"; version: "1.0"; targetOutpoints: readonly [Readonly<{ txid: string; vout: number }>] }>;
/** Targets are buy then sell. Recipients/fees come from authenticated orders. */
export type LopMatchIntent = Readonly<{ type: "tbc-lop-match"; version: "1.0"; targetOutpoints: readonly [Readonly<{ txid: string; vout: number }>, Readonly<{ txid: string; vout: number }>] }>;

export type HtlcTokenAsset = Readonly<{ assetStandard: "tbc20-standard" | "tbc20-stablecoin"; contractId: string }>;
type HtlcNativeAsset = Readonly<{ assetStandard?: never; contractId?: never; targetOutpoints?: never }>;
export type HtlcTokenTarget = HtlcTokenAsset & Readonly<{ targetOutpoints: readonly [Readonly<{ txid: string; vout: 1 }>] }>;
export type HtlcLockIntent = (HtlcNativeAsset | HtlcTokenAsset) & Readonly<{
  type: "tbc-htlc-lock"; version: "1.0"; to: string; amount: string; hashlock: string; lockTime: string;
}>;
/** Signed claim bytes disclose the preimage even before broadcast. */
export type HtlcClaimIntent = (HtlcNativeAsset | HtlcTokenTarget) & Readonly<{ type: "tbc-htlc-claim"; version: "1.0"; preimage: string }>;
export type HtlcRefundIntent = (HtlcNativeAsset | HtlcTokenTarget) & Readonly<{ type: "tbc-htlc-refund"; version: "1.0" }>;

export type LpTransferIntent = Readonly<{
  type: "tbc20-lp-transfer"; version: "1.0"; poolContractId: string; amount: string; to: string;
}>;
export type LpLockIntent = Readonly<{
  type: "tbc20-lp-lock"; version: "1.0"; poolContractId: string; amount: string; lockTime: string;
}>;
export type LpMaintenanceIntent = Readonly<{
  type: "tbc20-lp-merge" | "tbc20-lp-unlock"; version: "1.0"; poolContractId: string;
}>;
export type UnifiedLpTransferIntent = Readonly<Omit<LpTransferIntent, "type"> & { type: "tbc20Lp.transfer" }>;
export type UnifiedLpLockIntent = Readonly<Omit<LpLockIntent, "type"> & { type: "tbc20Lp.lock" }>;
export type UnifiedPoolMaintenanceIntent = Readonly<{
  type: "tbc20Lp.merge" | "tbc20Lp.unlock" | "tbc20Lp.burn" | "amm.mergeToken";
  version: "1.0"; poolContractId: string;
}>;

export interface KitWalletDescriptor {
  /** Self-reported product metadata. It is not a provider-instance or authority identity. */
  readonly productId: string | undefined;
  readonly name: string;
  readonly icon: `data:${string}`;
  readonly provider: KitProvider;
  readonly accounts: readonly Readonly<{
    address: string;
    publicKey: Uint8Array;
    chains: readonly `tbc:${string}`[];
  }>[];
}

export interface KitWalletCatalogEntry {
  readonly productId: string;
  readonly name: string;
  readonly icon: `data:${string}`;
  readonly homepageUrl?: `https://${string}`;
  readonly installUrl?: `https://${string}`;
}

export type KitWalletOption =
  | Readonly<{
      status: "detected";
      productId: string | undefined;
      catalog: KitWalletCatalogEntry | undefined;
      wallet: KitWalletDescriptor;
    }>
  | Readonly<{
      status: "not-detected";
      productId: string;
      catalog: KitWalletCatalogEntry;
      wallet: undefined;
    }>;

export interface KitTransactionEngine {
  normalizeRequest(params: unknown): unknown | Promise<unknown>;
  plan(params: unknown): unknown | Promise<unknown>;
  validate(params: unknown): unknown | Promise<unknown>;
  finalize(params: unknown): unknown | Promise<unknown>;
}
