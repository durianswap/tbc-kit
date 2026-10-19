import assert from "node:assert/strict";
import test from "node:test";

const amounts = await import("../src/amounts.mjs").catch((error) => {
  if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;
  return {};
});

test("TBC display values become exact atomic strings without floating point rounding", () => {
  assert.equal(typeof amounts.parseTbcAmount, "function");
  for (const [input, atomic] of [
    ["0.000001", "1"], ["1", "1000000"], ["1000", "1000000000"],
    ["0.29", "290000"], ["9007199254.740993", "9007199254740993"],
  ]) assert.equal(amounts.parseTbcAmount(input), atomic);
});

test("invalid or over-precision amounts cannot be silently sent", () => {
  assert.equal(typeof amounts.parseTbcAmount, "function");
  for (const input of ["0", "0.000000", "0.0000001", "1.0000000", "-1", "1e3", "NaN", "", "1,000", 1]) {
    assert.throws(() => amounts.parseTbcAmount(input), { name: "TypeError" });
  }
});

test("balances format exactly including zero and values beyond Number precision", () => {
  assert.equal(typeof amounts.formatTbcAmount, "function");
  for (const [atomic, display] of [["0", "0"], ["1", "0.000001"], ["290000", "0.29"], ["1000000000", "1000"], ["9007199254740993", "9007199254.740993"]]) {
    assert.equal(amounts.formatTbcAmount(atomic), display);
  }
  assert.throws(() => amounts.formatTbcAmount("1e6"), { name: "TypeError" });
});
