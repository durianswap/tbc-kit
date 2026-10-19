#!/usr/bin/env node
// Native Rust/source WASM parity for pure AMM descriptors. No delivered binary,
// HTTP, signing, wallet state or broadcast is used or replaced.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";
const root = fileURLToPath(new URL("../../../", import.meta.url));
const cwd = `${root}packages/tbc-engine/rust`;
const compiled = spawnSync("cargo", ["build", "--offline", "--locked", "--release", "-p", "tbc-keyless-wasm", "--target", "wasm32-unknown-unknown"], {
  cwd, env: { ...process.env, RUSTFLAGS: '--cfg getrandom_backend="unsupported"' }, encoding: "utf8", timeout: 60000, maxBuffer: 8 * 1024 * 1024,
});
assert.equal(compiled.status, 0, "Keyless source WASM build failed; output withheld");
const run = spawnSync("cargo", ["test", "--offline", "--locked", "-p", "tbc-keyless-core", "--test", "amm_material",
  "--", "--nocapture"], {
  cwd, env: { ...process.env, AMM_MATERIAL_DUMP_WIRE: "1" }, encoding: "utf8", timeout: 60000, maxBuffer: 16 * 1024 * 1024,
});
assert.equal(run.status, 0, "Native material gate failed; output withheld");
const rows = run.stdout.split("\n").filter(s => s.startsWith("AMM_MATERIAL_WIRE:")).map(s => JSON.parse(s.slice("AMM_MATERIAL_WIRE:".length)));
assert.equal(rows.length, 116);
const bundled = await build({ entryPoints: [`${root}packages/kit/src/keyless.ts`], bundle: true, write: false, format: "esm", platform: "node", logLevel: "silent" });
const { createWasmTbcKeylessEngine } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].contents).toString("base64")}`);
const wasm = await createWasmTbcKeylessEngine(readFileSync(`${cwd}/target/wasm32-unknown-unknown/release/tbc_keyless_wasm.wasm`));
for (const [index, row] of rows.entries()) {
  const result = JSON.parse(await wasm.execute("inspectAmmMaterial", JSON.stringify(row.input)));
  assert.ok(JSON.stringify(result) === JSON.stringify(row.result), `Native/WASM material mismatch at ${index}`);
}
for (const input of [{ phase: "inspectPool", pool: { txid: "00".repeat(32), rawTransaction: "00" } },
  { ...rows[0].input, privateKey: "forbidden" }, { phase: "inspectAssets", parents: [], outputs: [] }])
  await assert.rejects(wasm.execute("inspectAmmMaterial", JSON.stringify(input)));
console.log(`AMM_MATERIAL_SOURCE_PASS ${rows.length} Native/WASM calls; Pool scripts/index keys and direct asset dependencies match pinned SDK transactions; HTTP=0, signing=0, POST=0; delivery binaries unchanged`);
