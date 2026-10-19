import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as tws from "../dist/esm/index.js";

const approval = JSON.parse(
  await readFile(new URL("../../../test-vectors/approval.json", import.meta.url), "utf8"),
);
const integration = JSON.parse(
  await readFile(new URL("../../../test-vectors/integration.json", import.meta.url), "utf8"),
);
const provider = JSON.parse(
  await readFile(new URL("../../../test-vectors/provider.json", import.meta.url), "utf8"),
);
const context = provider.trustedContexts[0].context;
const session = provider.providerSessions.sessionA;

function advance(checkpoint, changes) {
  return tws.advanceCheckpoint(checkpoint, {
    ...checkpoint.payload,
    revision: String(BigInt(checkpoint.payload.revision) + 1n),
    previousCheckpointHash: checkpoint.checkpointHash,
    pendingCalls: [],
    ...changes,
  });
}

function createTransactionPlanningCheckpoint(validating) {
  const authorizing = advance(validating, {
    state: "authorizing",
    memory: {
      ...validating.payload.memory,
      permissionLoads: [],
    },
    data: { permissionSnapshot: [] },
  });
  const resolving = advance(authorizing, {
    state: "resolving",
    memory: {
      ...authorizing.payload.memory,
      accountResolutions: [],
    },
    data: { resolvedInputs: { account: integration.canonicalTransfer.account } },
  });
  return advance(resolving, {
    state: "planning",
    memory: {
      ...resolving.payload.memory,
      requestHash: integration.canonicalTransfer.requestHash,
      executionPlan: integration.canonicalTransfer.plan,
    },
    data: { requestHash: integration.canonicalTransfer.requestHash },
  });
}

test("approval binding reproduces every approved method category and separates sign from send", () => {
  assert.equal(approval.bindings.length, 8);
  for (const vector of approval.bindings) {
    assert.deepEqual(tws.createApprovalBinding(vector.binding.payload), vector.binding);
    assert.deepEqual(
      tws.assertApprovalBinding(vector.binding, vector.binding.payload),
      vector.binding,
    );
  }
  const sign = approval.bindings.find(({ method }) => method === "tbc_signTransaction");
  const send = approval.bindings.find(({ method }) => method === "tbc_sendTransaction");
  assert.notEqual(sign.binding.bindingHash, send.binding.bindingHash);
});

test("approval binding fails closed on method, context, request, operation, chain, or account drift", () => {
  const original = approval.bindings.find(
    ({ method }) => method === "tbc_sendTransaction",
  ).binding;
  for (const [field, value] of [
    ["method", "tbc_signTransaction"],
    ["contextHash", "f".repeat(64)],
    ["requestHash", "e".repeat(64)],
    ["operationHash", "d".repeat(64)],
  ]) {
    assert.throws(
      () => tws.assertApprovalBinding(original, { ...original.payload, [field]: value }),
      (error) =>
        error instanceof tws.TwsApprovalError &&
        error.code === "BINDING_EXPECTATION_MISMATCH",
      field,
    );
  }

  assert.throws(
    () => tws.createApprovalBinding({
      ...original.payload,
      chainId: "tbc:other",
    }),
    (error) =>
      error instanceof tws.TwsApprovalError && error.code === "ACCOUNT_CHAIN_MISMATCH",
  );
  assert.throws(
    () => tws.createApprovalBinding(approval.semanticFailures[0].payload),
    (error) =>
      error instanceof tws.TwsApprovalError && error.code === "CHAIN_IDS_NOT_SORTED",
  );
});

test("approval request binds the exact requester and preview without leaking a token", () => {
  const binding = integration.canonicalTransfer.binding;
  const preview = integration.canonicalTransfer.plan.payload.preview;
  const request = tws.createApprovalRequest(binding, preview, context);
  assert.deepEqual(request, integration.portData.approvalParams);
  assert.equal(JSON.stringify(request).includes("approvalToken"), false);

  const wrongPreview = approval.previews.find(
    ({ operationKind }) => operationKind === "message",
  );
  assert.throws(
    () => tws.createApprovalRequest(binding, wrongPreview, context),
    (error) => error instanceof tws.TwsApprovalError && error.code === "PREVIEW_MISMATCH",
  );
  assert.throws(
    () => tws.assertApprovalRequest(
      { ...request, approvalToken: "must-not-leak" },
      request,
    ),
    (error) => error instanceof tws.TwsApprovalError && error.code === "APPROVAL_REQUEST_INVALID",
  );
});

