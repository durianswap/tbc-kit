import type { OperationCheckpoint } from "../checkpoint.js";
import { TwsStateError } from "../errors.js";
import { deriveBroadcastIdempotencyKey } from "../identifiers.js";
import { hashCanonical } from "../hash.js";
import type { PortCall } from "../ports.js";
import type { CoreTransition } from "../transitions.js";
import { waitingTransition } from "../transitions.js";
import { assertValidTws } from "../validation.js";
import {
  advance,
  completeError,
  completeSuccess,
  makeCalls,
  nextRevision,
  operationOf,
} from "./shared.js";

interface SignedTransaction {
  readonly id: string;
  readonly txid: string;
  readonly rawTransaction: string;
  readonly role: string;
  readonly dependsOn: readonly string[];
}

interface SignedBundle {
  readonly transactions: readonly SignedTransaction[];
  readonly [key: string]: unknown;
}

interface BroadcastProgress {
  readonly attempts: readonly unknown[];
  readonly submittedTransactionIds: readonly string[];
  readonly nextTransactionId?: string;
  readonly reconciliationAttempts: number;
}

function bundle(checkpoint: OperationCheckpoint): SignedBundle {
  return checkpoint.payload.memory.finalizedBundle as SignedBundle;
}

function progress(checkpoint: OperationCheckpoint): BroadcastProgress {
  return checkpoint.payload.memory.broadcastProgress as BroadcastProgress;
}

function assertSendTransaction(checkpoint: OperationCheckpoint): void {
  const method = operationOf(checkpoint).method;
  if (
    method !== "tbc_sendTransaction" &&
    method !== "tbc_sendPreparedTransaction" &&
    method !== "tbc_sendWorkflow" &&
    method !== "tbc_sendPreparedWorkflow"
  ) {
    throw new TwsStateError(
      "STATE_MISMATCH",
      "broadcast states are reserved for send transaction methods",
    );
  }
}

function isSendWorkflow(checkpoint: OperationCheckpoint): boolean {
  const method = operationOf(checkpoint).method;
  return method === "tbc_sendWorkflow" || method === "tbc_sendPreparedWorkflow";
}

/** Public, non-secret progress for a terminal send error; never infer acceptance
 * from dispatch alone. Reuses the authenticated checkpoint, without new reads. */
function broadcastFailureData(checkpoint: OperationCheckpoint, reason: string, rejectedTxid?: string,
  memory: Readonly<Record<string, unknown>> = checkpoint.payload.memory): Readonly<Record<string, unknown>> {
  const recorded = memory.broadcastProgress as { attempts?: readonly { params?: { transaction?: { txid?: string } }; result?: { txid?: string; status?: string } }[];
    reconciliation?: { transactions?: readonly { txid: string; status: string }[] } } | undefined;
  const accepted = new Set<string>(), uncertain = new Set<string>(), rejected = new Set<string>();
  for (const attempt of recorded?.attempts ?? []) {
    const id = attempt.params?.transaction?.txid;
    if (!id) continue;
    if (attempt.result?.txid === id && ["accepted", "known"].includes(attempt.result.status ?? "")) accepted.add(id);
    else uncertain.add(id);
  }
  for (const tx of recorded?.reconciliation?.transactions ?? []) {
    if (tx.status === "mempool" || tx.status === "confirmed") { accepted.add(tx.txid); uncertain.delete(tx.txid); }
    if (tx.status === "rejected") { rejected.add(tx.txid); uncertain.delete(tx.txid); }
  }
  if (rejectedTxid) { rejected.add(rejectedTxid); uncertain.delete(rejectedTxid); }
  const ids = bundle(checkpoint).transactions.map(t => t.txid);
  return { reason, operationId: checkpoint.payload.operationId,
    submittedTransactionIds: ids.filter(id => accepted.has(id)),
    uncertainTransactionIds: ids.filter(id => uncertain.has(id)),
    rejectedTransactionIds: ids.filter(id => rejected.has(id)),
    notSubmittedTransactionIds: ids.filter(id => !accepted.has(id) && !uncertain.has(id) && !rejected.has(id)) };
}

function waitForBroadcastClock(
  checkpoint: OperationCheckpoint,
  memory: Readonly<Record<string, unknown>>,
): CoreTransition {
  const revision = nextRevision(checkpoint);
  const calls = makeCalls(checkpoint, revision, [
    { operation: "clock.now", params: { version: "1.0" } },
  ]);
  const next = advance(checkpoint, {
    state: "broadcasting",
    pendingCalls: calls,
    memory,
    data: { finalizedBundle: checkpoint.payload.memory.finalizedBundle },
  });
  return waitingTransition(next);
}

