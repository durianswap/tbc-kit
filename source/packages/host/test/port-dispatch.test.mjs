import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  TWS_HOST_OPERATION_PORTS,
  TWS_HOST_PORT_NAMES,
  createMemoryTwsHostStore,
  createTwsHost,
  dispatchHostPort,
} from "../dist/esm/index.js";
import { createStoreTransitionFlow } from "./fixtures/store-transitions.mjs";
import { TEST_LEASE_SCHEDULER } from "./fixtures/lease-scheduler.mjs";

const registry = JSON.parse(
  await readFile(
    new URL("../../../registry/integration-ports.json", import.meta.url),
    "utf8",
  ),
);

const expectedMapping = Object.fromEntries(
  registry.ports.flatMap((port) =>
    port.operations.map((operation) => [operation.name, port.name]),
  ),
);

function unavailable(call) {
  return {
    portError: {
      name: "UNAVAILABLE",
      message: `Unavailable fixture for ${call.operation}`,
      retryable: true,
    },
  };
}

function ports(overrides = {}) {
  return Object.freeze({
    accounts: unavailable,
    chainData: unavailable,
    policy: unavailable,
    permissionStore: unavailable,
    approval: unavailable,
    signer: unavailable,
    broadcast: unavailable,
    clock: unavailable,
    entropy: unavailable,
    ...overrides,
  });
}

function call(operation, index) {
  const finalCharacters = "AEIMQUYcgkosw048";
  return {
    version: "1.0",
    callId: `${"A".repeat(42)}${finalCharacters[index]}`,
    operation,
    params: { version: "1.0" },
  };
}

test("dispatcher maps every registered operation to exactly one Host Port", async () => {
  assert.deepEqual(TWS_HOST_OPERATION_PORTS, expectedMapping);
  assert.deepEqual(Object.keys(TWS_HOST_OPERATION_PORTS), registry.ports.flatMap(
    (port) => port.operations.map((operation) => operation.name),
  ));
  assert.deepEqual(TWS_HOST_PORT_NAMES, registry.ports.map((port) => port.name));

  const seen = [];
  const handlers = Object.fromEntries(
    TWS_HOST_PORT_NAMES.map((name) => [
      name,
      async (received) => {
        seen.push({ name, call: structuredClone(received) });
        return unavailable(received);
      },
    ]),
  );
  const calls = Object.keys(expectedMapping).map(call);
  const responses = await Promise.all(
    calls.map((item) => dispatchHostPort(handlers, item)),
  );

  assert.deepEqual(
    seen.map(({ name }) => name),
    calls.map(({ operation }) => expectedMapping[operation]),
  );
  assert.deepEqual(seen.map(({ call: item }) => item), calls);
  assert.equal(
    responses.every(
      (response, index) =>
        response.callId === calls[index].callId &&
        response.error?.name === "UNAVAILABLE",
    ),
    true,
  );
});

test("dispatcher validates successes and scrubs thrown or malformed Port failures", async () => {
  const clockCall = {
    version: "1.0",
    callId: "A".repeat(43),
    operation: "clock.now",
    params: { version: "1.0" },
  };
  assert.deepEqual(
    await dispatchHostPort(
      ports({ clock: async () => ({ now: "2026-09-01T00:00:00Z" }) }),
      clockCall,
    ),
    {
      version: "1.0",
      callId: clockCall.callId,
      result: { now: "2026-09-01T00:00:00Z" },
    },
  );

  const secret = "private endpoint and signature must never escape";
  const thrown = await dispatchHostPort(
    ports({ clock: async () => { throw new Error(secret); } }),
    clockCall,
  );
  assert.deepEqual(thrown, {
    version: "1.0",
    callId: clockCall.callId,
    error: {
      name: "INTERNAL_ERROR",
      message: "The Host Port failed.",
      retryable: false,
    },
  });
  assert.equal(JSON.stringify(thrown).includes(secret), false);

  const malformed = await dispatchHostPort(
    ports({ clock: async () => ({ signature: secret }) }),
    clockCall,
  );
  assert.deepEqual(malformed, thrown);
});

