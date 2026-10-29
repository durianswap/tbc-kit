import {
  assertValidTws,
  base64urlEncode,
  bytesToHex,
  hashCanonical,
  canonicalize,
  hexToBytes,
  resolveTransactionSigningAccounts,
  assertTransactionSigningSnapshot,
  resolveWorkflowSigningAccounts,
  type TransactionRoleRequest,
  type TransactionRoleAccount,
  type ChainDataRequirement,
} from "@tbc-wallet/core";
import type { KitWalletAccount } from "./wallet-runtime.js";
import { createChainDataReadScope } from "./chain-data-read-scope.js";
import { identifyTbcFungibleContracts, identifyTbcFungibleOrigin, identifyTbcNftOrigin, identifyTbcPoolOrigin, type TbcFungibleOriginHint, type TbcNftOriginHint, type TbcPoolOriginHint } from "./contract-identification.js";
import { inspectReviewedTokenCodes } from "./reviewed-token.js";
import { NftMaterialUnavailableError, resolveNftMaterial } from "./nft-material.js";
import { prepareTbcNftMintJobMaterial, type TbcNftMintJobMaterial } from "./nft-mint-job-material.js";
import type { TbcNftMintJobScope } from "./nft-mint-job.js";
import { resolveCoinManagementMaterial } from "./coin-management-material.js";
import { resolveTimelockMaterial } from "./timelock-material.js";
import { resolveHtlcMaterial } from "./htlc-material.js";
import { resolveHtlcTokenMaterial } from "./htlc-token-material.js";
import { resolveLopMaterial } from "./lop-material.js";
import { resolveAmmCreateMaterial, resolveLpMaterial } from "./amm-material.js";
import { resolveAmmBusinessMaterial, type AmmMaterialAction } from "./amm-business-material.js";
import type { PoolMaterialNativeProviderInput } from "./pool-material-native.js";
import { TbcTransportError } from "./network-transport.js";
import {
  assertTbcNetworkContext,
  createTbcNetworkContext,
  type TbcNetworkContext,
} from "./network-context.js";
import type {
  TestnetClient,
  TestnetFtUtxo,
  TestnetRawTransaction,
  TestnetTip,
  TestnetUtxo,
} from "./testnet-client.js";
import { isTestnetNodeError } from "./testnet-client.js";
import type { LegacyPoolFunding } from "./pool-signing-loader.js";
import type {
  PoolCreateInitializeMaterial,
  PoolCreateInitializeMaterialRequest,
  PoolLiquidityRemoveMaterial,
  PoolMaterial,
  PoolMaterialConfirmationPolicy,
  PoolMergeMaterial,
  PoolMaterialSource,
  PoolSnapshotMaterial,
  PoolSwapMaterial,
} from "./pool-material.js";
import { normalizePoolMaterialConfirmationPolicy } from "./pool-material.js";
import {
  assertTbcAddress,
  inspectTbcTransaction,
  type ParsedTbcTransaction,
} from "./testnet-validation.js";

const MAX_FT_ASSET_INPUTS = 5;
const MAX_TBC20_INPUTS = 6;
const MAX_TBC20_ASSET_INPUTS = 128;
const MAX_STABLECOIN_ASSET_INPUTS = 500;
const MAX_STABLECOIN_ANCESTRY_TRANSACTIONS = 1_024;
const MAX_TBC_MERGE_INPUTS = 500;
// Automatic AMM fee funding is not a public consolidation request.
const MAX_AMM_FUNDING_INPUTS = 100;
const MAX_NATIVE_UTXO_CANDIDATES = 256;
const DEFAULT_MAX_INPUTS = 128;
const DEFAULT_SNAPSHOT_TTL_MS = 120_000;
const FEE_RATE_SAT_PER_KB = 80n;
const DUST_THRESHOLD = 24n;
const ZERO_TXID = "0".repeat(64);
const TAPE_PREFIX = Uint8Array.from([0x00, 0x6a, 0x30]);
const TAPE_MARKER = new TextEncoder().encode("FTape");
const TBC20_TAPE_MARKER = new TextEncoder().encode("TBC20TAPE");
const TBC20_TEMPLATE_REVISION = "0f5db33bb46e4517963cbd383518f74283b5c2c4efb0a733522a1fbc0d4a9f84";
const COIN_TEMPLATE_REVISION = "c686fc271f0ee8116325bf541d87c4d2e6ad839896a9d9dd21dcf2ac847660e3";

// Role scope is not authority: accounts still come from trusted Host resolution.
function validSigningRoleScope(roles: TransactionRoleRequest["signingRoles"], intentType: string): boolean {
  if (roles === undefined) return true;
  if (roles.length !== 1) return false;
  if (roles[0]?.role === "pool-controller") return ["tbc-amm-add-liquidity", "tbc-amm-remove-liquidity", "tbc-amm-swap", "amm.swap", "amm.addLiquidity", "amm.removeLiquidity"].includes(intentType);
  return roles[0]?.role === "coin-admin" && ["tbc20-stablecoin-create", "tbc20-stablecoin-mint", "tbc20-stablecoin-freeze", "tbc20-stablecoin-unfreeze"].includes(intentType);
}

type RequirementAsset = Readonly<{
  kind: string;
  contractId?: string;
  minimumAmount?: string;
  contractDependency?: Readonly<{ contractId: string; relation: string }>;
}>;

type ChainDataParams = Readonly<{
  version: string;
  accountId: string;
  chainId: string;
  signingRoles?: TransactionRoleRequest["signingRoles"];
  signingAccounts?: readonly TransactionRoleAccount[];
  workflowSteps?: readonly Readonly<{
    stepId: string;
    requirement: ChainDataParams["requirement"];
    signingRoles?: TransactionRoleRequest["signingRoles"];
    signingAccounts?: readonly TransactionRoleAccount[];
  }>[];
  requirement: Readonly<{
    assets: readonly RequirementAsset[];
    contractIds?: readonly string[];
    includeAncestry: boolean;
    intentType: string;
    nativeAmount?: string;
    collectionSlots?: readonly number[];
    targetOutpoints?: readonly Readonly<{ txid: string; vout: number }>[];
    certificateOutpoint?: Readonly<{ txid: string; vout: number }>;
    inputOutpoints?: readonly Readonly<{ txid: string; vout: number }>[];
  }>;
}>;

type TransactionMaterial = Readonly<{
  txid: string;
  rawTransaction: string;
  inputs: readonly Readonly<{ txid: string; vout: number }>[];
  outputs: readonly Readonly<{
    vout: number;
    satoshis: string;
    scriptPubKey: string;
  }>[];
  confirmations?: string;
}>;

export interface DefaultTbcChainDataResolver {
  readonly network: TbcNetworkContext;
  /** The account is supplied by Kit after session binding when available. */
  readonly resolve: (params: unknown, account?: KitWalletAccount) => Promise<unknown>;
  /** Private bounded job scope; no cross-request mutable cache or background work. */
  readonly prepareNftMintJob: (scope: TbcNftMintJobScope, account: KitWalletAccount) => Promise<TbcNftMintJobMaterial>;
  /** Private read-plan selection, bound to this exact unexpired snapshot. */
  readonly readUnifiedIntent: (binding: Readonly<{
    snapshotHash: string; chainId: string; from: string; contractId: string; intentType: string;
  }>) => string | undefined;
  readonly readPoolPolicy: (binding: Readonly<{
    snapshotHash: string;
    chainId: string;
    sourceIdentity?: string;
    from: string;
    poolContractId: string;
  }>) => PoolMaterial["policy"] | undefined;
  readonly rememberFinalizedTransaction: (transaction: Readonly<{ txid: string; rawTransaction: string }>) => void;
}

export interface CreateDefaultTbcChainDataOptions {
  readonly accounts: Readonly<{ current: () => Promise<readonly KitWalletAccount[]> }>;
  readonly client: TestnetClient;
  /** Immutable chain and endpoint identity. Omission preserves the legacy Testnet default. */
  readonly network?: TbcNetworkContext;
  readonly now?: () => number;
  readonly snapshotId?: () => string | Promise<string>;
  /** Input budget; FT transfer/merge funding candidates are alternatives, not selected inputs. */
  readonly maxInputs?: number;
  readonly snapshotTtlMs?: number;
  readonly inspectTransaction?: typeof inspectTbcTransaction;
  readonly poolMaterial?: PoolMaterialSource;
  /** Shared keyless codec, also used by the existing Pool material source. */
  readonly materialNative?: PoolMaterialNativeProviderInput;
  /** Wallet-owned read requirement; omission preserves exact reads. */
  readonly confirmationPolicy?: Readonly<PoolMaterialConfirmationPolicy>;
  readonly rememberPoolSnapshotMaterial?: (value: PoolSnapshotMaterial) => void;
}

class ChainDataAuthorizationError extends Error {}
class ChainDataConflictError extends Error {}

function failure(
  name: "INVALID_INPUT" | "UNAUTHORIZED" | "UNAVAILABLE" | "CONFLICT",
  retryable = false,
) {
  return Object.freeze({
    portError: Object.freeze({
      name,
      retryable,
      message: name === "UNAVAILABLE"
        ? "TBC chain data is temporarily unavailable"
        : "TBC chain data could not be verified for the configured network",
    }),
  });
}

function record(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`Invalid ${label}`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function positive(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/u.test(value)) {
    throw new ChainDataConflictError(`Invalid ${label}`);
  }
  return BigInt(value);
}

function canonicalTime(value: number): string {
  if (!Number.isFinite(value)) throw new ChainDataConflictError("Invalid chain data clock");
  return new Date(value).toISOString();
}

function randomSnapshotId(): string {
  const bytes = new Uint8Array(18);
  if (globalThis.crypto?.getRandomValues === undefined) throw new Error("A secure random source is required");
  globalThis.crypto.getRandomValues(bytes);
  return `snapshot-${base64urlEncode(bytes)}`;
}

function startsWith(value: Uint8Array, prefix: Uint8Array): boolean {
  return prefix.every((byte, index) => value[index] === byte);
}

function endsWith(value: Uint8Array, suffix: Uint8Array): boolean {
  const offset = value.length - suffix.length;
  return offset >= 0 && suffix.every((byte, index) => value[offset + index] === byte);
}

/** Exact TypeScript equivalent of Mobile Rust prepareAssetAncestry phase=inspect. */
export function inspectFtAncestryReferences(
  transaction: ParsedTbcTransaction,
  outputIndex: number,
): readonly Readonly<{ txid: string; outputIndex: number; inputIndex: number }>[] {
  const tape = transaction.outputs[outputIndex + 1];
  if (
    tape === undefined ||
    tape.satoshis !== 0n ||
    tape.scriptPubKey.length < 56 ||
    !startsWith(tape.scriptPubKey, TAPE_PREFIX) ||
    !endsWith(tape.scriptPubKey, TAPE_MARKER)
  ) {
    throw new ChainDataConflictError("FT parent Tape is invalid");
  }
  const amounts = tape.scriptPubKey.slice(3, 51);
  const references: Readonly<{ txid: string; outputIndex: number; inputIndex: number }>[] = [];
  for (let inputIndex = 5; inputIndex >= 0; inputIndex -= 1) {
    const slot = amounts.slice(inputIndex * 8, inputIndex * 8 + 8);
    if (slot.every((byte) => byte === 0)) continue;
    const input = transaction.inputs[inputIndex];
    if (input === undefined) throw new ChainDataConflictError("FT Tape references a missing input");
    references.push(Object.freeze({ txid: input.txid, outputIndex: input.vout, inputIndex }));
  }
  if (references.length === 0) throw new ChainDataConflictError("FT Tape has no source reference");
  return Object.freeze(references);
}

function selectFtCandidates(candidates: readonly TestnetFtUtxo[], minimumAmount: bigint, maxInputs: number): readonly TestnetFtUtxo[] {
  if (maxInputs < 1) throw new ChainDataConflictError("FT input count exceeds policy");
  const single = [...candidates]
    .filter((candidate) => BigInt(candidate.ftAmount) > 0n && BigInt(candidate.ftAmount) >= minimumAmount)
    .sort((left, right) =>
      (BigInt(left.ftAmount) < BigInt(right.ftAmount) ? -1 : BigInt(left.ftAmount) > BigInt(right.ftAmount) ? 1 : 0) ||
      left.txid.localeCompare(right.txid) || left.vout - right.vout,
    )[0];
  const selected: TestnetFtUtxo[] = single === undefined ? [] : [single];
  if (single === undefined) {
    const sorted = [...candidates].filter(candidate => BigInt(candidate.ftAmount) > 0n).sort((left, right) =>
      (BigInt(left.ftAmount) > BigInt(right.ftAmount) ? -1 : BigInt(left.ftAmount) < BigInt(right.ftAmount) ? 1 : 0) ||
      left.txid.localeCompare(right.txid) || left.vout - right.vout,
    );
    let amount = 0n;
    for (const candidate of sorted) {
      if (selected.length >= maxInputs || amount >= minimumAmount) break;
      selected.push(candidate);
      amount += BigInt(candidate.ftAmount);
    }
  }
  // Five is the per-transaction contract limit, not a whole-plan limit.
  // Engine owns maintenance → primary construction. Read only the selected
  // plan inputs; never fetch all holder parents to work around fragmentation.
  if (selected.length === 0 || selected.reduce((sum, item) => sum + BigInt(item.ftAmount), 0n) < minimumAmount) {
    throw new ChainDataConflictError("FT transfer requires an asset merge or more balance");
  }
  return Object.freeze(selected);
}

/** Read hints only; the Engine authenticates Code identity, owner and full Tape. */
export function inspectTbc20AncestryReferences(
  transaction: ParsedTbcTransaction,
  outputIndex: number,
): readonly Readonly<{ txid: string; outputIndex: number; inputIndex: number }>[] {
  const code = transaction.outputs[outputIndex];
  const tape = transaction.outputs[outputIndex + 1];
  if (transaction.inputs.length < 1 || transaction.inputs.length > 6 ||
      code?.satoshis !== 500n || tape?.satoshis !== 0n ||
      tape.scriptPubKey.length < 61 || tape.scriptPubKey.length > 127 ||
      !startsWith(tape.scriptPubKey, TAPE_PREFIX) || !endsWith(tape.scriptPubKey, TBC20_TAPE_MARKER)) {
    throw new ChainDataConflictError("TBC20 parent Code/Tape read material is invalid");
  }
  const references: Readonly<{ txid: string; outputIndex: number; inputIndex: number }>[] = [];
  for (let inputIndex = 5; inputIndex >= 0; inputIndex -= 1) {
    const slot = tape.scriptPubKey.subarray(3 + inputIndex * 8, 11 + inputIndex * 8);
    if ((slot[7]! & 0x80) !== 0) throw new ChainDataConflictError("TBC20 slot exceeds signed-64 bound");
    if (slot.every((byte) => byte === 0)) continue;
    const input = transaction.inputs[inputIndex];
    if (input === undefined) throw new ChainDataConflictError("TBC20 Tape references a missing input");
    references.push(Object.freeze({ txid: input.txid, outputIndex: input.vout, inputIndex }));
  }
  if (references.length === 0) throw new ChainDataConflictError("TBC20 Tape has no source reference");
  return Object.freeze(references);
}

/** Read hints only. Coin shares six amount slots but has a four-byte lock suffix. */
export function inspectCoinAncestryReferences(transaction: ParsedTbcTransaction, outputIndex: number) {
  const tape = transaction.outputs[outputIndex + 1]?.scriptPubKey;
  coinTapeLockTime(tape);
  return inspectTbc20AncestryReferences(transaction, outputIndex);
}

