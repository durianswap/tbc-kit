import { assertWalletActionApproval, reduceWalletActionApproval, reduceWalletActionResult } from "./reducers/wallet-actions.js";
import {
  assertAuthorityUnchanged,
  assertProviderCommitAcknowledgment,
  classifyAuthorityChange,
  validateAuthoritySnapshot,
} from "./authority.js";
import { canonicalize } from "./canonical-json.js";
import {
  type CancellationReason,
  cancellationPolicy,
  isCancelAuthorityOptional,
  providerCompletionForCancellation,
} from "./cancellation.js";
import {
  type OperationCheckpoint,
  type OperationCheckpointPayload,
  advanceCheckpoint,
  createCheckpoint,
  verifyCheckpoint,
} from "./checkpoint.js";
import { TwsStateError } from "./errors.js";
import {
  assertTransactionEngine,
  normalizeCapabilityConfiguration,
  type LegacyBitcoinMessageDigest,
  type TransactionEngine,
  type TwsCapabilityConfiguration,
  type TwsCoreDependencies,
} from "./engine.js";
import { hashCanonical } from "./hash.js";
import { deriveOperationId } from "./identifiers.js";
import { createPortCall, type PortResponse } from "./ports.js";
import type {
  CancelInput,
  CommitAckInput,
  ResumeInput,
  StartInput,
} from "./protocol-types.js";
import { reduceAuthorizingResponse } from "./reducers/authorizing.js";
import { reduceApprovalClock } from "./reducers/approval.js";
import {
  reduceAmbiguousBroadcast,
  reduceBroadcastClock,
  reduceBroadcastResponse,
  reduceReconciliationResponse,
  reduceWorkflowBatchResponse,
} from "./reducers/broadcasting.js";
import {
  assertProviderSessionMutation,
  assertChainSwitchApprovalArtifacts,
  reduceCommitClock,
  reducePermissionCommit,
  reduceSwitchApproval,
} from "./reducers/committing.js";
import {
  assertPermissionApprovalArtifacts,
  reducePermissionApproval,
} from "./reducers/permissions.js";
import {
  reduceFinalizing,
  reduceFinalizingClock,
} from "./reducers/finalizing.js";
import { reducePlanning } from "./reducers/planning.js";
import {
  assertMessageApprovalArtifacts,
  reduceMessageApproval,
  reduceMessageSigningResponse,
} from "./reducers/messages.js";
import { reduceResolvingResponse } from "./reducers/resolving.js";
import {
  reduceSigningClock,
  reduceSigningResponse,
  reduceTransactionApproval,
} from "./reducers/signing.js";
import { reduceValidating } from "./reducers/validating.js";
import {
  assertWorkflowApprovalArtifacts,
  reduceWorkflowApproval,
  reduceWorkflowFinalizing,
  reduceWorkflowPlanning,
  reduceWorkflowSigningResponse,
  reduceWorkflowCryptoResponse,
  reduceWorkflowReviewedTransactionResponse,
  reduceWorkflowPortFailure,
} from "./reducers/workflows.js";
import { TWS_RELEASE, TWS_RELEASE_FINGERPRINT } from "./release.js";
import {
  type CoreTransition,
  completeTransition,
  continueTransition,
  waitingTransition,
} from "./transitions.js";
import { assertPortResult, assertValidTws } from "./validation.js";

const TERMINAL_STATES = new Set(["completed", "rejected", "failed", "cancelled"]);
const AUTHORITY_CHANGE_REASONS = new Set<CancellationReason>([
  "SESSION_REVOKED",
  "NAVIGATION_CHANGED",
  "ORIGIN_CHANGED",
  "CHAIN_CHANGED",
  "ACCOUNT_CHANGED",
]);

interface StartInputRecord {
  readonly version: "1.0";
  readonly release: typeof TWS_RELEASE;
  readonly request: {
    readonly id: unknown;
    readonly method: string;
    readonly params?: unknown;
  };
  readonly currentContext: unknown;
  readonly currentSession: unknown;
}

interface ResumeInputRecord {
  readonly checkpoint: OperationCheckpoint;
  readonly response?: PortResponse;
  readonly currentContext: unknown;
  readonly currentSession: unknown;
}

