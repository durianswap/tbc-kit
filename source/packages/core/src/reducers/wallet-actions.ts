// Independent Provider methods. No public workflow dispatch or synthetic workflow.
import {
  assertApprovalBinding,
  assertApprovalRequest,
  createApprovalBinding,
  createApprovalRequest,
  type ApprovalBinding,
  type ApprovalReceipt,
} from "../bindings.js";
import { canonicalize } from "../canonical-json.js";
import { verifyCheckpoint, type OperationCheckpoint } from "../checkpoint.js";
import { TwsEngineError, TwsStateError } from "../errors.js";
import { hashCanonical } from "../hash.js";
import type { PortCall } from "../ports.js";
import type { CoreTransition } from "../transitions.js";
import { completeTransition, waitingTransition } from "../transitions.js";
import { prepareApprovalWithMemory, readApprovalDecision } from "./approval.js";
import { advance, completeSuccess, earliestExpiry, makeCalls, nextRevision, operationOf } from "./shared.js";
import {
  cryptoTask, reviewedTransactionTask, reviewedSigningRoleContext, assertCryptoOutcome, assertReviewedOutcome,
  type AccountIdentity, type CryptoTask, type CryptoResult,
  type ReviewedTransactionTask, type ReviewedTransactionReview, type ReviewedTransactionResult,
} from "./private-action-kernel.js";

type RecordValue = Readonly<Record<string, unknown>>;
type Review = Pick<ReviewedTransactionReview, "payload" | "reviewHash">;
type Request = Readonly<{
  signingRoles?: import("../transaction-signing-roles.js").TransactionRoleRequest["signingRoles"];
  chainId: string; from: string; expiresAt?: string; maxFee?: string;
  request?: RecordValue;
  algorithm?: CryptoTask["algorithm"];
  message?: NonNullable<CryptoTask["message"]>;
  ciphertext?: string;
}>;
type ActionPlan = Readonly<{
  payload: Readonly<{
    requestHash: string; contextHash: string; chainId: string; accountId: string;
    expiresAt: string; task: CryptoTask | ReviewedTransactionTask;
    preview: RecordValue; review?: Review;
  }>;
  planHash: string;
}>;

export type WalletActionMethod =
  | "tbc_signReviewedTransaction"
  | "tbc_encrypt"
  | "tbc_decrypt";

export type WalletActionTaskSummary =
  | Readonly<{
      readonly purpose: "reviewedTransaction";
      readonly taskId: string;
      readonly requestHash: string;
      readonly reviewHash: string;
    }>
  | Readonly<{
      readonly purpose: "encrypt" | "decrypt";
      readonly taskId: string;
      readonly algorithm: CryptoTask["algorithm"];
    }>;

export interface WalletActionApprovalEvidence {
  readonly kind: "reviewed-transaction" | "crypto";
  readonly method: WalletActionMethod;
  readonly request: Readonly<Record<string, unknown>>;
  readonly requestHash: string;
  readonly contextHash: string;
  readonly origin: string;
  readonly chainId: string;
  readonly accountId: string;
  readonly from: string;
  readonly expiresAt: string;
  readonly planHash: string;
  readonly approvalBinding: ApprovalBinding;
  readonly preview: Readonly<Record<string, unknown>>;
  readonly task: WalletActionTaskSummary;
}

export interface WalletActionApprovalEvidenceInput {
  readonly checkpoint: unknown;
  readonly approvalCall: unknown;
  readonly approvalRequest: unknown;
}

export function isWalletAction(method: string): boolean {
  return method === "tbc_signReviewedTransaction" || method === "tbc_encrypt" || method === "tbc_decrypt";
}

function same(a: unknown, b: unknown): boolean { return canonicalize(a) === canonicalize(b); }
function invalid(message: string): never { throw new TwsEngineError("ENGINE_ARTIFACT_MISMATCH", message); }

