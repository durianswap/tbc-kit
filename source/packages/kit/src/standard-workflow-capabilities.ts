import {
  assertValidTws,
  base64Decode,
  hashCanonical,
  canonicalize,
  resolveReviewedSigningRoles,
  type ResolvedTransactionSigningRole,
  type TransactionRoleAccount,
} from "@tbc-wallet/core";

import type {
  TbcAssociatedTransactionReviewer,
  TbcRawTransactionReviewer,
  TbcReviewedTransactionRequest,
  TbcSecureOperationContext,
  TbcVerifiedTransactionInput,
} from "./reviewed-transaction-types.js";
import { parseTbcTransaction, turingTransactionId } from "./testnet-validation.js";
import type { TbcWalletPrivateNativeAdapters } from "./wallet-private-native.js";
import type { KitWalletOptions } from "./wallet-runtime.js";
import type { TbcKitWebViewVerifiedNavigation } from "./wallet-webview.js";
import type { TbcReviewedPolicyMaterial } from "./reviewed-transaction-types.js";
import type { PoolMaterialNativeProviderInput } from "./pool-material-native.js";
import { createLazyBundledWasmTbcKeylessEngine } from "./keyless.js";
import { normalizeReviewedPolicyMaterial, requireBoundReviewedPolicy } from "./reviewed-issuance-policy.js";
import { materializeAssociatedReviewRequest } from "./reviewed-transaction-reviewer.js";
import { bindReviewedCoinAdminMaterial, bindReviewedRawCoinAdminMaterial, reviewedCoinAdministrator } from "./reviewed-coin-admin.js";
import { createReviewedRoleExecutor, type TbcReviewedRoleSigner } from "./reviewed-role-executor.js";
import { tbcNetworkProfileForChainId } from "./network-context.js";

const HASH32 = /^[0-9a-f]{64}$/u;
const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{20,64}$/u;
const REVIEW_TTL_MS = 2 * 60_000;

type PlainRecord = Readonly<Record<string, unknown>>;
type RawRequest = TbcReviewedTransactionRequest;
type StandardReview = Readonly<{
  preview: PlainRecord;
  verifiedInputs: readonly (readonly TbcVerifiedTransactionInput[])[];
  policyMaterial: TbcReviewedPolicyMaterial;
}>;
type ApprovedDecision = Readonly<{
  status: "approved";
  bindingHash: string;
  approvalId: string;
}>;
type NativeBinding<TRequest> = Readonly<{
  version: "1.0";
  operationKind: "signTransaction" | "signAssociatedTransaction" | "encrypt" | "decrypt";
  bindingHash: string;
  requestHash: string;
  context: TbcSecureOperationContext;
  request: TRequest;
}>;

export type { TbcWalletPrivateNativeAdapters } from "./wallet-private-native.js";

export type TbcStandardWorkflowAccount = Readonly<{
  accountId: string;
  address: string;
  publicKey: string;
}>;

export type TbcStandardWorkflowAuthoritySnapshot = Readonly<{
  accountId: string;
  address: string;
  networkSourceIdentity: string;
  publicKey?: string;
  /** Current wallet-controlled additional accounts, never page metadata. */
  signingAccounts?: readonly TransactionRoleAccount[];
}>;

export interface TbcStandardWorkflowCapabilitiesOptions {
  /** Immutable native-verified WebView authority for this wallet session. */
  readonly navigation: TbcKitWebViewVerifiedNavigation;
  readonly chainId: `tbc:${string}`;
  readonly account: TbcStandardWorkflowAccount;
  /** Wallet-selected network identity; never take this value from page data. */
  readonly networkSourceIdentity: string;
  /** Wallet/platform state only; return null when session/navigation authority
   * is invalidated. Role execution also requires the current publicKey and
   * trusted signingAccounts, checked across asynchronous preparation/signing. */
  readonly readCurrentAuthority: () => Promise<TbcStandardWorkflowAuthoritySnapshot | null>;
  readonly rawReviewer: TbcRawTransactionReviewer;
  readonly associatedReviewer: TbcAssociatedTransactionReviewer;
  /** Reuse the same platform codec instance as the supplied reviewers. */
  readonly materialNative?: PoolMaterialNativeProviderInput;
  /** Required only for role-aware Reviewed signing; ordinary adapters are unchanged. */
  readonly reviewedRoleSigner?: TbcReviewedRoleSigner;
  /**
   * Returns wallet-private one-shot adapters for the exact account. The
   * implementation may close over SecureStore/native handles; key bytes are
   * deliberately absent from this interface.
   */
  readonly privateNative:
    | TbcWalletPrivateNativeAdapters
    | ((accountId: string) => TbcWalletPrivateNativeAdapters | Promise<TbcWalletPrivateNativeAdapters>);
  /** Trusted wallet clock used only to bound the review artifact. */
  readonly now?: () => string;
}

export type TbcStandardWorkflowCapabilities = Readonly<{
  crypto: NonNullable<KitWalletOptions["crypto"]>;
  reviewedTransaction: NonNullable<KitWalletOptions["reviewedTransaction"]>;
  /** Wallet-private approval projection. Input must come from verified Host
   * evidence, not a DApp. Does not authorize signing or query chain data. */
  resolveReviewedSigningMaterial: (task: unknown) => Promise<Readonly<{
    format: "raw" | "associated"; request: PlainRecord; policyMaterial: TbcReviewedPolicyMaterial;
  }>>;
}>;

function record(value: unknown, label: string): PlainRecord {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError(`Invalid standard ${label}`);
  }
  return value as PlainRecord;
}

function stringValue(value: unknown, label: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    throw new TypeError(`Invalid standard ${label}`);
  }
  return value;
}

function atomicBigInt(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/u.test(value)) {
    throw new TypeError(`Invalid standard ${label}`);
  }
  return BigInt(value);
}

function safeAtomicNumber(value: unknown, label: string): number {
  const numeric = atomicBigInt(value, label);
  if (numeric > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new TypeError(`Invalid standard ${label}`);
  }
  return Number(numeric);
}

