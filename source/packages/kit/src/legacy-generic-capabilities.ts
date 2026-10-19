import { canonicalize, hashCanonical } from "@tbc-wallet/core";
import { normalizeReviewedPolicyMaterial, requireBoundReviewedPolicy } from "./reviewed-issuance-policy.js";
import type { TbcReviewedPolicyMaterial } from "./reviewed-transaction-types.js";
import type { PoolMaterialNativeProviderInput } from "./pool-material-native.js";
import { createLazyBundledWasmTbcKeylessEngine } from "./keyless.js";
import { materializeAssociatedReviewRequest } from "./reviewed-transaction-reviewer.js";

import {
  createTbcOfficialApi,
  type CreateTbcOfficialApiOptions,
} from "./official-api.js";
import {
  assertTbcNetworkContext,
  type TbcNetworkContext,
} from "./network-context.js";
import {
  assertTbcAddress,
  parseTbcTransaction,
  turingTransactionId,
} from "./testnet-validation.js";
import {
  normalizeLegacyAssociatedTransactionRequest,
  type LegacyAssociatedTransactionExecutor,
  type LegacyAssociatedTransactionService,
} from "./legacy-associated-transaction.js";

const HEX = /^(?:[0-9a-fA-F]{2})+$/u;
const MAX_RAW_TRANSACTIONS = 32;
const MAX_INPUTS_PER_TRANSACTION = 1_000;
const MAX_RAW_REQUEST_BYTES = 4 * 1024 * 1024;
const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_ENCRYPTED_MESSAGE_BYTES = 256 * 1024;

export type LegacySecureOperationKind =
  | "signTransaction"
  | "signAssociatedTransaction"
  | "encrypt"
  | "decrypt";

export interface LegacySecureOperationContext {
  readonly origin: string;
  readonly chainId: string;
  readonly accountId: string;
  readonly sessionId: string;
  readonly navigationId: string;
}

export interface LegacySecureOperationBinding<TRequest = unknown> {
  readonly version: "1.0";
  readonly operationKind: LegacySecureOperationKind;
  readonly bindingHash: string;
  readonly requestHash: string;
  readonly context: LegacySecureOperationContext;
  readonly request: TRequest;
  readonly review?: LegacyRawTransactionReview | LegacyAssociatedTransactionReview;
}

export interface LegacySecureOperationAuthority {
  /** Fails unless this exact origin/account/session/navigation is still current. */
  readonly assertCurrent: (context: LegacySecureOperationContext) => Promise<void>;
}

/**
 * Internal boundary marker for a well-formed Legacy transport request whose
 * operation payload or reviewed material is invalid. The WebView adapter may
 * translate this into the historical `{ error }` result without treating it
 * as a transport-integrity failure.
 */
export class LegacySecureOperationRequestValidationError extends Error {
  readonly code = "LEGACY_SECURE_OPERATION_REQUEST_INVALID";

  constructor(cause: unknown) {
    super(
      cause instanceof Error && cause.message.length > 0
        ? cause.message
        : "Invalid Legacy secure operation request",
    );
    this.name = "LegacySecureOperationRequestValidationError";
  }
}

export type LegacySecureOperationApprovalDecision =
  | Readonly<{
      status: "approved";
      bindingHash: string;
      approvalId: string;
    }>
  | Readonly<{
      status: "rejected";
      bindingHash: string;
    }>;

export interface LegacySecureOperationApproval {
  /** Must present this exact operation. Legacy secure operations never reuse a grant. */
  readonly request: <TRequest>(
    binding: LegacySecureOperationBinding<TRequest>,
  ) => Promise<LegacySecureOperationApprovalDecision>;
}

export type LegacySecureOperationOutcome<TResult> =
  | Readonly<{ status: "approved"; result: TResult }>
  | Readonly<{ status: "rejected" }>;

export type LegacyRawTransactionRequest = Readonly<{
  txraws: readonly string[];
  utxos_satoshis: readonly (readonly number[])[];
  script_pubkeys: readonly (readonly string[])[];
}>;

export type LegacyRawTransactionResult = Readonly<{
  sigs: readonly (readonly string[])[];
}>;

export type LegacyRawTransactionReview = Readonly<{
  version: "1.0";
  policy: "recognized-asset-flows";
  requestHash: string;
  previewHash: string;
  materialHash: string;
  policyMaterial: TbcReviewedPolicyMaterial;
  preview: Readonly<Record<string, unknown>>;
}>;

