import assert from "node:assert/strict";
import test from "node:test";

import {
  createTbcWebViewNativeController,
  decodeTbcWebViewNativeMessage,
  encodeTbcWebViewPageMessage,
} from "../dist/esm/webview.js";
import { createMemoryWebViewSessionStore } from "./fixtures/webview-session-store.mjs";

const chainId = "tbc:00000000000000000000000000000001";
const authority = {
  webViewInstanceId: "webview-1",
  sessionId: "session-1",
  navigationId: "navigation-1",
  committedUrl: "https://dapp.example/app",
  origin: "https://dapp.example",
  topOrigin: "https://dapp.example",
  frame: "top",
  createdAt: "2026-09-02T00:00:00Z",
};

function page(type, fields = {}, ordinal = type) {
  return encodeTbcWebViewPageMessage({
    channel: "tws-webview/1",
    type,
    sessionId: authority.sessionId,
    navigationId: authority.navigationId,
    messageId: `page-${ordinal}`,
    ...fields,
  });
}

function controller(persisted, posted, post = (serialized) => posted.push(serialized)) {
  return createTbcWebViewNativeController({
    channel: { post, subscribe: () => () => undefined },
    store: persisted.store,
    chainId,
    handlers: {
      async send(request) {
        return {
          deliveryId: "f".repeat(64),
          response: { jsonrpc: "2.0", id: request.id, result: chainId },
          events: [],
        };
      },
      cancel: async () => undefined,
      close: async () => undefined,
    },
  });
}

test("native outbox durably marks sent before a blocked post and replays identical bytes", async () => {
  const persisted = createMemoryWebViewSessionStore();
  const originalMarkSent = persisted.store.markDeliverySent;
  let observeMarkedSent;
  const markedSent = new Promise((resolve) => { observeMarkedSent = resolve; });
  persisted.store.markDeliverySent = async (input) => {
    const decision = await originalMarkSent(input);
    observeMarkedSent();
    return decision;
  };
  const firstPosted = [];
  let holdDelivery;
  const blocked = new Promise((resolve) => { holdDelivery = resolve; });
  const first = controller(persisted, firstPosted, (serialized) => {
    const message = decodeTbcWebViewNativeMessage(serialized);
    firstPosted.push(serialized);
    return message.type === "delivery" ? blocked : undefined;
  });
  await first.openNavigation(authority);
  await first.acceptPageMessage({ webViewInstanceId: "webview-1", serialized: page("ready") });
  const pendingDispatch = first.acceptPageMessage({
    webViewInstanceId: "webview-1",
    serialized: page("request", {
      request: { jsonrpc: "2.0", id: "rpc-outbox", method: "tbc_chainId" },
    }),
  });
  await markedSent;
  const outstanding = await persisted.store.listOutstanding(authority.sessionId);
  assert.equal(outstanding[0].state, "sent");

  const secondPosted = [];
  const second = controller(persisted, secondPosted);
  await second.openNavigation(authority);
  await second.acceptPageMessage({
    webViewInstanceId: "webview-1",
    serialized: page("ready", {}, "ready-restart"),
  });
  const replayed = secondPosted.map(decodeTbcWebViewNativeMessage)
    .find((message) => message.type === "delivery");
  assert.equal(replayed.deliveryId, "f".repeat(64));
  assert.equal(
    secondPosted.find((serialized) => decodeTbcWebViewNativeMessage(serialized).type === "delivery"),
    outstanding[0].canonicalEnvelope,
  );
  assert.equal((await persisted.store.listOutstanding(authority.sessionId))[0].state, "sent");

  const thirdPosted = [];
  const third = controller(persisted, thirdPosted);
  await third.openNavigation(authority);
  await third.acceptPageMessage({
    webViewInstanceId: "webview-1",
    serialized: page("ready", {}, "ready-second-restart"),
  });
  assert.equal(
    thirdPosted.find((serialized) => decodeTbcWebViewNativeMessage(serialized).type === "delivery"),
    outstanding[0].canonicalEnvelope,
  );
  await third.acceptPageMessage({
    webViewInstanceId: "webview-1",
    serialized: page("ack", { deliveryId: replayed.deliveryId }, "ack"),
  });
  assert.deepEqual(await persisted.store.listOutstanding(authority.sessionId), []);

  holdDelivery();
  await pendingDispatch;
});

test("native outbox never replays an old session into a replacement navigation", async () => {
  const persisted = createMemoryWebViewSessionStore();
  await persisted.store.openSession(authority);
  await persisted.store.enqueueDelivery({
    sessionId: authority.sessionId,
    navigationId: authority.navigationId,
    deliveryId: "a".repeat(64),
    canonicalEnvelope: "old-session-bytes",
    envelopeDigest: "b".repeat(64),
  });
  const posted = [];
  const replacement = controller(persisted, posted);
  await replacement.openNavigation({
    ...authority,
    sessionId: "session-2",
    navigationId: "navigation-2",
  });
  await replacement.acceptPageMessage({
    webViewInstanceId: "webview-1",
    serialized: encodeTbcWebViewPageMessage({
      channel: "tws-webview/1",
      type: "ready",
      sessionId: "session-2",
      navigationId: "navigation-2",
      messageId: "page-ready-new",
    }),
  });
  assert.equal(posted.map(decodeTbcWebViewNativeMessage)
    .some((message) => message.type === "delivery"), false);
});
