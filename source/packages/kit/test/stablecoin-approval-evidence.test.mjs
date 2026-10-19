import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  ApprovalHostEvidenceConflictError,
  assertStablecoinApprovalEvidence,
  hashCanonical,
  hexToBytes,
  sha256Hex,
} from "../dist/esm/wallet.js";

const integration = JSON.parse(await readFile(
  new URL("../../../test-vectors/integration.json", import.meta.url),
  "utf8",
));
const canonical = integration.canonicalTransfer;
const CONTRACT_ID = "22".repeat(32);
const CREATION_TXID = "33".repeat(32);

function evidenceFor(operation = "transfer") {
  const request = structuredClone(canonical.request);
  request.intent = operation === "transfer"
    ? {
        type: "tbc.stablecoin.transfer",
        version: "1.0",
        contractId: CONTRACT_ID,
        to: canonical.request.intent.to,
        amount: "125",
      }
    : {
        type: "tbc.stablecoin.merge",
        version: "1.0",
        contractId: CONTRACT_ID,
      };
  const requestHash = hashCanonical(request);

  const snapshot = structuredClone(canonical.snapshot);
  snapshot.payload.contracts = [{
    contractId: CONTRACT_ID,
    creationTxid: CREATION_TXID,
    currentOutpoint: { txid: "44".repeat(32), vout: 0 },
    family: "stablecoin",
    protocolVersion: "1",
  }];
  snapshot.payload.utxos[0].classification = "stablecoin";
  snapshot.payload.utxos[0].contractId = CONTRACT_ID;

  const plan = structuredClone(canonical.plan);
  const baseRaw = plan.payload.transactions[0].unsignedTransaction;
  const nativeInput = `${"bb".repeat(32)}0000000000ffffffff`;
  plan.payload.transactions[0].unsignedTransaction =
    `${baseRaw.slice(0, 8)}02${baseRaw.slice(10, 92)}${nativeInput}${baseRaw.slice(92)}`;
  plan.payload.transactions[0].templateHash = sha256Hex(hexToBytes(
    plan.payload.transactions[0].unsignedTransaction,
  ));
  snapshot.payload.utxos.push({
    ...structuredClone(canonical.snapshot.payload.utxos[0]),
    txid: "bb".repeat(32),
  });
  plan.payload.signingTasks.push({
    ...structuredClone(plan.payload.signingTasks[0]),
    taskId: "sign-tx-1-input-1",
    inputIndex: 1,
    digest: "99".repeat(32),
  });
  if (operation === "merge") {
    const raw = plan.payload.transactions[0].unsignedTransaction;
    const secondInput = `${"aa".repeat(32)}0100000000ffffffff`;
    plan.payload.transactions[0].unsignedTransaction =
      `${raw.slice(0, 8)}03${raw.slice(10, 174)}${secondInput}${raw.slice(174)}`;
    plan.payload.transactions[0].templateHash = sha256Hex(hexToBytes(
      plan.payload.transactions[0].unsignedTransaction,
    ));
    snapshot.payload.utxos.push({
      ...structuredClone(snapshot.payload.utxos[0]),
      txid: "aa".repeat(32),
      vout: 1,
    });
    plan.payload.signingTasks.push({
      ...structuredClone(plan.payload.signingTasks[0]),
      taskId: "sign-tx-1-input-2",
      inputIndex: 2,
      digest: "55".repeat(32),
    });
  }
  snapshot.snapshotHash = hashCanonical(snapshot.payload);
  plan.payload.requestHash = requestHash;
  plan.payload.snapshotHash = snapshot.snapshotHash;
  plan.payload.policyHash = canonical.policy.policyHash;
  plan.payload.preview.assetFlows = [
    {
      kind: "stablecoin",
      direction: operation === "transfer" ? "send" : "merge",
      amount: operation === "transfer" ? "125" : "999",
      from: request.from,
      to: operation === "transfer" ? request.intent.to : request.from,
    },
    {
      kind: "native",
      direction: "fee",
      amount: "80",
      from: request.from,
    },
  ];
  plan.planHash = hashCanonical(plan.payload);
  const bindingPayload = {
    version: "1.0",
    method: "tbc_signTransaction",
    operationKind: "transaction",
    contextHash: "66".repeat(32),
    origin: "https://durianswap.org",
    sessionId: "stablecoin-approval-test",
    chainId: request.chainId,
    accountId: plan.payload.accountId,
    requestHash,
    operationHash: plan.planHash,
    expiresAt: request.constraints.expiresAt,
  };
  const binding = {
    payload: bindingPayload,
    bindingHash: hashCanonical(bindingPayload),
  };
  const params = {
    version: "1.0",
    binding,
    preview: plan.payload.preview,
  };
  return {
    callId: "call",
    operationId: "operation",
    releaseFingerprint: "77".repeat(32),
    call: { params },
    params,
    operation: {},
    payload: {},
    memory: {
      requestHash,
      normalizedTransaction: { request, requestHash },
      chainSnapshot: snapshot,
      executionPolicy: structuredClone(canonical.policy),
      executionPlan: plan,
      approvalBinding: binding,
      approvalPreview: plan.payload.preview,
    },
  };
}

