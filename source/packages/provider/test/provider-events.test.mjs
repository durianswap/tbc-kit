import assert from "node:assert/strict";
import test from "node:test";

import {
  ProviderRpcError,
  createTbcProvider,
} from "../dist/esm/index.js";

const chainA = "tbc:00000000000000000000000000000001";
const chainB = "tbc:other";

function eventTransport() {
  let listener = () => {};
  let chainId = chainA;
  let accounts = ["1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH"];
  let permissions = [{
    id: "permission-1",
    parentCapability: "tbc_accounts",
    invoker: "https://example.test",
    date: 0,
    caveats: [],
  }];
  let delivery = 0;
  return {
    transport: {
      async send(request) {
        const events = [];
        let result;
        if (request.method === "tbc_switchChain") {
          chainId = request.params.chainId;
          result = null;
          events.push(
            { name: "chainChanged", payload: chainId },
            { name: "accountsChanged", payload: [] },
          );
        } else if (request.method === "tbc_disconnect") {
          permissions = [];
          accounts = [];
          result = null;
          events.push(
            { name: "permissionsChanged", payload: [] },
            { name: "accountsChanged", payload: [] },
          );
        } else if (request.method === "wallet_getPermissions") {
          result = permissions;
        } else if (request.method === "tbc_accounts") {
          result = accounts;
        } else if (request.method === "tbc_chainId") {
          result = chainId;
        } else {
          throw new Error("unexpected method");
        }
        delivery += 1;
        return {
          deliveryId: delivery.toString(16).padStart(64, "0"),
          response: { jsonrpc: "2.0", id: request.id, result },
          events,
        };
      },
      subscribe(next) {
        listener = next;
        return () => {
          listener = () => {};
        };
      },
    },
    emit(signal) {
      listener(signal);
    },
  };
}

test("settles the request before emitting committed events in Core array order", async () => {
  const state = eventTransport();
  const provider = createTbcProvider({ transport: state.transport });
  const order = [];
  let queryFromListener;
  provider.on("chainChanged", (chainId) => {
    order.push(`chain:${chainId}`);
    queryFromListener = provider.request({ method: "tbc_chainId" });
  });
  provider.on("accountsChanged", () => order.push("accounts"));

  const switched = provider
    .request({ method: "tbc_switchChain", params: { chainId: chainB } })
    .then((result) => {
      order.push("settled");
      return result;
    });
  assert.equal(await switched, null);
  await Promise.resolve();
  assert.deepEqual(order, ["settled", `chain:${chainB}`, "accounts"]);
  assert.equal(await queryFromListener, chainB);
});

test("disconnect permission revocation settles before ordered events and listener re-queries", async () => {
  const state = eventTransport();
  const provider = createTbcProvider({ transport: state.transport });
  const order = [];
  const rechecks = [];
  let providerDisconnect = 0;
  provider.on("permissionsChanged", () => {
    order.push("permissions");
    rechecks.push(provider.request({ method: "wallet_getPermissions" }));
  });
  provider.on("accountsChanged", () => {
    order.push("accounts");
    rechecks.push(provider.request({ method: "tbc_accounts" }));
  });
  provider.on("disconnect", () => {
    providerDisconnect += 1;
  });

  const disconnected = provider.request({ method: "tbc_disconnect" }).then((result) => {
    order.push("settled");
    return result;
  });
  assert.equal(await disconnected, null);
  await Promise.resolve();
  assert.deepEqual(order, ["settled", "permissions", "accounts"]);
  assert.deepEqual(await Promise.all(rechecks), [[], []]);
  assert.equal(providerDisconnect, 0);
});

test("uses snapshot listener iteration and EventEmitter-compatible duplicates", () => {
  const state = eventTransport();
  const provider = createTbcProvider({ transport: state.transport });
  const calls = [];
  const duplicate = () => calls.push("duplicate");
  const later = () => calls.push("later");
  const mutate = () => {
    calls.push("mutate");
    provider.removeListener("chainChanged", duplicate);
    provider.on("chainChanged", later);
  };
  provider.on("chainChanged", mutate);
  provider.on("chainChanged", duplicate);
  provider.on("chainChanged", duplicate);

  state.emit({ type: "event", event: { name: "chainChanged", payload: chainA } });
  assert.deepEqual(calls, ["mutate", "duplicate", "duplicate"]);
  calls.length = 0;
  state.emit({ type: "event", event: { name: "chainChanged", payload: chainB } });
  assert.deepEqual(calls, ["mutate", "duplicate", "later"]);
});

test("validates out-of-band events and exposes disconnect as ProviderRpcError", async () => {
  const state = eventTransport();
  const provider = createTbcProvider({ transport: state.transport });
  let disconnect;
  provider.on("disconnect", (error) => {
    disconnect = error;
  });
  state.emit({
    type: "event",
    event: {
      name: "disconnect",
      payload: { code: 4900, message: "Disconnected" },
    },
  });
  assert.equal(disconnect instanceof ProviderRpcError, true);
  assert.equal(disconnect.code, 4900);

  state.emit({
    type: "event",
    event: { name: "chainChanged", payload: { secret: chainA } },
  });
  await assert.rejects(
    provider.request({ method: "tbc_chainId" }),
    (error) => error instanceof ProviderRpcError && error.code === 4900,
  );
});
