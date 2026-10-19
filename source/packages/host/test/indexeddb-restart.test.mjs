import assert from "node:assert/strict";
import test from "node:test";
import { indexedDB } from "fake-indexeddb";
import { createIndexedDbTwsHostStore } from "../dist/esm/indexeddb.js";
import { TWS_HOST_INDEXEDDB_STORES } from "../dist/esm/indexeddb.js";
import { createStoreTransitionFlow } from "./fixtures/store-transitions.mjs";
import { createPortCrashScenarios } from "./fixtures/port-scenarios.mjs";
import { TEST_LEASE_SCHEDULER } from "./fixtures/lease-scheduler.mjs";

function createStore(databaseName, now) {
  return createIndexedDbTwsHostStore({ factory: indexedDB, databaseName, now });
}

test("IndexedDB reopens the same durable operation across service-worker instances", async () => {
  const clock = { value: Date.parse("2026-09-01T00:00:00Z") };
  const databaseName = "tws-host-indexeddb-reopen";
  const flow = await createStoreTransitionFlow("indexeddb-reopen-flow");
  const first = createStore(databaseName, () => clock.value);
  const firstLease = await first.acquireLease({
    operationId: flow.operationId,
    ownerId: "service-worker-a",
    ttlMs: 10_000,
  });
  const initial = await first.commitTransition({
    lease: firstLease,
    expected: null,
    transition: flow.transitions[0],
  });
  await first.releaseLease({ lease: firstLease });

  const reopened = createStore(databaseName, () => clock.value);
  assert.deepEqual(await reopened.readOperation(flow.operationId), initial.operation);
  assert.deepEqual(
    await reopened.readCall(flow.transitions[0].calls[0].callId),
    initial.calls[0],
  );
  const secondLease = await reopened.acquireLease({
    operationId: flow.operationId,
    ownerId: "service-worker-b",
    ttlMs: 10_000,
  });
  const next = await reopened.commitTransition({
    lease: secondLease,
    expected: {
      storeRevision: initial.operation.storeRevision,
      checkpointHash: initial.operation.checkpointHash,
    },
    transition: flow.transitions[1],
  });
  assert.equal(next.operation.storeRevision, "1");
});

test("two IndexedDB connections serialize lease ownership and fence a stale writer", async () => {
  const clock = { value: Date.parse("2026-09-01T00:00:00Z") };
  const databaseName = "tws-host-indexeddb-two-connections";
  const first = createStore(databaseName, () => clock.value);
  const second = createStore(databaseName, () => clock.value);
  const [left, right] = await Promise.all([
    first.acquireLease({
      operationId: "indexeddb-shared-lease",
      ownerId: "connection-a",
      ttlMs: 1_000,
    }),
    second.acquireLease({
      operationId: "indexeddb-shared-lease",
      ownerId: "connection-b",
      ttlMs: 1_000,
    }),
  ]);
  assert.equal([left, right].filter(Boolean).length, 1);
  const winner = left ?? right;
  const loserStore = left === null ? first : second;

  clock.value += 1_001;
  const takeover = await loserStore.acquireLease({
    operationId: "indexeddb-shared-lease",
    ownerId: "connection-takeover",
    ttlMs: 1_000,
  });
  assert.equal(takeover.fencingToken, "2");
  await assert.rejects(
    first.renewLease({ lease: winner, ttlMs: 1_000 }),
    (error) => error?.code === "HOST_STORE_CONFLICT",
  );
});

function openRaw(databaseName) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
    transaction.onerror = () => reject(transaction.error);
  });
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function readRaw(database, storeName, key) {
  const transaction = database.transaction([storeName], "readonly");
  const value = await requestResult(transaction.objectStore(storeName).get(key));
  await transactionDone(transaction);
  return value;
}

async function writeRaw(database, storeName, value) {
  const transaction = database.transaction([storeName], "readwrite");
  await requestResult(transaction.objectStore(storeName).put(value));
  await transactionDone(transaction);
}

test("IndexedDB creates the five explicit stores and rejects corrupted persisted records", async () => {
  const databaseName = "tws-host-indexeddb-corruption";
  const store = createStore(databaseName, () => Date.parse("2026-09-01T00:00:00Z"));
  assert.equal(await store.readOperation("missing-before-corruption"), null);
  const database = await openRaw(databaseName);
  assert.deepEqual(
    [...database.objectStoreNames].sort(),
    [...TWS_HOST_INDEXEDDB_STORES].sort(),
  );
  const write = database.transaction(["operations"], "readwrite");
  write.objectStore("operations").put({
    operationId: "corrupted-operation",
    transition: { kind: "waiting" },
  });
  await transactionDone(write);

  await assert.rejects(
    store.readOperation("corrupted-operation"),
    (error) => error?.code === "HOST_STORE_CORRUPT",
  );

  await writeRaw(database, "leases", {
    key: "counter:orphan-counter-operation",
    kind: "counter",
    value: "5",
  });
  await assert.rejects(
    store.acquireLease({
      operationId: "orphan-counter-operation",
      ownerId: "owner-a",
      ttlMs: 1_000,
    }),
    (error) => error?.code === "HOST_STORE_CORRUPT",
  );
});

