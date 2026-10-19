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

function makeController(persisted = createMemoryWebViewSessionStore()) {
  const posted = [];
  const closes = [];
  let resolveRequest;
  const request = new Promise((resolve) => { resolveRequest = resolve; });
  const controller = createTbcWebViewNativeController({
    channel: { post: (serialized) => posted.push(serialized), subscribe: () => () => undefined },
    store: persisted.store,
    chainId,
    handlers: {
      send: () => request,
      cancel: async () => undefined,
      async close(reason, authority) { closes.push({ reason, authority }); },
    },
  });
  return { controller, persisted, posted, closes, resolveRequest };
}

test("native navigation rejects forged, opaque, credentialed, and non-top authority", async () => {
  const invalid = [
    navigation({ origin: "https://forged.example" }),
    navigation({ topOrigin: "https://top.example" }),
    navigation({ frame: "iframe" }),
    navigation({ committedUrl: "data:text/html,unsafe", origin: "null", topOrigin: "null" }),
    navigation({ committedUrl: "file:///tmp/unsafe", origin: "null", topOrigin: "null" }),
    navigation({ committedUrl: "javascript:alert(1)", origin: "null", topOrigin: "null" }),
    navigation({ committedUrl: "https://user:pass@dapp.example/app" }),
    navigation({ createdAt: "not-a-time" }),
    navigation({ sessionId: "" }),
  ];
  for (const value of invalid) {
    const harness = makeController();
    await assert.rejects(harness.controller.openNavigation(value));
    assert.deepEqual(harness.posted, []);
  }
});

test("native controller rejects forged serialized authority and wrong WebView instance", async () => {
  const harness = makeController();
  await harness.controller.openNavigation(navigation());
  const ready = {
    channel: "tws-webview/1",
    type: "ready",
    sessionId: "session-1",
    navigationId: "navigation-1",
    messageId: "page-ready",
  };
  await harness.controller.acceptPageMessage({
    webViewInstanceId: "forged-webview",
    serialized: encodeTbcWebViewPageMessage(ready),
  });
  assert.equal(harness.closes[0].reason, "TRANSPORT_CLOSED");

  const second = makeController();
  await second.controller.openNavigation(navigation());
  await second.controller.acceptPageMessage({
    webViewInstanceId: "webview-1",
    serialized: JSON.stringify({ ...ready, origin: "https://forged.example" }),
  });
  assert.equal(second.closes[0].reason, "TRANSPORT_CLOSED");
});

test("same-Origin reload creates a new epoch and suppresses the old late result", async () => {
  const harness = makeController();
  await harness.controller.openNavigation(navigation());
  await harness.controller.acceptPageMessage({
    webViewInstanceId: "webview-1",
    serialized: encodeTbcWebViewPageMessage({
      channel: "tws-webview/1",
      type: "ready",
      sessionId: "session-1",
      navigationId: "navigation-1",
      messageId: "page-ready",
    }),
  });
  const sending = harness.controller.acceptPageMessage({
    webViewInstanceId: "webview-1",
    serialized: encodeTbcWebViewPageMessage({
      channel: "tws-webview/1",
      type: "request",
      sessionId: "session-1",
      navigationId: "navigation-1",
      messageId: "page-request",
      request: { jsonrpc: "2.0", id: "rpc-old", method: "tbc_chainId" },
    }),
  });
  await Promise.resolve();
  await harness.controller.openNavigation(navigation({
    sessionId: "session-2",
    navigationId: "navigation-2",
  }));
  const beforeLate = harness.posted.length;
  harness.resolveRequest({
    deliveryId: "e".repeat(64),
    response: { jsonrpc: "2.0", id: "rpc-old", result: chainId },
    events: [],
  });
  await sending;
  assert.equal(harness.posted.length, beforeLate);
  const messages = harness.posted.map(decodeTbcWebViewNativeMessage);
  assert.equal(messages.filter(({ type }) => type === "initialize").length, 2);
  assert.equal(messages.some(({ type }) => type === "delivery"), false);
  assert.equal(harness.closes[0].reason, "NAVIGATION_CHANGED");
});

