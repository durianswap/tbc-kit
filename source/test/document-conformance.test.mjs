import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { repositoryRoot } from "../scripts/lib/repository.mjs";
import { runDocumentConformance } from "../scripts/lib/document-conformance.mjs";

const root = repositoryRoot(import.meta.url);

test("resolves every local Markdown link and parses every JSON fence", () => {
  const metrics = runDocumentConformance(root);
  assert.ok(metrics.markdown >= 16);
  assert.ok(metrics.localLinks >= 29);
  assert.ok(metrics.jsonBlocks >= 35);
  assert.ok(metrics.jsonFiles >= 33);
  assert.equal(metrics.normativeHashBindings, 18);
  assert.equal(metrics.normativeStates, 15);
  assert.equal(metrics.normativeCancellationReasons, 11);
  assert.equal(metrics.hostPorts, 11);
  assert.equal(metrics.hostOperations, 15);
  assert.equal(metrics.coreMethods, 4);
  assert.equal(metrics.coreTransitions, 4);
  assert.equal(metrics.methodCategories, 12);
  assert.equal(metrics.authorityInputs, 4);
  assert.equal(metrics.committingKinds, 2);
  assert.equal(metrics.transactionEngineFacades, 4);
  assert.equal(metrics.approvalMappings, 16);
  assert.equal(metrics.approvalPreviews, 7);
  assert.equal(metrics.compatibilityClaims, 7);
});

test("conformance CLI returns one machine-readable passing summary", () => {
  const result = spawnSync(process.execPath, ["scripts/conformance.mjs"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.status, "pass");
  assert.deepEqual(summary.profiles, [
    "schema",
    "semantic",
    "crypto",
    "lifecycle",
    "replay",
    "closure",
    "documents",
    "sdk",
  ]);
});
