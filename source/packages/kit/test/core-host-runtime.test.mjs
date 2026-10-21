import assert from "node:assert/strict";
import test from "node:test";
import { TWS_RELEASE_FINGERPRINT as CORE_RELEASE_FINGERPRINT } from "../../core/dist/esm/release.js";

import {
  TWS_HOST_PORT_NAMES,
  TWS_RELEASE,
  TWS_RELEASE_FINGERPRINT,
  createMemoryTwsHostStore,
  createTwsCore,
  createTwsHost,
} from "../dist/esm/wallet.js";
import {
  TBC_KIT_HOST_RELEASE_FINGERPRINT,
  createSqliteTwsHostStore,
} from "../dist/esm/sqlite.js";
import { createStoreTransitionFlow } from "../../host/test/fixtures/store-transitions.mjs";
import { TEST_LEASE_SCHEDULER } from "../../host/test/fixtures/lease-scheduler.mjs";

const PORT_NAMES = [
  "accounts",
  "chainData",
  "policy",
  "permissionStore",
  "approval",
  "signer",
  "crypto",
  "reviewedTransaction",
  "broadcast",
  "clock",
  "entropy",
];

function inertPorts() {
  const unused = async () => {
    throw new Error("unexpected Host Port");
  };
  return Object.freeze(
    Object.fromEntries(PORT_NAMES.map((name) => [name, unused])),
  );
}

function coreFacade() {
  const unused = async () => {
    throw new Error("unexpected Core method");
  };
  return Object.freeze({
    start: unused,
    resume: unused,
    acknowledgeCommit: unused,
    cancel: unused,
  });
}

function authoritySource(authority) {
  return Object.freeze({
    read: async () => structuredClone(authority),
    compareAndSwapSession: async () => {
      throw new Error("unexpected authority commit");
    },
  });
}

test("wallet and sqlite expose one generated Core/Host protocol identity", () => {
  assert.equal(TWS_RELEASE.version, "1.0.0-candidate.3");
  assert.equal(
    TWS_RELEASE_FINGERPRINT,
    CORE_RELEASE_FINGERPRINT,
  );
  assert.equal(TBC_KIT_HOST_RELEASE_FINGERPRINT, TWS_RELEASE_FINGERPRINT);
  assert.deepEqual(TWS_HOST_PORT_NAMES, PORT_NAMES);
  assert.equal(typeof createTwsCore, "function");
  assert.equal(typeof createTwsHost, "function");
  assert.equal(typeof createMemoryTwsHostStore, "function");
  assert.equal(typeof createSqliteTwsHostStore, "function");
});

test("Kit Host rejects a stored operation from the pre-optional-confirmations release", async () => {
  const flow = await createStoreTransitionFlow("kit-host-release-mismatch");
  assert.equal(flow.releaseFingerprint, TWS_RELEASE_FINGERPRINT);
  const store = createMemoryTwsHostStore();
  const transition = flow.transitions[0];
  const operationId = transition.checkpoint.payload.operationId;
  const lease = await store.acquireLease({
    operationId,
    ownerId: "seed-owner",
    ttlMs: 60_000,
  });
  await store.commitTransition({ lease, expected: null, transition });
  await store.releaseLease({ lease });

  const mismatchedStore = Object.freeze({
    ...store,
    async readOperation(id) {
      const record = await store.readOperation(id);
      return record === null
        ? null
        : { ...record, releaseFingerprint: "4e813ddc033ae009c3f147483c479ee893e2ba45e46d2ab948feb12a841ed946" };
    },
  });
  const host = createTwsHost({
    core: coreFacade(),
    ports: inertPorts(),
    store: mismatchedStore,
    authority: authoritySource(flow.authority),
    ownerId: "mismatch-owner",
    ...TEST_LEASE_SCHEDULER,
  });
  const result = await host.resumeOperation({ operationId });
  assert.equal(result.status, "failed");
  assert.deepEqual(result.error, {
    code: "HOST_RELEASE_MISMATCH",
    message: "The stored operation uses a different TWS release.",
    retryable: false,
    metadata: { operationId },
  });
});
