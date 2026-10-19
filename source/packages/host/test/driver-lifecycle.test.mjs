import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  TWS_RELEASE,
  TWS_RELEASE_FINGERPRINT,
  createTwsCore,
  deriveOperationId,
  hashCanonical,
} from "@tbc-wallet/core";
import {
  createMemoryTwsHostStore,
  createTwsHost,
  deriveHostAuthorityIdentity,
  deriveHostCompletionIdentity,
} from "../dist/esm/index.js";
import {
  createCancelledTransitionFlow,
  createStoreTransitionFlow,
} from "./fixtures/store-transitions.mjs";
import { TEST_LEASE_SCHEDULER } from "./fixtures/lease-scheduler.mjs";
import { materializeCheckpoints } from "../../../scripts/lib/lifecycle-conformance.mjs";

const lifecycle = JSON.parse(
  await readFile(
    new URL("../../../test-vectors/checkpoints.json", import.meta.url),
    "utf8",
  ),
);
const prePlanCheckpoint = materializeCheckpoints(lifecycle).find(
  ({ checkpoint }) => checkpoint.payload.state === "planning",
).checkpoint;

const PORT_NAMES = [
  "accounts",
  "chainData",
  "policy",
  "permissionStore",
  "approval",
  "signer",
  "broadcast",
  "clock",
  "entropy",
];

function coreFacade(overrides = {}) {
  const unused = async () => {
    throw new Error("unexpected Core method");
  };
  return Object.freeze({
    start: unused,
    resume: unused,
    acknowledgeCommit: unused,
    cancel: unused,
    ...overrides,
  });
}

function authoritySource(authority) {
  return Object.freeze({
    read: async () => structuredClone(authority),
    compareAndSwapSession: async (input) => ({
      acknowledgment: {
        version: "1.0",
        commitId: input.commitId,
        status: "committed",
        revision: input.mutation.payload.target.revision,
      },
      authority: structuredClone(authority),
    }),
  });
}

function inertPorts() {
  const inert = async () => {
    throw new Error("unexpected Host Port");
  };
  return Object.freeze(
    Object.fromEntries(PORT_NAMES.map((name) => [name, inert])),
  );
}

function startInput(id) {
  return {
    version: "1.0",
    release: TWS_RELEASE,
    request: {
      jsonrpc: "2.0",
      id,
      method: "tbc_switchChain",
      params: { chainId: "tbc:testnet" },
    },
  };
}

async function seed(store, transition, ownerId = "seed-owner") {
  const operationId = transition.checkpoint.payload.operationId;
  const lease = await store.acquireLease({ operationId, ownerId, ttlMs: 60_000 });
  const result = await store.commitTransition({
    lease,
    expected: null,
    transition,
  });
  await store.releaseLease({ lease });
  return result.operation;
}

function makeHost({
  core,
  store,
  authority,
  ownerId = "driver-owner",
  maxSteps,
  ports = inertPorts(),
  deferDeliveryAcknowledgment,
}) {
  return createTwsHost({
    core,
    ports,
    store,
    authority: authoritySource(authority),
    ownerId,
    ...TEST_LEASE_SCHEDULER,
    leaseTtlMs: 30_000,
    ...(maxSteps === undefined ? {} : { maxSteps }),
    ...(deferDeliveryAcknowledgment === undefined
      ? {}
      : { deferDeliveryAcknowledgment }),
  });
}

function rejectingPlanningCore(errorFactory) {
  const unexpected = async () => {
    throw new Error("unexpected Transaction Engine method");
  };
  return createTwsCore({
    transactionEngine: Object.freeze({
      normalizeRequest: unexpected,
      plan: async () => {
        throw errorFactory();
      },
      validate: unexpected,
      finalize: unexpected,
    }),
  });
}

function currentPrePlanCheckpoint() {
  const checkpoint = structuredClone(prePlanCheckpoint);
  checkpoint.payload.release = structuredClone(TWS_RELEASE);
  checkpoint.payload.releaseFingerprint = TWS_RELEASE_FINGERPRINT;
  checkpoint.payload.operationId = deriveOperationId({
    releaseFingerprint: TWS_RELEASE_FINGERPRINT,
    contextHash: checkpoint.payload.contextHash,
    requestId: checkpoint.payload.requestId,
    operation: checkpoint.payload.operation,
  });
  checkpoint.checkpointHash = hashCanonical(checkpoint.payload);
  return checkpoint;
}

function planningAuthority(checkpoint) {
  return {
    currentContext: structuredClone(checkpoint.payload.context),
    currentSession: structuredClone(checkpoint.payload.session),
  };
}