interface CommitAckInputRecord {
  readonly checkpoint: OperationCheckpoint;
  readonly acknowledgment: unknown;
  readonly currentContext: unknown;
  readonly currentSession: unknown;
}

interface CancelInputRecord {
  readonly checkpoint: OperationCheckpoint;
  readonly reason: CancellationReason;
  readonly currentContext?: unknown;
  readonly currentSession?: unknown;
}

export interface TwsCore {
  readonly start: (input: StartInput) => Promise<CoreTransition>;
  readonly resume: (input: ResumeInput) => Promise<CoreTransition>;
  readonly acknowledgeCommit: (input: CommitAckInput) => Promise<CoreTransition>;
  readonly cancel: (input: CancelInput) => Promise<CoreTransition>;
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalize(left) === canonicalize(right);
}

function normalizeOperation(request: StartInputRecord["request"]): {
  readonly method: string;
  readonly params: unknown;
} {
  return Object.freeze({
    method: request.method,
    params: request.params === undefined ? [] : request.params,
  });
}

function addWholeSeconds(timestamp: string, seconds: number): string {
  const milliseconds = Date.parse(timestamp) + seconds * 1000;
  return new Date(milliseconds).toISOString();
}

function assertNotTerminal(checkpoint: OperationCheckpoint): void {
  if (TERMINAL_STATES.has(String(checkpoint.payload.state))) {
    throw new TwsStateError("TERMINAL_STATE", "terminal checkpoint cannot advance");
  }
}

function failureCompletion(
  checkpoint: OperationCheckpoint,
  message: string,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    delivery: "respond",
    response: {
      jsonrpc: "2.0",
      id: checkpoint.payload.requestId,
      error: { code: -32603, message },
    },
    events: [],
  });
}

function failFromPort(
  checkpoint: OperationCheckpoint,
  operation: string,
): CoreTransition {
  const providerError = {
    code: -32603,
    message: `Required Host Port failed: ${operation}`,
  };
  const nextPayload = {
    ...checkpoint.payload,
    revision: String(BigInt(checkpoint.payload.revision) + 1n),
    previousCheckpointHash: checkpoint.checkpointHash,
    state: "failed",
    pendingCalls: [],
    data: { providerError },
  } as OperationCheckpointPayload;
  const next = advanceCheckpoint(checkpoint, nextPayload);
  return completeTransition(next, failureCompletion(next, providerError.message));
}

function resumeClock(
  checkpoint: OperationCheckpoint,
  response: PortResponse,
): CoreTransition {
  const result = response.result as { readonly now: string };
  const observedAt = Date.parse(result.now);
  if (!Number.isFinite(observedAt)) {
    throw new TwsStateError("PORT_RESULT_INVALID", "clock.now returned invalid time");
  }
  const nextPayload = {
    ...checkpoint.payload,
    revision: String(BigInt(checkpoint.payload.revision) + 1n),
    previousCheckpointHash: checkpoint.checkpointHash,
    state: "validating",
    createdAt: result.now,
    updatedAt: result.now,
    expiresAt: addWholeSeconds(result.now, 5 * 60),
    pendingCalls: [],
    memory: { trustedTime: result.now },
    data: { trustedTime: result.now },
  } as OperationCheckpointPayload;
  return continueTransition(advanceCheckpoint(checkpoint, nextPayload));
}

async function start(inputValue: unknown): Promise<CoreTransition> {
  assertValidTws("startInput", inputValue);
  const input = inputValue as StartInputRecord;
  if (!sameJson(input.release, TWS_RELEASE)) {
    throw new TwsStateError(
      "PROTOCOL_RELEASE_MISMATCH",
      "start release differs from the loaded Core release",
    );
  }
  validateAuthoritySnapshot(input.currentContext, input.currentSession);
  const contextHash = hashCanonical(input.currentContext);
  const operation = normalizeOperation(input.request);
  const operationId = deriveOperationId({
    releaseFingerprint: TWS_RELEASE_FINGERPRINT,
    contextHash,
    requestId: input.request.id,
    operation,
  });
  const call = createPortCall({
    operationId,
    checkpointRevision: "0",
    effectOrdinal: 0,
    operation: "clock.now",
    params: { version: "1.0" },
  });
  const checkpoint = createCheckpoint({
    version: "1.0",
    release: TWS_RELEASE,
    releaseFingerprint: TWS_RELEASE_FINGERPRINT,
    operationId,
    revision: "0",
    state: "initializing",
    requestId: input.request.id,
    operation,
    context: input.currentContext,
    contextHash,
    session: input.currentSession,
    pendingCalls: [call],
    memory: {},
    data: {},
  } as OperationCheckpointPayload);
  return waitingTransition(checkpoint);
}