function accountOf(checkpoint: OperationCheckpoint, memory = checkpoint.payload.memory): AccountIdentity {
  const operation = operationOf(checkpoint);
  if (!isWalletAction(operation.method)) invalid("wallet action method mismatch");
  const request = operation.params as Request;
  const resolutions = memory.accountResolutions as readonly { result: { accounts: readonly AccountIdentity[] } }[];
  const account = resolutions?.flatMap(x => x.result.accounts).find(x =>
    x.chainId === request.chainId && x.address === request.from && x.accountId === `${request.chainId}:${request.from}`);
  if (account === undefined) invalid("wallet action account mismatch");
  return account;
}

function reviewParams(checkpoint: OperationCheckpoint, account: AccountIdentity, memory = checkpoint.payload.memory) {
  const outer = operationOf(checkpoint).params as Request;
  const request = outer.request;
  if (request === undefined) invalid("reviewed request is missing");
  const context = checkpoint.payload.context as { origin: string; sessionId: string };
  const { roles } = reviewedSigningRoleContext(checkpoint, { id: "single", request, signingRoles: outer.signingRoles }, account, memory);
  return {
    ...(roles === undefined ? {} : { signingRoles: roles }),
    version: "1.0", taskId: "review-single", contextHash: checkpoint.payload.contextHash,
    origin: context.origin, sessionId: context.sessionId,
    chainId: account.chainId, accountId: account.accountId, publicKey: account.publicKey,
    requestHash: hashCanonical(request), request,
  };
}

function buildPlan(checkpoint: OperationCheckpoint, memory: Readonly<Record<string, unknown>>, review?: Review, expiry = checkpoint.payload.expiresAt): ActionPlan {
  const account = accountOf(checkpoint, memory);
  const operation = operationOf(checkpoint);
  const request = operation.params as Request;
  const origin = (checkpoint.payload.context as { origin: string }).origin;
  let task: CryptoTask | ReviewedTransactionTask;
  let preview: RecordValue;
  if (operation.method === "tbc_signReviewedTransaction") {
    if (review === undefined || request.request === undefined || review.reviewHash !== hashCanonical(review.payload) || review.payload.preview.operationKind !== "transaction") {
      invalid("trusted reviewed transaction artifact is missing or inconsistent");
    }
    if (request.maxFee !== undefined && BigInt(review.payload.totalFee) > BigInt(request.maxFee)) invalid("reviewed transaction exceeds maxFee");
    if (review.payload.preview.totalFee !== review.payload.totalFee) invalid("reviewed fee differs from preview");
    task = reviewedTransactionTask(checkpoint, { id: "single", request: request.request, signingRoles: request.signingRoles }, { stepId: "single", ...review }, account, memory);
    preview = review.payload.preview;
  } else {
    if (review !== undefined) invalid("crypto action must not carry a transaction review");
    task = cryptoTask(operation.method === "tbc_encrypt"
      ? { id: "single", kind: "encrypt", algorithm: request.algorithm!, message: request.message! }
      : { id: "single", kind: "decrypt", algorithm: request.algorithm!, ciphertext: request.ciphertext! }, account, origin);
    preview = {
      operationKind: "crypto", purpose: task.purpose, algorithm: task.algorithm,
      ...(task.purpose === "encrypt" ? { message: task.message } : { ciphertext: task.ciphertext }), warnings: [],
    };
  }
  const expiresAt = earliestExpiry(expiry, request.expiresAt, review?.payload.expiresAt);
  if (expiresAt === undefined) invalid("wallet action expiry missing");
  const payload = {
    requestHash: hashCanonical(operation.params), contextHash: checkpoint.payload.contextHash,
    chainId: account.chainId, accountId: account.accountId, expiresAt, task, preview,
    ...(review === undefined ? {} : { review }),
  };
  return { payload, planHash: hashCanonical(payload) };
}

