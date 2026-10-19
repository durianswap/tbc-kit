#!/usr/bin/env node
// Public observation account only: NOT our funded test account. No Signer,
// finalize, POST or broadcast exists in this diagnostic. Nothing is spendable
// merely because planning succeeds.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";

assert.equal(process.argv.length, 2);
const root = fileURLToPath(new URL("../../../", import.meta.url));
const source = spawnSync("cargo", ["build", "--offline", "--locked", "--release", "-p", "tbc-engine-wasm", "--target", "wasm32-unknown-unknown"], {
  cwd: `${root}packages/tbc-engine/rust`, env: { ...process.env, RUSTFLAGS: '--cfg getrandom_backend="unsupported"' },
  encoding: "utf8", timeout: 60_000, maxBuffer: 8 * 1024 * 1024,
});
assert.equal(source.status, 0, "Source WASM build failed; raw output withheld");
const compiled = await build({ stdin: { contents: `
  export { createDefaultTbcNetwork } from './packages/kit/src/default-network.ts';
  export { createTbcNetworkContext } from './packages/kit/src/network-context.ts';
  export { inspectTbcTransaction } from './packages/kit/src/testnet-validation.ts';
  export { prepareTbcTransaction } from './packages/kit/src/prepared.ts';
  export { createTbcEngine } from './packages/tbc-engine/src/facade.ts';
  export { createWasmTbcEngineBackend } from './packages/tbc-engine/src/wasm.ts';
`, resolveDir: root, loader: "ts" }, alias: { "@tbc-wallet/core": `${root}packages/core/src/index.ts` },
  bundle: true, write: false, format: "esm", platform: "node", target: "node22", logLevel: "silent" });
const kit = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`);
const fullEngine = kit.createTbcEngine({ backend: await kit.createWasmTbcEngineBackend(
  readFileSync(`${root}packages/tbc-engine/rust/target/wasm32-unknown-unknown/release/tbc_engine_wasm.wasm`)) });
const calls = [];
const engine = Object.fromEntries(["normalizeRequest", "plan", "validate"].map(method => [method, async input => {
  calls.push(method); return fullEngine[method](input);
}]));
const origin = "https://api.tbcdev.org";
const assetId = "adf34e37243821c8542b577202b4282bae7bb2687ad260c4ccb1feaf52ba9f0d";
const publicParent = "e2631551e50cbaae744ae3f440b0c5350661ad2a1f86bfcc8e4bfa13e6b5c1ea";
const address = "143KgKGcse57nXBnXyJwtQrf2KP4KWto59";
const trace = [];
async function read(input, options) {
  const url = new URL(String(input)); assert.equal(url.origin, origin);
  assert.equal(options?.method ?? "GET", "GET");
  assert.ok(!url.username && !url.password && !url.hash);
  const response = await fetch(url, { ...options, redirect: "error", signal: options?.signal ?? AbortSignal.timeout(15000) });
  trace.push({ path: url.pathname, status: response.status }); return response;
}
// Derive only a public key from a public P2PKH witness. Kit/Engine subsequently
// check that it really corresponds to the observation address and material.
const response = await read(`${origin}/api/tbc/txraw/txid/${publicParent}`);
assert.equal(response.status, 200);
const raw = (await response.json()).data.txraw;
const parsed = kit.inspectTbcTransaction(raw); assert.equal(parsed.txid, publicParent);
const witness = parsed.transaction.inputs.at(-1).scriptSig;
const size = witness[0]; assert.ok(size >= 9 && size <= 73);
assert.equal(witness[1 + size], 33); assert.equal(witness.length, size + 35);
const publicKey = Buffer.from(witness.subarray(size + 2)).toString("hex");
const account = { address, chainId: "tbc:testnet", accountId: `tbc:testnet:${address}`, publicKey };
const setupReads = trace.length;
const network = kit.createDefaultTbcNetwork({ network: kit.createTbcNetworkContext({ network: "testnet" }),
  accounts: { current: async () => [account] }, fetch: read,
  poolMaterial: { async resolveLiquidityAdd() { throw new Error("Unrelated Pool path"); } },
});
const request = { version: "1.0", chainId: account.chainId, from: address,
  intent: { type: "tbc20-stablecoin-transfer", version: "1.0", contractId: assetId, to: address, amount: "1" },
  constraints: { maxFee: "5000" } };
const prepared = await kit.prepareTbcTransaction({ request, network, engine });
assert.equal(prepared.proposal.payload.evidence.contracts[0].contractId, assetId);
assert.deepEqual(prepared.proposal.payload.evidence.contracts[0].genesisOutpoint, { txid: assetId, vout: 0 });
assert.equal(prepared.proposal.payload.transactions.length, 1);
assert.ok(calls.every(method => method !== "finalize"));
console.log(JSON.stringify({ result: "COIN_LIVE_READONLY_PLAN_PASS", assetId, address,
  setupReads, planningReads: trace.length - setupReads, calls, trace,
  estimatedFee: prepared.proposal.payload.estimatedTotalFee, signatures: 0, POST: 0,
  note: "Public node material and unsigned planning only; no custody or live spend acceptance" }));
