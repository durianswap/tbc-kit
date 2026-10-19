import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createSqliteTwsHostStore } from "../dist/esm/sqlite.js";
import {
  createNodeSqliteDriver,
  createSqliteTestStore,
} from "./fixtures/sqlite-node-driver.mjs";
import { createStoreTransitionFlow } from "./fixtures/store-transitions.mjs";

function temporaryDatabase(t, label) {
  const directory = mkdtempSync(join(tmpdir(), `tws-${label}-`));
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  return join(directory, "host.sqlite");
}

test("SQLite serializes 100 exact replays across two connections", async (t) => {
  const databaseName = temporaryDatabase(t, "contention");
  const now = () => Date.parse("2026-09-02T00:00:00Z");
  const first = createSqliteTestStore({ databaseName, namespace: "race", now });
  const second = createSqliteTestStore({ databaseName, namespace: "race", now });
  t.after(() => Promise.all([first.driver.close(), second.driver.close()]));
  const stores = [first.store, second.store];
  const flow = await createStoreTransitionFlow("sqlite-contention");
  const lease = await first.store.acquireLease({
    operationId: flow.operationId,
    ownerId: "race-owner",
    ttlMs: 60_000,
  });

  const initial = await Promise.all(
    Array.from({ length: 100 }, (_, index) =>
      stores[index % stores.length].commitTransition({
        lease,
        expected: null,
        transition: flow.transitions[0],
      }),
    ),
  );
  assert.equal(new Set(initial.map((result) => result.operation.transitionIdentity)).size, 1);
  assert.equal(new Set(initial.map((result) => result.calls[0].identity)).size, 1);

  let operation = initial[0].operation;
  let delivery;
  for (const transition of flow.transitions.slice(1)) {
    const result = await first.store.commitTransition({
      lease,
      expected: {
        storeRevision: operation.storeRevision,
        checkpointHash: operation.checkpointHash,
      },
      transition,
    });
    operation = result.operation;
    delivery ??= result.delivery;
  }

  const delivered = await Promise.all(
    Array.from({ length: 100 }, (_, index) =>
      stores[index % stores.length].markDeliveryDelivered({
        lease,
        operationId: flow.operationId,
        deliveryId: delivery.deliveryId,
        completionIdentity: delivery.completionIdentity,
      }),
    ),
  );
  assert.equal(new Set(delivered.map((record) => record.revision)).size, 1);
  assert.equal(delivered[0].revision, "1");
  assert.equal(
    first.database.prepare(
      "SELECT COUNT(*) AS count FROM tws_host_operations WHERE namespace = 'race'",
    ).get().count,
    1,
  );
  assert.equal(
    first.database.prepare(
      "SELECT COUNT(*) AS count FROM tws_host_deliveries WHERE namespace = 'race'",
    ).get().count,
    1,
  );
  assert.equal(await first.store.releaseLease({ lease }), true);
  const takeover = await second.store.acquireLease({
    operationId: flow.operationId,
    ownerId: "takeover-owner",
    ttlMs: 60_000,
  });
  assert.equal(takeover.fencingToken, "2");
  await assert.rejects(
    first.store.renewLease({ lease, ttlMs: 60_000 }),
    (error) => error?.code === "HOST_STORE_CONFLICT",
  );
});

test("SQLite rolls back a partially written transition", async (t) => {
  const databaseName = temporaryDatabase(t, "rollback");
  const base = createNodeSqliteDriver(databaseName);
  t.after(() => base.driver.close());
  let failOperationWrite = false;
  const driver = {
    dialect: "sqlite",
    transaction: (work) => base.driver.transaction((transaction) =>
      work({
        ...transaction,
        async run(sql, bindings) {
          const result = await transaction.run(sql, bindings);
          if (failOperationWrite && sql.includes("INSERT INTO tws_host_operations")) {
            throw new Error("injected transaction failure");
          }
          return result;
        },
      })),
  };
  const store = createSqliteTwsHostStore({
    driver,
    namespace: "rollback",
    now: () => Date.parse("2026-09-02T00:00:00Z"),
  });
  const flow = await createStoreTransitionFlow("sqlite-rollback");
  const lease = await store.acquireLease({
    operationId: flow.operationId,
    ownerId: "rollback-owner",
    ttlMs: 60_000,
  });
  failOperationWrite = true;
  await assert.rejects(
    store.commitTransition({ lease, expected: null, transition: flow.transitions[0] }),
    /injected transaction failure/,
  );
  failOperationWrite = false;
  assert.equal(await store.readOperation(flow.operationId), null);
  assert.equal(await store.readCall(flow.transitions[0].calls[0].callId), null);
});

test("SQLite fails closed on a busy database and a rolled-back fencing counter", async (t) => {
  const databaseName = temporaryDatabase(t, "busy");
  const first = createNodeSqliteDriver(databaseName, { serialize: false });
  const second = createNodeSqliteDriver(databaseName, { serialize: false });
  t.after(() => Promise.all([first.driver.close(), second.driver.close()]));
  const store = createSqliteTwsHostStore({
    driver: second.driver,
    namespace: "busy",
    now: () => Date.parse("2026-09-02T00:00:00Z"),
  });
  await store.readOperation("schema-ready");

  let release;
  let entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  const held = first.driver.transaction(async () => {
    entered();
    await gate;
  });
  await started;
  await assert.rejects(
    store.acquireLease({ operationId: "busy-op", ownerId: "owner", ttlMs: 1_000 }),
    /busy|locked/i,
  );
  release();
  await held;
  assert.equal(
    second.database.prepare(
      "SELECT COUNT(*) AS count FROM tws_host_leases WHERE namespace = 'busy'",
    ).get().count,
    0,
  );

  const lease = await store.acquireLease({
    operationId: "counter-op",
    ownerId: "owner",
    ttlMs: 1_000,
  });
  assert.equal(lease.fencingToken, "1");
  second.database.prepare(
    "UPDATE tws_host_leases SET fencing_counter = '01' WHERE namespace = 'busy' AND operation_id = 'counter-op'",
  ).run();
  await assert.rejects(
    store.acquireLease({ operationId: "counter-op", ownerId: "owner-2", ttlMs: 1_000 }),
    (error) => error?.code === "HOST_STORE_CORRUPT",
  );
});

test("SQLite retains a released lease anchor and rejects canonical counter rollback", async (t) => {
  const databaseName = temporaryDatabase(t, "lease-anchor");
  const sqlite = createSqliteTestStore({
    databaseName,
    namespace: "anchor",
    now: () => Date.parse("2026-09-02T00:00:00Z"),
  });
  t.after(() => sqlite.driver.close());
  const first = await sqlite.store.acquireLease({
    operationId: "anchor-op",
    ownerId: "owner-1",
    ttlMs: 1_000,
  });
  assert.equal(await sqlite.store.releaseLease({ lease: first }), true);
  const second = await sqlite.store.acquireLease({
    operationId: "anchor-op",
    ownerId: "owner-2",
    ttlMs: 1_000,
  });
  assert.equal(second.fencingToken, "2");
  assert.equal(await sqlite.store.releaseLease({ lease: second }), true);

  sqlite.database.prepare(
    "UPDATE tws_host_leases SET fencing_counter = '1' WHERE namespace = 'anchor' AND operation_id = 'anchor-op'",
  ).run();
  await assert.rejects(
    sqlite.store.acquireLease({
      operationId: "anchor-op",
      ownerId: "owner-3",
      ttlMs: 1_000,
    }),
    (error) => error?.code === "HOST_STORE_CORRUPT",
  );
});