function bindingFor(checkpoint: OperationCheckpoint, plan: ActionPlan) {
  const context = checkpoint.payload.context as { origin: string; sessionId: string };
  return createApprovalBinding({
    version: "1.0", method: operationOf(checkpoint).method,
    operationKind: plan.payload.task.purpose === "reviewedTransaction" ? "transaction" : "crypto",
    contextHash: checkpoint.payload.contextHash, origin: context.origin, sessionId: context.sessionId,
    chainId: plan.payload.chainId, accountId: plan.payload.accountId,
    requestHash: plan.payload.requestHash, operationHash: plan.planHash, expiresAt: plan.payload.expiresAt,
  });
}

function prepare(checkpoint: OperationCheckpoint, memory: Readonly<Record<string, unknown>>, review?: Review) {
  const plan = buildPlan(checkpoint, memory, review);
  return prepareApprovalWithMemory(checkpoint, bindingFor(checkpoint, plan), plan.payload.preview,
    { ...memory, walletActionPlan: plan });
}

export function beginWalletAction(checkpoint: OperationCheckpoint, account: AccountIdentity, memory: Readonly<Record<string, unknown>>): CoreTransition {
  if (!same(accountOf(checkpoint, memory), account)) invalid("wallet action resolved account changed");
  if (operationOf(checkpoint).method !== "tbc_signReviewedTransaction") return prepare(checkpoint, memory);
  return waitingTransition(advance(checkpoint, {
    state: "resolving", memory, data: { resolvedInputs: { account } },
    pendingCalls: makeCalls(checkpoint, nextRevision(checkpoint), [{ operation: "reviewedTransaction.review", params: reviewParams(checkpoint, account, memory) }]),
  }));
}

export function reduceWalletActionReview(checkpoint: OperationCheckpoint, call: PortCall, value: unknown): CoreTransition {
  const account = accountOf(checkpoint);
  if (operationOf(checkpoint).method !== "tbc_signReviewedTransaction" || call.operation !== "reviewedTransaction.review" ||
    !same(call.params, reviewParams(checkpoint, account))) invalid("trusted review request binding mismatch");
  return prepare(checkpoint, checkpoint.payload.memory, value as Review);
}

export function assertWalletActionApproval(checkpoint: OperationCheckpoint) {
  const plan = checkpoint.payload.memory.walletActionPlan as ActionPlan;
  if (plan === undefined || !same(plan, buildPlan(checkpoint, checkpoint.payload.memory, plan.payload.review, plan.payload.expiresAt))) {
    invalid("wallet action plan differs from request/account/review");
  }
  const binding = bindingFor(checkpoint, plan);
  assertApprovalBinding(checkpoint.payload.memory.approvalBinding as typeof binding, binding.payload);
  if (!same(checkpoint.payload.memory.approvalPreview, plan.payload.preview)) invalid("wallet action preview changed");
  if (checkpoint.payload.memory.signingTasks !== undefined && !same(checkpoint.payload.memory.signingTasks, [plan.payload.task])) invalid("wallet action task changed");
  return { plan, account: accountOf(checkpoint), binding };
}

/**
 * Verifies and projects one wallet-action approval from an authoritative Host
 * checkpoint. Hash-valid input is not authority by itself: callers must obtain
 * all three values from the same trusted Host evidence read.
 */