export type LegacyAssociatedTransactionReview = Readonly<{
  version: "1.0";
  policy: "recognized-associated-asset-flows";
  operationDigest: string;
  requestHash: string;
  previewHash: string;
  materialHash: string;
  policyMaterial: TbcReviewedPolicyMaterial;
  preview: Readonly<Record<string, unknown>>;
}>;

export interface LegacyAssociatedTransactionReviewer {
  readonly review: (input: Readonly<{
    request: Readonly<Record<string, unknown>>;
    operationDigest: string;
    context: LegacySecureOperationContext;
  }>) => Promise<Readonly<{
    preview: unknown;
    policyMaterial?: TbcReviewedPolicyMaterial;
    verifiedInputs: readonly (readonly Readonly<{
      txid: string;
      vout: number;
      satoshis: number;
      scriptPubKey: string;
      spent: false;
    }>[] )[];
  }>>;
}

export interface LegacyAssociatedTransactionSigningService {
  readonly sign: (
    request: unknown,
    context: LegacySecureOperationContext,
  ) => Promise<LegacySecureOperationOutcome<Readonly<{ txraws: readonly string[] }>>>;
}

export interface LegacyRawTransactionReviewer {
  /**
   * Shared transaction preview/parser. `verifiedInputs` must come from trusted
   * current material (normally one batched official TXO read), never page data.
   */
  readonly review: (input: Readonly<{
    request: LegacyRawTransactionRequest;
    context: LegacySecureOperationContext;
    transactionIds: readonly string[];
  }>) => Promise<Readonly<{
    preview: unknown;
    policyMaterial?: TbcReviewedPolicyMaterial;
    verifiedInputs: readonly (readonly Readonly<{
      txid: string;
      vout: number;
      satoshis: number;
      scriptPubKey: string;
      spent: false;
    }>[])[];
  }>>;
}

export interface LegacyRawTransactionSigningService {
  readonly sign: (
    request: unknown,
    context: LegacySecureOperationContext,
  ) => Promise<LegacySecureOperationOutcome<LegacyRawTransactionResult>>;
}

export interface LegacyRawTransactionSigner {
  /** Wallet-private execution. Keys and native handles never enter this input. */
  readonly sign: (input: Readonly<{
    binding: LegacySecureOperationBinding<LegacyRawTransactionRequest>;
    approval: Extract<LegacySecureOperationApprovalDecision, { status: "approved" }>;
  }>) => Promise<unknown>;
}

export type LegacyCryptoRequest = Readonly<{ message: string }>;
export type LegacyEncryptResult = Readonly<{ encryptedMessage: string }>;
export type LegacyDecryptResult = Readonly<{ decryptedMessage: string }>;

export interface LegacyCryptoService {
  readonly encrypt: (
    request: unknown,
    context: LegacySecureOperationContext,
  ) => Promise<LegacySecureOperationOutcome<LegacyEncryptResult>>;
  readonly decrypt: (
    request: unknown,
    context: LegacySecureOperationContext,
  ) => Promise<LegacySecureOperationOutcome<LegacyDecryptResult>>;
}

export interface LegacyCryptoAdapter {
  /** Wallet-private ECIES/native execution. No private material is returned to Kit. */
  readonly encrypt: (input: Readonly<{
    binding: LegacySecureOperationBinding<LegacyCryptoRequest>;
    approval: Extract<LegacySecureOperationApprovalDecision, { status: "approved" }>;
  }>) => Promise<unknown>;
  readonly decrypt: (input: Readonly<{
    binding: LegacySecureOperationBinding<LegacyCryptoRequest>;
    approval: Extract<LegacySecureOperationApprovalDecision, { status: "approved" }>;
  }>) => Promise<unknown>;
}

export interface LegacyTbcBalanceReader {
  readonly chainId: string;
  readonly networkSourceIdentity: string;
  readonly read: (address: string) => Promise<Readonly<{ tbc: number }>>;
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Reflect.ownKeys(value);
  return (
    actual.length === expected.length &&
    actual.every((key) => typeof key === "string" && expected.includes(key))
  );
}

function canonicalClone<T>(value: T, message: string): T {
  let cloned: unknown;
  try {
    cloned = JSON.parse(canonicalize(value));
  } catch {
    throw new TypeError(message);
  }
  const freeze = (candidate: unknown): void => {
    if (candidate === null || typeof candidate !== "object" || Object.isFrozen(candidate)) return;
    for (const child of Object.values(candidate as Record<string, unknown>)) freeze(child);
    Object.freeze(candidate);
  };
  freeze(cloned);
  return cloned as T;
}

