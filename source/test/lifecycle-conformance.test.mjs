import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateLifecycleFailure,
  materializeCheckpoints,
  materializeTransitions,
  runLifecycleConformance,
} from "../scripts/lib/lifecycle-conformance.mjs";
import { readJson, repositoryRoot } from "../scripts/lib/repository.mjs";

const root = repositoryRoot(import.meta.url);
const vectors = readJson(root, "test-vectors/checkpoints.json");
const checkpoints = materializeCheckpoints(vectors);
const transitions = materializeTransitions(vectors, checkpoints);

test("binds one strict checkpoint fixture for every operation state", () => {
  const byState = new Map(
    checkpoints.map((vector) => [vector.checkpoint.payload.state, vector]),
  );

  assert.equal(byState.size, 15);
  assert.equal("createdAt" in byState.get("initializing").checkpoint.payload, false);
  assert.equal("previousCheckpointHash" in byState.get("initializing").checkpoint.payload, false);
  assert.equal(byState.get("initializing").checkpoint.payload.revision, "0");
  assert.equal(
    byState.get("initializing").checkpoint.payload.pendingCalls[0].operation,
    "clock.now",
  );
  assert.equal(byState.get("initializing").checkpoint.payload.pendingCalls.length, 1);

  for (const [state, vector] of byState) {
    if (state === "initializing") continue;
    assert.ok(vector.checkpoint.payload.createdAt);
    assert.ok(vector.checkpoint.payload.updatedAt);
    assert.ok(vector.checkpoint.payload.expiresAt);
    assert.ok(vector.checkpoint.payload.previousCheckpointHash);
  }
});

test("exposes only the four resumable Core methods and four transition branches", () => {
  assert.deepEqual(vectors.coreSurface, [
    "start",
    "resume",
    "acknowledgeCommit",
    "cancel",
  ]);
  assert.deepEqual(
    [...new Set(transitions.map((vector) => vector.transition.kind))].sort(),
    ["commit", "complete", "continue", "waiting"],
  );
  assert.deepEqual(
    transitions
      .filter((vector) => vector.transition.kind === "complete")
      .map((vector) => vector.transition.completion.delivery)
      .sort(),
    ["respond", "suppress"],
  );
});

test("rejects rollback, broken predecessor, terminal resume and release drift", () => {
  const expected = new Map([
    ["revision-rollback", "CHECKPOINT_REVISION_INVALID"],
    ["previous-hash-break", "CHECKPOINT_CHAIN_INVALID"],
    ["resume-completed", "TERMINAL_STATE_RESUME"],
    ["release-fingerprint-mismatch", "PROTOCOL_RELEASE_CHANGED"],
    ["illegal-state-transition", "STATE_TRANSITION_INVALID"],
    ["expired-signing-effect", "OPERATION_EXPIRED"],
  ]);

  for (const failure of vectors.failures) {
    assert.equal(
      evaluateLifecycleFailure(root, vectors, failure),
      expected.get(failure.id),
      failure.id,
    );
  }
});

test("recomputes hashes, predecessors, state paths and transition payloads", () => {
  assert.deepEqual(runLifecycleConformance(root), {
    coreMethods: 4,
    states: 15,
    terminalStates: 4,
    checkpoints: 15,
    preClockTerminals: 2,
    transitions: 5,
    completionDeliveries: 2,
    failures: 6,
  });
});
