import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { runConformance } from "../scripts/conformance.mjs";
import { repositoryRoot } from "../scripts/lib/repository.mjs";

const root = repositoryRoot(import.meta.url);

test("CI installs from the lockfile and runs the complete local gate", () => {
  const workflow = fs.readFileSync(
    `${root}/.github/workflows/conformance.yml`,
    "utf8",
  );
  assert.match(workflow, /node-version: 22/);
  assert.deepEqual(
    [...workflow.matchAll(/^\s+- run: (.+)$/gm)].map((match) => match[1]),
    [
      "npm ci",
      "npm run check:core-portability",
      "npm run check:host-portability",
      "npm run check:provider-portability",
      "npm run check:wallet-standard-portability",
      "npm run check:handoff:sdk",
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
    "npm run check:handoff:draft1",
    "npm run check:handoff:draft2",
    "npm run check:handoff:draft3",
    "npm run check:handoff:draft4",
    "npm run check:handoff:draft5",
    "npm run check:handoff:draft6",
    "npm run check:handoff:core",
    "npm run check:handoff:sdk",
  ]) {
    assert.match(packageJson.scripts.check, new RegExp(requiredCommand.replaceAll(".", "\\.")));
  }
  const handoffScripts = Object.entries(packageJson.scripts)
    .filter(([name]) => name.startsWith("check:handoff:"))
    .map(([, command]) => command)
    .join("\n");
  for (const requiredAsset of [
    "release/tws-1.0.0-draft.1.config.json",
    "release/tws-1.0.0-draft.2.config.json",
    "release/freeze.config.json",
    "release/tws-1.0.0-draft.3.json",
    "release/tws-1.0.0-draft.4.config.json",
    "release/tws-1.0.0-draft.4.json",
    "release/tws-1.0.0-draft.5.config.json",
    "release/tws-1.0.0-draft.5.json",
    "release/tws-1.0.0-draft.6.config.json",
    "release/tws-1.0.0-draft.6.json",
    "release/tws-core-1.0.0-draft.6.config.json",
    "release/tws-core-1.0.0-draft.6.json",
    "release/tws-sdk-1.0.0-draft.6.3.config.json",
    "release/tws-sdk-1.0.0-draft.6.3.json",
  ]) {
    assert.match(handoffScripts, new RegExp(requiredAsset.replaceAll(".", "\\.")));
  }
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