async function resume(
  inputValue: unknown,
  transactionEngine?: TransactionEngine,
  legacyBitcoinMessageDigest?: LegacyBitcoinMessageDigest,
  capabilityConfiguration?: TwsCapabilityConfiguration,
): Promise<CoreTransition> {
  assertValidTws("resumeInput", inputValue);
  const input = inputValue as ResumeInputRecord;
  const checkpoint = verifyCheckpoint(input.checkpoint);
  assertNotTerminal(checkpoint);
  assertAuthorityUnchanged(
    checkpoint.payload.context,
    checkpoint.payload.session,
    input.currentContext,
    input.currentSession,
  );
  const response = input.response;
  if (checkpoint.payload.pendingCalls.length === 0) {
    if (checkpoint.payload.state === "validating") {
      return reduceValidating(checkpoint);
    }
    if (checkpoint.payload.state === "planning") {
      if (checkpoint.payload.memory.workflowPlan !== undefined) {
        return reduceWorkflowPlanning(checkpoint);
      }
      return reducePlanning(checkpoint, transactionEngine);
    }
    if (checkpoint.payload.state === "finalizing") {
      if (checkpoint.payload.memory.workflowPlan !== undefined) {
        return reduceWorkflowFinalizing(
          checkpoint,
          transactionEngine,
          legacyBitcoinMessageDigest,
        );
      }
      return reduceFinalizing(checkpoint, transactionEngine);
    }
    throw new TwsStateError(
      "STATE_HANDLER_NOT_IMPLEMENTED",
      `state handler is not implemented: ${String(checkpoint.payload.state)}`,
    );
  }
  const call = checkpoint.payload.pendingCalls.find(
    (candidate) => candidate.callId === response?.callId,
  );
  if (!call || !response) {
    throw new TwsStateError(
      "PORT_RESPONSE_NOT_PENDING",
      "Port response does not belong to the current checkpoint",
    );
  }
  if (response.error !== undefined) {
    if (
      checkpoint.payload.state === "broadcasting" &&
      (call.operation === "broadcast.submit" || call.operation === "broadcast.submitBatch")
    ) {
      return reduceAmbiguousBroadcast(checkpoint, call, response.error);
    }
    if (
      checkpoint.payload.memory.workflowPlan !== undefined &&
      checkpoint.payload.state === "signing" &&
      new Set(["signer.sign", "crypto.execute", "reviewedTransaction.execute"]).has(
        call.operation,
      ) &&
      (checkpoint.payload.memory.workflowPlan as {
        readonly payload?: { readonly failureMode?: unknown };
      }).payload?.failureMode === "continue-independent"
    ) {
      return reduceWorkflowPortFailure(
        checkpoint,
        call,
        response.error,
        legacyBitcoinMessageDigest,
      );
    }
    return failFromPort(checkpoint, call.operation);
  }
  assertPortResult(call.operation, response.result);
  if (checkpoint.payload.memory.walletActionPlan !== undefined) {
    assertWalletActionApproval(checkpoint);
    if (checkpoint.payload.state === "approval" && call.operation === "approval.request") {
      return reduceWalletActionApproval(checkpoint, call, response.result);
    }
    if (checkpoint.payload.state === "signing" && (call.operation === "crypto.execute" || call.operation === "reviewedTransaction.execute")) {
      return reduceWalletActionResult(checkpoint, call, response.result);
    }
  }
  if (checkpoint.payload.state === "initializing" && call.operation === "clock.now") {
    return resumeClock(checkpoint, response);
  }
  if (
    checkpoint.payload.state === "authorizing" &&
    call.operation === "permissionStore.load"
  ) {
    return reduceAuthorizingResponse(
      checkpoint,
      call,
      response.result,
      transactionEngine,
      capabilityConfiguration,
    );
  }
  if (
    checkpoint.payload.state === "resolving" &&
    new Set([
      "accounts.resolve",
      "chainData.resolve",
      "policy.resolve",
      "reviewedTransaction.review",
      "entropy.randomBytes",
    ]).has(
      call.operation,
    )
  ) {
    return reduceResolvingResponse(
      checkpoint,
      call,
      response.result,
      transactionEngine,
      legacyBitcoinMessageDigest,
      capabilityConfiguration,
    );
  }
  if (
    checkpoint.payload.state === "committing" &&
    call.operation === "clock.now"
  ) {
    return reduceCommitClock(checkpoint, call, response.result);
  }
  if (
    checkpoint.payload.state === "approval" &&
    call.operation === "clock.now"
  ) {
    if (checkpoint.payload.memory.permissionProposal !== undefined) {
      assertPermissionApprovalArtifacts(checkpoint);
    }
    if (checkpoint.payload.memory.chainSwitchProposal !== undefined) {
      assertChainSwitchApprovalArtifacts(checkpoint);
    }
    if (
      checkpoint.payload.memory.messageEnvelope !== undefined ||
      checkpoint.payload.memory.typedDataEnvelope !== undefined
    ) {
      assertMessageApprovalArtifacts(checkpoint);
    }
    if (checkpoint.payload.memory.workflowPlan !== undefined) {
      assertWorkflowApprovalArtifacts(checkpoint);
    }
    return reduceApprovalClock(checkpoint, call, response.result);
  }
  if (
    checkpoint.payload.state === "approval" &&
    call.operation === "approval.request" &&
    checkpoint.payload.memory.permissionProposal !== undefined
  ) {
    return reducePermissionApproval(checkpoint, call, response.result);
  }
  if (
    checkpoint.payload.state === "approval" &&
    call.operation === "approval.request" &&
    checkpoint.payload.memory.chainSwitchProposal !== undefined
  ) {
    return reduceSwitchApproval(checkpoint, call, response.result);
  }
  if (
    checkpoint.payload.state === "approval" &&
    call.operation === "approval.request" &&
    (checkpoint.payload.memory.messageEnvelope !== undefined ||
      checkpoint.payload.memory.typedDataEnvelope !== undefined)
  ) {
    return reduceMessageApproval(checkpoint, call, response.result);
  }
  if (
    checkpoint.payload.state === "approval" &&
    call.operation === "approval.request" &&
    checkpoint.payload.memory.workflowPlan !== undefined
  ) {
    return reduceWorkflowApproval(
      checkpoint,
      call,
      response.result,
      transactionEngine,
      legacyBitcoinMessageDigest,
    );
  }
  if (
    checkpoint.payload.state === "approval" &&
    call.operation === "approval.request" &&
    checkpoint.payload.memory.executionPlan !== undefined
  ) {
    return reduceTransactionApproval(
      checkpoint,
      call,
      response.result,
      transactionEngine,
    );
  }
  if (checkpoint.payload.state === "signing" && call.operation === "clock.now") {
    if (checkpoint.payload.memory.workflowPlan !== undefined) {
      assertWorkflowApprovalArtifacts(checkpoint);
    }
    return reduceSigningClock(checkpoint, call, response.result);
  }
  if (
    checkpoint.payload.state === "signing" &&
    call.operation === "signer.sign" &&
    checkpoint.payload.memory.workflowPlan !== undefined
  ) {
    return reduceWorkflowSigningResponse(
      checkpoint,
      call,
      response.result,
      legacyBitcoinMessageDigest,
    );
  }
  if (
    checkpoint.payload.state === "signing" &&
    call.operation === "crypto.execute" &&
    checkpoint.payload.memory.workflowPlan !== undefined
  ) {
    return reduceWorkflowCryptoResponse(
      checkpoint,
      call,
      response.result,
      legacyBitcoinMessageDigest,
    );
  }
  if (
    checkpoint.payload.state === "signing" &&
    call.operation === "reviewedTransaction.execute" &&
    checkpoint.payload.memory.workflowPlan !== undefined
  ) {
    return reduceWorkflowReviewedTransactionResponse(
      checkpoint,
      call,
      response.result,
      legacyBitcoinMessageDigest,
    );
  }
  if (
    checkpoint.payload.state === "signing" &&
    call.operation === "signer.sign" &&
    (checkpoint.payload.memory.messageEnvelope !== undefined ||
      checkpoint.payload.memory.typedDataEnvelope !== undefined)
  ) {
    return reduceMessageSigningResponse(checkpoint, call, response.result);
  }
  if (checkpoint.payload.state === "signing" && call.operation === "signer.sign") {
    return reduceSigningResponse(checkpoint, call, response.result);
  }
  if (
    checkpoint.payload.state === "finalizing" &&
    call.operation === "clock.now"
  ) {
    if (checkpoint.payload.memory.workflowPlan !== undefined) {
      assertWorkflowApprovalArtifacts(checkpoint);
    }
    return reduceFinalizingClock(checkpoint, call, response.result);
  }
  if (
    checkpoint.payload.state === "broadcasting" &&
    call.operation === "clock.now"
  ) {
    return reduceBroadcastClock(checkpoint, call, response.result);
  }
  if (
    checkpoint.payload.state === "broadcasting" &&
    call.operation === "broadcast.submit"
  ) {
    return reduceBroadcastResponse(checkpoint, call, response.result);
  }
  if (
    checkpoint.payload.state === "broadcasting" &&
    call.operation === "broadcast.submitBatch"
  ) {
    return reduceWorkflowBatchResponse(checkpoint, call, response.result);
  }
  if (
    checkpoint.payload.state === "reconciliation" &&
    call.operation === "broadcast.reconcile"
  ) {
    return reduceReconciliationResponse(checkpoint, call, response.result);
  }
  if (
    checkpoint.payload.state === "committing" &&
    call.operation === "permissionStore.commit"
  ) {
    return reducePermissionCommit(checkpoint, call, response.result);
  }
  throw new TwsStateError(
    "STATE_HANDLER_NOT_IMPLEMENTED",
    `state handler is not implemented: ${String(checkpoint.payload.state)}`,
  );
}