test("approval receipt must match the binding and remain live without exposing its token in errors", () => {
  const binding = integration.canonicalTransfer.binding;
  const receipt = integration.canonicalTransfer.approval;
  assert.deepEqual(
    tws.assertApprovalReceipt(binding, receipt, "2026-08-31T12:00:10Z"),
    receipt,
  );
  for (const [mutation, code] of [
    [{ bindingHash: "f".repeat(64) }, "RECEIPT_BINDING_MISMATCH"],
    [{ expiresAt: "2026-08-31T12:03:00Z" }, "RECEIPT_EXPIRY_EXTENDED"],
  ]) {
    assert.throws(
      () => tws.assertApprovalReceipt(binding, { ...receipt, ...mutation }, "2026-08-31T12:00:10Z"),
      (error) => {
        assert.equal(error instanceof tws.TwsApprovalError, true);
        assert.equal(error.code, code);
        assert.equal(error.message.includes(receipt.approvalToken), false);
        return true;
      },
    );
  }
  assert.throws(
    () => tws.assertApprovalReceipt(binding, receipt, receipt.expiresAt),
    (error) => error instanceof tws.TwsApprovalError && error.code === "RECEIPT_EXPIRED",
  );
});

test("millisecond receipt expires exactly at deadline and cannot extend it by 1ms", () => {
  const binding = tws.createApprovalBinding({
    ...integration.canonicalTransfer.binding.payload,
    expiresAt: "2026-08-31T12:02:00.123Z",
  });
  const receipt = {
    ...integration.canonicalTransfer.approval,
    bindingHash: binding.bindingHash,
    approvedAt: "2026-08-31T12:00:00Z",
    expiresAt: binding.payload.expiresAt,
  };
  assert.deepEqual(tws.assertApprovalReceipt(binding, receipt, "2026-08-31T12:02:00.122Z"), receipt);
  for (const now of ["2026-08-31T12:02:00.123Z", "2026-08-31T12:02:00.124Z"]) {
    assert.throws(() => tws.assertApprovalReceipt(binding, receipt, now),
      error => error.code === "RECEIPT_EXPIRED");
  }
  assert.throws(() => tws.assertApprovalReceipt(binding, {...receipt, expiresAt:"2026-08-31T12:02:00.124Z"}, receipt.approvedAt),
    error => error.code === "RECEIPT_EXPIRY_EXTENDED");
  assert.throws(() => tws.assertApprovalBinding({...binding,
    payload:{...binding.payload, expiresAt:"2026-08-31T12:02:00.12Z"}}));
});

test("approval reducer samples trusted time before issuing the durable approval effect", async () => {
  const core = tws.createTwsCore();
  const start = await core.start({
    version: "1.0",
    release: tws.TWS_RELEASE,
    request: {
      jsonrpc: "2.0",
      id: "approval-gate",
      method: "tbc_sendTransaction",
      params: integration.canonicalTransfer.request,
    },
    currentContext: context,
    currentSession: session,
  });
  const validating = await core.resume({
    version: "1.0",
    checkpoint: start.checkpoint,
    response: {
      version: "1.0",
      callId: start.calls[0].callId,
      result: { now: "2026-08-31T12:00:00Z" },
    },
    currentContext: context,
    currentSession: session,
  });
  assert.throws(
    () => tws.prepareApproval(
      validating.checkpoint,
      integration.canonicalTransfer.binding,
      integration.canonicalTransfer.plan.payload.preview,
    ),
    (error) =>
      error instanceof tws.TwsApprovalError &&
      error.code === "APPROVAL_REQUEST_INVALID",
  );
  const planning = createTransactionPlanningCheckpoint(validating.checkpoint);
  assert.throws(
    () => tws.prepareApproval(
      planning,
      integration.canonicalTransfer.binding,
      {
        ...integration.canonicalTransfer.plan.payload.preview,
        totalFee: "81",
      },
    ),
    (error) =>
      error instanceof tws.TwsApprovalError && error.code === "PREVIEW_MISMATCH",
  );
  const clock = tws.prepareApproval(
    planning,
    integration.canonicalTransfer.binding,
    integration.canonicalTransfer.plan.payload.preview,
  );
  assert.equal(clock.kind, "waiting");
  assert.deepEqual(clock.calls.map(({ operation }) => operation), ["clock.now"]);

  const request = await core.resume({
    version: "1.0",
    checkpoint: clock.checkpoint,
    response: {
      version: "1.0",
      callId: clock.calls[0].callId,
      result: { now: "2026-08-31T12:00:05Z" },
    },
    currentContext: context,
    currentSession: session,
  });
  assert.equal(request.kind, "waiting");
  assert.deepEqual(request.calls.map(({ operation }) => operation), ["approval.request"]);
  assert.deepEqual(request.calls[0].params, integration.portData.approvalParams);
  assert.equal(JSON.stringify(request.calls[0].params).includes("approvalToken"), false);

  const accepted = tws.readApprovalDecision(
    request.checkpoint,
    request.calls[0],
    integration.canonicalTransfer.approval,
  );
  assert.deepEqual(accepted, {
    status: "approved",
    receipt: integration.canonicalTransfer.approval,
  });
  assert.throws(
    () => tws.readApprovalDecision(
      request.checkpoint,
      request.calls[0],
      {
        ...integration.canonicalTransfer.approval,
        bindingHash: "f".repeat(64),
      },
    ),
    (error) =>
      error instanceof tws.TwsApprovalError &&
      error.code === "RECEIPT_BINDING_MISMATCH",
  );
});
