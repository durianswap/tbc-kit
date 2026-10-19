import assert from "node:assert/strict";
import test from "node:test";
import { indexedDB } from "fake-indexeddb";
import {
  createMemoryTwsHostStore,
  createTwsHost,
} from "../dist/esm/index.js";
import { createIndexedDbTwsHostStore } from "../dist/esm/indexeddb.js";
import { createPortCrashScenarios } from "./fixtures/port-scenarios.mjs";
import { TEST_LEASE_SCHEDULER } from "./fixtures/lease-scheduler.mjs";

const OPERATIONS = [
  "accounts.resolve",
  "chainData.resolve",
  "policy.resolve",
  "permissionStore.load",
  "permissionStore.commit",
  "approval.request",
  "signer.sign",
  "broadcast.submit",
  "broadcast.reconcile",
  "clock.now",
];

const WINDOWS = [
  ["after-intent-before-uncertain", "prepared"],
  ["after-effect-before-response", "uncertain"],
  ["after-response-before-resume", "completed"],
];

const scenarios = await createPortCrashScenarios();
let indexedDbOrdinal = 0;
const ADAPTERS = [
  {
    name: "Memory",
    createStore: () => createMemoryTwsHostStore(),
  },
  {
    name: "IndexedDB",
    createStore: () => {
      indexedDbOrdinal += 1;
      return createIndexedDbTwsHostStore({
        factory: indexedDB,
        databaseName: `tws-host-crash-matrix-${String(indexedDbOrdinal)}`,
      });
    },
  },
];

function scenarioFor(operation) {
  if (operation === "permissionStore.commit") return scenarios.permission;
  return scenarios.transaction;
}

function targetTransition(scenario, operation) {
  const index = scenario.transitions.findIndex(
    (transition) =>
      transition.kind === "waiting" &&
      transition.calls.some((call) => call.operation === operation),
  );
  assert.notEqual(index, -1, `missing real Core call for ${operation}`);
  const transition = scenario.transitions[index];
  return {
    index,
    transition,
    call: transition.calls.find((call) => call.operation === operation),
  };
}

async function seed(store, scenario, throughIndex) {
  const operationId = scenario.transitions[0].checkpoint.payload.operationId;
  const lease = await store.acquireLease({
    operationId,
    ownerId: "crash-seed-owner",
    ttlMs: 60_000,
  });
  let record = null;
  for (const transition of scenario.transitions.slice(0, throughIndex + 1)) {
    const committed = await store.commitTransition({
      lease,
      expected: record === null
        ? null
        : {
            storeRevision: record.storeRevision,
            checkpointHash: record.checkpointHash,
          },
      transition,
    });
    record = committed.operation;
  }
  await store.releaseLease({ lease });
  return operationId;
}

function makeIdempotentPorts(scenario) {
  const attempts = new Map();
  const logicalEffects = new Map();
  const responses = new Map();
  const invoke = async (call) => {
    attempts.set(call.callId, (attempts.get(call.callId) ?? 0) + 1);
    if (!responses.has(call.callId)) {
      logicalEffects.set(call.callId, (logicalEffects.get(call.callId) ?? 0) + 1);
      responses.set(call.callId, structuredClone(scenario.resultForCall(call)));
    }
    return structuredClone(responses.get(call.callId));
  };
  return {
    ports: Object.freeze({
      accounts: invoke,
      chainData: invoke,
      policy: invoke,
      permissionStore: invoke,
      approval: invoke,
      signer: invoke,
      broadcast: invoke,
      clock: invoke,
      entropy: invoke,
    }),
    attempts,
    logicalEffects,
  };
}

function authoritySource(scenario) {
  return Object.freeze({
    read: async () => structuredClone(scenario.authority),
    compareAndSwapSession: async () => {
      throw new Error("Port crash scenarios do not mutate Provider Session authority");
    },
  });
}

function crashStore(store, callId, window, state) {
  if (window === "after-intent-before-uncertain") {
    return Object.freeze({
      ...store,
      markCallUncertain: async (input) => {
        if (!state.crashed && input.call.callId === callId) {
          state.crashed = true;
          throw new Error("simulated process termination before uncertain write");
        }
        return store.markCallUncertain(input);
      },
    });
  }
  if (window === "after-effect-before-response") {
    return Object.freeze({
      ...store,
      completeCall: async (input) => {
        if (!state.crashed && input.call.callId === callId) {
          state.crashed = true;
          throw new Error("simulated process termination before response write");
        }
        return store.completeCall(input);
      },
    });
  }
  return store;
}

