import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (name) => readFile(new URL(`../src/${name}`, import.meta.url), "utf8");

test("deletion gate removes migrated Legacy fallbacks and keeps canonical replacements", async () => {
  const [legacy, runtime, workflow, poolMaterial, poolNative, keyless, loader, parity] =
    await Promise.all([
      source("legacy-webview-native.ts"),
      source("wallet-runtime.ts"),
      source("legacy-standard-workflow.ts"),
      source("pool-material.ts"),
      source("pool-material-native.ts"),
      source("keyless.ts"),
      source("pool-signing-loader.ts"),
      readFile(new URL("./pool-material-parity.test.ts", import.meta.url), "utf8"),
    ]);

  for (const marker of [
    "readonly prefetchRequest?:",
    "readonly batchConsent?:",
    "readonly rawTransactions?:",
    "readonly associatedTransactions?:",
    "readonly crypto?:",
  ]) assert.doesNotMatch(legacy, new RegExp(marker.replace(/[?]/g, "\\?")));
  assert.doesNotMatch(legacy, /preferStandardApprovalPreparation|onLegacyPreparationFallback|onLegacySecureFallback/);
  assert.doesNotMatch(runtime, /readonly workflowPreparation\?:/);

  // Canonical replacements and explicit adapters remain reachable.
  assert.match(runtime, /readonly approvalPreparation/);
  assert.match(runtime, /readonly prefetchRequest:/);
  assert.match(runtime, /readonly beginApprovalPreparation:/);
  assert.doesNotMatch(runtime, /readonly beginWorkflowPreparation:/);
  assert.doesNotMatch(runtime, /adaptWorkflowPreparationPresentation/);
  assert.match(runtime, /const genericPresentation = approvalPreparation/);
  assert.doesNotMatch(runtime, /entry\.presentation === "workflow"/);
  assert.doesNotMatch(workflow, /beginWorkflowPreparation/);
  assert.match(poolMaterial, /createPoolMaterialLoader/);
  assert.doesNotMatch(poolMaterial, /createLegacyPoolSigningLoader|legacyPoolPreview/);
  for (const resolver of [
    "resolveCreateInitialize",
    "resolveLiquidityAdd",
    "resolveLiquidityRemove",
    "resolveSwapTbcForToken",
    "resolveSwapTokenForTbc",
    "resolvePoolFtMerge",
  ]) {
    assert.match(poolMaterial, new RegExp(resolver));
  }
  assert.match(poolNative, /previewLiquidityAdd/);
  assert.match(poolNative, /legacyPoolPreview/);
  assert.match(keyless, /legacyPoolPreview/);
  assert.match(loader, /options\.native\.execute\("previewLiquidityAdd"/);
  assert.doesNotMatch(loader, /createLegacyPoolSigningLoader/);
  assert.equal((parity.match(/legacyPoolPreview/g) ?? []).length, 0);
  assert.equal((keyless.match(/legacyPoolPreview/g) ?? []).length, 1);
  assert.match(poolNative, /reason|compatibility/);
});
