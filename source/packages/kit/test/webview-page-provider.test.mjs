import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  TBC_KIT_WEBVIEW_CHANNEL,
  createTbcKitWebViewPageProvider,
} from "../dist/esm/index.js";
import {
  decodeTbcWebViewPageMessage,
  encodeTbcWebViewNativeMessage,
} from "../../provider/dist/esm/webview.js";

const signing = JSON.parse(await readFile(
  new URL("../../../test-vectors/signing.json", import.meta.url),
  "utf8",
));
const chainId = "tbc:mainnet";
const address = "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH";
const accountId = `${chainId}:${address}`;

function harness() {
  const listeners = new Set();
  const posted = [];
  return {
    posted,
    channel: {
      post(serialized) {
        posted.push(serialized);
      },
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    receive(message) {
      const serialized = typeof message === "string"
        ? message
        : encodeTbcWebViewNativeMessage(message);
      for (const listener of [...listeners]) listener(serialized);
    },
  };
}

function native(type, fields, ordinal) {
  return {
    channel: TBC_KIT_WEBVIEW_CHANNEL,
    type,
    sessionId: "session-1",
    navigationId: "navigation-1",
    messageId: `native-${ordinal}`,
    ...fields,
  };
}

function initialize() {
  return native("initialize", {
    origin: "https://dapp.example",
    chainId,
  }, "initialize");
}

function requestFor(posted, method) {
  return posted
    .map(decodeTbcWebViewPageMessage)
    .findLast((message) =>
      message.type === "request" && message.request.method === method
    )?.request;
}

function permission(parentCapability, suffix) {
  return {
    id: `permission-${suffix}`,
    parentCapability,
    invoker: "https://dapp.example",
    date: 1788177600000,
    caveats: [
      { type: "restrictChains", value: [chainId] },
      { type: "restrictAccounts", value: [accountId] },
      { type: "restrictMethods", value: [parentCapability] },
    ],
  };
}

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonical(value[key])}`
  ).join(",")}}`;
}

test("Kit root page Provider accepts current no-suffix permissions, events, and signing results", async () => {
  const bridge = harness();
  const page = createTbcKitWebViewPageProvider({
    channel: bridge.channel,
    isTopFrame: () => true,
    requestIdFactory: (() => {
      let next = 0;
      return () => `kit-rpc-${++next}`;
    })(),
  });
  page.acceptInitialize(encodeTbcWebViewNativeMessage(initialize()));

  const changed = [];
  page.provider.on("permissionsChanged", (payload) => changed.push(payload));
  const permissions = [
    permission("tbc_accounts", "accounts"),
    permission("tbc_signMessage", "message"),
    permission("tbc_signTypedData", "typed-data"),
  ];
  const permissionPromise = page.provider.request({
    method: "wallet_requestPermissions",
    params: [{
      tbc_accounts: { chains: [chainId], maxAccounts: 1 },
      tbc_signMessage: { chains: [chainId] },
      tbc_signTypedData: { chains: [chainId] },
    }],
  });
  const permissionRequest = requestFor(bridge.posted, "wallet_requestPermissions");
  assert.ok(permissionRequest);
  bridge.receive(native("delivery", {
    deliveryId: "1".repeat(64),
    response: { jsonrpc: "2.0", id: permissionRequest.id, result: permissions },
    events: [{ name: "permissionsChanged", payload: permissions }],
  }, "permissions"));
  assert.deepEqual(await permissionPromise, permissions);
  await Promise.resolve();
  assert.deepEqual(changed, [permissions]);

  const messageResult = signing.vectors[0].result;
  const messagePromise = page.provider.request({
    method: "tbc_signMessage",
    params: {
      version: "1.0",
      chainId,
      from: address,
      message: messageResult.envelope.message,
    },
  });
  const messageRequest = requestFor(bridge.posted, "tbc_signMessage");
  assert.ok(messageRequest);
  bridge.receive(native("delivery", {
    deliveryId: "2".repeat(64),
    response: { jsonrpc: "2.0", id: messageRequest.id, result: messageResult },
    events: [],
  }, "message"));
  assert.deepEqual(await messagePromise, messageResult);

  const typedResult = signing.vectors[1].result;
  const { domain, types, primaryType, message } = typedResult.envelope;
  const typedPromise = page.provider.request({
    method: "tbc_signTypedData",
    params: {
      version: "1.0",
      chainId,
      from: address,
      data: { domain, types, primaryType, message },
    },
  });
  const typedRequest = requestFor(bridge.posted, "tbc_signTypedData");
  assert.ok(typedRequest);
  bridge.receive(native("delivery", {
    deliveryId: "3".repeat(64),
    response: { jsonrpc: "2.0", id: typedRequest.id, result: typedResult },
    events: [],
  }, "typed-data"));
  assert.deepEqual(await typedPromise, typedResult);

  assert.deepEqual(
    bridge.posted.map(decodeTbcWebViewPageMessage)
      .filter((message) => message.type === "request")
      .map((message) => message.request.method),
    ["wallet_requestPermissions", "tbc_signMessage", "tbc_signTypedData"],
  );
  await page.destroy();
});

test("Kit root page Provider remains fail-closed for a stale message result schema", async () => {
  const bridge = harness();
  const page = createTbcKitWebViewPageProvider({
    channel: bridge.channel,
    isTopFrame: () => true,
    requestIdFactory: () => "stale-result",
  });
  page.acceptInitialize(encodeTbcWebViewNativeMessage(initialize()));
  const result = signing.vectors[0].result;
  const pending = page.provider.request({
    method: "tbc_signMessage",
    params: {
      version: "1.0",
      chainId,
      from: address,
      message: result.envelope.message,
    },
  });
  const request = requestFor(bridge.posted, "tbc_signMessage");
  assert.ok(request);
  const { scheme: _removed, ...staleResult } = result;
  bridge.receive(canonical(native("delivery", {
    deliveryId: "4".repeat(64),
    response: { jsonrpc: "2.0", id: request.id, result: staleResult },
    events: [],
  }, "stale-result")));

  await assert.rejects(pending);
  await assert.rejects(page.provider.request({ method: "tbc_chainId" }));
  await page.destroy();
});