function submitCall(
  checkpoint: OperationCheckpoint,
  transaction: SignedTransaction,
  memory: Readonly<Record<string, unknown>> = checkpoint.payload.memory,
  updatedAt?: string,
): CoreTransition {
  const params = {
    version: "1.0",
    chainId: (checkpoint.payload.memory.finalizedBundle as { readonly chainId: string })
      .chainId,
    transaction,
    idempotencyKey: deriveBroadcastIdempotencyKey({
      operationId: checkpoint.payload.operationId,
      txid: transaction.txid,
    }),
  };
  const revision = nextRevision(checkpoint);
  const calls = makeCalls(checkpoint, revision, [
    { operation: "broadcast.submit", params },
  ]);
  const next = advance(checkpoint, {
    state: "broadcasting",
    ...(updatedAt === undefined ? {} : { updatedAt }),
    pendingCalls: calls,
    memory,
    data: { finalizedBundle: checkpoint.payload.memory.finalizedBundle },
  });
  return waitingTransition(next);
}

export function reduceBroadcastClock(
  checkpoint: OperationCheckpoint,
  call: PortCall,
  resultValue: unknown,
): CoreTransition {
  assertSendTransaction(checkpoint);
  if (call.operation !== "clock.now") {
    throw new TwsStateError(
      "PORT_RESULT_INVALID",
      "broadcast freshness check requires clock.now",
    );
  }
  const result = resultValue as { readonly now: string };
  if (Date.parse(result.now) >= Date.parse(String(checkpoint.payload.expiresAt))) {
    return completeError(checkpoint, 4100, "Approval expired before broadcast", checkpoint.payload.memory,
      broadcastFailureData(checkpoint, "RECEIPT_EXPIRED"));
  }
  const transactions = bundle(checkpoint).transactions;
  if (isSendWorkflow(checkpoint)) {
    const params = {
      version: "1.0" as const,
      chainId: (checkpoint.payload.memory.finalizedBundle as { readonly chainId: string }).chainId,
      transactions,
      idempotencyKey: deriveBroadcastIdempotencyKey({
        operationId: checkpoint.payload.operationId,
        txid: hashCanonical(transactions.map(({ txid }) => txid)),
      }),
    };
    const revision = nextRevision(checkpoint);
    const calls = makeCalls(checkpoint, revision, [
      { operation: "broadcast.submitBatch", params },
    ]);
    const next = advance(checkpoint, {
      state: "broadcasting",
      updatedAt: result.now,
      pendingCalls: calls,
      memory: { ...checkpoint.payload.memory, trustedTime: result.now },
      data: { finalizedBundle: checkpoint.payload.memory.finalizedBundle },
    });
    return waitingTransition(next);
  }
  const nextTransaction = transactions.find(
    (transaction) => !progress(checkpoint).submittedTransactionIds.includes(transaction.txid),
  );
  if (nextTransaction === undefined) {
    throw new TwsStateError(
      "PORT_RESULT_INVALID",
      "broadcast checkpoint has no transaction to submit",
    );
  }
  return submitCall(
    checkpoint,
    nextTransaction,
    { ...checkpoint.payload.memory, trustedTime: result.now },
    result.now,
  );
}

function completeWorkflowBatch(
  checkpoint: OperationCheckpoint,
  transactions: readonly Readonly<{
    readonly txid: string;
    readonly status: "accepted" | "known" | "rejected" | "unknown";
    readonly reason?: string;
  }>[],
): CoreTransition {
  const signed = bundle(checkpoint).transactions;
  if (
    transactions.length !== signed.length ||
    transactions.some((item, index) => item.txid !== signed[index]?.txid)
  ) {
    throw new TwsStateError(
      "PORT_RESULT_INVALID",
      "batch broadcast result differs from the ordered signed transactions",
    );
  }
  const statusByTemplateId = new Map<string, "accepted" | "known" | "rejected" | "unknown">();
  const safe = Object.freeze(transactions.map((item, index) => {
    const transaction = signed[index]!;
    const blocked = transaction.dependsOn.some((dependency) => {
      const status = statusByTemplateId.get(dependency);
      return status === "rejected" || status === "unknown";
    });
    const normalized = blocked && (item.status === "accepted" || item.status === "known")
      ? Object.freeze({
          txid: item.txid,
          status: "unknown" as const,
          reason: "A prerequisite transaction was not accepted",
        })
      : Object.freeze({ ...item });
    statusByTemplateId.set(transaction.id, normalized.status);
    return normalized;
  }));
  const statuses = new Set(safe.map(({ status }) => status));
  const status = safe.every(({ status: item }) => item === "accepted" || item === "known")
    ? "complete" as const
    : statuses.size === 1 && statuses.has("rejected")
      ? "rejected" as const
      : statuses.size === 1 && statuses.has("unknown")
        ? "unknown" as const
        : "partial" as const;
  return completeSuccess(checkpoint, Object.freeze({
    version: "1.0" as const,
    status,
    workflow: checkpoint.payload.memory.workflowResult,
    transactions: safe,
  }));
}

