import assert from "node:assert/strict";
import test from "node:test";
import * as lifecycle from "../scripts/lib/lifecycle-conformance.mjs";
import { readJson, repositoryRoot } from "../scripts/lib/repository.mjs";

const root = repositoryRoot(import.meta.url);
const vectors = readJson(root, "test-vectors/checkpoints.json");
const checkpoints = lifecycle.materializeCheckpoints(vectors);
const byId = new Map(
  checkpoints.map((vector) => [vector.id, vector.checkpoint]),
);

test("uses exactly four transition branches", () => {
  assert.deepEqual(
    [
      ...new Set(
        lifecycle
          .materializeTransitions(vectors, checkpoints)
          .map((vector) => vector.transition.kind),
      ),
    ].sort(),
    ["commit", "complete", "continue", "waiting"],
  );
});

test("requires a response only for pending calls", () => {
  assert.equal(typeof lifecycle.validateResumeMode, "function");
  assert.throws(
    () => lifecycle.validateResumeMode({ checkpoint: byId.get("initializing") }),
    /RESPONSE_REQUIRED/,
  );
  assert.throws(
    () =>
      lifecycle.validateResumeMode({
        checkpoint: byId.get("validating"),
        response: {
          version: "1.0",
          callId: "etIjrXRWdnGta84eKtv6Ixg4_lqK8aS0zIXlWDcSZDY",
          result: { now: "2026-08-31T12:00:00Z" },
        },
      }),
    /UNEXPECTED_RESPONSE/,
  );
  assert.doesNotThrow(() =>
    lifecycle.validateResumeMode({ checkpoint: byId.get("validating") }),
  );
  assert.throws(
    () => lifecycle.validateResumeMode({ checkpoint: byId.get("completed") }),
    /TERMINAL_STATE_RESUME/,
  );
});

test("represents fail-closed terminal states before the first clock result", () => {
  assert.equal(typeof lifecycle.materializePreClockTerminals, "function");
  const terminals = lifecycle.materializePreClockTerminals(vectors);
  assert.deepEqual(
    terminals.map((vector) => vector.checkpoint.payload.state).sort(),
    ["cancelled", "failed"],
  );
  for (const vector of terminals) {
    const { payload } = vector.checkpoint;
    assert.equal(payload.revision, "1");
    assert.equal(payload.previousCheckpointHash, byId.get("initializing").checkpointHash);
    assert.equal(payload.pendingCalls.length, 0);
    assert.equal("createdAt" in payload, false);
    assert.equal("updatedAt" in payload, false);
    assert.equal("expiresAt" in payload, false);
    assert.doesNotThrow(() => lifecycle.validateCheckpointClosure(vector.checkpoint));
  }
});
