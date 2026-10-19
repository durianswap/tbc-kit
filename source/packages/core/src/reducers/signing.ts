import type { ApprovalReceipt } from "../bindings.js";
import type { OperationCheckpoint } from "../checkpoint.js";
import {
  invokeTransactionEngine,
  type TransactionEngine,
} from "../engine.js";
import { TwsApprovalError, TwsStateError } from "../errors.js";
import type { PortCall } from "../ports.js";
import type { CoreTransition } from "../transitions.js";
import {
  completeTransition,
  waitingTransition,
} from "../transitions.js";
import { readApprovalDecision } from "./approval.js";
import {
  advance,
  completeError,
  makeCalls,
  nextRevision,
} from "./shared.js";
import { transactionValidationParams } from "./planning.js";

interface SigningTask {
  readonly taskId: string;
  readonly purpose?: string;
  readonly signatureEncoding?: string;
  readonly [key: string]: unknown;
}

function completionForRejection(checkpoint: OperationCheckpoint) {
  return Object.freeze({
    delivery: "respond",
    response: {
      jsonrpc: "2.0",
      id: checkpoint.payload.requestId,
      error: { code: 4001, message: "User rejected the request" },
    },
    events: [],
  });
}

export async function reduceTransactionApproval(
  checkpoint: OperationCheckpoint,
  call: PortCall,
  resultValue: unknown,
  engine: TransactionEngine | undefined,
): Promise<CoreTransition> {
  const decision = readApprovalDecision(checkpoint, call, resultValue);
  if (decision.status === "rejected") {
    const completion = completionForRejection(checkpoint);
    const next = advance(checkpoint, {
      state: "rejected",
      pendingCalls: [],
      data: { cancellationReason: "USER_REJECTED" },
    });
    return completeTransition(next, completion);
  }

  const binding = checkpoint.payload.memory.approvalBinding;
  const validation = (await invokeTransactionEngine(
    engine,
    "validate",
    "validateParams",
    "validationResult",
    transactionValidationParams(checkpoint, "pre-sign", {
      binding,
      approval: decision.receipt,
    }),
  )) as { readonly valid: boolean };
  if (!validation.valid) {
    return completeError(checkpoint, -32603, "Pre-sign validation failed");
  }
  const plan = checkpoint.payload.memory.executionPlan as {
    readonly payload: { readonly signingTasks: readonly SigningTask[] };
  };
  const tasks = plan.payload.signingTasks;
  const revision = nextRevision(checkpoint);
  const calls = makeCalls(checkpoint, revision, [
    { operation: "clock.now", params: { version: "1.0" } },
  ]);
  const next = advance(checkpoint, {
    state: "signing",
    expiresAt: decision.receipt.expiresAt,
    pendingCalls: calls,
    memory: {
      ...checkpoint.payload.memory,
      approvalReceipt: decision.receipt,
      signingTasks: tasks,
    },
    data: { approvalReceipt: decision.receipt, signingTask: tasks[0] },
  });
  return waitingTransition(next);
}