function canonicalReviewPreview(
  value: unknown,
  message: string,
): Readonly<Record<string, unknown>> {
  const project = (candidate: unknown, inArray = false): unknown => {
    if (candidate === undefined) {
      if (inArray) throw new TypeError(message);
      return undefined;
    }
    if (candidate === null || typeof candidate !== "object") return candidate;
    if (Array.isArray(candidate)) {
      return Object.freeze(candidate.map((item) => project(item, true)));
    }
    if (Object.getPrototypeOf(candidate) !== Object.prototype) throw new TypeError(message);
    const output: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(candidate)) {
      if (typeof key !== "string") throw new TypeError(message);
      const child = Reflect.get(candidate, key);
      if (child !== undefined) output[key] = project(child);
    }
    return Object.freeze(output);
  };
  const projected = project(value);
  if (projected === null || typeof projected !== "object" || Array.isArray(projected)) {
    throw new TypeError(message);
  }
  return canonicalClone(projected, message) as Readonly<Record<string, unknown>>;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

function secureContext(input: LegacySecureOperationContext): LegacySecureOperationContext {
  if (
    input === null ||
    typeof input !== "object" ||
    !exactKeys(input, ["origin", "chainId", "accountId", "sessionId", "navigationId"]) ||
    typeof input.origin !== "string" ||
    input.origin.length === 0 ||
    typeof input.chainId !== "string" ||
    !/^tbc:[A-Za-z0-9._:-]+$/u.test(input.chainId) ||
    typeof input.accountId !== "string" ||
    !input.accountId.startsWith(`${input.chainId}:`) ||
    typeof input.sessionId !== "string" ||
    input.sessionId.length === 0 ||
    typeof input.navigationId !== "string" ||
    input.navigationId.length === 0
  ) {
    throw new TypeError("Invalid Legacy secure operation context");
  }
  return canonicalClone(input, "Invalid Legacy secure operation context");
}

function binding<TRequest>(
  operationKind: LegacySecureOperationKind,
  request: TRequest,
  contextInput: LegacySecureOperationContext,
  review?: LegacyRawTransactionReview | LegacyAssociatedTransactionReview,
): LegacySecureOperationBinding<TRequest> {
  const context = secureContext(contextInput);
  const requestHash = hashCanonical(request);
  const payload = Object.freeze({
    version: "1.0" as const,
    operationKind,
    requestHash,
    context,
    ...(review === undefined ? {} : { reviewHash: hashCanonical(review) }),
  });
  return Object.freeze({
    ...payload,
    bindingHash: hashCanonical(payload),
    request,
    ...(review === undefined ? {} : { review }),
  });
}

function assertRecognizedPreview(
  previewInput: unknown,
  expectedTransactions: number,
  message: string,
): Readonly<Record<string, unknown>> {
  const preview = canonicalClone(previewInput, message) as Readonly<Record<string, unknown>>;
  const transactions = Reflect.get(preview, "transactions");
  if (!Array.isArray(transactions) || transactions.length !== expectedTransactions) {
    throw new TypeError(message);
  }
  transactions.forEach((transaction, transactionIndex) => {
    if (
      transaction === null ||
      typeof transaction !== "object" ||
      Array.isArray(transaction) ||
      Reflect.get(transaction, "index") !== transactionIndex ||
      typeof Reflect.get(transaction, "txid") !== "string" ||
      !Array.isArray(Reflect.get(transaction, "groups")) ||
      (Reflect.get(transaction, "groups") as unknown[]).length === 0
    ) {
      throw new TypeError(message);
    }
    for (const group of Reflect.get(transaction, "groups") as unknown[]) {
      if (
        group === null ||
        typeof group !== "object" ||
        Array.isArray(group) ||
        !Array.isArray(Reflect.get(group, "flows")) ||
        (Reflect.get(group, "flows") as unknown[]).length === 0
      ) {
        throw new TypeError(message);
      }
      for (const flow of Reflect.get(group, "flows") as unknown[]) {
        if (
          flow === null ||
          typeof flow !== "object" ||
          Array.isArray(flow) ||
          Reflect.get(flow, "recognized") !== true
        ) {
          throw new TypeError("Unrecognized Legacy associated transaction impact");
        }
      }
    }
  });
  return preview;
}

