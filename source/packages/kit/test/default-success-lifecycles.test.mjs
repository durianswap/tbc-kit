import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const kitRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("default HTTP orchestration finalizes all nine business cases and preserves controlled submit order", () => {
  const evidence = JSON.parse(execFileSync(
    process.execPath,
    [resolve(kitRoot, "scripts/check-default-success-lifecycles.mjs")],
    { cwd: resolve(kitRoot, "../.."), encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  ));
  assert.equal(evidence.resolverOverride, false);
  assert.equal(evidence.policyOverride, false);
  assert.equal(evidence.cases, 9);
  assert.equal(evidence.signOnly.length, 9);
  assert.ok(evidence.signOnly.every((item) => item.approvalCalls === 1 && item.signerCalls > 0 && item.submitCalls === 0));
  assert.ok(evidence.signOnly.every((item) => !item.httpEdges.includes("POST /api/tbc/broadcasttx")));
  assert.ok(evidence.signOnly.every((item) => item.hostIdentity.executionTypes.every((type) => type === "session-only")));
  assert.ok(evidence.signOnly.every((item) => item.presentation.binding === "verified"));
  assert.ok(evidence.signOnly.every((item) => item.presentation.businessType === item.label ||
    (item.label.startsWith("tbc.pool.create.") && item.presentation.businessType === "tbc.pool.create")));
  assert.ok(evidence.signOnly.every((item) => Number(item.presentation.actualFeeAtomic) >= 0));
  assert.ok(evidence.signOnly.every((item) => item.presentation.transactions > 0 && item.presentation.signingTasks > 0));
  assert.equal(evidence.representativeSend.label, "tbc.ft.create");
  assert.equal(evidence.representativeSend.transactions, 2);
  assert.equal(evidence.representativeSend.submitCalls, 2);
  assert.equal(evidence.representativeSend.httpEdges.filter((edge) => edge === "POST /api/tbc/broadcasttx").length, 2);
  assert.equal(evidence.representativeSend.hostIdentity.frozen, true);
  assert.equal(
    new Set(evidence.representativeSend.hostIdentity.callIds).size,
    evidence.representativeSend.hostIdentity.callIds.length,
  );
  assert.equal(evidence.representativeSend.hostIdentity.operations.filter((operation) => operation === "approval.request").length, 1);
  assert.ok(evidence.representativeSend.hostIdentity.operations.includes("signer.sign"));
  assert.equal(evidence.representativeSend.hostIdentity.operations.filter((operation) => operation === "broadcast.submit").length, 2);
  assert.equal(evidence.representativeSend.hostIdentity.operations.filter((operation) => operation === "broadcast.reconcile").length, 1);
  assert.ok(evidence.representativeSend.hostIdentity.executionTypes.every((type) => type === "session-only"));
  assert.ok(evidence.prepared.sign.transactions > 0);
  assert.ok(evidence.prepared.sign.signerCalls > 0);
  assert.equal(evidence.prepared.sign.submitCalls, 0);
  assert.equal(evidence.prepared.sign.httpEdges.includes("POST /api/tbc/broadcasttx"), false);
  assert.equal(evidence.prepared.sign.executionType, "session-only");
  assert.ok(evidence.prepared.send.transactions > 0);
  assert.ok(evidence.prepared.send.signerCalls > 0);
  assert.equal(evidence.prepared.send.submitCalls, evidence.prepared.send.transactions);
  assert.equal(
    evidence.prepared.send.httpEdges.filter((edge) => edge === "POST /api/tbc/broadcasttx").length,
    evidence.prepared.send.transactions,
  );
  assert.equal(evidence.prepared.send.executionType, "session-only");
  assert.equal(evidence.prepared.deferredBundle.transactions, 2);
  assert.deepEqual(evidence.prepared.deferredBundle.proposalKinds, ["fixed", "deferred"]);
  assert.equal(evidence.prepared.deferredBundle.submitCalls, 0);
  assert.equal(evidence.prepared.preparedWorkflow.steps, 1);
  assert.equal(evidence.prepared.preparedWorkflow.transactions, 2);
  assert.deepEqual(evidence.prepared.preparedWorkflow.proposalKinds, ["fixed", "deferred"]);
  assert.equal(evidence.prepared.preparedWorkflow.approvalCalls, 1);
  assert.equal(evidence.prepared.preparedWorkflow.httpEdges.includes("POST /api/tbc/broadcasttx"), false);
  assert.equal(evidence.prepared.preparedWorkflow.executionType, "session-only");
});
