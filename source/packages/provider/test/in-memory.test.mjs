import assert from "node:assert/strict";
import test from "node:test";

import {
  ProviderRpcError,
  TBC_PROVIDER_MAX_MESSAGE_BYTES,
  createTbcProvider,
} from "../dist/esm/index.js";
import { createInMemoryTransport } from "../dist/esm/in-memory.js";

const chainA = "tbc:00000000000000000000000000000001";
const chainB = "tbc:other";

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

test("adapts public request/delivery values and preserves response event order", async () => {
  let deliveryIndex = 0;
  const controller = createInMemoryTransport({
    async handler(request) {
      deliveryIndex += 1;
      return {
        deliveryId: deliveryIndex.toString(16).padStart(64, "0"),
        response: { jsonrpc: "2.0", id: request.id, result: null },
        events: [
          { name: "chainChanged", payload: request.params.chainId },
          { name: "accountsChanged", payload: [] },
        ],
      };
    },
  });
  const provider = createTbcProvider({ transport: controller.transport });
  const order = [];
  provider.on("chainChanged", (chainId) => order.push(`chain:${chainId}`));
  provider.on("accountsChanged", () => order.push("accounts"));
  const result = provider
    .request({ method: "tbc_switchChain", params: { chainId: chainB } })
    .then((value) => {
      order.push("settled");
      return value;
    });
  assert.equal(await result, null);
  await Promise.resolve();
  assert.deepEqual(order, ["settled", `chain:${chainB}`, "accounts"]);
});

test("relays out-of-band events synchronously and lets Provider enforce size", async () => {
  const controller = createInMemoryTransport({
    handler: async () => {
      throw new Error("not called");
    },
  });
  const provider = createTbcProvider({ transport: controller.transport });
  const observed = [];
  provider.on("chainChanged", (chainId) => observed.push(chainId));
  controller.emitEvent({ name: "chainChanged", payload: chainA });
  assert.deepEqual(observed, [chainA]);

  controller.emitEvent({
    name: "disconnect",
    payload: {
      code: 4900,
      message: "x".repeat(TBC_PROVIDER_MAX_MESSAGE_BYTES),
    },
  });
  assert.deepEqual(observed, [chainA]);
  await assert.rejects(
    provider.request({ method: "tbc_chainId" }),
    (error) => error instanceof ProviderRpcError && error.code === 4900,
  );
});

test("forwards abort cancellation and suppresses the handler's late completion", async () => {
  const completion = deferred();
  const cancellations = [];
  const controller = createInMemoryTransport({
    handler: () => completion.promise,
    onCancel(id, reason) {
      cancellations.push({ id, reason });
    },
  });
  const provider = createTbcProvider({ transport: controller.transport });
  const observed = [];
  provider.on("chainChanged", (chainId) => observed.push(chainId));
  const abort = new AbortController();
  const request = provider.request(
    { method: "tbc_chainId" },
    { signal: abort.signal },
  );
  abort.abort();
  await assert.rejects(
    request,
    (error) => error instanceof ProviderRpcError && error.code === -32603,
  );
  assert.equal(cancellations.length, 1);
  assert.equal(cancellations[0].reason, "REQUEST_ABORTED");
  completion.resolve({
    deliveryId: "a".repeat(64),
    response: {
      jsonrpc: "2.0",
      id: cancellations[0].id,
      result: chainA,
    },
    events: [{ name: "chainChanged", payload: chainA }],
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(observed, []);
});

test("close rejects pending sends, emits one close signal, and ignores late work", async () => {
  const completion = deferred();
  const controller = createInMemoryTransport({
    handler: () => completion.promise,
  });
  const signals = [];
  controller.transport.subscribe((signal) => signals.push(signal));
  const provider = createTbcProvider({ transport: controller.transport });
  const request = provider.request({ method: "tbc_chainId" });
  controller.close("SESSION_REVOKED");
  controller.close("TRANSPORT_CLOSED");
  await assert.rejects(
    request,
    (error) => error instanceof ProviderRpcError && error.code === 4900,
  );
  assert.deepEqual(signals, [
    { type: "close", reason: "SESSION_REVOKED" },
  ]);
  completion.resolve({
    deliveryId: "b".repeat(64),
    response: { jsonrpc: "2.0", id: "late", result: chainA },
    events: [{ name: "chainChanged", payload: chainA }],
  });
  await assert.rejects(controller.transport.send({
    jsonrpc: "2.0",
    id: "after-close",
    method: "tbc_chainId",
  }));
});

test("lets the Provider fail-close on an oversized handler delivery", async () => {
  const controller = createInMemoryTransport({
    async handler(request) {
      return {
        deliveryId: "c".repeat(64),
        response: { jsonrpc: "2.0", id: request.id, result: chainA },
        events: [
          {
            name: "disconnect",
            payload: {
              code: 4900,
              message: "x".repeat(TBC_PROVIDER_MAX_MESSAGE_BYTES),
            },
          },
        ],
      };
    },
  });
  const provider = createTbcProvider({ transport: controller.transport });
  await assert.rejects(
    provider.request({ method: "tbc_chainId" }),
    (error) => error instanceof ProviderRpcError && error.code === 4900,
  );
});
