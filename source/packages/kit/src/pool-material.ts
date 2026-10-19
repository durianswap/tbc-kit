import { bytesToHex, canonicalize } from "@tbc-wallet/core";
import { createTbcOfficialApi } from "./official-api.js";
import {
  createPoolMaterialLoader,
  type LegacyPoolFunding,
  type LegacyPoolFundingSource,
  type LegacyPoolMaterialLoadRequest,
} from "./pool-signing-loader.js";
import {
  createTestnetClient,
  OFFICIAL_TBC_TESTNET_API_ORIGIN,
  type TestnetClient,
  type TestnetRawTransaction,
} from "./testnet-client.js";
import {
  assertHash32,
  assertRawTransaction,
  assertTbcAddress,
  inspectTbcTransaction,
  parseTbcTransaction,
  turingTransactionId,
} from "./testnet-validation.js";
import {
  createCanonicalPoolPolicy,
  freezeCanonicalPoolParents,
} from "./pool-material-helpers.js";
import {
  createPoolMaterialNativeProvider,
  POOL_MATERIAL_NATIVE_OPERATIONS,
  type PoolMaterialNativeProvider,
  type PoolMaterialNativeProviderInput,
} from "./pool-material-native.js";

const UINT = /^(?:0|[1-9][0-9]*)$/u;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

function poolAuthorityContext(
  context: Readonly<Record<string, unknown>>, ftId: string, poolId: string,
  parent: (value: unknown) => Readonly<{txid: string; rawTransaction: string}>,
) {
  if (context.indexedFungible !== undefined) {
    const value = record(context.indexedFungible, "indexed Pool FT");
    const codeScript = text(value.codeScript, "indexed FT Code").toLowerCase();
    const tapeScript = text(value.tapeScript, "indexed FT Tape").toLowerCase();
    for (const script of [codeScript, tapeScript]) {
      if (!/^(?:[0-9a-f]{2})+$/u.test(script) || script.length > 131072)
        throw new Error("Invalid indexed Pool FT scripts");
    }
    if (context.ftContractTxraw !== undefined || context.poolCreationTxraw !== undefined)
      throw new Error("Conflicting Pool authority sources");
    const indexedFungible = Object.freeze({codeScript, tapeScript, totalSupply: uint(value.totalSupply, "indexed FT supply")});
    return {
      rawParents: [] as unknown[],
      ft: {indexedFungible},
      pool: {indexedPool: Object.freeze({ftCodeScript: codeScript, ftTapeScript: tapeScript})},
    };
  }
  if (parent(context.ftContractTxraw).txid !== ftId || parent(context.poolCreationTxraw).txid !== poolId)
    throw new Error("Invalid canonical Pool authority identity");
  return {rawParents: [context.ftContractTxraw, context.poolCreationTxraw], ft: {}, pool: {}};
}

interface PoolMaterialUtxoBase {
  readonly txid: string;
  readonly vout: number;
  readonly satoshis: string;
  readonly scriptPubKey: string;
  /** Omitted means unobserved, never an implicit mempool zero. */
  readonly confirmations?: string;
}

/** Construction-only material. Exact transaction lookup keeps its required count. */
export type PoolMaterialTransaction = Omit<TestnetRawTransaction, "confirmations"> &
  Readonly<{ confirmations?: string }>;
type PoolMaterialClient = Pick<TestnetClient, "getRawTransactionBytes"> & Readonly<{
  getRawTransaction: (txid: string) => Promise<PoolMaterialTransaction>;
}>;

function confirmationFields(value: Readonly<{ confirmations?: string }>): Readonly<{ confirmations?: string }> {
  if (!Object.hasOwn(value, "confirmations")) return {};
  const confirmations = value.confirmations;
  if (typeof confirmations !== "string" || !UINT.test(confirmations) || BigInt(confirmations) > 0xffff_ffffn)
    throw new Error("Invalid Pool confirmation observation");
  return { confirmations };
}

export type PoolMaterialUtxo =
  | (PoolMaterialUtxoBase &
      Readonly<{
        classification: "pool-source";
      }>)
  | (PoolMaterialUtxoBase &
      Readonly<{
        classification: "pool" | "pool-ft" | "ftlp" | "ft";
        contractId: string;
      }>);

export interface PoolMaterial {
  readonly utxos: readonly PoolMaterialUtxo[];
  readonly parents: readonly Readonly<{
    txid: string;
    rawTransaction: string;
  }>[];
  readonly contracts: readonly Readonly<{
    contractId: string;
    family: "ft" | "pool";
    protocolVersion: "4.0" | "2.0";
    creationTxid: string;
    currentOutpoint: Readonly<{ txid: string; vout: number }>;
    indexedFungible?: Readonly<{codeScript: string; tapeScript: string; totalSupply: string}>;
    indexedPool?: Readonly<{ftCodeScript: string; ftTapeScript: string}>;
  }>[];
  readonly policy: Readonly<{
    lpPlan: number;
    serviceProviderTag: string;
    serviceFeeRate: number;
  }>;
  readonly review: Readonly<{
    ftContractId: string;
    ftRequiredRaw: string;
    ftlpDeltaRaw: string;
    lockTime: string;
    feeFundingCapAtomic: string;
    poolBefore: PoolMaterialAmounts;
    poolAfter: PoolMaterialAmounts;
  }>;
}

export interface PoolMaterialAmounts {
  readonly tbcSat: string;
  readonly ftARaw: string;
  readonly ftLpRaw: string;
  readonly poolValueSat: string;
}

/** Wallet-owned construction policy. This is not DApp-controlled input and
 * does not claim that a confirmation count was observed from the node. */
export interface PoolMaterialConfirmationPolicy {
  readonly minConfirmations: string;
}

export function normalizePoolMaterialConfirmationPolicy(
  value: PoolMaterialConfirmationPolicy,
): Readonly<PoolMaterialConfirmationPolicy> {
  if (typeof value?.minConfirmations !== "string") {
    throw new Error("Invalid canonical Pool minimum confirmations");
  }
  const minConfirmations = uint(
    value?.minConfirmations,
    "Pool minimum confirmations",
  );
  if (BigInt(minConfirmations) > 0xffff_ffffn) {
    throw new Error("Invalid canonical Pool minimum confirmations");
  }
  return Object.freeze({ minConfirmations });
}

export type PoolMergeIndexKind = "pool-ft" | "ftlp";

export interface PoolMergeIndexUtxo {
  readonly txid: string;
  readonly vout: number;
  readonly satoshis: string;
  readonly assetAmount: string;
  readonly lockTime?: number;
}

export interface PoolMergeIndex {
  readonly version: "1.0";
  readonly kind: PoolMergeIndexKind;
  readonly poolContractId: string;
  readonly ftContractId: string;
  /** Current Pool state identity; FTLP merge does not consume this output. */
  readonly currentPoolTxid: string;
  readonly utxos: readonly PoolMergeIndexUtxo[];
}

/** Internal preparation context, not a DApp request or retained index cache. */
export type PoolMaterialReadScope = Readonly<Pick<ReturnType<typeof createTbcOfficialApi>, "poolInfo"> & Partial<Pick<ReturnType<typeof createTbcOfficialApi>, "ftInfo">>>;

export interface PoolMaterialSource {
  /** Internal immutable-byte handoff, never a confirmation/unspentness cache. */
  readonly rememberTransaction?: (txid: string, rawTransaction: string) => void | Promise<void>;
  /** Present only when the wallet deliberately selected a construction floor. */
  readonly confirmationPolicy?: Readonly<PoolMaterialConfirmationPolicy>;
  /**
   * Wallet-startup capability warmup. It creates the native-backed source and
   * validates its operation surface without reading mutable chain state.
   */
  readonly warmup?: () => Promise<void>;
  readonly resolveLiquidityAdd: (
    input: PoolMaterialRequest,
    funding?: LegacyPoolFundingSource,
    reads?: PoolMaterialReadScope,
  ) => Promise<PoolMaterial>;
  readonly resolveLiquidityRemove?: (
    input: PoolLiquidityRemoveMaterialRequest,
    funding?: LegacyPoolFundingSource,
    reads?: PoolMaterialReadScope,
  ) => Promise<PoolLiquidityRemoveMaterial>;
  readonly resolveCreateInitialize?: (
    input: PoolCreateInitializeMaterialRequest,
  ) => Promise<PoolCreateInitializeMaterial>;
  readonly resolveSwapTbcForToken?: (
    input: PoolSwapTbcForTokenMaterialRequest,
    funding?: LegacyPoolFundingSource,
    reads?: PoolMaterialReadScope,
  ) => Promise<PoolSwapMaterial>;
  readonly resolveSwapTokenForTbc?: (
    input: PoolSwapTokenForTbcMaterialRequest,
    funding?: LegacyPoolFundingSource,
    reads?: PoolMaterialReadScope,
  ) => Promise<PoolSwapMaterial>;
  readonly resolvePoolFtMerge?: (
    input: PoolMergeMaterialRequest,
    funding?: LegacyPoolFundingSource,
    reads?: PoolMaterialReadScope,
  ) => Promise<PoolMergeMaterial>;
  /** Private authoritative inventory used only by bounded Pool maintenance. */
  readonly readMergeIndex?: (
    input: PoolMergeMaterialRequest & Readonly<{ kind: PoolMergeIndexKind }>,
  ) => Promise<PoolMergeIndex>;
  readonly resolveFtlpMerge?: (
    input: PoolMergeMaterialRequest,
    funding?: LegacyPoolFundingSource,
    reads?: PoolMaterialReadScope,
  ) => Promise<PoolMergeMaterial>;
  readonly resolveFtlpBurn?: (
    input: PoolMergeMaterialRequest,
    funding?: LegacyPoolFundingSource,
    reads?: PoolMaterialReadScope,
  ) => Promise<PoolMergeMaterial>;
}

type PoolSnapshotBinding = Readonly<{
  snapshotHash: string;
  chainId: string;
  /** Separates same-chain material loaded from different trusted sources. */
  sourceIdentity?: string;
}>;
export type PoolSnapshotMaterial = Readonly<{
  binding: PoolSnapshotBinding;
  expiresAt: number;
}> &
  (
    | Readonly<{
        kind: "add";
        input: PoolMaterialRequest;
        material: PoolMaterial;
      }>
    | Readonly<{
        kind: "remove";
        input: PoolLiquidityRemoveMaterialRequest;
        material: PoolLiquidityRemoveMaterial;
      }>
    | Readonly<{
        kind: "initialize";
        input: PoolCreateInitializeMaterialRequest;
        material: PoolCreateInitializeMaterial;
      }>
    | Readonly<{
        kind: "swap-tbc-for-token";
        input: PoolSwapTbcForTokenMaterialRequest;
        material: PoolSwapMaterial;
      }>
    | Readonly<{
        kind: "swap-token-for-tbc";
        input: PoolSwapTokenForTbcMaterialRequest;
        material: PoolSwapMaterial;
      }>
  );

