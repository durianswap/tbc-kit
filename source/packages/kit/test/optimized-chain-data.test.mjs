import assert from "node:assert/strict";
import test from "node:test";

import { createOptimizedChainDataResolver, createRequestLedger } from "../dist/esm/testing.js";

const A = "aa".repeat(32);
const B = "bb".repeat(32);
const C = "cc".repeat(32);
const POOL = "dd".repeat(32);

test("optimized resolver overlaps independent indexes, selects first, and reuses only immutable bytes", async () => {
  const ledger = createRequestLedger({ enabled: true });
  const starts = [];
  let rawReads = 0;
  const resolver = createOptimizedChainDataResolver({
    ledger,
    source: {
      networkKey: "testnet",
      needsTip: () => true,
      needsNative: () => true,
      async loadTip() { starts.push("tip"); return { height: 100 }; },
      async loadNativeCandidates() { starts.push("native"); return [{ txid: A, amount: 1000 }]; },
      async loadAssetCandidates() { starts.push("asset"); return [{ txid: B, amount: 1 }, { txid: C, amount: 10 }]; },
      async loadContract({ contractId }) { starts.push("contract"); return { contractId }; },
      selectNative: ({ candidates }) => candidates,
      selectAsset: ({ candidates }) => [candidates[1]],
      requiredAncestry: ({ selectedAssets, contracts }) => [selectedAssets[0].candidates[0].txid, contracts[0].contractId],
      async loadRawTransaction(txid) { rawReads += 1; return txid === C ? "00" : "01"; },
      buildSnapshot: (input) => input,
    },
  });
  const params = {
    accountId: "account-1",
    chainId: "tbc:testnet",
    requirement: {
      assets: [{ kind: "ft", contractId: "11".repeat(32), minimumAmount: "5" }],
      contractIds: [POOL], nativeAmount: "1",
    },
  };
  const first = await resolver.resolve(params);
  assert.deepEqual(starts, ["tip", "native", "asset", "contract"]);
  assert.deepEqual(first.selectedAssets[0].candidates.map((candidate) => candidate.txid), [C]);
  assert.deepEqual(first.parents.map((parent) => parent.txid), [C, POOL]);
  assert.equal(first.parents.some((parent) => parent.txid === A || parent.txid === B), false);
  assert.equal(rawReads, 2);

  await resolver.resolve(params);
  assert.equal(rawReads, 2, "fresh indexes must not force immutable txraw re-downloads");
  assert.equal(ledger.snapshot().counts["native-index"], 2);
  assert.equal(ledger.snapshot().counts["asset-index"], 2);
  assert.equal(ledger.snapshot().counts.txraw, 2);
  assert.deepEqual(resolver.cacheSize(), { entries: 2, hexCharacters: 4 });
});

test("optimized resolver starts every independent read without an artificial concurrency cap", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let started = 0;
  const begin = async (value) => {
    started += 1;
    await gate;
    return value;
  };
  const assetCount = 12;
  const contractCount = 12;
  const resolver = createOptimizedChainDataResolver({
    source: {
      networkKey: "uncapped-testnet",
      needsTip: () => true,
      needsNative: () => true,
      loadTip: () => begin({ height: 100 }),
      loadNativeCandidates: () => begin([]),
      loadAssetCandidates: () => begin([]),
      loadContract: ({ contractId }) => begin({ contractId }),
      selectNative: () => [],
      selectAsset: () => [],
      requiredAncestry: () => [],
      loadRawTransaction: async () => { throw new Error("unexpected ancestry"); },
      buildSnapshot: (input) => input,
    },
  });
  const resolving = resolver.resolve({
    accountId: "uncapped-account",
    chainId: "tbc:testnet",
    requirement: {
      assets: Array.from({ length: assetCount }, (_, index) => ({
        kind: "ft",
        contractId: index.toString(16).padStart(64, "0"),
      })),
      contractIds: Array.from({ length: contractCount }, (_, index) =>
        (index + 100).toString(16).padStart(64, "0")),
    },
  });
  await Promise.resolve();
  assert.equal(started, 2 + assetCount + contractCount);
  release();
  await resolving;
});
