import assert from "node:assert/strict";
import test from "node:test";
import * as lifecycle from "../scripts/lib/lifecycle-conformance.mjs";
import { readJson, repositoryRoot } from "../scripts/lib/repository.mjs";

const root = repositoryRoot(import.meta.url);
const vectors = readJson(root, "test-vectors/checkpoints.json");

function checkpointFor(state) {
  return lifecycle
    .materializeCheckpoints(vectors)
    .find((vector) => vector.id === state)?.checkpoint;
}

test("keeps every later-stage dependency in one current checkpoint", () => {
  assert.equal(typeof lifecycle.validateCheckpointClosure, "function");

  const approval = checkpointFor("approval");
  assert.ok(approval.payload.session);
  assert.ok(approval.payload.memory.normalizedTransaction);
  assert.ok(approval.payload.memory.chainSnapshot);
  assert.ok(approval.payload.memory.executionPolicy);
  assert.ok(approval.payload.memory.executionPlan);
  assert.ok(approval.payload.memory.approvalBinding);
  assert.doesNotThrow(() => lifecycle.validateCheckpointClosure(approval));

  const finalizing = checkpointFor("finalizing");
  assert.ok(finalizing.payload.memory.approvalReceipt);
  assert.ok(finalizing.payload.memory.signatures.length > 0);
  assert.doesNotThrow(() => lifecycle.validateCheckpointClosure(finalizing));
});

test("retains permission revisions and partial broadcast progress", () => {
  const authorizing = checkpointFor("authorizing");
  assert.ok(authorizing.payload.memory, "OperationMemory is missing");
  assert.equal(
    authorizing.payload.memory.permissionLoads[0].result.revision,
    "3",
  );

  const reconciliation = checkpointFor("reconciliation");
  assert.deepEqual(
    reconciliation.payload.memory.broadcastProgress.submittedTransactionIds,
    ["e715bbe7ea8e6e95ff339b24e1e2aaff8771e8e17af4682b775919fad953c907"],
  );
  assert.doesNotThrow(() => lifecycle.validateCheckpointClosure(reconciliation));
});

test("fails when a transaction checkpoint loses an approved plan", () => {
  const approval = structuredClone(checkpointFor("approval"));
  assert.ok(approval.payload.memory, "OperationMemory is missing");
  delete approval.payload.memory.executionPlan;

  assert.throws(
    () => lifecycle.validateCheckpointClosure(approval),
    /CHECKPOINT_MEMORY_MISSING:executionPlan/,
  );
});
