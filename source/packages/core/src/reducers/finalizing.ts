import type { OperationCheckpoint } from "../checkpoint.js";
import {
  invokeTransactionEngine,
  type TransactionEngine,
} from "../engine.js";
import { TwsEngineError, TwsStateError } from "../errors.js";
import type { PortCall } from "../ports.js";
import type { CoreTransition } from "../transitions.js";
import { continueTransition, waitingTransition } from "../transitions.js";
import { transactionArtifacts, transactionValidationParams } from "./planning.js";
import { assertTransactionRoleTasks, type TransactionRoleRequest, type TransactionRoleAccount } from "../transaction-signing-roles.js";
import {
  advance,
  completeError,
  completeSuccess,
  makeCalls,
  nextRevision,
  operationOf,
} from "./shared.js";

interface SignedBundle {
  readonly version: "1.0";
  readonly chainId: string;
  readonly from: string;
  readonly requestHash: string;
  readonly approvalId: string;
  readonly transactions: readonly unknown[];
  readonly totalFee: string;
  readonly [key: string]: unknown;
}

interface SigningTask {
  readonly taskId: string;
  readonly signatureEncoding: string;
  readonly accountId: string;
  readonly publicKey: string;
  readonly [key: string]: unknown;
}

interface FinalizeContinuation {
  readonly version: "1.0";
  readonly method: "finalize";
  readonly family: "ft" | "pool" | "stablecoin" | "collection" | "nft";
  readonly requestHash: string;
  readonly planHash: string;
  readonly bindingHash: string;
  readonly approvalId: string;
  readonly stage: number;
  readonly [key: string]: unknown;
}

interface PendingFinalizeResult {
  readonly status: "pending";
  readonly continuation: FinalizeContinuation;
  readonly signingRequests: readonly SigningTask[];
}

interface FinalizationStage {
  readonly continuation: FinalizeContinuation;
  readonly signatureStart: number;
}

function assertPendingBindings(
  checkpoint: OperationCheckpoint,
  result: PendingFinalizeResult,
): void {
  const request = checkpoint.payload.memory.normalizedTransaction as {
    readonly requestHash: string;
    readonly request: TransactionRoleRequest;
  };
  const plan = checkpoint.payload.memory.executionPlan as {
    readonly planHash: string;
  };
  const binding = checkpoint.payload.memory.approvalBinding as {
    readonly bindingHash: string;
  };
  const approval = checkpoint.payload.memory.approvalReceipt as {
    readonly approvalId: string;
  };
  const continuation = result.continuation;
  if (
    continuation.requestHash !== request.requestHash ||
    continuation.planHash !== plan.planHash ||
    continuation.bindingHash !== binding.bindingHash ||
    continuation.approvalId !== approval.approvalId ||
    result.signingRequests.length === 0
  ) {
    throw new TwsEngineError(
      "ENGINE_ARTIFACT_MISMATCH",
      "pending finalization is not bound to its approved operation",
    );
  }
  if (request.request.signingRoles !== undefined) {
    const resolutions = checkpoint.payload.memory.accountResolutions as readonly { readonly result: { readonly accounts: readonly TransactionRoleAccount[] } }[];
    assertTransactionRoleTasks(request.request, resolutions.at(-1)!.result.accounts, result.signingRequests);
  }
}

export function reduceFinalizingClock(
  checkpoint: OperationCheckpoint,
  call: PortCall,
  resultValue: unknown,
): CoreTransition {
  if (call.operation !== "clock.now") {
    throw new TwsStateError(
      "PORT_RESULT_INVALID",
      "finalizing freshness check requires clock.now",
    );
  }
  const result = resultValue as { readonly now: string };
  if (Date.parse(result.now) >= Date.parse(String(checkpoint.payload.expiresAt))) {
    return completeError(checkpoint, 4100, "Approval expired before finalizing", checkpoint.payload.memory,
      { reason: "RECEIPT_EXPIRED", stage: "finalizing", operationId: checkpoint.payload.operationId });
  }
  const next = advance(checkpoint, {
    state: "finalizing",
    updatedAt: result.now,
    pendingCalls: [],
    memory: { ...checkpoint.payload.memory, trustedTime: result.now },
    data: { signatures: checkpoint.payload.memory.signatures },
  });
  return continueTransition(next);
}

function assertBundleBindings(
  checkpoint: OperationCheckpoint,
  bundle: SignedBundle,
): void {
  const request = (checkpoint.payload.memory.normalizedTransaction as {
    readonly request: { readonly chainId: string; readonly from: string };
    readonly requestHash: string;
  });
  const approval = checkpoint.payload.memory.approvalReceipt as {
    readonly approvalId: string;
  };
  if (
    bundle.chainId !== request.request.chainId ||
    bundle.from !== request.request.from ||
    bundle.requestHash !== request.requestHash ||
    bundle.approvalId !== approval.approvalId
  ) {
    throw new TwsEngineError(
      "ENGINE_ARTIFACT_MISMATCH",
      "finalized bundle differs from its request or approval",
    );
  }
}

