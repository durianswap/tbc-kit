import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const packageDirectory = path.join(root, "packages/provider");
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

test("Provider package declares portable root and opt-in transport boundaries", async () => {
  const manifest = JSON.parse(
    await readFile(path.join(packageDirectory, "package.json"), "utf8"),
  );
  assert.equal(manifest.name, "@tbc-wallet/provider");
  assert.equal(manifest.version, "1.0.0-draft.6.15");
  assert.equal(manifest.private, false);
  assert.equal(manifest.sideEffects, false);
  assert.deepEqual(manifest.files, [
    "dist",
    "README.md",
    "CHANGELOG.md",
    "LICENSE",
  ]);
  assert.deepEqual(Object.keys(manifest.exports), [".", "./in-memory", "./webview"]);
  assert.deepEqual(manifest.dependencies, {
    "@tbc-wallet/core": "1.0.0-draft.6.10",
  });
  assert.equal(manifest.scripts?.postinstall, undefined);
});

test("Provider method and event constants exactly project the frozen registries", async () => {
  const runtime = await import(new URL("../dist/esm/index.js", import.meta.url));
  const methods = JSON.parse(
    await readFile(path.join(root, "registry/methods.json"), "utf8"),
  ).methods.map(({ name }) => name);
  const events = JSON.parse(
    await readFile(path.join(root, "registry/events.json"), "utf8"),
  ).events.map(({ name }) => name);

  assert.deepEqual(runtime.TBC_PROVIDER_METHODS, methods);
  assert.deepEqual(runtime.TBC_PROVIDER_EVENTS, events);
  assert.equal(new Set(runtime.TBC_PROVIDER_METHODS).size, 22);
  assert.equal(new Set(runtime.TBC_PROVIDER_EVENTS).size, 6);
});

test("keeps WebView controllers outside the Provider root entry", async () => {
  const rootRuntime = await import(new URL("../dist/esm/index.js", import.meta.url));
  const webview = await import(new URL("../dist/esm/webview.js", import.meta.url));
  assert.equal("createTbcWebViewPageTransport" in rootRuntime, false);
  assert.equal("createTbcWebViewNativeController" in rootRuntime, false);
  assert.equal(typeof webview.createTbcWebViewPageTransport, "function");
  assert.equal(typeof webview.createTbcWebViewNativeController, "function");
});

test("generated Provider types are deterministic and strict consumers compile", () => {
  const generated = spawnSync(
    process.execPath,
    [path.join(root, "scripts/generate-provider-types.mjs"), "--check"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(generated.status, 0, `${generated.stdout}\n${generated.stderr}`);

  for (const fixture of ["valid.ts", "invalid.ts"]) {
    const result = compile(fixture);
    assert.equal(result.status, 0, `${fixture}\n${result.stdout}\n${result.stderr}`);
  }
});

test("WebView subpath exact unions compile under strict TypeScript", () => {
  for (const fixture of ["webview-valid.ts", "webview-invalid.ts"]) {
    const result = compile(fixture);
    assert.equal(result.status, 0, `${fixture}\n${result.stdout}\n${result.stderr}`);
  }
});