export function reduceSigningClock(
  checkpoint: OperationCheckpoint,
  call: PortCall,
  resultValue: unknown,
): CoreTransition {
  if (call.operation !== "clock.now") {
    throw new TwsStateError(
      "PORT_RESULT_INVALID",
      "signing freshness check requires clock.now",
    );
  }
  const result = resultValue as { readonly now: string };
  const approval = checkpoint.payload.memory.approvalReceipt as ApprovalReceipt;
  if (Date.parse(result.now) < Date.parse(approval.approvedAt)) {
    throw new TwsApprovalError(
      "RECEIPT_TIME_INVALID",
      "signing clock predates the approval receipt",
    );
  }
  if (Date.parse(result.now) >= Date.parse(String(checkpoint.payload.expiresAt))) {
    return completeError(checkpoint, 4100, "Approval expired before signing");
  }
  const tasks = checkpoint.payload.memory.signingTasks as readonly SigningTask[];
  const signatures = (checkpoint.payload.memory.signatures ?? []) as readonly unknown[];
  const cryptoResults = (checkpoint.payload.memory.cryptoResults ?? []) as readonly unknown[];
  const reviewedTransactionResults =
    (checkpoint.payload.memory.reviewedTransactionResults ?? []) as readonly unknown[];
  const workflowProgress = checkpoint.payload.memory.workflowProgress as
    | {
        readonly steps: readonly Readonly<{
          readonly status: string;
          readonly signingTasks?: readonly SigningTask[];
          readonly signatures?: readonly unknown[];
        }>[];
      }
    | undefined;
  const activeWorkflowStep = workflowProgress?.steps.find(({ status }) => status === "signing");
  const task = activeWorkflowStep === undefined
    ? tasks[signatures.length + cryptoResults.length + reviewedTransactionResults.length]
    : activeWorkflowStep.signingTasks?.[activeWorkflowStep.signatures?.length ?? 0];
  if (task === undefined) {
    throw new TwsStateError(
      "PORT_RESULT_INVALID",
      "signing checkpoint has no remaining task",
    );
  }
  const revision = nextRevision(checkpoint);
  const crypto = task.purpose === "encrypt" || task.purpose === "decrypt";
  const reviewedTransaction = task.purpose === "reviewedTransaction";
  const calls = makeCalls(checkpoint, revision, [{
    operation: crypto
      ? "crypto.execute"
      : reviewedTransaction
        ? "reviewedTransaction.execute"
        : "signer.sign",
    params: { version: "1.0", approval, task },
  }]);
  const next = advance(checkpoint, {
    state: "signing",
    updatedAt: result.now,
    pendingCalls: calls,
    memory: { ...checkpoint.payload.memory, trustedTime: result.now, signatures },
    data: { approvalReceipt: approval, signingTask: task },
  });
  return waitingTransition(next);
}

export function reduceSigningResponse(
  checkpoint: OperationCheckpoint,
  call: PortCall,
  resultValue: unknown,
): CoreTransition {
  if (call.operation !== "signer.sign") {
    throw new TwsStateError("PORT_RESULT_INVALID", "signing reducer requires signer.sign");
  }
  const task = (call.params as { readonly task: SigningTask }).task;
  const result = resultValue as {
    readonly taskId: string;
    readonly signatureEncoding: string;
  };
  if (
    result.taskId !== task.taskId ||
    result.signatureEncoding !== task.signatureEncoding
  ) {
    throw new TwsStateError(
      "PORT_RESULT_INVALID",
      "signer result differs from its exact signing task",
    );
  }
  const signatures = Object.freeze([
    ...((checkpoint.payload.memory.signatures ?? []) as readonly unknown[]),
    resultValue,
  ]);
  const tasks = checkpoint.payload.memory.signingTasks as readonly SigningTask[];
  const nextTask = tasks[signatures.length];
  if (nextTask !== undefined) {
    const revision = nextRevision(checkpoint);
    const calls = makeCalls(checkpoint, revision, [
      {
        operation: "clock.now",
        params: { version: "1.0" },
      },
    ]);
    const next = advance(checkpoint, {
      state: "signing",
      pendingCalls: calls,
      memory: { ...checkpoint.payload.memory, signatures },
      data: {
        approvalReceipt: checkpoint.payload.memory.approvalReceipt,
        signingTask: nextTask,
      },
    });
    return waitingTransition(next);
  }
  const revision = nextRevision(checkpoint);
  const calls = makeCalls(checkpoint, revision, [
    { operation: "clock.now", params: { version: "1.0" } },
  ]);
  const next = advance(checkpoint, {
    state: "finalizing",
    pendingCalls: calls,
    memory: { ...checkpoint.payload.memory, signatures },
    data: { signatures },
  });
  return waitingTransition(next);
}
