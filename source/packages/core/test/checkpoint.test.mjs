import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  materializeCheckpoints,
  materializePreClockTerminals,
} from "../../../scripts/lib/lifecycle-conformance.mjs";
import * as core from "../dist/esm/index.js";

const lifecycle = JSON.parse(
  await readFile(
    new URL("../../../test-vectors/checkpoints.json", import.meta.url),
    "utf8",
  ),
);
const checkpoints = materializeCheckpoints(lifecycle);
const preClock = materializePreClockTerminals(lifecycle, checkpoints);
const byId = new Map(checkpoints.map((entry) => [entry.id, entry.checkpoint]));
const vectorRelease = lifecycle.fixture.basePayload.release;

test("checkpoint kernel reproduces hashes and returns a deeply frozen clone", () => {
  const source = byId.get("initializing");
  const created = core.createCheckpoint(source.payload);

  assert.deepEqual(created, source);
  assert.notEqual(created, source);
  assert.ok(Object.isFrozen(created));
  assert.ok(Object.isFrozen(created.payload));
  assert.ok(Object.isFrozen(created.payload.pendingCalls));
  assert.throws(() => {
    created.payload.pendingCalls.push({});
  }, TypeError);
  assert.deepEqual(core.verifyCheckpoint(created, vectorRelease), created);
});

test("checkpoint kernel verifies internal release, context, operation, and call bindings", () => {
  const source = byId.get("initializing");
  assert.throws(
    () => core.verifyCheckpoint(source),
    (error) => error instanceof core.TwsCheckpointError && error.code === "RELEASE_MISMATCH",
  );

  for (const [field, value, code] of [
    ["releaseFingerprint", "f".repeat(64), "RELEASE_FINGERPRINT_MISMATCH"],
    ["contextHash", "f".repeat(64), "CONTEXT_HASH_MISMATCH"],
    ["operationId", "A".repeat(43), "OPERATION_ID_MISMATCH"],
  ]) {
    const payload = structuredClone(source.payload);
    payload[field] = value;
    const checkpoint = {
      payload,
      checkpointHash: core.hashCanonical(payload),
    };
    assert.throws(
      () => core.verifyCheckpoint(checkpoint, vectorRelease),
      (error) => error instanceof core.TwsCheckpointError && error.code === code,
      field,
    );
  }

  const changedCall = structuredClone(source);
  changedCall.payload.pendingCalls[0].callId = "A".repeat(43);
  changedCall.checkpointHash = core.hashCanonical(changedCall.payload);
  assert.throws(
    () => core.verifyCheckpoint(changedCall, vectorRelease),
    (error) => error instanceof core.TwsCheckpointError && error.code === "CALL_ID_MISMATCH",
  );
});

test("checkpoint kernel rejects schema drift and terminal pending effects", () => {
  const source = byId.get("initializing");
  assert.throws(
    () => core.createCheckpoint({ ...source.payload, hiddenState: true }),
    core.TwsValidationError,
  );

  const terminal = structuredClone(byId.get("completed").payload);
  terminal.pendingCalls = structuredClone(source.payload.pendingCalls);
  assert.throws(() => core.createCheckpoint(terminal), core.TwsValidationError);
});

test("checkpoint kernel enforces predecessor, revision, and immutable memory", () => {
  const planning = byId.get("planning");
  const approval = byId.get("approval");
  assert.deepEqual(
    core.advanceCheckpoint(planning, approval.payload, vectorRelease),
    approval,
  );

  const staleRevision = structuredClone(approval.payload);
  staleRevision.revision = planning.payload.revision;
  assert.throws(
    () => core.advanceCheckpoint(planning, staleRevision, vectorRelease),
    (error) => error instanceof core.TwsCheckpointError && error.code === "REVISION_NOT_MONOTONIC",
  );

  const brokenPredecessor = structuredClone(approval.payload);
  brokenPredecessor.previousCheckpointHash = "f".repeat(64);
  assert.throws(
    () => core.advanceCheckpoint(planning, brokenPredecessor, vectorRelease),
    (error) => error instanceof core.TwsCheckpointError && error.code === "PREDECESSOR_MISMATCH",
  );

  const alteredMemory = structuredClone(approval.payload);
  alteredMemory.memory.executionPolicy.payload.allowUnconfirmed =
    !alteredMemory.memory.executionPolicy.payload.allowUnconfirmed;
  assert.throws(
    () => core.advanceCheckpoint(planning, alteredMemory, vectorRelease),
    (error) => error instanceof core.TwsCheckpointError && error.code === "MEMORY_NOT_MONOTONIC",
  );
});

test("checkpoint kernel accepts only the two frozen pre-clock terminal shapes", () => {
  assert.equal(preClock.length, 2);
  for (const { checkpoint } of preClock) {
    assert.deepEqual(core.verifyCheckpoint(checkpoint, vectorRelease), checkpoint);
    assert.equal("createdAt" in checkpoint.payload, false);
    assert.deepEqual(checkpoint.payload.pendingCalls, []);
  }
});
