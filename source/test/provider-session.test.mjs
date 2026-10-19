import assert from "node:assert/strict";
import test from "node:test";
import {
  applyProviderSessionMutation,
  deriveCommitId,
  evaluateCommitReplay,
  runProviderSessionConformance,
} from "../scripts/lib/provider-session-conformance.mjs";
import { readJson, repositoryRoot } from "../scripts/lib/repository.mjs";

const root = repositoryRoot(import.meta.url);
const vectors = readJson(root, "test-vectors/provider.json");
const sessions = vectors.providerSessions;

test("isolates active chain by wallet profile and Trusted Context session", () => {
  assert.notDeepEqual(sessions.sessionA.scope, sessions.sessionB.scope);

  const switched = applyProviderSessionMutation(
    sessions.sessionA,
    sessions.switchA,
  );
  assert.equal(switched.activeChainId, sessions.chainB);
  assert.equal(sessions.sessionB.state.activeChainId, sessions.chainA);
});

test("derives and binds one deterministic commit id", () => {
  assert.equal(
    deriveCommitId(sessions.commitId.input),
    sessions.switchA.commitId,
  );
  assert.equal(
    sessions.switchA.commitId,
    "KtfmSX2l0hJ0hW6xqJsNSbAny3RFZZIIh5vJZeIMeqo",
  );
});

test("persists CAS acknowledgment before Core completion and event delivery", () => {
  assert.deepEqual(sessions.switchLifecycle.map((step) => step.kind), [
    "transition:commit",
    "host:cas",
    "host:persist-ack",
    "core:acknowledgeCommit",
    "transition:complete",
    "host:emit-events",
  ]);
  assert.deepEqual(
    sessions.switchA.payload.events,
    sessions.switchCompletion.events,
  );
});

test("replays one durable Ack and rejects a commitId payload collision", () => {
  const exact = evaluateCommitReplay(sessions, sessions.commitReplay.exact);
  assert.deepEqual(exact.ack, sessions.commitReplay.exact.firstAck);
  assert.equal(exact.casWrites, 1);

  const collision = evaluateCommitReplay(
    sessions,
    sessions.commitReplay.collision,
  );
  assert.equal(collision.error, "CONFLICT");
  assert.equal(collision.casWrites, 1);
  assert.deepEqual(collision.events, []);
});

test("completes a switch no-op and disconnect without a session mutation", () => {
  assert.equal(sessions.switchNoop.approvalRequested, false);
  assert.equal(sessions.switchNoop.mutation, null);
  assert.deepEqual(sessions.switchNoop.events, []);
  assert.equal(sessions.disconnect.sessionMutation, null);
  assert.equal(sessions.disconnect.permissionCommit.params.changes.length, 2);
});

test("validates the complete Provider Session commit profile", () => {
  assert.deepEqual(runProviderSessionConformance(root), {
    sessions: 2,
    mutations: 1,
    commitAcks: 1,
    commitReplays: 2,
    lifecycleSteps: 6,
    noops: 1,
    disconnects: 1,
    failures: 4,
  });
});