function rawRequest(requestInput: unknown, allowRoles = false): RawRequest {
  const request = record(requestInput, "reviewed transaction request");
  const payload = record(Reflect.get(request, "payload"), "raw transaction payload");
  if (Reflect.get(payload, "format") !== "raw") {
    throw new TypeError("Invalid standard raw transaction payload");
  }
  const transactions = Reflect.get(payload, "transactions");
  if (!Array.isArray(transactions)) throw new TypeError("Invalid standard raw transactions");
  for (const transaction of transactions) {
    const inputs = record(transaction,"raw transaction").inputs;
    if (!Array.isArray(inputs)) throw new TypeError("Invalid standard raw inputs");
    if (!allowRoles && inputs.some(input => Object.hasOwn(record(input,"raw input"),"signingRole"))) {
      throw new Error("Reviewed role-aware signing adapter is not installed");
    }
  }
  const normalized = Object.freeze({
    txraws: Object.freeze(transactions.map((candidate) =>
      stringValue(Reflect.get(record(candidate, "raw transaction"), "rawTransaction"), "raw transaction"))),
    utxos_satoshis: Object.freeze(transactions.map((candidate) => {
      const inputs = Reflect.get(record(candidate, "raw transaction"), "inputs");
      if (!Array.isArray(inputs)) throw new TypeError("Invalid standard raw inputs");
      return Object.freeze(inputs.map((input) =>
        safeAtomicNumber(Reflect.get(record(input, "raw input"), "satoshis"), "raw input value")));
    })),
    script_pubkeys: Object.freeze(transactions.map((candidate) => {
      const inputs = Reflect.get(record(candidate, "raw transaction"), "inputs");
      if (!Array.isArray(inputs)) throw new TypeError("Invalid standard raw inputs");
      return Object.freeze(inputs.map((input) =>
        stringValue(Reflect.get(record(input, "raw input"), "scriptPubKey"), "raw input script")));
    })),
  });
  normalized.txraws.forEach((raw, index) => {
    const parsed = parseTbcTransaction(raw);
    if (parsed.inputs.length !== normalized.utxos_satoshis[index]!.length) {
      throw new TypeError("Invalid standard raw transaction input matrix");
    }
  });
  return normalized;
}

/** Exact execution material for trusted native custody adapters, not a public
 * display projection. Associated templates can contain an HTLC claim preimage.
 * Keep this request in session memory only; never log/persist/display it. Use
 * the bound approval presentation for UI. Does not approve or sign. */
export function normalizeTbcReviewedTransactionMaterial(request: unknown): Readonly<{
  format: "raw" | "associated";
  request: Readonly<Record<string, unknown>>;
}> {
  const payload = record(Reflect.get(record(request, "reviewed transaction request"), "payload"), "reviewed transaction payload");
  if (payload.format === "raw") return Object.freeze({ format: "raw", request: { ...rawRequest(request) } });
  if (payload.format === "associated") return Object.freeze({ format: "associated", request: associatedRequest(request) });
  throw new TypeError("Invalid standard reviewed transaction format");
}

function legacySigningProfile(value: unknown): string {
  if (value === "p2pkh") return "p2pkh";
  if (value === "ft") return "tbc20";
  if (value === "ft-contract") return "tbc20_contract";
  if (value === "contract-template") return "other";
  if (value === "tbc-lop-match") return "tbc_lop_match";
  if (value === "tbc20-standard" || value === "tbc20-stablecoin") return value;
  throw new TypeError("Invalid standard associated signing profile");
}

function legacyAssociatedInput(value: unknown, allowRoles = false): PlainRecord {
  const input = record(value, "associated input");
  // The synchronous public normalizer cannot authenticate a role's Code. Only
  // the trusted role path may retain this marker for asynchronous binding.
  if (Object.hasOwn(input, "signingRole") && !allowRoles) {
    throw new Error("Reviewed role-aware signing adapter is not installed");
  }
  const profile = legacySigningProfile(Reflect.get(input, "signingProfile"));
  if (Object.hasOwn(input, "signingPublicKey") || (Object.hasOwn(input, "signingRole") &&
      (input.signingRole !== "coin-admin" || profile !== "tbc20-stablecoin"))) throw new Error("Invalid Reviewed role input");
  const current = profile === "tbc20-standard" || profile === "tbc20-stablecoin";
  const proofRaw = (item: unknown): string => {
    const raw = stringValue(item, "current associated proof material");
    if (raw.length > 2_097_152 || !/^(?:[0-9a-fA-F]{2})+$/u.test(raw)) {
      throw new TypeError("Invalid current associated proof material");
    }
    return raw.toLowerCase();
  };
  if (current) {
    for (const field of ["previousOutputContext", "contractTransaction", "contractVersion", "unlockingScriptTemplate"]) {
      if (Object.hasOwn(input, field)) throw new TypeError("Current associated profile rejects witness overrides");
    }
    if (Object.hasOwn(input, "txid")) {
      for (const field of ["satoshis", "scriptPubKey", "previousTransaction", "ancestorTransactions"]) {
        if (!Object.hasOwn(input, field)) throw new TypeError("Current associated external input requires complete proof material");
      }
    } else if (Object.hasOwn(input, "previousTransaction")) {
      throw new TypeError("Current associated local input must omit previousTransaction");
    }
  } else if (Object.hasOwn(input, "ancestorTransactions")) {
    throw new TypeError("Current ancestor material requires a current signing profile");
  }
  let ancestors: readonly string[] | undefined;
  if (Object.hasOwn(input, "ancestorTransactions")) {
    const raws = Reflect.get(input, "ancestorTransactions");
    if (!Array.isArray(raws) || raws.length > 6) throw new TypeError("Invalid current ancestor material bound");
    const normalized = raws.map(proofRaw);
    if (new Set(normalized).size !== normalized.length) throw new TypeError("Duplicate current ancestor material");
    ancestors = Object.freeze(normalized);
  }
  const optional = (standard: string, legacy: string, normalize: (item: unknown) => unknown) =>
    Object.hasOwn(input, standard) ? { [legacy]: normalize(Reflect.get(input, standard)) } : {};
  const outputIndex = Reflect.get(input, "outputIndex");
  if (!Number.isSafeInteger(outputIndex) || Number(outputIndex) < 0) {
    throw new TypeError("Invalid standard associated output index");
  }
  return Object.freeze({
    ...optional("txid", "txId", (item) => stringValue(item, "associated txid").toLowerCase()),
    outputIndex,
    ...optional("satoshis", "satoshis", (item) => safeAtomicNumber(item, "associated input value")),
    ...optional("scriptPubKey", "script", (item) => stringValue(item, "associated input script")),
    scriptSigType: profile,
    ...(Object.hasOwn(input, "signingRole") ? {signingRole: input.signingRole} : {}),
    ...(ancestors === undefined ? {} : { ancestorTransactions: ancestors }),
    ...optional("previousTransaction", "preTx", (item) => current ? proofRaw(item) : stringValue(item, "previous transaction")),
    ...optional("previousOutputContext", "prePreTxData", (item) =>
      stringValue(item, "previous output context")),
    ...optional("contractTransaction", "contractTx", (item) =>
      stringValue(item, "contract transaction")),
    ...optional("contractVersion", "ftVersion", (item) => item),
    ...optional("unlockingScriptTemplate", "unfinishedScriptSig", (item) =>
      stringValue(item, "unlocking script template")),
  });
}