function coinTapeLockTime(tape: Uint8Array | undefined): number {
  if (tape === undefined || tape.length < 66 || tape.length > 127 ||
    !startsWith(tape, TAPE_PREFIX) || !endsWith(tape, TBC20_TAPE_MARKER) ||
    tape[tape.length - 15] !== 4 || tape[tape.length - 10] !== 9) {
    throw new ChainDataConflictError("Coin Tape lock envelope is invalid");
  }
  return new DataView(tape.buffer, tape.byteOffset + tape.length - 14, 4).getUint32(0, true);
}

function selectTbc20Candidates(
  candidates: readonly TestnetFtUtxo[], minimumAmount: bigint, merge: boolean,
  requested?: readonly Readonly<{ txid: string; vout: number }>[],
  limit = MAX_TBC20_ASSET_INPUTS,
): readonly TestnetFtUtxo[] {
  const seen = new Set<string>();
  const selected: TestnetFtUtxo[] = [];
  let total = 0n;
  for (const candidate of [...candidates].sort((a, b) => a.txid.localeCompare(b.txid) || a.vout - b.vout)) {
    const key = `${candidate.txid}:${candidate.vout}`;
    if (seen.has(key)) throw new ChainDataConflictError("Duplicate TBC20 index outpoint");
    seen.add(key);
    if (requested !== undefined && !requested.some((item) => item.txid === candidate.txid && item.vout === candidate.vout)) continue;
    if (!merge && requested === undefined && total >= minimumAmount) continue;
    if (selected.length === limit) throw new ChainDataConflictError("TBC20 asset material exceeds the bounded maintenance budget");
    total += positive(candidate.ftAmount, "TBC20 index amount");
    selected.push(candidate);
  }
  if (selected.length < (merge ? 2 : 1) || total < minimumAmount) throw new ChainDataConflictError("TBC20 inputs are insufficient");
  return Object.freeze(selected);
}

/** Bounded read selection only; Engine authenticates Code, issuer, owner and locks. */
async function prepareCoinCandidates(
  candidates: readonly TestnetFtUtxo[], minimumAmount: bigint, merge: boolean,
  requested: readonly Readonly<{ txid: string; vout: number }>[] | undefined,
  limit: number, read: (txid: string) => Promise<TransactionMaterial>,
  chainTip: () => Promise<TestnetTip>, administratorHash: Promise<string>, ownerHash: string,
  minimumConfirmations: bigint,
) {
  const seen = new Set<string>();
  const remaining = [...candidates].sort((a, b) => a.txid.localeCompare(b.txid) || a.vout - b.vout).filter((item) => {
    const key = `${item.txid}:${item.vout}`;
    if (seen.has(key)) throw new ChainDataConflictError("Duplicate Coin index outpoint");
    seen.add(key);
    return requested === undefined || requested.some((point) => point.txid === item.txid && point.vout === item.vout);
  });
  const selected: TestnetFtUtxo[] = [];
  const parents = new Map<string, TransactionMaterial>();
  let total = 0n, inspected = 0;
  while (remaining.length > 0 && (merge || requested !== undefined || total < minimumAmount)) {
    const batch: TestnetFtUtxo[] = [];
    let provisional = total;
    while (remaining.length > 0 && batch.length < Math.max(1, limit - selected.length)
      && (merge || requested !== undefined || provisional < minimumAmount)) {
      const candidate = remaining.shift()!;
      if (++inspected > DEFAULT_MAX_INPUTS) throw new ChainDataConflictError("Coin lock discovery exceeds bounded input budget");
      if (minimumConfirmations > 0n && candidate.height !== undefined) {
        const height = BigInt((await chainTip()).height), at = BigInt(candidate.height);
        if (at > height || at < 0n) throw new ChainDataConflictError("Coin index height is invalid");
        if ((at === 0n ? 0n : height - at + 1n) < minimumConfirmations) continue;
      }
      provisional += positive(candidate.ftAmount, "Coin index amount");
      batch.push(candidate);
    }
    await Promise.all([...new Set(batch.map((item) => item.txid))].map(async (txid) => {
      if (!parents.has(txid)) parents.set(txid, await read(txid));
    }));
    for (const candidate of batch) {
      const parent = parents.get(candidate.txid)!;
      if (minimumConfirmations > 0n && candidate.height === undefined) {
        if (parent.confirmations === undefined) throw new ChainDataConflictError("Coin confirmations are unknown");
        if (BigInt(parent.confirmations) < minimumConfirmations) continue;
      }
      const code = parent.outputs[candidate.vout], tape = parent.outputs[candidate.vout + 1];
      if (code?.satoshis !== "500" || tape?.satoshis !== "0") throw new ChainDataConflictError("Coin Code/Tape values differ");
      const lock = coinTapeLockTime(hexToBytes(tape.scriptPubKey));
      if (lock !== 0) {
        const admin = await administratorHash;
        const adminHint = admin === ownerHash;
        if (!adminHint) {
          const tip = await chainTip();
          if (lock >= 500_000_000 && tip.medianTimePast === undefined) {
            throw new ChainDataConflictError("Coin timestamp lock requires node median time");
          }
          const mature = lock < 500_000_000 ? BigInt(lock) <= BigInt(tip.height)
            : BigInt(lock) < BigInt(tip.medianTimePast!);
          if (!mature) {
            if (requested !== undefined) throw new ChainDataConflictError("Explicit Coin input is locked");
            continue;
          }
        }
      }
      if (selected.length === limit) throw new ChainDataConflictError("Coin asset inputs exceed current material budget");
      selected.push(candidate);
      total += positive(candidate.ftAmount, "Coin index amount");
    }
  }
  if (selected.length < (merge ? 2 : 1) || total < minimumAmount) throw new ChainDataConflictError("Insufficient mature Coin inputs");
  return { selected: Object.freeze(selected), selectedParents: [...new Set(selected.map((item) => item.txid))].map((txid) => parents.get(txid)!) };
}

function selectFtMergeCandidates(candidates: readonly TestnetFtUtxo[]): readonly TestnetFtUtxo[] {
  const selected = [...candidates]
    .filter((candidate) => BigInt(candidate.ftAmount) > 0n)
    .sort((left, right) =>
      (BigInt(left.ftAmount) < BigInt(right.ftAmount) ? -1 : BigInt(left.ftAmount) > BigInt(right.ftAmount) ? 1 : 0) ||
      left.txid.localeCompare(right.txid) || left.vout - right.vout,
    )
    .slice(0, MAX_FT_ASSET_INPUTS);
  if (selected.length < 2) throw new ChainDataConflictError("FT merge requires at least two asset inputs");
  return Object.freeze(selected);
}

function selectStablecoinCandidates(
  candidates: readonly TestnetFtUtxo[],
  minimumAmount: bigint,
  maximumInputs: number,
): readonly TestnetFtUtxo[] {
  const usable = [...candidates].filter((candidate) => BigInt(candidate.ftAmount) > 0n);
  const single = usable
    .filter((candidate) => BigInt(candidate.ftAmount) >= minimumAmount)
    .sort((left, right) =>
      (BigInt(left.ftAmount) < BigInt(right.ftAmount) ? -1 : BigInt(left.ftAmount) > BigInt(right.ftAmount) ? 1 : 0) ||
      left.txid.localeCompare(right.txid) || left.vout - right.vout,
    )[0];
  if (single !== undefined) return Object.freeze([single]);
  const selected: TestnetFtUtxo[] = [];
  let total = 0n;
  for (const candidate of usable.sort((left, right) =>
    (BigInt(left.ftAmount) > BigInt(right.ftAmount) ? -1 : BigInt(left.ftAmount) < BigInt(right.ftAmount) ? 1 : 0) ||
    left.txid.localeCompare(right.txid) || left.vout - right.vout,
  )) {
    if (selected.length >= Math.min(maximumInputs, MAX_STABLECOIN_ASSET_INPUTS)) break;
    selected.push(candidate);
    total += BigInt(candidate.ftAmount);
    if (total >= minimumAmount) break;
  }
  if (selected.length === 0 || total < minimumAmount) {
    throw new ChainDataConflictError("StableCoin balance is insufficient within the input policy");
  }
  return Object.freeze(selected);
}

function materialFromRaw(txid: string, rawTransaction: string, inspect: typeof inspectTbcTransaction): TransactionMaterial {
  const inspected = inspect(rawTransaction);
  if (inspected.txid !== txid) throw new ChainDataConflictError("Historical transaction identity mismatch");
  return Object.freeze({
    txid,
    rawTransaction,
    inputs: Object.freeze(inspected.transaction.inputs.map(({ txid: inputTxid, vout }) => Object.freeze({ txid: inputTxid, vout }))),
    outputs: Object.freeze(inspected.transaction.outputs.map((output, vout) => Object.freeze({
      vout,
      satoshis: output.satoshis.toString(),
      scriptPubKey: bytesToHex(output.scriptPubKey),
    }))),
  });
}

function materialFromDecoded(value: TestnetRawTransaction): TransactionMaterial {
  return Object.freeze({
    txid: value.txid,
    rawTransaction: value.rawTransaction,
    confirmations: value.confirmations,
    inputs: Object.freeze(value.inputs.map((input) => Object.freeze({ txid: input.txid, vout: input.vout }))),
    outputs: Object.freeze(value.outputs.map((output) => Object.freeze({
      vout: output.vout,
      satoshis: output.satoshis,
      scriptPubKey: output.scriptPubKey,
    }))),
  });
}

