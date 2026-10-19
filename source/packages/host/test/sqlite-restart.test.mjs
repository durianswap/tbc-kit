import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createSqliteTestStore } from "./fixtures/sqlite-node-driver.mjs";
import { createStoreTransitionFlow } from "./fixtures/store-transitions.mjs";

function temporaryDatabase(t, label) {
  const directory = mkdtempSync(join(tmpdir(), `tws-${label}-`));
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  return join(directory, "host.sqlite");
}

test("SQLite reopens every prepared, uncertain, completed, and delivered journal state", async (t) => {
  const databaseName = temporaryDatabase(t, "restart");
  const namespace = "restart";
  const now = () => Date.parse("2026-09-02T00:00:00Z");
  const flow = await createStoreTransitionFlow("sqlite-restart");
  let current = createSqliteTestStore({ databaseName, namespace, now });

  async function restart() {
    await current.driver.close();
    current = createSqliteTestStore({ databaseName, namespace, now });
    await current.store.readOperation("schema-ready");
  }

  const lease = await current.store.acquireLease({
    operationId: flow.operationId,
    ownerId: "restart-owner",
    ttlMs: 60_000,
  });
  const first = await current.store.commitTransition({
    lease,
    expected: null,
    transition: flow.transitions[0],
  });
  const call = first.calls[0];
  assert.equal(call.status, "prepared");

  await restart();
  assert.equal((await current.store.readCall(call.callId)).status, "prepared");
  await current.store.markCallUncertain({ lease, call: call.call });

  await restart();
  assert.equal((await current.store.readCall(call.callId)).status, "uncertain");
  const response = {
    version: "1.0",
    callId: call.callId,
    result: { now: "2026-08-31T12:00:00Z" },
  };
  await current.store.completeCall({ lease, call: call.call, response });

  await restart();
  assert.equal((await current.store.readCall(call.callId)).status, "completed");

  let operation = await current.store.readOperation(flow.operationId);
  let sessionCommit;
  let delivery;
  for (const transition of flow.transitions.slice(1)) {
    const result = await current.store.commitTransition({
      lease,
      expected: {
        storeRevision: operation.storeRevision,
        checkpointHash: operation.checkpointHash,
      },
      transition,
    });
    operation = result.operation;
    sessionCommit ??= result.sessionCommit;
    delivery ??= result.delivery;
  }

  assert.equal(sessionCommit.status, "prepared");
  await restart();
  assert.equal(
    (await current.store.readSessionCommit(sessionCommit.commitId)).status,
    "prepared",
  );
  await current.store.markSessionCommitUncertain({ lease, mutation: flow.mutation });

  await restart();
  assert.equal(
    (await current.store.readSessionCommit(sessionCommit.commitId)).status,
    "uncertain",
  );
  await current.store.completeSessionCommit({
    lease,
    mutation: flow.mutation,
    acknowledgment: flow.acknowledgment,
    authority: flow.authority,
  });

  await restart();
  assert.equal(
    (await current.store.readSessionCommit(sessionCommit.commitId)).status,
    "completed",
  );
  assert.equal((await current.store.readDelivery(flow.operationId)).status, "pending");
  await current.store.markDeliveryDelivered({
    lease,
    operationId: flow.operationId,
    deliveryId: delivery.deliveryId,
    completionIdentity: delivery.completionIdentity,
  });

  await restart();
  assert.equal((await current.store.readDelivery(flow.operationId)).status, "delivered");
  assert.equal((await current.store.readOperation(flow.operationId)).terminal, true);
  await current.driver.close();
});

