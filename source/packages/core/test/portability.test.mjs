import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  PORTABILITY_LIMITS,
  checkCorePortability,
  scanForbiddenRuntimeCapabilities,
} from "../../../scripts/check-core-portability.mjs";

const rootPackage = JSON.parse(
  await readFile(new URL("../../../package.json", import.meta.url), "utf8"),
);
const workflow = await readFile(
  new URL("../../../../.github/workflows/conformance.yml", import.meta.url),
  "utf8",
);

test("portable Core bundles for MV3, neutral ESM, and React Native/Hermes", async () => {
  const report = await checkCorePortability();
  assert.equal(report.status, "pass");
  assert.equal(report.nodeMajor >= 20, true);
  assert.deepEqual(Object.keys(report.bundles), ["mv3", "neutral", "hermes"]);
  for (const bundle of Object.values(report.bundles)) {
    assert.equal(bundle.bytes <= PORTABILITY_LIMITS.maxBundleBytes, true);
    assert.equal(bundle.gzipBytes <= PORTABILITY_LIMITS.maxGzipBytes, true);
    assert.deepEqual(bundle.forbiddenCapabilities, []);
  }
  assert.deepEqual(report.runtimeDependencies, {
    "@noble/curves": "1.9.7",
    "@noble/hashes": "1.8.0",
  });
  assert.deepEqual(report.publicCoreMethods, [
    "acknowledgeCommit",
    "cancel",
    "resume",
    "start",
  ]);
  assert.equal(report.mv3CspSmoke, "pass");
  assert.equal(report.hermesSmoke, "pass");
  assert.equal(report.nodeEsmSmoke, "pass");
});

test("portability scanner rejects ambient platform, UI, timer, private, and dynamic-code capabilities", () => {
  const mutations = {
    node: 'import fs from "node:fs";',
    browser: "globalThis.chrome.runtime.sendMessage({});",
    ui: 'import React from "react";',
    timer: "setTimeout(() => undefined, 1);",
    private: 'const vaultHandle = "wallet-vault/1";',
    rpc: 'const rpcUrl = "https://node.invalid";',
    dynamic: 'eval("1 + 1"); new Function("return 1");',
  };
  for (const [name, source] of Object.entries(mutations)) {
    assert.notDeepEqual(
      scanForbiddenRuntimeCapabilities(source, `${name}.ts`),
      [],
      name,
    );
  }
});

test("package and CI keep portability as a first-class required gate", () => {
  assert.equal(
    rootPackage.scripts["check:core-portability"],
    "node scripts/check-core-portability.mjs",
  );
  assert.match(rootPackage.scripts.check, /npm run check:core-portability/);
  assert.match(workflow, /run: npm run check:core-portability/);
});
