import assert from "node:assert/strict";
import test from "node:test";

import {
  assertTbcProviderRequest as assertRootProviderRequest,
  createTbcProvider,
} from "../dist/esm/index.js";
import {
  TBC_WEBVIEW_CHANNEL,
  assertTbcProviderEvent,
  assertTbcProviderRequest,
  assertTbcTransportDelivery,
  decodeTbcWebViewNativeMessage,
  decodeTbcWebViewPageMessage,
  digestTbcWebViewEnvelope,
  encodeTbcWebViewNativeMessage,
  encodeTbcWebViewPageMessage,
} from "../dist/esm/wallet.js";

const request = Object.freeze({
  jsonrpc: "2.0",
  id: "request-1",
  method: "tbc_chainId",
  params: Object.freeze([]),
});

test("wallet entry exposes the bundled strict Provider validators", () => {
  assert.equal(assertRootProviderRequest, assertTbcProviderRequest);
  const checkedRequest = assertTbcProviderRequest(request);
  assert.deepEqual(checkedRequest, request);
  assert.equal(Object.isFrozen(checkedRequest), true);

  const event = assertTbcProviderEvent({
    name: "accountsChanged",
    payload: ["1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH"],
  });
  assert.equal(event.name, "accountsChanged");
  assert.equal(Object.isFrozen(event), true);

  const delivery = assertTbcTransportDelivery(
    {
      deliveryId: "a".repeat(64),
      response: {
        jsonrpc: "2.0",
        id: request.id,
        result: "tbc:00000000000000000000000000000001",
      },
      events: [event],
    },
    request.method,
  );
  assert.equal(delivery.response.result, "tbc:00000000000000000000000000000001");
  assert.equal(Object.isFrozen(delivery), true);

  assert.throws(() =>
    assertTbcProviderRequest({ ...request, walletPrivateRoute: true }),
  );
  assert.throws(() =>
    assertTbcTransportDelivery({ ...delivery, walletPrivateRoute: true }),
  );
});

test("wallet entry exposes the bundled strict WebView decoders and digest", () => {
  const page =
    '{"channel":"tws-webview/1","messageId":"message-1","navigationId":"navigation-1","request":{"id":"request-1","jsonrpc":"2.0","method":"tbc_chainId","params":[]},"sessionId":"session-1","type":"request"}';
  const decodedPage = decodeTbcWebViewPageMessage(page);
  assert.equal(decodedPage.type, "request");
  assert.equal(Object.isFrozen(decodedPage), true);
  assert.equal(encodeTbcWebViewPageMessage(decodedPage), page);

  const native =
    '{"channel":"tws-webview/1","messageId":"message-2","navigationId":"navigation-1","reason":"NAVIGATION_CHANGED","sessionId":"session-1","type":"close"}';
  const decodedNative = decodeTbcWebViewNativeMessage(native);
  assert.equal(decodedNative.type, "close");
  assert.equal(encodeTbcWebViewNativeMessage(decodedNative), native);
  assert.equal(TBC_WEBVIEW_CHANNEL, "tws-webview/1");
  assert.equal(digestTbcWebViewEnvelope(native), digestTbcWebViewEnvelope(native));

  assert.throws(() =>
    decodeTbcWebViewPageMessage(
      '{"channel":"tws-webview/1","channel":"tws-webview/1"}',
    ),
  );
});

test("root exposes the bundled strict Provider factory and transport contract", async () => {
  const provider = createTbcProvider({
    requestIdFactory: () => "root-provider-factory",
    transport: {
      async send(providerRequest) {
        return {
          deliveryId: "b".repeat(64),
          response: {
            jsonrpc: "2.0",
            id: providerRequest.id,
            result: "tbc:00000000000000000000000000000001",
          },
          events: [],
        };
      },
      subscribe() {
        return () => undefined;
      },
    },
  });
  assert.equal(
    await provider.request({ method: "tbc_chainId", params: [] }),
    "tbc:00000000000000000000000000000001",
  );
  await provider.destroy();
});