/** One exact snapshot's read-only material, shared by chain preparation and approval.
 * Not spendability, authority or a signing capability; misses keep the normal loader.
 */
export function createPoolSnapshotMaterialRetention(
  now: () => number = Date.now,
) {
  let entry: PoolSnapshotMaterial | undefined;
  let key = "";
  function read(
    kind:
      | "add"
      | "remove"
      | "initialize"
      | "swap-tbc-for-token"
      | "swap-token-for-tbc",
    binding: PoolSnapshotBinding,
    input:
      | PoolMaterialRequest
      | PoolLiquidityRemoveMaterialRequest
      | PoolCreateInitializeMaterialRequest
      | PoolSwapTbcForTokenMaterialRequest
      | PoolSwapTokenForTbcMaterialRequest,
  ) {
    if (entry && entry.expiresAt <= now()) entry = undefined;
    const effectiveBinding =
      entry?.binding.sourceIdentity !== undefined && binding.sourceIdentity === undefined
        ? Object.freeze({
            ...binding,
            sourceIdentity: entry.binding.sourceIdentity,
          })
        : binding;
    return entry && key === canonicalize({ kind, binding: effectiveBinding, input })
      ? entry
      : undefined;
  }
  return Object.freeze({
    remember(value: PoolSnapshotMaterial) {
      if (!Number.isFinite(value.expiresAt) || value.expiresAt <= now()) return;
      key = canonicalize({
        kind: value.kind,
        binding: value.binding,
        input: value.input,
      });
      entry = value;
    },
    readAdd(binding: PoolSnapshotBinding, input: PoolMaterialRequest) {
      const value = read("add", binding, input);
      return value?.kind === "add" ? value.material : undefined;
    },
    readRemove(
      binding: PoolSnapshotBinding,
      input: PoolLiquidityRemoveMaterialRequest,
    ) {
      const value = read("remove", binding, input);
      return value?.kind === "remove" ? value.material : undefined;
    },
    readInitialize(
      binding: PoolSnapshotBinding,
      input: PoolCreateInitializeMaterialRequest,
    ) {
      const value = read("initialize", binding, input);
      return value?.kind === "initialize" ? value.material : undefined;
    },
    readSwapTbcForToken(
      binding: PoolSnapshotBinding,
      input: PoolSwapTbcForTokenMaterialRequest,
    ) {
      const value = read("swap-tbc-for-token", binding, input);
      return value?.kind === "swap-tbc-for-token"
        ? value.material
        : undefined;
    },
    readSwapTokenForTbc(
      binding: PoolSnapshotBinding,
      input: PoolSwapTokenForTbcMaterialRequest,
    ) {
      const value = read("swap-token-for-tbc", binding, input);
      return value?.kind === "swap-token-for-tbc"
        ? value.material
        : undefined;
    },
  });
}

export type PoolLiquidityRemoveMaterial = Readonly<
  Pick<PoolMaterial, "utxos" | "parents" | "contracts" | "policy"> & {
    readonly review: Readonly<{
      readonly ftContractId: string;
      readonly lpAmountRaw: string;
      readonly currentLockTime: string;
      readonly feeFundingCapAtomic: string;
      readonly poolBefore: PoolMaterialAmounts;
    }>;
  }
>;

export interface PoolLiquidityRemoveMaterialRequest {
  readonly address: string;
  readonly poolContractId: string;
  readonly receiver: string;
  readonly lpAmount: string;
}

export type PoolSwapMaterial = Readonly<
  Pick<PoolMaterial, "utxos" | "parents" | "contracts" | "policy"> & {
    readonly review: Readonly<{
      readonly direction: "tbc-for-token" | "token-for-tbc";
      readonly ftContractId: string;
      readonly inputAmount: string;
      readonly feeFundingCapAtomic: string;
      readonly poolBefore: PoolMaterialAmounts;
    }>;
  }
>;

export interface PoolSwapTbcForTokenMaterialRequest {
  readonly address: string;
  readonly poolContractId: string;
  readonly receiver: string;
  readonly tbcAmount: string;
}

export interface PoolSwapTokenForTbcMaterialRequest {
  readonly address: string;
  readonly poolContractId: string;
  readonly receiver: string;
  readonly ftAmount: string;
}

export interface PoolMergeMaterialRequest {
  readonly address: string;
  readonly poolContractId: string;
}

export type PoolMergeMaterial = Readonly<
  Pick<PoolMaterial, "utxos" | "parents" | "contracts" | "policy"> & {
    readonly review: Readonly<{
      readonly kind: "pool-ft" | "ftlp";
      readonly ftContractId: string;
      readonly assetAmountRaw: string;
      readonly feeFundingCapAtomic: string;
      readonly poolBefore: PoolMaterialAmounts;
    }>;
  }
>;

export type PoolCreateInitializeMaterial = Readonly<
  Pick<PoolMaterial, "utxos" | "parents" | "contracts" | "policy">
>;

export interface PoolCreateInitializeMaterialRequest {
  readonly address: string;
  readonly poolContractId: string;
  readonly receiver: string;
  readonly tbcAmount: string;
  readonly ftAmount: string;
}

export interface PoolMaterialRequest {
  readonly address: string;
  readonly poolContractId: string;
  readonly receiver: string;
  readonly tbcAmount: string;
}

