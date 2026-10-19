import assert from "node:assert/strict";
import test from "node:test";

import { createTbcKitWebViewPageProvider } from "../dist/esm/index.js";
import { createTbcKitWebViewNativeController } from "../dist/esm/wallet.js";

const chainId = "tbc:00000000000000000000000000000001";
const navigation = Object.freeze({
  webViewInstanceId: "webview-1",
  sessionId: "session-1",
  navigationId: "navigation-1",
  committedUrl: "https://dapp.example/app",
  origin: "https://dapp.example",
  topOrigin: "https://dapp.example",
  frame: "top",
  createdAt: "2026-09-18T00:00:00Z",
});

function memoryStore() {
  const inbound = new Map();
  const deliveries = new Map();
  let live;
  let closed;
  const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  return {
    get closed() { return closed; },
    store: {
      async openSession(value) { live = structuredClone(value); },
      async closeSession(value) { closed = structuredClone(value); },
      async acceptInbound(value) {
        if (!live || closed) return "collision";
        const key = `${value.sessionId}:${value.messageId}`;
        const prior = inbound.get(key);
        if (prior) return same(prior, value) ? "replay" : "collision";
        inbound.set(key, structuredClone(value));
        return "accepted";
      },
      async enqueueDelivery(value) {
        const key = `${value.sessionId}:${value.deliveryId}`;
        const prior = deliveries.get(key);
        if (prior) {
          const { state: _state, ...comparable } = prior;
          return same(comparable, value) ? "replay" : "collision";
        }
        deliveries.set(key, { ...structuredClone(value), state: "pending" });
        return "accepted";
      },
      async markDeliverySent(value) {
        const record = deliveries.get(`${value.sessionId}:${value.deliveryId}`);
        if (!record || record.envelopeDigest !== value.envelopeDigest) return "collision";
        if (record.state === "pending") {
          record.state = "sent";
          return "accepted";
        }
        return "replay";
      },
      async acknowledgeDelivery(value) {
        const record = deliveries.get(`${value.sessionId}:${value.deliveryId}`);
        if (!record || record.envelopeDigest !== value.envelopeDigest || record.state === "pending") {
          return "collision";
        }
        if (record.state === "acknowledged") return "replay";
        record.state = "acknowledged";
        return "accepted";
      },
      async listOutstanding(sessionId) {
        return [...deliveries.values()]
          .filter((value) => value.sessionId === sessionId && value.state !== "acknowledged")
          .map((value) => structuredClone(value));
      },
    },
  };
}

test("the Kit-only page/native pair round-trips and terminates the bound session", async () => {
  const persisted = memoryStore();
  const pageListeners = new Set();
  const closed = [];
  let native;
  const page = createTbcKitWebViewPageProvider({
    channel: {
      post(serialized) {
        return native.acceptPageMessage({
          webViewInstanceId: navigation.webViewInstanceId,
          serialized,
        });
      },
      subscribe(listener) {
        pageListeners.add(listener);
        return () => pageListeners.delete(listener);
      },
    },
    isTopFrame: () => true,
    requestIdFactory: () => "kit-native-roundtrip",
  });
  native = createTbcKitWebViewNativeController({
    channel: {
      async post(serialized) {
        const message = JSON.parse(serialized);
        if (message.type === "initialize") page.acceptInitialize(serialized);
        else for (const listener of [...pageListeners]) listener(serialized);
      },
      subscribe() { return () => undefined; },
    },
    store: persisted.store,
    chainId,
    handlers: {
      async send(request, authority) {
        assert.deepEqual(authority, navigation);
        return {
          deliveryId: "a".repeat(64),
          response: { jsonrpc: "2.0", id: request.id, result: chainId },
          events: [],
        };
      },
      cancel: async () => undefined,
      async close(reason, authority) { closed.push({ reason, authority }); },
    },
  });

  await native.openNavigation(navigation);
  assert.equal(await page.provider.request({ method: "tbc_chainId" }), chainId);
  assert.deepEqual(await persisted.store.listOutstanding(navigation.sessionId), []);

  await native.close("NAVIGATION_CHANGED");
  assert.deepEqual(persisted.closed, {
    sessionId: navigation.sessionId,
    navigationId: navigation.navigationId,
    reason: "NAVIGATION_CHANGED",
  });
  assert.deepEqual(closed, [{ reason: "NAVIGATION_CHANGED", authority: navigation }]);
  await assert.rejects(page.provider.request({ method: "tbc_chainId" }));
  await page.destroy();
});