async function acknowledgeCommit(inputValue: unknown): Promise<CoreTransition> {
  assertValidTws("commitAckInput", inputValue);
  const input = inputValue as CommitAckInputRecord;
  const checkpoint = verifyCheckpoint(input.checkpoint);
  assertNotTerminal(checkpoint);
  if (
    checkpoint.payload.state !== "committing" ||
    (checkpoint.payload.data as { kind?: unknown }).kind !== "provider-session"
  ) {
    throw new TwsStateError(
      "STATE_MISMATCH",
      "acknowledgeCommit requires provider-session committing",
    );
  }
  if (hashCanonical(input.currentContext) !== checkpoint.payload.contextHash) {
    throw new TwsStateError("STATE_MISMATCH", "commit context changed");
  }
  validateAuthoritySnapshot(input.currentContext, input.currentSession);
  const mutation = assertProviderSessionMutation(checkpoint);
  assertProviderCommitAcknowledgment(
    mutation,
    input.acknowledgment,
    input.currentSession,
  );
  const completion = {
    delivery: "respond",
    response: {
      jsonrpc: "2.0",
      id: checkpoint.payload.requestId,
      result: null,
    },
    events: (mutation.payload as { events: unknown }).events,
  };
  const nextPayload = {
    ...checkpoint.payload,
    revision: String(BigInt(checkpoint.payload.revision) + 1n),
    previousCheckpointHash: checkpoint.checkpointHash,
    state: "completed",
    pendingCalls: [],
    memory: {
      ...checkpoint.payload.memory,
      providerSessionCommitAck: input.acknowledgment,
      providerCompletion: completion,
    },
    data: { providerCompletion: completion },
  } as OperationCheckpointPayload;
  const next = advanceCheckpoint(checkpoint, nextPayload);
  return completeTransition(next, completion);
}

