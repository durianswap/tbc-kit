import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const sourceRoot = resolve(new URL("../src/", import.meta.url).pathname);

async function source(name) {
  return readFile(resolve(sourceRoot, name), "utf8");
}

test("the Standard-only Legacy route removes migrated FT and secure fallbacks", async () => {
  const [legacy, poolMaterial, loader, runtime] = await Promise.all([
    source("legacy-webview-native.ts"),
    source("pool-material.ts"),
    source("pool-signing-loader.ts"),
    source("wallet-runtime.ts"),
  ]);

  assert.doesNotMatch(legacy, /async function sendFtTransfer\(/u);
  assert.doesNotMatch(legacy, /preferStandardApprovalPreparation/u);
  assert.doesNotMatch(legacy, /readonly (?:rawTransactions|associatedTransactions|crypto|ftTransfers)\?:/u);
  assert.match(legacy, /canonical = withStandardApprovalFeeCap\(canonical, "10000"\)/u);
  assert.match(legacy, /readonly genericBatch\?: LegacyStandardWorkflowBatchAdapter/u);

  // The canonical Pool path is active, while the old native operation and
  // The canonical Pool path remains; the zero-consumer loader alias is gone.
  assert.match(poolMaterial, /createPoolMaterialLoader/u);
  assert.doesNotMatch(loader, /createLegacyPoolSigningLoader/u);
  assert.doesNotMatch(runtime, /workflowPreparation\?:/u);
  assert.match(runtime, /approvalPreparation/u);
});
