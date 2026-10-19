import assert from "node:assert/strict";
import test from "node:test";

import {
  createCanonicalPoolPolicy,
  freezeCanonicalPoolParents,
  selectCanonicalPoolInput,
} from "../src/pool-material-helpers.ts";
import {
  createPoolMaterialNativeProvider,
  POOL_MATERIAL_NATIVE_OPERATIONS,
} from "../src/pool-material-native.ts";

test("canonical Pool policy is validated, bound and immutable", () => {
  const policy = createCanonicalPoolPolicy(
    {
      lpPlan: 2,
      serviceProviderTag: "controlled-pool",
      serviceFeeRate: 35,
    },
    "Pool initialize",
    35,
  );
  assert.deepEqual(policy, {
    lpPlan: 2,
    serviceProviderTag: "controlled-pool",
    serviceFeeRate: 35,
  });
  assert.equal(Object.isFrozen(policy), true);
  assert.throws(
    () =>
      createCanonicalPoolPolicy(
        { lpPlan: 2, serviceProviderTag: "controlled-pool", serviceFeeRate: 35 },
        "Pool initialize",
        130,
      ),
    /Invalid canonical Pool initialize policy/u,
  );
});

test("canonical Pool parents deduplicate by txid and retain immutable order", () => {
  const parents = freezeCanonicalPoolParents([
    { txid: "aa".repeat(32), rawTransaction: "aa" },
    { txid: "aa".repeat(32), rawTransaction: "different" },
    { txid: "bb".repeat(32), rawTransaction: "bb" },
  ]);
  assert.deepEqual(parents, [
    { txid: "aa".repeat(32), rawTransaction: "aa" },
    { txid: "bb".repeat(32), rawTransaction: "bb" },
  ]);
  assert.equal(Object.isFrozen(parents), true);
  assert.equal(Object.isFrozen(parents[0]), true);
});

test("canonical Pool input selection chooses the smallest sufficient balance", () => {
  const selected = selectCanonicalPoolInput(
    [
      { txid: "cc".repeat(32), outputIndex: 0, balance: "100" },
      { txid: "aa".repeat(32), outputIndex: 1, balance: "80" },
      { txid: "bb".repeat(32), outputIndex: 0, balance: "80" },
    ],
    "75",
  );
  assert.deepEqual(selected, {
    txid: "aa".repeat(32),
    outputIndex: 1,
    balance: "80",
  });
  assert.equal(
    selectCanonicalPoolInput(
      [{ txid: "aa".repeat(32), outputIndex: 0, balance: "10" }],
      "11",
    ),
    undefined,
  );
});

test("Pool native compatibility adapter exposes only neutral canonical operations", async () => {
  const calls: string[] = [];
  const provider = createPoolMaterialNativeProvider({
    protocolInfo: async () =>
      JSON.stringify({
        version: 1,
        operations: ["preparePoolNft", "legacyPoolPreview", "legacyPoolPreview"],
      }),
    execute: async (operation, requestJson) => {
      calls.push(`${operation}:${requestJson}`);
      return "{}";
    },
  });

  assert.deepEqual(POOL_MATERIAL_NATIVE_OPERATIONS, [
    "preparePoolNft",
    "prepareAssetAncestry",
    "previewLiquidityAdd",
  ]);
  const info = JSON.parse(await provider.protocolInfo());
  assert.deepEqual(info.operations, ["preparePoolNft", "previewLiquidityAdd"]);
  await provider.execute("previewLiquidityAdd", '{"amount":"1"}');
  assert.deepEqual(calls, ['legacyPoolPreview:{"amount":"1"}']);
});
