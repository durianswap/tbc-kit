import assert from "node:assert/strict";
import test from "node:test";
import {
  deriveCallId,
  deriveOperationId,
  doesResponseAdvance,
  evaluateReplayScenario,
  runReplayConformance,
} from "../scripts/lib/replay-conformance.mjs";
import { readJson, repositoryRoot } from "../scripts/lib/repository.mjs";

const root = repositoryRoot(import.meta.url);
const vectors = readJson(root, "test-vectors/port-replay.json");

test("derives domain-separated operation and call identifiers", () => {
  assert.equal(deriveOperationId(vectors.ids.operation.input), vectors.ids.operation.expected);
  assert.equal(
    vectors.ids.operation.expected,
    "cNB8h3rzetsQsQLJAPDlZ7fn2h9a0VIaXnjAZRQJYsY",
  );
  assert.equal(deriveCallId(vectors.ids.call.input), vectors.ids.call.expected);
  assert.equal(
    vectors.ids.call.expected,
    "1FYldPLoxmyjMXnuM59MMJevCqv3N88DcNZdSpTWbec",
  );
});

test("replays the first durable response without redispatch", () => {
  const scenario = vectors.exactReplays[0];
  const outcome = evaluateReplayScenario(scenario);

  assert.deepEqual(outcome.response, scenario.firstResponse);
  assert.equal(outcome.dispatchCount, 1);
  assert.equal(outcome.journalWrites, 1);
});

test("fails closed when one callId is reused with a different payload", () => {
  const outcome = evaluateReplayScenario(vectors.payloadCollision);

  assert.equal(outcome.response.error.name, "CONFLICT");
  assert.equal(outcome.dispatchCount, 1);
  assert.equal(outcome.terminalState, "failed");
});

test("covers every Host Port operation and all three crash windows", () => {
  assert.equal(new Set(vectors.operationCoverage).size, 15);
  assert.deepEqual(vectors.crashWindows.map((entry) => entry.window), [
    "before-dispatch",
    "after-dispatch-before-response-persist",
    "after-response-persist-before-resume",
  ]);
  assert.deepEqual(vectors.nonAdvancingResponses.map((entry) => entry.kind), [
    "unknown",
    "late",
    "cancelled",
    "duplicate",
    "collision",
  ]);
  for (const entry of vectors.nonAdvancingResponses) {
    assert.equal(doesResponseAdvance(root, entry), false, entry.kind);
  }
});

test("keeps broadcast business idempotency in addition to call replay", () => {
  assert.ok(vectors.broadcastCall.params.idempotencyKey);
  assert.ok(vectors.broadcastCall.callId);
  assert.notEqual(vectors.broadcastCall.params.idempotencyKey, vectors.broadcastCall.callId);
});

test("validates the complete durable replay profile", () => {
  assert.deepEqual(runReplayConformance(root), {
    operations: 15,
    exactReplays: 3,
    crashWindows: 3,
    nonAdvancingResponses: 5,
    idKnownAnswers: 2,
  });
});