function associatedRequest(requestInput: unknown, allowRoles = false): PlainRecord {
  const request = record(requestInput, "reviewed transaction request");
  const payload = record(Reflect.get(request, "payload"), "associated transaction payload");
  if (Reflect.get(payload, "format") !== "associated") {
    throw new TypeError("Invalid standard associated transaction payload");
  }
  const sourceInputs = Reflect.get(payload, "sourceInputs");
  const children = Reflect.get(payload, "children");
  if (!Array.isArray(sourceInputs) || !Array.isArray(children)) {
    throw new TypeError("Invalid standard associated transaction matrix");
  }
  return Object.freeze({
    sourceTxraw: stringValue(Reflect.get(payload, "sourceTransaction"), "source transaction"),
    sourceUtxos: Object.freeze(sourceInputs.map(input => legacyAssociatedInput(input, allowRoles))),
    inputs: Object.freeze(children.map((candidate) => {
      const inputs = Reflect.get(record(candidate, "associated child"), "inputs");
      if (!Array.isArray(inputs)) throw new TypeError("Invalid standard associated child inputs");
      return Object.freeze(inputs.map(input => legacyAssociatedInput(input, allowRoles)));
    })),
    outputs: Object.freeze(children.map((candidate) => {
      const outputs = Reflect.get(record(candidate, "associated child"), "outputs");
      if (!Array.isArray(outputs)) throw new TypeError("Invalid standard associated child outputs");
      return Object.freeze(outputs.map((outputValue) => {
        const output = record(outputValue, "associated output");
        return Object.freeze({
          satoshis: safeAtomicNumber(Reflect.get(output, "satoshis"), "associated output value"),
          script: stringValue(Reflect.get(output, "scriptPubKey"), "associated output script"),
        });
      }));
    })),
  });
}

function outputsTotal(rawTransaction: string): bigint {
  return parseTbcTransaction(rawTransaction).outputs.reduce(
    (total, output) => total + BigInt(output.satoshis),
    0n,
  );
}

function rawFee(request: RawRequest): string {
  let total = 0n;
  request.txraws.forEach((raw, index) => {
    const input = request.utxos_satoshis[index]!.reduce(
      (sum, value) => sum + BigInt(value),
      0n,
    );
    const fee = input - outputsTotal(raw);
    if (fee < 0n) throw new TypeError("Invalid standard raw transaction fee");
    total += fee;
  });
  return total.toString();
}

function associatedFee(requestInput: unknown): string {
  const request = record(requestInput, "reviewed transaction request");
  const payload = record(Reflect.get(request, "payload"), "associated transaction payload");
  const sourceRaw = stringValue(Reflect.get(payload, "sourceTransaction"), "source transaction");
  const sourceInputs = Reflect.get(payload, "sourceInputs");
  const children = Reflect.get(payload, "children");
  if (!Array.isArray(sourceInputs) || !Array.isArray(children)) {
    throw new TypeError("Invalid standard associated transaction matrix");
  }
  let total = sourceInputs.reduce((sum: bigint, value) => {
    const input = record(value, "associated source input");
    return sum + atomicBigInt(Reflect.get(input, "satoshis"), "associated source input value");
  }, 0n) - outputsTotal(sourceRaw);
  if (total < 0n) throw new TypeError("Invalid standard associated transaction fee");

  let previousOutputs = parseTbcTransaction(sourceRaw).outputs.map((output) => BigInt(output.satoshis));
  for (const childValue of children) {
    const child = record(childValue, "associated child");
    const inputs = Reflect.get(child, "inputs");
    const outputs = Reflect.get(child, "outputs");
    if (!Array.isArray(inputs) || !Array.isArray(outputs)) {
      throw new TypeError("Invalid standard associated transaction matrix");
    }
    const inputTotal = inputs.reduce((sum: bigint, inputValue) => {
      const input = record(inputValue, "associated input");
      if (Object.hasOwn(input, "satoshis")) {
        return sum + atomicBigInt(Reflect.get(input, "satoshis"), "associated input value");
      }
      if (Object.hasOwn(input, "txid")) {
        throw new TypeError("Invalid standard associated external input value");
      }
      const outputIndex = Reflect.get(input, "outputIndex");
      if (!Number.isSafeInteger(outputIndex) || previousOutputs[Number(outputIndex)] === undefined) {
        throw new TypeError("Invalid standard associated internal input");
      }
      return sum + previousOutputs[Number(outputIndex)]!;
    }, 0n);
    const nextOutputs = outputs.map((outputValue) =>
      atomicBigInt(
        Reflect.get(record(outputValue, "associated output"), "satoshis"),
        "associated output value",
      ));
    const fee = inputTotal - nextOutputs.reduce((sum, value) => sum + value, 0n);
    if (fee < 0n) throw new TypeError("Invalid standard associated transaction fee");
    total += fee;
    previousOutputs = nextOutputs;
  }
  return total.toString();
}

function immutableJson(value: unknown, label: string): unknown {
  const project = (candidate: unknown, inArray = false): unknown => {
    if (candidate === undefined) {
      if (inArray) throw new TypeError(`Invalid standard ${label}`);
      return undefined;
    }
    if (candidate === null || typeof candidate !== "object") return candidate;
    if (Array.isArray(candidate)) {
      return Object.freeze(candidate.map((item) => project(item, true)));
    }
    if (Object.getPrototypeOf(candidate) !== Object.prototype) {
      throw new TypeError(`Invalid standard ${label}`);
    }
    const output: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(candidate)) {
      if (typeof key !== "string") throw new TypeError(`Invalid standard ${label}`);
      const child = Reflect.get(candidate, key);
      if (child !== undefined) output[key] = project(child);
    }
    return Object.freeze(output);
  };
  return project(value);
}

function verifiedInput(value: unknown, label: string): TbcVerifiedTransactionInput {
  const input = record(value, label);
  const txid = Reflect.get(input, "txid");
  const vout = Reflect.get(input, "vout");
  const satoshis = Reflect.get(input, "satoshis");
  const scriptPubKey = Reflect.get(input, "scriptPubKey");
  if (
    Reflect.ownKeys(input).length !== 5 ||
    !HASH32.test(String(txid)) ||
    !Number.isSafeInteger(vout) ||
    Number(vout) < 0 ||
    !Number.isSafeInteger(satoshis) ||
    Number(satoshis) < 0 ||
    typeof scriptPubKey !== "string" ||
    !/^(?:[0-9a-fA-F]{2})+$/u.test(scriptPubKey) ||
    Reflect.get(input, "spent") !== false
  ) {
    throw new TypeError(`Invalid standard ${label}`);
  }
  return Object.freeze({
    txid: String(txid),
    vout: Number(vout),
    satoshis: Number(satoshis),
    scriptPubKey,
    spent: false,
  });
}

