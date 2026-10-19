import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as tws from "../dist/esm/index.js";
import {
  createMemoryTwsHostStore,
  createTwsHost,
} from "@tbc-wallet/host";
import { TEST_LEASE_SCHEDULER } from "../../host/test/fixtures/lease-scheduler.mjs";

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

function clone(value) {
  return structuredClone(value);
}

function authoritySource() {
  let current = clone(initialAuthority);
  return Object.freeze({
    read: async () => clone(current),
    compareAndSwapSession: async (input) => {
      current = {
        currentContext: clone(input.expected.currentContext),
        currentSession: {
          version: "1.0",
          scope: clone(input.mutation.payload.scope),
          state: clone(input.mutation.payload.target),
        },
      };
      return {
        acknowledgment: {
          version: "1.0",
          commitId: input.commitId,
          status: "committed",
          revision: input.mutation.payload.target.revision,
        },
        authority: clone(current),
      };
    },
  });
}

function concurrencyPorts(calls, delays = []) {
  let ordinal = 0;
  const unavailable = (call) => ({
    portError: {
      name: "UNAVAILABLE",
      message: `unused concurrency Port: ${call.operation}`,
      retryable: false,
    },
  });
  const permissionStore = async (call) => {
    const currentOrdinal = ordinal;
    ordinal += 1;
    calls.push(clone(call));
    const delay = delays[currentOrdinal] ?? 0;
    if (delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    return { revision: String(currentOrdinal), permissions: [] };
  };
  return Object.freeze({
    accounts: unavailable,
    chainData: unavailable,
    policy: unavailable,
    permissionStore,
    approval: unavailable,
    signer: unavailable,
    broadcast: unavailable,
    clock: () => ({ now: "2026-08-31T12:00:11Z" }),
    entropy: unavailable,
  });
}

function hostWith(delays = []) {
  const calls = [];
  const store = createMemoryTwsHostStore();
  const host = createTwsHost({
    core: tws.createTwsCore(),
    ports: concurrencyPorts(calls, delays),
    store,
    authority: authoritySource(),
    ownerId: "core-concurrency-public-host",
    ...TEST_LEASE_SCHEDULER,
  });
  return { host, store, calls };
}

function startInput(id, method = "tbc_chainId", params = []) {
  return {
    version: "1.0",
    release: tws.TWS_RELEASE,
    request: { jsonrpc: "2.0", id, method, params },
  };
}

test("public Host isolates 100 concurrent real Core checkpoints", async () => {
  const { host } = hostWith();
  const results = await Promise.all(
    Array.from({ length: 100 }, (_, index) =>
      host.startOperation(startInput(`concurrent-${String(index)}`)),
    ),
  );
  assert.equal(results.every(({ status }) => status === "complete"), true);
  assert.equal(new Set(results.map(({ operationId }) => operationId)).size, 100);
  const inspections = await Promise.all(
    results.map(({ operationId }) => host.inspectOperation({ operationId })),
  );
  assert.equal(inspections.every(({ terminal }) => terminal), true);
});

test("public Host correlates delayed same-name responses by their registered callId", async () => {
  const { host, store, calls } = hostWith([40, 0, 0, 0]);
  const results = await Promise.all([
    host.startOperation(startInput("permissions-delayed-a", "wallet_getPermissions")),
    host.startOperation(startInput("permissions-delayed-b", "wallet_getPermissions")),
  ]);
  assert.equal(results.every(({ status }) => status === "complete"), true);
  assert.equal(calls.length, 4);
  assert.equal(new Set(calls.map(({ callId }) => callId)).size, 4);
  for (const call of calls) {
    const record = await store.readCall(call.callId);
    assert.equal(record.callId, call.callId);
    assert.equal(record.operation, "permissionStore.load");
    assert.equal(record.response.callId, call.callId);
  }
});

test("public Host keeps simultaneous identical methods in separate journals", async () => {
  const { host, calls } = hostWith();
  const results = await Promise.all(
    Array.from({ length: 25 }, (_, index) =>
      host.startOperation(
        startInput(`permission-read-${String(index)}`, "wallet_getPermissions"),
      ),
    ),
  );
  assert.equal(results.every(({ status }) => status === "complete"), true);
  assert.equal(calls.length, 50);
  assert.equal(new Set(calls.map(({ callId }) => callId)).size, 50);
});
