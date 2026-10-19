import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = () => readFile(new URL("../src/legacy-webview-native.ts", import.meta.url), "utf8");

test("FT transfer has one shared Standard route with mandatory preparation metadata", async () => {
  const text = await source();
  assert.match(text, /readonly ftTransferIntents\?: LegacyFtTransferIntentResolver/);
  assert.match(text, /const ftTransfer = isLegacyFtTransferParams\(params\)/);
  assert.match(text, /ftTransfer && transactionOptions\.ftTransferIntents === undefined/);
  assert.match(text, /ftTransferIntents !== undefined && isLegacyFtTransferParams\(params\)/);
  assert.match(text, /canonical = withStandardApprovalFeeCap\(canonical, "10000"\)/);
  assert.doesNotMatch(text, /async function sendFtTransfer\(/);
  assert.doesNotMatch(text, /readonly ftTransfers\?:|preferStandardApprovalPreparation/);
});