function normalizedReview(
  input: unknown,
  expectedTransactions: number,
  expectedIds?: readonly string[],
): StandardReview {
  const result = record(input, "review result");
  if (
    Reflect.ownKeys(result).some(key => !["preview", "verifiedInputs", "policyMaterial"].includes(String(key))) ||
    !Object.hasOwn(result, "preview") ||
    !Object.hasOwn(result, "verifiedInputs")
  ) {
    throw new TypeError("Invalid standard review result");
  }
  const rows = Reflect.get(result, "verifiedInputs");
  if (!Array.isArray(rows) || rows.length !== expectedTransactions) {
    throw new TypeError("Invalid standard reviewed transaction material");
  }
  const verifiedInputs = Object.freeze(rows.map((row, transactionIndex) => {
    if (!Array.isArray(row)) throw new TypeError("Invalid standard reviewed transaction material");
    return Object.freeze(row.map((candidate, inputIndex) =>
      verifiedInput(candidate, `review input ${String(transactionIndex)}:${String(inputIndex)}`)));
  }));
  const preview = immutableJson(Reflect.get(result, "preview"), "review preview");
  const previewRecord = record(preview, "review preview");
  const transactions = Reflect.get(previewRecord, "transactions");
  if (!Array.isArray(transactions) || transactions.length !== expectedTransactions) {
    throw new TypeError("Invalid standard review preview");
  }
  transactions.forEach((transactionValue, transactionIndex) => {
    const transaction = record(transactionValue, "review transaction");
    const txid = Reflect.get(transaction, "txid");
    const groups = Reflect.get(transaction, "groups");
    if (
      Reflect.get(transaction, "index") !== transactionIndex ||
      typeof txid !== "string" ||
      !HASH32.test(txid) ||
      (expectedIds !== undefined && txid !== expectedIds[transactionIndex]) ||
      !Array.isArray(groups) ||
      groups.length === 0
    ) {
      throw new TypeError("Invalid standard review preview");
    }
    for (const groupValue of groups) {
      const group = record(groupValue, "review group");
      const flows = Reflect.get(group, "flows");
      if (!Array.isArray(flows) || flows.length === 0) {
        throw new TypeError("Invalid standard review preview");
      }
      for (const flowValue of flows) {
        if (Reflect.get(record(flowValue, "review flow"), "recognized") !== true) {
          throw new TypeError("Unrecognized standard reviewed transaction impact");
        }
      }
    }
  });
  const policyMaterial = normalizeReviewedPolicyMaterial(Reflect.get(result, "policyMaterial") ?? { resolvedOutputs: [] });
  return Object.freeze({ preview: previewRecord, verifiedInputs, policyMaterial });
}

function normalizeRawReview(input: unknown, request: RawRequest): StandardReview {
  const transactionIds = Object.freeze(request.txraws.map(turingTransactionId));
  const review = normalizedReview(input, request.txraws.length, transactionIds);
  review.verifiedInputs.forEach((row, transactionIndex) => {
    const parsed = parseTbcTransaction(request.txraws[transactionIndex]!);
    if (row.length !== parsed.inputs.length) {
      throw new TypeError("Invalid standard raw transaction material");
    }
    row.forEach((candidate, inputIndex) => {
      const outpoint = parsed.inputs[inputIndex]!;
      if (
        candidate.txid !== outpoint.txid ||
        candidate.vout !== outpoint.vout ||
        candidate.satoshis !== request.utxos_satoshis[transactionIndex]![inputIndex] ||
        candidate.scriptPubKey.toLowerCase() !==
          request.script_pubkeys[transactionIndex]![inputIndex]!.toLowerCase()
      ) {
        throw new TypeError("Standard raw transaction material mismatch");
      }
    });
  });
  return review;
}

function normalizeAssociatedReview(
  input: unknown,
  materialized: RawRequest,
): StandardReview {
  return normalizeRawReview(input, materialized);
}

function normalizeRawResult(input: unknown, request: RawRequest): readonly (readonly string[])[] {
  const result = record(input, "raw transaction result");
  const signatures = Reflect.get(result, "sigs");
  if (
    Reflect.ownKeys(result).length !== 1 ||
    !Array.isArray(signatures) ||
    signatures.length !== request.txraws.length
  ) {
    throw new TypeError("Invalid standard raw transaction result");
  }
  return Object.freeze(signatures.map((row, index) => {
    if (
      !Array.isArray(row) ||
      row.length !== request.utxos_satoshis[index]!.length ||
      row.some((signature) =>
        typeof signature !== "string" ||
        !/^(?:[0-9a-fA-F]{2})+$/u.test(signature) ||
        signature.length > 1_024)
    ) {
      throw new TypeError("Invalid standard raw transaction result");
    }
    return Object.freeze([...row] as string[]);
  }));
}

function normalizeAssociatedResult(input: unknown): readonly string[] {
  let candidate = input;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      throw new TypeError("Invalid standard associated transaction result");
    }
  }
  const result = record(candidate, "associated transaction result");
  const raws = Reflect.get(result, "txraws");
  if (
    Reflect.ownKeys(result).length !== 1 ||
    !Array.isArray(raws) ||
    raws.length === 0 ||
    raws.length > 33 ||
    raws.some((raw) => typeof raw !== "string" || !/^(?:[0-9a-fA-F]{2})+$/u.test(raw))
  ) {
    throw new TypeError("Invalid standard associated transaction result");
  }
  return Object.freeze([...raws] as string[]);
}

function endpointAddress(value: unknown): string | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const address = Reflect.get(value, "address");
  return typeof address === "string" && ADDRESS.test(address) ? address : undefined;
}

