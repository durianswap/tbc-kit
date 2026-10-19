import assert from "node:assert/strict";
import test from "node:test";

import { createTbcProvider } from "../dist/esm/index.js";
import {
  createTbcWebViewPageTransport,
  decodeTbcWebViewPageMessage,
  encodeTbcWebViewNativeMessage,
} from "../dist/esm/webview.js";

const chainA = "tbc:00000000000000000000000000000001";
const chainB = "tbc:other";

function channelHarness() {
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

function initialize(messageId = "native-init") {
  return {
    channel: "tws-webview/1",
    type: "initialize",
    sessionId: "session-1",
    navigationId: "navigation-1",
    messageId,
    origin: "https://dapp.example",
    chainId: chainA,
  };
}

function native(type, fields, ordinal) {
  return {
    channel: "tws-webview/1",
    type,
    sessionId: "session-1",
    navigationId: "navigation-1",
    messageId: `native-${ordinal}`,
    ...fields,
  };
}

test("settled and late-cancelled page requests do not exhaust a 128-call lifetime", async () => {
  const harness=channelHarness();
  const controller=createTbcWebViewPageTransport({channel:harness.channel,isTopFrame:()=>true});
  harness.receive(initialize());
  for(let i=0;i<200;i++){
    const pending=controller.transport.send({jsonrpc:'2.0',id:i,method:'tbc_chainId'});
    const rejected=assert.rejects(pending,/aborted/);
    controller.transport.cancel(i,'REQUEST_ABORTED');await rejected;
    harness.receive(native('delivery',{deliveryId:(i+1).toString(16).padStart(64,'0'),response:{jsonrpc:'2.0',id:i,result:chainA},events:[]},i));
  }
  const result=controller.transport.send({jsonrpc:'2.0',id:200,method:'tbc_chainId'});
  harness.receive(native('delivery',{deliveryId:'f'.repeat(64),response:{jsonrpc:'2.0',id:200,result:chainA},events:[]},200));
  assert.equal((await result).response.result,chainA);
  assert.equal(harness.posted.map(decodeTbcWebViewPageMessage).filter(x=>x.type==='ack').length,201);
  await controller.destroy();
});

test("page transport initializes once and rejects non-top-frame use", async () => {
  const harness = channelHarness();
  const controller = createTbcWebViewPageTransport({
    channel: harness.channel,
    isTopFrame: () => true,
  });
  controller.acceptInitialize(encodeTbcWebViewNativeMessage(initialize()));
  assert.equal(decodeTbcWebViewPageMessage(harness.posted[0]).type, "ready");
  assert.equal(decodeTbcWebViewPageMessage(harness.posted[0]).sessionId, "session-1");

  const iframe = channelHarness();
  const denied = createTbcWebViewPageTransport({
    channel: iframe.channel,
    isTopFrame: () => false,
  });
  denied.acceptInitialize(encodeTbcWebViewNativeMessage(initialize("iframe-init")));
  await assert.rejects(denied.transport.send({
    jsonrpc: "2.0",
    id: "iframe-request",
    method: "tbc_chainId",
  }));
});

test("page transport correlates 100 same-method requests out of order", async () => {
  const harness = channelHarness();
  const controller = createTbcWebViewPageTransport({
    channel: harness.channel,
    isTopFrame: () => true,
  });
  harness.receive(initialize());
  const pending = Array.from({ length: 100 }, (_, index) =>
    controller.transport.send({
      jsonrpc: "2.0",
      id: `rpc-${index}`,
      method: "tbc_chainId",
    }),
  );
  const requests = harness.posted
    .map(decodeTbcWebViewPageMessage)
    .filter((message) => message.type === "request");
  assert.equal(requests.length, 100);
  for (const [ordinal, message] of [...requests].reverse().entries()) {
    harness.receive(native("delivery", {
      deliveryId: ordinal.toString(16).padStart(64, "0"),
      response: { jsonrpc: "2.0", id: message.request.id, result: chainA },
      events: [],
    }, `delivery-${ordinal}`));
  }
  const deliveries = await Promise.all(pending);
  assert.deepEqual(deliveries.map(({ response }) => response.result),
    Array.from({ length: 100 }, () => chainA));
});

test("page transport deduplicates delivery replay and closes on byte collision", async () => {
  const harness = channelHarness();
  const controller = createTbcWebViewPageTransport({
    channel: harness.channel,
    isTopFrame: () => true,
  });
  const signals = [];
  controller.transport.subscribe((signal) => signals.push(signal));
  harness.receive(initialize());
  const request = controller.transport.send({
    jsonrpc: "2.0",
    id: "rpc-replay",
    method: "tbc_chainId",
  });
  const delivery = native("delivery", {
    deliveryId: "a".repeat(64),
    response: { jsonrpc: "2.0", id: "rpc-replay", result: chainA },
    events: [],
  }, "delivery-replay");
  harness.receive(delivery);
  assert.equal((await request).response.result, chainA);
  harness.receive(delivery);
  const acknowledgments = harness.posted
    .map(decodeTbcWebViewPageMessage)
    .filter((message) => message.type === "ack");
  assert.equal(acknowledgments.length, 2);
  assert.deepEqual(signals, []);

  harness.receive(native("delivery", {
    ...delivery,
    deliveryId: delivery.deliveryId,
    response: { jsonrpc: "2.0", id: "rpc-replay", result: chainB },
    events: [],
  }, "delivery-collision"));
  assert.deepEqual(signals, [{ type: "close", reason: "TRANSPORT_CLOSED" }]);
});

test("page abort posts only REQUEST_ABORTED and suppresses a late delivery", async () => {
  const harness = channelHarness();
  const controller = createTbcWebViewPageTransport({
    channel: harness.channel,
    isTopFrame: () => true,
  });
  harness.receive(initialize());
  const request = controller.transport.send({
    jsonrpc: "2.0",
    id: "rpc-abort",
    method: "tbc_chainId",
  });
  await controller.transport.cancel("rpc-abort", "REQUEST_ABORTED");
  await assert.rejects(request);
  const cancel = harness.posted
    .map(decodeTbcWebViewPageMessage)
    .find((message) => message.type === "cancel");
  assert.equal(cancel.reason, "REQUEST_ABORTED");
  harness.receive(native("delivery", {
    deliveryId: "b".repeat(64),
    response: { jsonrpc: "2.0", id: "rpc-abort", result: chainA },
    events: [{ name: "chainChanged", payload: chainA }],
  }, "late-abort"));
  assert.equal(
    harness.posted.map(decodeTbcWebViewPageMessage)
      .filter((message) => message.type === "ack").length,
    1,
  );
});

test("page Provider settles the Promise before committed events", async () => {
  const harness = channelHarness();
  const controller = createTbcWebViewPageTransport({
    channel: harness.channel,
    isTopFrame: () => true,
  });
  harness.receive(initialize());
  const provider = createTbcProvider({
    transport: controller.transport,
    requestIdFactory: () => "rpc-order",
  });
  const order = [];
  provider.on("chainChanged", () => order.push("event"));
  const request = provider.request({ method: "tbc_chainId" }).then((value) => {
    order.push("promise");
    return value;
  });
  harness.receive(native("delivery", {
    deliveryId: "c".repeat(64),
    response: { jsonrpc: "2.0", id: "rpc-order", result: chainA },
    events: [{ name: "chainChanged", payload: chainA }],
  }, "ordered"));
  assert.equal(await request, chainA);
  await Promise.resolve();
  assert.deepEqual(order, ["promise", "event"]);
});

test("page close is terminal and suppresses late messages", async () => {
  const harness = channelHarness();
  const controller = createTbcWebViewPageTransport({
    channel: harness.channel,
    isTopFrame: () => true,
  });
  const signals = [];
  controller.transport.subscribe((signal) => signals.push(signal));
  harness.receive(initialize());
  const request = controller.transport.send({
    jsonrpc: "2.0",
    id: "rpc-close",
    method: "tbc_chainId",
  });
  harness.receive(native("close", { reason: "SESSION_REVOKED" }, "close"));
  await assert.rejects(request);
  assert.deepEqual(signals, [{ type: "close", reason: "SESSION_REVOKED" }]);
  const postedBefore = harness.posted.length;
  harness.receive(native("event", {
    event: { name: "chainChanged", payload: chainB },
  }, "late-event"));
  assert.equal(harness.posted.length, postedBefore);
  await controller.destroy();
});

