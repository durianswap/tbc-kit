import assert from "node:assert/strict";
import test from "node:test";

import {
  TBC_WEBVIEW_CHANNEL,
  TBC_WEBVIEW_MAX_MESSAGE_BYTES,
  decodeTbcWebViewNativeMessage,
  decodeTbcWebViewPageMessage,
  encodeTbcWebViewNativeMessage,
  encodeTbcWebViewPageMessage,
} from "../dist/esm/webview.js";

const sessionId = "session-1";
const navigationId = "navigation-1";
const chainId = "tbc:00000000000000000000000000000001";
const base = { channel: "tws-webview/1", sessionId, navigationId };

const pageMessages = [
  { ...base, type: "ready", messageId: "page-1" },
  {
    ...base,
    type: "request",
    messageId: "page-2",
    request: { jsonrpc: "2.0", id: "rpc-1", method: "tbc_chainId" },
  },
  {
    ...base,
    type: "cancel",
    messageId: "page-3",
    requestId: "rpc-1",
    reason: "REQUEST_ABORTED",
  },
  {
    ...base,
    type: "ack",
    messageId: "page-4",
    deliveryId: "d".repeat(64),
  },
];

const nativeMessages = [
  {
    ...base,
    type: "initialize",
    messageId: "native-1",
    origin: "https://dapp.example",
    chainId,
  },
  {
    ...base,
    type: "delivery",
    messageId: "native-2",
    deliveryId: "d".repeat(64),
    response: { jsonrpc: "2.0", id: "rpc-1", result: chainId },
    events: [{ name: "chainChanged", payload: chainId }],
  },
  {
    ...base,
    type: "event",
    messageId: "native-3",
    event: { name: "chainChanged", payload: chainId },
  },
  {
    ...base,
    type: "close",
    messageId: "native-4",
    reason: "NAVIGATION_CHANGED",
  },
];

test("WebView codecs round-trip the exact eight channel envelopes", () => {
  assert.equal(TBC_WEBVIEW_CHANNEL, "tws-webview/1");
  assert.equal(TBC_WEBVIEW_MAX_MESSAGE_BYTES, 4 * 1024 * 1024);
  for (const message of pageMessages) {
    const encoded = encodeTbcWebViewPageMessage(message);
    assert.deepEqual(decodeTbcWebViewPageMessage(encoded), message);
    assert.equal(Object.isFrozen(decodeTbcWebViewPageMessage(encoded)), true);
  }
  for (const message of nativeMessages) {
    const encoded = encodeTbcWebViewNativeMessage(message);
    assert.deepEqual(decodeTbcWebViewNativeMessage(encoded), message);
    assert.equal(Object.isFrozen(decodeTbcWebViewNativeMessage(encoded)), true);
  }
});

test("WebView codecs reject extra keys, accessors, symbols, and hostile prototypes", () => {
  assert.throws(() => encodeTbcWebViewPageMessage({ ...pageMessages[0], hidden: true }));
  assert.throws(() => encodeTbcWebViewNativeMessage({ ...nativeMessages[0], hidden: true }));
  assert.throws(() => encodeTbcWebViewPageMessage(Object.assign(
    Object.create({ inherited: true }),
    pageMessages[0],
  )));

  let accessed = 0;
  const accessor = { ...pageMessages[0] };
  Object.defineProperty(accessor, "type", {
    enumerable: true,
    get() {
      accessed += 1;
      return "ready";
    },
  });
  assert.throws(() => encodeTbcWebViewPageMessage(accessor));
  assert.equal(accessed, 0);

  const symbol = { ...nativeMessages[0], [Symbol("hidden")]: true };
  assert.throws(() => encodeTbcWebViewNativeMessage(symbol));
});

test("WebView decoders reject duplicates, non-canonical JSON, invalid Unicode, and non-I-JSON numbers", () => {
  assert.throws(() => decodeTbcWebViewPageMessage(
    '{"channel":"tws-webview/1","messageId":"page-1","navigationId":"navigation-1","sessionId":"session-1","type":"ready","type":"request"}',
  ));
  assert.throws(() => decodeTbcWebViewPageMessage(
    JSON.stringify(pageMessages[0], null, 2),
  ));
  assert.throws(() => decodeTbcWebViewNativeMessage(
    '{"chainId":"tbc:00000000000000000000000000000001","channel":"tws-webview/1","messageId":"native-1","navigationId":"navigation-1","origin":"https://dapp.example/\\ud800","sessionId":"session-1","type":"initialize"}',
  ));
  assert.throws(() => decodeTbcWebViewPageMessage(
    '{"channel":"tws-webview/1","messageId":"page-2","navigationId":"navigation-1","request":{"id":1e400,"jsonrpc":"2.0","method":"unknown"},"sessionId":"session-1","type":"request"}',
  ));
  assert.throws(() => encodeTbcWebViewPageMessage({
    ...pageMessages[1],
    request: { jsonrpc: "2.0", id: Number.POSITIVE_INFINITY, method: "unknown" },
  }));
});

test("WebView codec accepts exactly 4 MiB and rejects the next UTF-8 byte", () => {
  const make = (padding) => ({
    ...base,
    type: "request",
    messageId: "page-sized",
    request: {
      jsonrpc: "2.0",
      id: "rpc-sized",
      method: "vendor_echo",
      params: { padding },
    },
  });
  const empty = encodeTbcWebViewPageMessage(make(""));
  const exact = encodeTbcWebViewPageMessage(
    make("x".repeat(TBC_WEBVIEW_MAX_MESSAGE_BYTES - Buffer.byteLength(empty))),
  );
  assert.equal(Buffer.byteLength(exact), TBC_WEBVIEW_MAX_MESSAGE_BYTES);
  assert.deepEqual(decodeTbcWebViewPageMessage(exact).request.params.padding.length,
    TBC_WEBVIEW_MAX_MESSAGE_BYTES - Buffer.byteLength(empty));
  assert.throws(() => encodeTbcWebViewPageMessage(
    make("x".repeat(TBC_WEBVIEW_MAX_MESSAGE_BYTES - Buffer.byteLength(empty) + 1)),
  ));
});