function standardAssetFlow(
  assetInput: unknown,
  flowInput: unknown,
  action: unknown,
): PlainRecord | undefined {
  const asset = record(assetInput, "review asset");
  const flow = record(flowInput, "review flow");
  if (Reflect.get(flow, "recognized") !== true) {
    throw new TypeError("Unrecognized standard reviewed transaction impact");
  }
  const assetType = Reflect.get(asset, "type");
  const kind = assetType === "tbc" ? "native"
    : assetType === "nftCollection" ? "collection"
      : assetType === "ftlp" ? "lp"
        : assetType === "ft" || assetType === "stablecoin" || assetType === "nft"
          ? assetType
          : undefined;
  if (kind === undefined) throw new TypeError("Invalid standard reviewed transaction asset");
  const purpose = Reflect.get(flow, "purpose");
  if (purpose === "state" || purpose === "self") return undefined;
  const direction = purpose === "mint"
    ? assetType === "nftCollection" || (assetType === "nft" && Reflect.get(asset, "subtype") === "poolNft")
      ? "create"
      : "mint"
    : purpose === "burn" ? "burn"
      : purpose === "lock" ? "lock"
        : purpose === "release" ? "unlock"
          : purpose === "fee" ? "fee"
            : action === "merge" ? "merge"
              : Reflect.get(flow, "direction") === "in" ? "receive" : "send";
  const amountValue = Reflect.get(flow, "amount");
  let amount = "1";
  if (amountValue !== undefined) {
    const amountRecord = record(amountValue, "review amount");
    const candidate = Reflect.get(amountRecord, "raw") ?? Reflect.get(amountRecord, "satoshis");
    if (
      (typeof candidate !== "string" || !/^(0|[1-9][0-9]*)$/u.test(candidate)) &&
      (!Number.isSafeInteger(candidate) || Number(candidate) < 0)
    ) {
      throw new TypeError("Invalid standard reviewed transaction amount");
    }
    amount = String(candidate);
  }
  const contract = Reflect.get(asset, "contractId") ?? Reflect.get(asset, "collectionId");
  const from = endpointAddress(Reflect.get(flow, "from"));
  const to = endpointAddress(Reflect.get(flow, "to"));
  return Object.freeze({
    kind: Reflect.get(asset, "subtype") === "poolNft" ? "pool" : kind,
    direction,
    amount,
    ...(typeof contract === "string" && HASH32.test(contract) ? { contractId: contract } : {}),
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
  });
}

function reviewPreview(
  review: StandardReview,
  totalFee: string,
): PlainRecord {
  const transactions = Reflect.get(review.preview, "transactions");
  if (!Array.isArray(transactions) || transactions.length === 0 || transactions.length > 32) {
    throw new TypeError("Invalid standard reviewed transaction preview");
  }
  const assetFlows: PlainRecord[] = [];
  const lopOrders: PlainRecord[] = [];
  const coinLocks: PlainRecord[] = [];
  const htlcLocks: PlainRecord[] = [];
  const timeLocks: PlainRecord[] = [];
  for (const transactionValue of transactions) {
    const transaction = record(transactionValue, "review transaction");
    const groups = Reflect.get(transaction, "groups");
    const classification = Reflect.get(transaction, "classification");
    if (Object.hasOwn(transaction, "orderTerms")) {
      lopOrders.push(Object.freeze({
        ...record(Reflect.get(transaction, "orderTerms"), "LOP order terms"),
        transactionIndex: Reflect.get(transaction, "index"),
      }));
    }
    if (Object.hasOwn(transaction, "coinLocks")) {
      const locks = Reflect.get(transaction, "coinLocks");
      if (!Array.isArray(locks)) throw new TypeError("Invalid reviewed Coin lock material");
      for (const lock of locks) coinLocks.push(Object.freeze({
        ...record(lock, "Coin lock material"), transactionIndex: Reflect.get(transaction, "index"),
      }));
    }
    if (Object.hasOwn(transaction, "htlcLocks")) {
      const locks = Reflect.get(transaction, "htlcLocks");
      if (!Array.isArray(locks)) throw new TypeError("Invalid reviewed HTLC material");
      for (const lock of locks) htlcLocks.push(Object.freeze({
        ...record(lock, "HTLC material"), transactionIndex: Reflect.get(transaction, "index"),
      }));
    }
    const action = classification !== null && typeof classification === "object"
      ? Reflect.get(classification, "action")
      : undefined;
    if (Object.hasOwn(transaction, "timeLocks")) {
      const locks = Reflect.get(transaction, "timeLocks");
      if (!Array.isArray(locks)) throw new TypeError("Invalid reviewed TimeLock material");
      for (const lock of locks) timeLocks.push(Object.freeze({
        ...record(lock, "TimeLock material"), transactionIndex: Reflect.get(transaction, "index"),
      }));
    }
    if (!Array.isArray(groups)) throw new TypeError("Invalid standard reviewed transaction groups");
    for (const groupValue of groups) {
      const group = record(groupValue, "review group");
      const flows = Reflect.get(group, "flows");
      if (!Array.isArray(flows)) throw new TypeError("Invalid standard reviewed transaction flows");
      for (const flow of flows) {
        const mapped = standardAssetFlow(Reflect.get(group, "asset"), flow, action);
        if (mapped !== undefined) assetFlows.push(mapped);
      }
    }
  }
  return Object.freeze({
    operationKind: "transaction" as const,
    ...(lopOrders.length === 0 ? {} : { lopOrders: Object.freeze(lopOrders) }),
    ...(coinLocks.length === 0 ? {} : { coinLocks: Object.freeze(coinLocks) }),
    ...(htlcLocks.length === 0 ? {} : { htlcLocks: Object.freeze(htlcLocks) }),
    ...(timeLocks.length === 0 ? {} : { timeLocks: Object.freeze(timeLocks) }),
    assetFlows: Object.freeze(assetFlows),
    totalFee,
    transactionCount: transactions.length,
    warnings: Object.freeze([...(transactions.length > 1 ? ["MULTI_TRANSACTION" as const] : []),
      ...(htlcLocks.some(lock => lock.branch === "claim") ? ["HTLC_CLAIM_SIGNED_BYTES_DISCLOSE_PREIMAGE" as const] : []),
      ...(timeLocks.length > 0 || htlcLocks.length > 0 || coinLocks.some(lock => Number(lock.lockTime) > 0) ? ["LOCKED_ASSET" as const] : [])]),
    irreversible: true,
  });
}

function reviewExpiry(now: () => string): string {
  const value = now();
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new TypeError("Invalid standard workflow clock");
  return new Date(milliseconds + REVIEW_TTL_MS).toISOString();
}

function secureContext(
  options: TbcStandardWorkflowCapabilitiesOptions,
): TbcSecureOperationContext {
  return Object.freeze({
    origin: options.navigation.origin,
    chainId: options.chainId,
    accountId: options.account.accountId,
    sessionId: options.navigation.sessionId,
    navigationId: options.navigation.navigationId,
  });
}

