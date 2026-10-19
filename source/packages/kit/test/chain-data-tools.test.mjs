import assert from "node:assert/strict";
import test from "node:test";

import {
  assertRequestBudget,
  createImmutableTransactionCache,
  createRequestLedger,
  loadIndependentGroups,
  selectThenLoadAncestry,
} from "../dist/esm/testing.js";

test("selection happens before ancestry and only selected parents are loaded", async () => {
  const loaded = [];
  const ledger = createRequestLedger({ enabled: true });
  const result = await selectThenLoadAncestry({
    candidates: [
      { txid: "a", amount: 1 },
      { txid: "b", amount: 10 },
      { txid: "c", amount: 20 },
    ],
    select: (candidates) => [candidates[1]],
    parentTxid: (candidate) => candidate.txid,
    async loadParent(txid) { loaded.push(txid); return { txid }; },
    ledger,
  });
  assert.deepEqual(loaded, ["b"]);
  assert.deepEqual(result.parents, [{ txid: "b" }]);
  assertRequestBudget(ledger.snapshot(), { maximumByCategory: { txraw: 1 } });
});

test("independent groups start together and immutable bytes remain bounded", async () => {
  const order = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const pending = loadIndependentGroups({
    funding: async () => { order.push("funding:start"); await gate; return "funding"; },
    asset: async () => { order.push("asset:start"); await gate; return "asset"; },
  });
  await Promise.resolve();
  assert.deepEqual(order, ["funding:start", "asset:start"]);
  release();
  assert.deepEqual(await pending, { funding: "funding", asset: "asset" });

  const cache = createImmutableTransactionCache({ maxEntries: 2, maxHexCharacters: 1024 });
  cache.remember({ txid: "11".repeat(32), rawTransaction: "00" });
  cache.remember({ txid: "22".repeat(32), rawTransaction: "01" });
  cache.remember({ txid: "33".repeat(32), rawTransaction: "02" });
  assert.equal(cache.get("11".repeat(32)), undefined);
  assert.equal(cache.size().entries, 2);
  assert.throws(() => cache.remember({ txid: "22".repeat(32), rawTransaction: "03" }), /conflict/u);
});