/** Raw and associated reviews bind the same concrete unsigned input matrix. */
function assertReviewedInputRows(
  verifiedInputs: unknown,
  request: LegacyRawTransactionRequest,
): void {
  if (!Array.isArray(verifiedInputs) || verifiedInputs.length !== request.txraws.length) {
    throw new TypeError("Invalid Legacy raw transaction material");
  }
  for (let transactionIndex = 0; transactionIndex < request.txraws.length; transactionIndex += 1) {
    const transaction = parseTbcTransaction(request.txraws[transactionIndex]!);
    const row = verifiedInputs[transactionIndex];
    if (!Array.isArray(row) || row.length !== transaction.inputs.length) {
      throw new TypeError("Invalid Legacy raw transaction material");
    }
    row.forEach((candidate, inputIndex) => {
      const outpoint = transaction.inputs[inputIndex]!;
      if (
        candidate === null ||
        typeof candidate !== "object" ||
        Array.isArray(candidate) ||
        !exactKeys(candidate, ["txid", "vout", "satoshis", "scriptPubKey", "spent"]) ||
        Reflect.get(candidate, "txid") !== outpoint.txid ||
        Reflect.get(candidate, "vout") !== outpoint.vout ||
        Reflect.get(candidate, "satoshis") !== request.utxos_satoshis[transactionIndex]![inputIndex] ||
        typeof Reflect.get(candidate, "scriptPubKey") !== "string" ||
        (Reflect.get(candidate, "scriptPubKey") as string).toLowerCase() !==
          request.script_pubkeys[transactionIndex]![inputIndex]!.toLowerCase() ||
        Reflect.get(candidate, "spent") !== false
      ) {
        throw new TypeError("Legacy raw transaction material mismatch");
      }
    });
  }
}

function normalizeAssociatedTransactionReview(
  input: unknown,
  request: Readonly<Record<string, unknown>>,
  operationDigest: string,
  materialized: LegacyRawTransactionRequest,
): LegacyAssociatedTransactionReview {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Object.prototype ||
    !(exactKeys(input, ["preview", "verifiedInputs"]) || exactKeys(input, ["preview", "verifiedInputs", "policyMaterial"]))
  ) {
    throw new TypeError("Invalid Legacy associated transaction review");
  }
  const verifiedInputs = Reflect.get(input, "verifiedInputs");
  const expectedTransactions = materialized.txraws.length;
  assertReviewedInputRows(verifiedInputs, materialized);
  const previewInput = canonicalReviewPreview(
    Reflect.get(input, "preview"),
    "Invalid Legacy associated transaction review",
  );
  if (utf8Bytes(canonicalize({ preview: previewInput, verifiedInputs })) > 2 * 1024 * 1024) {
    throw new TypeError("Invalid Legacy associated transaction review");
  }
  const preview = assertRecognizedPreview(
    previewInput,
    expectedTransactions,
    "Invalid Legacy associated transaction review",
  );
  (Reflect.get(preview, "transactions") as readonly object[]).forEach((transaction, index) => {
    if (Reflect.get(transaction, "txid") !== turingTransactionId(materialized.txraws[index]!)) {
      throw new TypeError("Legacy associated transaction preview identity mismatch");
    }
  });
  const policyMaterial = normalizeReviewedPolicyMaterial(Reflect.get(input, "policyMaterial") ?? { resolvedOutputs: [] });
  const requestHash = hashCanonical(request);
  return Object.freeze({
    version: "1.0" as const,
    policy: "recognized-associated-asset-flows" as const,
    operationDigest,
    requestHash,
    previewHash: hashCanonical(preview),
    materialHash: hashCanonical({ verifiedInputs, policyMaterial }),
    policyMaterial,
    preview,
  });
}

