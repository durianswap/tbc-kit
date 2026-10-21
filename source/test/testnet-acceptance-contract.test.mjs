import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { repositoryRoot } from "../scripts/lib/repository.mjs";
const root = repositoryRoot(import.meta.url);
test("live adapter retains explicit fingerprint authority and confirmation boundaries without claiming a historical run", () => {
  const source = fs.readFileSync(root + "/examples/third-party-wallet-minimal/src/testnet-adapter.ts", "utf8");
  assert.match(source, /AUTHORIZATION_REQUIRED/);
  assert.match(source, /authorization.approvalFingerprint !== preview.approvalFingerprint/);
  assert.match(source, /CONFIRMATION_REQUIRED/);
  assert.match(source, /confirmed \? "confirmed" : "broadcast"/);
  assert.match(source, /Read-only testnet preflight rejected a network write/);
  const guide = fs.readFileSync(root + "/examples/third-party-wallet-minimal/README.md", "utf8");
  assert.match(guide, /no historical run is treated as acceptance/);
  assert.doesNotMatch(guide, /\]\([^)]*docs\/testing\/testnet-acceptance/);
  const manifest = JSON.parse(fs.readFileSync(root + "/package.json", "utf8"));
  assert.match(manifest.scripts["build:example:minimal"], /testnet-adapter\.ts/);
});
