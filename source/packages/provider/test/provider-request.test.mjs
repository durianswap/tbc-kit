import assert from "node:assert/strict";
import test from "node:test";

import {
  ProviderRpcError,
  createTbcProvider,
} from "../dist/esm/index.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function controlledTransport() {
  const calls = [];
  let listener = () => {};
  let closeCalls = 0;
  return {
    calls,
    get closeCalls() {
      return closeCalls;
    },
    transport: {
      send(request) {
        const completion = deferred();
        calls.push({ request, ...completion });
        return completion.promise;
      },
      subscribe(next) {
        listener = next;
        return () => {
          listener = () => {};
        };
      },
      close() {
        closeCalls += 1;
      },
    },
    signal(value) {
      listener(value);
    },
  };
}

function delivery(id, result, deliveryIndex, events = []) {
  return {
    deliveryId: deliveryIndex.toString(16).padStart(64, "0"),
    response: { jsonrpc: "2.0", id, result },
    events,
  };
}

function rpcFailure(promise, code) {
  return assert.rejects(promise, (error) => {
    assert.equal(error instanceof ProviderRpcError, true);
    assert.equal(error.code, code);
    return true;
  });
}

test("correlates 100 same-method requests only by exact IDs out of order", async () => {
  const controlled = controlledTransport();
  let nextId = 0;
  const provider = createTbcProvider({
    transport: controlled.transport,
    requestIdFactory: () => nextId++,
  });
  const requests = Array.from({ length: 100 }, () =>
    provider.request({ method: "tbc_chainId" }),
  );
  assert.equal(controlled.calls.length, 100);

  for (let index = 99; index >= 0; index -= 1) {
    const chainId = `tbc:${index.toString(16).padStart(32, "0")}`;
    controlled.calls[index].resolve(
      delivery(controlled.calls[index].request.id, chainId, index + 1),
    );
  }
  const results = await Promise.all(requests);
  assert.deepEqual(
    results,
    Array.from(
      { length: 100 },
      (_, index) => `tbc:${index.toString(16).padStart(32, "0")}`,
    ),
  );
});

test("retains every session ID and rejects custom factory collisions", async () => {
  const controlled = controlledTransport();
  const provider = createTbcProvider({
    transport: controlled.transport,
    requestIdFactory: () => "same-id",
  });
  const first = provider.request({ method: "tbc_chainId" });
  await rpcFailure(provider.request({ method: "tbc_chainId" }), -32603);
  assert.equal(controlled.calls.length, 1);
  controlled.calls[0].resolve(
    delivery(
      "same-id",
      "tbc:00000000000000000000000000000001",
      1,
    ),
  );
  await first;
  await rpcFailure(provider.request({ method: "tbc_chainId" }), -32603);
  assert.equal(controlled.calls.length, 1);
});

test("treats string/number ID mismatches and unknown IDs as integrity failures", async () => {
  for (const responseId of ["1", 999]) {
    const controlled = controlledTransport();
    const ids = [1, 2];
    const provider = createTbcProvider({
      transport: controlled.transport,
      requestIdFactory: () => ids.shift(),
    });
    const first = provider.request({ method: "tbc_chainId" });
    const second = provider.request({ method: "tbc_chainId" });
    controlled.calls[0].resolve(
      delivery(
        responseId,
        "tbc:00000000000000000000000000000001",
        1,
      ),
    );
    await Promise.all([rpcFailure(first, 4900), rpcFailure(second, 4900)]);
    assert.equal(controlled.closeCalls, 1);
    controlled.calls[1].resolve(
      delivery(2, "tbc:00000000000000000000000000000002", 2),
    );
  }
});

test("converts valid RPC errors into immutable ProviderRpcError values", async () => {
  const controlled = controlledTransport();
  const provider = createTbcProvider({ transport: controlled.transport });
  const request = provider.request({ method: "tbc_chainId" });
  const id = controlled.calls[0].request.id;
  controlled.calls[0].resolve({
    deliveryId: "a".repeat(64),
    response: {
      jsonrpc: "2.0",
      id,
      error: {
        code: -32000,
        message: "Insufficient funds",
        data: {
          name: "INSUFFICIENT_FUNDS",
          stage: "planning",
          retryable: false,
          details: { asset: "tbc:native" },
        },
      },
    },
    events: [],
  });
  await assert.rejects(request, (error) => {
    assert.equal(error instanceof ProviderRpcError, true);
    assert.equal(error.code, -32000);
    assert.equal(error.message, "Insufficient funds");
    assert.equal(Object.isFrozen(error), true);
    assert.equal(Object.isFrozen(error.data), true);
    assert.equal(Object.isFrozen(error.data.details), true);
    return true;
  });
});

test("sanitizes malformed deliveries and transport exceptions", async () => {
  const secret = "secret-endpoint-token";
  const throwing = createTbcProvider({
    transport: {
      send() {
        throw new Error(secret);
      },
      subscribe() {
        return () => {};
      },
    },
  });
  await assert.rejects(
    throwing.request({ method: "tbc_chainId" }),
    (error) => {
      assert.equal(error instanceof ProviderRpcError, true);
      assert.equal(error.code, -32603);
      assert.equal(`${error.message}\n${error.stack}`.includes(secret), false);
      return true;
    },
  );

  const controlled = controlledTransport();
  const provider = createTbcProvider({ transport: controlled.transport });
  const first = provider.request({ method: "tbc_chainId" });
  const second = provider.request({ method: "tbc_chainId" });
  controlled.calls[0].resolve({
    deliveryId: "b".repeat(64),
    response: {
      jsonrpc: "2.0",
      id: controlled.calls[0].request.id,
      result: "tbc:00000000000000000000000000000001",
      error: { code: 4100, message: secret },
    },
    events: [],
  });
  await Promise.all([rpcFailure(first, 4900), rpcFailure(second, 4900)]);
  assert.equal(controlled.closeCalls, 1);

  const malformed = controlledTransport();
  const malformedProvider = createTbcProvider({ transport: malformed.transport });
  const malformedRequest = malformedProvider.request({ method: "tbc_chainId" });
  malformed.calls[0].resolve({
    deliveryId: "c".repeat(64),
    response: {
      jsonrpc: "2.0",
      id: malformed.calls[0].request.id,
      error: {
        code: -32000,
        message: "Execution failed",
        data: {
          name: "INSUFFICIENT_FUNDS",
          stage: "signing",
          retryable: false,
        },
      },
    },
    events: [],
  });
  await rpcFailure(malformedRequest, 4900);
  assert.equal(malformed.closeCalls, 1);
});
