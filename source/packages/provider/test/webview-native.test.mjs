import assert from "node:assert/strict";
import test from "node:test";

import {
  createTbcWebViewNativeController,
  decodeTbcWebViewNativeMessage,
  encodeTbcWebViewPageMessage,
} from "../dist/esm/webview.js";
import { createMemoryWebViewSessionStore } from "./fixtures/webview-session-store.mjs";

const chainId = "tbc:00000000000000000000000000000001";

function navigation(overrides = {}) {
  return {
    webViewInstanceId: "webview-1",
    sessionId: "session-1",
    navigationId: "navigation-1",
    committedUrl: "https://dapp.example/app",
    origin: "https://dapp.example",
    topOrigin: "https://dapp.example",
    frame: "top",
    createdAt: "2026-09-02T00:00:00Z",
    ...overrides,
  };
}

function page(type, fields = {}, ordinal = type) {
  return encodeTbcWebViewPageMessage({
    channel: "tws-webview/1",
    type,
    sessionId: "session-1",
    navigationId: "navigation-1",
    messageId: `page-${ordinal}`,
    ...fields,
  });
}

function setup() {
  const persisted = createMemoryWebViewSessionStore();
  const posted = [];
  const sent = [];
  const cancelled = [];
  const closed = [];
  const controller = createTbcWebViewNativeController({
    channel: { post: (serialized) => posted.push(serialized), subscribe: () => () => undefined },
    store: persisted.store,
    chainId,
    handlers: {
      async send(request, authority) {
        sent.push({ request, authority });
        return {
          deliveryId: "d".repeat(64),
          response: { jsonrpc: "2.0", id: request.id, result: chainId },
          events: [],
        };
      },
      async cancel(requestId, reason, authority) {
        cancelled.push({ requestId, reason, authority });
      },
      async close(reason, authority) {
        closed.push({ reason, authority });
      },
    },
  });
  return { controller, persisted, posted, sent, cancelled, closed };
}

test("native controller dispatches only after bound ready and persists delivery acknowledgment", async () => {
  const harness = setup();
  await harness.controller.openNavigation(navigation());
  assert.equal(decodeTbcWebViewNativeMessage(harness.posted[0]).type, "initialize");
  await harness.controller.acceptPageMessage({
    webViewInstanceId: "webview-1",
    serialized: page("ready"),
  });
  await harness.controller.acceptPageMessage({
    webViewInstanceId: "webview-1",
    serialized: page("request", {
      request: { jsonrpc: "2.0", id: "rpc-1", method: "tbc_chainId" },
    }),
  });
  assert.equal(harness.sent.length, 1);
  assert.deepEqual(harness.sent[0].authority, navigation());
  const delivery = harness.posted.map(decodeTbcWebViewNativeMessage)
    .find((message) => message.type === "delivery");
  assert.equal(delivery.response.id, "rpc-1");
  assert.equal((await harness.persisted.store.listOutstanding("session-1"))[0].state, "sent");
  await harness.controller.acceptPageMessage({
    webViewInstanceId: "webview-1",
    serialized: page("ack", { deliveryId: delivery.deliveryId }),
  });
  assert.deepEqual(await harness.persisted.store.listOutstanding("session-1"), []);
});

test("native accepts the outbox before acknowledging Host delivery and posting", async () => {
  const persisted = createMemoryWebViewSessionStore();
  const order = [];
  const originalEnqueue = persisted.store.enqueueDelivery;
  const originalMarkSent = persisted.store.markDeliverySent;
  persisted.store.enqueueDelivery = async (input) => {
    order.push("outbox");
    return originalEnqueue(input);
  };
  persisted.store.markDeliverySent = async (input) => {
    order.push("mark-sent");
    return originalMarkSent(input);
  };
  const controller = createTbcWebViewNativeController({
    channel: {
      post(serialized) {
        if (decodeTbcWebViewNativeMessage(serialized).type === "delivery") {
          order.push("post");
        }
      },
      subscribe: () => () => undefined,
    },
    store: persisted.store,
    chainId,
    handlers: {
      async send(request) {
        return {
          deliveryId: "a".repeat(64),
          response: { jsonrpc: "2.0", id: request.id, result: chainId },
          events: [],
        };
      },
      async acknowledgeDelivery(deliveryId) {
        assert.equal(deliveryId, "a".repeat(64));
        order.push("host-ack");
      },
      cancel: async () => undefined,
      close: async () => undefined,
    },
  });
  await controller.openNavigation(navigation());
  await controller.acceptPageMessage({
    webViewInstanceId: "webview-1",
    serialized: page("ready", {}, "ack-order-ready"),
  });
  await controller.acceptPageMessage({
    webViewInstanceId: "webview-1",
    serialized: page(
      "request",
      { request: { jsonrpc: "2.0", id: "ack-order", method: "tbc_chainId" } },
      "ack-order-request",
    ),
  });
  assert.deepEqual(order, ["outbox", "mark-sent", "host-ack", "post"]);
});

