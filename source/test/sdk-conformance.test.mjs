import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { runConformance } from "../scripts/conformance.mjs";
import { repositoryRoot } from "../scripts/lib/repository.mjs";

const root = repositoryRoot(import.meta.url);

test("ships machine-readable Provider, discovery, and third-party profiles", () => {
  const expected = [
    "conformance/provider-profile.json",
    "conformance/third-party-wallet-profile.json",
    "conformance/wallet-standard-profile.json",
  ];
  for (const relative of expected) {
    assert.equal(fs.existsSync(path.join(root, relative)), true, relative);
  }

  const provider = JSON.parse(
    fs.readFileSync(path.join(root, expected[0]), "utf8"),
  );
  assert.equal(provider.package, "@tbc-wallet/provider");
  assert.equal(provider.version, "1.0.0-draft.6.15");
  assert.equal(provider.methods.length, 22);
  assert.equal(provider.events.length, 6);
  assert.deepEqual(provider.atomicDelivery, ["deliveryId", "response", "events"]);

  const example = JSON.parse(
    fs.readFileSync(path.join(root, expected[1]), "utf8"),
  );
  assert.deepEqual(example.transactionPath, [
    "normalize",
    "plan",
    "approval-binding",
    "signer.sign",
    "finalize",
    "broadcast",
  ]);
  assert.equal(example.privateCodeFree, true);
  assert.deepEqual(example.scenarios, [
    "account-authorization",
    "arbitrary-mainnet-transfer",
    "testnet-transfer",
    "multi-input-selection",
    "exact-spend",
    "change-output",
    "concurrent-same-method",
    "sign-only-no-broadcast",
    "provider-close",
    "request-abort",
    "cross-session-request-id-isolation",
    "pending-close-host-cancellation",
    "pre-registration-provider-close",
    "pre-registration-controller-close",
    "abort-host-cancellation",
    "durable-delivery-replay",
  ]);

  const discovery = JSON.parse(
    fs.readFileSync(path.join(root, expected[2]), "utf8"),
  );
  assert.equal(discovery.registryPackage, "@wallet-standard/core");
  assert.equal(discovery.registryVersion, "1.1.2");
  assert.equal(discovery.autoSelect, false);
});

test("executes SDK profiles as part of aggregate conformance", () => {
  const result = runConformance(root);
  assert.equal(result.status, "pass");
  assert.equal(result.sdk.version, "1.0.0-draft.6.15");
  assert.deepEqual(result.sdk.transport.lifecycle, [
    "unique-session-id",
    "atomic-delivery",
    "promise-before-events",
    "sent-before-page-dispatch",
    "abort-suppresses-late-delivery",
    "close-rejects-pending",
    "replay-fails-closed",
  ]);
  assert.deepEqual(result.sdk.portability.targets, [
    "browser",
    "worker",
    "chrome-mv3-csp",
    "react-native-hermes",
    "node-esm",
    "node-cjs",
  ]);
  assert.equal(result.sdk.packages, 5);
  assert.equal(result.sdk.thirdPartyExample.scenarios, 16);
});
