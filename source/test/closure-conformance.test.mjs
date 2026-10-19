import assert from "node:assert/strict";
import test from "node:test";
import * as closure from "../scripts/lib/closure-conformance.mjs";
import {
  materializeCheckpoints,
  validateCheckpointClosure,
} from "../scripts/lib/lifecycle-conformance.mjs";
import { readJson, repositoryRoot } from "../scripts/lib/repository.mjs";

const root = repositoryRoot(import.meta.url);

test("runs executable closure as a first-class profile", () => {
  assert.deepEqual(closure.runClosureConformance(root), {
    methods: 22,
    methodCategories: 12,
    authorityCases: 8,
    resumeModes: 4,
    selfContainedCheckpoints: 5,
    pendingResponseOrders: 6,
    memoryMutationsRejected: 8,
    preClockTerminals: 2,
  });
});

test("consumes one pending response while retaining every other call", () => {
  const vectors = readJson(root, "test-vectors/core-closure.json");
  const checkpoint = structuredClone(vectors.pendingCheckpoint);
  const original = structuredClone(checkpoint);
  const result = closure.consumePendingResponse(
    checkpoint,
    vectors.pendingResponses.middle,
  );

  assert.equal(result.disposition, "accept");
  assert.equal(result.checkpoint.payload.pendingCalls.length, 2);
  assert.deepEqual(
    result.checkpoint.payload.pendingCalls.map(({ callId }) => callId),
    [
      vectors.pendingResponses.first.callId,
      vectors.pendingResponses.last.callId,
    ],
  );
  assert.deepEqual(checkpoint, original);
});

test("accepts an append-only checkpoint advance and rejects approval replacement", () => {
  const lifecycle = readJson(root, "test-vectors/checkpoints.json");
  const checkpoints = materializeCheckpoints(lifecycle);
  const byId = new Map(
    checkpoints.map((vector) => [vector.id, vector.checkpoint]),
  );
  assert.doesNotThrow(() =>
    closure.validateCheckpointAdvance(
      byId.get("approval"),
      byId.get("signing"),
    ),
  );

  const replaced = structuredClone(byId.get("signing"));
  replaced.payload.memory.approvalBinding.bindingHash =
    "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
  assert.throws(
    () => closure.validateCheckpointAdvance(byId.get("approval"), replaced),
    /MEMORY_IMMUTABLE_CHANGED:approvalBinding/,
  );

  const missingPlan = structuredClone(byId.get("signing"));
  delete missingPlan.payload.memory.executionPlan;
  assert.throws(
    () => closure.validateCheckpointAdvance(byId.get("approval"), missingPlan),
    /MEMORY_FIELD_REMOVED:executionPlan/,
  );

  const extendedExpiry = structuredClone(byId.get("signing"));
  extendedExpiry.payload.expiresAt = "2026-08-31T12:03:00Z";
  assert.throws(
    () => closure.validateCheckpointAdvance(byId.get("approval"), extendedExpiry),
    /EXPIRY_EXTENSION_FORBIDDEN/,
  );
});

test("rejects a permission operation disguised as a Provider Session commit", () => {
  const lifecycle = readJson(root, "test-vectors/checkpoints.json");
  const checkpoint = structuredClone(
    materializeCheckpoints(lifecycle)
      .find(({ id }) => id === "committing").checkpoint,
  );
  checkpoint.payload.operation = {
    method: "wallet_requestPermissions",
    params: readJson(root, "test-vectors/permissions.json").request,
  };

  assert.throws(
    () => validateCheckpointClosure(checkpoint),
    /COMMITTING_KIND_MISMATCH/,
  );
});