test("native persists sent before dispatch so a fast synchronous ACK is accepted once", async () => {
  const persisted = createMemoryWebViewSessionStore();
  const originalAcknowledge = persisted.store.acknowledgeDelivery;
  let storeAcknowledgments = 0;
  persisted.store.acknowledgeDelivery = async (input) => {
    storeAcknowledgments += 1;
    return originalAcknowledge(input);
  };
  const posted = [];
  const sent = [];
  const hostAcknowledgments = [];
  const closed = [];
  let controller;
  controller = createTbcWebViewNativeController({
    channel: {
      async post(serialized) {
        const message = decodeTbcWebViewNativeMessage(serialized);
        posted.push(message);
        if (message.type === "delivery") {
          await controller.acceptPageMessage({
            webViewInstanceId: "webview-1",
            serialized: page(
              "ack",
              { deliveryId: message.deliveryId },
              "fast-synchronous-ack",
            ),
          });
        }
      },
      subscribe: () => () => undefined,
    },
    store: persisted.store,
    chainId,
    handlers: {
      async send(request) {
        sent.push(request);
        return {
          deliveryId: "9".repeat(64),
          response: { jsonrpc: "2.0", id: request.id, result: chainId },
          events: [],
        };
      },
      async acknowledgeDelivery(deliveryId) {
        hostAcknowledgments.push(deliveryId);
      },
      cancel: async () => undefined,
      async close(reason) { closed.push(reason); },
    },
  });
  await controller.openNavigation(navigation());
  await controller.acceptPageMessage({
    webViewInstanceId: "webview-1",
    serialized: page("ready", {}, "fast-ready"),
  });
  await controller.acceptPageMessage({
    webViewInstanceId: "webview-1",
    serialized: page("request", {
      request: { jsonrpc: "2.0", id: "fast-request", method: "tbc_chainId" },
    }, "fast-request"),
  });

  assert.equal(sent.length, 1);
  assert.equal(posted.filter(({ type }) => type === "delivery").length, 1);
  assert.deepEqual(hostAcknowledgments, ["9".repeat(64)]);
  assert.equal(storeAcknowledgments, 1);
  assert.deepEqual(await persisted.store.listOutstanding("session-1"), []);
  assert.deepEqual(closed, []);
});

test("native does not dispatch or acknowledge a delivery when mark-sent collides", async () => {
  const persisted = createMemoryWebViewSessionStore();
  persisted.store.markDeliverySent = async () => "collision";
  const posted = [];
  const sent = [];
  const hostAcknowledgments = [];
  const closed = [];
  const controller = createTbcWebViewNativeController({
    channel: {
      post(serialized) { posted.push(decodeTbcWebViewNativeMessage(serialized)); },
      subscribe: () => () => undefined,
    },
    store: persisted.store,
    chainId,
    handlers: {
      async send(request) {
        sent.push(request);
        return {
          deliveryId: "8".repeat(64),
          response: { jsonrpc: "2.0", id: request.id, result: chainId },
          events: [],
        };
      },
      async acknowledgeDelivery(deliveryId) {
        hostAcknowledgments.push(deliveryId);
      },
      cancel: async () => undefined,
      async close(reason) { closed.push(reason); },
    },
  });
  await controller.openNavigation(navigation());
  await controller.acceptPageMessage({
    webViewInstanceId: "webview-1",
    serialized: page("ready", {}, "collision-ready"),
  });
  await controller.acceptPageMessage({
    webViewInstanceId: "webview-1",
    serialized: page("request", {
      request: { jsonrpc: "2.0", id: "collision-request", method: "tbc_chainId" },
    }, "collision-request"),
  });

  assert.equal(sent.length, 1);
  assert.equal(posted.filter(({ type }) => type === "delivery").length, 0);
  assert.deepEqual(hostAcknowledgments, []);
  assert.deepEqual(closed, ["TRANSPORT_CLOSED"]);
});