export function createDefaultTbcChainDataResolver(
  options: CreateDefaultTbcChainDataOptions,
): DefaultTbcChainDataResolver {
  const network = assertTbcNetworkContext(
    options.network ?? createTbcNetworkContext({ network: "testnet" }),
  );
  const now = options.now ?? Date.now;
  const snapshotId = options.snapshotId ?? randomSnapshotId;
  const maxInputs = options.maxInputs ?? DEFAULT_MAX_INPUTS;
  const snapshotTtlMs = options.snapshotTtlMs ?? DEFAULT_SNAPSHOT_TTL_MS;
  const inspect = options.inspectTransaction ?? inspectTbcTransaction;
  const minimumConfirmations = options.confirmationPolicy === undefined
    ? "0"
    : normalizePoolMaterialConfirmationPolicy(options.confirmationPolicy).minConfirmations;
  if (!Number.isSafeInteger(maxInputs) || maxInputs < 1 || maxInputs > 500 || !Number.isSafeInteger(snapshotTtlMs) || snapshotTtlMs < 1_000 || snapshotTtlMs > 300_000) {
    throw new TypeError("Invalid default Chain Data configuration");
  }

  const immutable = new Map<string, TransactionMaterial>();
  // Weak keys share the existing bounded immutable byte cache's lifetime.
  // Never retain fresh UTXOs, confirmations, permissions or account authority.
  const originHints = new WeakMap<TransactionMaterial, Promise<TbcFungibleOriginHint | TbcNftOriginHint>>();
  const nftOriginHints = new WeakMap<TransactionMaterial, Promise<TbcFungibleOriginHint | TbcNftOriginHint>>();
  const poolOriginHints = new WeakMap<TransactionMaterial, Promise<TbcPoolOriginHint>>();
  const resolvedPolicies = new Map<string, Readonly<{ expiresAt: number; intentType: string }>>();
  const poolPolicies = new Map<string, Readonly<{
    expiresAt: number;
    value: PoolMaterial["policy"];
  }>>();
  let retainedHexCharacters = 0;
  function remember(value: TransactionMaterial) {
    if (value.rawTransaction.length > 4 * 1024 * 1024) return;
    const existing = immutable.get(value.txid);
    if (existing !== undefined && existing.rawTransaction !== value.rawTransaction) {
      throw new ChainDataConflictError("Immutable transaction bytes conflict");
    }
    if (existing !== undefined) return;
    while (immutable.size >= 32 || retainedHexCharacters + value.rawTransaction.length > 4 * 1024 * 1024) {
      const oldest = immutable.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      retainedHexCharacters -= immutable.get(oldest)!.rawTransaction.length;
      immutable.delete(oldest);
    }
    // Cross-request retention is byte/parse reuse only. Confirmation state is
    // mutable and must be observed again whenever an index height is absent.
    const immutableValue = Object.freeze({
      txid: value.txid,
      rawTransaction: value.rawTransaction,
      inputs: value.inputs,
      outputs: value.outputs,
    });
    immutable.set(value.txid, immutableValue);
    retainedHexCharacters += value.rawTransaction.length;
  }

  async function resolveUnifiedAsset(raw: unknown, boundAccount: KitWalletAccount | undefined, client: TestnetClient) {
    assertValidTws("chainDataResolveParams", raw);
    const params = JSON.parse(canonicalize(raw)) as ChainDataParams;
    const r = params.requirement, contractId = r.contractIds?.[0];
    const nft = r.intentType === "tbc721.transfer";
    const stable = r.intentType.startsWith("tbc20Stablecoin."), merge = r.intentType.endsWith(".merge");
    const native = r.assets[0], token = r.assets[1];
    if (options.materialNative === undefined || params.chainId !== network.chainId || params.signingRoles !== undefined || params.signingAccounts !== undefined ||
        r.includeAncestry !== true || r.contractIds?.length !== 1 || contractId === undefined || r.assets.length !== 2 ||
        native?.kind !== "native" || native.contractId !== undefined || native.contractDependency !== undefined || native.minimumAmount !== r.nativeAmount ||
        token?.kind !== (nft ? "nft" : stable ? "stablecoin" : "ft") || token.contractId !== contractId || token.contractDependency !== undefined ||
        (nft && token.minimumAmount !== "1") ||
        (merge ? token.minimumAmount !== undefined || r.nativeAmount !== undefined : !/^[1-9][0-9]*$/u.test(token.minimumAmount ?? "")) ||
        (r.inputOutpoints !== undefined && r.inputOutpoints.length > maxInputs)) return failure("INVALID_INPUT");
    const accounts = boundAccount === undefined ? await options.accounts.current() : [boundAccount];
    const account = accounts.find(a => a.accountId === params.accountId && a.chainId === params.chainId);
    if (account === undefined || account.accountId !== `${account.chainId}:${account.address}`) return failure("UNAUTHORIZED");
    assertTbcAddress(account.address, network.profile.p2pkhVersion);
    const scoped = createChainDataReadScope(client);
    // Launch the same indexes alongside the already-required origin. Nested
    // concrete resolution consumes these exact promises, not duplicate reads.
    const indexes: Promise<unknown>[] = [scoped.getNativeUtxos !== undefined
      ? scoped.getNativeUtxos(account.address) : scoped.getUtxos(account.address)];
    if (!nft) indexes.push(stable ? scoped.getStablecoinUtxos(account.address, contractId) : scoped.getFtUtxos(account.address, contractId));
    const drained = Promise.allSettled(indexes);
    try {
      const hint = !nft ? await (async () => {
        const info = await (stable ? scoped.getStablecoinInfo(contractId) : scoped.getFtInfo(contractId));
        const [identity] = await identifyTbcFungibleContracts([{ codeScript: info.codeScript, tapeScript: info.tapeScript,
          codeSatoshis: 500, tapeSatoshis: 0 }], { engine: options.materialNative! });
        if (identity === null || identity === undefined) throw new ChainDataConflictError("Unrecognized indexed fungible template");
        return identity;
      })() : await (async () => {
      let origin = immutable.get(contractId);
      if (origin === undefined) {
        origin = scoped.getRawTransactionBytes === undefined
          ? materialFromDecoded(await scoped.getRawTransaction(contractId))
          : materialFromRaw(contractId, await scoped.getRawTransactionBytes(contractId), inspect);
        remember(origin);
        origin = immutable.get(contractId) ?? origin;
      }
      // An invalid cross-family request cannot poison the other codec's cache.
      const hints = nft ? nftOriginHints : originHints;
      let pending = hints.get(origin);
      if (pending === undefined) {
        pending = (nft ? identifyTbcNftOrigin : identifyTbcFungibleOrigin)(contractId, origin.rawTransaction, { engine: options.materialNative! });
        hints.set(origin, pending);
      }
      return await pending;
      })();
      if (hint.family !== (nft ? "tbc721" : stable ? "tbc20Stablecoin" : "tbc20")) throw new ChainDataConflictError("Asset origin family differs");
      if (nft && hint.generation === "historical" && r.nativeAmount !== undefined) return failure("INVALID_INPUT");
      const prefix = hint.generation === "current" ? (stable ? "tbc20-stablecoin-" : "tbc20-standard-")
        : (stable ? "tbc.stablecoin." : "tbc.ft.");
      // Only the private read plan is lowered. Core's original request/hash and
      // Engine's own independently authenticated holder routing stay unchanged.
      const intentType = nft ? hint.generation === "current" ? "tbc721-standard-transfer" : "tbc.nft.transfer"
        : `${prefix}${merge ? "merge" : "transfer"}`;
      const result = await resolve({ ...params, requirement: { ...r, intentType } }, account, scoped);
      const snapshot = record(result, "Unified asset chain result");
      if (snapshot.portError === undefined) {
        const payload = record(snapshot.payload, "Unified asset snapshot");
        const key = hashCanonical({ snapshotHash: snapshot.snapshotHash, chainId: params.chainId, from: account.address, contractId, intentType: r.intentType });
        resolvedPolicies.delete(key);
        while (resolvedPolicies.size >= 32) resolvedPolicies.delete(resolvedPolicies.keys().next().value!);
        resolvedPolicies.set(key, { expiresAt: Date.parse(String(payload.expiresAt)), intentType });
      }
      return result;
    } finally {
      await drained; // No orphan index read survives a failed origin/codec.
    }
  }

  async function resolveUnifiedPool(raw: unknown, boundAccount: KitWalletAccount | undefined, client: TestnetClient) {
    assertValidTws("chainDataResolveParams", raw);
    const params = JSON.parse(canonicalize(raw)) as ChainDataParams;
    const r = params.requirement, contractId = r.contractIds?.[0];
    const [native, pool, holder] = r.assets;
    const positiveAmount = (value: unknown): value is string => typeof value === "string" && /^[1-9][0-9]*$/u.test(value);
    const buy = r.intentType === "amm.swap" && r.nativeAmount !== undefined;
    const remove = r.intentType === "amm.removeLiquidity";
    const add = r.intentType === "amm.addLiquidity";
    const lp = r.intentType.startsWith("tbc20Lp.");
    const mergeToken = r.intentType === "amm.mergeToken";
    if (options.materialNative === undefined || client.api === undefined || params.chainId !== network.chainId ||
        r.includeAncestry !== true || r.contractIds?.length !== 1 || contractId === undefined || !/^[0-9a-f]{64}$/u.test(contractId) ||
        native?.kind !== "native" || native.contractId !== undefined || native.contractDependency !== undefined || native.minimumAmount !== r.nativeAmount ||
        pool?.kind !== (lp ? "ftlp" : "pool") || pool.contractId !== contractId || (!lp && pool.minimumAmount !== undefined) || pool.contractDependency !== undefined ||
        !validSigningRoleScope(params.signingRoles, r.intentType) || (params.signingRoles === undefined && params.signingAccounts !== undefined) ||
        r.targetOutpoints !== undefined || r.certificateOutpoint !== undefined || (r.inputOutpoints !== undefined && r.inputOutpoints.length > maxInputs)) return failure("INVALID_INPUT");
    if (lp) {
      const amount = r.intentType === "tbc20Lp.transfer" || r.intentType === "tbc20Lp.lock";
      if (r.assets.length !== 2 || r.nativeAmount !== undefined || (amount ? !positiveAmount(pool.minimumAmount) : pool.minimumAmount !== undefined)) return failure("INVALID_INPUT");
    } else if (mergeToken) {
      if (r.assets.length !== 3 || r.nativeAmount !== undefined || holder?.kind !== "ft" || holder.contractId !== undefined ||
          holder.minimumAmount !== undefined || holder.contractDependency?.contractId !== contractId || holder.contractDependency.relation !== "pool-ft") return failure("INVALID_INPUT");
    } else if (buy) {
      if (r.assets.length !== 2 || !positiveAmount(r.nativeAmount)) return failure("INVALID_INPUT");
    } else {
      if (r.assets.length !== 3 || holder?.kind !== (remove ? "ftlp" : "ft") || holder.contractId !== undefined ||
          holder.contractDependency?.contractId !== contractId || holder.contractDependency.relation !== (remove ? "pool-lp" : "pool-ft")) return failure("INVALID_INPUT");
      if (add && r.nativeAmount !== undefined) {
        if (!positiveAmount(r.nativeAmount) || (holder.minimumAmount !== undefined && !positiveAmount(holder.minimumAmount))) return failure("INVALID_INPUT");
      } else if (r.nativeAmount !== undefined || !positiveAmount(holder.minimumAmount)) return failure("INVALID_INPUT");
    }
    const current = boundAccount === undefined ? await options.accounts.current() : undefined;
    const account = boundAccount ?? current!.find(a => a.accountId === params.accountId && a.chainId === params.chainId);
    if (account === undefined || account.accountId !== params.accountId || account.chainId !== params.chainId ||
        account.accountId !== `${account.chainId}:${account.address}`) return failure("UNAUTHORIZED");
    assertTbcAddress(account.address, network.profile.p2pkhVersion);
    const accounts = current ?? [account, ...(params.signingAccounts ?? [])];
    const roleRequest = { chainId: params.chainId, from: account.address, signingRoles: params.signingRoles };
    const selected = resolveTransactionSigningAccounts(roleRequest, accounts);
    if (params.signingAccounts !== undefined) assertTransactionSigningSnapshot(roleRequest, accounts, {
      chainId: params.chainId, account, signingAccounts: params.signingAccounts,
    });
    const scoped = createChainDataReadScope(client);
    // Both generations need this index. Read it concurrently with immutable
    // recognition, once without automatic retries; a failed read is surfaced.
    // Neither a version endpoint nor an index-provided template claim is used.
    // New LP uses no current Pool index. Maintenance resolves the immutable
    // template first so an unsupported profile cannot trigger spare reads.
    const info = scoped.api!.poolInfo({ pool_id: contractId }, { category: "pool", retry: "none" });
    const drained = Promise.allSettled([info, scoped.getNativeUtxos?.(account.address) ?? scoped.getUtxos(account.address)]);
    try {
      const currentPoolInfo=await info;
      const stateId=currentPoolInfo.txid;
      let origin = immutable.get(stateId);
      if (origin === undefined) {
        origin = scoped.getRawTransactionBytes === undefined
          ? materialFromDecoded(await scoped.getRawTransaction(stateId))
          : materialFromRaw(stateId, await scoped.getRawTransactionBytes(stateId), inspect);
        remember(origin);
        origin = immutable.get(stateId) ?? origin;
      }
      const hint=JSON.parse(await options.materialNative.execute("inspectAmmMaterial",JSON.stringify({phase:"identifyPoolState",pool:{txid:stateId,rawTransaction:origin.rawTransaction}})));
      if(hint.family!=="amm"||!["current","historical"].includes(hint.generation)||hint.verification!=="state-template"||hint.assetIdentityVerified!==false)throw new Error("Invalid Pool state identification");
      const historical = hint.generation === "historical";
      if (historical && (params.signingRoles !== undefined || (add && (r.nativeAmount === undefined || holder?.minimumAmount !== undefined)))) return failure("INVALID_INPUT");
      const maintenance: Readonly<Record<string, string>> = historical
        ? { "tbc20Lp.merge": "tbc.pool.ftlp.merge", "tbc20Lp.burn": "tbc.pool.ftlp.burn", "amm.mergeToken": "tbc.pool.ft.merge" }
        : { "tbc20Lp.transfer": "tbc20-lp-transfer", "tbc20Lp.lock": "tbc20-lp-lock", "tbc20Lp.unlock": "tbc20-lp-unlock", "tbc20Lp.merge": "tbc20-lp-merge" };
      const intentType = lp || mergeToken ? maintenance[r.intentType] : historical
        ? add ? "tbc.pool.liquidity.add" : remove ? "tbc.pool.liquidity.remove" : buy ? "tbc.pool.swap.exactTbcForToken" : "tbc.pool.swap.exactTokenForTbc"
        : add ? "tbc-amm-add-liquidity" : remove ? "tbc-amm-remove-liquidity" : "tbc-amm-swap";
      if (intentType === undefined) return Object.freeze({ portError: Object.freeze({ name: "INVALID_INPUT", retryable: false,
        message: "Operation is not supported for the authenticated Pool template" }) });
      if (historical) await options.poolMaterial?.rememberTransaction?.(stateId, origin.rawTransaction);
      const readClient = info === undefined ? scoped : Object.freeze({ ...scoped, api: Object.freeze({ ...scoped.api!,
        poolInfo: ((input, readOptions) => input.pool_id === contractId && readOptions?.signal === undefined
          ? info : scoped.api!.poolInfo(input, readOptions)) as NonNullable<TestnetClient["api"]>["poolInfo"],
      }) });
      // Historical buy needs a dependent FT descriptor although no holder FT
      // is spent. Only the material projection changes, never the request/hash.
      const assets = historical && lp ? [native, { kind: "pool", contractId }, { kind: "ftlp", contractDependency: { contractId, relation: "pool-lp" } }]
        : historical && buy ? [...r.assets, { kind: "ft", contractDependency: { contractId, relation: "pool-ft" } }] : r.assets;
      const { signingAccounts: _declared, ...rest } = params;
      const result = await resolve({ ...rest, ...(selected.additional.length === 0 ? {} : { signingAccounts: selected.additional }),
        requirement: { ...r, intentType, assets } }, account, readClient);
      const snapshot = record(result, "Unified Pool chain result");
      if (snapshot.portError === undefined) {
        const payload = record(snapshot.payload, "Unified Pool snapshot");
        const key = hashCanonical({ snapshotHash: snapshot.snapshotHash, chainId: params.chainId, from: account.address, contractId, intentType: r.intentType });
        resolvedPolicies.delete(key);
        while (resolvedPolicies.size >= 32) resolvedPolicies.delete(resolvedPolicies.keys().next().value!);
        resolvedPolicies.set(key, { expiresAt: Date.parse(String(payload.expiresAt)), intentType });
      }
      return result;
    } finally { await drained; }
  }

  async function resolveNftBatch(raw: unknown, boundAccount: KitWalletAccount | undefined, client: TestnetClient): Promise<unknown> {
    assertValidTws("chainDataResolveParams", raw);
    const params = JSON.parse(canonicalize(raw)) as ChainDataParams;
    const r = params.requirement, ids = r.contractIds;
    const native = r.assets[0];
    if (params.chainId !== network.chainId || params.signingRoles !== undefined || params.signingAccounts !== undefined ||
        !Array.isArray(ids) || ids.length < 1 || ids.length > 100 || new Set(ids).size !== ids.length ||
        r.includeAncestry !== true || r.assets.length !== ids.length + 1 || native?.kind !== "native" ||
        native.contractId !== undefined || native.contractDependency !== undefined || native.minimumAmount !== r.nativeAmount ||
        r.collectionSlots !== undefined || r.targetOutpoints !== undefined || r.certificateOutpoint !== undefined ||
        ids.some((id, index) => { const asset = r.assets[index + 1]; return asset?.kind !== "nft" ||
          asset.contractId !== id || asset.minimumAmount !== "1" || asset.contractDependency !== undefined; })) {
      return failure("INVALID_INPUT");
    }
    const accounts = boundAccount === undefined ? await options.accounts.current() : [boundAccount];
    const account = accounts.find(a => a.accountId === params.accountId && a.chainId === params.chainId);
    if (account === undefined || account.accountId !== `${account.chainId}:${account.address}`) return failure("UNAUTHORIZED");
    assertTbcAddress(account.address, network.profile.p2pkhVersion);
    // Reuse existing authenticated single-NFT readers. One scope owns all
    // indexes/raw promises, including common collection ancestry. Never retain
    // mutable UTXO observations beyond this batch.
    const scoped = createChainDataReadScope(client);
    const results = await Promise.allSettled(ids.map(contractId => resolveUnifiedAsset({
      version: params.version, chainId: params.chainId, accountId: params.accountId,
      requirement: { intentType: "tbc721.transfer", includeAncestry: true, contractIds: [contractId],
        assets: [{ kind: "native" }, { kind: "nft", contractId, minimumAmount: "1" }] },
    }, account, scoped)));
    const utxos = new Map<string, Record<string, unknown>>();
    const parents = new Map<string, Record<string, unknown>>();
    const contracts = new Map<string, Record<string, unknown>>();
    let first: Record<string, unknown> | undefined;
    let capturedAt = Infinity, expiresAt = Infinity;
    const merge = (map: Map<string, Record<string, unknown>>, key: string, item: Record<string, unknown>) => {
      const previous = map.get(key);
      if (previous !== undefined && canonicalize(previous) !== canonicalize(item)) throw new ChainDataConflictError("NFT batch material differs for one identity");
      map.set(key, item);
    };
    for (const [index, result] of results.entries()) {
      if (result.status === "rejected") throw result.reason;
      const value = record(result.value, "NFT batch child snapshot");
      if (value.portError !== undefined) return value;
      const payload = record(value.payload, "NFT batch child payload");
      if (first === undefined) first = payload;
      else if (canonicalize(payload.account) !== canonicalize(first.account) ||
          canonicalize(payload.block ?? null) !== canonicalize(first.block ?? null)) throw new ChainDataConflictError("NFT batch account or chain context changed");
      capturedAt = Math.min(capturedAt, Date.parse(String(payload.capturedAt)));
      expiresAt = Math.min(expiresAt, Date.parse(String(payload.expiresAt)));
      for (const rawItem of payload.utxos as unknown[]) {
        const item = record(rawItem, "NFT batch input");
        merge(utxos, `${item.txid}:${item.vout}`, item);
      }
      for (const rawItem of payload.parents as unknown[]) {
        const item = record(rawItem, "NFT batch parent"); merge(parents, String(item.txid), item);
      }
      for (const rawItem of payload.contracts as unknown[]) {
        const item = record(rawItem, "NFT batch contract");
        if (item.contractId !== ids[index]) throw new ChainDataConflictError("NFT batch reader returned an unrequested contract");
        merge(contracts, String(item.contractId), item);
      }
    }
    if (contracts.size !== ids.length || utxos.size > (options.maxInputs ?? 2 * ids.length + DEFAULT_MAX_INPUTS) || parents.size > 10_000) return failure("INVALID_INPUT");
    const payload = Object.freeze({ ...first!, snapshotId: await snapshotId(), capturedAt: canonicalTime(capturedAt), expiresAt: canonicalTime(expiresAt),
      utxos: Object.freeze([...utxos.values()]), parents: Object.freeze([...parents.values()]), contracts: Object.freeze([...contracts.values()]) });
    const result = Object.freeze({ payload, snapshotHash: hashCanonical(payload) });
    assertValidTws("chainDataResolveResult", result);
    return result;
  }

  async function resolveWorkflow(raw: ChainDataParams, boundAccount?: KitWalletAccount): Promise<unknown> {
    assertValidTws("chainDataResolveParams", raw);
    // Own the full request before the first await; a DApp may retain its object.
    const params = JSON.parse(canonicalize(raw)) as ChainDataParams;
    const steps = params.workflowSteps!;
    if (params.chainId !== network.chainId || new Set(steps.map(step => step.stepId)).size !== steps.length) {
      return failure("INVALID_INPUT");
    }
    for (const step of steps) {
      if ((step.signingRoles === undefined && step.signingAccounts !== undefined) ||
          !validSigningRoleScope(step.signingRoles, step.requirement.intentType)) {
        return failure("INVALID_INPUT");
      }
    }
    const declared = new Map<string, TransactionRoleAccount>();
    for (const account of steps.flatMap(step => step.signingAccounts ?? [])) {
      const previous = declared.get(account.accountId);
      if (previous !== undefined && canonicalize(previous) !== canonicalize(account)) return failure("UNAUTHORIZED");
      declared.set(account.accountId, account);
    }
    const current = boundAccount === undefined ? await options.accounts.current() : undefined;
    const primary = boundAccount ?? current!.find(account => account.accountId === params.accountId && account.chainId === params.chainId);
    if (primary === undefined || primary.accountId !== params.accountId || primary.chainId !== params.chainId) return failure("UNAUTHORIZED");
    const accounts = current ?? [primary, ...declared.values()];
    resolveWorkflowSigningAccounts({ chainId: params.chainId, from: primary.address,
      steps: steps.map(step => ({ id: step.stepId, kind: "transaction", signingRoles: step.signingRoles })),
    }, accounts);
    // Validate all role declarations before any child can start network I/O.
    const children = steps.map(step => {
      const roleRequest = { chainId: params.chainId, from: primary.address, signingRoles: step.signingRoles };
      const selected = resolveTransactionSigningAccounts(roleRequest, accounts);
      if (step.signingAccounts !== undefined) assertTransactionSigningSnapshot(roleRequest, accounts, {
        chainId: params.chainId, account: primary, signingAccounts: step.signingAccounts,
      });
      return { version: "1.0", chainId: params.chainId, accountId: primary.accountId, requirement: step.requirement,
        ...(step.signingRoles === undefined ? {} : { signingRoles: step.signingRoles }),
        ...(selected.additional.length === 0 ? {} : { signingAccounts: selected.additional }),
      };
    });
    const scoped = createChainDataReadScope(options.client);
    // Drain all work even when a child fails; no orphan read survives a reply.
    const results = await Promise.allSettled(children.map(child => resolve(child, primary, scoped)));
    const snapshots: { stepId: string; snapshot: unknown }[] = [];
    for (const [index, result] of results.entries()) {
      if (result.status === "rejected") throw result.reason;
      const value = record(result.value, "Workflow chain result");
      if (value.portError !== undefined) return value;
      snapshots.push(Object.freeze({ stepId: steps[index]!.stepId, snapshot: value }));
    }
    const result = Object.freeze({ version: "1.0", steps: Object.freeze(snapshots) });
    assertValidTws("chainDataResolveResult", result);
    return result;
  }

  async function resolveLop(raw: unknown, boundAccount: KitWalletAccount | undefined, client: TestnetClient) {
    assertValidTws("chainDataResolveParams", raw);
    // Own selectors before awaiting account discovery or any HTTP operation.
    const params = JSON.parse(canonicalize(raw)) as ChainDataParams & { requirement: ChainDataRequirement };
    if (params.signingRoles !== undefined || params.signingAccounts !== undefined || options.materialNative === undefined) {
      return failure("INVALID_INPUT");
    }
    const accounts = boundAccount === undefined ? await options.accounts.current() : [boundAccount];
    const account = accounts.find(value => value.accountId === params.accountId && value.chainId === params.chainId);
    if (account === undefined || account.accountId !== `${account.chainId}:${account.address}`) {
      throw new ChainDataAuthorizationError("LOP Chain Data account mismatch");
    }
    const address = assertTbcAddress(account.address, network.profile.p2pkhVersion);
    const historical = new Map<string, Promise<TransactionMaterial>>();
    const fresh = new Map<string, Promise<TransactionMaterial>>();
    const readHistory = (txid: string): Promise<TransactionMaterial> => {
      const cached = immutable.get(txid);
      if (cached !== undefined) return Promise.resolve(cached);
      let pending = historical.get(txid);
      if (pending === undefined) {
        pending = (client.getRawTransactionBytes === undefined
          ? client.getRawTransaction(txid).then(materialFromDecoded)
          : client.getRawTransactionBytes(txid).then(raw => materialFromRaw(txid, raw, inspect)))
          .then(value => { remember(value); return value; });
        historical.set(txid, pending);
      }
      return pending;
    };
    const readDecoded = (txid: string): Promise<TransactionMaterial> => {
      let pending = fresh.get(txid);
      if (pending === undefined) {
        pending = client.getRawTransaction(txid).then(materialFromDecoded)
          .then(value => { remember(value); return value; });
        fresh.set(txid, pending);
        if (!historical.has(txid)) historical.set(txid, pending);
      }
      return pending;
    };
    const material = await resolveLopMaterial({ requirement: params.requirement, address: account.address,
      ownerScript: address.scriptPubKey, client, native: options.materialNative,
      minimumConfirmations: minimumConfirmations ?? "0", maxInputs, readHistory, readDecoded,
      hasHistory: txid => immutable.has(txid) });
    const captured = now();
    const payload = Object.freeze({ version: "1.0", snapshotId: await snapshotId(), chainId: params.chainId,
      ...(material.tip === undefined ? {} : {block: material.tip}), capturedAt: canonicalTime(captured), expiresAt: canonicalTime(captured + snapshotTtlMs),
      account: Object.freeze({ accountId: account.accountId, address: account.address, chainId: account.chainId, publicKey: account.publicKey }),
      utxos: material.utxos, parents: Object.freeze(material.parents.map(({txid, rawTransaction}) => Object.freeze({txid, rawTransaction}))),
      contracts: material.contracts });
    const result = Object.freeze({ payload, snapshotHash: hashCanonical(payload) });
    assertValidTws("chainDataResolveResult", result);
    return result;
  }

  async function resolve(
    rawParams: unknown,
    boundAccount?: KitWalletAccount,
    client: TestnetClient = options.client,
  ): Promise<unknown> {
    try {
      const params = record(rawParams, "Chain Data parameters") as unknown as ChainDataParams;
      if (params.workflowSteps !== undefined) return await resolveWorkflow(params, boundAccount);
      const requirement = record(params.requirement, "Chain Data requirement") as unknown as ChainDataParams["requirement"];
      if (requirement.intentType === "tbc721.batchTransfer") return await resolveNftBatch(rawParams, boundAccount, client);
      const maxInputs = options.maxInputs ?? (requirement.intentType === "tbc.maintenance.merge" ? MAX_TBC_MERGE_INPUTS : DEFAULT_MAX_INPUTS);
      if (requirement.intentType.startsWith("tbc20Lp.") || ["amm.mergeToken", "amm.swap", "amm.addLiquidity", "amm.removeLiquidity"].includes(requirement.intentType)) {
        return await resolveUnifiedPool(rawParams, boundAccount, client);
      }
      if (["tbc721.transfer", "tbc20.transfer", "tbc20.merge", "tbc20Stablecoin.transfer", "tbc20Stablecoin.merge"].includes(requirement.intentType)) {
        return await resolveUnifiedAsset(rawParams, boundAccount, client);
      }
      if (
        params.version !== "1.0" ||
        typeof params.accountId !== "string" ||
        params.chainId !== network.chainId ||
        !Array.isArray(requirement.assets) ||
        (requirement.contractIds !== undefined && !Array.isArray(requirement.contractIds)) ||
        (requirement.inputOutpoints !== undefined && !Array.isArray(requirement.inputOutpoints))
      ) return failure("INVALID_INPUT");

      const requestedInputOutpoints = requirement.inputOutpoints;
      if (requestedInputOutpoints !== undefined) {
        if (
          requestedInputOutpoints.length < 1 ||
          requestedInputOutpoints.length > maxInputs ||
          requestedInputOutpoints.some((outpoint) =>
            outpoint === null || typeof outpoint !== "object" || Array.isArray(outpoint) ||
            !/^[0-9a-f]{64}$/u.test(outpoint.txid) ||
            !Number.isSafeInteger(outpoint.vout) || outpoint.vout < 0 || outpoint.vout > 0xffff_ffff
          ) ||
          new Set(requestedInputOutpoints.map(({ txid, vout }) => `${txid}:${vout}`)).size !== requestedInputOutpoints.length
        ) return failure("INVALID_INPUT");
      }

      if (["tbc-lop-create", "tbc-lop-cancel", "tbc-lop-match"].includes(requirement.intentType)) {
        return await resolveLop(params, boundAccount, client);
      }
      const htlcOperation = ["tbc-htlc-lock", "tbc-htlc-claim", "tbc-htlc-refund"].includes(requirement.intentType);
      const htlcToken = htlcOperation && ["ft", "stablecoin"].includes(requirement.assets[0]?.kind ?? "");
      const htlcTokenLock = htlcToken && requirement.intentType === "tbc-htlc-lock";
      const htlcTokenSpend = htlcToken && !htlcTokenLock;
      const nativeAsset = requirement.assets[htlcToken ? 1 : 0];
      const timelockLock = requirement.intentType === "tbc-timelock-lock";
      const timelockUnlock = requirement.intentType === "tbc-timelock-unlock";
      const htlcLock = !htlcToken && requirement.intentType === "tbc-htlc-lock";
      const htlcSpend = !htlcToken && (requirement.intentType === "tbc-htlc-claim" || requirement.intentType === "tbc-htlc-refund");
      if ((htlcLock || htlcSpend) && (requirement.assets.length !== 1 ||
          nativeAsset?.kind !== (htlcLock ? "native" : "htlc") || nativeAsset.contractId !== undefined ||
          nativeAsset.contractDependency !== undefined || requirement.contractIds !== undefined ||
          requirement.includeAncestry !== htlcSpend ||
          (htlcLock ? typeof requirement.nativeAmount !== "string" || nativeAsset.minimumAmount !== requirement.nativeAmount
            : requirement.nativeAmount !== undefined || nativeAsset.minimumAmount !== undefined || requestedInputOutpoints === undefined || client.api === undefined))) return failure("INVALID_INPUT");
      if ((timelockLock || timelockUnlock) && (requirement.assets.length !== 1 ||
          nativeAsset?.kind !== (timelockLock ? "native" : "timelock") || nativeAsset.contractId !== undefined ||
          nativeAsset.contractDependency !== undefined || requirement.contractIds !== undefined ||
          requirement.includeAncestry !== timelockUnlock ||
          (timelockLock ? typeof requirement.nativeAmount !== "string" || nativeAsset.minimumAmount !== requirement.nativeAmount
            : requirement.nativeAmount !== undefined || nativeAsset.minimumAmount !== undefined || requestedInputOutpoints === undefined || client.api === undefined))) return failure("INVALID_INPUT");
      const ftAsset = requirement.assets[htlcToken ? 0 : 1];
      const contractId = requirement.contractIds?.[0];
      if (htlcToken && (requirement.assets.length !== (htlcTokenLock ? 2 : 3) ||
          requirement.includeAncestry !== true || requirement.contractIds?.length !== 1 ||
          typeof contractId !== "string" || !/^[0-9a-f]{64}$/u.test(contractId) || ftAsset?.contractId !== contractId ||
          ftAsset.contractDependency !== undefined || nativeAsset?.kind !== "native" || nativeAsset.contractId !== undefined ||
          nativeAsset.contractDependency !== undefined || nativeAsset.minimumAmount !== undefined || requirement.nativeAmount !== undefined ||
          client.api === undefined || (htlcTokenLock ? typeof ftAsset.minimumAmount !== "string" || !/^[1-9][0-9]*$/u.test(ftAsset.minimumAmount)
            : ftAsset.minimumAmount !== undefined || requirement.assets[2]?.kind !== "htlc" ||
              requirement.assets[2]?.contractId !== undefined || requirement.assets[2]?.contractDependency !== undefined ||
              requirement.assets[2]?.minimumAmount !== undefined))) return failure("INVALID_INPUT");
      const ammCreate = requirement.intentType === "tbc-amm-create";
      const ammBusiness = ["tbc-amm-add-liquidity", "tbc-amm-remove-liquidity", "tbc-amm-swap"].includes(requirement.intentType);
      let ammAction: AmmMaterialAction | undefined;
      if (ammBusiness) {
        const holder = requirement.assets[2];
        if (requirement.includeAncestry !== true || requirement.contractIds?.length !== 1 || typeof contractId !== "string" || !/^[0-9a-f]{64}$/u.test(contractId) ||
            nativeAsset?.kind !== "native" || nativeAsset.contractId !== undefined || nativeAsset.contractDependency !== undefined ||
            nativeAsset.minimumAmount !== requirement.nativeAmount || ftAsset?.kind !== "pool" || ftAsset.contractId !== contractId ||
            ftAsset.minimumAmount !== undefined || ftAsset.contractDependency !== undefined || options.materialNative === undefined || client.api === undefined) return failure("INVALID_INPUT");
        const positiveAmount = (v: unknown): v is string => typeof v === "string" && /^[1-9][0-9]*$/u.test(v);
        const native = requirement.nativeAmount;
        const buy = requirement.intentType === "tbc-amm-swap" && native !== undefined;
        const remove = requirement.intentType === "tbc-amm-remove-liquidity";
        if (buy) {
          if (requirement.assets.length !== 2 || !positiveAmount(native)) return failure("INVALID_INPUT");
          ammAction = { kind: "buy", amount: native };
        } else {
          if (requirement.assets.length !== 3 || holder?.kind !== (remove ? "ftlp" : "ft") || holder.contractId !== undefined ||
              holder.contractDependency?.contractId !== contractId || holder.contractDependency.relation !== (remove ? "pool-lp" : "pool-ft")) return failure("INVALID_INPUT");
          if (requirement.intentType === "tbc-amm-add-liquidity" && native !== undefined) {
            if (!positiveAmount(native) || (holder.minimumAmount !== undefined && !positiveAmount(holder.minimumAmount))) return failure("INVALID_INPUT");
            ammAction = { kind: "addTbc", amount: native, ...(holder.minimumAmount === undefined ? {} : { initialFtAmount: holder.minimumAmount }) };
          } else {
            if (native !== undefined || !positiveAmount(holder.minimumAmount)) return failure("INVALID_INPUT");
            ammAction = { kind: remove ? "remove" : requirement.intentType === "tbc-amm-swap" ? "sell" : "addFt", amount: holder.minimumAmount };
          }
        }
      }
      const lp = ["tbc20-lp-transfer", "tbc20-lp-lock", "tbc20-lp-merge", "tbc20-lp-unlock"].includes(requirement.intentType);
      if ((ammCreate || lp) && (requirement.includeAncestry !== true || requirement.contractIds?.length !== 1 ||
          typeof contractId !== "string" || !/^[0-9a-f]{64}$/u.test(contractId) ||
          nativeAsset?.kind !== "native" || nativeAsset.contractId !== undefined || nativeAsset.contractDependency !== undefined ||
          nativeAsset.minimumAmount !== undefined || requirement.nativeAmount !== undefined)) return failure("INVALID_INPUT");
      if (ammCreate && requirement.assets.length !== 1) return failure("INVALID_INPUT");
      if (lp && (requirement.assets.length !== 2 || ftAsset?.kind !== "ftlp" || ftAsset.contractId !== contractId ||
          ftAsset.contractDependency !== undefined || options.materialNative === undefined || client.api === undefined ||
          (["tbc20-lp-transfer", "tbc20-lp-lock"].includes(requirement.intentType)
            ? typeof ftAsset.minimumAmount !== "string" || !/^[1-9][0-9]*$/u.test(ftAsset.minimumAmount)
            : ftAsset.minimumAmount !== undefined))) return failure("INVALID_INPUT");
      const tbc20Create = requirement.intentType === "tbc20-standard-create";
      const tbc20 = tbc20Create || requirement.intentType === "tbc20-standard-transfer" || requirement.intentType === "tbc20-standard-merge" || (htlcToken && ftAsset?.kind === "ft");
      const coinCreate = requirement.intentType === "tbc20-stablecoin-create";
      const coinMint = requirement.intentType === "tbc20-stablecoin-mint";
      const coinLocks = requirement.intentType === "tbc20-stablecoin-freeze" || requirement.intentType === "tbc20-stablecoin-unfreeze";
      const coinManagement = coinMint || coinLocks;
      const coin = coinManagement || coinCreate || requirement.intentType === "tbc20-stablecoin-transfer" || requirement.intentType === "tbc20-stablecoin-merge" || (htlcToken && ftAsset?.kind === "stablecoin");
      const validPoint = (p: Readonly<{ txid: string; vout: number }>) => p !== null && typeof p === "object" &&
        /^[0-9a-f]{64}$/u.test(p.txid) && Number.isSafeInteger(p.vout) && p.vout >= 0 && p.vout <= 0xffff_ffff;
      if (coinLocks ? !Array.isArray(requirement.targetOutpoints) || requirement.targetOutpoints.length < 1 || requirement.targetOutpoints.length > 5 ||
          requirement.targetOutpoints.some(p => !validPoint(p)) || new Set(requirement.targetOutpoints.map(p => `${p.txid}:${p.vout}`)).size !== requirement.targetOutpoints.length
          : htlcTokenSpend ? !Array.isArray(requirement.targetOutpoints) || requirement.targetOutpoints.length !== 1 ||
            !validPoint(requirement.targetOutpoints[0]!) || requirement.targetOutpoints[0]!.vout !== 1
          : requirement.targetOutpoints !== undefined) return failure("INVALID_INPUT");
      if (requirement.certificateOutpoint !== undefined && (!coinMint || !validPoint(requirement.certificateOutpoint) || requirement.certificateOutpoint.vout !== 0)) return failure("INVALID_INPUT");
      if (coinManagement && (requirement.includeAncestry !== true || requirement.contractIds?.length !== 1 ||
          typeof contractId !== "string" || requirement.assets.length !== 2 || nativeAsset?.kind !== "native" ||
          nativeAsset.minimumAmount !== undefined || requirement.nativeAmount !== undefined || ftAsset?.kind !== "stablecoin" ||
          ftAsset.contractId !== contractId || ftAsset.minimumAmount !== undefined || client.api === undefined)) return failure("INVALID_INPUT");
      const tbc721Mint = requirement.intentType === "tbc721-standard-mint" || requirement.intentType === "tbc721-standard-batch-mint";
      const tbc721 = tbc721Mint || requirement.intentType === "tbc721-standard-create-collection" || requirement.intentType === "tbc721-standard-transfer";
      const slots = requirement.collectionSlots;
      if (tbc721Mint ? !Array.isArray(slots) || slots.length < 1 || slots.length > 100 || new Set(slots).size !== slots.length ||
          slots.some(slot => !Number.isSafeInteger(slot) || slot < 1 || slot > 0xffff_ffff) ||
          (requirement.intentType === "tbc721-standard-mint" && slots.length !== 1) : slots !== undefined) return failure("INVALID_INPUT");
      const nativeTransfer = requirement.intentType === "tbc.transfer" &&
        requirement.assets.length === 1 && nativeAsset?.kind === "native" &&
        nativeAsset.minimumAmount === requirement.nativeAmount && requirement.nativeAmount !== undefined;
      const nativeMerge = requirement.intentType === "tbc.maintenance.merge" &&
        requirement.assets.length === 1 && nativeAsset?.kind === "native" &&
        nativeAsset.minimumAmount === undefined && requirement.nativeAmount === undefined && requirement.includeAncestry === false;
      if (requestedInputOutpoints !== undefined && !nativeTransfer && !nativeMerge && !tbc20 && !tbc721 && !coin && !ammCreate && !lp && !ammBusiness && !timelockLock && !timelockUnlock && !htlcLock && !htlcSpend) return failure("INVALID_INPUT");
      const ftCreate = (requirement.intentType === "tbc.ft.create" || tbc20Create || coinCreate) &&
        requirement.assets.length === 1 && nativeAsset?.kind === "native" &&
        nativeAsset.minimumAmount === undefined && requirement.nativeAmount === undefined && requirement.includeAncestry === false;
      const collectionCreate = (requirement.intentType === "tbc.collection.create" || requirement.intentType === "tbc721-standard-create-collection") &&
        requirement.assets.length === 1 && nativeAsset?.kind === "native" &&
        nativeAsset.minimumAmount === undefined && requirement.nativeAmount === undefined && requirement.includeAncestry === false;
      const nftKind = requirement.intentType === "tbc.nft.mint" || tbc721Mint ? "collection" : "nft";
      const nftSpend = (requirement.intentType === "tbc.nft.mint" || requirement.intentType === "tbc.nft.transfer" || tbc721Mint || requirement.intentType === "tbc721-standard-transfer") &&
        requirement.includeAncestry === true && requirement.contractIds?.length === 1 &&
        typeof contractId === "string" && requirement.assets.length === 2 && nativeAsset?.kind === "native" &&
        nativeAsset.minimumAmount === requirement.nativeAmount && (requirement.intentType === "tbc721-standard-transfer" || requirement.nativeAmount === undefined) &&
        ftAsset?.kind === nftKind && ftAsset.contractId === contractId && ftAsset.minimumAmount === (tbc721Mint ? String(slots!.length) : "1") && client.api !== undefined;
      const ftTransfer = (requirement.intentType === "tbc.ft.transfer" || requirement.intentType === "tbc20-standard-transfer" || (htlcTokenLock && tbc20)) &&
        requirement.includeAncestry === true && requirement.contractIds?.length === 1 &&
        typeof contractId === "string" && requirement.assets.length === 2 &&
        nativeAsset?.kind === "native" && nativeAsset.minimumAmount === requirement.nativeAmount &&
        ftAsset?.kind === "ft" &&
        ftAsset.contractId === contractId && ftAsset.minimumAmount !== undefined;
      const stablecoinTransfer = (requirement.intentType === "tbc.stablecoin.transfer" || requirement.intentType === "tbc20-stablecoin-transfer" || (htlcTokenLock && coin)) &&
        requirement.includeAncestry === true && requirement.contractIds?.length === 1 &&
        typeof contractId === "string" && requirement.assets.length === 2 &&
        nativeAsset?.kind === "native" && nativeAsset.minimumAmount === requirement.nativeAmount &&
        ftAsset?.kind === "stablecoin" &&
        ftAsset.contractId === contractId && ftAsset.minimumAmount !== undefined;
      const ftMerge = (requirement.intentType === "tbc.ft.merge" || requirement.intentType === "tbc20-standard-merge") &&
        requirement.includeAncestry === true && requirement.contractIds?.length === 1 &&
        typeof contractId === "string" && requirement.assets.length === 2 &&
        nativeAsset?.kind === "native" && nativeAsset.minimumAmount === undefined && requirement.nativeAmount === undefined &&
        ftAsset?.kind === "ft" && ftAsset.contractId === contractId && ftAsset.minimumAmount === undefined;
      const stablecoinMerge = (requirement.intentType === "tbc.stablecoin.merge" || requirement.intentType === "tbc20-stablecoin-merge") &&
        requirement.includeAncestry === true && requirement.contractIds?.length === 1 &&
        typeof contractId === "string" && requirement.assets.length === 2 &&
        nativeAsset?.kind === "native" && nativeAsset.minimumAmount === undefined && requirement.nativeAmount === undefined &&
        ftAsset?.kind === "stablecoin" && ftAsset.contractId === contractId && ftAsset.minimumAmount === undefined;
      const poolMint = requirement.intentType === "tbc.pool.create" &&
        requirement.includeAncestry === true && requirement.contractIds?.length === 1 &&
        typeof contractId === "string" && requirement.nativeAmount === undefined &&
        requirement.assets.length === 2 && nativeAsset?.kind === "native" &&
        nativeAsset.contractId === undefined && nativeAsset.minimumAmount === undefined &&
        ftAsset?.kind === "ft" && ftAsset.contractId === contractId &&
        ftAsset.contractDependency === undefined && ftAsset.minimumAmount === undefined;
      const poolContractId = requirement.contractIds?.[0];
      const poolAsset = requirement.assets[1];
      const poolFtAsset = requirement.assets[2];
      const poolAdd = requirement.intentType === "tbc.pool.liquidity.add" &&
        requirement.includeAncestry === true && requirement.contractIds?.length === 1 &&
        typeof poolContractId === "string" && requirement.assets.length === 3 &&
        requirement.nativeAmount !== undefined && nativeAsset?.kind === "native" &&
        nativeAsset.contractId === undefined && nativeAsset.minimumAmount === requirement.nativeAmount &&
        poolAsset?.kind === "pool" && poolAsset.contractId === poolContractId &&
        poolAsset.minimumAmount === undefined && poolFtAsset?.kind === "ft" &&
        poolFtAsset.contractId === undefined && poolFtAsset.contractDependency?.relation === "pool-ft" &&
        poolFtAsset.contractDependency.contractId === poolContractId && poolFtAsset.minimumAmount === undefined &&
        options.poolMaterial !== undefined;
      const poolRemove = requirement.intentType === "tbc.pool.liquidity.remove" &&
        requirement.includeAncestry === true && requirement.contractIds?.length === 1 &&
        typeof poolContractId === "string" && requirement.assets.length === 3 &&
        requirement.nativeAmount === undefined && nativeAsset?.kind === "native" &&
        nativeAsset.contractId === undefined && nativeAsset.minimumAmount === undefined &&
        poolAsset?.kind === "pool" && poolAsset.contractId === poolContractId &&
        poolAsset.minimumAmount === undefined && poolFtAsset?.kind === "ftlp" &&
        poolFtAsset.contractId === undefined && poolFtAsset.contractDependency?.relation === "pool-lp" &&
        poolFtAsset.contractDependency.contractId === poolContractId && poolFtAsset.minimumAmount !== undefined &&
        options.poolMaterial?.resolveLiquidityRemove !== undefined;
      const poolSwapTbcForToken = requirement.intentType === "tbc.pool.swap.exactTbcForToken" &&
        requirement.includeAncestry === true && requirement.contractIds?.length === 1 &&
        typeof poolContractId === "string" && requirement.assets.length === 3 &&
        requirement.nativeAmount !== undefined && nativeAsset?.kind === "native" &&
        nativeAsset.minimumAmount === requirement.nativeAmount && poolAsset?.kind === "pool" &&
        poolAsset.contractId === poolContractId && poolFtAsset?.kind === "ft" &&
        poolFtAsset.contractDependency?.relation === "pool-ft" &&
        poolFtAsset.contractDependency.contractId === poolContractId && poolFtAsset.minimumAmount === undefined &&
        options.poolMaterial?.resolveSwapTbcForToken !== undefined;
      const poolSwapTokenForTbc = requirement.intentType === "tbc.pool.swap.exactTokenForTbc" &&
        requirement.includeAncestry === true && requirement.contractIds?.length === 1 &&
        typeof poolContractId === "string" && requirement.assets.length === 3 &&
        requirement.nativeAmount === undefined && nativeAsset?.kind === "native" &&
        nativeAsset.minimumAmount === undefined && poolAsset?.kind === "pool" &&
        poolAsset.contractId === poolContractId && poolFtAsset?.kind === "ft" &&
        poolFtAsset.contractDependency?.relation === "pool-ft" &&
        poolFtAsset.contractDependency.contractId === poolContractId && poolFtAsset.minimumAmount !== undefined &&
        options.poolMaterial?.resolveSwapTokenForTbc !== undefined;
      const poolFtMerge = requirement.intentType === "tbc.pool.ft.merge" &&
        requirement.includeAncestry === true && requirement.contractIds?.length === 1 &&
        typeof poolContractId === "string" && requirement.assets.length === 3 &&
        requirement.nativeAmount === undefined && nativeAsset?.kind === "native" &&
        nativeAsset.minimumAmount === undefined && poolAsset?.kind === "pool" &&
        poolAsset.contractId === poolContractId && poolFtAsset?.kind === "ft" &&
        poolFtAsset.minimumAmount === undefined &&
        poolFtAsset.contractDependency?.relation === "pool-ft" &&
        poolFtAsset.contractDependency.contractId === poolContractId &&
        options.poolMaterial?.resolvePoolFtMerge !== undefined;
      const poolFtlpMerge = requirement.intentType === "tbc.pool.ftlp.merge" &&
        requirement.includeAncestry === true && requirement.contractIds?.length === 1 &&
        typeof poolContractId === "string" && requirement.assets.length === 3 &&
        requirement.nativeAmount === undefined && nativeAsset?.kind === "native" &&
        nativeAsset.minimumAmount === undefined && poolAsset?.kind === "pool" &&
        poolAsset.contractId === poolContractId && poolFtAsset?.kind === "ftlp" &&
        poolFtAsset.minimumAmount === undefined &&
        poolFtAsset.contractDependency?.relation === "pool-lp" &&
        poolFtAsset.contractDependency.contractId === poolContractId &&
        options.poolMaterial?.resolveFtlpMerge !== undefined;
      const poolFtlpBurn = requirement.intentType === "tbc.pool.ftlp.burn" &&
        requirement.includeAncestry === true && requirement.contractIds?.length === 1 &&
        typeof poolContractId === "string" && requirement.assets.length === 3 &&
        requirement.nativeAmount === undefined && nativeAsset?.kind === "native" &&
        nativeAsset.minimumAmount === undefined && poolAsset?.kind === "pool" &&
        poolAsset.contractId === poolContractId && poolFtAsset?.kind === "ftlp" &&
        poolFtAsset.minimumAmount === undefined &&
        poolFtAsset.contractDependency?.relation === "pool-lp" &&
        poolFtAsset.contractDependency.contractId === poolContractId &&
        options.poolMaterial?.resolveFtlpBurn !== undefined;
      const poolInitialize = requirement.intentType === "tbc.pool.create" &&
        requirement.includeAncestry === true && requirement.contractIds?.length === 1 &&
        typeof poolContractId === "string" && requirement.assets.length === 3 &&
        requirement.nativeAmount !== undefined && nativeAsset?.kind === "native" &&
        nativeAsset.minimumAmount === requirement.nativeAmount && poolAsset?.kind === "pool" &&
        poolAsset.contractId === poolContractId && poolFtAsset?.kind === "ft" &&
        poolFtAsset.contractDependency?.relation === "pool-ft" &&
        poolFtAsset.contractDependency.contractId === poolContractId && poolFtAsset.minimumAmount !== undefined &&
        options.poolMaterial?.resolveCreateInitialize !== undefined;
      const supportedPool = poolMint || poolInitialize || poolAdd || poolRemove || poolSwapTbcForToken || poolSwapTokenForTbc || poolFtMerge || poolFtlpMerge || poolFtlpBurn;
      if (!nativeTransfer && !nativeMerge && !ftCreate && !ftTransfer && !ftMerge && !stablecoinTransfer && !stablecoinMerge && !supportedPool && !collectionCreate && !nftSpend && !coinManagement && !ammCreate && !lp && !ammBusiness && !timelockLock && !timelockUnlock && !htlcLock && !htlcSpend && !htlcTokenSpend) return failure("INVALID_INPUT");
      if (nativeTransfer || requirement.nativeAmount !== undefined) positive(requirement.nativeAmount, "native amount");
      const minimumFt = ftTransfer || stablecoinTransfer ? positive(ftAsset?.minimumAmount, "fungible amount") : 0n;
      if (poolInitialize || poolRemove || poolSwapTokenForTbc) positive(poolFtAsset?.minimumAmount, "Pool asset amount");

      const currentAccounts = boundAccount === undefined ? await options.accounts.current() : undefined;
      const account = boundAccount === undefined
        ? currentAccounts!.find((candidate) =>
            candidate.accountId === params.accountId && candidate.chainId === params.chainId,
          )
        : boundAccount.accountId === params.accountId && boundAccount.chainId === params.chainId
          ? boundAccount
          : undefined;
      if (account === undefined || account.accountId !== `${account.chainId}:${account.address}`) {
        throw new ChainDataAuthorizationError("Chain Data account mismatch");
      }
      if (!validSigningRoleScope(params.signingRoles, requirement.intentType)) return failure("INVALID_INPUT");
      if (params.signingRoles === undefined && params.signingAccounts !== undefined) return failure("INVALID_INPUT");
      const roleRequest = { chainId: params.chainId, from: account.address, signingRoles: params.signingRoles };
      // Host supplied accounts are already permission-bound; standalone DApp
      // preparation uses its single current() result. Neither grants authority.
      const roleAccounts = params.signingRoles === undefined ? undefined : resolveTransactionSigningAccounts(
        roleRequest, currentAccounts ?? [account, ...(params.signingAccounts ?? [])],
      );
      if (params.signingAccounts !== undefined && roleAccounts !== undefined) {
        assertTransactionSigningSnapshot(roleRequest, [roleAccounts.primary, ...roleAccounts.additional], {
          chainId: params.chainId, account, signingAccounts: params.signingAccounts,
        });
      }
      const address = assertTbcAddress(account.address, network.profile.p2pkhVersion);

      const parentReads = new Map<string, Promise<TransactionMaterial>>();
      const freshTbc20Reads = new Map<string, Promise<TransactionMaterial>>();
      const readFreshTbc20Parent = (txid: string): Promise<TransactionMaterial> => {
        // A concurrently loaded immutable Genesis raw has no fresh confirmation
        // fact. Only an index without height under a nonzero policy needs this.
        let pending = freshTbc20Reads.get(txid);
        if (pending === undefined) {
          pending = client.getRawTransaction(txid).then(materialFromDecoded)
            .then((value) => { remember(value); return value; });
          freshTbc20Reads.set(txid, pending);
          if (!parentReads.has(txid)) parentReads.set(txid, pending);
        }
        return pending;
      };
      const readDecoded = (txid: string): Promise<TransactionMaterial> => {
        let pending = parentReads.get(txid);
        if (pending === undefined) {
          pending = client.getRawTransaction(txid).then((value) => materialFromDecoded(value)).then((value) => { remember(value); return value; });
          parentReads.set(txid, pending);
        }
        return pending;
      };
      const readHistory = (txid: string): Promise<TransactionMaterial> => {
        const cached = immutable.get(txid);
        if (cached !== undefined) return Promise.resolve(cached);
        let pending = parentReads.get(txid);
        if (pending === undefined) {
          pending = (client.getRawTransactionBytes === undefined
            ? client.getRawTransaction(txid).then(materialFromDecoded)
            : client.getRawTransactionBytes(txid).then((raw) => materialFromRaw(txid, raw, inspect)))
            .then((value) => { remember(value); return value; });
          parentReads.set(txid, pending);
        }
        return pending;
      };

      const directFt = ftTransfer || ftMerge || stablecoinTransfer || stablecoinMerge || poolMint;
      if (timelockUnlock || htlcSpend) {
        const material = htlcSpend ? await resolveHtlcMaterial({ api: client.api!,
          branch: requirement.intentType === "tbc-htlc-claim" ? "claim" : "refund",
          ownerScript: address.scriptPubKey, inputOutpoints: requestedInputOutpoints!, minimumConfirmations: minimumConfirmations ?? "0",
          readHistory, readDecoded: readFreshTbc20Parent }) : await resolveTimelockMaterial({ api: client.api!, address: account.address,
          ownerScript: address.scriptPubKey, inputOutpoints: requestedInputOutpoints!, minimumConfirmations: minimumConfirmations ?? "0",
          readHistory, readDecoded: readFreshTbc20Parent });
        const captured = now();
        const payload = Object.freeze({ version: "1.0", snapshotId: await snapshotId(), chainId: params.chainId,
          ...(material.tip === undefined ? {} : {block: material.tip}), capturedAt: canonicalTime(captured), expiresAt: canonicalTime(captured + snapshotTtlMs),
          account: Object.freeze({ accountId: account.accountId, address: account.address, chainId: account.chainId, publicKey: account.publicKey }),
          utxos: material.utxos, parents: Object.freeze(material.parents.map(({txid,rawTransaction}) => Object.freeze({txid,rawTransaction}))), contracts: Object.freeze([]) });
        const result = Object.freeze({ payload, snapshotHash: hashCanonical(payload) });
        assertValidTws("chainDataResolveResult", result);
        return result;
      }
      // Retain native alternatives for exact Rust selection without parent reads.
      // Historical profiles normally select one fee input; new TBC20 can select
      // multiple fee inputs inside its total six-input bound (accounted below).
      const ftNativeAlternatives = ftTransfer || ftMerge || stablecoinTransfer || stablecoinMerge || tbc20Create || ammCreate || lp || ammBusiness || timelockLock || htlcLock || htlcTokenSpend;
      const nativeInputBudget = (count: number) => ftNativeAlternatives || supportedPool ? Math.min(count, 1) : count;
      const ftIndex = directFt
        ? stablecoinTransfer || stablecoinMerge
          ? client.getStablecoinUtxos(account.address, contractId!)
          : client.getFtUtxos(account.address, contractId!)
        : Promise.resolve(undefined);
      const skipTip = minimumConfirmations === "0" && !htlcTokenLock &&
        (nativeTransfer || nativeMerge || poolSwapTbcForToken || poolSwapTokenForTbc || poolFtMerge || poolAdd || poolRemove || poolFtlpMerge || poolFtlpBurn || ammCreate || ammBusiness || lp || (htlcTokenSpend && requirement.intentType === "tbc-htlc-claim") || (ftCreate && !coinCreate) || collectionCreate ||
          (stablecoinTransfer || stablecoinMerge || ftTransfer || ftMerge || nftSpend)) && client.getNativeUtxos !== undefined;
      const nativeIndex: Promise<Readonly<{ tip?: TestnetTip; utxos: readonly TestnetUtxo[] }>> = skipTip
        ? client.getNativeUtxos!(account.address, nativeMerge ? { limit: Math.min(maxInputs, MAX_TBC_MERGE_INPUTS) } : undefined).then(utxos => ({ utxos }))
        : client.getUtxos(account.address, nativeMerge ? { limit: Math.min(maxInputs, MAX_TBC_MERGE_INPUTS) } : undefined);
      let observedTip: TestnetTip | undefined, pendingTip: Promise<TestnetTip> | undefined;
      const readTip = () => pendingTip ??= nativeIndex.then(async index => {
        observedTip = index.tip ?? (client.getTip === undefined ? (await client.getUtxos(account.address)).tip : await client.getTip());
        return observedTip;
      });
      // New Coin ID is the issuance certificate source. Do not query or walk
      // latest mint state: the Engine authenticates source + selected ancestry.
      const stableInfo = (stablecoinTransfer || stablecoinMerge) ? client.getStablecoinInfo(contractId!) : undefined;
      stableInfo?.catch(() => undefined);
      const fungibleInfo = stableInfo ?? ((ftTransfer || ftMerge) ? client.getFtInfo(contractId!) : undefined);
      fungibleInfo?.catch(() => undefined);
      const coinAdmin = coin && directFt ? stableInfo!.then(async info => {
        const [code] = await inspectReviewedTokenCodes(options.materialNative!, [info.codeScript]);
        if (code?.standardId !== "tbc20-stablecoin" || code.adminPubkeyHash === undefined) throw new ChainDataConflictError("Indexed Coin template invalid");
        return code.adminPubkeyHash;
      }) : undefined;
      coinAdmin?.catch(() => undefined);
      const ftPreparation = (tbc20 || coin) && directFt
        ? Promise.all([
            ftIndex.then(async (candidates) => {
              let eligible = candidates!;
              const floor = BigInt(minimumConfirmations ?? "0");
              if (floor > 0n && !coin) {
                const { tip } = await nativeIndex;
                const height = BigInt(requireTip(tip).height);
                const confirmed: TestnetFtUtxo[] = [];
                let amount = 0n;
                let decodedCount = 0;
                for (const candidate of [...eligible].sort((a, b) => a.txid.localeCompare(b.txid) || a.vout - b.vout)) {
                  if (requestedInputOutpoints !== undefined && !requestedInputOutpoints.some((item) => item.txid === candidate.txid && item.vout === candidate.vout)) continue;
                  let count: bigint;
                  if (candidate.height !== undefined) {
                    const at = BigInt(candidate.height);
                    if (at > height || at < 0n) throw new ChainDataConflictError("TBC20 index height is invalid");
                    count = at === 0n ? 0n : height - at + 1n;
                  } else {
                    if (++decodedCount > maxInputs) throw new ChainDataConflictError("TBC20 confirmation discovery exceeds policy");
                    const decoded = await readFreshTbc20Parent(candidate.txid);
                    if (decoded.confirmations === undefined) throw new ChainDataConflictError("TBC20 confirmations are unknown");
                    count = BigInt(decoded.confirmations);
                  }
                  if (count < floor) continue;
                  confirmed.push(candidate);
                  amount += positive(candidate.ftAmount, "TBC20 index amount");
                  if ((!ftMerge && !stablecoinMerge && requestedInputOutpoints === undefined && amount >= minimumFt) ||
                      (htlcTokenLock ? confirmed.length >= Math.min(maxInputs, MAX_FT_ASSET_INPUTS)
                        : confirmed.length > Math.min(maxInputs, MAX_TBC20_ASSET_INPUTS))) break;
                }
                eligible = confirmed;
              }
              if (coin) return prepareCoinCandidates(eligible, minimumFt, stablecoinMerge, requestedInputOutpoints,
                Math.min(maxInputs, htlcTokenLock ? MAX_FT_ASSET_INPUTS : MAX_TBC20_ASSET_INPUTS),
                (txid) => minimumConfirmations === "0" || eligible.filter((item) => item.txid === txid).every((item) => item.height !== undefined)
                  ? readHistory(txid) : readFreshTbc20Parent(txid),
                readTip, coinAdmin!, address.publicKeyHash, floor);
              const selected = selectTbc20Candidates(eligible, minimumFt, ftMerge || stablecoinMerge, requestedInputOutpoints, Math.min(maxInputs, coin || htlcTokenLock ? MAX_FT_ASSET_INPUTS : MAX_TBC20_ASSET_INPUTS));
              const selectedParents = await Promise.all([...new Set(selected.map((item) => item.txid))].map((txid) =>
                minimumConfirmations === "0" || selected.filter((item) => item.txid === txid).every((item) => item.height !== undefined)
                  ? readHistory(txid) : readFreshTbc20Parent(txid),
              ));
              return { selected, selectedParents };
            }),
            undefined,
            undefined,
            fungibleInfo,
          ]).then(([selected, creation, source, stablecoinInfo]) => ({ ...selected, creation, source, stablecoinInfo }))
        : directFt
        ? ftIndex.then(async (candidates) => {
            const selected = ftMerge || stablecoinMerge
              ? selectFtMergeCandidates(candidates!)
              : stablecoinTransfer
                ? selectStablecoinCandidates(candidates!, minimumFt, Math.max(1, maxInputs - 1))
                : selectFtCandidates(candidates!, minimumFt, maxInputs - 1);
            const [selectedParents, creation, stablecoinInfo] = await Promise.all([
              Promise.all([...new Set(selected.map((item) => item.txid))].map((txid) =>
                minimumConfirmations === "0" || selected.filter((item) => item.txid === txid).every((item) => item.height !== undefined)
                  ? readHistory(txid) : readDecoded(txid),
              )),
              fungibleInfo === undefined ? readHistory(contractId!) : undefined,
              fungibleInfo,
            ]);
            return { selected, selectedParents, creation, stablecoinInfo, source: undefined };
          })
        : Promise.resolve(undefined);
      // Exact direct proofs are known as soon as selected parents arrive.
      // Start them before waiting for unrelated native funding or issuance.
      const directProofReads = new Map<string, Promise<TransactionMaterial>>();
      const prefetchDirectProofs = ftPreparation.then(prepared => {
        if (prepared === undefined || (!ftTransfer && !ftMerge && !stablecoinTransfer && !stablecoinMerge)) return;
        const selectedParents = new Map(prepared.selectedParents.map(parent => [parent.txid, parent]));
        const references = new Set(prepared.selected.flatMap(candidate => {
          const parent = selectedParents.get(candidate.txid)!;
          const refs = coin ? inspectCoinAncestryReferences : tbc20 ? inspectTbc20AncestryReferences : inspectFtAncestryReferences;
          return refs(inspect(parent.rawTransaction).transaction, candidate.vout).map(point => point.txid);
        }));
        for (const id of references) {
          if (id === ZERO_TXID || id === contractId || selectedParents.has(id)) continue;
          const pending = readHistory(id);
          pending.catch(() => undefined);
          directProofReads.set(id, pending);
        }
      });
      prefetchDirectProofs.catch(() => undefined);
      const nativeIndexPreparation = nativeIndex.then(({ tip, utxos: nativeCandidates }) => {
        if (nativeCandidates.length > (nativeMerge ? MAX_TBC_MERGE_INPUTS : MAX_NATIVE_UTXO_CANDIDATES)) throw new ChainDataConflictError("Too many native UTXO candidates");
        const tipHeight = tip === undefined ? undefined : BigInt(tip.height);
        const sortedNative = [...nativeCandidates].sort((a, b) => a.txid.localeCompare(b.txid) || a.vout - b.vout);
        validateNativeCandidates(sortedNative, tipHeight);
        const poolFunding = supportedPool || coinCreate || coinManagement || ammBusiness
          ? [...sortedNative]
              .sort((left, right) => BigInt(left.satoshis) === BigInt(right.satoshis)
                ? left.txid.localeCompare(right.txid) || left.vout - right.vout
                : BigInt(left.satoshis) > BigInt(right.satoshis) ? -1 : 1)
          : undefined;
        // Coin issuance needs one complete parent for its certificate proof.
        // Reuse the existing largest-first fee policy; never fetch every fee
        // candidate's ancestry. An explicit selection must not be replaced.
        if (coinCreate && requestedInputOutpoints !== undefined && requestedInputOutpoints.length !== 1) {
          throw new ChainDataConflictError("Coin creation requires one selected native funding output");
        }
        const selectedNative = coinCreate || coinManagement || ammBusiness
          ? requestedInputOutpoints === undefined
            ? poolFunding!.filter(utxo => (minimumConfirmations ?? "0") === "0" || BigInt(confirmations(utxo, tipHeight)!) >= BigInt(minimumConfirmations!))
                .slice(0, ammBusiness ? Math.min(maxInputs, MAX_AMM_FUNDING_INPUTS) : 1)
            : coinCreate ? selectRequestedNativeOutpoints(sortedNative, requestedInputOutpoints)
              : sortedNative.filter(candidate => requestedInputOutpoints.some(point => point.txid === candidate.txid && point.vout === candidate.vout))
          : poolFunding ?? (nativeTransfer
          ? requestedInputOutpoints === undefined
            ? selectNativeTransfer(sortedNative, BigInt(requirement.nativeAmount!), maxInputs)
            : selectRequestedNativeOutpoints(sortedNative, requestedInputOutpoints)
          : nativeMerge
            ? requestedInputOutpoints !== undefined
              ? selectRequestedNativeOutpoints(sortedNative, requestedInputOutpoints)
              : [...sortedNative]
                .sort((left, right) => BigInt(left.satoshis) === BigInt(right.satoshis)
                  ? left.txid.localeCompare(right.txid) || left.vout - right.vout
                  : BigInt(left.satoshis) < BigInt(right.satoshis) ? -1 : 1)
                .slice(0, Math.min(maxInputs, MAX_TBC_MERGE_INPUTS))
            : (tbc20 || tbc721 || coin || ammCreate || lp || timelockLock || htlcLock) && requestedInputOutpoints !== undefined
              ? sortedNative.filter((candidate) => requestedInputOutpoints.some((item) => item.txid === candidate.txid && item.vout === candidate.vout))
              : sortedNative);
        if (nativeMerge && selectedNative.length < 2) throw new ChainDataConflictError("TBC merge requires at least two inputs");
        if (coinManagement && selectedNative.length !== 1) throw new ChainDataConflictError("Coin management requires one selected native fee output");
        if (ammBusiness && requestedInputOutpoints !== undefined && selectedNative.length !== 1) throw new ChainDataConflictError("AMM explicit inputs require one selected native funding output");
        // TBC20 merging can release enough native value from spent Code outputs
        // to pay fees without a separate native input. Rust computes sufficiency.
        if ((selectedNative.length === 0 && !(tbc20 && directFt)) || nativeInputBudget(selectedNative.length) > maxInputs) throw new ChainDataConflictError("Selected UTXO count exceeds policy");
        const indexedHeights = Object.freeze(Object.fromEntries(sortedNative.map((utxo) => [utxo.txid, utxo.height])));
        return { tip, tipHeight, selectedNative, indexedHeights };
      });
      const nativePreparation = nativeIndexPreparation.then(async ({ tip, tipHeight, selectedNative, indexedHeights }) => {
        const nativeParentNodes = supportedPool
          ? await Promise.all(selectedNative.slice(0, 1).map(async (utxo) => {
              const parent = await readHistory(utxo.txid);
              const node = { ...parent, confirmations: confirmations(utxo, tipHeight)!,
                outputs: parent.outputs.map(output => ({...output,
                  addresses: output.scriptPubKey === address.scriptPubKey ? [account.address] : []})) };
              const output = node.outputs[utxo.vout];
              if (node.txid !== utxo.txid || output === undefined || output.satoshis !== utxo.satoshis ||
                output.scriptPubKey !== address.scriptPubKey || output.addresses.length !== 1 || output.addresses[0] !== account.address ||
                node.confirmations !== confirmations(utxo, tipHeight)) {
                throw new ChainDataConflictError("Pool funding parent mismatch");
              }
              return node;
            }))
          : [];
        const nativeParentValues = coinCreate || coinManagement || ammBusiness
          // AMM alternatives use the same fresh index descriptors as the
          // shared native prerequisite. Only the preferred direct AMM input
          // needs a full parent; keep the successful one-input HTTP path.
          ? await Promise.all((ammBusiness ? selectedNative.slice(0, 1) : selectedNative).map(async (utxo) => {
              const parent = await readHistory(utxo.txid);
              const output = parent.outputs[utxo.vout];
              if (output === undefined || output.satoshis !== utxo.satoshis || output.scriptPubKey !== address.scriptPubKey) {
                throw new ChainDataConflictError("Selected funding parent mismatch");
              }
              return parent;
            }))
          : nativeParentNodes.map(materialFromDecoded);
        const nativeUtxos = selectedNative.map((utxo) => Object.freeze({
          txid: utxo.txid,
          vout: utxo.vout,
          satoshis: utxo.satoshis,
          scriptPubKey: address.scriptPubKey,
          ...(confirmations(utxo, tipHeight) === undefined ? {} : { confirmations: confirmations(utxo, tipHeight)! }),
          classification: "native" as const,
        }));
        const selectedFunding = selectedNative[0];
        const selectedParent = nativeParentNodes[0];
        const nativeFunding: LegacyPoolFunding | undefined = (poolAdd || poolRemove || poolSwapTbcForToken || poolSwapTokenForTbc || poolFtMerge || poolFtlpMerge || poolFtlpBurn) && selectedFunding && selectedParent
          ? Object.freeze({
              address: account.address,
              ...(tip === undefined ? {} : { tipHeight: tip.height }),
              indexedHeights,
              txid: selectedFunding.txid,
              vout: selectedFunding.vout,
              satoshis: selectedFunding.satoshis,
              rawTransaction: selectedParent.rawTransaction,
            })
          : undefined;
        return { tip, tipHeight, nativeUtxos, nativeParentValues, nativeFunding, indexedHeights };
      });
      const readNativeFunding = Object.assign(
        async () => {
          const funding = (await nativePreparation).nativeFunding;
          if (funding === undefined) throw new ChainDataConflictError("Missing selected native funding");
          return funding;
        },
        { readTipHeight: async () => (await readTip()).height, readIndex: async () => {
          const value = await nativeIndexPreparation;
          const selected = value.selectedNative[0];
          return {
            ...(value.tip === undefined ? {} : { tipHeight: value.tip.height }),
            indexedHeights: value.indexedHeights,
            ...(selected === undefined
              ? {}
              : { selectedParentTxid: selected.txid }),
          };
        } },
      );
      const poolInitializeInput: PoolCreateInitializeMaterialRequest | undefined = poolInitialize
        ? Object.freeze({
            address: account.address,
            receiver: account.address,
            poolContractId: poolContractId!,
            tbcAmount: requirement.nativeAmount!,
            ftAmount: poolFtAsset!.minimumAmount!,
          })
        : undefined;
      const poolPreparation: Promise<PoolMaterial | PoolLiquidityRemoveMaterial | PoolCreateInitializeMaterial | PoolSwapMaterial | PoolMergeMaterial | undefined> = (async () => {
        if (poolAdd) return options.poolMaterial?.resolveLiquidityAdd({
          address: account.address, receiver: account.address, poolContractId: poolContractId!, tbcAmount: requirement.nativeAmount!,
        }, readNativeFunding, client.api);
        if (poolRemove) return options.poolMaterial?.resolveLiquidityRemove?.({
          address: account.address, receiver: account.address, poolContractId: poolContractId!, lpAmount: poolFtAsset!.minimumAmount!,
        }, readNativeFunding, client.api);
        if (poolInitializeInput !== undefined) {
          return options.poolMaterial?.resolveCreateInitialize?.(poolInitializeInput);
        }
        if (poolSwapTbcForToken) return options.poolMaterial?.resolveSwapTbcForToken?.({
          address: account.address, receiver: account.address, poolContractId: poolContractId!, tbcAmount: requirement.nativeAmount!,
        }, readNativeFunding, client.api);
        if (poolSwapTokenForTbc) return options.poolMaterial?.resolveSwapTokenForTbc?.({
          address: account.address, receiver: account.address, poolContractId: poolContractId!, ftAmount: poolFtAsset!.minimumAmount!,
        }, readNativeFunding, client.api);
        if (poolFtMerge) return options.poolMaterial?.resolvePoolFtMerge?.({
          address: account.address, poolContractId: poolContractId!,
        }, readNativeFunding, client.api);
        if (poolFtlpMerge) return options.poolMaterial?.resolveFtlpMerge?.({
          address: account.address, poolContractId: poolContractId!,
        }, readNativeFunding, client.api);
        if (poolFtlpBurn) return options.poolMaterial?.resolveFtlpBurn?.({
          address: account.address, poolContractId: poolContractId!,
        }, readNativeFunding, client.api);
        return undefined;
      })();
      const nftPreparation = nftSpend ? resolveNftMaterial({
        kind: nftKind, contractId: contractId!, ownerScript: address.scriptPubKey,
        api: client.api!, readHistory,
        readDecoded: tbc721 ? readFreshTbc20Parent : (txid) => client.getRawTransaction(txid).then(materialFromDecoded),
        tipHeight: nativeIndexPreparation.then(value => value.tip === undefined ? undefined : BigInt(value.tip.height)), minimumConfirmations,
        ...(tbc721 ? { standardId: "tbc721-standard" as const, ...(slots === undefined ? {} : { collectionSlots: slots }) } : {}),
      }) : Promise.resolve(undefined);
      const coinManagementPreparation = coinManagement ? resolveCoinManagementMaterial({
        mint: coinMint, contractId: contractId!, api: client.api!, readHistory, readDecoded: readFreshTbc20Parent,
        ancestors: (parent, vout) => inspectCoinAncestryReferences(inspect(parent.rawTransaction).transaction, vout).map(point => point.txid),
        tipHeight: nativeIndexPreparation.then(value => BigInt(requireTip(value.tip).height)), minimumConfirmations,
        ...(requirement.targetOutpoints === undefined ? {} : { targetOutpoints: requirement.targetOutpoints }),
        ...(requirement.certificateOutpoint === undefined ? {} : { certificateOutpoint: requirement.certificateOutpoint }),
      }) : Promise.resolve(undefined);
      const htlcTokenPreparation = htlcTokenSpend ? resolveHtlcTokenMaterial({
        assetStandard: coin ? "tbc20-stablecoin" : "tbc20-standard", contractId: contractId!,
        templateRevision: coin ? COIN_TEMPLATE_REVISION : TBC20_TEMPLATE_REVISION,
        target: requirement.targetOutpoints![0]!, branch: requirement.intentType === "tbc-htlc-claim" ? "claim" : "refund",
        ownerScript: address.scriptPubKey, minimumConfirmations: minimumConfirmations ?? "0", api: client.api!,
        readIdentity: () => coin ? client.getStablecoinInfo(contractId!) : client.getFtInfo(contractId!),
        readHistory, readDecoded: readFreshTbc20Parent, readTip,
        tokenLockTime: async parent => {
          if (options.materialNative === undefined) throw new Error("Token lock inspection requires keyless material codec");
          const result = JSON.parse(await options.materialNative.execute("inspectLopMaterial", JSON.stringify({
            phase: "inspectAsset", parent: {txid: parent.txid, rawTransaction: parent.rawTransaction}, vout: 1,
          })));
          return result.lockTime;
        },
        ancestors: (parent, vout) => (coin ? inspectCoinAncestryReferences : inspectTbc20AncestryReferences)(inspect(parent.rawTransaction).transaction, vout).map(point => point.txid),
      }) : Promise.resolve(undefined);
      const ammPreparation = ammCreate
        ? resolveAmmCreateMaterial({ contractId: contractId!, readIdentity: () => client.getFtInfo(contractId!) })
        : lp ? resolveLpMaterial({
            readFtInfo: id => client.getFtInfo(id),
            contractId: contractId!, intentType: requirement.intentType, publicKey: account.publicKey,
            api: client.api!, native: options.materialNative!, readHistory, readDecoded: readFreshTbc20Parent,
            readTip, minimumConfirmations,
            ...(ftAsset?.minimumAmount === undefined ? {} : { amount: ftAsset.minimumAmount }),
            ...(requestedInputOutpoints === undefined ? {} : { inputOutpoints: requestedInputOutpoints }),
          }) : ammBusiness ? resolveAmmBusinessMaterial({
            readFtInfo: id => client.getFtInfo(id),
            contractId: contractId!, publicKey: account.publicKey, action: ammAction!,
            ...(roleAccounts === undefined ? {} : { controllerPublicKey: roleAccounts.roles[0]!.account.publicKey }),
            api: client.api!, native: options.materialNative!, readHistory, readDecoded: readFreshTbc20Parent,
            readTip, minimumConfirmations,
            ...(requestedInputOutpoints === undefined ? {} : { inputOutpoints: requestedInputOutpoints }),
          }) : Promise.resolve(undefined);
      const [preparedNative, preparedFt, poolMaterial, nftMaterial, coinManagementMaterial, ammMaterial, htlcTokenMaterial] = await Promise.all([nativePreparation, ftPreparation, poolPreparation, nftPreparation, coinManagementPreparation, ammPreparation, htlcTokenPreparation]);
      await prefetchDirectProofs;
      if (supportedPool && !poolMint && poolMaterial === undefined) throw new ChainDataConflictError("Pool material is unavailable");
      if (poolAdd && poolMaterial !== undefined && "review" in poolMaterial && "lockTime" in poolMaterial.review && poolMaterial.review.lockTime !== "0") await readTip();
      const { nativeUtxos, nativeParentValues } = preparedNative;
      const tip = observedTip ?? preparedNative.tip;
      const tipHeight = tip === undefined ? undefined : BigInt(tip.height);

      let assetUtxos: readonly unknown[] = Object.freeze([]);
      let parents: readonly TransactionMaterial[] = nativeParentValues;
      let contracts: readonly unknown[] = Object.freeze([]);
      if (directFt && preparedFt !== undefined) {
        const selectedInputBudget = tbc20 && !htlcTokenLock
          ? Math.min(nativeUtxos.length, preparedFt.selected.length > MAX_TBC20_INPUTS ? 1 : MAX_TBC20_INPUTS - preparedFt.selected.length) + preparedFt.selected.length
          : nativeInputBudget(nativeUtxos.length) + preparedFt.selected.length;
        if (selectedInputBudget > maxInputs) throw new ChainDataConflictError("FT input count exceeds policy");
        const parentMap = new Map(preparedFt.selectedParents.map((value) => [value.txid, value]));
        assetUtxos = Object.freeze(preparedFt.selected.map((candidate) => {
          const parent = parentMap.get(candidate.txid);
          const output = parent?.outputs[candidate.vout];
          const height = candidate.height === undefined ? undefined : BigInt(candidate.height);
          const candidateConfirmations = height === undefined || tipHeight === undefined ? parent?.confirmations : height === 0n ? "0" : (tipHeight - height + 1n).toString();
          if (output === undefined || output.satoshis !== candidate.satoshis ||
            (candidateConfirmations === undefined && minimumConfirmations !== "0") ||
            (height !== undefined && tipHeight !== undefined && height > tipHeight)) {
            throw new ChainDataConflictError("FT UTXO parent mismatch");
          }
          return Object.freeze({
            txid: candidate.txid,
            vout: candidate.vout,
            satoshis: candidate.satoshis,
            scriptPubKey: output.scriptPubKey,
            ...(candidateConfirmations === undefined ? {} : { confirmations: candidateConfirmations }),
            classification: stablecoinTransfer || stablecoinMerge ? "stablecoin" as const : "ft" as const,
            contractId,
          });
        }));
        const direct = new Map(preparedFt.selectedParents.map((value) => [value.txid, value]));
        if (preparedFt.creation !== undefined) direct.set(contractId!, preparedFt.creation);
        const ancestry: TransactionMaterial[] = [];
        const indexedFungible = preparedFt.stablecoinInfo === undefined ? undefined : Object.freeze({
          codeScript: preparedFt.stablecoinInfo.codeScript, tapeScript: preparedFt.stablecoinInfo.tapeScript,
          totalSupply: preparedFt.stablecoinInfo.totalSupply,
        });
        if (!coin && (stablecoinTransfer || stablecoinMerge)) {
          const info = preparedFt.stablecoinInfo;
          if (info === undefined || info.contractId !== contractId || !('stateVout' in info) || info.stateVout !== 0) {
            throw new ChainDataConflictError("StableCoin state index is inconsistent");
          }
          const include = async (txid: string) => {
            const existing = direct.get(txid) ?? ancestry.find((item) => item.txid === txid);
            if (existing !== undefined) return existing;
            if (direct.size + ancestry.length >= MAX_STABLECOIN_ANCESTRY_TRANSACTIONS) {
              throw new ChainDataConflictError("StableCoin ancestry exceeds the request limit");
            }
            const value = await (directProofReads.get(txid) ?? readHistory(txid));
            ancestry.push(value);
            return value;
          };
          // The configured API is the issuance authority. Bind its metadata
          // into the snapshot, not a download of every issuance/funding parent.
          direct.delete(contractId!);
          const directIds = new Set(preparedFt.selected.flatMap(candidate => {
            const parent = parentMap.get(candidate.txid);
            if (parent === undefined) throw new ChainDataConflictError("StableCoin parent unavailable");
            return inspectFtAncestryReferences(inspect(parent.rawTransaction).transaction, candidate.vout).map(ref => ref.txid);
          }));
          await Promise.all([...directIds].map(include));
        } else {
          const references = (ftTransfer || ftMerge || coin)
            ? preparedFt.selected.flatMap((candidate) => {
                const parent = parentMap.get(candidate.txid);
                if (parent === undefined) throw new ChainDataConflictError("FT parent is unavailable");
                const inspectReferences = coin ? inspectCoinAncestryReferences : tbc20 ? inspectTbc20AncestryReferences : inspectFtAncestryReferences;
                return inspectReferences(inspect(parent.rawTransaction).transaction, candidate.vout).map((reference) => reference.txid);
              })
            : [...direct.values()].flatMap((parent) => parent.inputs.map((input) => input.txid));
          if ((ftTransfer || ftMerge) && indexedFungible === undefined) {
            const source = preparedFt.creation?.inputs[0];
            if (preparedFt.creation?.inputs.length !== 1 || source === undefined || source.vout !== 0) throw new ChainDataConflictError("Invalid FT V4 creation source");
            references.push(source.txid);
          }
          const ancestryIds = [...new Set(references.filter((txid) => txid !== ZERO_TXID && !direct.has(txid)))];
          ancestry.push(...await Promise.all(ancestryIds.map(readHistory)));
        }
        parents = [...nativeParentValues, ...direct.values(), ...ancestry];
        const current = assetUtxos.at(-1) as Readonly<{ txid: string; vout: number }> | undefined;
        if (current === undefined) throw new ChainDataConflictError("FT current state unavailable");
        contracts = Object.freeze([Object.freeze({
          contractId,
          family: stablecoinTransfer || stablecoinMerge ? "stablecoin" as const : "ft" as const,
          protocolVersion: coin ? "coin" : tbc20 ? "tbc20" : "4.0",
          ...(tbc20 || coin ? {
            standardId: coin ? "tbc20-stablecoin" : "tbc20-standard",
            templateRevision: coin ? COIN_TEMPLATE_REVISION : TBC20_TEMPLATE_REVISION,
            genesisOutpoint: Object.freeze({ txid: contractId!, vout: 0 }),
          } : {}),
          creationTxid: contractId,
          ...(indexedFungible === undefined ? {} : { indexedFungible }),
          currentOutpoint: Object.freeze({ txid: current.txid, vout: current.vout }),
        })]);
      }

      const allUtxos = Object.freeze([...nativeUtxos, ...assetUtxos, ...(poolMaterial?.utxos ?? []), ...(nftMaterial?.utxos ?? []), ...(coinManagementMaterial?.utxos ?? []), ...(ammMaterial?.utxos ?? []), ...(htlcTokenMaterial?.utxos ?? [])]);
      const inputBudget = tbc20 && directFt && !htlcTokenLock
        ? Math.min(nativeUtxos.length, assetUtxos.length > MAX_TBC20_INPUTS ? 1 : MAX_TBC20_INPUTS - assetUtxos.length) + assetUtxos.length
        : nativeInputBudget(nativeUtxos.length) + assetUtxos.length + (poolMaterial?.utxos.length ?? 0) + (nftMaterial?.utxos.length ?? 0) + (coinManagementMaterial?.utxos.length ?? 0) + (ammMaterial?.utxos.length ?? 0) + (htlcTokenMaterial?.utxos.length ?? 0);
      if (inputBudget > maxInputs || new Set(allUtxos.map((value) => {
        const utxo = value as Readonly<{ txid: string; vout: number }>;
        return `${utxo.txid}:${utxo.vout}`;
      })).size !== allUtxos.length) throw new ChainDataConflictError("Invalid snapshot input set");
      const allParents = [...parents, ...(poolMaterial?.parents ?? []), ...(nftMaterial?.parents ?? []), ...(coinManagementMaterial?.parents ?? []), ...(ammMaterial?.parents ?? []), ...(htlcTokenMaterial?.parents ?? [])]
        .filter((value, index, values) => values.findIndex((other) => other.txid === value.txid) === index);
      const allContracts = Object.freeze([...contracts, ...(poolMaterial?.contracts ?? []), ...(nftMaterial?.contracts ?? []), ...(coinManagementMaterial?.contracts ?? []), ...(ammMaterial?.contracts ?? []), ...(htlcTokenMaterial?.contracts ?? [])]);
      const captured = now();
      const payload = Object.freeze({
        version: "1.0" as const,
        snapshotId: await snapshotId(),
        chainId: params.chainId,
        ...(tip === undefined ? {} : { block: Object.freeze({ height: tip.height, hash: tip.hash,
          ...((coin || lp || ammBusiness || htlcLock || htlcToken) && tip.medianTimePast !== undefined ? { medianTimePast: tip.medianTimePast } : {}),
        }) }),
        capturedAt: canonicalTime(captured),
        expiresAt: canonicalTime(captured + snapshotTtlMs),
        account: Object.freeze({ accountId: account.accountId, address: account.address, chainId: account.chainId, publicKey: account.publicKey }),
        ...(roleAccounts === undefined || roleAccounts.additional.length === 0 ? {} : { signingAccounts: roleAccounts.additional }),
        utxos: allUtxos,
        parents: Object.freeze(allParents.map(({ txid, rawTransaction }) => Object.freeze({ txid, rawTransaction }))),
        contracts: allContracts,
      });
      const result = Object.freeze({ payload, snapshotHash: hashCanonical(payload) });
      assertValidTws("chainDataResolveResult", result);
      if (
        poolMaterial !== undefined &&
        (poolAdd ||
          poolRemove ||
          poolInitializeInput !== undefined ||
          poolSwapTbcForToken ||
          poolSwapTokenForTbc)
      ) {
        const common = Object.freeze({
          binding: Object.freeze({
            snapshotHash: result.snapshotHash,
            chainId: params.chainId,
            sourceIdentity: network.sourceIdentity,
          }),
          expiresAt: Date.parse(payload.expiresAt),
        });
        const input = { address: account.address, receiver: account.address, poolContractId: poolContractId! };
        options.rememberPoolSnapshotMaterial?.(
          poolAdd
            ? Object.freeze({ ...common, kind: "add" as const, input: Object.freeze({ ...input, tbcAmount: requirement.nativeAmount! }), material: poolMaterial as PoolMaterial })
            : poolRemove
              ? Object.freeze({ ...common, kind: "remove" as const, input: Object.freeze({ ...input, lpAmount: poolFtAsset!.minimumAmount! }), material: poolMaterial as PoolLiquidityRemoveMaterial })
              : poolSwapTbcForToken
                ? Object.freeze({ ...common, kind: "swap-tbc-for-token" as const, input: Object.freeze({ ...input, tbcAmount: requirement.nativeAmount! }), material: poolMaterial as PoolSwapMaterial })
                : poolSwapTokenForTbc
                  ? Object.freeze({ ...common, kind: "swap-token-for-tbc" as const, input: Object.freeze({ ...input, ftAmount: poolFtAsset!.minimumAmount! }), material: poolMaterial as PoolSwapMaterial })
                  : Object.freeze({ ...common, kind: "initialize" as const, input: poolInitializeInput!, material: poolMaterial as PoolCreateInitializeMaterial }),
        );
      }
      if (poolMaterial !== undefined && poolContractId !== undefined) {
        const key = hashCanonical({
              snapshotHash: result.snapshotHash,
              chainId: params.chainId,
              sourceIdentity: network.sourceIdentity,
              from: account.address,
              poolContractId,
            });
        poolPolicies.delete(key);
        while (poolPolicies.size >= 32) poolPolicies.delete(poolPolicies.keys().next().value!);
        poolPolicies.set(key, Object.freeze({
            expiresAt: captured + snapshotTtlMs,
            value: Object.freeze({ ...poolMaterial.policy }),
          }));
      }
      return result;
    } catch (error) {
      if (error instanceof ChainDataAuthorizationError) return failure("UNAUTHORIZED");
      if (isTestnetNodeError(error) && error.code === "NODE_REQUEST_FAILED") return failure("UNAVAILABLE", true);
      if (error instanceof NftMaterialUnavailableError ||
        (error instanceof TbcTransportError && (error.retryable || error.code === "TIMEOUT"))) return failure("UNAVAILABLE", true);
      return failure("CONFLICT");
    }
  }

  return Object.freeze({
    network,
    resolve,
    prepareNftMintJob(scope: TbcNftMintJobScope, account: KitWalletAccount) {
      const captured = now();
      const scoped = createDefaultTbcChainDataResolver({ ...options,
        client: createChainDataReadScope(options.client), now: () => captured });
      const knownCollection = immutable.get(scope.collectionId);
      if (knownCollection !== undefined) scoped.rememberFinalizedTransaction(knownCollection);
      // All subset snapshots keep the ORIGINAL observation deadline. Reusing
      // an index must not silently extend its lifetime on each sub-batch.
      return prepareTbcNftMintJobMaterial({ scope, account, network, resolve: scoped.resolve, now });
    },
    readUnifiedIntent(binding: Parameters<DefaultTbcChainDataResolver["readUnifiedIntent"]>[0]) {
      const key = hashCanonical(binding), value = resolvedPolicies.get(key);
      if (value !== undefined && value.expiresAt <= now()) { resolvedPolicies.delete(key); return undefined; }
      return value?.intentType;
    },
    readPoolPolicy(binding: Readonly<{ snapshotHash: string; chainId: string; sourceIdentity?: string; from: string; poolContractId: string }>) {
      const key = hashCanonical({
        ...binding,
        sourceIdentity: binding.sourceIdentity ?? network.sourceIdentity,
      });
      const value = poolPolicies.get(key);
      if (value !== undefined && value.expiresAt <= now()) { poolPolicies.delete(key); return undefined; }
      return value?.value;
    },
    rememberFinalizedTransaction({ txid, rawTransaction }: Readonly<{ txid: string; rawTransaction: string }>) {
      remember(materialFromRaw(txid, rawTransaction, inspect));
    },
  });
}