function normalizeRawTransactionReview(
  input: unknown,
  request: LegacyRawTransactionRequest,
): LegacyRawTransactionReview {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Object.prototype ||
    !(exactKeys(input, ["preview", "verifiedInputs"]) || exactKeys(input, ["preview", "verifiedInputs", "policyMaterial"]))
  ) {
    throw new TypeError("Invalid Legacy raw transaction review");
  }
  const verifiedInputs = Reflect.get(input, "verifiedInputs");
  assertReviewedInputRows(verifiedInputs, request);
  const preview = canonicalReviewPreview(
    Reflect.get(input, "preview"),
    "Invalid Legacy raw transaction review",
  );
  if (utf8Bytes(canonicalize({ preview, verifiedInputs })) > 1024 * 1024) {
    throw new TypeError("Invalid Legacy raw transaction review");
  }
  const transactions = Reflect.get(preview, "transactions");
  if (!Array.isArray(transactions) || transactions.length !== request.txraws.length) {
    throw new TypeError("Invalid Legacy raw transaction review");
  }
  transactions.forEach((transaction, transactionIndex) => {
    if (
      transaction === null ||
      typeof transaction !== "object" ||
      Array.isArray(transaction) ||
      Reflect.get(transaction, "index") !== transactionIndex ||
      typeof Reflect.get(transaction, "txid") !== "string" ||
      Reflect.get(transaction, "txid") !== turingTransactionId(request.txraws[transactionIndex]!) ||
      !Array.isArray(Reflect.get(transaction, "groups")) ||
      (Reflect.get(transaction, "groups") as unknown[]).length === 0
    ) {
      throw new TypeError("Invalid Legacy raw transaction review");
    }
    const groups = Reflect.get(transaction, "groups") as unknown[];
    for (const group of groups) {
      if (
        group === null ||
        typeof group !== "object" ||
        Array.isArray(group) ||
        !Array.isArray(Reflect.get(group, "flows")) ||
        (Reflect.get(group, "flows") as unknown[]).length === 0
      ) {
        throw new TypeError("Invalid Legacy raw transaction review");
      }
      for (const flow of Reflect.get(group, "flows") as unknown[]) {
        if (
          flow === null ||
          typeof flow !== "object" ||
          Array.isArray(flow) ||
          Reflect.get(flow, "recognized") !== true
        ) {
          throw new TypeError("Unrecognized Legacy raw transaction impact");
        }
      }
    }
  });
  const policyMaterial = normalizeReviewedPolicyMaterial(Reflect.get(input, "policyMaterial") ?? { resolvedOutputs: [] });
  const requestHash = hashCanonical(request);
  return Object.freeze({
    version: "1.0" as const,
    policy: "recognized-asset-flows" as const,
    requestHash,
    previewHash: hashCanonical(preview),
    materialHash: hashCanonical({ verifiedInputs, policyMaterial }),
    policyMaterial,
    preview,
  });
}

async function approve<TRequest>(
  approval: LegacySecureOperationApproval,
  operationBinding: LegacySecureOperationBinding<TRequest>,
): Promise<LegacySecureOperationApprovalDecision> {
  const decision = await approval.request(operationBinding);
  if (
    decision === null ||
    typeof decision !== "object" ||
    decision.bindingHash !== operationBinding.bindingHash ||
    (decision.status !== "approved" && decision.status !== "rejected") ||
    (decision.status === "approved" &&
      (typeof decision.approvalId !== "string" || decision.approvalId.length === 0))
  ) {
    throw new Error("Legacy secure operation approval binding mismatch");
  }
  return Object.freeze({ ...decision });
}

export function normalizeLegacyRawTransactionRequest(
  input: unknown,
): LegacyRawTransactionRequest {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Object.prototype ||
    !exactKeys(input, ["txraws", "utxos_satoshis", "script_pubkeys"])
  ) {
    throw new TypeError("Invalid Legacy raw transaction request");
  }
  const value = canonicalClone(input, "Invalid Legacy raw transaction request");
  const txraws = Reflect.get(value, "txraws");
  const satoshis = Reflect.get(value, "utxos_satoshis");
  const scripts = Reflect.get(value, "script_pubkeys");
  if (
    !Array.isArray(txraws) ||
    txraws.length === 0 ||
    txraws.length > MAX_RAW_TRANSACTIONS ||
    !Array.isArray(satoshis) ||
    !Array.isArray(scripts) ||
    satoshis.length !== txraws.length ||
    scripts.length !== txraws.length ||
    utf8Bytes(canonicalize(value)) > MAX_RAW_REQUEST_BYTES
  ) {
    throw new TypeError("Invalid Legacy raw transaction request");
  }
  for (let index = 0; index < txraws.length; index += 1) {
    const raw = txraws[index];
    const amounts = satoshis[index];
    const scriptRow = scripts[index];
    if (
      typeof raw !== "string" ||
      !HEX.test(raw) ||
      !Array.isArray(amounts) ||
      !Array.isArray(scriptRow) ||
      amounts.length === 0 ||
      amounts.length > MAX_INPUTS_PER_TRANSACTION ||
      amounts.length !== scriptRow.length ||
      amounts.some((amount) => !Number.isSafeInteger(amount) || amount < 0) ||
      scriptRow.some((script) => typeof script !== "string" || !HEX.test(script))
    ) {
      throw new TypeError("Invalid Legacy raw transaction request");
    }
    let transaction: ReturnType<typeof parseTbcTransaction>;
    try {
      transaction = parseTbcTransaction(raw);
    } catch {
      throw new TypeError("Invalid Legacy raw transaction request");
    }
    if (transaction.inputs.length !== amounts.length) {
      throw new TypeError("Invalid Legacy raw transaction request");
    }
  }
  return value as LegacyRawTransactionRequest;
}

