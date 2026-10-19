import assert from "node:assert/strict";
import test from "node:test";
import {
  computeEffectiveExpiry,
  evaluateCancellation,
  methodPathFor,
  runCancellationConformance,
  runLifecycleCase,
} from "../scripts/lib/cancellation-conformance.mjs";
import {
  materializeCheckpoints,
  validateCheckpointIntegrity,
} from "../scripts/lib/lifecycle-conformance.mjs";
import { readJson, repositoryRoot } from "../scripts/lib/repository.mjs";

const root = repositoryRoot(import.meta.url);
const vectors = readJson(root, "test-vectors/checkpoints.json");
const checkpoints = materializeCheckpoints(vectors);

test("keeps all twelve method paths exact and never broadcasts sign-only", () => {
  assert.equal(vectors.methodLifecycle.expectedCategories.length, 12);
  assert.ok(!methodPathFor(root, "tbc_signTransaction").states.includes("broadcasting"));
  assert.ok(!methodPathFor(root, "tbc_signWorkflow").states.includes("broadcasting"));
  assert.ok(methodPathFor(root, "tbc_sendTransaction").states.includes("broadcasting"));
});

test("caps authorization at five minutes and only narrows expiry", () => {
  const { expiry } = vectors.methodLifecycle;
  assert.equal(computeEffectiveExpiry(expiry.default), expiry.default.expected);
  assert.equal(computeEffectiveExpiry(expiry.narrowed), expiry.narrowed.expected);
  assert.throws(
    () => computeEffectiveExpiry(expiry.attemptedExtension),
    /EXPIRY_EXTENSION_FORBIDDEN/,
  );
});

test("blocks sensitive effects after expiry but reconciles one partial broadcast", () => {
  for (const scenario of vectors.methodLifecycle.expiredForbiddenEffects) {
    assert.deepEqual(runLifecycleCase(root, scenario).effects, []);
  }
  assert.deepEqual(
    runLifecycleCase(
      root,
      vectors.methodLifecycle.expiredPartialBroadcast,
    ).effects,
    ["broadcast.reconcile"],
  );
  assert.deepEqual(
    runLifecycleCase(
      root,
      vectors.methodLifecycle.expiredPartialBroadcastAfterReconcile,
    ).effects,
    [],
  );
});

test("ignores late approval, signer and broadcast responses after cancellation", () => {
  for (const scenario of vectors.methodLifecycle.lateResponses) {
    assert.deepEqual(runLifecycleCase(root, scenario), {
      state: "cancelled",
      revision: scenario.checkpointRevision,
      effects: [],
      responseDisposition: "ignore",
    });
  }
});

test("maps cancellation delivery and errors without inventing a wire response", () => {
  assert.deepEqual(evaluateCancellation(root, "USER_REJECTED", true), {
    terminalState: "rejected",
    delivery: "respond",
    providerCode: 4001,
    executionErrorName: null,
    retryable: false,
  });
  assert.equal(
    evaluateCancellation(root, "REQUEST_ABORTED", true).delivery,
    "suppress",
  );
  assert.deepEqual(
    evaluateCancellation(root, "SNAPSHOT_INVALIDATED", true),
    {
      terminalState: "failed",
      delivery: "respond",
      providerCode: -32000,
      executionErrorName: "CONFLICT",
      retryable: true,
    },
  );
  assert.equal(
    evaluateCancellation(root, "PROTOCOL_RELEASE_CHANGED", false).delivery,
    "suppress",
  );
});

test("maps every authority change to its frozen terminal state", () => {
  for (const scenario of vectors.methodLifecycle.contextChanges) {
    assert.equal(
      evaluateCancellation(root, scenario.reason, true).terminalState,
      scenario.terminalState,
      scenario.id,
    );
  }
});

test("validates checkpoint bindings before interpreting state data", () => {
  const signing = checkpoints.find(({ id }) => id === "signing").checkpoint;
  const approval = checkpoints.find(({ id }) => id === "approval").checkpoint;
  const tampered = structuredClone(signing);
  tampered.payload.data.signingTask.taskId = "";
  assert.throws(
    () =>
      validateCheckpointIntegrity(tampered, {
        previous: approval,
        loadedReleaseFingerprint: signing.payload.releaseFingerprint,
        currentContext: signing.payload.context,
      }),
    /CHECKPOINT_HASH_MISMATCH/,
  );

  const navigated = structuredClone(signing.payload.context);
  navigated.navigationId = "nav-2";
  assert.throws(
    () =>
      validateCheckpointIntegrity(signing, {
        previous: approval,
        loadedReleaseFingerprint: signing.payload.releaseFingerprint,
        currentContext: navigated,
      }),
    /NAVIGATION_CHANGED/,
  );
});

test("refuses to resume all four terminal states", () => {
  for (const scenario of vectors.methodLifecycle.terminalResume) {
    assert.deepEqual(runLifecycleCase(root, scenario), {
      state: scenario.state,
      revision: scenario.checkpointRevision,
      effects: [],
      error: "TERMINAL_STATE_RESUME",
    });
  }
});

test("validates the complete cancellation and expiry profile", () => {
  assert.deepEqual(runCancellationConformance(root), {
    methodPaths: 12,
    cancellations: 11,
    expirySources: 6,
    forbiddenEffects: 7,
    lateResponses: 3,
    contextChanges: 7,
    terminalResumeBlocks: 4,
    lifecycleCases: 13,
  });
});
