import assert from "node:assert/strict";
import test from "node:test";

import {
  checkWalletStandardPortability,
  scanForbiddenWalletStandardCapabilities,
} from "../../../scripts/check-wallet-standard-portability.mjs";

test("Wallet Standard adapter loads in browser, SSR ESM, and SSR CJS", async () => {
  const report = await checkWalletStandardPortability();
  assert.equal(report.status, "pass");
  assert.equal(report.browserSmoke, "pass");
  assert.equal(report.ssrEsmSmoke, "pass");
  assert.equal(report.ssrCjsSmoke, "pass");
  assert.equal(report.usesOfficialRegistry, true);
  assert.deepEqual(report.runtimeDependencies, {
    "@tbc-wallet/provider": "1.0.0-draft.6.15",
    "@wallet-standard/core": "1.1.2",
  });
  assert.deepEqual(report.forbiddenSourceCapabilities, []);
});

test("Wallet Standard scanner rejects private registries and competing discovery", () => {
  const findings = scanForbiddenWalletStandardCapabilities(`
    import { createTwsHost } from "@tbc-wallet/host";
    const registry = new Map();
    window.Turing = registry;
    localStorage.setItem("wallet", "first");
    const priority = 1;
    window.dispatchEvent(new Event("eip6963:announceProvider"));
    const vault = "wallet-vault/1";
  `);
  assert.deepEqual(
    [...new Set(findings.map(({ kind }) => kind))].sort(),
    [
      "competing-discovery",
      "private-boundary",
      "private-registry",
      "runtime-boundary",
      "wallet-persistence",
      "wallet-ranking",
    ],
  );
});