function rebind(evidence) {
  evidence.memory.chainSnapshot.snapshotHash = hashCanonical(
    evidence.memory.chainSnapshot.payload,
  );
  evidence.memory.executionPlan.payload.snapshotHash =
    evidence.memory.chainSnapshot.snapshotHash;
  evidence.memory.executionPlan.planHash = hashCanonical(
    evidence.memory.executionPlan.payload,
  );
  evidence.memory.approvalBinding.payload.operationHash =
    evidence.memory.executionPlan.planHash;
  evidence.memory.approvalBinding.bindingHash = hashCanonical(
    evidence.memory.approvalBinding.payload,
  );
  evidence.params.binding = evidence.memory.approvalBinding;
  evidence.params.preview = evidence.memory.executionPlan.payload.preview;
  evidence.memory.approvalPreview = evidence.params.preview;
}

test("projects fully bound stablecoin transfer evidence without equating contract identity and genesis", () => {
  const projected = assertStablecoinApprovalEvidence(evidenceFor("transfer"));
  assert.equal(projected.kind, "stablecoin");
  assert.equal(projected.operation, "transfer");
  assert.equal(projected.contractId, CONTRACT_ID);
  assert.equal(projected.creationTxid, CREATION_TXID);
  assert.notEqual(projected.contractId, projected.creationTxid);
  assert.equal(projected.rawAmount, "125");
  assert.equal(projected.assetInputCount, 1);
  assert.equal(projected.feeAtomic, "80");
  assert.equal(projected.transactionCount, 1);
  assert.deepEqual(projected.inputOutpoints, [{
    txid: canonical.snapshot.payload.utxos[0].txid,
    vout: 0,
  }, { txid: "bb".repeat(32), vout: 0 }]);
  assert.equal(Object.isFrozen(projected), true);
  assert.equal(Object.isFrozen(projected.inputOutpoints), true);
  assert.equal(Object.isFrozen(projected.preview), true);
});

test("projects stablecoin merge amount and exact selected input count", () => {
  const projected = assertStablecoinApprovalEvidence(evidenceFor("merge"));
  assert.equal(projected.operation, "merge");
  assert.equal(projected.recipient, projected.source);
  assert.equal(projected.rawAmount, "999");
  assert.equal(projected.assetInputCount, 2);
  assert.deepEqual(projected.inputOutpoints, [
    { txid: canonical.snapshot.payload.utxos[0].txid, vout: 0 },
    { txid: "bb".repeat(32), vout: 0 },
    { txid: "aa".repeat(32), vout: 1 },
  ]);
});

test("accepts an exact later signing stage that is not yet represented by current-stage tasks", () => {
  const evidence = evidenceFor("transfer");
  const first = evidence.memory.executionPlan.payload.transactions[0];
  const raw = first.unsignedTransaction;
  const laterRaw = `${raw.slice(0, 10)}${"00".repeat(32)}${raw.slice(74)}`;
  evidence.memory.executionPlan.payload.transactions.push({
    ...structuredClone(first),
    id: "tx-2",
    role: "primary",
    dependsOn: [first.id],
    unsignedTransaction: laterRaw,
    templateHash: sha256Hex(hexToBytes(laterRaw)),
  });
  evidence.memory.executionPlan.payload.preview.transactionCount = 2;
  evidence.memory.executionPlan.payload.preview.totalFee = "160";
  evidence.memory.executionPlan.payload.preview.assetFlows[1].amount = "160";
  rebind(evidence);

  const projected = assertStablecoinApprovalEvidence(evidence);
  assert.equal(projected.transactionCount, 2);
  assert.equal(projected.assetInputCount, 1);
  assert.equal(projected.feeAtomic, "160");
});

test("rejects independently rebound preview, input, task and contract mutations", () => {
  for (const mutate of [
    (evidence) => {
      evidence.memory.executionPlan.payload.preview.assetFlows[0].amount = "126";
    },
    (evidence) => {
      evidence.memory.chainSnapshot.payload.utxos[0].contractId = "88".repeat(32);
    },
    (evidence) => {
      evidence.memory.executionPlan.payload.signingTasks[0].inputIndex = 1;
    },
    (evidence) => {
      evidence.memory.chainSnapshot.payload.contracts[0].family = "ft";
    },
  ]) {
    const evidence = evidenceFor("transfer");
    mutate(evidence);
    rebind(evidence);
    assert.throws(
      () => assertStablecoinApprovalEvidence(evidence),
      ApprovalHostEvidenceConflictError,
    );
  }
});
