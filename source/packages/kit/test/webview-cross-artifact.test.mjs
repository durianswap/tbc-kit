import assert from "node:assert/strict";
import test from "node:test";

import { createTbcKitWebViewPageProvider } from "../dist/esm/index.js";
import { decodeTbcWebViewPageMessage } from "../../provider/dist/esm/webview.js";

const chainId = "tbc:mainnet";

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonical(value[key])}`
  ).join(",")}}`;
}

test("Kit page typed-data bytes decode through the standalone Provider native codec", async () => {
  const posted = [];
  const page = createTbcKitWebViewPageProvider({
    channel: {
      post(serialized) { posted.push(serialized); },
      subscribe() { return () => undefined; },
    },
    isTopFrame: () => true,
    requestIdFactory: () => "typed-rpc-1",
  });
  page.acceptInitialize(canonical({
    channel: "tws-webview/1",
    type: "initialize",
    sessionId: "session-1",
    navigationId: "navigation-1",
    messageId: "native-initialize",
    origin: "https://dapp.example",
    chainId,
  }));

  const abort = new AbortController();
  const pending = page.provider.request({
    method: "tbc_signTypedData",
    params: {
      version: "1.0",
      chainId,
      from: "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH",
      clientRequestId: "mobile-typed-1",
      data: {
        domain: {
          name: "DurianSwap Order",
          version: "1",
          chainId,
          origin: "https://dapp.example",
        },
        types: {
          Order: [
            { name: "amount", type: "uint256" },
            { name: "side", type: "string" },
          ],
        },
        primaryType: "Order",
        message: { amount: "1000000", side: "buy" },
      },
    },
  }, { signal: abort.signal });
  const serialized = posted.find((entry) => JSON.parse(entry).type === "request");
  assert.ok(serialized);

  const decoded = decodeTbcWebViewPageMessage(serialized);
  assert.equal(decoded.type, "request");
  assert.equal(decoded.request.method, "tbc_signTypedData");
  assert.deepEqual(Object.keys(decoded.request.params), [
    "chainId",
    "clientRequestId",
    "data",
    "from",
    "version",
  ]);
  assert.deepEqual(Object.keys(decoded.request.params.data), [
    "domain",
    "message",
    "primaryType",
    "types",
  ]);
  assert.deepEqual(Object.keys(decoded.request.params.data.domain), [
    "chainId",
    "name",
    "origin",
    "version",
  ]);

  abort.abort();
  await assert.rejects(pending);
  await page.destroy();
});
