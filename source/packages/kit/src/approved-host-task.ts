import { canonicalize, hashCanonical, verifyCheckpoint, assertWorkflowDeferredSigningTask, type OperationCheckpoint, type LegacyBitcoinMessageDigest } from "@tbc-wallet/core";
import type { ApprovalHostEvidenceStoreReader } from "./approval-host-evidence.js";

type RecordValue = Readonly<Record<string, unknown>>;
function record(value: unknown): RecordValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid approved Host task evidence");
  return value as RecordValue;
}
function same(a: unknown, b: unknown): boolean { return canonicalize(a) === canonicalize(b); }

/**
 * Reads the current private Host call, never a page-supplied task or checkpoint.
 * Core remains the transaction/workflow verifier. Platform adapters use this
 * projection to bind a Vault one-shot token to the active workflow step as well
 * as the task ID (task IDs may repeat across different transaction steps).
 * It adds no chain read, signing, storage write or broadcast.
 */
export function createApprovedHostTaskReader(options: Readonly<{
  store: ApprovalHostEvidenceStoreReader;
  releaseFingerprint: string;
  /** Same host-owned digest authority used by Core, never supplied by the page. */
  legacyBitcoinMessageDigest?: LegacyBitcoinMessageDigest;
}>) {
  async function read(callId: string, params: unknown, reviewed = false) {
    const row = record(await options.store.readCall(callId));
    const call = record(row.call);
    if (row.callId !== callId || call.callId !== callId || row.operation !== call.operation ||
        !["signer.sign", "crypto.execute", "reviewedTransaction.execute"].includes(String(call.operation)) ||
        !same(call.params, params)) throw new Error("Approved Host call mismatch");
    const operation = record(await options.store.readOperation(String(row.operationId)));
    const checkpoint = verifyCheckpoint(record(record(operation.transition).checkpoint) as unknown as OperationCheckpoint);
    const payload = checkpoint.payload;
    const memory = record(payload.memory), input = record(params), binding = record(memory.approvalBinding);
    const bindingPayload = record(binding.payload), receipt = record(memory.approvalReceipt), task = record(input.task);
    if (operation.operationId !== row.operationId || payload.operationId !== row.operationId ||
        operation.releaseFingerprint !== options.releaseFingerprint || payload.releaseFingerprint !== options.releaseFingerprint ||
        payload.state !== "signing" || !payload.pendingCalls.some(pending => same(pending, call)) ||
        hashCanonical(bindingPayload) !== binding.bindingHash || receipt.bindingHash !== binding.bindingHash ||
        !same(receipt, input.approval) || receipt.status !== "approved") throw new Error("Approved Host checkpoint mismatch");
    if (reviewed && (call.operation !== "reviewedTransaction.execute" || task.purpose !== "reviewedTransaction")) {
      throw new Error("Approved Reviewed task required");
    }
    if (bindingPayload.operationKind !== "workflow") {
      if (!reviewed) return undefined;
      const plan = record(memory.walletActionPlan), planPayload = record(plan.payload);
      if (bindingPayload.operationKind !== "transaction" || bindingPayload.method !== "tbc_signReviewedTransaction" ||
          plan.planHash !== bindingPayload.operationHash || hashCanonical(planPayload) !== plan.planHash ||
          planPayload.requestHash !== bindingPayload.requestHash || !same(planPayload.task, task) ||
          !Array.isArray(memory.signingTasks) || !same(memory.signingTasks, [task])) {
        throw new Error("Approved Reviewed plan mismatch");
      }
      return Object.freeze({version: "1.0", operationId: payload.operationId, callId,
        bindingHash: binding.bindingHash, task});
    }
    const plan = record(memory.workflowPlan), planPayload = record(plan.payload);
    if (plan.workflowPlanHash !== bindingPayload.operationHash || hashCanonical(planPayload) !== plan.workflowPlanHash ||
        planPayload.requestHash !== bindingPayload.requestHash || memory.requestHash !== bindingPayload.requestHash) {
      throw new Error("Approved workflow plan mismatch");
    }
    const progress = record(memory.workflowProgress);
    if (!Array.isArray(progress.steps)) throw new Error("Approved workflow progress missing");
    const active = progress.steps.map(record).filter(step => step.status === "signing" &&
      Array.isArray(step.signingTasks) && step.signingTasks.some(candidate => same(candidate, task)));
    if (active.length !== 1 || typeof active[0]?.stepId !== "string") throw new Error("Approved workflow active task mismatch");
    const step = active[0];
    if (reviewed && (!Array.isArray(planPayload.reviewedTransactionTasks) ||
        !planPayload.reviewedTransactionTasks.some(candidate => same(candidate, task)))) {
      throw new Error("Approved Reviewed workflow task mismatch");
    }
    if ((task.purpose === "message" || task.purpose === "typedData") &&
        !Array.isArray(planPayload.immediateSigningTasks)) throw new Error("Workflow signing tasks missing");
    if (task.purpose === "message" || task.purpose === "typedData") {
      const immediate = (planPayload.immediateSigningTasks as unknown[]).map(record).some(entry =>
        entry.stepId === step.stepId && same(entry.task, task));
      if (!immediate) await assertWorkflowDeferredSigningTask(checkpoint, String(step.stepId), task,
        options.legacyBitcoinMessageDigest);
    }
    if (Array.isArray(step.signatures) && step.signatures.some(s => record(s).taskId === task.taskId)) {
      throw new Error("Approved workflow task already completed");
    }
    return Object.freeze({ version: "1.0", operationId: payload.operationId, callId,
      workflowPlanHash: plan.workflowPlanHash, bindingHash: binding.bindingHash,
      stepId: step.stepId, task });
  }
  return Object.freeze({
    read: (callId: string, params: unknown) => read(callId, params),
    async readReviewed(callId: string, params: unknown) {
      const evidence = await read(callId, params, true);
      if (evidence === undefined) throw new Error("Approved Reviewed evidence missing");
      return evidence;
    },
  });
}
