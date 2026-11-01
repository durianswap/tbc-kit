import {
  assertApprovalBinding,
  assertApprovalReceipt,
  assertApprovalRequest,
  createApprovalRequest,
  type ApprovalBinding,
  type ApprovalReceipt,
} from "../bindings.js";
import { canonicalize } from "../canonical-json.js";
import type { OperationCheckpoint } from "../checkpoint.js";
import { TwsApprovalError } from "../errors.js";
import { hashCanonical } from "../hash.js";
import { signingEnvelopeDigest } from "../signing-artifacts.js";
import type { PortCall } from "../ports.js";
import type { CoreTransition } from "../transitions.js";
import { waitingTransition } from "../transitions.js";
import { assertPortResult, assertValidTws } from "../validation.js";
import {
  advance,
  completeError,
  makeCalls,
  nextRevision,
  operationOf,
} from "./shared.js";

interface ApprovalContext {
  readonly sessionId: string;
  readonly transport: "webview" | "extension" | "remote";
  readonly origin: string;
  readonly topOrigin: string;
  readonly frame: "top" | "child";
}

export type ApprovalDecision =
  | Readonly<{ readonly status: "approved"; readonly receipt: ApprovalReceipt }>
  | Readonly<{
      readonly status: "rejected";
      readonly bindingHash: string;
      readonly rejectedAt: string;
    }>;

const APPROVAL_SOURCE_STATE: Readonly<Record<string, string>> = Object.freeze({
  permission: "resolving",
  switchChain: "authorizing",
  transaction: "planning",
  message: "resolving",
  typedData: "resolving",
  workflow: "planning",
  crypto: "resolving",
} as const);

function prepareApprovalInternal(
  checkpoint: OperationCheckpoint,
  bindingValue: ApprovalBinding,
  preview: unknown,
  additionalMemory: Readonly<Record<string, unknown>> = {},
  operationHashOverride?: string,
): CoreTransition {
  const binding = assertApprovalBinding(bindingValue);
  const expectedSourceState = APPROVAL_SOURCE_STATE[binding.payload.operationKind];
  const freshlyPlannedWorkflow =
    binding.payload.operationKind === "workflow" &&
    checkpoint.payload.state === "resolving" &&
    additionalMemory.workflowPlan !== undefined;
  const freshlyReviewedAction = binding.payload.method === "tbc_signReviewedTransaction" &&
    checkpoint.payload.state === "resolving" && additionalMemory.walletActionPlan !== undefined;
  if (checkpoint.payload.state !== expectedSourceState && !freshlyPlannedWorkflow && !freshlyReviewedAction) {
    throw new TwsApprovalError(
      "APPROVAL_REQUEST_INVALID",
      `approval for ${binding.payload.operationKind} requires ${expectedSourceState}`,
    );
  }
  const context = checkpoint.payload.context as ApprovalContext;
  const operation = operationOf(checkpoint);
  const operationParams = operation.params as {
    readonly chainId?: string;
    readonly from?: string;
  };
  const prospectiveMemory = {
    ...checkpoint.payload.memory,
    ...additionalMemory,
  };
  const expectedRequestHash = prospectiveMemory.requestHash;
  const expectedOperationHash = operationHashOverride ??
    (prospectiveMemory.walletActionPlan as { readonly planHash?: string } | undefined)?.planHash ??
    (prospectiveMemory.executionPlan as { readonly planHash?: string } | undefined)
      ?.planHash ??
    (prospectiveMemory.permissionProposal as {
      readonly permissionProposalHash?: string;
    } | undefined)?.permissionProposalHash ??
    (prospectiveMemory.chainSwitchProposal as {
      readonly chainSwitchProposalHash?: string;
    } | undefined)?.chainSwitchProposalHash ??
    (prospectiveMemory.workflowPlan as {
      readonly workflowPlanHash?: string;
    } | undefined)?.workflowPlanHash ??
    (prospectiveMemory.messageEnvelope !== undefined
      ? signingEnvelopeDigest(prospectiveMemory.messageEnvelope)
      : prospectiveMemory.typedDataEnvelope !== undefined
        ? signingEnvelopeDigest(prospectiveMemory.typedDataEnvelope)
        : undefined);
  if (
    binding.payload.method !== operation.method ||
    binding.payload.contextHash !== checkpoint.payload.contextHash ||
    binding.payload.origin !== context.origin ||
    binding.payload.sessionId !== context.sessionId ||
    (expectedRequestHash !== undefined &&
      binding.payload.requestHash !== expectedRequestHash) ||
    (expectedOperationHash !== undefined &&
      binding.payload.operationHash !== expectedOperationHash) ||
    (operationParams.chainId !== undefined &&
      binding.payload.chainId !== operationParams.chainId) ||
    (operationParams.from !== undefined &&
      binding.payload.accountId !==
        `${operationParams.chainId}:${operationParams.from}`)
  ) {
    throw new TwsApprovalError(
      "BINDING_EXPECTATION_MISMATCH",
      "approval binding differs from the current operation",
    );
  }
  if (
    expectedRequestHash === undefined &&
    operation.method !== "tbc_requestAccounts" &&
    binding.payload.requestHash !== hashCanonical(operation.params)
  ) {
    throw new TwsApprovalError(
      "BINDING_EXPECTATION_MISMATCH",
      "approval request hash differs from the current operation",
    );
  }
  const expectedPreview =
    (prospectiveMemory.walletActionPlan as { readonly payload?: { readonly preview?: unknown } } | undefined)?.payload?.preview ??
    (prospectiveMemory.executionPlan as {
      readonly payload?: { readonly preview?: unknown };
    } | undefined)?.payload?.preview ??
    (prospectiveMemory.workflowPlan as {
      readonly payload?: { readonly preview?: unknown };
    } | undefined)?.payload?.preview;
  if (
    expectedPreview !== undefined &&
    canonicalize(preview) !== canonicalize(expectedPreview)
  ) {
    throw new TwsApprovalError(
      "PREVIEW_MISMATCH",
      "approval preview differs from the bound operation artifact",
    );
  }
  createApprovalRequest(binding, preview, context);
  const revision = nextRevision(checkpoint);
  const calls = makeCalls(checkpoint, revision, [
    { operation: "clock.now", params: { version: "1.0" } },
  ]);
  const next = advance(checkpoint, {
    state: "approval",
    expiresAt: binding.payload.expiresAt,
    pendingCalls: calls,
    memory: {
      ...prospectiveMemory,
      permissionLoads: prospectiveMemory.permissionLoads ?? [],
      approvalBinding: binding,
      approvalPreview: preview,
    },
    data: { approvalBinding: binding, approvalPreview: preview },
  });
  return waitingTransition(next);
}

