import assert from "node:assert/strict";
import test from "node:test";

import { createOptimizedChainDataResolver, createRequestLedger } from "../dist/esm/testing.js";

const ids = Array.from({ length: 8 }, (_, index) => (index + 1).toString(16).padStart(2, "0").repeat(32));

const cases = [
  { name: "TBC transfer", assets: [], contracts: [], ancestry: [], expected: { tip: 1, "native-index": 1, "asset-index": 0, pool: 0, txraw: 0 } },
  { name: "FT create", assets: [], contracts: [], ancestry: [ids[0]], expected: { tip: 1, "native-index": 1, "asset-index": 0, pool: 0, txraw: 1 } },
  { name: "FT transfer", assets: [{ kind: "ft" }], contracts: [ids[1]], ancestry: [ids[2]], expected: { tip: 1, "native-index": 1, "asset-index": 1, pool: 1, txraw: 1 } },
  { name: "Pool create", assets: [{ kind: "ft" }], contracts: [ids[1]], ancestry: [ids[2], ids[3]], expected: { tip: 1, "native-index": 1, "asset-index": 1, pool: 1, txraw: 2 } },
  { name: "TBC to FT buy", assets: [], contracts: [ids[4]], ancestry: [ids[4], ids[5]], expected: { tip: 1, "native-index": 1, "asset-index": 0, pool: 1, txraw: 2 } },
  { name: "FT to TBC sell", assets: [{ kind: "ft" }], contracts: [ids[4]], ancestry: [ids[2], ids[5]], expected: { tip: 1, "native-index": 1, "asset-index": 1, pool: 1, txraw: 2 } },
  { name: "LP add", assets: [{ kind: "ft" }], contracts: [ids[4]], ancestry: [ids[2], ids[6]], expected: { tip: 1, "native-index": 1, "asset-index": 1, pool: 1, txraw: 2 } },
  { name: "LP remove", assets: [{ kind: "lp" }], contracts: [ids[4]], ancestry: [ids[7], ids[6]], expected: { tip: 1, "native-index": 1, "asset-index": 1, pool: 1, txraw: 2 } },
];

for (const item of cases) {
  test(`${item.name} controlled request budget`, async () => {
    const ledger = createRequestLedger({ enabled: true });
    const resolver = createOptimizedChainDataResolver({
      ledger,
      source: {
        networkKey: `testnet-${item.name}`,
        needsTip: () => true,
        needsNative: () => true,
        loadTip: async () => ({ height: 1 }),
        loadNativeCandidates: async () => [{ txid: ids[0], amount: 100 }],
        loadAssetCandidates: async ({ asset }) => [{ txid: asset.kind === "lp" ? ids[7] : ids[2], amount: 100 }],
        loadContract: async ({ contractId }) => ({ contractId }),
        selectNative: ({ candidates }) => candidates.slice(0, 1),
        selectAsset: ({ candidates }) => candidates.slice(0, 1),
        requiredAncestry: () => item.ancestry,
        loadRawTransaction: async () => "00",
        buildSnapshot: (input) => input,
      },
    });
    await resolver.resolve({
      accountId: "account",
      chainId: "tbc:testnet",
      requirement: { assets: item.assets, contractIds: item.contracts, nativeAmount: "1" },
    });
    const counts = ledger.snapshot().counts;
    for (const [category, expected] of Object.entries(item.expected)) {
      assert.equal(counts[category], expected, category);
    }
  });
}
