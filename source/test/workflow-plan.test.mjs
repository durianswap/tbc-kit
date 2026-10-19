import assert from "node:assert/strict";
import test from "node:test";
import { repositoryRoot, readJson } from "../scripts/lib/repository.mjs";
import { validateDeferredDerivation } from "../scripts/lib/semantic-conformance.mjs";

const root = repositoryRoot(import.meta.url);
const workflow = readJson(root, "test-vectors/workflow.json");
const integration = readJson(root, "test-vectors/integration.json");

test("binds the complete transaction plan and deferred typed-data task before signing", () => {
  const vector = workflow.vectors[0];

  assert.equal(vector.plan.payload.transactionPlans.length, 1);
  assert.equal(
    vector.plan.payload.requestHash,
    "9b0c4ede6733bb8f0822e381a852b50fa5a8800a93466ef80470ec5fbaf50f4d",
  );
  assert.equal(
    vector.plan.workflowPlanHash,
    "310a55e35c088769556813a770313eab3323364b2dcb62b602d026abd6057540",
  );
  assert.deepEqual(
    vector.plan.payload.transactionPlans[0].plan,
    integration.canonicalTransfer.plan,
  );
  assert.equal(vector.plan.payload.preview.operationKind, "workflow");
  assert.equal(vector.plan.payload.deferredSigningTasks.length, 1);
  assert.deepEqual(vector.plan.payload.deferredSigningTasks[0].source, {
    stepId: "trade",
    output: "transactionIds",
  });
  assert.equal(
    vector.plan.payload.deferredSigningTasks[0].target,
    "/message/txids",
  );
  assert.equal(
    vector.plan.payload.deferredSigningTasks[0].targetType,
    "bytes32[]",
  );
});

test("derives the deferred task only from the finalized upstream bundle", () => {
  const vector = workflow.vectors[0];

  assert.equal(
    vector.derivation.sourceValue[0],
    integration.canonicalTransfer.bundle.transactions[0].txid,
  );
  assert.equal(
    vector.derivation.resolvedEnvelope.message.txids[0],
    integration.canonicalTransfer.bundle.transactions[0].txid,
  );
  assert.equal(
    vector.derivation.digest,
    "ff32b007969a5d543880a9f8e34d48b6707b8c6dd1bb85cd69688addcf63a1d4",
  );
  assert.equal(
    validateDeferredDerivation(
      vector.request,
      vector.plan,
      vector.derivation,
      { trade: integration.canonicalTransfer.bundle },
    ),
    vector.derivation,
  );
});

test("rejects a deferred derivation whose declared type does not match its source", () => {
  const vector = structuredClone(workflow.vectors[0]);
  vector.plan.payload.deferredSigningTasks[0].targetType = "bytes32";

  assert.throws(
    () =>
      validateDeferredDerivation(
        vector.request,
        vector.plan,
        vector.derivation,
        { trade: integration.canonicalTransfer.bundle },
      ),
    /DEFERRED_TARGET_TYPE_MISMATCH/,
  );
});

test("workflow terminal failure cannot contain partial step results or signatures", () => {
  assert.deepEqual(workflow.terminalFailure, {
    version: "1.0",
    state: "failed",
    error: {
      code: -32603,
      message: "Workflow failed before atomic result commit",
      data: { reason: "DEFERRED_DERIVATION_INVALID" },
    },
  });
  assert.equal("steps" in workflow.terminalFailure, false);
  assert.equal("signatures" in workflow.terminalFailure, false);
});