export function prepareApproval(
  checkpoint: OperationCheckpoint,
  bindingValue: ApprovalBinding,
  preview: unknown,
): CoreTransition {
  return prepareApprovalInternal(checkpoint, bindingValue, preview);
}

export function prepareApprovalWithMemory(
  checkpoint: OperationCheckpoint,
  bindingValue: ApprovalBinding,
  preview: unknown,
  additionalMemory: Readonly<Record<string, unknown>>,
  operationHashOverride?: string,
): CoreTransition {
  return prepareApprovalInternal(
    checkpoint,
    bindingValue,
    preview,
    additionalMemory,
    operationHashOverride,
  );
}

export function reduceApprovalClock(
  checkpoint: OperationCheckpoint,
  call: PortCall,
  resultValue: unknown,
): CoreTransition {
  if (checkpoint.payload.state !== "approval" || call.operation !== "clock.now") {
    throw new TwsApprovalError(
      "APPROVAL_REQUEST_INVALID",
      "approval clock reducer received the wrong state",
    );
  }
  if (
    !checkpoint.payload.pendingCalls.some(
      (pending) => pending.callId === call.callId,
    )
  ) {
    throw new TwsApprovalError(
      "APPROVAL_REQUEST_INVALID",
      "approval clock call is not pending",
    );
  }
  assertPortResult("clock.now", resultValue);
  const result = resultValue as { readonly now: string };
  if (Date.parse(result.now) >= Date.parse(String(checkpoint.payload.expiresAt))) {
    return completeError(checkpoint, 4100, "Approval expired before review", checkpoint.payload.memory,
      { reason: "RECEIPT_EXPIRED", stage: "approval", operationId: checkpoint.payload.operationId });
  }
  const binding = checkpoint.payload.memory.approvalBinding as ApprovalBinding;
  const preview = checkpoint.payload.memory.approvalPreview;
  const request = createApprovalRequest(
    binding,
    preview,
    checkpoint.payload.context as ApprovalContext,
  );
  assertValidTws("approvalRequestParams", request);
  const revision = nextRevision(checkpoint);
  const calls = makeCalls(checkpoint, revision, [
    { operation: "approval.request", params: request },
  ]);
  const next = advance(checkpoint, {
    state: "approval",
    updatedAt: result.now,
    pendingCalls: calls,
    memory: { ...checkpoint.payload.memory, trustedTime: result.now },
    data: { approvalBinding: binding, approvalPreview: preview },
  });
  return waitingTransition(next);
}

export function readApprovalDecision(
  checkpoint: OperationCheckpoint,
  call: PortCall,
  resultValue: unknown,
): ApprovalDecision {
  if (
    checkpoint.payload.state !== "approval" ||
    call.operation !== "approval.request" ||
    !checkpoint.payload.pendingCalls.some((pending) => pending.callId === call.callId)
  ) {
    throw new TwsApprovalError(
      "APPROVAL_REQUEST_INVALID",
      "approval result does not belong to the pending request",
    );
  }
  assertPortResult("approval.request", resultValue);
  const binding = checkpoint.payload.memory.approvalBinding as ApprovalBinding;
  const expectedRequest = createApprovalRequest(
    binding,
    checkpoint.payload.memory.approvalPreview,
    checkpoint.payload.context as ApprovalContext,
  );
  assertApprovalRequest(call.params, expectedRequest);
  const result = resultValue as {
    readonly status: "approved" | "rejected";
    readonly bindingHash: string;
    readonly rejectedAt?: string;
  };
  if (result.status === "rejected") {
    if (result.bindingHash !== binding.bindingHash || result.rejectedAt === undefined) {
      throw new TwsApprovalError(
        "RECEIPT_BINDING_MISMATCH",
        "approval rejection does not match the binding",
      );
    }
    return Object.freeze({
      status: "rejected",
      bindingHash: result.bindingHash,
      rejectedAt: result.rejectedAt,
    });
  }
  const receipt = assertApprovalReceipt(
    binding,
    resultValue as ApprovalReceipt,
    String(checkpoint.payload.memory.trustedTime),
  );
  if (
    Date.parse(receipt.approvedAt) <
    Date.parse(String(checkpoint.payload.memory.trustedTime))
  ) {
    throw new TwsApprovalError(
      "RECEIPT_TIME_INVALID",
      "approval predates the trusted approval request time",
    );
  }
  return Object.freeze({ status: "approved", receipt });
}
