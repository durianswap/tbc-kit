import assert from "node:assert/strict";
import test from "node:test";

// Isolated immutable candidates can be checked without overwriting local dist.
const { poolServiceFeeRate } = await import(
  process.env.TBC_KIT_WALLET_MODULE ?? "../dist/esm/wallet.js"
);

test("wallet exports the single canonical Pool service fee policy", () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6].map(poolServiceFeeRate),
    [35, 35, 135, 335, 535, 330],
  );
  for (const unsupported of [0, 7, -1, 1.5, Number.NaN]) {
    assert.equal(poolServiceFeeRate(unsupported), undefined);
  }
});