test("IndexedDB fails closed on impossible operation, call, and session journal states", async () => {
  const databaseName = "tws-host-indexeddb-impossible-journal-states";
  const store = createStore(databaseName, () => Date.parse("2026-09-01T00:00:00Z"));
  const flow = await createStoreTransitionFlow("indexeddb-impossible-journal-states");
  const lease = await store.acquireLease({
    operationId: flow.operationId,
    ownerId: "indexeddb-corruption-seed",
    ttlMs: 60_000,
  });
  let operation = null;
  let call;

  for (const transition of flow.transitions) {
    if (transition.kind === "complete") break;
    const committed = await store.commitTransition({
      lease,
      expected: operation === null
        ? null
        : {
            storeRevision: operation.storeRevision,
            checkpointHash: operation.checkpointHash,
          },
      transition,
    });
    operation = committed.operation;
    if (call === undefined && committed.calls.length > 0) {
      call = committed.calls[0].call;
      await store.markCallUncertain({ lease, call });
      await store.completeCall({
        lease,
        call,
        response: {
          version: "1.0",
          callId: call.callId,
          result: { now: "2026-08-31T12:00:00Z" },
        },
      });
    }
    if (committed.sessionCommit !== undefined) {
      await store.markSessionCommitUncertain({
        lease,
        mutation: flow.mutation,
      });
      await store.completeSessionCommit({
        lease,
        mutation: flow.mutation,
        acknowledgment: flow.acknowledgment,
        authority: flow.authority,
      });
    }
  }

  assert.ok(call);
  assert.equal(operation.terminal, false);
  const database = await openRaw(databaseName);
  const callRecord = await readRaw(database, "calls", call.callId);
  const sessionRecord = await readRaw(
    database,
    "sessionCommits",
    flow.mutation.commitId,
  );
  const operationRecord = await readRaw(database, "operations", flow.operationId);
  await writeRaw(database, "calls", { ...callRecord, status: "uncertain" });
  await writeRaw(database, "sessionCommits", {
    ...sessionRecord,
    status: "prepared",
  });
  await writeRaw(database, "operations", { ...operationRecord, terminal: true });

  for (const read of [
    store.readCall(call.callId),
    store.readSessionCommit(flow.mutation.commitId),
    store.readOperation(flow.operationId),
  ]) {
    await assert.rejects(read, (error) => error?.code === "HOST_STORE_CORRUPT");
  }
});

test("IndexedDB fails closed on malformed lease wrappers and counters", async () => {
  const databaseName = "tws-host-indexeddb-corrupt-leases";
  const store = createStore(databaseName, () => Date.parse("2026-09-01T00:00:00Z"));
  assert.equal(await store.readOperation("initialize-corrupt-leases"), null);
  const database = await openRaw(databaseName);
  await writeRaw(database, "leases", {
    key: "lease:bound-operation",
    kind: "lease",
    value: {
      operationId: "different-operation",
      ownerId: "owner-a",
      fencingToken: "1",
      expiresAt: "2026-09-01T00:01:00.000Z",
    },
  });
  await assert.rejects(
    store.acquireLease({
      operationId: "bound-operation",
      ownerId: "owner-b",
      ttlMs: 1_000,
    }),
    (error) => error?.code === "HOST_STORE_CORRUPT",
  );

  await writeRaw(database, "leases", {
    key: "counter:counter-operation",
    kind: "counter",
    value: "-1",
  });
  await assert.rejects(
    store.acquireLease({
      operationId: "counter-operation",
      ownerId: "owner-a",
      ttlMs: 1_000,
    }),
    (error) => error?.code === "HOST_STORE_CORRUPT",
  );
});

test("IndexedDB rejects a canonical counter rollback before it can create a fencing ABA", async () => {
  const clock = { value: Date.parse("2026-09-01T00:00:00Z") };
  const databaseName = "tws-host-indexeddb-counter-rollback";
  const store = createStore(databaseName, () => clock.value);
  const first = await store.acquireLease({
    operationId: "counter-rollback-operation",
    ownerId: "reused-owner",
    ttlMs: 1_000,
  });
  assert.equal(first.fencingToken, "1");
  clock.value += 1_001;
  const second = await store.acquireLease({
    operationId: "counter-rollback-operation",
    ownerId: "takeover-owner",
    ttlMs: 1_000,
  });
  assert.equal(second.fencingToken, "2");
  clock.value += 1_001;

  const database = await openRaw(databaseName);
  await writeRaw(database, "leases", {
    key: "counter:counter-rollback-operation",
    kind: "counter",
    value: "0",
  });
  await assert.rejects(
    store.acquireLease({
      operationId: "counter-rollback-operation",
      ownerId: "reused-owner",
      ttlMs: 1_000,
    }),
    (error) => error?.code === "HOST_STORE_CORRUPT",
  );
});

