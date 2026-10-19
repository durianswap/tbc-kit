import assert from "node:assert/strict";
import test from "node:test";

import {
  checkProviderPortability,
  PROVIDER_PORTABILITY_LIMITS,
  scanForbiddenProviderCapabilities,
} from "../../../scripts/check-provider-portability.mjs";

test("Provider loads under Browser, Worker, MV3 CSP, React Native, and Node", async () => {
  const report = await checkProviderPortability();

  assert.equal(report.status, "pass");
  assert.equal(report.browserSmoke, "pass");
  assert.equal(report.workerSmoke, "pass");
  assert.equal(report.mv3CspSmoke, "pass");
  assert.equal(report.reactNativeSmoke, "pass");
  assert.equal(report.nodeEsmSmoke, "pass");
  assert.equal(report.nodeCjsSmoke, "pass");
  assert.equal(report.webviewBrowserSmoke, "pass");
  assert.equal(report.webviewWorkerSmoke, "pass");
  assert.equal(report.webviewMv3CspSmoke, "pass");
  assert.equal(report.webviewReactNativeSmoke, "pass");
  assert.equal(report.webviewNodeEsmSmoke, "pass");
  assert.equal(report.webviewNodeCjsSmoke, "pass");
  assert.deepEqual(Object.keys(report.webviewBundles).sort(), [
    "browser",
    "mv3",
    "nodeEsm",
    "reactNative",
    "worker",
  ]);
  assert.equal(report.webviewArtifact.bytes <= PROVIDER_PORTABILITY_LIMITS.maxWebViewArtifactBytes, true);
  assert.equal(report.webviewArtifact.gzipBytes <= PROVIDER_PORTABILITY_LIMITS.maxWebViewArtifactGzipBytes, true);
  assert.deepEqual(report.runtimeDependencies, {
    "@tbc-wallet/core": "1.0.0-draft.6.10",
  });
  assert.deepEqual(report.publicRuntimeExports, [
    "ProviderRpcError",
    "TBC_PROVIDER_EVENTS",
    "TBC_PROVIDER_MAX_MESSAGE_BYTES",
    "TBC_PROVIDER_METHODS",
    "TbcProviderValidationError",
    "assertTbcProviderEvent",
    "assertTbcProviderMethodParams",
    "assertTbcProviderMethodResult",
    "assertTbcProviderRequest",
    "assertTbcProviderResponse",
    "assertTbcTransportDelivery",
    "canonicalTbcMessageBytes",
    "createTbcProvider",
  ]);
  assert.deepEqual(report.forbiddenSourceCapabilities, []);
  assert.equal(report.publicRuntimeExports.includes("createTbcWebViewNativeController"), false);
});

test("Provider portability scanner rejects ambient, private, network, and Node powers", () => {
  const findings = scanForbiddenProviderCapabilities(`
    import fs from "node:fs";
    import { createTwsHost } from "@tbc-wallet/host";
    const tab = chrome.runtime.id;
    fetch("https://wallet.invalid");
    setTimeout(() => undefined, 1);
    const privateName = "wallet-vault/1";
    const secret = vaultHandle;
  `);

  assert.deepEqual(
    [...new Set(findings.map(({ kind }) => kind))].sort(),
    [
      "ambient-timer",
      "network-runtime",
      "node-builtin",
      "platform-global",
      "private-boundary",
      "runtime-boundary",
    ],
  );
});