async function cancel(inputValue: unknown): Promise<CoreTransition> {
  assertValidTws("cancelInput", inputValue);
  const input = inputValue as CancelInputRecord;
  const checkpointRelease = input.checkpoint.payload.release;
  const checkpoint = verifyCheckpoint(
    input.checkpoint,
    input.reason === "PROTOCOL_RELEASE_CHANGED"
      ? checkpointRelease
      : TWS_RELEASE,
  );
  assertNotTerminal(checkpoint);
  if (
    input.reason === "PROTOCOL_RELEASE_CHANGED" &&
    sameJson(checkpointRelease, TWS_RELEASE)
  ) {
    throw new TwsStateError(
      "CANCEL_REASON_NOT_PROVEN",
      "loaded protocol release did not change",
    );
  }

  const hasAuthority =
    input.currentContext !== undefined && input.currentSession !== undefined;
  if (!hasAuthority && !isCancelAuthorityOptional(input.reason)) {
    throw new TwsStateError(
      "CANCEL_REASON_NOT_PROVEN",
      "cancellation reason requires current authority",
    );
  }
  if (hasAuthority) {
    const actual = classifyAuthorityChange(
      checkpoint.payload.context,
      checkpoint.payload.session,
      input.currentContext,
      input.currentSession,
    );
    if (AUTHORITY_CHANGE_REASONS.has(input.reason)) {
      if (actual !== input.reason) {
        throw new TwsStateError(
          "CANCEL_REASON_NOT_PROVEN",
          `current authority proves ${String(actual)}, not ${input.reason}`,
        );
      }
    } else if (actual !== null) {
      throw new TwsStateError(
        "CANCEL_REASON_NOT_PROVEN",
        `unrelated authority change: ${actual}`,
      );
    }
  }

  const channelReachable =
    hasAuthority &&
    !new Set<CancellationReason>([
      "REQUEST_ABORTED",
      "TRANSPORT_CLOSED",
      "NAVIGATION_CHANGED",
      "ORIGIN_CHANGED",
    ]).has(input.reason);
  const policy = cancellationPolicy(input.reason, channelReachable);
  const completion = providerCompletionForCancellation(
    input.reason,
    checkpoint.payload.requestId,
    channelReachable,
  );
  const preClock = checkpoint.payload.state === "initializing";
  const response = (completion as { response?: { error?: unknown } }).response;
  const data =
    policy.terminalState === "failed"
      ? { providerError: response?.error ?? { code: -32603, message: "Request failed" } }
      : { cancellationReason: input.reason };
  const nextPayload = {
    ...checkpoint.payload,
    revision: String(BigInt(checkpoint.payload.revision) + 1n),
    previousCheckpointHash: checkpoint.checkpointHash,
    state: policy.terminalState,
    pendingCalls: [],
    memory: preClock
      ? {}
      : { ...checkpoint.payload.memory, providerCompletion: completion },
    data,
  } as OperationCheckpointPayload;
  const next = advanceCheckpoint(checkpoint, nextPayload, checkpointRelease);
  return completeTransition(next, completion);
}