test("native keeps a sent outstanding delivery recoverable when page post fails", async () => {
  const persisted = createMemoryWebViewSessionStore();
  let deliveryPosts = 0;
  const closed = [];
  const controller = createTbcWebViewNativeController({
    channel: {
      post(serialized) {
        const message = decodeTbcWebViewNativeMessage(serialized);
        if (message.type === "delivery") {
          deliveryPosts += 1;
          throw new Error("page post failed");
        }
      },
      subscribe: () => () => undefined,
    },
    store: persisted.store,
    chainId,
    handlers: {
      async send(request) {
        return {
          deliveryId: "7".repeat(64),
          response: { jsonrpc: "2.0", id: request.id, result: chainId },
          events: [],
        };
      },
      cancel: async () => undefined,
      async close(reason) { closed.push(reason); },
    },
  });
  await controller.openNavigation(navigation());
  await controller.acceptPageMessage({
    webViewInstanceId: "webview-1",
    serialized: page("ready", {}, "post-failure-ready"),
  });
  await controller.acceptPageMessage({
    webViewInstanceId: "webview-1",
    serialized: page("request", {
      request: { jsonrpc: "2.0", id: "post-failure", method: "tbc_chainId" },
    }, "post-failure-request"),
  });

  assert.equal(deliveryPosts, 1);
  assert.equal((await persisted.store.listOutstanding("session-1"))[0].state, "sent");
  assert.deepEqual(closed, ["TRANSPORT_CLOSED"]);
});

test("native suppression acknowledges Host without creating a wire delivery", async () => {
  const persisted = createMemoryWebViewSessionStore();
  const posted = [];
  const acknowledged = [];
  const controller = createTbcWebViewNativeController({
    channel: {
      post: (serialized) => posted.push(serialized),
      subscribe: () => () => undefined,
    },
    store: persisted.store,
    chainId,
    handlers: {
      async send() {
        return { status: "suppressed", deliveryId: "b".repeat(64) };
      },
      async acknowledgeDelivery(deliveryId) {
        acknowledged.push(deliveryId);
      },
      cancel: async () => undefined,
      close: async () => undefined,
    },
  });
  await controller.openNavigation(navigation());
  await controller.acceptPageMessage({
    webViewInstanceId: "webview-1",
    serialized: page("ready", {}, "suppress-ready"),
  });
  await controller.acceptPageMessage({
    webViewInstanceId: "webview-1",
    serialized: page(
      "request",
      { request: { jsonrpc: "2.0", id: "suppressed", method: "tbc_chainId" } },
      "suppress-request",
    ),
  });

  assert.deepEqual(acknowledged, ["b".repeat(64)]);
  assert.deepEqual(await persisted.store.listOutstanding("session-1"), []);
  assert.equal(
    posted.map(decodeTbcWebViewNativeMessage).some(({ type }) => type === "delivery"),
    false,
  );
});

test("native controller accepts only REQUEST_ABORTED from the live authoritative instance", async () => {
  const harness = setup();
  await harness.controller.openNavigation(navigation());
  await harness.controller.acceptPageMessage({
    webViewInstanceId: "webview-1",
    serialized: page("ready"),
  });
  await harness.controller.acceptPageMessage({
    webViewInstanceId: "webview-1",
    serialized: page("cancel", { requestId: "rpc-1", reason: "REQUEST_ABORTED" }),
  });
  assert.equal(harness.cancelled.length, 1);
  assert.equal(harness.cancelled[0].reason, "REQUEST_ABORTED");
  assert.deepEqual(harness.cancelled[0].authority, navigation());
});

test("native controller fails closed on response correlation and Store failures", async () => {
  for (const failure of ["response", "store"]) {
    const persisted = createMemoryWebViewSessionStore();
    if (failure === "store") {
      persisted.store.acceptInbound = async () => { throw new Error("private-marker"); };
    }
    const posted = [];
    const closed = [];
    const controller = createTbcWebViewNativeController({
      channel: { post: (serialized) => posted.push(serialized), subscribe: () => () => undefined },
      store: persisted.store,
      chainId,
      handlers: {
        async send() {
          return {
            deliveryId: "e".repeat(64),
            response: { jsonrpc: "2.0", id: "wrong-rpc-id", result: chainId },
            events: [],
          };
        },
        cancel: async () => undefined,
        async close(reason) { closed.push(reason); },
      },
    });
    await controller.openNavigation(navigation());
    await controller.acceptPageMessage({
      webViewInstanceId: "webview-1",
      serialized: page("ready", {}, `${failure}-ready`),
    });
    await controller.acceptPageMessage({
      webViewInstanceId: "webview-1",
      serialized: page("request", {
        request: { jsonrpc: "2.0", id: "rpc-expected", method: "tbc_chainId" },
      }, `${failure}-request`),
    }).catch((error) => {
      assert.equal(String(error).includes("private-marker"), false);
    });
    assert.deepEqual(closed, ["TRANSPORT_CLOSED"]);
    assert.equal(posted.map(decodeTbcWebViewNativeMessage)
      .some((message) => message.type === "delivery"), false);
  }
});
