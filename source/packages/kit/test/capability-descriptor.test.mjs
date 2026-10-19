import assert from "node:assert/strict";
import test from "node:test";

import {
  TBC_KIT_WALLET_INTENTS,
  TBC_KIT_UNIFIED_TEMPLATE_SUPPORT,
  createTbcWallet,
} from "../dist/esm/wallet.js";

const CHAIN_ID = "tbc:testnet";
const ADDRESS = "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH";
const ACCOUNT_ID = `${CHAIN_ID}:${ADDRESS}`;
const ACCOUNT = Object.freeze({
  chainId: CHAIN_ID,
  address: ADDRESS,
  accountId: ACCOUNT_ID,
  publicKey: "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
});

function permission() {
  return Object.freeze({
    id: "capability-account-permission",
    parentCapability: "tbc_accounts",
    invoker: "https://capability.test",
    date: Date.parse("2026-09-25T00:00:00Z"),
    caveats: Object.freeze([
      { type: "restrictChains", value: Object.freeze([CHAIN_ID]) },
      { type: "restrictAccounts", value: Object.freeze([ACCOUNT_ID]) },
      { type: "restrictMethods", value: Object.freeze(["tbc_accounts"]) },
    ]),
  });
}

function wallet(capabilities) {
  return createTbcWallet({
    capabilities,
    accounts: { current: async () => [ACCOUNT] },
    approval: { request: async () => { throw new Error("approval forbidden"); } },
    signer: { sign: async () => { throw new Error("Signer forbidden"); } },
    storage: {
      loadPermissions: async () => ({ revision: "0", permissions: [permission()] }),
      commitPermissions: async () => { throw new Error("commit forbidden"); },
    },
    network: {
      resolveChainData: async () => { throw new Error("chain read forbidden"); },
      resolvePolicy: async () => { throw new Error("policy forbidden"); },
      broadcastSubmit: async () => { throw new Error("broadcast forbidden"); },
      broadcastSubmitBatch: async () => { throw new Error("broadcast forbidden"); },
      broadcastReconcile: async () => { throw new Error("reconcile forbidden"); },
    },
    clock: () => "2026-09-25T00:00:01Z",
    randomBytes: (length) => new Uint8Array(length),
  });
}

test("Kit advertises unified operations and current issuance, with explicit template limits", () => {
  assert.equal(new Set(TBC_KIT_WALLET_INTENTS).size, TBC_KIT_WALLET_INTENTS.length);
  assert.equal(TBC_KIT_WALLET_INTENTS.includes("tbc.pool.liquidity.close"), false);
  for(const name of ['tbc.ft.create','tbc.nft.mint','tbc.pool.create'])assert.equal(TBC_KIT_WALLET_INTENTS.includes(name),false);
  assert.equal(TBC_KIT_WALLET_INTENTS.includes('tbc.collection.create'),true);
  for(const name of ['tbc20.transfer','tbc721.transfer','tbc20Stablecoin.merge','tbc20Lp.merge','amm.swap','tbc-lop-match','tbc-htlc-claim','tbc-timelock-unlock'])assert.ok(TBC_KIT_WALLET_INTENTS.includes(name));
  assert.equal(TBC_KIT_UNIFIED_TEMPLATE_SUPPORT['tbc-amm'].includes('tbc20Lp.burn'),false);
  assert.equal(TBC_KIT_UNIFIED_TEMPLATE_SUPPORT['historical-pool2'].includes('tbc20Lp.transfer'),false);
  for(const supported of Object.values(TBC_KIT_UNIFIED_TEMPLATE_SUPPORT))assert.ok(supported.every(name=>TBC_KIT_WALLET_INTENTS.includes(name)));
});

test("wallet composition supplies trusted chain and account capability scopes without new Ports", async () => {
  const runtime = wallet({
    version: "1.0",
    scopes: [
      {
        chainId: CHAIN_ID,
        intents: TBC_KIT_WALLET_INTENTS,
        profiles: ["core", "assets"],
      },
      {
        chainId: CHAIN_ID,
        accountId: ACCOUNT_ID,
        intents: ["tbc.transfer"],
        profiles: ["core"],
      },
    ],
  });
  const session = await runtime.openSession({
    origin: "https://capability.test",
    sessionId: "capability-session",
  });
  const chain = await session.provider.request({
    method: "tbc_getCapabilities",
    params: {},
  });
  assert.deepEqual(
    Object.keys(chain.intents).toSorted(),
    [...TBC_KIT_WALLET_INTENTS].toSorted(),
  );
  assert.deepEqual(chain.profiles, ["core", "assets", "transport:remote"]);

  const account = await session.provider.request({
    method: "tbc_getCapabilities",
    params: { chainId: CHAIN_ID, address: ADDRESS },
  });
  assert.deepEqual(account.intents, { "tbc.transfer": ["1.0"] });
  assert.deepEqual(account.profiles, ["core", "transport:remote"]);
});

test("wallets without a descriptor retain the conservative transfer-only default", async () => {
  const runtime = wallet(undefined);
  const session = await runtime.openSession({
    origin: "https://capability.test",
    sessionId: "default-capability-session",
  });
  const capabilities = await session.provider.request({
    method: "tbc_getCapabilities",
    params: {},
  });
  assert.deepEqual(capabilities.intents, { "tbc.transfer": ["1.0"] });
  assert.deepEqual(capabilities.profiles, ["core", "transport:remote"]);
});

test("partner usage scope does not inherit Kit issuance or administrator capabilities", async () => {
  const installed = ["tbc.transfer", "tbc20Stablecoin.transfer", "tbc20Lp.transfer", "amm.swap"];
  const runtime = wallet({version: "1.0", scopes: [{chainId: CHAIN_ID, intents: installed, profiles: ["core"]}]});
  const session = await runtime.openSession({origin: "https://capability.test", sessionId: "partner-usage-capability"});
  const capabilities = await session.provider.request({method: "tbc_getCapabilities", params: {}});
  assert.deepEqual(Object.keys(capabilities.intents).toSorted(), installed.toSorted());
  for (const excluded of ["tbc.collection.create", "tbc20-stablecoin-create", "tbc20-stablecoin-mint",
    "tbc20-stablecoin-freeze", "tbc20-stablecoin-unfreeze"]) {
    assert.equal(Object.hasOwn(capabilities.intents, excluded), false);
  }
  assert.deepEqual(capabilities.profiles, ["core", "transport:remote"]);
});
