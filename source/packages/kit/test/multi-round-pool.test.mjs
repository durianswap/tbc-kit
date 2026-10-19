import assert from "node:assert/strict";
import test from "node:test";

import {
  createPoolMaterialSource,
  createTbcWallet,
} from "../dist/esm/wallet.js";
import { createTbcKitMemoryHostStore } from "../dist/esm/sqlite.js";

const CHAIN_ID = "tbc:testnet";
const ADDRESS = "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH";
const ORIGIN = "https://pool-maintenance.test";
const POOL = "21".repeat(32);
const FT = "22".repeat(32);
const CURRENT = "23".repeat(32);
const ACCOUNT = Object.freeze({
  accountId: `${CHAIN_ID}:${ADDRESS}`,
  address: ADDRESS,
  chainId: CHAIN_ID,
  publicKey: `02${"11".repeat(32)}`,
});

function permission(capability) {
  return {
    id: `pool-${capability}`,
    parentCapability: capability,
    invoker: ORIGIN,
    date: Date.parse("2026-09-23T00:00:00Z"),
    caveats: [
      { type: "restrictChains", value: [CHAIN_ID] },
      { type: "restrictAccounts", value: [ACCOUNT.accountId] },
      { type: "restrictMethods", value: [capability] },
    ],
  };
}

test("canonical Pool merge index exposes all rows and preserves Pool identity", async () => {
  const requests = [];
  const source = createPoolMaterialSource({
    client: {},
    async load(request) {
      requests.push(request);
      return {
        version: 1,
        kind: request.operation === "indexPoolFt" ? "pool-ft" : "ftlp",
        poolContractId: POOL,
        ftContractId: FT,
        currentPoolTxid: CURRENT,
        utxos: [
          { txid: "31".repeat(32), outputIndex: 2, satoshis: 100, balance: "7" },
          { txid: "32".repeat(32), outputIndex: 3, satoshis: 200, balance: "11", lockTime: 9 },
        ],
      };
    },
  });
  const index = await source.readMergeIndex({
    address: ADDRESS,
    poolContractId: POOL,
    kind: "pool-ft",
  });
  assert.deepEqual(requests, [{
    operation: "indexPoolFt",
    addressFrom: ADDRESS,
    contractId: POOL,
  }]);
  assert.equal(index.poolContractId, POOL);
  assert.equal(index.ftContractId, FT);
  assert.equal(index.currentPoolTxid, CURRENT);
  assert.deepEqual(index.utxos.map(({ satoshis, assetAmount }) => [satoshis, assetAmount]), [
    ["100", "7"], ["200", "11"],
  ]);
});

for (const scenario of [
  { kind: "pool-ft", custody: "pool-contract", maximum: 4 },
  { kind: "ftlp", custody: "active-account", maximum: 5 },
]) {
  test(`${scenario.kind} approval scope carries Pool identity and accurate custody`, async () => {
    let observedScope;
    const runtime = createTbcWallet({
      accounts: { current: async () => [ACCOUNT] },
      approval: { async request() { throw new Error("ordinary approval must not open"); } },
      multiRoundMerge: {
        async approve({ scope, scopeHash }) {
          observedScope = scope;
          return { status: "rejected", scopeHash };
        },
        async authorizeStep() { throw new Error("rejected scope reached formal approval"); },
      },
      signer: { async sign() { throw new Error("rejected scope reached Signer"); } },
      storage: {
        hostStore: createTbcKitMemoryHostStore(),
        async loadPermissions() {
          return {
            revision: "0",
            permissions: [permission("tbc_accounts"), permission("tbc_sendTransaction")],
          };
        },
        async commitPermissions(params) {
          return { revisions: params.changes.map(({ scope }) => ({ scope, revision: "1" })) };
        },
      },
      network: {
        client: {},
        async readPoolMergeIndex({ kind, poolContractId }) {
          assert.equal(kind, scenario.kind);
          assert.equal(poolContractId, POOL);
          return {
            version: "1.0", kind, poolContractId, ftContractId: FT,
            currentPoolTxid: CURRENT,
            utxos: [
              { txid: "31".repeat(32), vout: 0, satoshis: "100", assetAmount: "7" },
              { txid: "32".repeat(32), vout: 0, satoshis: "100", assetAmount: "9" },
            ],
          };
        },
        async resolveChainData() { throw new Error("rejected scope reached Chain Data"); },
        async resolvePolicy() { throw new Error("rejected scope reached policy"); },
        async broadcastSubmit() { throw new Error("rejected scope reached POST"); },
        async broadcastReconcile() { throw new Error("rejected scope reached reconciliation"); },
      },
      clock: () => "2026-09-23T00:00:00Z",
    });
    const session = await runtime.openSession({
      origin: ORIGIN,
      sessionId: `${scenario.kind}-approval`,
      execution: { hostStore: createTbcKitMemoryHostStore() },
    });
    const result = await session.runMultiRoundMerge({
      asset: { kind: scenario.kind, poolContractId: POOL },
      limits: {
        targetUtxoCount: 1,
        maxTransactions: 2,
        maxTotalFee: "1000",
        expiresAt: "2027-09-23T00:05:00Z",
      },
    });
    assert.equal(result.reason, "approval-rejected");
    assert.equal(observedScope.impact.custody, scenario.custody);
    assert.equal(observedScope.impact.resultOwner, scenario.custody);
    assert.equal(observedScope.impact.maxAssetInputsPerTransaction, scenario.maximum);
    assert.deepEqual(observedScope.impact.poolIdentity, {
      poolContractId: POOL,
      ftContractId: FT,
      currentPoolTxid: CURRENT,
    });
    session.close();
  });
}