async function assertCurrentAuthority(
  options: TbcStandardWorkflowCapabilitiesOptions,
  roles?: readonly ResolvedTransactionSigningRole[],
): Promise<void> {
  const current = await options.readCurrentAuthority();
  if (
    current === null ||
    current.accountId !== options.account.accountId ||
    current.address !== options.account.address ||
    current.networkSourceIdentity !== options.networkSourceIdentity
  ) {
    throw new Error("Standard workflow authority changed");
  }
  if (roles !== undefined) {
    if (current.publicKey !== options.account.publicKey) throw new Error("Reviewed primary account changed");
    const primary = {...options.account,chainId:options.chainId};
    for (const role of roles) {
      const available = role.account.accountId === primary.accountId ? [primary] : current.signingAccounts ?? [];
      const matching = available.filter(account => account.accountId === role.account.accountId);
      if (matching.length !== 1 || canonicalize(matching[0]) !== canonicalize(role.account)) {
        throw new Error("Reviewed administrator account changed");
      }
    }
  }
}

function reviewedRoles(params: PlainRecord, request: unknown, options: TbcStandardWorkflowCapabilitiesOptions): readonly ResolvedTransactionSigningRole[] | undefined {
  if (!Object.hasOwn(params, "signingRoles")) return undefined;
  if (!options.reviewedRoleSigner) throw new Error("Reviewed role-aware signing adapter is not installed");
  const roles = params.signingRoles as readonly ResolvedTransactionSigningRole[];
  const profile = tbcNetworkProfileForChainId(options.chainId);
  reviewedCoinAdministrator(roles, options.chainId, profile.p2pkhVersion);
  const accounts = [{...options.account,chainId:options.chainId},
    ...roles.filter(role => role.account.accountId !== options.account.accountId).map(role => role.account)];
  const resolved = resolveReviewedSigningRoles({chainId:options.chainId,from:options.account.address,
    request:record(request,"role request"),signingRoles:roles.map(role => ({role:role.role,accountId:role.account.accountId}))},accounts);
  if (canonicalize(resolved ?? []) !== canonicalize(roles)) throw new Error("Reviewed signing role binding mismatch");
  return roles;
}

async function privateNative(
  options: TbcStandardWorkflowCapabilitiesOptions,
): Promise<TbcWalletPrivateNativeAdapters> {
  const adapters = typeof options.privateNative === "function"
    ? await options.privateNative(options.account.accountId)
    : options.privateNative;
  if (
    adapters === null ||
    typeof adapters !== "object" ||
    typeof adapters.rawSigner?.sign !== "function" ||
    typeof adapters.associatedExecutor?.execute !== "function" ||
    typeof adapters.cryptoAdapter?.encrypt !== "function" ||
    typeof adapters.cryptoAdapter.decrypt !== "function"
  ) {
    throw new TypeError("Standard workflow wallet-private adapters are required");
  }
  return adapters;
}

function approvedDecision(approvalInput: unknown): ApprovedDecision {
  const approval = record(approvalInput, "approval receipt");
  const bindingHash = Reflect.get(approval, "bindingHash");
  const approvalId = Reflect.get(approval, "approvalId");
  if (
    Reflect.get(approval, "status") !== "approved" ||
    typeof bindingHash !== "string" ||
    !HASH32.test(bindingHash) ||
    typeof approvalId !== "string" ||
    approvalId.length === 0
  ) {
    throw new TypeError("Invalid standard approval receipt");
  }
  return Object.freeze({ status: "approved" as const, bindingHash, approvalId });
}

function nativeBinding<TRequest>(
  operationKind: "signTransaction" | "signAssociatedTransaction" | "encrypt" | "decrypt",
  request: TRequest,
  context: TbcSecureOperationContext,
  approval: ApprovedDecision,
): NativeBinding<TRequest> {
  return Object.freeze({
    version: "1.0" as const,
    operationKind,
    bindingHash: approval.bindingHash,
    requestHash: hashCanonical(request),
    context,
    request,
  });
}

function assertTaskAuthority(
  task: PlainRecord,
  options: TbcStandardWorkflowCapabilitiesOptions,
): void {
  if (
    Reflect.get(task, "accountId") !== options.account.accountId ||
    Reflect.get(task, "publicKey") !== options.account.publicKey ||
    (Object.hasOwn(task, "chainId") && Reflect.get(task, "chainId") !== options.chainId) ||
    (Object.hasOwn(task, "origin") && Reflect.get(task, "origin") !== options.navigation.origin)
  ) {
    throw new Error("Standard workflow task authority mismatch");
  }
}

function signedTransactions(
  raws: readonly string[],
  associated: boolean,
): readonly PlainRecord[] {
  return Object.freeze(raws.map((rawTransaction, index) => {
    const id = `tx-${String(index + 1)}`;
    return Object.freeze({
      id,
      txid: turingTransactionId(rawTransaction),
      rawTransaction,
      role: associated && index < raws.length - 1 ? "prerequisite" as const : "primary" as const,
      dependsOn: Object.freeze(associated && index > 0 ? [`tx-${String(index)}`] : []),
    });
  }));
}