export function normalizeLegacyRawTransactionResult(
  input: unknown,
  request: LegacyRawTransactionRequest,
): LegacyRawTransactionResult {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Object.prototype ||
    !exactKeys(input, ["sigs"])
  ) {
    throw new TypeError("Invalid Legacy raw transaction result");
  }
  const value = canonicalClone(input, "Invalid Legacy raw transaction result");
  const signatures = Reflect.get(value, "sigs");
  if (
    !Array.isArray(signatures) ||
    signatures.length !== request.txraws.length ||
    signatures.some((row, index) =>
      !Array.isArray(row) ||
      row.length !== request.utxos_satoshis[index]?.length ||
      row.some((signature) =>
        typeof signature !== "string" ||
        !HEX.test(signature) ||
        signature.length > 1_024
      )
    )
  ) {
    throw new TypeError("Invalid Legacy raw transaction result");
  }
  return Object.freeze({
    sigs: Object.freeze(signatures.map((row) => Object.freeze([...(row as string[])]))),
  });
}

export function createLegacyRawTransactionSigningService(options: Readonly<{
  approval: LegacySecureOperationApproval;
  authority: LegacySecureOperationAuthority;
  reviewer: LegacyRawTransactionReviewer;
  signer: LegacyRawTransactionSigner;
  materialNative?: PoolMaterialNativeProviderInput;
}>): LegacyRawTransactionSigningService {
  if (
    options === null ||
    typeof options !== "object" ||
    typeof options.approval?.request !== "function" ||
    typeof options.authority?.assertCurrent !== "function" ||
    typeof options.reviewer?.review !== "function" ||
    typeof options.signer?.sign !== "function"
  ) {
    throw new TypeError("Legacy raw transaction review, approval, authority and Signer are required");
  }
  const materialNative = options.materialNative ?? createLazyBundledWasmTbcKeylessEngine();
  return Object.freeze({
    async sign(requestInput: unknown, context: LegacySecureOperationContext) {
      let request: LegacyRawTransactionRequest;
      try {
        request = normalizeLegacyRawTransactionRequest(requestInput);
      } catch (error) {
        throw new LegacySecureOperationRequestValidationError(error);
      }
      const trustedContext = secureContext(context);
      await options.authority.assertCurrent(trustedContext);
      // Historical signTransaction also signs FT/NFT/Pool covenant inputs. The
      // shared reviewer must verify and classify their exact material instead
      // of narrowing the request to one P2PKH script or presenting raw hex.
      let review: LegacyRawTransactionReview;
      try {
        review = normalizeRawTransactionReview(
          await options.reviewer.review({
            request,
            context: trustedContext,
            transactionIds: Object.freeze(request.txraws.map(turingTransactionId)),
          }),
          request,
        );
        await requireBoundReviewedPolicy(materialNative, request, review.policyMaterial);
      } catch (error) {
        throw new LegacySecureOperationRequestValidationError(error);
      }
      const operationBinding = binding("signTransaction", request, trustedContext, review);
      const decision = await approve(options.approval, operationBinding);
      if (decision.status === "rejected") return Object.freeze({ status: "rejected" as const });
      await requireBoundReviewedPolicy(materialNative, request, review.policyMaterial);
      await options.authority.assertCurrent(trustedContext);
      const result = normalizeLegacyRawTransactionResult(
        await options.signer.sign({ binding: operationBinding, approval: decision }),
        request,
      );
      return Object.freeze({ status: "approved" as const, result });
    },
  });
}