test("recovery terminalizes a deterministic invalid request before signing", async () => {
  const store = createMemoryTwsHostStore();
  const checkpoint = currentPrePlanCheckpoint();
  await seed(store, { kind: "continue", checkpoint });
  const invalidRequest = () => {
    const error = new Error("Pool mint source outpoint is missing");
    error.name = "TbcEngineError";
    error.code = "INVALID_REQUEST";
    return error;
  };
  const host = makeHost({
    core: rejectingPlanningCore(invalidRequest),
    store,
    authority: planningAuthority(checkpoint),
  });

  const recovered = await host.recoverPendingOperations();
  assert.equal(recovered.length, 1);
  assert.equal(
    recovered[0].result.status,
    "complete",
    JSON.stringify(recovered[0].result),
  );
  assert.deepEqual(recovered[0].result.completion.response.error, {
    code: -32602,
    message: "Transaction planning rejected the invalid request",
  });
  assert.deepEqual(await host.recoverPendingOperations(), []);
  const inspection = await host.inspectOperation({
    operationId: checkpoint.payload.operationId,
  });
  assert.deepEqual({
    operationId: inspection.operationId,
    revision: inspection.revision,
    state: inspection.state,
    transitionKind: inspection.transitionKind,
    releaseFingerprint: inspection.releaseFingerprint,
    terminal: inspection.terminal,
  }, {
    operationId: checkpoint.payload.operationId,
    revision: String(Number(checkpoint.payload.revision) + 1),
    state: "failed",
    transitionKind: "complete",
    releaseFingerprint: TWS_RELEASE_FINGERPRINT,
    terminal: true,
  });
  assert.equal(Number.isNaN(Date.parse(inspection.createdAt)), false);
  assert.equal(Number.isNaN(Date.parse(inspection.updatedAt)), false);
});

test("recovery keeps an unclassified planning exception nonterminal", async () => {
  const store = createMemoryTwsHostStore();
  const checkpoint = currentPrePlanCheckpoint();
  await seed(store, { kind: "continue", checkpoint });
  let attempts = 0;
  const host = makeHost({
    core: rejectingPlanningCore(() => {
      attempts += 1;
      return new Error("runtime unavailable");
    }),
    store,
    authority: planningAuthority(checkpoint),
  });

  const first = await host.recoverPendingOperations();
  assert.equal(first[0].result.status, "failed");
  assert.equal((await host.inspectOperation({
    operationId: checkpoint.payload.operationId,
  })).terminal, false);
  const second = await host.recoverPendingOperations();
  assert.equal(second[0].result.status, "failed");
  assert.equal(
    attempts,
    2,
    JSON.stringify([first[0].result, second[0].result]),
  );
});

test("start rejects a changed Authority identity before Core or Port dispatch", async () => {
  const flow = await createStoreTransitionFlow("driver-authority-expectation");
  let starts = 0;
  const changed = structuredClone(flow.authority);
  changed.currentContext.navigationId = "replacement-navigation";
  const host = createTwsHost({
    core: coreFacade({
      start: async () => {
        starts += 1;
        throw new Error("must not start");
      },
    }),
    ports: inertPorts(),
    store: createMemoryTwsHostStore(),
    authority: authoritySource(changed),
    ownerId: "authority-expectation",
    ...TEST_LEASE_SCHEDULER,
  });

  await assert.rejects(
    host.startOperation({
      ...startInput("authority-expectation"),
      expectedAuthorityIdentity: deriveHostAuthorityIdentity(flow.authority),
    }),
    { code: "HOST_AUTHORITY_FAILURE" },
  );
  assert.equal(starts, 0);
});

test("deferred delivery stays recoverable until the transport acknowledges it", async () => {
  const flow = await createStoreTransitionFlow("driver-deferred-delivery");
  const complete = flow.transitions.at(-1);
  const store = createMemoryTwsHostStore();
  const host = makeHost({
    core: coreFacade({ start: async () => structuredClone(complete) }),
    store,
    authority: flow.authority,
    deferDeliveryAcknowledgment: true,
  });

  const first = await host.startOperation(startInput("deferred-delivery"));
  assert.equal(first.status, "complete");
  assert.equal((await store.readDelivery(first.operationId)).status, "pending");
  const recovered = await host.recoverPendingOperations();
  assert.equal(recovered.length, 1);
  assert.deepEqual(recovered[0].result, first);

  const lease = await store.acquireLease({
    operationId: first.operationId,
    ownerId: "transport-acknowledger",
    ttlMs: 30_000,
  });
  await store.markDeliveryDelivered({
    lease,
    operationId: first.operationId,
    deliveryId: first.deliveryId,
    completionIdentity: deriveHostCompletionIdentity(first.completion),
  });
  await store.releaseLease({ lease });
  assert.deepEqual(await host.recoverPendingOperations(), []);
});