function crashCore(core, callId, window, state) {
  if (window !== "after-response-before-resume") return core;
  return Object.freeze({
    ...core,
    resume: async (input) => {
      if (!state.crashed && input.response?.callId === callId) {
        state.crashed = true;
        throw new Error("simulated process termination before Core resume");
      }
      return core.resume(input);
    },
  });
}

function host({ core, store, scenario, ports, ownerId }) {
  return createTwsHost({
    core,
    store,
    ports,
    authority: authoritySource(scenario),
    ownerId,
    ...TEST_LEASE_SCHEDULER,
  });
}

for (const adapter of ADAPTERS) {
  for (const operation of OPERATIONS) {
    for (const [window, expectedStatus] of WINDOWS) {
      test(`${adapter.name} ${operation}: recovers ${window} with the identical callId`, async () => {
      const scenario = scenarioFor(operation);
      const target = targetTransition(scenario, operation);
      const store = adapter.createStore();
      const operationId = await seed(store, scenario, target.index);
      const idempotent = makeIdempotentPorts(scenario);
      const state = { crashed: false };
      const first = host({
        core: crashCore(scenario.createCore(), target.call.callId, window, state),
        store: crashStore(store, target.call.callId, window, state),
        scenario,
        ports: idempotent.ports,
        ownerId: `crash-first-${operation}-${window}`,
      });

      const interrupted = await first.resumeOperation({ operationId });
      assert.equal(interrupted.status, "failed");
      assert.equal(state.crashed, true);
      assert.equal((await store.readCall(target.call.callId)).status, expectedStatus);

      const recovered = host({
        core: scenario.createCore(),
        store,
        scenario,
        ports: idempotent.ports,
        ownerId: `crash-recovery-${operation}-${window}`,
      });
      const result = await recovered.resumeOperation({ operationId });
      assert.equal(result.status, "complete");
      assert.equal((await store.readCall(target.call.callId)).status, "completed");
      assert.equal(idempotent.logicalEffects.get(target.call.callId), 1);
      const expectedAttempts = window === "after-effect-before-response" ? 2 : 1;
      assert.equal(idempotent.attempts.get(target.call.callId), expectedAttempts);
      });
    }
  }
}

test("signer and broadcast crash recovery never create a replacement effect identity", async () => {
  for (const operation of ["signer.sign", "broadcast.submit"]) {
    const scenario = scenarioFor(operation);
    const target = targetTransition(scenario, operation);
    const store = createMemoryTwsHostStore();
    const operationId = await seed(store, scenario, target.index);
    const idempotent = makeIdempotentPorts(scenario);
    const state = { crashed: false };
    const interruptedHost = host({
      core: scenario.createCore(),
      store: crashStore(
        store,
        target.call.callId,
        "after-effect-before-response",
        state,
      ),
      scenario,
      ports: idempotent.ports,
      ownerId: `sensitive-first-${operation}`,
    });
    assert.equal(
      (await interruptedHost.resumeOperation({ operationId })).status,
      "failed",
    );

    const recoveredHost = host({
      core: scenario.createCore(),
      store,
      scenario,
      ports: idempotent.ports,
      ownerId: `sensitive-recovery-${operation}`,
    });
    assert.equal(
      (await recoveredHost.resumeOperation({ operationId })).status,
      "complete",
    );
    assert.equal(idempotent.logicalEffects.get(target.call.callId), 1);
    assert.equal(idempotent.attempts.get(target.call.callId), 2);
  }
});

test("a corrupt completed journal fails closed without invoking the Port", async () => {
  const scenario = scenarios.transaction;
  const target = targetTransition(scenario, "clock.now");
  const store = createMemoryTwsHostStore();
  const operationId = await seed(store, scenario, target.index);
  const idempotent = makeIdempotentPorts(scenario);
  const corrupt = Object.freeze({
    ...store,
    readCall: async (callId) => {
      const record = await store.readCall(callId);
      return callId === target.call.callId
        ? { ...record, status: "completed", response: undefined }
        : record;
    },
  });
  const corruptHost = host({
    core: scenario.createCore(),
    store: corrupt,
    scenario,
    ports: idempotent.ports,
    ownerId: "corrupt-journal-owner",
  });

  const result = await corruptHost.resumeOperation({ operationId });
  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "HOST_STORE_CORRUPT");
  assert.equal(idempotent.attempts.get(target.call.callId), undefined);
});
