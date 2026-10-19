import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { repositoryRoot } from "../scripts/lib/repository.mjs";

const root = repositoryRoot(import.meta.url);

test("defines a clean packed-package consumer gate", () => {
  const source = fs.readFileSync(`${root}/scripts/check-sdk-consumer.mjs`, "utf8");
  for (const packagePath of [
    "packages/core",
    "packages/tbc-engine",
    "packages/host",
    "packages/provider",
    "packages/wallet-standard",
  ]) {
    assert.match(source, new RegExp(packagePath.replaceAll("/", "\\/")));
  }
  assert.match(source, /mkdtempSync/);
  assert.match(source, /npm pack/);
  assert.match(source, /npm install/);
  assert.match(source, /@tbc-wallet\/host\/indexeddb/);
  assert.match(source, /@tbc-wallet\/provider\/in-memory/);
  assert.match(source, /third-party-wallet-minimal\/test\/e2e\.test\.mjs/);
  assert.match(source, /testnet-adapter\.test\.mjs/);
  assert.match(source, /testnet-preflight\.test\.mjs/);
  assert.match(source, /testnet-acceptance-command\.test\.mjs/);
  assert.match(source, /check-testnet-preflight\.mjs/);
  assert.match(source, /run-testnet-acceptance\.mjs/);
  assert.match(source, /scopes duplicate/);
  assert.match(source, /pending Provider close/);
  assert.match(source, /same-tick/);
  assert.match(source, /rmSync/);
  assert.doesNotMatch(source, /WIF|mnemonic|seedPhrase|apiKey|rpcUrl|authorization:/i);
});
