import { createMemoryTwsHostStore } from "../dist/esm/index.js";
import { createCheckpoint, verifyCheckpoint } from "@tbc-wallet/core";
import assert from "node:assert/strict";
import test from "node:test";
import { defineTwsHostStoreContract } from "./store-contract.mjs";
import { createStoreTransitionFlow } from "./fixtures/store-transitions.mjs";

defineTwsHostStoreContract({
  name: "MemoryTwsHostStore",
  createStore: createMemoryTwsHostStore,
});

test("Memory store preserves Core-owned checkpoints across the Host round trip", async () => {
  const flow = await createStoreTransitionFlow("memory-owned-checkpoint");
  const checkpoint = createCheckpoint(flow.transitions[0].checkpoint.payload);
  const transition = Object.freeze({ kind: "waiting", checkpoint, calls: checkpoint.payload.pendingCalls });
  const store = createMemoryTwsHostStore();
  const lease = await store.acquireLease({ operationId: flow.operationId, ownerId: "owned-test", ttlMs: 60_000 });
  const committed = await store.commitTransition({ lease, expected: null, transition });
  assert.equal(committed.operation.transition.checkpoint, checkpoint);
  assert.equal(committed.calls[0].call, checkpoint.payload.pendingCalls[0]);
  assert.equal(verifyCheckpoint(committed.operation.transition.checkpoint), checkpoint);

  const bad = structuredClone(transition);
  bad.checkpoint.checkpointHash = "f".repeat(64);
  await assert.rejects(store.commitTransition({ lease, expected: null, transition: bad }), e => e.code === "HOST_STORE_CORRUPT");
  assert.equal((await store.readOperation(flow.operationId)).checkpointHash, checkpoint.checkpointHash);
});

test("MemoryTwsHostStore serializes 100 identical commits and returns immutable snapshots", async () => {
  const store = createMemoryTwsHostStore({
    now: () => Date.parse("2026-09-01T00:00:00Z"),
  });
  const flow = await createStoreTransitionFlow("memory-concurrent-identical");
  const transition = flow.transitions[0];
  const lease = await store.acquireLease({
    operationId: flow.operationId,
    ownerId: "memory-concurrent-owner",
    ttlMs: 60_000,
  });

  const results = await Promise.all(
    Array.from({ length: 100 }, () =>
      store.commitTransition({ lease, expected: null, transition }),
    ),
  );
  assert.equal(new Set(results.map((item) => item.operation.transitionIdentity)).size, 1);
  assert.equal(results.every((item) => item.operation.storeRevision === "0"), true);

  const record = await store.readOperation(flow.operationId);
  assert.equal(record, results[0].operation, "reads reuse the store-owned immutable record instead of serializing it again");
  assert.equal(await store.readCall(transition.calls[0].callId), results[0].calls[0]);
  assert.notEqual(record.transition, transition, "external write input is still snapshotted once");
  assert.throws(() => {
    record.transition.checkpoint.payload.operationId = "mutated";
  }, TypeError);
  assert.equal((await store.readOperation(flow.operationId)).operationId, flow.operationId);
});