test("IndexedDB retains a released lease anchor and rejects counter rollback ABA", async () => {
  const databaseName = "tws-host-indexeddb-released-counter-rollback";
  const store = createStore(databaseName, () => Date.parse("2026-09-01T00:00:00Z"));
  const first = await store.acquireLease({
    operationId: "released-counter-rollback-operation",
    ownerId: "reused-owner",
    ttlMs: 1_000,
  });
  assert.equal(first.fencingToken, "1");
  assert.equal(await store.releaseLease({ lease: first }), true);
  assert.equal(await store.releaseLease({ lease: first }), false);

  const database = await openRaw(databaseName);
  await writeRaw(database, "leases", {
    key: "counter:released-counter-rollback-operation",
    kind: "counter",
    value: "0",
  });
  await assert.rejects(
    store.acquireLease({
      operationId: "released-counter-rollback-operation",
      ownerId: "reused-owner",
      ttlMs: 1_000,
    }),
    (error) => error?.code === "HOST_STORE_CORRUPT",
  );
});

test("IndexedDB Host resumes a response-persisted crash from a new adapter instance", async () => {
  const scenario = (await createPortCrashScenarios()).transaction;
  const targetIndex = scenario.transitions.findIndex(
    (transition) =>
      transition.kind === "waiting" &&
      transition.calls.some((call) => call.operation === "signer.sign"),
  );
  const target = scenario.transitions[targetIndex].calls.find(
    (call) => call.operation === "signer.sign",
  );
  const databaseName = "tws-host-indexeddb-driver-restart";
  const firstStore = createStore(databaseName, () => Date.now());
  const operationId = scenario.transitions[0].checkpoint.payload.operationId;
  const seedLease = await firstStore.acquireLease({
    operationId,
    ownerId: "indexeddb-driver-seed",
    ttlMs: 60_000,
  });
  let record = null;
  for (const transition of scenario.transitions.slice(0, targetIndex + 1)) {
    const committed = await firstStore.commitTransition({
      lease: seedLease,
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
  await firstStore.releaseLease({ lease: seedLease });

  const responses = new Map();
  let signerAttempts = 0;
  const invoke = async (call) => {
    if (call.callId === target.callId) signerAttempts += 1;
    if (!responses.has(call.callId)) {
      responses.set(call.callId, structuredClone(scenario.resultForCall(call)));
    }
    return structuredClone(responses.get(call.callId));
  };
  const ports = Object.freeze({
    accounts: invoke,
    chainData: invoke,
    policy: invoke,
    permissionStore: invoke,
    approval: invoke,
    signer: invoke,
    broadcast: invoke,
    clock: invoke,
    entropy: invoke,
  });
  const authority = Object.freeze({
    read: async () => structuredClone(scenario.authority),
    compareAndSwapSession: async () => {
      throw new Error("transaction restart fixture has no session commit");
    },
  });
  const realCore = scenario.createCore();
  let crashed = false;
  const crashingCore = Object.freeze({
    ...realCore,
    resume: async (input) => {
      if (!crashed && input.response?.callId === target.callId) {
        crashed = true;
        throw new Error("simulated service-worker termination");
      }
      return realCore.resume(input);
    },
  });
  const firstHost = (await import("../dist/esm/index.js")).createTwsHost({
    core: crashingCore,
    store: firstStore,
    ports,
    authority,
    ownerId: "indexeddb-driver-first",
    ...TEST_LEASE_SCHEDULER,
  });
  assert.equal(
    (await firstHost.resumeOperation({ operationId })).status,
    "failed",
  );
  assert.equal((await firstStore.readCall(target.callId)).status, "completed");

  const reopenedStore = createStore(databaseName, () => Date.now());
  const recoveredHost = (await import("../dist/esm/index.js")).createTwsHost({
    core: scenario.createCore(),
    store: reopenedStore,
    ports,
    authority,
    ownerId: "indexeddb-driver-recovered",
    ...TEST_LEASE_SCHEDULER,
  });
  assert.equal(
    (await recoveredHost.resumeOperation({ operationId })).status,
    "complete",
  );
  assert.equal(signerAttempts, 1);
});
