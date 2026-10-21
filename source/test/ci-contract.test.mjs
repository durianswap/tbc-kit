import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { runConformance } from "../scripts/conformance.mjs";
import { repositoryRoot } from "../scripts/lib/repository.mjs";

const root = repositoryRoot(import.meta.url);

test("CI installs from the lockfile and runs the complete local gate", () => {
  const workflow = fs.readFileSync(
    `${root}/../.github/workflows/conformance.yml`,
    "utf8",
  );
  assert.match(workflow, /node-version: 22/);
  assert.deepEqual(
    [...workflow.matchAll(/^\s+- run: (.+)$/gm)].map((match) => match[1]),
    [
      "npm ci",
      "cargo fetch --locked --manifest-path packages/tbc-engine/rust/Cargo.toml",
      "sdkmanager 'ndk;27.2.12479018'",
      "node packages/tbc-engine/scripts/build-rust-native.mjs",
      "node packages/tbc-engine/scripts/build-rust-mobile.mjs",
      "node packages/tbc-engine/scripts/build-rust-wasm.mjs",
      "npm run build:wallet-standard",
      "npm run build:tbc-engine",
      "npm run build:kit",
      "npm run check:core-portability",
      "npm run check:host-portability",
      "npm run check:provider-portability",
      "npm run check:wallet-standard-portability",
      "npm run check",
    ],
  );
  assert.match(workflow, /permissions:\s*\n\s+contents: read/);

  const packageJson = JSON.parse(
    fs.readFileSync(`${root}/package.json`, "utf8"),
  );
  const buildCore = packageJson.scripts.check.indexOf("npm run build:core");
  const rootTests = packageJson.scripts.check.indexOf("npm run test");
  assert.ok(buildCore >= 0, "root check must build Core declarations");
  assert.ok(
    buildCore < rootTests,
    "Core declarations must exist before docs compile",
  );
  for (const requiredCommand of [
    "npm run test",
    "npm run test:core",
    "npm run test:tbc-engine",
    "npm run test:host",
    "npm run test:provider",
    "npm run test:wallet-standard",
    "npm run test:example:minimal",
    "npm run check:sdk-consumer",
    "npm run check:core-portability",
    "npm run check:host-portability",
    "npm run check:provider-portability",
    "npm run check:wallet-standard-portability",
    "npm run check:conformance",
  ]) {
    assert.match(packageJson.scripts.check, new RegExp(requiredCommand.replaceAll(".", "\\.")));
  }
  assert.match(packageJson.scripts.check, /npm run test:kit/);
});

test("runs every v1 Candidate conformance profile", () => {
  const result = runConformance(root);
  assert.equal(result.version, "1.0.0-candidate.2");
  assert.deepEqual(result.profiles, [
    "schema",
    "semantic",
    "crypto",
    "lifecycle",
    "replay",
    "closure",
    "documents",
    "sdk",
  ]);
  assert.equal(result.closure.memoryMutationsRejected, 8);
  assert.equal(result.sdk.provider.methods, 22);
  assert.equal(result.sdk.provider.events, 6);
  assert.equal(result.sdk.discovery.officialRegistry, true);
  assert.equal(result.sdk.thirdPartyExample.privateCodeFree, true);
});
