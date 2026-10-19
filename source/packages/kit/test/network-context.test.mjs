import assert from "node:assert/strict";
import test from "node:test";
import { hashCanonical } from "@tbc-wallet/core";

import {
  OFFICIAL_TBC_MAINNET_API_ORIGIN,
  OFFICIAL_TBC_TESTNET_API_ORIGIN,
  createDefaultTbcNetwork,
  createDefaultTbcTestnetNetwork,
  createTbcWallet,
  createTbcNetworkContext,
  normalizePoolMaterialConfirmationPolicy,
} from "../dist/esm/wallet.js";
import {
  TBC_MAINNET_PROFILE,
  TBC_TESTNET_PROFILE,
} from "../dist/esm/engine.js";

const ADDRESS = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa";

function response(data) {
  return new Response(JSON.stringify({ code: "200", data }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function controlledFetch(hosts) {
  return async (input, init) => {
    assert.notEqual(init?.method, "POST", "dual-network configuration proof is read-only");
    const url = new URL(input instanceof Request ? input.url : String(input));
    hosts.push(url.origin);
    if (url.pathname === "/api/tbc/nodeinfo") {
      return response({ blocks: 1000, bestblockhash: "aa".repeat(32) });
    }
    if (url.pathname === `/api/tbc/utxo/address/${ADDRESS}`) {
      return response({ utxos: [] });
    }
    throw new Error(`unexpected controlled request ${url.pathname}`);
  };
}

test("official and trusted-custom TBC network contexts are immutable and reject official cross-network origins", () => {
  const mainnet = createTbcNetworkContext({ network: "mainnet" });
  const testnet = createTbcNetworkContext({ network: "testnet" });
  assert.equal(mainnet.chainId, TBC_MAINNET_PROFILE.chainId);
  assert.equal(testnet.chainId, TBC_TESTNET_PROFILE.chainId);
  assert.equal(mainnet.endpoint.apiOrigin, OFFICIAL_TBC_MAINNET_API_ORIGIN);
  assert.equal(testnet.endpoint.apiOrigin, OFFICIAL_TBC_TESTNET_API_ORIGIN);
  assert.notEqual(mainnet.sourceIdentity, testnet.sourceIdentity);
  assert.equal(Object.isFrozen(mainnet), true);
  assert.equal(Object.isFrozen(mainnet.endpoint), true);

  assert.throws(
    () => createTbcNetworkContext({
      network: "mainnet",
      endpoint: {
        kind: "trusted-custom",
        apiOrigin: OFFICIAL_TBC_TESTNET_API_ORIGIN,
        trustId: "audited-wrong-network",
      },
    }),
    /does not match the selected network/,
  );
  assert.throws(
    () => createDefaultTbcTestnetNetwork({
      accounts: { current: async () => [] },
      baseUrl: OFFICIAL_TBC_MAINNET_API_ORIGIN,
      allowedOrigins: [OFFICIAL_TBC_MAINNET_API_ORIGIN],
      fetch: async () => { throw new Error("must reject before IO"); },
    }),
    /does not match the selected network/,
  );

  const customA = createTbcNetworkContext({
    network: "testnet",
    endpoint: {
      kind: "trusted-custom",
      apiOrigin: "https://audited-a.example",
      rpcOrigin: "https://audited-rpc.example",
      trustId: "wallet-audit-17",
    },
  });
  const customB = createTbcNetworkContext({
    network: "testnet",
    endpoint: {
      kind: "trusted-custom",
      apiOrigin: "https://audited-b.example",
      rpcOrigin: "https://audited-rpc.example",
      trustId: "wallet-audit-17",
    },
  });
  assert.notEqual(customA.sourceIdentity, customB.sourceIdentity);
});

test("same-process Mainnet and Testnet defaults route only to their immutable source", async () => {
  const mainnetHosts = [];
  const testnetHosts = [];
  const common = {
    accounts: { current: async () => [] },
    broadcast: {
      async submit() { throw new Error("no controlled broadcast"); },
      async reconcile() { return { transactions: [] }; },
    },
  };
  const mainnet = createDefaultTbcNetwork({
    ...common,
    network: createTbcNetworkContext({ network: "mainnet" }),
    fetch: controlledFetch(mainnetHosts),
  });
  const testnet = createDefaultTbcNetwork({
    ...common,
    network: createTbcNetworkContext({ network: "testnet" }),
    fetch: controlledFetch(testnetHosts),
  });
  await Promise.all([
    mainnet.client.getUtxos(ADDRESS),
    testnet.client.getUtxos(ADDRESS),
  ]);
  assert.deepEqual(new Set(mainnetHosts), new Set([OFFICIAL_TBC_MAINNET_API_ORIGIN]));
  assert.deepEqual(new Set(testnetHosts), new Set([OFFICIAL_TBC_TESTNET_API_ORIGIN]));
  assert.notEqual(mainnet.network.sourceIdentity, testnet.network.sourceIdentity);
  assert.equal(mainnet.chainData.network.sourceIdentity, mainnet.network.sourceIdentity);
  assert.equal(testnet.chainData.network.sourceIdentity, testnet.network.sourceIdentity);
});

test("wallet confirmation policy cannot compose a lower-floor Pool source", () => {
  const poolMaterial = Object.freeze({
    confirmationPolicy: Object.freeze({ minConfirmations: "0" }),
    async resolveLiquidityAdd() {
      throw new Error("must reject before Pool material IO");
    },
  });
  assert.throws(
    () => createDefaultTbcNetwork({
      network: createTbcNetworkContext({ network: "testnet" }),
      accounts: { current: async () => [] },
      fetch: async () => { throw new Error("must reject before network IO"); },
      poolMaterial,
      confirmationPolicy: { minConfirmations: "1" },
    }),
    /confirmation floor is below the wallet policy/,
  );
});

test("wallet confirmation configuration is canonical, immutable and bound into resolved policy", async () => {
  for (const minConfirmations of [undefined, null, 0, "", "00", "-1", "1.5", "4294967296"]) {
    assert.throws(() => normalizePoolMaterialConfirmationPolicy({ minConfirmations }));
  }
  const configuration = { minConfirmations: "2" };
  const network = createDefaultTbcTestnetNetwork({
    accounts: { current: async () => [] },
    fetch: async () => { throw new Error("policy resolution is read-free"); },
    confirmationPolicy: configuration,
  });
  configuration.minConfirmations = "0";
  const request = {
    version: "1.0", chainId: TBC_TESTNET_PROFILE.chainId, from: ADDRESS,
    intent: { type: "tbc.transfer", version: "1.0", to: ADDRESS, amount: "1000" },
  };
  const result = await network.resolvePolicy({
    version: "1.0", request, requestHash: hashCanonical(request), snapshotHash: "aa".repeat(32),
  });
  assert.equal(result.portError, undefined);
  assert.equal(result.payload.minConfirmations, "2");
  assert.equal(result.policyHash, hashCanonical(result.payload));
});

test("wallet default transaction stack pins the active account to the selected network before IO", async () => {
  const mainnet = createTbcNetworkContext({ network: "mainnet" });
  const calls = [];
  const wallet = createTbcWallet({
    accounts: {
      current: async () => [Object.freeze({
        accountId: `${TBC_TESTNET_PROFILE.chainId}:${ADDRESS}`,
        address: ADDRESS,
        chainId: TBC_TESTNET_PROFILE.chainId,
        publicKey: `02${"11".repeat(32)}`,
      })],
    },
    approval: { async request() { throw new Error("no approval"); } },
    signer: { async sign() { throw new Error("no signing"); } },
    storage: {
      async loadPermissions() { return []; },
      async commitPermissions() { return {}; },
    },
    network: {
      defaultNetwork: {
        network: mainnet,
        fetch: async (...args) => {
          calls.push(args);
          throw new Error("network must remain inert");
        },
        broadcast: {
          async submit() { throw new Error("no broadcast"); },
          async reconcile() { return { transactions: [] }; },
        },
      },
    },
    legacy: false,
  });
  await assert.rejects(
    wallet.openSession(),
    /active account does not match the configured TBC network/,
  );
  assert.equal(calls.length, 0);
});