test("driver persists, delivers, resumes, and inspects one stable completion", async () => {
  const flow = await createStoreTransitionFlow("driver-stable-completion");
  const complete = flow.transitions.at(-1);
  const store = createMemoryTwsHostStore();
  const host = makeHost({
    core: coreFacade({ start: async () => structuredClone(complete) }),
    store,
    authority: flow.authority,
  });

  const first = await host.startOperation(startInput("ignored-by-fixture-core"));
  assert.equal(first.status, "complete");
  assert.deepEqual(first.completion, complete.completion);
  const delivery = await store.readDelivery(first.operationId);
  assert.equal(delivery.status, "delivered");
  assert.equal(first.deliveryId, delivery.deliveryId);

  const replay = await host.resumeOperation({ operationId: first.operationId });
  assert.deepEqual(replay, first);
  const inspection = await host.inspectOperation({ operationId: first.operationId });
  assert.deepEqual(Object.keys(inspection).sort(), [
    "createdAt",
    "operationId",
    "releaseFingerprint",
    "revision",
    "state",
    "terminal",
    "transitionKind",
    "updatedAt",
  ]);
  assert.equal(inspection.releaseFingerprint, TWS_RELEASE_FINGERPRINT);
  assert.equal(JSON.stringify(inspection).includes("checkpoint"), false);
  assert.equal(JSON.stringify(inspection).includes("signature"), false);
});

test("driver resumes only the authoritative stored checkpoint", async () => {
  const flow = await createStoreTransitionFlow("driver-authoritative-resume");
  const continueIndex = flow.transitions.findIndex(
    (transition) => transition.kind === "continue",
  );
  assert.notEqual(continueIndex, -1);
  const current = flow.transitions[continueIndex];
  const store = createMemoryTwsHostStore();
  await seed(store, current);
  let operationReads = 0;
  const countedStore = {
    ...store,
    async readOperation(operationId) {
      operationReads += 1;
      return store.readOperation(operationId);
    },
  };
  const resumedCheckpointHashes = [];
  const host = makeHost({
    core: coreFacade({
      resume: async (input) => {
        resumedCheckpointHashes.push(input.checkpoint.checkpointHash);
        const index = flow.transitions.findIndex(
          ({ checkpoint }) =>
            checkpoint.checkpointHash === input.checkpoint.checkpointHash,
        );
        return structuredClone(flow.transitions[index + 1]);
      },
      acknowledgeCommit: async () => structuredClone(flow.transitions.at(-1)),
    }),
    store: countedStore,
    authority: flow.authority,
  });

  const result = await host.resumeOperation({ operationId: flow.operationId });
  assert.equal(resumedCheckpointHashes[0], current.checkpoint.checkpointHash);
  assert.equal(result.status, "complete");
  assert.equal(result.revision, flow.transitions.at(-1).checkpoint.payload.revision);
  assert.equal("checkpoint" in result, false);
  // One pre-lease existence check and one fresh post-lease read. Later loop
  // iterations use the record returned by the fenced commit, not another read.
  assert.equal(operationReads, 2);
});

test("driver cancellation goes through Core and preserves its completion delivery", async () => {
  const flow = await createCancelledTransitionFlow("driver-cancel");
  const store = createMemoryTwsHostStore();
  await seed(store, flow.initial);
  let cancellationReason;
  const host = makeHost({
    core: coreFacade({
      cancel: async (input) => {
        cancellationReason = input.reason;
        return structuredClone(flow.cancelled);
      },
    }),
    store,
    authority: flow.authority,
  });

  const result = await host.cancelOperation({
    operationId: flow.initial.checkpoint.payload.operationId,
    reason: "REQUEST_ABORTED",
  });
  assert.equal(cancellationReason, "REQUEST_ABORTED");
  assert.equal(result.status, "cancelled");
  assert.deepEqual(result.completion, flow.cancelled.completion);
  assert.equal((await store.readDelivery(result.operationId)).status, "delivered");
});

test("driver cooperatively applies cancellation queued behind its active lease", async () => {
  const flow = await createCancelledTransitionFlow("driver-cooperative-cancel");
  const store = createMemoryTwsHostStore();
  let releaseClock;
  let clockReached;
  const reachedClock = new Promise((resolve) => {
    clockReached = resolve;
  });
  const clockRelease = new Promise((resolve) => {
    releaseClock = resolve;
  });
  let permissionLoads = 0;
  const ports = {
    ...inertPorts(),
    clock: async () => {
      clockReached();
      await clockRelease;
      return { now: "2026-08-31T12:00:00Z" };
    },
    permissionStore: async () => {
      permissionLoads += 1;
      throw new Error("cancellation must run before the next Host Port");
    },
  };
  const host = makeHost({
    core: createTwsCore(),
    store,
    authority: flow.authority,
    ports,
  });

  const started = host.startOperation(startInput("driver-cooperative-cancel"));
  await reachedClock;
  const queued = await host.cancelOperation({
    operationId: flow.initial.checkpoint.payload.operationId,
    reason: "REQUEST_ABORTED",
  });
  assert.deepEqual(queued, {
    status: "busy",
    operationId: flow.initial.checkpoint.payload.operationId,
    retryable: true,
  });
  releaseClock();

  const result = await started;
  assert.equal(result.status, "cancelled");
  assert.equal(result.completion.cancellationReason, "REQUEST_ABORTED");
  assert.equal(permissionLoads, 0);
  assert.equal((await host.inspectOperation({ operationId: result.operationId })).terminal, true);
});