function utf8Message(messageInput: unknown): string {
  const message = record(messageInput, "crypto message");
  const encoding = Reflect.get(message, "encoding");
  const data = stringValue(Reflect.get(message, "data"), "crypto message data", true);
  if (encoding === "utf8") return data;
  let bytes: Uint8Array;
  if (encoding === "hex") {
    if (!/^(?:[0-9a-fA-F]{2})*$/u.test(data)) {
      throw new TypeError("Invalid standard crypto hex message");
    }
    bytes = new Uint8Array(data.length / 2);
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Number.parseInt(data.slice(index * 2, index * 2 + 2), 16);
    }
  } else if (encoding === "base64") {
    bytes = base64Decode(data);
  } else {
    throw new TypeError("Invalid standard crypto message encoding");
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

/**
 * Creates the reusable Standard reviewed-transaction and crypto Port adapters.
 *
 * This composer is independent of `KitWalletOptions.legacy`: a wallet may omit
 * or disable Legacy entirely. It adds no network read, approval or retry. The
 * injected reviewers perform the one trusted review; private callbacks are
 * invoked by the Host Port call after Core approval; Host persistence follows
 * the selected runtime policy, not this private execution capability.
 */
export function createTbcStandardWorkflowCapabilities(
  options: TbcStandardWorkflowCapabilitiesOptions,
): TbcStandardWorkflowCapabilities {
  if (
    options === null ||
    typeof options !== "object" ||
    !options.chainId.startsWith("tbc:") ||
    options.account.accountId !== `${options.chainId}:${options.account.address}` ||
    options.networkSourceIdentity.length === 0 ||
    typeof options.readCurrentAuthority !== "function" ||
    typeof options.rawReviewer?.review !== "function" ||
    typeof options.associatedReviewer?.review !== "function"
  ) {
    throw new TypeError("Standard workflow capability dependencies are required");
  }
  const context = secureContext(options);
  const now = options.now ?? (() => new Date().toISOString());
  const materialNative = options.materialNative ?? createLazyBundledWasmTbcKeylessEngine();
  const executeRoles = createReviewedRoleExecutor();
  const roleMaterial = async (request: unknown, roles: readonly ResolvedTransactionSigningRole[] | undefined) =>
    roles === undefined ? associatedRequest(request) : bindReviewedCoinAdminMaterial({
      request:associatedRequest(request,true),publicKey:roles[0]!.account.publicKey,native:materialNative,
    });
  const rawRoleMaterial = async (request: unknown, roles: readonly ResolvedTransactionSigningRole[] | undefined) => {
    const normalized = rawRequest(request, roles !== undefined);
    if (roles === undefined) return normalized;
    const payload = record(record(request,"raw role request").payload,"raw payload");
    const transactions = payload.transactions as readonly {inputs: readonly {signingRole?: unknown}[]}[];
    return bindReviewedRawCoinAdminMaterial({request:normalized,inputRoles:transactions.map(transaction=>transaction.inputs.map(input=>input.signingRole)),
      publicKey:roles[0]!.account.publicKey,native:materialNative});
  };
  const resolveReviewedSigningMaterial: TbcStandardWorkflowCapabilities["resolveReviewedSigningMaterial"] = async (input) => {
    // Snapshot before the first await; later page mutations cannot alter what
    // the native approval commits. This projection is not an approval token.
    const task = record(JSON.parse(canonicalize(input)), "reviewed approval task");
    const request = task.request;
    if (task.purpose !== "reviewedTransaction" || task.requestHash !== hashCanonical(request) ||
        typeof task.taskId !== "string" || !HASH32.test(String(task.reviewHash))) {
      throw new TypeError("Invalid Reviewed approval material task");
    }
    assertTaskAuthority(task, options);
    const roles = reviewedRoles(task, request, options);
    await assertCurrentAuthority(options, roles);
    const payload = record(record(request, "reviewed request").payload, "reviewed payload");
    const format = payload.format;
    if (format !== "raw" && format !== "associated") throw new TypeError("Invalid Reviewed approval material format");
    const normalized = format === "raw" ? {...await rawRoleMaterial(request,roles)} : await roleMaterial(request, roles);
    const policyMaterial = normalizeReviewedPolicyMaterial(task.policyMaterial);
    await assertCurrentAuthority(options, roles);
    return Object.freeze({format, request:normalized, policyMaterial});
  };

  const reviewedTransaction: NonNullable<KitWalletOptions["reviewedTransaction"]> = Object.freeze({
    async review(paramsInput: unknown, call) {
      if (call.operation !== "reviewedTransaction.review") {
        throw new TypeError("Invalid standard reviewed transaction operation");
      }
      const incoming = record(paramsInput, "review params");
      if (Object.hasOwn(incoming, "signingRoles") && !options.reviewedRoleSigner) {
        throw new Error("Reviewed role-aware signing adapter is not installed");
      }
      const params = Object.hasOwn(incoming,"signingRoles") ? JSON.parse(canonicalize(incoming)) as PlainRecord : incoming;
      const request = Reflect.get(params, "request");
      const roles = reviewedRoles(params,request,options);
      const requestHash = Reflect.get(params, "requestHash");
      if (
        Reflect.get(params, "version") !== "1.0" ||
        Reflect.get(params, "origin") !== options.navigation.origin ||
        Reflect.get(params, "sessionId") !== options.navigation.sessionId ||
        Reflect.get(params, "chainId") !== options.chainId ||
        Reflect.get(params, "accountId") !== options.account.accountId ||
        Reflect.get(params, "publicKey") !== options.account.publicKey ||
        requestHash !== hashCanonical(request)
      ) {
        throw new Error("Standard reviewed transaction context mismatch");
      }
      await assertCurrentAuthority(options,roles);
      const payload = record(Reflect.get(record(request, "reviewed transaction request"), "payload"), "reviewed transaction payload");
      let review: StandardReview;
      let totalFee: string;
      if (Reflect.get(payload, "format") === "raw") {
        const normalized = await rawRoleMaterial(request,roles);
        review = normalizeRawReview(
          await options.rawReviewer.review({
            request: normalized,
            context,
            transactionIds: Object.freeze(normalized.txraws.map(turingTransactionId)),
            ...(roles === undefined ? {} : {signingRoles:roles}),
          }),
          normalized,
        );
        totalFee = rawFee(normalized);
        await requireBoundReviewedPolicy(materialNative, normalized, review.policyMaterial);
      } else if (Reflect.get(payload, "format") === "associated") {
        const normalized = await roleMaterial(request,roles);
        const operationDigest = hashCanonical({ kind: "signAssociated", request: normalized });
        const reviewed = await options.associatedReviewer.review({
            request: normalized,
            operationDigest,
            context,
            publicKey: options.account.publicKey,
            ...(roles === undefined ? {} : {signingRoles:roles}),
          });
        const materialized = materializeAssociatedReviewRequest(normalized);
        review = normalizeAssociatedReview(reviewed, materialized);
        totalFee = associatedFee(request);
        await requireBoundReviewedPolicy(materialNative, materialized, review.policyMaterial);
      } else {
        throw new TypeError("Invalid standard reviewed transaction format");
      }
      if (roles !== undefined) await assertCurrentAuthority(options,roles);
      const payloadResult = Object.freeze({
        preview: Object.freeze({...reviewPreview(review, totalFee),...(roles === undefined ? {} : {signingRoles:roles})}),
        totalFee,
        expiresAt: reviewExpiry(now),
        policyMaterial: review.policyMaterial,
      });
      const result = Object.freeze({ payload: payloadResult, reviewHash: hashCanonical(payloadResult) });
      assertValidTws("reviewedTransactionReviewResult", result);
      return result;
    },

    async execute(paramsInput: unknown, call) {
      if (call.operation !== "reviewedTransaction.execute") {
        throw new TypeError("Invalid standard reviewed transaction operation");
      }
      const incoming = record(paramsInput, "execution params");
      const incomingTask = record(Reflect.get(incoming,"task"),"reviewed transaction task");
      if (Object.hasOwn(incomingTask, "signingRoles") && !options.reviewedRoleSigner) {
        throw new Error("Reviewed role-aware signing adapter is not installed");
      }
      const params = Object.hasOwn(incomingTask,"signingRoles") ? JSON.parse(canonicalize(incoming)) as PlainRecord : incoming;
      const task = record(params.task,"reviewed transaction task");
      const request = Reflect.get(task, "request");
      const roles = reviewedRoles(task,request,options);
      if (
        Reflect.get(params, "version") !== "1.0" ||
        Reflect.get(task, "purpose") !== "reviewedTransaction" ||
        Reflect.get(task, "requestHash") !== hashCanonical(request) ||
        typeof Reflect.get(task, "taskId") !== "string" ||
        !HASH32.test(String(Reflect.get(task, "reviewHash")))
      ) {
        throw new TypeError("Invalid standard reviewed transaction task");
      }
      assertTaskAuthority(task, options);
      const approval = approvedDecision(Reflect.get(params, "approval"));
      const policyMaterial = normalizeReviewedPolicyMaterial(Reflect.get(task, "policyMaterial"));
      const payload = record(Reflect.get(record(request, "reviewed transaction request"), "payload"), "reviewed transaction payload");
      let raws: readonly string[];
      let totalFee: string;
      let detachedSignatures: readonly (readonly string[])[] | undefined;
      let associated = false;
      if (Reflect.get(payload, "format") === "raw") {
        const normalized = await rawRoleMaterial(request,roles);
        await requireBoundReviewedPolicy(materialNative, normalized, policyMaterial);
        if (roles !== undefined) {
          const expiresAt = Date.parse(String(record(params.approval,"approval receipt").expiresAt));
          const result = await executeRoles({native:materialNative,signer:options.reviewedRoleSigner!,format:"raw",
            request:{...normalized},params,call,primary:options.account,roles,policyMaterial,
            assertAuthority:async()=>{
              await assertCurrentAuthority(options,roles);
              const currentTime=Date.parse(now());
              if (!Number.isFinite(expiresAt)||!Number.isFinite(currentTime)||currentTime>=expiresAt) throw new Error("Reviewed approval expired");
            }});
          detachedSignatures = result.detachedSignatures!;
        } else {
          await assertCurrentAuthority(options);
          const adapters = await privateNative(options);
          detachedSignatures = normalizeRawResult(
            await adapters.rawSigner.sign({
              binding: nativeBinding("signTransaction", normalized, context, approval),
              approval,
              policyMaterial,
            }),
            normalized,
          );
        }
        raws = normalized.txraws;
        totalFee = rawFee(normalized);
      } else if (Reflect.get(payload, "format") === "associated") {
        associated = true;
        const normalized = await roleMaterial(request,roles);
        await requireBoundReviewedPolicy(materialNative, materializeAssociatedReviewRequest(normalized), policyMaterial);
        if (roles !== undefined) {
          const expiresAt = Date.parse(String(record(params.approval,"approval receipt").expiresAt));
          const result = await executeRoles({native:materialNative,signer:options.reviewedRoleSigner!,
            request:normalized,params,call,primary:options.account,roles,policyMaterial,
            assertAuthority:async()=>{
              await assertCurrentAuthority(options,roles);
              const currentTime = Date.parse(now());
              if (!Number.isFinite(expiresAt) || !Number.isFinite(currentTime) || currentTime >= expiresAt) {
                throw new Error("Reviewed approval expired");
              }
            }});
          raws = result.transactions;
        } else {
          await assertCurrentAuthority(options);
          const adapters = await privateNative(options);
          const operationDigest = hashCanonical({ kind: "signAssociated", request: normalized });
          const result = normalizeAssociatedResult(
            await adapters.associatedExecutor.execute({ operationDigest, request: normalized, policyMaterial }),
          );
          const expected = 1 + (Array.isArray(Reflect.get(normalized, "inputs"))
            ? (Reflect.get(normalized, "inputs") as readonly unknown[]).length
            : 0);
          if (result.length !== expected) {
            throw new Error("Standard associated transaction result count mismatch");
          }
          raws = result;
        }
        totalFee = associatedFee(request);
      } else {
        throw new TypeError("Invalid standard reviewed transaction format");
      }
      const bundle = Object.freeze({
        version: "1.0" as const,
        chainId: options.chainId,
        from: options.account.address,
        requestHash: Reflect.get(task, "requestHash"),
        approvalId: approval.approvalId,
        transactions: signedTransactions(raws, associated),
        totalFee,
        ...(detachedSignatures === undefined ? {} : { detachedSignatures }),
      });
      const result = Object.freeze({
        taskId: Reflect.get(task, "taskId"),
        reviewHash: Reflect.get(task, "reviewHash"),
        bundle,
      });
      assertValidTws("reviewedTransactionExecuteResult", result);
      return result;
    },
  });

  const crypto: NonNullable<KitWalletOptions["crypto"]> = Object.freeze({
    async execute(paramsInput: unknown, call) {
      if (call.operation !== "crypto.execute") {
        throw new TypeError("Invalid standard crypto operation");
      }
      const params = record(paramsInput, "crypto params");
      const task = record(Reflect.get(params, "task"), "crypto task");
      if (Reflect.get(params, "version") !== "1.0") {
        throw new TypeError("Invalid standard crypto params");
      }
      assertTaskAuthority(task, options);
      await assertCurrentAuthority(options);
      const approval = approvedDecision(Reflect.get(params, "approval"));
      const adapters = await privateNative(options);
      const purpose = Reflect.get(task, "purpose");
      const request = purpose === "encrypt"
        ? Object.freeze({ message: utf8Message(Reflect.get(task, "message")) })
        : purpose === "decrypt"
          ? Object.freeze({ message: stringValue(Reflect.get(task, "ciphertext"), "ciphertext") })
          : undefined;
      if (request === undefined) throw new TypeError("Invalid standard crypto task");
      const binding = nativeBinding(
        purpose === "encrypt" ? "encrypt" : "decrypt",
        request,
        context,
        approval,
      );
      const nativeResult = purpose === "encrypt"
        ? await adapters.cryptoAdapter.encrypt({ binding, approval })
        : await adapters.cryptoAdapter.decrypt({ binding, approval });
      const resultRecord = record(nativeResult, "crypto result");
      const result = purpose === "encrypt"
        ? Object.freeze({
            taskId: Reflect.get(task, "taskId"),
            algorithm: Reflect.get(task, "algorithm"),
            ciphertext: stringValue(Reflect.get(resultRecord, "encryptedMessage"), "encrypted message"),
          })
        : Object.freeze({
            taskId: Reflect.get(task, "taskId"),
            algorithm: Reflect.get(task, "algorithm"),
            message: Object.freeze({
              encoding: "utf8" as const,
              data: stringValue(Reflect.get(resultRecord, "decryptedMessage"), "decrypted message", true),
            }),
          });
      assertValidTws("cryptoExecuteResult", result);
      return result;
    },
  });

  return Object.freeze({ crypto, reviewedTransaction, resolveReviewedSigningMaterial });
}
