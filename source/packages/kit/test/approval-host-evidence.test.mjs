import assert from "node:assert/strict";
import test from "node:test";

import {
  ApprovalHostEvidenceConflictError,
  createApprovalHostEvidenceReader,
} from "../dist/esm/wallet.js";

const binding = Object.freeze({
  bindingHash: "aa".repeat(32),
  payload: Object.freeze({ method: "tbc_signTransaction" }),
});
const releaseFingerprint = "dd".repeat(32);
const preview = Object.freeze({
  operationKind: "transaction",
  totalFee: "500",
});
const callEnvelope = Object.freeze({ params: Object.freeze({ binding, preview }) });

function fixtures() {
  const call = {
    operation: "approval.request",
    operationId: "operation",
    callId: "call",
    call: callEnvelope,
  };
  const payload = {
    operationId: "operation",
    releaseFingerprint,
    state: "approval",
    pendingCalls: [callEnvelope],
    memory: { approvalBinding: binding, approvalPreview: preview },
  };
  const operation = {
    operationId: "operation",
    releaseFingerprint,
    transition: { checkpoint: { payload } },
  };
  return { call, operation, payload };
}

function reader(overrides = {}) {
  const values = fixtures();
  const { store = {}, ...options } = overrides;
  return createApprovalHostEvidenceReader({
    store: {
      readCall: async () => values.call,
      readOperation: async () => values.operation,
      ...store,
    },
    releaseFingerprint,
    parseApprovalRequest: (value) => value,
    ...options,
  });
}

test("approval Host evidence reader is exported", () => {
  assert.equal(typeof createApprovalHostEvidenceReader, "function");
  assert.equal(typeof ApprovalHostEvidenceConflictError, "function");
});

test("reads one authoritative approval envelope", async () => {
  const evidence = await reader().read("call", binding.bindingHash);
  assert.deepEqual(evidence.params, { binding, preview });
  assert.equal(evidence.operationId, "operation");
  assert.equal(evidence.callId, "call");
  assert.equal(evidence.releaseFingerprint, releaseFingerprint);
  assert.deepEqual(
    evidence.call,
    evidence.operation.transition.checkpoint.payload.pendingCalls[0],
  );
  assert.equal(evidence.payload.state, "approval");
  assert.deepEqual(evidence.memory.approvalBinding, binding);
});

test("reports sanitized evidence read and clone diagnostics without observer authority", async () => {
  const diagnostics = [];
  const evidence = await reader({
    onPerformance(event) {
      diagnostics.push(event);
      if (event.stage === "params-clone") throw new Error("observer");
    },
  }).read("call", binding.bindingHash);
  assert.equal(evidence.operationId, "operation");
  assert.deepEqual(
    diagnostics.map(({ stage }) => stage),
    [
      "call-read",
      "call-clone",
      "params-clone",
      "operation-read",
      "operation-clone",
    ],
  );
  assert.ok(diagnostics.every((event) =>
    event.component === "approval-host-evidence" &&
    event.count === 1 &&
    Number.isFinite(event.durationMs) &&
    event.durationMs >= 0 &&
    Number.isSafeInteger(event.bytes) &&
    event.bytes >= 0 &&
    !Object.hasOwn(event, "call") &&
    !Object.hasOwn(event, "operation") &&
    !Object.hasOwn(event, "signature")
  ));
});

test("skips diagnostic byte encoding when no performance observer is configured", async (t) => {
  const originalEncode = TextEncoder.prototype.encode;
  let encodeCalls = 0;
  TextEncoder.prototype.encode = function (...args) {
    encodeCalls += 1;
    return Reflect.apply(originalEncode, this, args);
  };
  t.after(() => {
    TextEncoder.prototype.encode = originalEncode;
  });

  const evidence = await reader().read("call", binding.bindingHash);

  assert.equal(evidence.operationId, "operation");
  assert.equal(encodeCalls, 0);
});