export function reduceWorkflowBatchResponse(
  checkpoint: OperationCheckpoint,
  call: PortCall,
  resultValue: unknown,
): CoreTransition {
  assertSendTransaction(checkpoint);
  if (!isSendWorkflow(checkpoint) || call.operation !== "broadcast.submitBatch") {
    throw new TwsStateError(
      "PORT_RESULT_INVALID",
      "workflow batch reducer requires broadcast.submitBatch",
    );
  }
  const result = resultValue as {
    readonly transactions: readonly Readonly<{
      readonly txid: string;
      readonly status: "accepted" | "known" | "rejected" | "unknown";
      readonly reason?: string;
    }>[];
  };
  return completeWorkflowBatch(checkpoint, result.transactions);
}

export function reduceWorkflowBatchFailure(
  checkpoint: OperationCheckpoint,
  call: PortCall,
  errorValue: unknown,
): CoreTransition {
  if (!isSendWorkflow(checkpoint) || call.operation !== "broadcast.submitBatch") {
    throw new TwsStateError("PORT_RESULT_INVALID", "workflow batch failure is not applicable");
  }
  const error = errorValue as { readonly name?: string; readonly retryable?: boolean };
  if (
    error.retryable !== true ||
    (error.name !== "UNAVAILABLE" && error.name !== "INTERNAL_ERROR")
  ) {
    return completeError(checkpoint, -32603, "TBC batch broadcast failed");
  }
  return completeWorkflowBatch(
    checkpoint,
    bundle(checkpoint).transactions.map(({ txid }) => Object.freeze({
      txid,
      status: "unknown" as const,
      reason: "Submission outcome is unknown; query status without resending",
    })),
  );
}

function submittedBundle(
  checkpoint: OperationCheckpoint,
  submittedIds: readonly string[] = progress(checkpoint).submittedTransactionIds,
): Readonly<Record<string, unknown>> {
  const signed = bundle(checkpoint);
  if (
    signed.transactions.some(
      (transaction) => !submittedIds.includes(transaction.txid),
    )
  ) {
    throw new TwsStateError(
      "STATE_MISMATCH",
      "a submitted bundle cannot include an unsubmitted transaction",
    );
  }
  const result = {
    ...signed,
    transactions: signed.transactions.map((transaction) => ({
      id: transaction.id,
      txid: transaction.txid,
      status: "submitted",
      role: transaction.role,
      dependsOn: transaction.dependsOn,
    })),
  };
  assertValidTws("submittedTransactionBundle", result);
  return result;
}

export function reduceBroadcastResponse(
  checkpoint: OperationCheckpoint,
  call: PortCall,
  resultValue: unknown,
): CoreTransition {
  assertSendTransaction(checkpoint);
  if (call.operation !== "broadcast.submit") {
    throw new TwsStateError(
      "PORT_RESULT_INVALID",
      "broadcast reducer requires broadcast.submit",
    );
  }
  const params = call.params as { readonly transaction: SignedTransaction };
  const result = resultValue as {
    readonly txid: string;
    readonly status: "accepted" | "known" | "rejected";
  };
  if (result.txid !== params.transaction.txid) {
    throw new TwsStateError(
      "PORT_RESULT_INVALID",
      "broadcast result txid differs from the submitted transaction",
    );
  }
  if (result.status === "rejected") {
    return completeError(checkpoint, -32603, "TBC transaction broadcast was rejected", checkpoint.payload.memory,
      broadcastFailureData(checkpoint, "BROADCAST_REJECTED", result.txid));
  }
  const previous = progress(checkpoint);
  const submittedTransactionIds = Object.freeze([
    ...previous.submittedTransactionIds,
    result.txid,
  ]);
  const attempts = Object.freeze([
    ...previous.attempts,
    { params: call.params, result: resultValue },
  ]);
  const nextTransaction = bundle(checkpoint).transactions.find(
    (transaction) => !submittedTransactionIds.includes(transaction.txid),
  );
  const broadcastProgress = Object.freeze({
    ...previous,
    attempts,
    submittedTransactionIds,
  });
  const memory = { ...checkpoint.payload.memory, broadcastProgress };
  if (nextTransaction !== undefined) {
    return waitForBroadcastClock(checkpoint, memory);
  }
  return completeSuccess(
    checkpoint,
    submittedBundle(checkpoint, submittedTransactionIds),
    memory,
  );
}