test("Host rejects missing, extra, and hidden Port capabilities", () => {
  const inert = async () => unavailable({ operation: "clock.now" });
  const core = {
    start: inert,
    resume: inert,
    acknowledgeCommit: inert,
    cancel: inert,
  };
  const authority = { read: inert, compareAndSwapSession: inert };
  const store = createMemoryTwsHostStore();
  const valid = ports();

  assert.doesNotThrow(() =>
    createTwsHost({
      core,
      ports: valid,
      store,
      authority,
      ownerId: "exact-ports",
      ...TEST_LEASE_SCHEDULER,
    }),
  );
  function declaredPort(value) {
    return unavailable(value);
  }
  assert.doesNotThrow(() =>
    createTwsHost({
      core,
      ports: { ...valid, accounts: declaredPort },
      store,
      authority,
      ownerId: "declared-function-port",
      ...TEST_LEASE_SCHEDULER,
    }),
  );
  function legacyDeclaredPort(value) {
    return unavailable(value);
  }
  for (const intrinsic of ["caller", "arguments"]) {
    Object.defineProperty(legacyDeclaredPort, intrinsic, {
      value: null,
      writable: false,
      enumerable: false,
      configurable: false,
    });
  }
  assert.doesNotThrow(() =>
    createTwsHost({
      core,
      ports: { ...valid, accounts: legacyDeclaredPort },
      store,
      authority,
      ownerId: "legacy-declared-function-port",
      ...TEST_LEASE_SCHEDULER,
    }),
  );
  const throwTypeError = () => {
    throw new TypeError("restricted function property");
  };
  function customAccessorPort(value) {
    return unavailable(value);
  }
  for (const intrinsic of ["caller", "arguments"]) {
    Object.defineProperty(customAccessorPort, intrinsic, {
      get: throwTypeError,
      set: throwTypeError,
      enumerable: false,
      configurable: false,
    });
  }
  assert.throws(() =>
    createTwsHost({
      core,
      ports: { ...valid, accounts: customAccessorPort },
      store,
      authority,
      ownerId: "custom-accessor-function-port",
      ...TEST_LEASE_SCHEDULER,
    }),
    /capabilit/i,
  );
  assert.throws(
    () => createTwsHost({
      core,
      ports: { ...valid, telemetry: inert },
      store,
      authority,
      ownerId: "extra-port",
      ...TEST_LEASE_SCHEDULER,
    }),
    /exactly nine|unknown|capabilit/i,
  );
  const { entropy: _removed, ...missing } = valid;
  assert.throws(
    () => createTwsHost({
      core,
      ports: missing,
      store,
      authority,
      ownerId: "missing-port",
      ...TEST_LEASE_SCHEDULER,
    }),
    /exactly nine|missing|capabilit/i,
  );
  const signer = async (value) => unavailable(value);
  signer.secretHandle = "must-not-cross-boundary";
  assert.throws(
    () => createTwsHost({
      core,
      ports: { ...valid, signer },
      store,
      authority,
      ownerId: "hidden-port-capability",
      ...TEST_LEASE_SCHEDULER,
    }),
    /hidden|capabilit/i,
  );
  declaredPort.prototype.secretHandle = "must-not-cross-boundary";
  assert.throws(
    () => createTwsHost({
      core,
      ports: { ...valid, accounts: declaredPort },
      store,
      authority,
      ownerId: "prototype-hidden-port-capability",
      ...TEST_LEASE_SCHEDULER,
    }),
    /hidden|capabilit/i,
  );
  delete declaredPort.prototype.secretHandle;
  Object.setPrototypeOf(declaredPort.prototype, {
    vaultHandle: "must-not-cross-inherited-boundary",
  });
  assert.throws(
    () => createTwsHost({
      core,
      ports: { ...valid, accounts: declaredPort },
      store,
      authority,
      ownerId: "inherited-prototype-hidden-port-capability",
      ...TEST_LEASE_SCHEDULER,
    }),
    /hidden|prototype|capabilit/i,
  );
});

test("driver journals waiting calls before dispatch and resumes with persisted responses", async () => {
  const flow = await createStoreTransitionFlow("driver-port-journal");
  let index = 0;
  const resumed = [];
  const core = {
    start: async () => structuredClone(flow.transitions[0]),
    resume: async (input) => {
      if (input.response !== undefined) {
        resumed.push(structuredClone(input.response));
      }
      index += 1;
      return structuredClone(flow.transitions[index]);
    },
    acknowledgeCommit: async () => structuredClone(flow.transitions.at(-1)),
    cancel: async () => {
      throw new Error("cancel is not part of Port dispatch phase");
    },
  };
  const seen = [];
  const tracedPorts = ports(Object.fromEntries(
    TWS_HOST_PORT_NAMES.map((name) => [name, async (received) => {
      seen.push({ name, callId: received.callId, operation: received.operation });
      return unavailable(received);
    }]),
  ));
  const store = createMemoryTwsHostStore();
  const host = createTwsHost({
    core,
    ports: tracedPorts,
    store,
    authority: {
      read: async () => structuredClone(flow.authority),
      compareAndSwapSession: async (input) => ({
        acknowledgment: {
          version: "1.0",
          commitId: input.commitId,
          status: "committed",
          revision: input.mutation.payload.target.revision,
        },
        authority: structuredClone(flow.authority),
      }),
    },
    ownerId: "driver-port-owner",
    ...TEST_LEASE_SCHEDULER,
  });

  const result = await host.startOperation({
    version: "1.0",
    release: flow.transitions[0].checkpoint.payload.release,
    request: {
      jsonrpc: "2.0",
      id: "ignored-scripted-request",
      method: "tbc_switchChain",
      params: { chainId: "tbc:testnet" },
    },
  });
  assert.equal(result.status, "complete");
  assert.equal(seen.length, resumed.length);
  assert.equal(seen.length > 0, true);
  for (const item of seen) {
    const journal = await store.readCall(item.callId);
    assert.equal(journal.status, "completed");
    assert.equal(journal.operation, item.operation);
  }
  assert.deepEqual(
    resumed.map((response) => response.callId),
    seen.map((item) => item.callId),
  );
});
