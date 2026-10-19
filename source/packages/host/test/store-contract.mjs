import assert from "node:assert/strict";
import test from "node:test";
import { createStoreTransitionFlow } from "./fixtures/store-transitions.mjs";

function expected(record) {
  return {
    storeRevision: record.storeRevision,
    checkpointHash: record.checkpointHash,
  };
}

async function assertHostError(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error?.name, "TwsHostError");
    assert.equal(error?.code, code);
    return true;
  });
}

export function defineTwsHostStoreContract({ name, createStore }) {
  test(`${name}: empty reads and recoverable scans are deterministic`, async () => {
    const clock = { value: Date.parse("2026-09-01T00:00:00Z") };
    const store = createStore({ now: () => clock.value });

    assert.equal(store.storeVersion, "1.0");
    assert.equal(await store.readOperation("missing-operation"), null);
    assert.equal(await store.readCall("missing-call"), null);
    assert.equal(await store.readSessionCommit("missing-commit"), null);
    assert.equal(await store.readDelivery("missing-operation"), null);
    assert.deepEqual(
      await store.listRecoverable({ releaseFingerprint: "f".repeat(64) }),
      [],
    );
  });

  test(`${name}: leases use monotonic fencing across expiry and takeover`, async () => {
    const clock = { value: Date.parse("2026-09-01T00:00:00Z") };
    const store = createStore({ now: () => clock.value });
    const first = await store.acquireLease({
      operationId: "lease-operation",
      ownerId: "owner-a",
      ttlMs: 1_000,
    });
    assert.equal(first.fencingToken, "1");
    assert.equal(
      await store.acquireLease({
        operationId: "lease-operation",
        ownerId: "owner-b",
        ttlMs: 1_000,
      }),
      null,
    );

    clock.value += 500;
    const renewed = await store.renewLease({ lease: first, ttlMs: 1_000 });
    assert.equal(renewed.fencingToken, "1");
    assert.ok(Date.parse(renewed.expiresAt) > Date.parse(first.expiresAt));

    clock.value += 1_001;
    const second = await store.acquireLease({
      operationId: "lease-operation",
      ownerId: "owner-b",
      ttlMs: 1_000,
    });
    assert.equal(second.fencingToken, "2");
    await assertHostError(
      store.renewLease({ lease: renewed, ttlMs: 1_000 }),
      "HOST_STORE_CONFLICT",
    );
    assert.equal(await store.releaseLease({ lease: renewed }), false);
    assert.equal(await store.releaseLease({ lease: second }), true);

    const third = await store.acquireLease({
      operationId: "lease-operation",
      ownerId: "owner-a",
      ttlMs: 1_000,
    });
    assert.equal(third.fencingToken, "3");
  });

  test(`${name}: transition, call intent, response, and CAS form one journal`, async () => {
    const clock = { value: Date.parse("2026-09-01T00:00:00Z") };
    const store = createStore({ now: () => clock.value });
    const flow = await createStoreTransitionFlow(`${name}-call-journal`);
    const transition = flow.transitions[0];
    const call = transition.calls[0];
    const lease = await store.acquireLease({
      operationId: flow.operationId,
      ownerId: "journal-owner",
      ttlMs: 60_000,
    });

    const committed = await store.commitTransition({
      lease,
      expected: null,
      transition,
    });
    assert.equal(committed.operation.operationId, flow.operationId);
    assert.equal(committed.operation.checkpointHash, transition.checkpoint.checkpointHash);
    assert.equal(committed.calls.length, 1);
    assert.equal(committed.calls[0].status, "prepared");
    assert.deepEqual(await store.readCall(call.callId), committed.calls[0]);

    const replay = await store.commitTransition({
      lease,
      expected: null,
      transition: structuredClone(transition),
    });
    assert.deepEqual(replay, committed);

    const uncertain = await store.markCallUncertain({ lease, call });
    assert.equal(uncertain.status, "uncertain");
    const response = {
      version: "1.0",
      callId: call.callId,
      result: { now: "2026-08-31T12:00:00Z" },
    };
    const completed = await store.completeCall({ lease, call, response });
    assert.equal(completed.status, "completed");
    assert.deepEqual(completed.response, response);
    assert.deepEqual(
      await store.completeCall({
        lease,
        call: structuredClone(call),
        response: structuredClone(response),
      }),
      completed,
    );

    const collision = {
      ...structuredClone(call),
      params: { version: "1.0", collision: true },
    };
    await assertHostError(
      store.markCallUncertain({ lease, call: collision }),
      "HOST_STORE_CONFLICT",
    );
    assert.deepEqual(await store.readOperation(flow.operationId), committed.operation);
  });

  test(`${name}: session commits and completion deliveries are atomic and idempotent`, async () => {
    const clock = { value: Date.parse("2026-09-01T00:00:00Z") };
    const store = createStore({ now: () => clock.value });
    const flow = await createStoreTransitionFlow(`${name}-complete-journal`);
    const lease = await store.acquireLease({
      operationId: flow.operationId,
      ownerId: "complete-owner",
      ttlMs: 60_000,
    });
    let operation = null;
    let commitRecord;
    let sessionComplete;
    let delivery;

    for (const transition of flow.transitions) {
      clock.value += 1;
      const result = await store.commitTransition({
        lease,
        expected: operation === null ? null : expected(operation),
        transition,
      });
      operation = result.operation;
      if (result.sessionCommit !== undefined) {
        commitRecord = result.sessionCommit;
        const uncertain = await store.markSessionCommitUncertain({
          lease,
          mutation: flow.mutation,
        });
        assert.equal(uncertain.status, "uncertain");
        sessionComplete = await store.completeSessionCommit({
          lease,
          mutation: flow.mutation,
          acknowledgment: flow.acknowledgment,
          authority: flow.authority,
        });
      }
      if (result.delivery !== undefined) delivery = result.delivery;
    }

    assert.equal(commitRecord.status, "prepared");
    assert.deepEqual(commitRecord.mutation, flow.mutation);
    assert.equal(sessionComplete.status, "completed");
    assert.deepEqual(sessionComplete.acknowledgment, flow.acknowledgment);
    assert.deepEqual(sessionComplete.authority, flow.authority);
    await assertHostError(
      store.markSessionCommitUncertain({
        lease,
        mutation: {
          ...flow.mutation,
          payload: {
            ...flow.mutation.payload,
            events: [{ name: "chainChanged", payload: "tbc:collision" }],
          },
        },
      }),
      "HOST_STORE_CONFLICT",
    );

    assert.equal(operation.terminal, true);
    assert.equal(delivery.status, "pending");
    assert.deepEqual(await store.readDelivery(flow.operationId), delivery);
    assert.deepEqual(
      await store.listRecoverable({ releaseFingerprint: flow.releaseFingerprint }),
      [operation],
    );

    const delivered = await store.markDeliveryDelivered({
      lease,
      operationId: flow.operationId,
      deliveryId: delivery.deliveryId,
      completionIdentity: delivery.completionIdentity,
    });
    assert.equal(delivered.status, "delivered");
    assert.deepEqual(
      await store.markDeliveryDelivered({
        lease,
        operationId: flow.operationId,
        deliveryId: delivery.deliveryId,
        completionIdentity: delivery.completionIdentity,
      }),
      delivered,
    );
    assert.deepEqual(
      await store.listRecoverable({ releaseFingerprint: flow.releaseFingerprint }),
      [],
    );

    await assertHostError(
      store.commitTransition({
        lease,
        expected: expected(operation),
        transition: flow.transitions[0],
      }),
      "HOST_STORE_CONFLICT",
    );
  });

  test(`${name}: stale CAS and release filtering never mutate the operation`, async () => {
    const clock = { value: Date.parse("2026-09-01T00:00:00Z") };
    const store = createStore({ now: () => clock.value });
    const first = await createStoreTransitionFlow(`${name}-cas-a`);
    const second = await createStoreTransitionFlow(`${name}-cas-b`);
    const firstLease = await store.acquireLease({
      operationId: first.operationId,
      ownerId: "cas-owner-a",
      ttlMs: 60_000,
    });
    const secondLease = await store.acquireLease({
      operationId: second.operationId,
      ownerId: "cas-owner-b",
      ttlMs: 60_000,
    });
    const firstCommit = await store.commitTransition({
      lease: firstLease,
      expected: null,
      transition: first.transitions[0],
    });
    await store.commitTransition({
      lease: secondLease,
      expected: null,
      transition: second.transitions[0],
    });

    await assertHostError(
      store.commitTransition({
        lease: firstLease,
        expected: { storeRevision: "999", checkpointHash: "0".repeat(64) },
        transition: first.transitions[1],
      }),
      "HOST_STORE_CONFLICT",
    );
    assert.deepEqual(await store.readOperation(first.operationId), firstCommit.operation);

    const recoverable = await store.listRecoverable({
      releaseFingerprint: first.releaseFingerprint,
      limit: 1,
    });
    assert.equal(recoverable.length, 1);
    assert.equal(
      [first.operationId, second.operationId].includes(recoverable[0].operationId),
      true,
    );
    assert.deepEqual(
      await store.listRecoverable({ releaseFingerprint: "0".repeat(64) }),
      [],
    );
  });
}