export function createTwsCore(
  dependencies: TwsCoreDependencies = {},
): TwsCore {
  if (
    dependencies === null ||
    typeof dependencies !== "object" ||
    Array.isArray(dependencies) ||
    Reflect.ownKeys(dependencies).some(
      (key) =>
        key !== "transactionEngine" &&
        key !== "legacyBitcoinMessageDigest" &&
        key !== "capabilities",
    )
  ) {
    throw new TypeError("Core dependencies contain an unknown capability");
  }
  const transactionEngine =
    dependencies.transactionEngine === undefined
      ? undefined
      : assertTransactionEngine(dependencies.transactionEngine);
  const legacyBitcoinMessageDigest = dependencies.legacyBitcoinMessageDigest;
  if (
    legacyBitcoinMessageDigest !== undefined &&
    typeof legacyBitcoinMessageDigest !== "function"
  ) {
    throw new TypeError(
      "Legacy Bitcoin message digest capability must be a function",
    );
  }
  const capabilityConfiguration = normalizeCapabilityConfiguration(
    dependencies.capabilities,
  );
  return Object.freeze({
    start: (input: StartInput) => start(input),
    resume: (input: ResumeInput) =>
      resume(
        input,
        transactionEngine,
        legacyBitcoinMessageDigest,
        capabilityConfiguration,
      ),
    acknowledgeCommit: (input: CommitAckInput) => acknowledgeCommit(input),
    cancel: (input: CancelInput) => cancel(input),
  });
}
