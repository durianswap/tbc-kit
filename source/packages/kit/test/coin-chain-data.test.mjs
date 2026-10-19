import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { createRequire, registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const require = createRequire(new URL("../package.json", import.meta.url));
const tbc = require("tbc-lib-js");
const bundled = await build({ stdin: { contents: `
  export { createDefaultTbcChainDataResolver } from './packages/kit/src/default-chain-data.ts';
  export { createTestnetClient } from './packages/kit/src/testnet-client.ts';
  export { inspectTbcTransaction } from './packages/kit/src/testnet-validation.ts';
  export { createWasmTbcKeylessEngine } from './packages/kit/src/keyless.ts';
`, resolveDir: root, loader: "ts" }, bundle: true, write: false, format: "esm", platform: "node",
  alias: { "@tbc-wallet/core": `${root}packages/core/src/index.ts` }, logLevel: "silent" });
const virtual = new URL("./.coin-chain-data-source.mjs", import.meta.url).href;
const hooks = registerHooks({
  resolve(specifier, context, next) { return specifier === virtual ? { url: virtual, shortCircuit: true } : next(specifier, context); },
  load(url, context, next) { return url === virtual ? { source: bundled.outputFiles[0].text, format: "module", shortCircuit: true } : next(url, context); },
});
const kit = await import(virtual); hooks.deregister();
const materialNative = await kit.createWasmTbcKeylessEngine(await readFile(`${root}packages/tbc-engine/rust/target/wasm32-unknown-unknown/release/tbc_keyless_wasm.wasm`));
const fixture = JSON.parse(await readFile(`${root}packages/tbc-engine/rust/fixtures/coin-proof.json`, "utf8"));
const address = "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH";
const account = { chainId: "tbc:testnet", address, accountId: `tbc:testnet:${address}`, publicKey: fixture.vectors[0].publicKeyHex };

function setup(locks, median, floor = "0", reverseIndex = false) {
  // Synthetic already-indexed outputs. No signatures are created or submitted.
  const tx = new tbc.Transaction(fixture.vectors[0].signedRaw);
  for (const [i, lock] of locks.entries()) {
    const tape = tx.outputs[i * 2 + 1].script.toBuffer();
    tape.writeUInt32LE(lock, tape.length - 14);
    tx.outputs[i * 2 + 1].setScript(tbc.Script.fromBuffer(tape));
  }
  const raw = tx.uncheckedSerialize();
  const parent = kit.inspectTbcTransaction(raw);
  const issuer = kit.inspectTbcTransaction(fixture.vectors[0].ancestorsRaw[0]);
  const mint = kit.inspectTbcTransaction(fixture.vectors[0].parentRaw);
  const raws = new Map([[parent.txid, raw], [issuer.txid, fixture.vectors[0].ancestorsRaw[0]], [mint.txid, fixture.vectors[0].parentRaw]]);
  const trace = [];
  const client = kit.createTestnetClient({ baseUrl: "https://api.tbcdev.org", allowedOrigins: ["https://api.tbcdev.org"], fetch: async (input, init) => {
    const url = new URL(String(input)); assert.equal(url.origin, "https://api.tbcdev.org");
    assert.equal(init?.method ?? "GET", "GET"); trace.push(url.pathname);
    let data;
    if (url.pathname === "/api/tbc/nodeinfo") data = { blocks: 100, bestblockhash: "aa".repeat(32), ...(median === undefined ? {} : { mediantime: median }) };
    else if (url.pathname === `/api/tbc/utxo/address/${address}`) data = { utxos: [{ txid: parent.txid, index: 4, value: parent.transaction.outputs[4].satoshis.toString(), height: 99 }] };
    else if (url.pathname.includes("/stablecoin/utxo/")) {
      const utxos = [0, 2].map((index, i) => ({ txid: parent.txid, index, tbc_value: "500", ft_value: i === 0 ? "250" : "750", height: 99,
        lock_time: 0 })); // Deliberately false index hint: only actual Tape determines lock.
      data = { utxos: reverseIndex ? utxos.reverse() : utxos };
    } else if (url.pathname.includes('/stablecoin/info/')) {
      data = {stablecoin_id: issuer.txid, utxo: {txid: mint.txid, vout: 0}, supply: '1000', decimal: 0,
        name: 'Coin', symbol: 'COIN', code_script: Buffer.from(mint.transaction.outputs[3].scriptPubKey).toString('hex'),
        tape_script: Buffer.from(mint.transaction.outputs[4].scriptPubKey).toString('hex')};
    } else if (url.pathname.startsWith("/api/tbc/txraw/txid/")) {
      const txid = url.pathname.split("/").at(-1); assert.ok(raws.has(txid)); data = { txraw: raws.get(txid) };
    } else throw new Error("Unexpected endpoint: " + url.pathname);
    return new Response(JSON.stringify({ code: "200", data }), { status: 200 });
  } });
  const resolver = kit.createDefaultTbcChainDataResolver({ accounts: { current: async () => [account] }, client,
    materialNative,
    now: () => Date.parse("2026-09-28T12:00:00Z"), snapshotId: () => "coin-lock-test", confirmationPolicy: { minConfirmations: floor } });
  const request = (merge = false, exact) => ({ version: "1.0", accountId: account.accountId, chainId: account.chainId, requirement: {
    intentType: merge ? "tbc20-stablecoin-merge" : "tbc20-stablecoin-transfer", includeAncestry: true,
    assets: [{ kind: "native" }, { kind: "stablecoin", contractId: issuer.txid, ...(merge ? {} : { minimumAmount: "250" }) }],
    contractIds: [issuer.txid], ...(exact ? { inputOutpoints: exact } : {}),
  } });
  return { trace, client, parent, issuer, resolver, request, resolve: (merge = false, exact) => resolver.resolve(request(merge, exact), account) };
}

test("Coin zero-lock hot path uses five SDK reads without a tip or issuer audit", async () => {
  const s = setup([0, 0]); const result = await s.resolve();
  assert.ok(result.snapshotHash, JSON.stringify(result));
  assert.equal(result.payload.block, undefined);
  assert.deepEqual(result.payload.utxos.filter(u => u.classification === "stablecoin").map(u => u.vout), [0]);
  assert.equal(s.trace.length, 5); assert.equal(new Set(s.trace).size, 5);
});

test("Coin locked-first backfills without duplicate raw and ignores index lock hints", async () => {
  for (const floor of ["0", "1"]) {
    const s = setup([101, 0], undefined, floor, true); const result = await s.resolve();
    assert.ok(result.snapshotHash, JSON.stringify(result));
    assert.deepEqual(result.payload.utxos.filter(u => u.classification === "stablecoin").map(u => u.vout), [2]);
    assert.equal(s.trace.length, 6); assert.equal(new Set(s.trace).size, 6);
    assert.equal((await s.resolve(false, [{ txid: s.parent.txid, vout: 0 }, { txid: s.parent.txid, vout: 4 }])).portError?.name, "CONFLICT");
  }
});

test("Coin timestamp maturity uses same-tip MTP, equality is not mature", async () => {
  for (const [median, vout, success] of [[undefined, 0, false], [500000100, 2, true], [500000101, 0, true]]) {
    const s = setup([500000100, 0], median); const result = await s.resolve();
    assert.equal(Boolean(result.snapshotHash), success, JSON.stringify(result));
    if (success) {
      assert.equal(result.payload.block.medianTimePast, String(median));
      assert.equal(result.payload.utxos.find(u => u.classification === "stablecoin").vout, vout);
    }
    assert.equal(s.trace.filter(p => p === "/api/tbc/nodeinfo").length, 1);
    assert.ok(s.trace.length <= 6);
  }
});

test("Coin height boundary and merge only include mature inputs", async () => {
  assert.ok((await setup([100, 100]).resolve(true)).snapshotHash);
  assert.equal((await setup([101, 101]).resolve()).portError?.name, "CONFLICT");
  assert.equal((await setup([101, 0]).resolve(true)).portError?.name, "CONFLICT");
});

test("node median accepts exact integer strings, rejects malformed present values", async () => {
  assert.equal((await setup([0, 0], "500000100").client.getUtxos(address)).tip.medianTimePast, "500000100");
  for (const median of [-1, 1.5, "x", null, "01"]) {
    await assert.rejects(setup([0, 0], median).client.getUtxos(address), error => error.code === "NODE_RESPONSE_INVALID");
  }
});
