import assert from "node:assert/strict";
import test from "node:test";
import {
  checkHostPortability,
  scanForbiddenHostCapabilities,
} from "../../../scripts/check-host-portability.mjs";

test("Host root bundles for browser, worker, React Native, and Node", async () => {
  const report = await checkHostPortability();

  assert.equal(report.status, "pass");
  assert.equal(report.browserSmoke, "pass");
  assert.equal(report.workerSmoke, "pass");
  assert.equal(report.reactNativeSmoke, "pass");
  assert.equal(report.nodeEsmSmoke, "pass");
  assert.equal(report.nodeCjsSmoke, "pass");
  assert.equal(report.sqliteBrowserSmoke, "pass");
  assert.equal(report.sqliteWorkerSmoke, "pass");
  assert.equal(report.sqliteReactNativeSmoke, "pass");
  assert.equal(report.sqliteNodeEsmSmoke, "pass");
  assert.equal(report.sqliteNodeCjsSmoke, "pass");
  assert.deepEqual(Object.keys(report.sqliteBundles).sort(), [
    "browser",
    "nodeEsm",
    "reactNative",
    "worker",
  ]);
  assert.deepEqual(report.runtimeDependencies, {
    "@tbc-wallet/core": "1.0.0-draft.6.10",
  });
  assert.deepEqual(report.publicDriverMethods, [
    "cancelOperation",
    "inspectOperation",
    "recoverPendingOperations",
    "resumeOperation",
    "startOperation",
  ]);
  assert.deepEqual(report.forbiddenRootCapabilities, []);
});

test("Host portability scanner rejects private, ambient, network, and Node powers", () => {
  const findings = scanForbiddenHostCapabilities(`
    import fs from "node:fs";
    import { openDatabaseSync } from "expo-sqlite";
    const store = indexedDB.open("hidden");
    fetch("https://wallet.invalid");
    const privateName = "wallet-vault/1";
    const secret = vaultHandle;
  `);

  assert.deepEqual(
    [...new Set(findings.map(({ kind }) => kind))].sort(),
    [
      "network-runtime",
      "node-builtin",
      "platform-adapter",
      "private-boundary",
      "root-platform-global",
    ],
  );
});