export function reduceAmbiguousBroadcast(
  checkpoint: OperationCheckpoint,
  call: PortCall,
  errorValue: unknown,
): CoreTransition {
  if (call.operation === "broadcast.submitBatch") {
    return reduceWorkflowBatchFailure(checkpoint, call, errorValue);
  }
  assertSendTransaction(checkpoint);
  if (call.operation !== "broadcast.submit") {
    throw new TwsStateError(
      "PORT_RESULT_INVALID",
      "only an uncertain broadcast submission can be reconciled",
    );
  }
  const error = errorValue as { readonly name?: string; readonly retryable?: boolean };
  if (
    error.retryable !== true ||
    (error.name !== "UNAVAILABLE" && error.name !== "INTERNAL_ERROR")
  ) {
    return completeError(checkpoint, -32603, "TBC transaction broadcast failed");
  }
  const params = call.params as {
    readonly chainId: string;
    readonly transaction: SignedTransaction;
  };
  const previous = progress(checkpoint);
  const broadcastProgress = Object.freeze({
    ...previous,
    attempts: Object.freeze([...previous.attempts, { params: call.params }]),
    submittedTransactionIds: Object.freeze([
      ...previous.submittedTransactionIds,
      params.transaction.txid,
    ]),
    reconciliationAttempts: previous.reconciliationAttempts + 1,
  });
  if (broadcastProgress.reconciliationAttempts > 1) {
    return completeError(checkpoint, -32603, "Broadcast reconciliation limit exceeded");
  }
  const revision = nextRevision(checkpoint);
  const calls = makeCalls(checkpoint, revision, [
    {
      operation: "broadcast.reconcile",
      params: {
        version: "1.0",
        chainId: params.chainId,
        txids: broadcastProgress.submittedTransactionIds,
      },
    },
  ]);
  const next = advance(checkpoint, {
    state: "reconciliation",
    pendingCalls: calls,
    memory: { ...checkpoint.payload.memory, broadcastProgress },
    data: { submittedTransactionIds: broadcastProgress.submittedTransactionIds },
  });
  return waitingTransition(next);
}

export function reduceReconciliationResponse(
  checkpoint: OperationCheckpoint,
  call: PortCall,
  resultValue: unknown,
): CoreTransition {
  assertSendTransaction(checkpoint);
  if (call.operation !== "broadcast.reconcile") {
    throw new TwsStateError(
      "PORT_RESULT_INVALID",
      "reconciliation reducer requires broadcast.reconcile",
    );
  }
  const requested = (call.params as { readonly txids: readonly string[] }).txids;
  const transactions = bundle(checkpoint).transactions;
  const previous = progress(checkpoint);
  const requestedIsSubmittedPrefix =
    requested.length === previous.submittedTransactionIds.length &&
    requested.every(
      (txid, index) =>
        txid === previous.submittedTransactionIds[index] &&
        txid === transactions[index]?.txid,
    );
  if (!requestedIsSubmittedPrefix) {
    throw new TwsStateError(
      "PORT_RESULT_INVALID",
      "broadcast reconciliation request is not an ordered bundle prefix",
    );
  }
  const result = resultValue as {
    readonly transactions: readonly {
      readonly txid: string;
      readonly status: "unknown" | "mempool" | "confirmed" | "rejected";
    }[];
  };
  if (
    result.transactions.length !== requested.length ||
    result.transactions.some(
      (transaction, index) => transaction.txid !== requested[index],
    )
  ) {
    throw new TwsStateError(
      "PORT_RESULT_INVALID",
      "broadcast reconciliation result differs from the requested txids",
    );
  }
  const broadcastProgress = Object.freeze({
    ...previous,
    reconciliation: resultValue,
  });
  const memory = { ...checkpoint.payload.memory, broadcastProgress };
  if (
    result.transactions.some(
      (transaction) =>
        transaction.status === "unknown" || transaction.status === "rejected",
    )
  ) {
    return completeError(
      checkpoint,
      -32603,
      "TBC transaction broadcast could not be confirmed",
      memory,
      broadcastFailureData(checkpoint, "SUBMISSION_UNCERTAIN", undefined, memory),
    );
  }
  const nextTransaction = transactions[requested.length];
  if (nextTransaction !== undefined) {
    const submittedTemplateIds = new Set(
      transactions.slice(0, requested.length).map((transaction) => transaction.id),
    );
    if (
      nextTransaction.dependsOn.some(
        (dependency) => !submittedTemplateIds.has(dependency),
      )
    ) {
      return completeError(
        checkpoint,
        -32603,
        "Broadcast dependency could not be proven from the reconciled prefix",
        memory,
      );
    }
    return waitForBroadcastClock(checkpoint, memory);
  }
  if (requested.length !== transactions.length) {
    return completeError(
      checkpoint,
      -32603,
      "Broadcast reconciliation confirmed only part of the transaction bundle",
      memory,
    );
  }
  return completeSuccess(checkpoint, submittedBundle(checkpoint), memory);
}
