import assert from "node:assert/strict";
import test from "node:test";

import {
  ProviderRpcError,
  createTbcProvider,
} from "../dist/esm/index.js";

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function harness() {
  const calls = [];
  const cancellations = [];
  let listener = () => {};
  let closeCalls = 0;
  let unsubscribeCalls = 0;
  return {
    calls,
    cancellations,
    get closeCalls() {
      return closeCalls;
    },
    get unsubscribeCalls() {
      return unsubscribeCalls;
    },
    transport: {
      send(request) {
        const completion = deferred();
        calls.push({ request, ...completion });
        return completion.promise;
      },
      subscribe(next) {
        listener = next;
        return () => {
          unsubscribeCalls += 1;
          listener = () => {};
        };
      },
      cancel(id, reason) {
        cancellations.push({ id, reason });
      },
      close() {
        closeCalls += 1;
      },
    },
    signal(signal) {
      listener(signal);
    },
  };
}

function success(call, deliveryId, events = []) {
  return {
    deliveryId,
    response: {
      jsonrpc: "2.0",
      id: call.request.id,
      result: "tbc:00000000000000000000000000000001",
    },
    events,
  };
}

async function rejectsWithCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error instanceof ProviderRpcError, true);
    assert.equal(error.code, code);
    return true;
  });
}

test("aborts locally, forwards only REQUEST_ABORTED, and suppresses late delivery", async () => {
  const state = harness();
  const provider = createTbcProvider({ transport: state.transport });
  const controller = new AbortController();
  const events = [];
  provider.on("chainChanged", (chainId) => events.push(chainId));
  const request = provider.request(
    { method: "tbc_chainId" },
    { signal: controller.signal },
  );
  controller.abort("DApp supplied untrusted close reason");
  await rejectsWithCode(request, -32603);
  assert.deepEqual(state.cancellations, [
    { id: state.calls[0].request.id, reason: "REQUEST_ABORTED" },
  ]);

  state.calls[0].resolve(
    success(state.calls[0], "1".repeat(64), [
      {
        name: "chainChanged",
        payload: "tbc:00000000000000000000000000000001",
      },
    ]),
  );
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(events, []);
  assert.equal(state.closeCalls, 0);
});

test("does not send a request whose signal is already aborted", async () => {
  const state = harness();
  const provider = createTbcProvider({ transport: state.transport });
  const controller = new AbortController();
  controller.abort();
  await rejectsWithCode(
    provider.request(
      { method: "tbc_chainId" },
      { signal: controller.signal },
    ),
    -32603,
  );
  assert.equal(state.calls.length, 0);
  assert.deepEqual(state.cancellations, []);
});

test("close signals and destroy reject pending work and permanently stop delivery", async () => {
  for (const action of ["signal", "destroy"]) {
    const state = harness();
    const provider = createTbcProvider({ transport: state.transport });
    const observed = [];
    provider.on("chainChanged", (value) => observed.push(value));
    const pending = provider.request({ method: "tbc_chainId" });
    if (action === "signal") {
      state.signal({ type: "close", reason: "SESSION_REVOKED" });
    } else {
      await provider.destroy();
      await provider.destroy();
    }
    await rejectsWithCode(pending, 4900);
    await rejectsWithCode(provider.request({ method: "tbc_chainId" }), 4900);
    state.signal({
      type: "event",
      event: {
        name: "chainChanged",
        payload: "tbc:other",
      },
    });
    state.calls[0].resolve(success(state.calls[0], "2".repeat(64), []));
    await Promise.resolve();
    assert.deepEqual(observed, []);
    assert.equal(state.unsubscribeCalls, 1);
    assert.equal(state.closeCalls, 1);
  }
});

test("a replayed delivery identity closes fail-closed", async () => {
  const state = harness();
  const provider = createTbcProvider({ transport: state.transport });
  const first = provider.request({ method: "tbc_chainId" });
  state.calls[0].resolve(success(state.calls[0], "3".repeat(64)));
  await first;

  const second = provider.request({ method: "tbc_chainId" });
  const third = provider.request({ method: "tbc_chainId" });
  state.calls[1].resolve(success(state.calls[1], "3".repeat(64)));
  await Promise.all([
    rejectsWithCode(second, 4900),
    rejectsWithCode(third, 4900),
  ]);
  assert.equal(state.closeCalls, 1);
});