test("rejects call and operation identity mismatches", async () => {
  for (const mutate of [
    ({ call }) => (call.operation = "signer.sign"),
    ({ call }) => (call.callId = "other"),
    ({ call }) => (call.call.params.binding.bindingHash = "bb".repeat(32)),
    ({ call }) => delete call.operationId,
    ({ operation }) => (operation.operationId = "other"),
    ({ payload }) => (payload.operationId = "other"),
    ({ operation }) => (operation.releaseFingerprint = "ee".repeat(32)),
    ({ payload }) => (payload.releaseFingerprint = "ee".repeat(32)),
  ]) {
    const values = fixtures();
    values.call.call = structuredClone(values.call.call);
    mutate(values);
    await assert.rejects(
      reader({
        store: {
          readCall: async () => values.call,
          readOperation: async () => values.operation,
        },
      }).read("call", binding.bindingHash),
      ApprovalHostEvidenceConflictError,
    );
  }
});

test("rejects non-authoritative checkpoint and memory", async () => {
  for (const mutate of [
    ({ payload }) => (payload.state = "planning"),
    ({ payload }) => (payload.pendingCalls = []),
    ({ payload }) => (payload.memory.approvalBinding = { bindingHash: "cc" }),
    ({ payload }) => (payload.memory.approvalPreview = { totalFee: "501" }),
  ]) {
    const values = fixtures();
    values.payload.memory = structuredClone(values.payload.memory);
    mutate(values);
    await assert.rejects(
      reader({
        store: {
          readCall: async () => values.call,
          readOperation: async () => values.operation,
        },
      }).read("call", binding.bindingHash),
      ApprovalHostEvidenceConflictError,
    );
  }
});

test("canonical pending-call equality ignores key order but rejects mutation", async () => {
  const values = fixtures();
  values.payload.pendingCalls = [
    {
      params: {
        preview: structuredClone(preview),
        binding: structuredClone(binding),
      },
    },
  ];
  await reader({
    store: {
      readCall: async () => values.call,
      readOperation: async () => values.operation,
    },
  }).read("call", binding.bindingHash);

  values.payload.pendingCalls[0].params.preview.totalFee = "501";
  await assert.rejects(
    reader({
      store: {
        readCall: async () => values.call,
        readOperation: async () => values.operation,
      },
    }).read("call", binding.bindingHash),
    ApprovalHostEvidenceConflictError,
  );
});

test("null, malformed, read and parser failures use the wallet conflict", async () => {
  class WalletConflict extends Error {}
  const createConflictError = (message) => new WalletConflict(message);
  for (const overrides of [
    { store: { readCall: async () => null } },
    { store: { readCall: async () => [] } },
    { store: { readOperation: async () => null } },
    { store: { readOperation: async () => [] } },
    { store: { readCall: async () => { throw new Error("read"); } } },
    { parseApprovalRequest: () => { throw new TypeError("parse"); } },
  ]) {
    await assert.rejects(
      reader({ ...overrides, createConflictError }).read(
        "call",
        binding.bindingHash,
      ),
      WalletConflict,
    );
  }
});

test("returns a detached deeply immutable evidence identity", async () => {
  const values = fixtures();
  const evidence = await reader({
    store: {
      readCall: async () => values.call,
      readOperation: async () => values.operation,
    },
  }).read("call", binding.bindingHash);
  values.payload.state = "complete";
  values.operation.releaseFingerprint = "ee".repeat(32);
  assert.equal(evidence.payload.state, "approval");
  assert.equal(evidence.operation.releaseFingerprint, releaseFingerprint);
  assert.equal(Object.isFrozen(evidence), true);
  assert.equal(Object.isFrozen(evidence.operation), true);
  assert.equal(Object.isFrozen(evidence.payload), true);
  assert.equal(Object.isFrozen(evidence.memory), true);
});

test("preserves wallet conflict error identity", async () => {
  class WalletConflict extends Error {}
  await assert.rejects(
    reader({
      store: { readCall: async () => null },
      createConflictError: (message) => new WalletConflict(message),
    }).read("call", binding.bindingHash),
    WalletConflict,
  );
});
