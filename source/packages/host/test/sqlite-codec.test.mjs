import assert from "node:assert/strict";
import test from "node:test";

import { canonicalize } from "@tbc-wallet/core";
import { createMemoryTwsHostStore } from "../dist/esm/index.js";
import { createSqliteTwsHostStore } from "../dist/esm/sqlite.js";
import { createNodeSqliteDriver } from "./fixtures/sqlite-node-driver.mjs";
import { createStoreTransitionFlow } from "./fixtures/store-transitions.mjs";

async function assertHostError(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error?.name, "TwsHostError");
    assert.equal(error?.code, code);
    assert.equal(JSON.stringify(error).includes("private-marker"), false);
    return true;
  });
}

async function createHarness(t, namespace = "codec") {
  const sqlite = createNodeSqliteDriver();
  t.after(() => sqlite.driver.close());
  const store = createSqliteTwsHostStore({
    driver: sqlite.driver,
    namespace,
    now: () => Date.parse("2026-09-02T00:00:00Z"),
  });
  await store.readOperation("initialize-schema");
  return { ...sqlite, store, namespace };
}

async function createValidRecords(label) {
  const flow = await createStoreTransitionFlow(label);
  const memory = createMemoryTwsHostStore({
    now: () => Date.parse("2026-09-02T00:00:00Z"),
  });
  const lease = await memory.acquireLease({
    operationId: flow.operationId,
    ownerId: "codec-owner",
    ttlMs: 60_000,
  });
  let operation = null;
  let call;
  let sessionCommit;
  let delivery;
  for (const transition of flow.transitions) {
    const result = await memory.commitTransition({
      lease,
      expected: operation === null
        ? null
        : {
            storeRevision: operation.storeRevision,
            checkpointHash: operation.checkpointHash,
          },
      transition,
    });
    operation = result.operation;
    call ??= result.calls[0];
    sessionCommit ??= result.sessionCommit;
    delivery ??= result.delivery;
  }
  return { flow, operation, call, sessionCommit, delivery };
}

function insertRecord(database, table, columns, bindings) {
  const names = columns.join(", ");
  const values = columns.map((name) => `:${name}`).join(", ");
  database.prepare(`INSERT INTO ${table} (${names}) VALUES (${values})`).run(bindings);
}

test("SQLite read methods return deterministic empty values", async (t) => {
  const { store } = await createHarness(t, "empty");

  assert.equal(await store.readOperation("missing-operation"), null);
  assert.equal(await store.readCall("missing-call"), null);
  assert.equal(await store.readSessionCommit("missing-commit"), null);
  assert.equal(await store.readDelivery("missing-operation"), null);
  assert.deepEqual(
    await store.listRecoverable({ releaseFingerprint: "f".repeat(64) }),
    [],
  );
});

test("SQLite reads exact canonical Host records as immutable snapshots", async (t) => {
  const { database, store, namespace } = await createHarness(t, "valid");
  const records = await createValidRecords("sqlite-codec-valid");

  insertRecord(
    database,
    "tws_host_operations",
    ["namespace", "operation_id", "release_fingerprint", "terminal", "created_at", "canonical_json"],
    {
      namespace,
      operation_id: records.operation.operationId,
      release_fingerprint: records.operation.releaseFingerprint,
      terminal: records.operation.terminal ? 1 : 0,
      created_at: records.operation.createdAt,
      canonical_json: canonicalize(records.operation),
    },
  );
  insertRecord(
    database,
    "tws_host_calls",
    ["namespace", "call_id", "operation_id", "status", "created_at", "canonical_json"],
    {
      namespace,
      call_id: records.call.callId,
      operation_id: records.call.operationId,
      status: records.call.status,
      created_at: records.call.createdAt,
      canonical_json: canonicalize(records.call),
    },
  );
  insertRecord(
    database,
    "tws_host_session_commits",
    ["namespace", "commit_id", "operation_id", "status", "created_at", "canonical_json"],
    {
      namespace,
      commit_id: records.sessionCommit.commitId,
      operation_id: records.sessionCommit.operationId,
      status: records.sessionCommit.status,
      created_at: records.sessionCommit.createdAt,
      canonical_json: canonicalize(records.sessionCommit),
    },
  );
  insertRecord(
    database,
    "tws_host_deliveries",
    ["namespace", "operation_id", "delivery_id", "status", "created_at", "canonical_json"],
    {
      namespace,
      operation_id: records.delivery.operationId,
      delivery_id: records.delivery.deliveryId,
      status: records.delivery.status,
      created_at: records.delivery.createdAt,
      canonical_json: canonicalize(records.delivery),
    },
  );

  assert.deepEqual(await store.readOperation(records.operation.operationId), records.operation);
  assert.deepEqual(await store.readCall(records.call.callId), records.call);
  assert.deepEqual(
    await store.readSessionCommit(records.sessionCommit.commitId),
    records.sessionCommit,
  );
  assert.deepEqual(await store.readDelivery(records.delivery.operationId), records.delivery);
  assert.equal(Object.isFrozen(await store.readCall(records.call.callId)), true);
});

test("SQLite rejects malformed, non-canonical, oversized, and colliding records", async (t) => {
  const { database, store, namespace } = await createHarness(t, "invalid");
  const records = await createValidRecords("sqlite-codec-invalid");
  const cases = [
    { callId: "invalid-json", canonicalJson: '{"private-marker":' },
    { callId: "non-canonical", canonicalJson: JSON.stringify(records.call, null, 2) },
    { callId: "oversized", canonicalJson: `"${"x".repeat(4 * 1024 * 1024)}"` },
    {
      callId: "identity-collision",
      canonicalJson: canonicalize(records.call),
    },
    {
      callId: "impossible-status",
      canonicalJson: canonicalize({ ...records.call, status: "completed" }),
    },
    {
      callId: "invalid-revision",
      canonicalJson: canonicalize({ ...records.call, revision: "01" }),
    },
  ];

  for (const fixture of cases) {
    insertRecord(
      database,
      "tws_host_calls",
      ["namespace", "call_id", "operation_id", "status", "created_at", "canonical_json"],
      {
        namespace,
        call_id: fixture.callId,
        operation_id: records.call.operationId,
        status: "prepared",
        created_at: records.call.createdAt,
        canonical_json: fixture.canonicalJson,
      },
    );
    await assertHostError(store.readCall(fixture.callId), "HOST_STORE_CORRUPT");
  }

  insertRecord(
    database,
    "tws_host_operations",
    ["namespace", "operation_id", "release_fingerprint", "terminal", "created_at", "canonical_json"],
    {
      namespace,
      operation_id: records.operation.operationId,
      release_fingerprint: "0".repeat(64),
      terminal: records.operation.terminal ? 1 : 0,
      created_at: records.operation.createdAt,
      canonical_json: canonicalize(records.operation),
    },
  );
  await assertHostError(
    store.readOperation(records.operation.operationId),
    "HOST_STORE_CORRUPT",
  );
});

test("SQLite reads never cross namespace boundaries", async (t) => {
  const { database, store } = await createHarness(t, "visible");
  const records = await createValidRecords("sqlite-codec-namespace");
  insertRecord(
    database,
    "tws_host_calls",
    ["namespace", "call_id", "operation_id", "status", "created_at", "canonical_json"],
    {
      namespace: "private-marker-hidden",
      call_id: records.call.callId,
      operation_id: records.call.operationId,
      status: records.call.status,
      created_at: records.call.createdAt,
      canonical_json: canonicalize(records.call),
    },
  );

  assert.equal(await store.readCall(records.call.callId), null);
});
