// Internal shared kernel for standalone wallet actions and workflow steps.
import { canonicalize } from "../canonical-json.js";
import { hashCanonical } from "../hash.js";
import type { OperationCheckpoint } from "../checkpoint.js";
import { TwsEngineError, TwsStateError } from "../errors.js";
import type { ApprovalReceipt } from "../bindings.js";
import { resolveReviewedSigningRoles, assertReviewedSigningRolePreview } from "../reviewed-signing-roles.js";
import type { TransactionRoleRequest, ResolvedTransactionSigningRole } from "../transaction-signing-roles.js";

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalize(left) === canonicalize(right);
}

export function assertCryptoOutcome(
  params: unknown, result: CryptoResult, task: CryptoTask, approval: ApprovalReceipt,
): void {
  if (!sameJson(params, { version: "1.0", approval, task }) ||
    result.taskId !== task.taskId || result.algorithm !== task.algorithm ||
    (task.purpose === "encrypt"
      ? typeof result.ciphertext !== "string" || result.message !== undefined
      : result.message === undefined || result.ciphertext !== undefined)) {
    throw new TwsStateError("PORT_RESULT_INVALID", "crypto result differs from its approved task");
  }
}

export function assertReviewedOutcome(
  params: unknown, result: ReviewedTransactionResult, task: ReviewedTransactionTask,
  review: Pick<ReviewedTransactionReview, "payload" | "reviewHash">,
  account: AccountIdentity, approval: ApprovalReceipt,
): void {
  if (!sameJson(params, { version: "1.0", approval, task }) ||
    result.taskId !== task.taskId || result.reviewHash !== task.reviewHash ||
    result.bundle.chainId !== account.chainId || result.bundle.from !== account.address ||
    result.bundle.requestHash !== task.requestHash || result.bundle.approvalId !== approval.approvalId ||
    result.bundle.totalFee !== review.payload.totalFee || !reviewedDetachedSignaturesMatch(task, result.bundle) ||
    account.accountId !== task.accountId || account.publicKey !== task.publicKey) {
    throw new TwsStateError("PORT_RESULT_INVALID", "reviewed transaction execution differs from its approved review");
  }
}

type EncodedMessage = Readonly<{ encoding: "utf8" | "hex" | "base64"; data: string }>;
type CryptoStep = Readonly<{ id: string; algorithm: "tbc-bie1-secp256k1-aes128-cbc-hmac-sha256-v1" }> & (Readonly<{ kind: "encrypt"; message: EncodedMessage }> | Readonly<{ kind: "decrypt"; ciphertext: string }>);
interface ReviewedTransactionStep { readonly id: string; readonly request: Readonly<Record<string, unknown>>; readonly signingRoles?: TransactionRoleRequest["signingRoles"]; }

export interface AccountIdentity {
  readonly address: string;
  readonly accountId: string;
  readonly chainId: string;
  readonly publicKey: string;
}


export type CryptoTask = Readonly<{
  readonly taskId: string;
  readonly purpose: "encrypt" | "decrypt";
  readonly algorithm: CryptoStep["algorithm"];
  readonly origin: string;
  readonly accountId: string;
  readonly publicKey: string;
  readonly message?: EncodedMessage;
  readonly ciphertext?: string;
}>;

export type CryptoResult = Readonly<{
  readonly taskId: string;
  readonly algorithm: CryptoStep["algorithm"];
  readonly ciphertext?: string;
  readonly message?: EncodedMessage;
}>;

export type ReviewedPolicyMaterial = Readonly<{
  readonly resolvedOutputs: readonly Readonly<{
    readonly txid: string; readonly vout: number;
    readonly satoshis: string; readonly scriptPubKey: string;
  }>[];
}>;

export type ReviewedTransactionTask = Readonly<{
  readonly signingRoles?: readonly ResolvedTransactionSigningRole[];
  readonly taskId: string;
  readonly purpose: "reviewedTransaction";
  readonly contextHash: string;
  readonly requestHash: string;
  readonly reviewHash: string;
  readonly policyMaterial: ReviewedPolicyMaterial;
  readonly chainId: string;
  readonly accountId: string;
  readonly publicKey: string;
  readonly request: Readonly<Record<string, unknown>>;
}>;