export function createLegacyAssociatedTransactionSigningService(options: Readonly<{
  approval: LegacySecureOperationApproval;
  authority: LegacySecureOperationAuthority;
  reviewer: LegacyAssociatedTransactionReviewer;
  transactions: Pick<
    LegacyAssociatedTransactionService,
    "prepare" | "readRequest" | "read" | "complete"
  >;
  executor: LegacyAssociatedTransactionExecutor;
  materialNative?: PoolMaterialNativeProviderInput;
}>): LegacyAssociatedTransactionSigningService {
  if (
    options === null ||
    typeof options !== "object" ||
    typeof options.approval?.request !== "function" ||
    typeof options.authority?.assertCurrent !== "function" ||
    typeof options.reviewer?.review !== "function" ||
    typeof options.transactions?.prepare !== "function" ||
    typeof options.transactions.readRequest !== "function" ||
    typeof options.transactions.read !== "function" ||
    typeof options.transactions.complete !== "function" ||
    typeof options.executor?.execute !== "function"
  ) {
    throw new TypeError(
      "Legacy associated review, approval, authority, journal and executor are required",
    );
  }
  const materialNative = options.materialNative ?? createLazyBundledWasmTbcKeylessEngine();
  return Object.freeze({
    async sign(requestInput: unknown, context: LegacySecureOperationContext) {
      let normalizedRequest: Readonly<Record<string, unknown>>;
      try {
        normalizedRequest = normalizeLegacyAssociatedTransactionRequest(requestInput);
      } catch (error) {
        throw new LegacySecureOperationRequestValidationError(error);
      }
      const trustedContext = secureContext(context);
      await options.authority.assertCurrent(trustedContext);
      const prepared = await options.transactions.prepare(normalizedRequest);
      const request = await options.transactions.readRequest(prepared.operationDigest);
      if (request === null) {
        throw new Error("Legacy associated transaction request is unavailable");
      }
      let review: LegacyAssociatedTransactionReview;
      try {
        const reviewed = await options.reviewer.review({
            request,
            operationDigest: prepared.operationDigest,
            context: trustedContext,
          });
        const materialized = materializeAssociatedReviewRequest(request);
        review = normalizeAssociatedTransactionReview(
          reviewed,
          request,
          prepared.operationDigest,
          materialized,
        );
        await requireBoundReviewedPolicy(materialNative, materialized, review.policyMaterial);
      } catch (error) {
        throw new LegacySecureOperationRequestValidationError(error);
      }
      const operationBinding = binding(
        "signAssociatedTransaction",
        request,
        trustedContext,
        review,
      );
      const decision = await approve(options.approval, operationBinding);
      if (decision.status === "rejected") {
        return Object.freeze({ status: "rejected" as const });
      }
      await requireBoundReviewedPolicy(materialNative, materializeAssociatedReviewRequest(request), review.policyMaterial);
      await options.authority.assertCurrent(trustedContext);
      const completed = await options.transactions.read(prepared.operationDigest);
      const result = completed ?? await options.transactions.complete(
        prepared.operationDigest,
        await options.executor.execute({
          operationDigest: prepared.operationDigest,
          request,
        }),
      );
      return Object.freeze({ status: "approved" as const, result });
    },
  });
}

function normalizeCryptoRequest(input: unknown, operation: "encrypt" | "decrypt"): LegacyCryptoRequest {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Object.prototype
  ) {
    throw new TypeError(`Invalid Legacy ${operation} request`);
  }
  const allowed = operation === "decrypt" && Object.hasOwn(input, "encryptedMessage")
    ? ["encryptedMessage"]
    : ["message"];
  if (!exactKeys(input, allowed)) throw new TypeError(`Invalid Legacy ${operation} request`);
  const message = Reflect.get(input, allowed[0]!);
  const limit = operation === "encrypt" ? MAX_MESSAGE_BYTES : MAX_ENCRYPTED_MESSAGE_BYTES;
  if (typeof message !== "string" || message.length === 0 || utf8Bytes(message) > limit) {
    throw new TypeError(`Invalid Legacy ${operation} request`);
  }
  return Object.freeze({ message });
}

function normalizeEncryptResult(input: unknown): LegacyEncryptResult {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Object.prototype ||
    !exactKeys(input, ["encryptedMessage"])
  ) throw new TypeError("Invalid Legacy encrypt result");
  const encryptedMessage = Reflect.get(input, "encryptedMessage");
  if (
    typeof encryptedMessage !== "string" ||
    encryptedMessage.length === 0 ||
    utf8Bytes(encryptedMessage) > MAX_ENCRYPTED_MESSAGE_BYTES
  ) throw new TypeError("Invalid Legacy encrypt result");
  return Object.freeze({ encryptedMessage });
}