function requireTip(tip: TestnetTip | undefined): TestnetTip {
  if (tip === undefined) throw new ChainDataConflictError("This operation requires chain height/time");
  return tip;
}

function validateNativeCandidates(candidates: readonly TestnetUtxo[], tipHeight: bigint | undefined): void {
  const outpoints = new Set<string>();
  for (const utxo of candidates) {
    if (
      !/^[0-9a-f]{64}$/u.test(utxo.txid) ||
      !Number.isSafeInteger(utxo.vout) || utxo.vout < 0 || utxo.vout > 0xffff_ffff ||
      !/^(?:0|[1-9][0-9]*)$/u.test(utxo.height) || (tipHeight !== undefined && BigInt(utxo.height) > tipHeight) ||
      !/^[1-9][0-9]*$/u.test(utxo.satoshis) || BigInt(utxo.satoshis) > 0xffff_ffff_ffff_ffffn
    ) throw new ChainDataConflictError("Invalid native UTXO descriptor");
    const key = `${utxo.txid}:${utxo.vout}`;
    if (outpoints.has(key)) throw new ChainDataConflictError("Duplicate native UTXO");
    outpoints.add(key);
  }
}

function selectNativeTransfer(candidates: readonly TestnetUtxo[], amount: bigint, maxInputs: number): readonly TestnetUtxo[] {
  const selected = [...candidates]
    .filter((utxo) => BigInt(utxo.satoshis) >= amount + FEE_RATE_SAT_PER_KB + DUST_THRESHOLD)
    .sort((left, right) =>
      (BigInt(left.satoshis) < BigInt(right.satoshis) ? -1 : BigInt(left.satoshis) > BigInt(right.satoshis) ? 1 : 0) ||
      left.txid.localeCompare(right.txid) || left.vout - right.vout,
    )[0];
  if (selected !== undefined) return [selected];
  // Preserve the single-input fast path. Otherwise supply a bounded candidate
  // set, not a fabricated fee/selection decision: Rust owns exact signed-size
  // fees, dust handling, final input selection and the caller's maxFee cap.
  // Native descriptors need no parent reads, so this adds no network requests.
  const bounded = [...candidates].sort((left, right) =>
    (BigInt(left.satoshis) > BigInt(right.satoshis) ? -1 : BigInt(left.satoshis) < BigInt(right.satoshis) ? 1 : 0) ||
    left.txid.localeCompare(right.txid) || left.vout - right.vout,
  ).slice(0, maxInputs);
  if (bounded.reduce((sum, item) => sum + BigInt(item.satoshis), 0n) < amount + FEE_RATE_SAT_PER_KB) {
    throw new ChainDataConflictError("Insufficient native funding within the input policy");
  }
  return bounded;
}

function selectRequestedNativeOutpoints(
  candidates: readonly TestnetUtxo[],
  requested: readonly Readonly<{ readonly txid: string; readonly vout: number }>[],
): readonly TestnetUtxo[] {
  const byOutpoint = new Map(candidates.map((candidate) => [
    `${candidate.txid}:${candidate.vout}`,
    candidate,
  ]));
  return Object.freeze(requested.map((outpoint) => {
    const candidate = byOutpoint.get(`${outpoint.txid}:${outpoint.vout}`);
    if (candidate === undefined) {
      throw new ChainDataConflictError("Requested native UTXO is unavailable");
    }
    return candidate;
  }));
}

function confirmations(utxo: TestnetUtxo, tipHeight: bigint | undefined): string | undefined {
  const height = BigInt(utxo.height);
  return height === 0n ? "0" : tipHeight === undefined ? undefined : (tipHeight - height + 1n).toString();
}
