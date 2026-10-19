import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const manifestUrl = new URL("../package.json", import.meta.url);
const esmUrl = new URL("../dist/esm/index.js", import.meta.url);
const cjsUrl = new URL("../dist/cjs/index.cjs", import.meta.url);
const require = createRequire(import.meta.url);

test("publishes one portable package with an exact dependency boundary", async () => {
  const manifest = JSON.parse(await readFile(manifestUrl, "utf8"));

  assert.equal(manifest.name, "@tbc-wallet/tbc-engine");
  assert.equal(manifest.version, "1.0.0-draft.6.10.rust13");
  assert.equal(manifest.private, false);
  assert.equal(manifest.sideEffects, false);
  assert.deepEqual(manifest.files, ["artifacts", "dist", "README.md", "LICENSE"]);
  assert.deepEqual(manifest.dependencies, {
    "@noble/curves": "1.9.7",
    "@noble/hashes": "1.8.0",
    "@tbc-wallet/core": "1.0.0-draft.6.10",
  });
  assert.deepEqual(Object.keys(manifest.exports), [".", "./native", "./wasm"]);
  assert.equal(manifest.exports["."].types, "./dist/types/index.d.ts");
  assert.equal(manifest.exports["."].import, "./dist/esm/index.js");
  assert.equal(manifest.exports["."].require, "./dist/cjs/index.cjs");
  assert.equal(manifest.scripts?.postinstall, undefined);
});

test("exports only the engine factory, profile, and stable errors", async () => {
  const runtime = await import(esmUrl);
  const cjs = require(fileURLToPath(cjsUrl));
  const expectedExports = [
    "TBC_ENGINE_ERROR_CODES",
    "TBC_ENGINE_METHODS",
    "TBC_MAINNET_PROFILE",
    "TBC_TESTNET_PROFILE",
    "TbcEngineError",
    "createTbcEngine",
    "createTbcTransferEngine",
  ];

  assert.deepEqual(Object.keys(runtime).sort(), expectedExports);
  assert.deepEqual(Object.keys(cjs).sort(), expectedExports);
  assert.deepEqual(runtime.TBC_MAINNET_PROFILE, {
    chainId: "tbc:mainnet",
    p2pkhVersion: 0,
    transactionVersion: 10,
  });
  assert.deepEqual(runtime.TBC_TESTNET_PROFILE, {
    chainId: "tbc:testnet",
    p2pkhVersion: 0,
    transactionVersion: 10,
  });
  assert.equal(Object.isFrozen(runtime.TBC_TESTNET_PROFILE), true);

  const engine = runtime.createTbcTransferEngine();
  assert.equal(Object.isFrozen(engine), true);
  assert.deepEqual(Object.keys(engine).sort(), [
    "finalize",
    "normalizeRequest",
    "plan",
    "validate",
  ]);
  assert.equal("execute" in engine, false);
});

test("rejects hidden profiles and invalid requests without adding capabilities", async () => {
  const runtime = await import(esmUrl);

  assert.throws(
    () => runtime.createTbcTransferEngine({ coinSelection: "largest-first" }),
    (error) => error instanceof runtime.TbcEngineError && error.code === "INVALID_REQUEST",
  );
  assert.throws(
    () =>
      runtime.createTbcTransferEngine({
        networks: [runtime.TBC_MAINNET_PROFILE, runtime.TBC_MAINNET_PROFILE],
      }),
    (error) => error instanceof runtime.TbcEngineError && error.code === "INVALID_REQUEST",
  );

  const engine = runtime.createTbcTransferEngine();
  await assert.rejects(
    Promise.resolve().then(() => engine.normalizeRequest({})),
    (error) => error instanceof runtime.TbcEngineError && error.code === "INVALID_REQUEST",
  );
});

test("loads its ESM entry without ambient Node globals", () => {
  const script = `
    delete globalThis.Buffer;
    delete globalThis.crypto;
    delete globalThis.process;
    const runtime = await import(${JSON.stringify(pathToFileURL(fileURLToPath(esmUrl)).href)});
    if (typeof runtime.createTbcTransferEngine !== "function") throw new Error("factory missing");
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: packageDirectory,
    encoding: "utf8",
  });

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