export function assertWalletActionApprovalEvidence(
  input: WalletActionApprovalEvidenceInput,
): WalletActionApprovalEvidence {
  const checkpoint = verifyCheckpoint(input.checkpoint as OperationCheckpoint);
  if (checkpoint.payload.state !== "approval") {
    invalid("wallet action evidence is not awaiting approval");
  }
  const approvalCall = input.approvalCall as PortCall;
  if (
    approvalCall === null ||
    typeof approvalCall !== "object" ||
    approvalCall.operation !== "approval.request" ||
    !checkpoint.payload.pendingCalls.some((pending) => same(pending, approvalCall))
  ) {
    invalid("wallet action approval call is not authoritative");
  }
  const { plan, account, binding } = assertWalletActionApproval(checkpoint);
  const context = checkpoint.payload.context as {
    readonly origin: string;
    readonly sessionId: string;
    readonly transport: "webview" | "extension" | "remote";
    readonly topOrigin: string;
    readonly frame: "top" | "child";
  };
  const expectedRequest = createApprovalRequest(binding, plan.payload.preview, context);
  assertApprovalRequest(approvalCall.params, expectedRequest);
  assertApprovalRequest(input.approvalRequest, expectedRequest);
  const operation = operationOf(checkpoint);
  if (!isWalletAction(operation.method)) invalid("wallet action method mismatch");
  const method = operation.method as WalletActionMethod;
  const task = plan.payload.task;
  const taskSummary: WalletActionTaskSummary = task.purpose === "reviewedTransaction"
    ? Object.freeze({
        purpose: task.purpose,
        taskId: task.taskId,
        requestHash: task.requestHash,
        reviewHash: task.reviewHash,
      })
    : Object.freeze({
        purpose: task.purpose,
        taskId: task.taskId,
        algorithm: task.algorithm,
      });
  return Object.freeze({
    kind: task.purpose === "reviewedTransaction" ? "reviewed-transaction" : "crypto",
    method,
    request: operation.params as Readonly<Record<string, unknown>>,
    requestHash: plan.payload.requestHash,
    contextHash: plan.payload.contextHash,
    origin: context.origin,
    chainId: account.chainId,
    accountId: account.accountId,
    from: account.address,
    expiresAt: plan.payload.expiresAt,
    planHash: plan.planHash,
    approvalBinding: binding,
    preview: plan.payload.preview,
    task: taskSummary,
  });
}

export function reduceWalletActionApproval(checkpoint: OperationCheckpoint, call: PortCall, value: unknown): CoreTransition {
  const { plan } = assertWalletActionApproval(checkpoint);
  const decision = readApprovalDecision(checkpoint, call, value);
  if (decision.status === "rejected") {
    return completeTransition(advance(checkpoint, { state: "rejected", pendingCalls: [], data: { cancellationReason: "USER_REJECTED" } }), {
      delivery: "respond", response: { jsonrpc: "2.0", id: checkpoint.payload.requestId, error: { code: 4001, message: "User rejected the request" } }, events: [],
    });
  }
  return waitingTransition(advance(checkpoint, {
    state: "signing", expiresAt: decision.receipt.expiresAt,
    pendingCalls: makeCalls(checkpoint, nextRevision(checkpoint), [{ operation: "clock.now", params: { version: "1.0" } }]),
    memory: { ...checkpoint.payload.memory, approvalReceipt: decision.receipt, signingTasks: [plan.payload.task] },
    data: { approvalReceipt: decision.receipt, signingTask: plan.payload.task },
  }));
}

export function reduceWalletActionResult(checkpoint: OperationCheckpoint, call: PortCall, value: unknown): CoreTransition {
  const { plan, account } = assertWalletActionApproval(checkpoint);
  const task = plan.payload.task;
  const approval = checkpoint.payload.memory.approvalReceipt as ApprovalReceipt;
  if (task.purpose === "reviewedTransaction") {
    if (call.operation !== "reviewedTransaction.execute" || plan.payload.review === undefined) throw new TwsStateError("PORT_RESULT_INVALID", "unexpected reviewed operation");
    const result = value as ReviewedTransactionResult;
    assertReviewedOutcome(call.params, result, task, plan.payload.review, account, approval);
    return completeSuccess(checkpoint, { ...result.bundle, requestHash: plan.payload.requestHash });
  }
  if (call.operation !== "crypto.execute") throw new TwsStateError("PORT_RESULT_INVALID", "unexpected crypto operation");
  const result = value as CryptoResult;
  assertCryptoOutcome(call.params, result, task, approval);
  return completeSuccess(checkpoint, {
    version: "1.0", chainId: account.chainId, from: account.address, algorithm: task.algorithm,
    ...(task.purpose === "encrypt" ? { ciphertext: result.ciphertext } : { message: result.message }),
  });
}