export async function reduceFinalizing(
  checkpoint: OperationCheckpoint,
  engine: TransactionEngine | undefined,
): Promise<CoreTransition> {
  const common = transactionArtifacts(checkpoint);
  const binding = checkpoint.payload.memory.approvalBinding;
  const approval = checkpoint.payload.memory.approvalReceipt;
  const allSignatures = checkpoint.payload.memory.signatures as readonly unknown[];
  const finalizationStages = (checkpoint.payload.memory.finalizationStages ??
    []) as readonly FinalizationStage[];
  const currentStage = finalizationStages.at(-1);
  const signatures = allSignatures.slice(currentStage?.signatureStart ?? 0);
  const continuation = currentStage?.continuation;
  const result = (await invokeTransactionEngine(
    engine,
    "finalize",
    "finalizeParams",
    "finalizeResult",
    {
      version: "1.0",
      ...common,
      plan: checkpoint.payload.memory.executionPlan,
      binding,
      approval,
      signatures,
      ...(continuation === undefined ? {} : { continuation }),
    },
  )) as PendingFinalizeResult | {
    readonly bundle: SignedBundle;
    readonly validation: { readonly valid: boolean };
  };
  if ("status" in result) {
    assertPendingBindings(checkpoint, result);
    const pendingValidation = (await invokeTransactionEngine(
      engine,
      "validate",
      "validateParams",
      "validationResult",
      transactionValidationParams(checkpoint, "finalized", {
        binding,
        approval,
        signatures,
        pending: result,
        ...(continuation === undefined ? {} : { continuation }),
      }),
    )) as { readonly valid: boolean };
    if (!pendingValidation.valid) {
      return completeError(
        checkpoint,
        -32603,
        "Pending transaction validation failed",
      );
    }
    const revision = nextRevision(checkpoint);
    const calls = makeCalls(checkpoint, revision, [
      { operation: "clock.now", params: { version: "1.0" } },
    ]);
    const next = advance(checkpoint, {
      state: "signing",
      pendingCalls: calls,
      memory: {
        ...checkpoint.payload.memory,
        finalizationStages: Object.freeze([
          ...finalizationStages,
          Object.freeze({
            continuation: result.continuation,
            signatureStart: allSignatures.length,
          }),
        ]),
        signingTasks: Object.freeze([
          ...((checkpoint.payload.memory.signingTasks ?? []) as readonly SigningTask[]),
          ...result.signingRequests,
        ]),
      },
      data: {
        approvalReceipt: approval,
        signingTask: result.signingRequests[0],
      },
    });
    return waitingTransition(next);
  }
  if (!result.validation.valid) {
    return completeError(checkpoint, -32603, "Transaction finalization failed");
  }
  assertBundleBindings(checkpoint, result.bundle);
  const memory = { ...checkpoint.payload.memory, finalizedBundle: result.bundle };
  const finalizedValidation = (await invokeTransactionEngine(
    engine,
    "validate",
    "validateParams",
    "validationResult",
    transactionValidationParams(checkpoint, "finalized", {
      binding,
      approval,
      signatures,
      bundle: result.bundle,
      ...(continuation === undefined ? {} : { continuation }),
    }),
  )) as { readonly valid: boolean };
  if (!finalizedValidation.valid) {
    return completeError(
      checkpoint,
      -32603,
      "Finalized transaction validation failed",
    );
  }
  const operation = operationOf(checkpoint);
  if (
    operation.method === "tbc_signTransaction" ||
    operation.method === "tbc_signPreparedTransaction"
  ) {
    return completeSuccess(checkpoint, result.bundle, memory);
  }
  if (
    operation.method !== "tbc_sendTransaction" &&
    operation.method !== "tbc_sendPreparedTransaction"
  ) {
    throw new TwsEngineError(
      "ENGINE_INPUT_INVALID",
      "transaction finalizer received a non-transaction method",
    );
  }
  const broadcastValidation = (await invokeTransactionEngine(
    engine,
    "validate",
    "validateParams",
    "validationResult",
    transactionValidationParams(checkpoint, "pre-broadcast", {
      binding,
      approval,
      signatures,
      bundle: result.bundle,
      ...(continuation === undefined ? {} : { continuation }),
    }),
  )) as { readonly valid: boolean };
  if (!broadcastValidation.valid) {
    return completeError(
      checkpoint,
      -32603,
      "Pre-broadcast transaction validation failed",
    );
  }
  const broadcastProgress = Object.freeze({
    attempts: [],
    submittedTransactionIds: [],
    reconciliationAttempts: 0,
  });
  const revision = nextRevision(checkpoint);
  const calls = makeCalls(checkpoint, revision, [
    { operation: "clock.now", params: { version: "1.0" } },
  ]);
  const next = advance(checkpoint, {
    state: "broadcasting",
    pendingCalls: calls,
    memory: { ...memory, broadcastProgress },
    data: { finalizedBundle: result.bundle },
  });
  return waitingTransition(next);
}