function normalizeDecryptResult(input: unknown): LegacyDecryptResult {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Object.prototype ||
    !exactKeys(input, ["decryptedMessage"])
  ) throw new TypeError("Invalid Legacy decrypt result");
  const decryptedMessage = Reflect.get(input, "decryptedMessage");
  if (
    typeof decryptedMessage !== "string" ||
    utf8Bytes(decryptedMessage) > MAX_MESSAGE_BYTES
  ) throw new TypeError("Invalid Legacy decrypt result");
  return Object.freeze({ decryptedMessage });
}

export function createLegacyCryptoService(options: Readonly<{
  approval: LegacySecureOperationApproval;
  authority: LegacySecureOperationAuthority;
  adapter: LegacyCryptoAdapter;
}>): LegacyCryptoService {
  if (
    options === null ||
    typeof options !== "object" ||
    typeof options.approval?.request !== "function" ||
    typeof options.authority?.assertCurrent !== "function" ||
    typeof options.adapter?.encrypt !== "function" ||
    typeof options.adapter.decrypt !== "function"
  ) {
    throw new TypeError("Legacy crypto approval, authority and wallet adapter are required");
  }
  const execute = async <TResult>(
    operationKind: "encrypt" | "decrypt",
    requestInput: unknown,
    context: LegacySecureOperationContext,
  ): Promise<LegacySecureOperationOutcome<TResult>> => {
    let request: LegacyCryptoRequest;
    try {
      request = normalizeCryptoRequest(requestInput, operationKind);
    } catch (error) {
      throw new LegacySecureOperationRequestValidationError(error);
    }
    const trustedContext = secureContext(context);
    await options.authority.assertCurrent(trustedContext);
    const operationBinding = binding(operationKind, request, trustedContext);
    const decision = await approve(options.approval, operationBinding);
    if (decision.status === "rejected") return Object.freeze({ status: "rejected" as const });
    await options.authority.assertCurrent(trustedContext);
    const raw = await options.adapter[operationKind]({
      binding: operationBinding,
      approval: decision,
    });
    const result = operationKind === "encrypt"
      ? normalizeEncryptResult(raw)
      : normalizeDecryptResult(raw);
    return Object.freeze({ status: "approved" as const, result: result as TResult });
  };
  return Object.freeze({
    encrypt: (request: unknown, context: LegacySecureOperationContext) =>
      execute<LegacyEncryptResult>("encrypt", request, context),
    decrypt: (request: unknown, context: LegacySecureOperationContext) =>
      execute<LegacyDecryptResult>("decrypt", request, context),
  });
}

export function createLegacyTbcBalanceReader(
  options: Omit<CreateTbcOfficialApiOptions, "baseUrl" | "network" | "allowedOrigins"> &
    Readonly<{ network: TbcNetworkContext }>,
): LegacyTbcBalanceReader {
  if (options === null || typeof options !== "object") {
    throw new TypeError("Legacy TBC balance network is required");
  }
  const { network: networkInput, ...transportOptions } = options;
  const network = assertTbcNetworkContext(networkInput);
  const api = createTbcOfficialApi({
    ...transportOptions,
    baseUrl: network.endpoint.apiOrigin,
    allowedOrigins: Object.freeze([network.endpoint.apiOrigin]),
  });
  return Object.freeze({
    chainId: network.chainId,
    networkSourceIdentity: network.sourceIdentity,
    async read(addressInput: string) {
      const address = assertTbcAddress(addressInput, network.profile.p2pkhVersion).address;
      const result = await api.balanceByAddress({ address });
      if (
        result === null ||
        typeof result !== "object" ||
        Array.isArray(result) ||
        (result.address !== undefined && result.address !== address)
      ) {
        throw new Error("Invalid Legacy TBC balance response");
      }
      const candidate = result.balance;
      const atomic = typeof candidate === "number" && Number.isSafeInteger(candidate)
        ? String(candidate)
        : candidate;
      if (
        typeof atomic !== "string" ||
        !/^(0|[1-9][0-9]*)$/u.test(atomic) ||
        BigInt(atomic) > BigInt(Number.MAX_SAFE_INTEGER)
      ) {
        throw new Error("Invalid Legacy TBC balance response");
      }
      const padded = atomic.padStart(7, "0");
      const display = `${padded.slice(0, -6)}.${padded.slice(-6)}`;
      return Object.freeze({ tbc: Number(display) });
    },
  });
}