test("driver preserves cancellation that arrives before the operation journal", async () => {
  const flow = await createCancelledTransitionFlow("driver-prestart-cancel");
  const store = createMemoryTwsHostStore();
  const host = makeHost({
    core: coreFacade({
      start: async () => structuredClone(flow.initial),
      cancel: async () => structuredClone(flow.cancelled),
    }),
    store,
    authority: flow.authority,
  });

  const queued = await host.cancelOperation({
    operationId: flow.initial.checkpoint.payload.operationId,
    reason: "REQUEST_ABORTED",
  });
  assert.deepEqual(queued, {
    status: "busy",
    operationId: flow.initial.checkpoint.payload.operationId,
    retryable: true,
  });

  const result = await host.startOperation(startInput("prestart-cancel"));
  assert.equal(result.status, "cancelled");
  assert.equal(result.completion.cancellationReason, "REQUEST_ABORTED");
});

test("driver reports a busy lease and a scrubbed release mismatch", async () => {
  const flow = await createStoreTransitionFlow("driver-busy");
  const store = createMemoryTwsHostStore();
  const record = await seed(store, flow.transitions[0]);
  const held = await store.acquireLease({
    operationId: flow.operationId,
    ownerId: "other-host",
    ttlMs: 60_000,
  });
  const busyHost = makeHost({
    core: coreFacade(),
    store,
    authority: flow.authority,
  });
  assert.deepEqual(await busyHost.resumeOperation({ operationId: flow.operationId }), {
    status: "busy",
    operationId: flow.operationId,
    retryable: true,
  });
  await store.releaseLease({ lease: held });

  const mismatchedStore = Object.freeze({
    ...store,
    readOperation: async (operationId) => ({
      ...(await store.readOperation(operationId)),
      releaseFingerprint: "0".repeat(64),
    }),
  });
  const mismatchHost = makeHost({
    core: coreFacade(),
    store: mismatchedStore,
    authority: flow.authority,
  });
  const mismatch = await mismatchHost.resumeOperation({
    operationId: record.operationId,
  });
  assert.equal(mismatch.status, "failed");
  assert.deepEqual(mismatch.error, {
    code: "HOST_RELEASE_MISMATCH",
    message: "The stored operation uses a different TWS release.",
    retryable: false,
    metadata: { operationId: record.operationId },
  });
});

test("driver bounds transition loops and recovery uses the same lifecycle", async () => {
  const bounded = await createStoreTransitionFlow("driver-step-bound");
  const continueIndex = bounded.transitions.findIndex(
    (transition) => transition.kind === "continue",
  );
  const boundedStore = createMemoryTwsHostStore();
  await seed(boundedStore, bounded.transitions[continueIndex]);
  const boundedHost = makeHost({
    core: coreFacade({
      resume: async () => structuredClone(bounded.transitions[continueIndex + 1]),
    }),
    store: boundedStore,
    authority: bounded.authority,
    maxSteps: 1,
  });
  const boundedResult = await boundedHost.resumeOperation({
    operationId: bounded.operationId,
  });
  assert.equal(boundedResult.status, "failed");
  assert.equal(boundedResult.error.code, "HOST_STEP_LIMIT");

  const recovery = await createStoreTransitionFlow("driver-recovery");
  const recoveryIndex = recovery.transitions.findIndex(
    (transition) => transition.kind === "continue",
  );
  const recoveryStore = createMemoryTwsHostStore();
  await seed(recoveryStore, recovery.transitions[recoveryIndex]);
  const recoveryHost = makeHost({
    core: coreFacade({
      resume: async (input) => {
        const index = recovery.transitions.findIndex(
          ({ checkpoint }) =>
            checkpoint.checkpointHash === input.checkpoint.checkpointHash,
        );
        return structuredClone(recovery.transitions[index + 1]);
      },
      acknowledgeCommit: async () => structuredClone(recovery.transitions.at(-1)),
    }),
    store: recoveryStore,
    authority: recovery.authority,
  });
  const recovered = await recoveryHost.recoverPendingOperations();
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].operationId, recovery.operationId);
  assert.equal(recovered[0].result.status, "complete");
});