export type ReviewedTransactionReview = Readonly<{
  readonly stepId: string;
  readonly payload: Readonly<{
    readonly preview: Readonly<Record<string, unknown>>;
    readonly totalFee: string;
    readonly expiresAt: string;
    readonly policyMaterial: ReviewedPolicyMaterial;
  }>;
  readonly reviewHash: string;
}>;

export type ReviewedTransactionResult = Readonly<{
  readonly taskId: string;
  readonly reviewHash: string;
  readonly bundle: SignedBundle;
}>;

export function reviewedDetachedSignaturesMatch(
  task: ReviewedTransactionTask,
  bundle: SignedBundle,
): boolean {
  const payload = task.request.payload as
    | Readonly<{
        readonly format?: unknown;
        readonly transactions?: readonly Readonly<{ readonly inputs?: readonly unknown[] }>[];
      }>
    | undefined;
  if (payload?.format !== "raw") return bundle.detachedSignatures === undefined;
  if (bundle.detachedSignatures === undefined) return true;
  const transactions = payload.transactions;
  return Array.isArray(transactions) &&
    bundle.detachedSignatures.length === transactions.length &&
    bundle.detachedSignatures.every((row, index) =>
      Array.isArray(transactions[index]?.inputs) &&
      row.length === transactions[index]!.inputs!.length
    );
}


export interface SignedBundle {
  readonly version: "1.0";
  readonly chainId: string;
  readonly from: string;
  readonly requestHash: string;
  readonly approvalId: string;
  readonly transactions: readonly {
    readonly txid: string;
    readonly role: string;
    readonly [key: string]: unknown;
  }[];
  readonly totalFee: string;
  readonly artifacts?: Readonly<Record<string, string>>;
  readonly detachedSignatures?: readonly (readonly string[])[];
}


export function reviewedSigningRoleContext(checkpoint: OperationCheckpoint, step: ReviewedTransactionStep, account: AccountIdentity,
  memory = checkpoint.payload.memory) {
  const resolutions = memory.accountResolutions as readonly { result: { accounts: readonly AccountIdentity[] } }[] | undefined;
  const accounts = resolutions?.at(-1)?.result.accounts ?? [account];
  const request = { chainId: account.chainId, from: account.address, request: step.request, signingRoles: step.signingRoles };
  return { request, accounts, roles: resolveReviewedSigningRoles(request, accounts) };
}

export function reviewedTransactionTask(
  checkpoint: OperationCheckpoint,
  step: ReviewedTransactionStep,
  review: ReviewedTransactionReview,
  account: AccountIdentity,
  memory = checkpoint.payload.memory,
): ReviewedTransactionTask {
  if (review.reviewHash !== hashCanonical(review.payload)) {
    throw new TwsEngineError(
      "ENGINE_ARTIFACT_MISMATCH",
      "reviewed transaction review hash does not match its payload",
    );
  }
  const roleContext = reviewedSigningRoleContext(checkpoint, step, account, memory);
  const roles = assertReviewedSigningRolePreview(roleContext.request, roleContext.accounts, review.payload.preview);
  return Object.freeze({
    ...(roles === undefined ? {} : { signingRoles: roles }),
    taskId: `review-${step.id}`,
    purpose: "reviewedTransaction" as const,
    contextHash: checkpoint.payload.contextHash,
    requestHash: hashCanonical(step.request),
    reviewHash: review.reviewHash,
    policyMaterial: review.payload.policyMaterial,
    chainId: account.chainId,
    accountId: account.accountId,
    publicKey: account.publicKey,
    request: step.request,
  });
}


export function cryptoTask(
  step: CryptoStep,
  account: AccountIdentity,
  origin: string,
): CryptoTask {
  return Object.freeze({
    taskId: `crypto-${step.id}`,
    purpose: step.kind,
    algorithm: step.algorithm,
    origin,
    accountId: account.accountId,
    publicKey: account.publicKey,
    ...(step.kind === "encrypt"
      ? { message: Object.freeze({ ...step.message }) }
      : { ciphertext: step.ciphertext }),
  });
}
