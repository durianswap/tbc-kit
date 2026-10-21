import assert from "node:assert/strict";
import { access, readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const require = createRequire(import.meta.url);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("public export targets exist and React Native conditions precede Node/import/require", async () => {
  const manifest = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8"));
  assert.deepEqual(Object.keys(manifest.exports).sort(),
    [".", "./wallet", "./engine", "./rpc", "./api", "./sqlite", "./testing", "./multisig"].sort());
  async function checkTargets(value) {
    if (typeof value === "string") {
      assert.ok(value.startsWith("./dist/"));
      await access(resolve(packageRoot, value));
    } else {
      for (const target of Object.values(value)) await checkTargets(target);
    }
  }
  await checkTargets(manifest.exports);
  for (const [entry, target] of Object.entries({
    ".": "./dist/esm/index.native.js",
    "./wallet": "./dist/esm/wallet.js",
    "./engine": "./dist/esm/engine.js",
    "./sqlite": "./dist/esm/sqlite.js",
  })) {
    const conditions = manifest.exports[entry];
    assert.equal(conditions["react-native"], target);
    const keys = Object.keys(conditions);
    for (const fallback of ["node", "import", "require", "default"]) {
      if (keys.includes(fallback)) assert.ok(keys.indexOf("react-native") < keys.indexOf(fallback));
    }
  }
});

async function declarationFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return declarationFiles(path);
    return entry.name.endsWith(".d.ts") ? [path] : [];
  }));
  return nested.flat();
}

test("Kit build artifacts retain source maps without embedded original source", async () => {
  let count = 0;
  async function check(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await check(path);
      else if (entry.isFile() && entry.name.endsWith(".map")) {
        const map = JSON.parse(await readFile(path, "utf8"));
        assert.equal(map.version, 3, path);
        // Re-export-only chunks can legitimately have no source mappings.
        assert.ok(Array.isArray(map.sources), path);
        assert.equal(typeof map.mappings, "string", path);
        assert.equal(Object.hasOwn(map, "sourcesContent"), false, path);
        count += 1;
      }
    }
  }
  await check(resolve(packageRoot, "dist"));
  assert.ok(count > 0);
});

test("all eight public entry points load in ESM and CommonJS", async () => {
  const entries = ["index", "wallet", "engine", "rpc", "api", "sqlite", "testing", "multisig"];
  for (const entry of entries) {
    const esm = await import(`../dist/esm/${entry}.js`);
    const cjs = require(`../dist/cjs/${entry}.cjs`);
    assert.ok(Object.keys(esm).length > 0, entry);
    assert.deepEqual(Object.keys(cjs).sort(), Object.keys(esm).sort(), entry);
  }
});

test("public declaration closure is self-contained inside @tbc/kit", async () => {
  const files = await declarationFiles(resolve(packageRoot, "dist/types"));
  assert.ok(files.some((file) => file.endsWith("/internal/core/index.d.ts")));
  for (const file of files) {
    const declaration = await readFile(file, "utf8");
    assert.doesNotMatch(declaration, /from ["']@tbc-wallet\//u, file);
  }
});