interface IndexedPoolInfo {
  readonly ftAPartialHash: string;
  readonly ftContractId: string;
  readonly ftLpPartialHash: string;
  readonly lpBalance: string;
  readonly poolCodeScript: string;
  readonly serviceFeeRate: number;
  readonly serviceProvider: string;
  readonly tbcBalance: string;
  readonly tokenBalance: string;
  readonly txid: string;
  readonly value: string;
  readonly version: number;
  readonly vout: number;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new Error(`Invalid canonical Pool ${label}`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid canonical Pool ${label}`);
  }
  return value;
}

function uint(value: unknown, label: string): string {
  const normalized =
    typeof value === "number" && Number.isSafeInteger(value)
      ? String(value)
      : value;
  if (typeof normalized !== "string" || !UINT.test(normalized)) {
    throw new Error(`Invalid canonical Pool ${label}`);
  }
  return normalized;
}

function integer(value: unknown, label: string): number {
  const normalized = BigInt(uint(value, label));
  if (normalized > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`Invalid canonical Pool ${label}`);
  }
  return Number(normalized);
}

function atomicToDisplay(value: string): string {
  if (!/^[1-9][0-9]*$/u.test(value)) {
    throw new Error("Invalid canonical Pool TBC amount");
  }
  const padded = value.padStart(7, "0");
  const whole = padded.slice(0, -6);
  const fraction = padded.slice(-6).replace(/0+$/u, "");
  return fraction.length === 0 ? whole : `${whole}.${fraction}`;
}

function parent(rawValue: unknown) {
  const rawTransaction = assertRawTransaction(text(rawValue, "parent"));
  return Object.freeze({
    txid: turingTransactionId(rawTransaction),
    rawTransaction,
  });
}

/** Wallet-private exact-byte cache; callers own its scope. No mutable authority. */
export function createPoolTransactionInspector(): typeof inspectTbcTransaction {
  const transactions = new Map<
    string,
    ReturnType<typeof inspectTbcTransaction>
  >();
  let retainedSize = 0;
  return (raw) => {
    let value = transactions.get(raw);
    if (!value) {
      value = inspectTbcTransaction(raw);
      if (raw.length > MAX_RESPONSE_BYTES) return value;
      while (
        transactions.size >= 32 ||
        retainedSize + raw.length > MAX_RESPONSE_BYTES
      ) {
        const oldest = transactions.keys().next().value as string;
        retainedSize -= oldest.length;
        transactions.delete(oldest);
      }
      transactions.set(raw, value);
      retainedSize += raw.length;
    }
    return value;
  };
}

function createParentReader(
  inspect: typeof inspectTbcTransaction,
): typeof parent {
  return (rawValue) => {
    const rawTransaction = assertRawTransaction(text(rawValue, "parent"));
    return Object.freeze({
      txid: inspect(rawTransaction).txid,
      rawTransaction,
    });
  };
}

function amounts(value: unknown, label: string): PoolMaterialAmounts {
  const input = record(value, label);
  return Object.freeze({
    tbcSat: uint(input.tbcSat, `${label} TBC`),
    ftARaw: uint(input.ftARaw, `${label} FT`),
    ftLpRaw: uint(input.ftLpRaw, `${label} FT-LP`),
    poolValueSat: uint(input.poolValueSat, `${label} value`),
  });
}

async function readIndexedPoolInfo(
  fetch: typeof globalThis.fetch,
  baseUrl: string,
  poolContractId: string,
): Promise<IndexedPoolInfo> {
  let value: unknown;
  try {
    value = await createTbcOfficialApi({
      baseUrl,
      fetch,
      maxResponseBytes: MAX_RESPONSE_BYTES,
    }).poolInfo(
      { pool_id: poolContractId },
      { category: "pool", retry: "none" },
    );
  } catch {
    throw new Error("Pool initialize metadata request failed");
  }
  const info = record(value, "initialize metadata");
  const result = Object.freeze({
    ftAPartialHash: text(info.ft_a_partial_hash, "FT partial hash"),
    ftContractId: assertHash32(
      text(info.ft_contract_id, "FT contract").toLowerCase(),
    ),
    ftLpPartialHash: text(info.ft_lp_partial_hash, "FT-LP partial hash"),
    lpBalance: uint(info.lp_balance, "LP balance"),
    poolCodeScript: text(
      info.pool_code_script,
      "Pool code script",
    ).toLowerCase(),
    serviceFeeRate: integer(info.service_fee_rate, "service fee rate"),
    serviceProvider: text(info.service_provider, "service provider"),
    tbcBalance: uint(info.tbc_balance, "TBC balance"),
    tokenBalance: uint(info.token_balance, "token balance"),
    txid: assertHash32(text(info.txid, "current transaction").toLowerCase()),
    value: uint(info.value, "Pool value"),
    version: integer(info.version, "Pool version"),
    vout: integer(info.vout, "Pool output"),
  });
  if (
    result.version !== 2 ||
    result.vout !== 0 ||
    result.txid !== poolContractId ||
    result.lpBalance !== "0" ||
    result.tbcBalance !== "0" ||
    result.tokenBalance !== "0"
  ) {
    throw new Error("Pool initialize requires an uninitialized Pool v2");
  }
  return result;
}

export function createPoolInitializeMaterialResolver(options: {
  readonly client: PoolMaterialClient & Pick<TestnetClient, "getFtUtxos">;
  readonly fetch: typeof globalThis.fetch;
  readonly native: PoolMaterialNativeProvider;
  readonly inspectTransaction?: typeof inspectTbcTransaction;
  readonly baseUrl?: string;
  readonly p2pkhVersion?: number;
}): (
  input: PoolCreateInitializeMaterialRequest,
) => Promise<PoolCreateInitializeMaterial> {
  return async (input) => {
    const inspectTransaction =
      options.inspectTransaction ?? createPoolTransactionInspector();
    const readParent = createParentReader(inspectTransaction);
    const readTransaction = (raw: string) =>
      inspectTransaction(raw).transaction;
    const source = assertTbcAddress(input.address, options.p2pkhVersion ?? 0).address;
    assertTbcAddress(input.receiver, options.p2pkhVersion ?? 0);
    const poolContractId = assertHash32(input.poolContractId.toLowerCase());
    const requiredFt = BigInt(uint(input.ftAmount, "initialize FT amount"));
    if (requiredFt === 0n) {
      throw new Error("Pool initialize FT amount must be positive");
    }
    const info = await readIndexedPoolInfo(
      options.fetch,
      options.baseUrl ?? OFFICIAL_TBC_TESTNET_API_ORIGIN,
      poolContractId,
    );
    const [poolNode, ftContractNode, candidates] = await Promise.all([
      options.client.getRawTransaction(poolContractId),
      options.client.getRawTransaction(info.ftContractId),
      options.client.getFtUtxos(source, info.ftContractId),
    ]);
    const poolParent = readParent(poolNode.rawTransaction);
    const ftContractParent = readParent(ftContractNode.rawTransaction);
    if (
      poolParent.txid !== poolContractId ||
      poolNode.txid !== poolContractId ||
      ftContractParent.txid !== info.ftContractId ||
      ftContractNode.txid !== info.ftContractId
    ) {
      throw new Error("Invalid Pool initialize contract identity");
    }
    const poolTransaction = readTransaction(poolNode.rawTransaction);
    const poolOutput = poolTransaction.outputs[0];
    const sourceInput = poolTransaction.inputs[0];
    if (
      poolOutput === undefined ||
      sourceInput === undefined ||
      bytesToHex(poolOutput.scriptPubKey) !== info.poolCodeScript ||
      poolOutput.satoshis.toString() !== info.value
    ) {
      throw new Error("Invalid uninitialized Pool output");
    }
    const sourceNodeRead = options.client.getRawTransaction(sourceInput.txid);
    void sourceNodeRead.catch(() => {});
    const descriptor = record(
      JSON.parse(
        await options.native.execute(
          "preparePoolNft",
          JSON.stringify({
            phase: "describe",
            contractId: poolContractId,
            ownerAddress: source,
            info,
            poolPreTxraw: poolNode.rawTransaction,
            ftContractTxraw: ftContractNode.rawTransaction,
          }),
        ),
      ) as unknown,
      "initialize descriptor",
    );
    const descriptorPool = record(descriptor.pool, "initialize Pool state");
    if (
      descriptor.stablecoin === true ||
      descriptor.ftContractId !== info.ftContractId ||
      uint(descriptorPool.ftLpRaw, "initialize FT-LP state") !== "0" ||
      uint(descriptorPool.ftARaw, "initialize FT state") !== "0" ||
      uint(descriptorPool.tbcSat, "initialize TBC state") !== "0"
    ) {
      throw new Error("Invalid uninitialized Pool state");
    }
    const sourceNode = await sourceNodeRead;
    const sourceParent = readParent(sourceNode.rawTransaction);
    const sourceOutput = readTransaction(sourceNode.rawTransaction).outputs[
      sourceInput.vout
    ];
    const indexedSourceOutput = sourceNode.outputs[sourceInput.vout];
    if (
      sourceParent.txid !== sourceInput.txid ||
      sourceOutput === undefined ||
      indexedSourceOutput === undefined ||
      indexedSourceOutput.satoshis !== sourceOutput.satoshis.toString() ||
      indexedSourceOutput.scriptPubKey !== bytesToHex(sourceOutput.scriptPubKey)
    ) {
      throw new Error("Invalid Pool source ancestry");
    }
    const selected = [...candidates]
      .filter((candidate) => BigInt(candidate.ftAmount) >= requiredFt)
      .sort(
        (left, right) =>
          (BigInt(left.ftAmount) < BigInt(right.ftAmount)
            ? -1
            : BigInt(left.ftAmount) > BigInt(right.ftAmount)
              ? 1
              : 0) ||
          left.txid.localeCompare(right.txid) ||
          left.vout - right.vout,
      )[0];
    if (selected === undefined) {
      throw new Error("Pool initialize requires one sufficient FT input");
    }
    const ownerNode = await options.client.getRawTransaction(selected.txid);
    const ownerParent = readParent(ownerNode.rawTransaction);
    const ownerOutput = ownerNode.outputs[selected.vout];
    const ownerFtScript = text(
      descriptor.ownerFtScript,
      "initialize owner FT script",
    ).toLowerCase();
    if (
      ownerParent.txid !== selected.txid ||
      ownerOutput === undefined ||
      ownerOutput.satoshis !== selected.satoshis ||
      ownerOutput.scriptPubKey !== ownerFtScript
    ) {
      throw new Error("Invalid Pool initialize FT authority");
    }
    const directParents = [sourceNode, poolNode, ftContractNode, ownerNode];
    const directIds = new Set(directParents.map(({ txid }) => txid));
    // The transaction funding the authenticated Pool source is not contract
    // ancestry: sourceNode itself is the exact parent spent by the Pool mint
    // and its output is verified above. Only the Pool/FT authority branches
    // need their preceding contract transactions.
    const authorityParents = [poolNode, ftContractNode, ownerNode];
    const ancestryIds = [
      ...new Set(
        authorityParents
          .flatMap(({ inputs }) => inputs.map(({ txid }) => txid))
          .filter((txid) => txid !== "0".repeat(64) && !directIds.has(txid)),
      ),
    ];
    const ancestry = await Promise.all(
      ancestryIds.map((txid) => options.client.getRawTransaction(txid)),
    );
    const lpPlan = integer(descriptorPool.lpPlan, "initialize LP plan");
    const serviceFeeRate = integer(
      descriptorPool.serviceFeeRate,
      "initialize service fee rate",
    );
    const policy = createCanonicalPoolPolicy(
      {
        lpPlan,
        serviceProviderTag: info.serviceProvider,
        serviceFeeRate,
      },
      "Pool initialize",
      info.serviceFeeRate,
    );
    return Object.freeze({
      utxos: Object.freeze([
        Object.freeze({
          txid: sourceInput.txid,
          vout: sourceInput.vout,
          satoshis: sourceOutput.satoshis.toString(),
          scriptPubKey: bytesToHex(sourceOutput.scriptPubKey),
          ...confirmationFields(sourceNode),
          classification: "pool-source" as const,
        }),
        Object.freeze({
          txid: poolContractId,
          vout: 0,
          satoshis: poolOutput.satoshis.toString(),
          scriptPubKey: info.poolCodeScript,
          ...confirmationFields(poolNode),
          classification: "pool" as const,
          contractId: poolContractId,
        }),
        Object.freeze({
          txid: selected.txid,
          vout: selected.vout,
          satoshis: selected.satoshis,
          scriptPubKey: ownerFtScript,
          ...confirmationFields(ownerNode),
          classification: "ft" as const,
          contractId: info.ftContractId,
        }),
      ]),
      parents: freezeCanonicalPoolParents(
        [...directParents, ...ancestry]
          .map(({ rawTransaction }) => readParent(rawTransaction)),
      ),
      contracts: Object.freeze([
        Object.freeze({
          contractId: info.ftContractId,
          family: "ft" as const,
          protocolVersion: "4.0" as const,
          creationTxid: info.ftContractId,
          currentOutpoint: Object.freeze({
            txid: selected.txid,
            vout: selected.vout,
          }),
        }),
        Object.freeze({
          contractId: poolContractId,
          family: "pool" as const,
          protocolVersion: "2.0" as const,
          creationTxid: poolContractId,
          currentOutpoint: Object.freeze({ txid: poolContractId, vout: 0 }),
        }),
      ]),
      policy,
    });
  };
}

export function createPoolMaterialSource(options: {
  readonly client: PoolMaterialClient;
  readonly inspectTransaction?: typeof inspectTbcTransaction;
  readonly p2pkhVersion?: number;
  readonly load: (
    request: LegacyPoolMaterialLoadRequest,
  ) => Promise<Readonly<Record<string, unknown>>>;
}): PoolMaterialSource {
  const inspect = options.inspectTransaction ?? createPoolTransactionInspector();
  const parseTransaction = (raw: string) => inspect(raw).transaction;


  async function readMergeIndex(
    input: PoolMergeMaterialRequest & Readonly<{ kind: PoolMergeIndexKind }>,
  ): Promise<PoolMergeIndex> {
    const poolContractId = assertHash32(input.poolContractId.toLowerCase());
    const address = assertTbcAddress(
      input.address,
      options.p2pkhVersion ?? 0,
    ).address;
    const value = record(
      await options.load({
        operation: input.kind === "pool-ft" ? "indexPoolFt" : "indexFtlp",
        addressFrom: address,
        contractId: poolContractId,
      }),
      "Pool merge index",
    );
    const kind = value.kind;
    const ftContractId = assertHash32(
      text(value.ftContractId, "Pool merge index FT contract").toLowerCase(),
    );
    const currentPoolTxid = assertHash32(
      text(value.currentPoolTxid, "Pool merge index state").toLowerCase(),
    );
    if (
      value.version !== 1 ||
      kind !== input.kind ||
      value.poolContractId !== poolContractId ||
      !Array.isArray(value.utxos)
    ) {
      throw new Error("Invalid canonical Pool merge index binding");
    }
    const verifiedKind = input.kind;
    const utxos = value.utxos.map((entry) => {
      const row = record(entry, "Pool merge index UTXO");
      const lockTime = row.lockTime;
      return Object.freeze({
        txid: assertHash32(text(row.txid, "Pool merge index txid").toLowerCase()),
        vout: integer(row.outputIndex, "Pool merge index output"),
        satoshis: uint(row.satoshis, "Pool merge index value"),
        assetAmount: uint(row.balance, "Pool merge index amount"),
        ...(lockTime === undefined
          ? {}
          : { lockTime: integer(lockTime, "Pool merge index lock time") }),
      });
    });
    if (
      new Set(utxos.map(({ txid, vout }) => `${txid}:${String(vout)}`)).size !==
      utxos.length
    ) {
      throw new Error("Duplicate canonical Pool merge index outpoint");
    }
    return Object.freeze({
      version: "1.0",
      kind: verifiedKind,
      poolContractId,
      ftContractId,
      currentPoolTxid,
      utxos: Object.freeze(utxos),
    });
  }

  async function resolveSwap(
    input:
      | PoolSwapTbcForTokenMaterialRequest
      | PoolSwapTokenForTbcMaterialRequest,
    operation: "swapToToken" | "swapToTbc",
  ): Promise<PoolSwapMaterial> {
    const source = assertTbcAddress(input.address, options.p2pkhVersion ?? 0).address;
    const receiver = assertTbcAddress(input.receiver, options.p2pkhVersion ?? 0).address;
    const poolContractId = assertHash32(input.poolContractId.toLowerCase());
    const inputAmount = uint(
      operation === "swapToToken"
        ? (input as PoolSwapTbcForTokenMaterialRequest).tbcAmount
        : (input as PoolSwapTokenForTbcMaterialRequest).ftAmount,
      "swap input amount",
    );
    if (BigInt(inputAmount) === 0n) {
      throw new Error("Pool swap input amount must be positive");
    }
    const preparedValue = await options.load(
        operation === "swapToToken"
          ? {
              operation,
              addressFrom: source,
              contractId: poolContractId,
              receiver,
              tbcAmount: inputAmount,
            }
          : {
              operation,
              addressFrom: source,
              contractId: poolContractId,
              receiver,
              ftAmount: inputAmount,
            },
      );
    const prepared = record(preparedValue, "prepared swap material");
    const context = record(prepared.preparedContext, "prepared swap context");
    const info = record(context.info, "swap information");
    const descriptor = record(context.canonicalDescriptor, "swap descriptor");
    const feeUtxo = record(prepared.feeUtxo, "swap fee UTXO");
    const ftContractId = assertHash32(
      text(info.ftContractId, "swap FT contract").toLowerCase(),
    );
    const currentPoolTxid = assertHash32(
      text(info.txid, "swap current transaction").toLowerCase(),
    );
    const currentPoolVout = integer(info.vout, "swap current output");
    const preparedAmount =
      operation === "swapToToken" ? prepared.tbcAmount : prepared.ftAmount;
    if (
      prepared.version !== 2 ||
      prepared.operation !== operation ||
      prepared.contractId !== poolContractId ||
      prepared.receiver !== receiver ||
      uint(preparedAmount, "prepared swap amount") !== inputAmount ||
      currentPoolVout !== 0
    ) {
      throw new Error("Invalid canonical Pool swap material binding");
    }
    const currentParent = parent(context.poolPreTxraw);
    const authority = poolAuthorityContext(context, ftContractId, poolContractId, parent);
    if (
      currentParent.txid !== currentPoolTxid
    ) {
      throw new Error("Invalid canonical Pool swap transaction identity");
    }
    const currentNode = await options.client.getRawTransaction(currentPoolTxid);
    if (currentNode.rawTransaction !== currentParent.rawTransaction) {
      throw new Error("Invalid canonical Pool swap current node identity");
    }
    const current = parseTransaction(currentParent.rawTransaction);
    const poolOutput = current.outputs[currentPoolVout];
    const poolCodeScript = text(
      info.poolCodeScript,
      "swap code script",
    ).toLowerCase();
    const poolFtScript = text(
      descriptor.poolFtScript,
      "swap Pool-held FT script",
    ).toLowerCase();
    const ownerFtScript = text(
      descriptor.ownerFtScript,
      "swap owner FT script",
    ).toLowerCase();
    if (
      poolOutput === undefined ||
      bytesToHex(poolOutput.scriptPubKey) !== poolCodeScript ||
      poolOutput.satoshis.toString() !== uint(info.value, "swap current value")
    ) {
      throw new Error("Invalid canonical Pool swap current output");
    }
    const utxos: PoolMaterialUtxo[] = [
      Object.freeze({
        txid: currentPoolTxid,
        vout: currentPoolVout,
        satoshis: poolOutput.satoshis.toString(),
        scriptPubKey: poolCodeScript,
        ...confirmationFields(currentNode),
        classification: "pool" as const,
        contractId: poolContractId,
      }),
    ];
    current.outputs.forEach((output, vout) => {
      const scriptPubKey = bytesToHex(output.scriptPubKey);
      if (scriptPubKey === poolFtScript) {
        utxos.push(
          Object.freeze({
            txid: currentPoolTxid,
            vout,
            satoshis: output.satoshis.toString(),
            scriptPubKey,
            ...confirmationFields(currentNode),
            classification: "pool-ft" as const,
            contractId: poolContractId,
          }),
        );
      }
    });
    const selectedValues = context.ftInputs;
    if (!Array.isArray(selectedValues) || selectedValues.length === 0) {
      throw new Error("Canonical Pool swap requires selected FT inputs");
    }
    let selectedBalance = 0n;
    let selectedFtOutpoint:
      | Readonly<{ txid: string; vout: number }>
      | undefined;
    const rawParents: unknown[] = [
      context.poolPrePreTxraw,
      context.poolPreTxraw,
      ...authority.rawParents,
      context.feeParentTxraw,
    ];
    for (const value of selectedValues) {
      const selected = record(value, "swap selected FT input");
      const selectedParent = parent(selected.preTxraw);
      const selectedVout = integer(
        selected.outputIndex,
        "swap selected FT output",
      );
      const selectedNode = await options.client.getRawTransaction(
        selectedParent.txid,
      );
      const selectedOutput = parseTransaction(selectedParent.rawTransaction)
        .outputs[selectedVout];
      const expectedScript =
        operation === "swapToToken" ? poolFtScript : ownerFtScript;
      if (
        selectedNode.rawTransaction !== selectedParent.rawTransaction ||
        selectedOutput === undefined ||
        bytesToHex(selectedOutput.scriptPubKey) !== expectedScript ||
        selectedOutput.satoshis.toString() !==
          uint(selected.satoshis, "swap selected FT value")
      ) {
        throw new Error("Invalid canonical Pool swap selected FT output");
      }
      selectedBalance += BigInt(
        uint(selected.balance, "swap selected FT balance"),
      );
      const outpoint = Object.freeze({
        txid: selectedParent.txid,
        vout: selectedVout,
      });
      selectedFtOutpoint ??= outpoint;
      if (
        !utxos.some(
          ({ txid, vout }) => txid === outpoint.txid && vout === outpoint.vout,
        )
      ) {
        utxos.push(
          Object.freeze({
            ...outpoint,
            satoshis: selectedOutput.satoshis.toString(),
            scriptPubKey: expectedScript,
            ...confirmationFields(selectedNode),
            classification:
              operation === "swapToToken"
                ? ("pool-ft" as const)
                : ("ft" as const),
            contractId:
              operation === "swapToToken" ? poolContractId : ftContractId,
          }),
        );
      }
      rawParents.push(
        selected.preTxraw,
        ...(Array.isArray(selected.grandparentTxraws)
          ? selected.grandparentTxraws
          : []),
      );
    }
    if (
      selectedFtOutpoint === undefined ||
      (operation === "swapToTbc" && selectedBalance < BigInt(inputAmount)) ||
      !utxos.some(({ classification }) => classification === "pool-ft")
    ) {
      throw new Error("Invalid canonical Pool swap selected balance");
    }
    if (
      new Set(utxos.map(({ txid, vout }) => `${txid}:${vout}`)).size !==
      utxos.length
    ) {
      throw new Error("Duplicate canonical Pool swap outpoint");
    }
    const parents = freezeCanonicalPoolParents(rawParents.map(parent));
    const lpPlan = integer(descriptor.lpPlan, "swap LP plan");
    const serviceFeeRate = integer(
      descriptor.serviceFeeRate,
      "swap service fee rate",
    );
    const serviceProviderTag = text(
      descriptor.serviceProviderTag,
      "swap service provider",
    );
    const policy = createCanonicalPoolPolicy(
      { lpPlan, serviceProviderTag, serviceFeeRate },
      "Pool swap",
    );
    return Object.freeze({
      utxos: Object.freeze(utxos),
      parents,
      contracts: Object.freeze([
        Object.freeze({
          contractId: ftContractId,
          family: "ft" as const,
          protocolVersion: "4.0" as const,
          creationTxid: ftContractId,
          ...authority.ft,
          currentOutpoint: selectedFtOutpoint,
        }),
        Object.freeze({
          contractId: poolContractId,
          family: "pool" as const,
          protocolVersion: "2.0" as const,
          creationTxid: poolContractId,
          ...authority.pool,
          currentOutpoint: Object.freeze({
            txid: currentPoolTxid,
            vout: currentPoolVout,
          }),
        }),
      ]),
      policy,
      review: Object.freeze({
        direction:
          operation === "swapToToken" ? "tbc-for-token" : "token-for-tbc",
        ftContractId,
        inputAmount,
        feeFundingCapAtomic: uint(feeUtxo.satoshis, "swap fee funding cap"),
        poolBefore: amounts(context.poolBefore, "Pool swap before"),
      }),
    });
  }

  async function resolveMerge(
    input: PoolMergeMaterialRequest,
    operation: "mergePoolFt" | "mergeFtlp" | "burnFtlp",
  ): Promise<PoolMergeMaterial> {
    const inspect = options.inspectTransaction ?? createPoolTransactionInspector();
    const readParent = createParentReader(inspect);
    const parse = (raw: string) => inspect(raw).transaction;
    const source = assertTbcAddress(
      input.address,
      options.p2pkhVersion ?? 0,
    ).address;
    const poolContractId = assertHash32(input.poolContractId.toLowerCase());
    const preparedValue = await options.load({
        operation,
        addressFrom: source,
        contractId: poolContractId,
      });
    const prepared = record(preparedValue, "prepared merge material");
    const context = record(prepared.preparedContext, "prepared merge context");
    const info = record(context.info, "merge information");
    const descriptor = record(context.canonicalDescriptor, "merge descriptor");
    const feeUtxo = record(prepared.feeUtxo, "merge fee UTXO");
    const ftContractId = assertHash32(
      text(info.ftContractId, "merge FT contract").toLowerCase(),
    );
    const currentPoolTxid = assertHash32(
      text(info.txid, "merge current transaction").toLowerCase(),
    );
    const currentPoolVout = integer(info.vout, "merge current output");
    if (
      prepared.version !== 2 ||
      prepared.operation !== operation ||
      prepared.contractId !== poolContractId ||
      currentPoolVout !== 0
    ) {
      throw new Error("Invalid canonical Pool merge material binding");
    }
    const currentParent = readParent(context.poolPreTxraw);
    const authority = poolAuthorityContext(context, ftContractId, poolContractId, readParent);
    if (
      currentParent.txid !== currentPoolTxid
    ) {
      throw new Error("Invalid canonical Pool merge transaction identity");
    }
    const currentNode = await options.client.getRawTransaction(currentPoolTxid);
    if (currentNode.rawTransaction !== currentParent.rawTransaction) {
      throw new Error("Invalid canonical Pool merge current node identity");
    }
    const current = parse(currentParent.rawTransaction);
    const poolOutput = current.outputs[currentPoolVout];
    const poolCodeScript = text(info.poolCodeScript, "merge Pool code").toLowerCase();
    if (
      poolOutput === undefined ||
      bytesToHex(poolOutput.scriptPubKey) !== poolCodeScript ||
      poolOutput.satoshis.toString() !== uint(info.value, "merge Pool value")
    ) {
      throw new Error("Invalid canonical Pool merge current output");
    }
    const selectedValues = operation === "mergePoolFt"
      ? context.ftInputs
      : context.ftlpInputs;
    const minimum = operation === "burnFtlp" ? 1 : 2;
    if (!Array.isArray(selectedValues) || selectedValues.length < minimum) {
      throw new Error("Canonical Pool maintenance has too few selected inputs");
    }
    const maximum = operation === "mergePoolFt" ? 4 : 5;
    if (selectedValues.length > maximum) {
      throw new Error("Canonical Pool merge exceeds its input bound");
    }
    const selectedScript = text(
      operation === "mergePoolFt"
        ? descriptor.poolFtScript
        : descriptor.ftlpScript,
      "merge selected script",
    ).toLowerCase();
    const utxos: PoolMaterialUtxo[] = [
      Object.freeze({
        txid: currentPoolTxid,
        vout: currentPoolVout,
        satoshis: poolOutput.satoshis.toString(),
        scriptPubKey: poolCodeScript,
        ...confirmationFields(currentNode),
        classification: "pool" as const,
        contractId: poolContractId,
      }),
    ];
    let selectedAmount = 0n;
    let selectedOutpoint: Readonly<{ txid: string; vout: number }> | undefined;
    const rawParents: unknown[] = [
      context.poolPrePreTxraw,
      context.poolPreTxraw,
      ...authority.rawParents,
      context.feeParentTxraw,
    ];
    for (const value of selectedValues) {
      const selected = record(value, "merge selected input");
      const selectedParent = readParent(selected.preTxraw);
      const selectedVout = integer(selected.outputIndex, "merge selected output");
      const selectedNode = await options.client.getRawTransaction(selectedParent.txid);
      const selectedOutput = parse(selectedParent.rawTransaction).outputs[selectedVout];
      if (
        selectedNode.rawTransaction !== selectedParent.rawTransaction ||
        selectedOutput === undefined ||
        bytesToHex(selectedOutput.scriptPubKey) !== selectedScript ||
        selectedOutput.satoshis.toString() !== uint(selected.satoshis, "merge selected value")
      ) {
        throw new Error("Invalid canonical Pool merge selected output");
      }
      selectedAmount += BigInt(uint(selected.balance, "merge selected balance"));
      const outpoint = Object.freeze({ txid: selectedParent.txid, vout: selectedVout });
      selectedOutpoint ??= outpoint;
      utxos.push(Object.freeze({
        ...outpoint,
        satoshis: selectedOutput.satoshis.toString(),
        scriptPubKey: selectedScript,
        ...confirmationFields(selectedNode),
        classification: operation === "mergePoolFt" ? "pool-ft" as const : "ftlp" as const,
        contractId: poolContractId,
      }));
      rawParents.push(
        selected.preTxraw,
        ...(Array.isArray(selected.grandparentTxraws)
          ? selected.grandparentTxraws
          : []),
      );
    }
    if (selectedOutpoint === undefined || selectedAmount === 0n) {
      throw new Error("Invalid canonical Pool merge selected balance");
    }
    if (new Set(utxos.map(({ txid, vout }) => `${txid}:${vout}`)).size !== utxos.length) {
      throw new Error("Duplicate canonical Pool merge outpoint");
    }
    const parents = freezeCanonicalPoolParents(rawParents.map(readParent));
    const lpPlan = integer(descriptor.lpPlan, "merge LP plan");
    const serviceFeeRate = integer(descriptor.serviceFeeRate, "merge service fee rate");
    const serviceProviderTag = text(descriptor.serviceProviderTag, "merge service provider");
    const policy = createCanonicalPoolPolicy(
      { lpPlan, serviceProviderTag, serviceFeeRate },
      "Pool merge",
    );
    return Object.freeze({
      utxos: Object.freeze(utxos),
      parents,
      contracts: Object.freeze([
        Object.freeze({
          contractId: ftContractId,
          family: "ft" as const,
          protocolVersion: "4.0" as const,
          creationTxid: ftContractId,
          ...authority.ft,
          currentOutpoint: selectedOutpoint,
        }),
        Object.freeze({
          contractId: poolContractId,
          family: "pool" as const,
          protocolVersion: "2.0" as const,
          creationTxid: poolContractId,
          ...authority.pool,
          currentOutpoint: Object.freeze({ txid: currentPoolTxid, vout: currentPoolVout }),
        }),
      ]),
      policy,
      review: Object.freeze({
        kind: operation === "mergePoolFt" ? "pool-ft" as const : "ftlp" as const,
        ftContractId,
        assetAmountRaw: selectedAmount.toString(),
        feeFundingCapAtomic: uint(feeUtxo.satoshis, "merge fee funding cap"),
        poolBefore: amounts(context.poolBefore, "Pool merge before"),
      }),
    });
  }

  return Object.freeze({
    readMergeIndex,
    async resolveLiquidityAdd(input: PoolMaterialRequest) {
      const inspect =
        options.inspectTransaction ?? createPoolTransactionInspector();
      const parent = createParentReader(inspect);
      const parseTbcTransaction = (raw: string) => inspect(raw).transaction;
      const source = assertTbcAddress(input.address, options.p2pkhVersion ?? 0).address;
      const receiver = assertTbcAddress(input.receiver, options.p2pkhVersion ?? 0).address;
      const poolContractId = assertHash32(input.poolContractId.toLowerCase());
      const preparedValue = await options.load({
          operation: "increaseLp",
          addressFrom: source,
          contractId: poolContractId,
          receiver,
          tbcAmount: atomicToDisplay(input.tbcAmount),
        });
      const prepared = record(preparedValue, "prepared material");
      const context = record(prepared.preparedContext, "prepared context");
      const info = record(context.info, "information");
      const descriptor = record(context.canonicalDescriptor, "descriptor");
      const preview = record(prepared.preview, "preview");
      const feeUtxo = record(prepared.feeUtxo, "fee UTXO");
      const ftContractId = assertHash32(
        text(info.ftContractId, "FT contract").toLowerCase(),
      );
      const currentPoolTxid = assertHash32(
        text(info.txid, "current transaction").toLowerCase(),
      );
      const currentPoolVout = integer(info.vout, "current output");
      if (
        prepared.version !== 2 ||
        prepared.operation !== "increaseLp" ||
        prepared.contractId !== poolContractId ||
        prepared.receiver !== receiver ||
        currentPoolVout !== 0 ||
        uint(preview.tbcAmountSat, "preview TBC") !== input.tbcAmount ||
        text(preview.ftContractId, "preview FT contract").toLowerCase() !==
          ftContractId
      ) {
        throw new Error("Invalid canonical Pool material binding");
      }
      const currentParent = parent(context.poolPreTxraw);
      const authority = poolAuthorityContext(context, ftContractId, poolContractId, parent);
      if (
        currentParent.txid !== currentPoolTxid
      ) {
        throw new Error("Invalid canonical Pool transaction identity");
      }
      const currentNode =
        await options.client.getRawTransaction(currentPoolTxid);
      if (currentNode.rawTransaction !== currentParent.rawTransaction) {
        throw new Error("Invalid canonical Pool current node identity");
      }
      const current = parseTbcTransaction(currentParent.rawTransaction);
      const poolOutput = current.outputs[currentPoolVout];
      const poolCodeScript = text(
        info.poolCodeScript,
        "code script",
      ).toLowerCase();
      if (
        poolOutput === undefined ||
        bytesToHex(poolOutput.scriptPubKey) !== poolCodeScript ||
        poolOutput.satoshis.toString() !== uint(info.value, "current value")
      ) {
        throw new Error("Invalid canonical Pool current output");
      }
      const poolFtScript = text(
        descriptor.poolFtScript,
        "Pool-held FT script",
      ).toLowerCase();
      const ftlpScript = text(
        descriptor.ftlpScript,
        "FT-LP script",
      ).toLowerCase();
      const utxos: PoolMaterialUtxo[] = [
        Object.freeze({
          txid: currentPoolTxid,
          vout: currentPoolVout,
          satoshis: poolOutput.satoshis.toString(),
          scriptPubKey: poolCodeScript,
          ...confirmationFields(currentNode),
          classification: "pool" as const,
          contractId: poolContractId,
        }),
      ];
      current.outputs.forEach((output, vout) => {
        const scriptPubKey = bytesToHex(output.scriptPubKey);
        const classification =
          scriptPubKey === poolFtScript
            ? ("pool-ft" as const)
            : scriptPubKey === ftlpScript
              ? ("ftlp" as const)
              : undefined;
        if (classification !== undefined) {
          utxos.push(
            Object.freeze({
              txid: currentPoolTxid,
              vout,
              satoshis: output.satoshis.toString(),
              scriptPubKey,
              ...confirmationFields(currentNode),
              classification,
              contractId: poolContractId,
            }),
          );
        }
      });
      if (!utxos.some(({ classification }) => classification === "pool-ft")) {
        throw new Error("Invalid canonical Pool-held FT state");
      }
      const ftInputs = context.ftInputs;
      if (!Array.isArray(ftInputs) || ftInputs.length !== 1) {
        throw new Error("Canonical Pool add requires one owner FT input");
      }
      const ftInput = record(ftInputs[0], "owner FT input");
      const ownerParent = parent(ftInput.preTxraw);
      const ownerVout = integer(ftInput.outputIndex, "owner FT output");
      const ownerNode = await options.client.getRawTransaction(
        ownerParent.txid,
      );
      const ownerOutput = parseTbcTransaction(ownerParent.rawTransaction)
        .outputs[ownerVout];
      const ownerFtScript = text(
        descriptor.ownerFtScript,
        "owner FT script",
      ).toLowerCase();
      if (
        ownerNode.rawTransaction !== ownerParent.rawTransaction ||
        ownerOutput === undefined ||
        bytesToHex(ownerOutput.scriptPubKey) !== ownerFtScript ||
        ownerOutput.satoshis.toString() !==
          uint(ftInput.satoshis, "owner FT value")
      ) {
        throw new Error("Invalid canonical Pool owner FT output");
      }
      utxos.push(
        Object.freeze({
          txid: ownerParent.txid,
          vout: ownerVout,
          satoshis: ownerOutput.satoshis.toString(),
          scriptPubKey: ownerFtScript,
          ...confirmationFields(ownerNode),
          classification: "ft" as const,
          contractId: ftContractId,
        }),
      );
      const rawParents: unknown[] = [
        context.poolPrePreTxraw,
        context.poolPreTxraw,
        ...authority.rawParents,
        context.feeParentTxraw,
        ftInput.preTxraw,
        ...(Array.isArray(ftInput.grandparentTxraws)
          ? ftInput.grandparentTxraws
          : []),
      ];
      const parents = freezeCanonicalPoolParents(rawParents.map(parent));
      const lpPlan = integer(descriptor.lpPlan, "LP plan");
      const serviceFeeRate = integer(
        descriptor.serviceFeeRate,
        "service fee rate",
      );
      const serviceProviderTag = text(
        descriptor.serviceProviderTag,
        "service provider",
      );
      const policy = createCanonicalPoolPolicy(
        { lpPlan, serviceProviderTag, serviceFeeRate },
        "Pool",
      );
      return Object.freeze({
        utxos: Object.freeze(utxos),
        parents,
        contracts: Object.freeze([
          Object.freeze({
            contractId: ftContractId,
            family: "ft" as const,
            protocolVersion: "4.0" as const,
            creationTxid: ftContractId,
          ...authority.ft,
            currentOutpoint: Object.freeze({
              txid: ownerParent.txid,
              vout: ownerVout,
            }),
          }),
          Object.freeze({
            contractId: poolContractId,
            family: "pool" as const,
            protocolVersion: "2.0" as const,
            creationTxid: poolContractId,
          ...authority.pool,
            currentOutpoint: Object.freeze({
              txid: currentPoolTxid,
              vout: currentPoolVout,
            }),
          }),
        ]),
        policy,
        review: Object.freeze({
          ftContractId,
          ftRequiredRaw: uint(preview.ftRequiredRaw, "required FT"),
          ftlpDeltaRaw: uint(preview.ftlpMintedRaw, "minted FT-LP"),
          lockTime: uint(preview.lockTime, "lock time"),
          feeFundingCapAtomic: uint(feeUtxo.satoshis, "fee funding cap"),
          poolBefore: amounts(preview.before, "Pool before"),
          poolAfter: amounts(preview.after, "Pool after"),
        }),
      });
    },
    async resolveLiquidityRemove(input: PoolLiquidityRemoveMaterialRequest) {
      const inspect =
        options.inspectTransaction ?? createPoolTransactionInspector();
      const parent = createParentReader(inspect);
      const parseTbcTransaction = (raw: string) => inspect(raw).transaction;
      const source = assertTbcAddress(input.address, options.p2pkhVersion ?? 0).address;
      const receiver = assertTbcAddress(input.receiver, options.p2pkhVersion ?? 0).address;
      const poolContractId = assertHash32(input.poolContractId.toLowerCase());
      const lpAmount = uint(input.lpAmount, "LP amount");
      if (BigInt(lpAmount) === 0n) {
        throw new Error("Pool LP amount must be positive");
      }
      const preparedValue = await options.load({
          operation: "consumeLp",
          addressFrom: source,
          contractId: poolContractId,
          receiver,
          lpAmount,
        });
      const prepared = record(preparedValue, "prepared remove material");
      const context = record(
        prepared.preparedContext,
        "prepared remove context",
      );
      const info = record(context.info, "remove information");
      const descriptor = record(
        context.canonicalDescriptor,
        "remove descriptor",
      );
      const feeUtxo = record(prepared.feeUtxo, "remove fee UTXO");
      const ftContractId = assertHash32(
        text(info.ftContractId, "remove FT contract").toLowerCase(),
      );
      const currentPoolTxid = assertHash32(
        text(info.txid, "remove current transaction").toLowerCase(),
      );
      const currentPoolVout = integer(info.vout, "remove current output");
      if (
        prepared.version !== 2 ||
        prepared.operation !== "consumeLp" ||
        prepared.contractId !== poolContractId ||
        prepared.receiver !== receiver ||
        uint(prepared.lpAmount, "prepared LP amount") !== lpAmount ||
        currentPoolVout !== 0
      ) {
        throw new Error("Invalid canonical Pool remove material binding");
      }
      const currentParent = parent(context.poolPreTxraw);
      const authority = poolAuthorityContext(context, ftContractId, poolContractId, parent);
      if (
        currentParent.txid !== currentPoolTxid
      ) {
        throw new Error("Invalid canonical Pool remove transaction identity");
      }
      const currentNode =
        await options.client.getRawTransaction(currentPoolTxid);
      if (currentNode.rawTransaction !== currentParent.rawTransaction) {
        throw new Error("Invalid canonical Pool remove current node identity");
      }
      const current = parseTbcTransaction(currentParent.rawTransaction);
      const poolOutput = current.outputs[currentPoolVout];
      const poolCodeScript = text(
        info.poolCodeScript,
        "remove code script",
      ).toLowerCase();
      if (
        poolOutput === undefined ||
        bytesToHex(poolOutput.scriptPubKey) !== poolCodeScript ||
        poolOutput.satoshis.toString() !==
          uint(info.value, "remove current value")
      ) {
        throw new Error("Invalid canonical Pool remove current output");
      }
      const poolFtScript = text(
        descriptor.poolFtScript,
        "remove Pool-held FT script",
      ).toLowerCase();
      const ftlpScript = text(
        descriptor.ftlpScript,
        "remove FT-LP script",
      ).toLowerCase();
      const ftInputs = context.ftInputs;
      const ftlpInputs = context.ftlpInputs;
      if (
        !Array.isArray(ftInputs) ||
        ftInputs.length === 0 ||
        !Array.isArray(ftlpInputs) ||
        ftlpInputs.length === 0
      ) {
        throw new Error("Canonical Pool remove requires FT and FT-LP inputs");
      }
      const utxos: PoolMaterialUtxo[] = [
        Object.freeze({
          txid: currentPoolTxid,
          vout: currentPoolVout,
          satoshis: poolOutput.satoshis.toString(),
          scriptPubKey: poolCodeScript,
          ...confirmationFields(currentNode),
          classification: "pool" as const,
          contractId: poolContractId,
        }),
      ];
      const rawParents: unknown[] = [
        context.poolPrePreTxraw,
        context.poolPreTxraw,
        ...authority.rawParents,
        context.feeParentTxraw,
      ];
      let selectedPoolFtOutpoint:
        | Readonly<{ txid: string; vout: number }>
        | undefined;
      let selectedLpAmount = 0n;
      for (const [classification, script, inputs] of [
        ["pool-ft", poolFtScript, ftInputs],
        ["ftlp", ftlpScript, ftlpInputs],
      ] as const) {
        for (const value of inputs) {
          const selected = record(value, `remove ${classification} input`);
          const selectedParent = parent(selected.preTxraw);
          const selectedVout = integer(
            selected.outputIndex,
            `remove ${classification} output`,
          );
          const selectedNode = await options.client.getRawTransaction(
            selectedParent.txid,
          );
          const selectedOutput = parseTbcTransaction(
            selectedParent.rawTransaction,
          ).outputs[selectedVout];
          if (
            selectedNode.rawTransaction !== selectedParent.rawTransaction ||
            selectedOutput === undefined ||
            bytesToHex(selectedOutput.scriptPubKey) !== script ||
            selectedOutput.satoshis.toString() !==
              uint(selected.satoshis, `remove ${classification} value`)
          ) {
            throw new Error(
              `Invalid canonical Pool remove ${classification} output`,
            );
          }
          const outpoint = Object.freeze({
            txid: selectedParent.txid,
            vout: selectedVout,
          });
          if (
            classification === "pool-ft" &&
            selectedPoolFtOutpoint === undefined
          ) {
            selectedPoolFtOutpoint = outpoint;
          }
          if (classification === "ftlp") {
            selectedLpAmount += BigInt(
              uint(selected.balance, "remove LP balance"),
            );
          }
          utxos.push(
            Object.freeze({
              ...outpoint,
              satoshis: selectedOutput.satoshis.toString(),
              scriptPubKey: script,
              ...confirmationFields(selectedNode),
              classification,
              contractId: poolContractId,
            }),
          );
          rawParents.push(
            selected.preTxraw,
            ...(Array.isArray(selected.grandparentTxraws)
              ? selected.grandparentTxraws
              : []),
          );
        }
      }
      if (
        selectedPoolFtOutpoint === undefined ||
        selectedLpAmount < BigInt(lpAmount)
      ) {
        throw new Error("Invalid canonical Pool remove selected balance");
      }
      if (
        new Set(utxos.map(({ txid, vout }) => `${txid}:${vout}`)).size !==
        utxos.length
      ) {
        throw new Error("Duplicate canonical Pool remove outpoint");
      }
      const parents = freezeCanonicalPoolParents(rawParents.map(parent));
      const lpPlan = integer(descriptor.lpPlan, "remove LP plan");
      const serviceFeeRate = integer(
        descriptor.serviceFeeRate,
        "remove service fee rate",
      );
      const serviceProviderTag = text(
        descriptor.serviceProviderTag,
        "remove service provider",
      );
      const policy = createCanonicalPoolPolicy(
        { lpPlan, serviceProviderTag, serviceFeeRate },
        "Pool remove",
      );
      return Object.freeze({
        utxos: Object.freeze(utxos),
        parents,
        contracts: Object.freeze([
          Object.freeze({
            contractId: ftContractId,
            family: "ft" as const,
            protocolVersion: "4.0" as const,
            creationTxid: ftContractId,
          ...authority.ft,
            currentOutpoint: selectedPoolFtOutpoint,
          }),
          Object.freeze({
            contractId: poolContractId,
            family: "pool" as const,
            protocolVersion: "2.0" as const,
            creationTxid: poolContractId,
          ...authority.pool,
            currentOutpoint: Object.freeze({
              txid: currentPoolTxid,
              vout: currentPoolVout,
            }),
          }),
        ]),
        policy,
        review: Object.freeze({
          ftContractId,
          lpAmountRaw: lpAmount,
          currentLockTime: uint(
            prepared.currentLockTime,
            "remove current lock time",
          ),
          feeFundingCapAtomic: uint(feeUtxo.satoshis, "remove fee funding cap"),
          poolBefore: amounts(context.poolBefore, "Pool remove before"),
        }),
      });
    },
    resolveSwapTbcForToken(
      input: PoolSwapTbcForTokenMaterialRequest,
      _funding?: LegacyPoolFundingSource,
    ) {
      return resolveSwap(input, "swapToToken");
    },
    resolveSwapTokenForTbc(
      input: PoolSwapTokenForTbcMaterialRequest,
      _funding?: LegacyPoolFundingSource,
    ) {
      return resolveSwap(input, "swapToTbc");
    },
    resolvePoolFtMerge(input: PoolMergeMaterialRequest) {
      return resolveMerge(input, "mergePoolFt");
    },
    resolveFtlpMerge(input: PoolMergeMaterialRequest) {
      return resolveMerge(input, "mergeFtlp");
    },
    resolveFtlpBurn(input: PoolMergeMaterialRequest) {
      return resolveMerge(input, "burnFtlp");
    },
  });
}

/** One LP preparation only: collapse duplicate parent reads across its two loaders.
 * Fresh scopes never reuse mutable confirmations or cache index/UTXO responses.
 */
export function createPoolMaterialTransactionReader(
  client: Pick<TestnetClient, "getRawTransaction" | "getRawTransactionBytes">,
  readTipHeight?: () => Promise<string | undefined>,
  readIndexedHeight?: (txid: string) => Promise<string | undefined>,
  inspectTransaction: typeof inspectTbcTransaction = inspectTbcTransaction,
  readSelectedParentBytes?: (txid: string) => Promise<string | undefined>,
  confirmationPolicy?: Readonly<PoolMaterialConfirmationPolicy>,
): PoolMaterialClient["getRawTransaction"] & {
  readonly readBytes: (txid: string) => Promise<string>;
  readonly observeHeight: (txid: string, height: string) => void;
} {
  const normalizedConfirmationPolicy = confirmationPolicy === undefined
    ? undefined
    : normalizePoolMaterialConfirmationPolicy(confirmationPolicy);
  const skipConfirmationRead =
    normalizedConfirmationPolicy?.minConfirmations === "0";
  const reads = new Map<
    string,
    ReturnType<PoolMaterialClient["getRawTransaction"]>
  >();
  const rawReads = new Map<string, Promise<string>>();
  const heights = new Map<string, string>();
  const loadBytes = (
    id: string,
    allowSelectedParent = false,
  ): Promise<string> => {
    let pending = rawReads.get(id);
    if (!pending) {
      if (rawReads.size >= 32)
        rawReads.delete(rawReads.keys().next().value as string);
      const created: Promise<string> = (async () => {
        const supplied = allowSelectedParent
          ? await readSelectedParentBytes?.(id)
          : undefined;
        if (supplied !== undefined) {
          if (inspectTransaction(supplied).txid !== id)
            throw new Error("Invalid selected Pool funding parent identity");
          return supplied;
        }
        if (client.getRawTransactionBytes)
          return await client.getRawTransactionBytes(id);
        return (await client.getRawTransaction(id)).rawTransaction;
      })();
      pending = created;
      rawReads.set(id, pending);
      void pending.catch(() => {
        if (rawReads.get(id) === pending) rawReads.delete(id);
      });
    }
    return pending;
  };
  async function loadFromVerifiedBytes(id: string, confirmations?: string) {
    const rawTransaction = await loadBytes(id, true);
    const inspected = inspectTransaction(rawTransaction);
    if (inspected.txid !== id)
      throw new Error("Invalid Pool indexed transaction identity");
    return Object.freeze({
      txid: id,
      rawTransaction,
      ...(confirmations === undefined ? {} : { confirmations }),
      inputs: inspected.transaction.inputs.map(({ txid, vout }) => ({
        txid,
        vout,
      })),
      outputs: inspected.transaction.outputs.map((output, vout) => ({
        vout,
        satoshis: output.satoshis.toString(),
        scriptPubKey: bytesToHex(output.scriptPubKey),
        addresses: [] as string[],
      })),
    });
  }
  async function readConfirmations(id: string, stillUseful = () => true) {
    const observedHeight = heights.get(id);
    const nativeHeight = await readIndexedHeight?.(id);
    if (
      observedHeight !== undefined &&
      nativeHeight !== undefined &&
      observedHeight !== nativeHeight
    )
      throw new Error("Conflicting Pool indexed height");
    const height = observedHeight ?? nativeHeight;
    const h = height === undefined ? undefined : BigInt(uint(height, "Pool indexed height"));
    if (!stillUseful()) return undefined;
    const tip =
      height !== undefined && client.getRawTransactionBytes && readTipHeight
        ? await readTipHeight()
        : undefined;
    if (h === undefined || tip === undefined) return undefined;
    const t = BigInt(uint(tip, "same-request tip height"));
    if (h > t) throw new Error("Invalid Pool indexed height");
    return h === 0n ? "0" : (t - h + 1n).toString();
  }
  async function loadNode(id: string) {
    if (!skipConfirmationRead) {
      const confirmations = await readConfirmations(id);
      return confirmations === undefined
        ? client.getRawTransaction(id)
        : loadFromVerifiedBytes(id, confirmations);
    }
    // Zero-floor construction may reuse metadata ready with the required bytes,
    // but must not wait for it. Parent identity/reuse still runs in loadBytes.
    let metadataOpen = true;
    let observed:
      | { count: string | undefined; failed: false }
      | { error: unknown; failed: true }
      | undefined;
    void readConfirmations(id, () => metadataOpen).then(
      (count) => { observed = { count, failed: false }; },
      (error: unknown) => { observed = { error, failed: true }; },
    );
    try {
      const node = await loadFromVerifiedBytes(id);
      if (observed?.failed) throw observed.error;
      return observed?.count === undefined
        ? node
        : Object.freeze({ ...node, confirmations: observed.count });
    } finally {
      // A late index cannot trigger a confirmation-only tip read or mutate the
      // delivered snapshot. Rejections are consumed by the handler above.
      metadataOpen = false;
    }
  }
  const read = async (txid: string) => {
    const id = assertHash32(txid.toLowerCase());
    let value = reads.get(id);
    if (!value) {
      if (reads.size >= 32) reads.delete(reads.keys().next().value as string);
      value = loadNode(id);
      reads.set(id, value);
    }
    try {
      return await value;
    } catch (error) {
      if (reads.get(id) === value) reads.delete(id);
      throw error;
    }
  };
  return Object.assign(read, {
    observeHeight(txid: string, height: string) {
      const id = assertHash32(txid.toLowerCase());
      const normalized = uint(height, "Pool indexed height");
      const previous = heights.get(id);
      if (previous !== undefined && previous !== normalized)
        throw new Error("Conflicting Pool indexed height");
      if (heights.size >= 256)
        heights.delete(heights.keys().next().value as string);
      heights.set(id, normalized);
    },
    async readBytes(txid: string): Promise<string> {
      const id = assertHash32(txid.toLowerCase());
      const decoded = reads.get(id);
      if (decoded) return (await decoded).rawTransaction;
      if (!client.getRawTransactionBytes)
        return (await read(id)).rawTransaction;
      const pending = loadBytes(id);
      try {
        return await pending;
      } catch (error) {
        if (rawReads.get(id) === pending) rawReads.delete(id);
        throw error;
      }
    },
  });
}

export async function createProductionPoolMaterialSource(options: {
  readonly native: PoolMaterialNativeProviderInput;
  readonly fetch?: typeof globalThis.fetch;
  readonly baseUrl?: string;
  readonly allowedOrigins?: readonly string[];
  readonly requestTimeoutMs?: number;
  readonly p2pkhVersion?: number;
  /** Wallet-owned only; omitted preserves exact node confirmation reads. */
  readonly confirmationPolicy?: Readonly<PoolMaterialConfirmationPolicy>;
}): Promise<PoolMaterialSource> {
  const fetch = options.fetch ?? globalThis.fetch;
  const native = createPoolMaterialNativeProvider(options.native);
  const baseUrl = options.baseUrl ?? OFFICIAL_TBC_TESTNET_API_ORIGIN;
  const allowedOrigins = options.allowedOrigins ?? [OFFICIAL_TBC_TESTNET_API_ORIGIN];
  const confirmationPolicy = options.confirmationPolicy === undefined
    ? undefined
    : normalizePoolMaterialConfirmationPolicy(options.confirmationPolicy);
  const info = JSON.parse(await native.protocolInfo()) as {
    readonly operations?: unknown;
  };
  const operations = info.operations;
  if (
    !Array.isArray(operations) ||
    !POOL_MATERIAL_NATIVE_OPERATIONS.every((operation) =>
      operations.includes(operation),
    )
  ) {
    throw new Error("Canonical Pool material capability is unavailable");
  }
  const inspectTransaction = createPoolTransactionInspector();
  const client = createTestnetClient({
    baseUrl,
    allowedOrigins,
    fetch,
    inspectTransaction,
    ...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
  });
  const liquidity = createPoolMaterialSource({
    client,
    ...(options.p2pkhVersion === undefined ? {} : { p2pkhVersion: options.p2pkhVersion }),
    load: createPoolMaterialLoader({
      fetch,
      native,
      baseUrl,
      allowedOrigins,
      ...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
    }),
  });
  // Reuse only verified immutable bytes, never confirmations or mutable indexes.
  // Wallet-runtime memory only; bound both entry count and retained hex size.
  const historyBytes = new Map<string, string>();
  let historySize = 0;
  function rememberTransaction(txid: string, raw: string) {
    if (typeof txid !== "string" || !/^[0-9a-f]{64}$/u.test(txid) || typeof raw !== "string" ||
        raw.length > MAX_RESPONSE_BYTES || !/^(?:[0-9a-f]{2})+$/u.test(raw) || inspectTransaction(raw).txid !== txid) {
      throw new Error("Invalid immutable Pool transaction handoff");
    }
    rememberVerifiedTransaction(txid, raw);
  }
  function rememberVerifiedTransaction(txid: string, raw: string) {
    const existing = historyBytes.get(txid);
    if (existing !== undefined) {
      if (existing !== raw) throw new Error("Conflicting immutable Pool transaction handoff");
      return;
    }
    while (historyBytes.size >= 32 || historySize + raw.length > MAX_RESPONSE_BYTES) {
      const oldest = historyBytes.keys().next().value!;
      historySize -= historyBytes.get(oldest)!.length;historyBytes.delete(oldest);
    }
    historyBytes.set(txid, raw);historySize += raw.length;
  }
  function scopedLiquidity(funding?: LegacyPoolFundingSource, reads?: PoolMaterialReadScope) {
    const inspectTransaction = createPoolTransactionInspector();
    const scopedClient = createTestnetClient({
      baseUrl,
      allowedOrigins,
      fetch,
      inspectTransaction,
      ...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
    });
    const readHistoryBytes = async (txid: string): Promise<string> => {
      const cached = historyBytes.get(txid);
      if (cached !== undefined) {
        if (inspectTransaction(cached).txid !== txid)
          throw new Error("Invalid cached Pool transaction identity");
        historyBytes.delete(txid);
        historyBytes.set(txid, cached);
        return cached;
      }
      const raw = await scopedClient.getRawTransactionBytes?.(txid);
      if (raw === undefined) throw new Error("Pool raw reader unavailable");
      if (raw.length <= MAX_RESPONSE_BYTES && !historyBytes.has(txid)) {
        if (inspectTransaction(raw).txid !== txid) throw new Error("Invalid Pool transaction identity");
        rememberVerifiedTransaction(txid, raw);
      }
      return raw;
    };
    // Height metadata needs the fresh index, not the selected fee parent's raw.
    // Retain compatibility with private callers that supply complete funding.
    let indexRead:
      | Promise<
          | (Pick<LegacyPoolFunding, "tipHeight" | "indexedHeights"> &
              Readonly<{ selectedParentTxid?: string }>)
          | undefined
        >
      | undefined;
    const readIndex = () => {
      if (!indexRead) {
        indexRead =
          typeof funding === "function"
            ? funding.readIndex
              ? funding.readIndex()
              : funding()
            : Promise.resolve(funding);
      }
      return indexRead;
    };
    const getRawTransaction = createPoolMaterialTransactionReader(
      { ...scopedClient, getRawTransactionBytes: readHistoryBytes },
      async () => (await readIndex())?.tipHeight,
      async (txid) => (await readIndex())?.indexedHeights?.[txid],
      inspectTransaction,
      async (txid) => {
        const index = await readIndex();
        const selectedTxid =
          typeof funding === "function"
            ? index?.selectedParentTxid
            : funding?.txid;
        if (selectedTxid !== txid) return undefined;
        const selected =
          typeof funding === "function" ? await funding() : funding;
        if (selected?.txid !== txid)
          throw new Error("Conflicting selected Pool funding parent");
        return selected.rawTransaction;
      },
      confirmationPolicy,
    );
    const materialClient = {
      ...scopedClient,
      getRawTransaction,
      getRawTransactionBytes: getRawTransaction.readBytes,
    };
    const material = createPoolMaterialSource({
      client: materialClient,
      inspectTransaction,
      ...(options.p2pkhVersion === undefined ? {} : { p2pkhVersion: options.p2pkhVersion }),
      load: createPoolMaterialLoader({
        fetch,
        native,
        baseUrl,
        allowedOrigins,
        ...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
        purpose: "public-material",
        ...(reads === undefined ? {} : { readPoolInfo: reads.poolInfo }),
        ...(reads?.ftInfo === undefined ? {} : { readFtInfo: reads.ftInfo }),
        inspectTransaction,
        ...(funding ? { funding } : {}),
        readRawTransaction: async (txid) =>
          (await getRawTransaction(txid)).rawTransaction,
        readHistoricalTransaction: getRawTransaction.readBytes,
        observeIndexedHeight: getRawTransaction.observeHeight,
      }),
    });
    return Object.freeze({
      ...material,
      resolveCreateInitialize: createPoolInitializeMaterialResolver({
        client: materialClient, fetch, native, inspectTransaction, baseUrl,
        ...(options.p2pkhVersion === undefined ? {} : { p2pkhVersion: options.p2pkhVersion }),
      }),
    });
  }
  return Object.freeze({
    ...(confirmationPolicy === undefined ? {} : { confirmationPolicy }),
    ...liquidity,
    rememberTransaction,
    resolveLiquidityAdd: (
      input: PoolMaterialRequest,
      funding?: LegacyPoolFundingSource,
      reads?: PoolMaterialReadScope,
    ) => scopedLiquidity(funding, reads).resolveLiquidityAdd(input),
    resolveLiquidityRemove: (
      input: PoolLiquidityRemoveMaterialRequest,
      funding?: LegacyPoolFundingSource,
      reads?: PoolMaterialReadScope,
    ) => {
      const resolve = scopedLiquidity(funding, reads).resolveLiquidityRemove;
      if (!resolve) throw new Error("Canonical Pool remove is unavailable");
      return resolve(input);
    },
    resolveCreateInitialize: createPoolInitializeMaterialResolver({
      client,
      fetch,
      native,
      inspectTransaction,
      baseUrl,
      ...(options.p2pkhVersion === undefined ? {} : { p2pkhVersion: options.p2pkhVersion }),
    }),
    resolvePoolFtMerge: (
      input: PoolMergeMaterialRequest,
      funding?: LegacyPoolFundingSource,
      reads?: PoolMaterialReadScope,
    ) => scopedLiquidity(funding, reads).resolvePoolFtMerge!(input),
    resolveFtlpMerge: (
      input: PoolMergeMaterialRequest,
      funding?: LegacyPoolFundingSource,
      reads?: PoolMaterialReadScope,
    ) => scopedLiquidity(funding, reads).resolveFtlpMerge!(input),
    resolveFtlpBurn: (
      input: PoolMergeMaterialRequest,
      funding?: LegacyPoolFundingSource,
      reads?: PoolMaterialReadScope,
    ) => scopedLiquidity(funding, reads).resolveFtlpBurn!(input),
    // A confirmation floor changes freshness reads, not contract authority.
    // Both swap modes use the same indexed material and scoped raw-byte cache.
    resolveSwapTbcForToken: (
      input: PoolSwapTbcForTokenMaterialRequest,
      funding?: LegacyPoolFundingSource,
      reads?: PoolMaterialReadScope,
    ) => scopedLiquidity(funding, reads).resolveSwapTbcForToken!(input, funding),
    resolveSwapTokenForTbc: (
      input: PoolSwapTokenForTbcMaterialRequest,
      funding?: LegacyPoolFundingSource,
      reads?: PoolMaterialReadScope,
    ) => scopedLiquidity(funding, reads).resolveSwapTokenForTbc!(input, funding),
    ...(confirmationPolicy?.minConfirmations !== "0" ? {} : {
      resolveCreateInitialize: (input: PoolCreateInitializeMaterialRequest) =>
        scopedLiquidity().resolveCreateInitialize(input),
    }),
  });
}

/** Synchronous wallet composition facade; capability negotiation remains lazy
 * and is shared by every Pool request in this runtime. */
export function createLazyProductionPoolMaterialSource(options: {
  readonly native: PoolMaterialNativeProviderInput;
  readonly fetch?: typeof globalThis.fetch;
  readonly baseUrl?: string;
  readonly allowedOrigins?: readonly string[];
  readonly requestTimeoutMs?: number;
  readonly p2pkhVersion?: number;
  /** Wallet-owned only; omitted preserves exact node confirmation reads. */
  readonly confirmationPolicy?: Readonly<PoolMaterialConfirmationPolicy>;
}): PoolMaterialSource {
  const confirmationPolicy = options.confirmationPolicy === undefined
    ? undefined
    : normalizePoolMaterialConfirmationPolicy(options.confirmationPolicy);
  let source: Promise<PoolMaterialSource> | undefined;
  const read = () => source ??= createProductionPoolMaterialSource({
    ...options,
    ...(confirmationPolicy === undefined ? {} : { confirmationPolicy }),
  });
  return Object.freeze({
    rememberTransaction: async (txid: string, rawTransaction: string) => {
      await (await read()).rememberTransaction!(txid, rawTransaction);
    },
    ...(confirmationPolicy === undefined ? {} : { confirmationPolicy }),
    warmup: async () => {
      await read();
    },
    readMergeIndex: async (
      input: PoolMergeMaterialRequest & Readonly<{ kind: PoolMergeIndexKind }>,
    ) => {
      const resolve = (await read()).readMergeIndex;
      if (resolve === undefined) throw new Error("Canonical Pool merge index is unavailable");
      return resolve(input);
    },
    resolveLiquidityAdd: async (input: PoolMaterialRequest, funding?: LegacyPoolFundingSource, reads?: PoolMaterialReadScope) => (await read()).resolveLiquidityAdd(input, funding, reads),
    resolveLiquidityRemove: async (input: PoolLiquidityRemoveMaterialRequest, funding?: LegacyPoolFundingSource, reads?: PoolMaterialReadScope) => {
      const resolve = (await read()).resolveLiquidityRemove;
      if (resolve === undefined) throw new Error("Canonical Pool remove is unavailable");
      return resolve(input, funding, reads);
    },
    resolveCreateInitialize: async (input: PoolCreateInitializeMaterialRequest) => {
      const resolve = (await read()).resolveCreateInitialize;
      if (resolve === undefined) throw new Error("Canonical Pool initialize is unavailable");
      return resolve(input);
    },
    resolveSwapTbcForToken: async (
      input: PoolSwapTbcForTokenMaterialRequest,
      funding?: LegacyPoolFundingSource,
      reads?: PoolMaterialReadScope,
    ) => {
      const resolve = (await read()).resolveSwapTbcForToken;
      if (resolve === undefined) throw new Error("Canonical Pool buy is unavailable");
      return resolve(input, funding, reads);
    },
    resolveSwapTokenForTbc: async (
      input: PoolSwapTokenForTbcMaterialRequest,
      funding?: LegacyPoolFundingSource,
      reads?: PoolMaterialReadScope,
    ) => {
      const resolve = (await read()).resolveSwapTokenForTbc;
      if (resolve === undefined) throw new Error("Canonical Pool sell is unavailable");
      return resolve(input, funding, reads);
    },
    resolvePoolFtMerge: async (input: PoolMergeMaterialRequest, funding?: LegacyPoolFundingSource, reads?: PoolMaterialReadScope) => {
      const resolve = (await read()).resolvePoolFtMerge;
      if (resolve === undefined) throw new Error("Canonical Pool FT merge is unavailable");
      return resolve(input, funding, reads);
    },
    resolveFtlpMerge: async (input: PoolMergeMaterialRequest, funding?: LegacyPoolFundingSource, reads?: PoolMaterialReadScope) => {
      const resolve = (await read()).resolveFtlpMerge;
      if (resolve === undefined) throw new Error("Canonical FTLP merge is unavailable");
      return resolve(input, funding, reads);
    },
    resolveFtlpBurn: async (input: PoolMergeMaterialRequest, funding?: LegacyPoolFundingSource, reads?: PoolMaterialReadScope) => {
      const resolve = (await read()).resolveFtlpBurn;
      if (resolve === undefined) throw new Error("Canonical FTLP burn is unavailable");
      return resolve(input, funding, reads);
    },
  });
}
