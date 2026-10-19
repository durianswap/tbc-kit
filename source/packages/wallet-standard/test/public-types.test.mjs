import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const packageDirectory = path.join(root, "packages/wallet-standard");
const tsc = path.join(root, "node_modules/.bin/tsc");

function compile(fixture) {
  return spawnSync(
    tsc,
    [
      "--noEmit",
      "--strict",
      "--exactOptionalPropertyTypes",
      "--noUncheckedIndexedAccess",
      "--skipLibCheck",
      "--module", "NodeNext",
      "--moduleResolution", "NodeNext",
      "--target", "ES2022",
      path.join(packageDirectory, "test/types", fixture),
    ],
    { cwd: root, encoding: "utf8" },
  );
}

test("Wallet Standard adapter has one official, side-effect-free boundary", async () => {
  const manifest = JSON.parse(
    await readFile(path.join(packageDirectory, "package.json"), "utf8"),
  );
  assert.equal(manifest.name, "@tbc-wallet/wallet-standard");
  assert.equal(manifest.version, "1.0.0-draft.6.11");
  assert.equal(manifest.private, false);
  assert.equal(manifest.sideEffects, false);
  assert.deepEqual(Object.keys(manifest.exports), ["."]);
  assert.deepEqual(manifest.dependencies, {
    "@tbc-wallet/provider": "1.0.0-draft.6.15",
    "@wallet-standard/core": "1.1.2",
  });
  assert.equal(manifest.scripts?.postinstall, undefined);

  const source = await readFile(path.join(packageDirectory, "src/index.ts"), "utf8");
  assert.doesNotMatch(source, /wallet-standard:(?:app-ready|register-wallet)/);
  assert.doesNotMatch(source, /window\.Turing|eip6963|localStorage|sessionStorage/);
});

test("valid and invalid Wallet Standard consumers compile strictly", () => {
  for (const fixture of ["valid.ts", "invalid.ts"]) {
    const result = compile(fixture);
    assert.equal(result.status, 0, `${fixture}\n${result.stdout}\n${result.stderr}`);
  }
});
