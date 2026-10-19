import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as tws from "@tbc-wallet/core";
import {
  createMemoryTwsHostStore,
  createTwsHost,
} from "../dist/esm/index.js";
import { TEST_LEASE_SCHEDULER } from "./fixtures/lease-scheduler.mjs";

const provider = JSON.parse(
  await readFile(
    new URL("../../../test-vectors/provider.json", import.meta.url),
    "utf8",
  ),
);
const initialAuthority = Object.freeze({
  currentContext: structuredClone(provider.trustedContexts[0].context),
  currentSession: structuredClone(provider.providerSessions.sessionA),
});
const testnet = "tbc:testnet";
const address = "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH";

function clone(value) {
  return structuredClone(value);
}

function same(left, right) {
  return tws.canonicalize(left) === tws.canonicalize(right);
}

function switchPermission() {
  return {
    id: "host-session-switch-testnet",
    parentCapability: "tbc_switchChain",
    invoker: initialAuthority.currentContext.origin,
    date: Date.parse("2026-08-31T11:00:00Z"),
    caveats: [
      { type: "restrictChains", value: [testnet] },
      { type: "restrictAccounts", value: [`${testnet}:${address}`] },
      { type: "restrictMethods", value: ["tbc_switchChain"] },
    ],
  };
}

function createPorts() {
  const responses = new Map();
  const unavailable = (call) => ({
    portError: {
      name: "UNAVAILABLE",
      message: `Unused session fixture Port: ${call.operation}`,
      retryable: false,
    },
  });
  const invoke = async (call) => {
    if (responses.has(call.callId)) return clone(responses.get(call.callId));
    let result;
    if (call.operation === "clock.now") {
      result = { now: "2026-08-31T12:00:11Z" };
    } else if (call.operation === "permissionStore.load") {
      result = { revision: "0", permissions: [switchPermission()] };
    } else if (call.operation === "approval.request") {
      result = {
        status: "approved",
        approvalId: "host-session-approval-1",
        approvalToken: "host-session-approval-token-1",
        bindingHash: call.params.binding.bindingHash,
        approvedAt: "2026-08-31T12:00:11Z",
        expiresAt: call.params.binding.payload.expiresAt,
      };
    } else {
      result = unavailable(call);
    }
    responses.set(call.callId, clone(result));
    return result;
  };
  return Object.freeze({
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
}

function createAuthoritySource(options = {}) {
  let current = clone(initialAuthority);
  const journal = new Map();
  const attempts = [];
  let logicalEffects = 0;
  return {
    source: Object.freeze({
      read: async () => clone(current),
      compareAndSwapSession: async (input) => {
        attempts.push(clone(input));
        if (options.throwSecret !== undefined) {
          throw new Error(options.throwSecret);
        }
        const existing = journal.get(input.commitId);
        if (existing !== undefined) {
          if (!same(existing.input, input)) {
            throw new Error("commitId was replayed with a different request");
          }
          return clone(existing.result);
        }
        if (!same(input.expected, current)) {
          throw new Error("Provider Session compare-and-swap is stale");
        }
        logicalEffects += 1;
        current = {
          currentContext: clone(input.expected.currentContext),
          currentSession: {
            version: "1.0",
            scope: clone(input.mutation.payload.scope),
            state: clone(input.mutation.payload.target),
          },
        };
        const result = options.invalidAcknowledgment
          ? {
              acknowledgment: {
                version: "1.0",
                commitId: "A".repeat(43),
                status: "committed",
                revision: input.mutation.payload.target.revision,
              },
              authority: clone(current),
            }
          : {
              acknowledgment: {
                version: "1.0",
                commitId: input.commitId,
                status: "committed",
                revision: input.mutation.payload.target.revision,
              },
              authority: clone(current),
            };
        journal.set(input.commitId, { input: clone(input), result: clone(result) });
        return result;
      },
    }),
    attempts,
    get logicalEffects() {
      return logicalEffects;
    },
    get current() {
      return clone(current);
    },
  };
}

function startInput(id) {
  return {
    version: "1.0",
    release: tws.TWS_RELEASE,
    request: {
      jsonrpc: "2.0",
      id,
      method: "tbc_switchChain",
      params: { chainId: testnet },
    },
  };
}

function host({ store, authority, ownerId, core = tws.createTwsCore() }) {
  return createTwsHost({
    core,
    store,
    authority: authority.source,
    ports: createPorts(),
    ownerId,
    ...TEST_LEASE_SCHEDULER,
  });
}

test("real Core chain switch commits Authority and delivers exactly once", async () => {
  const store = createMemoryTwsHostStore();
  const authority = createAuthoritySource();
  const wallet = host({ store, authority, ownerId: "session-real-core" });
  const result = await wallet.startOperation(startInput("session-real-core"));

  assert.equal(result.status, "complete");
  assert.equal(authority.logicalEffects, 1);
  assert.equal(authority.attempts.length, 1);
  assert.deepEqual(authority.attempts[0].expected, initialAuthority);
  assert.equal(authority.current.currentSession.state.activeChainId, testnet);
  const operation = await store.readOperation(result.operationId);
  const commitId = operation.transition.checkpoint.payload.memory
    .providerSessionCommitAck.commitId;
  assert.equal((await store.readSessionCommit(commitId)).status, "completed");
  assert.equal((await store.readDelivery(result.operationId)).status, "delivered");
  assert.deepEqual(
    await wallet.resumeOperation({ operationId: result.operationId }),
    result,
  );
  assert.equal(authority.logicalEffects, 1);
});
const SESSION_WINDOWS = [
  ["before-authority-cas", "prepared", 0, 1],
  ["after-authority-cas", "uncertain", 1, 2],
  ["after-commit-response", "completed", 1, 1],
];

for (const [window, expectedStatus, firstAttempts, finalAttempts] of SESSION_WINDOWS) {
  test(`Provider Session commit recovers ${window} with one logical CAS`, async () => {
    const baseStore = createMemoryTwsHostStore();
    const authority = createAuthoritySource();
    const state = { crashed: false };
    let store = baseStore;
    let core = tws.createTwsCore();
    if (window === "before-authority-cas") {
      store = Object.freeze({
        ...baseStore,
        markSessionCommitUncertain: async (input) => {
          if (!state.crashed) {
            state.crashed = true;
            throw new Error("simulated crash before Authority CAS");
          }
          return baseStore.markSessionCommitUncertain(input);
        },
      });
    } else if (window === "after-authority-cas") {
      store = Object.freeze({
        ...baseStore,
        completeSessionCommit: async (input) => {
          if (!state.crashed) {
            state.crashed = true;
            throw new Error("simulated crash before commit response persistence");
          }
          return baseStore.completeSessionCommit(input);
        },
      });
    } else {
      const realCore = core;
      core = Object.freeze({
        ...realCore,
        acknowledgeCommit: async (input) => {
          if (!state.crashed) {
            state.crashed = true;
            throw new Error("simulated crash before Core commit acknowledgment");
          }
          return realCore.acknowledgeCommit(input);
        },
      });
    }

    const first = host({
      store,
      authority,
      ownerId: `session-first-${window}`,
      core,
    });
    const interrupted = await first.startOperation(startInput(`session-${window}`));
    assert.equal(interrupted.status, "failed");
    assert.equal(state.crashed, true);
    assert.equal(authority.attempts.length, firstAttempts);
    const operation = await baseStore.readOperation(interrupted.operationId);
    assert.equal(operation.transition.kind, "commit");
    const commitId = operation.transition.mutation.commitId;
    assert.equal((await baseStore.readSessionCommit(commitId)).status, expectedStatus);

    const recovered = host({
      store: baseStore,
      authority,
      ownerId: `session-recovery-${window}`,
    });
    const result = await recovered.resumeOperation({
      operationId: interrupted.operationId,
    });
    assert.equal(result.status, "complete");
    assert.equal(authority.attempts.length, finalAttempts);
    assert.equal(authority.logicalEffects, 1);
    assert.equal((await baseStore.readSessionCommit(commitId)).status, "completed");
    if (authority.attempts.length === 2) {
      assert.deepEqual(authority.attempts[1], authority.attempts[0]);
    }
  });
}

test("Authority failures and invalid acknowledgments are scrubbed and fail closed", async () => {
  const secret = "private wallet database path must not escape";
  const throwing = createAuthoritySource({ throwSecret: secret });
  const failed = await host({
    store: createMemoryTwsHostStore(),
    authority: throwing,
    ownerId: "authority-secret-failure",
  }).startOperation(startInput("authority-secret-failure"));
  assert.equal(failed.status, "failed");
  assert.equal(failed.error.code, "HOST_AUTHORITY_FAILURE");
  assert.equal(JSON.stringify(failed).includes(secret), false);

  const invalid = createAuthoritySource({ invalidAcknowledgment: true });
  const invalidResult = await host({
    store: createMemoryTwsHostStore(),
    authority: invalid,
    ownerId: "authority-invalid-ack",
  }).startOperation(startInput("authority-invalid-ack"));
  assert.equal(invalidResult.status, "failed");
  assert.equal(invalidResult.error.code, "HOST_STORE_CORRUPT");
  assert.equal(invalid.logicalEffects, 1);
});

test("100 identical starts across two Hosts converge on one operation and delivery", async () => {
  const store = createMemoryTwsHostStore();
  const authority = createAuthoritySource();
  const first = host({ store, authority, ownerId: "concurrent-host-a" });
  const second = host({ store, authority, ownerId: "concurrent-host-b" });
  const input = startInput("session-concurrent-identical");
  const initial = await Promise.all(
    Array.from({ length: 100 }, (_, index) =>
      (index % 2 === 0 ? first : second).startOperation(clone(input)),
    ),
  );
  assert.equal(initial.some(({ status }) => status === "failed"), false);
  assert.equal(initial.some(({ status }) => status === "complete"), true);
  const operationIds = new Set(initial.map(({ operationId }) => operationId));
  assert.equal(operationIds.size, 1);
  const [operationId] = operationIds;

  for (const result of initial.filter(({ status }) => status === "busy")) {
    const replay = await first.resumeOperation({ operationId: result.operationId });
    assert.equal(replay.status, "complete");
  }
  assert.equal(authority.logicalEffects, 1);
  const operation = await store.readOperation(operationId);
  assert.equal(operation.terminal, true);
  const delivery = await store.readDelivery(operationId);
  assert.equal(delivery.status, "delivered");
  assert.equal(delivery.revision, "1");
});
