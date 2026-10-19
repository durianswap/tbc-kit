#!/usr/bin/env node
// Current-source descriptor and default material loader. All API responses are
// offline SDK fixtures; no wallet, private key, permission or node is accessed.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const rust = `${root}packages/tbc-engine/rust`;
const bundle = await build({
  stdin: { contents: 'export * from "./packages/kit/src/amm-business-material.ts"; export * from "./packages/kit/src/keyless.ts"; export { inspectTbcTransaction } from "./packages/kit/src/testnet-validation.ts";', resolveDir: root, loader: "ts" },
  bundle: true, write: false, format: "esm", platform: "node", logLevel: "silent",
});
const kit = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString("base64")}`);
const native = await kit.createWasmTbcKeylessEngine(readFileSync(`${rust}/target/wasm32-unknown-unknown/release/tbc_keyless_wasm.wasm`));
const fixture = JSON.parse(readFileSync(`${rust}/fixtures/amm-pool-proof.json`, "utf8"));
const keys = [
  "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
  "02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5",
];
const row = (label, op) => fixture.vectors.find(value => value.id === `${label}-${op}`);
const raw = txid => ({ txid, rawTransaction: fixture.raws[txid] });
const inspect = async input => JSON.parse(await native.execute("inspectAmmMaterial", JSON.stringify(input)));
function transaction(txid) {
  assert.equal(typeof fixture.raws[txid], "string", "No unrelated transaction read");
  const tx = kit.inspectTbcTransaction(fixture.raws[txid]).transaction;
  return { ...raw(txid), inputs: tx.inputs, outputs: tx.outputs.map((out, vout) => ({
    vout, satoshis: out.satoshis.toString(), scriptPubKey: Buffer.from(out.scriptPubKey).toString("hex"),
  })) };
}
let accepted = 0, rejected = 0, explicitAccepted = 0, explicitRejected = 0;
const reports = [];
for (const label of ["public-plain", "public-locked", "controller-plain", "controller-locked"]) {
  const contractId = row(label, "add").parentTxid, currentId = row(label, "buy").parentTxid;
  const pool = transaction(currentId);
  const meta = await inspect({ phase: "inspectPool", pool: raw(contractId) });
  for (const [index, publicKey] of keys.entries()) {
    const descriptor = await inspect({ phase: "describe", poolGenesis: raw(contractId), ftGenesis: raw(meta.ftContractId), publicKey, currentPool: raw(currentId) });
    const trace = [], reads = [];
    const source = kit.inspectTbcTransaction(row(label, "buy").currentRaw).transaction;
    const reserve = source.inputs[2];
    const assets = await inspect({ phase: "inspectAssets", parents: [raw(reserve.txid)], outputs: [{ txid: reserve.txid, vout: reserve.vout, kind: "ft" }] });
    const input = {
      contractId, publicKey, action: { kind: "buy", amount: "10000" }, native,
      minimumConfirmations: "0", tip: Promise.resolve({ height: "830000", hash: "11".repeat(32) }),
      readHistory: async id => { reads.push(id); return transaction(id); },
      readDecoded: async () => { throw new Error("Unexpected decoded query"); },
      api: {
        poolInfo: async () => { trace.push("pool-index"); return { txid: currentId, vout: "0", value: pool.outputs[0].satoshis,
          pool_code_script: descriptor.poolCodeScript, ft_contract_id: descriptor.ftContractId,
          token_balance: descriptor.state.ftAmount, lp_balance: descriptor.state.lpAmount,
          tbc_balance: descriptor.state.tbcAmount, service_fee_rate: String(descriptor.serviceFeeRate) }; },
        ftUtxosByCombineScript: async query => {
          assert.equal(query.combine_script, descriptor.poolCombineScript);
          trace.push("pool-ft-index");
          return { utxos: [{ txid: reserve.txid, index: String(reserve.vout), tbc_value: "500", ft_value: assets.items[0].balance, height: "0" }] };
        },
        poolLpUtxosByScriptHash: async () => { throw new Error("Buy needs no holder LP index"); },
      },
    };
    const foreignController = label.startsWith("controller") && index === 0;
    let baseTrace, baseReadCount;
    if (foreignController) {
      await assert.rejects(kit.resolveAmmBusinessMaterial(input), /independent Pool controller needs an explicit shared signing role/u);
      assert.deepEqual(trace, ["pool-index"], "Unsupported role must not start asset indexes");
      const allowed = new Set([contractId, meta.ftContractId, currentId, transaction(contractId).inputs[0].txid, pool.inputs[0].txid]);
      assert.ok(reads.every(id => allowed.has(id)), "Unsupported role must not fetch asset ancestors");
      // Rejected tip, concurrently with the role failure, must remain observed.
      await assert.rejects(kit.resolveAmmBusinessMaterial({ ...input, tip: Promise.reject(new Error("Synthetic tip failure")) }), /independent Pool controller/u);
      await new Promise(resolve => setImmediate(resolve));
      rejected++;
      baseTrace = [...new Set(trace)]; baseReadCount = new Set(reads).size;
      trace.length = 0; reads.length = 0;
      const explicit = await kit.resolveAmmBusinessMaterial({ ...input, controllerPublicKey: keys[1] });
      assert.deepEqual(trace, ["pool-index", "pool-ft-index"]);
      assert.equal(explicit.utxos.filter(u => u.classification === "pool-ft").length, 1);
      const desc = await inspect({ phase: "describe", poolGenesis: raw(contractId), ftGenesis: raw(meta.ftContractId),
        publicKey, controllerPublicKey: keys[1], currentPool: raw(currentId) });
      assert.equal(desc.ownerCombineScript, descriptor.ownerCombineScript);
      assert.equal(desc.ownerLpScript, descriptor.ownerLpScript);
      explicitAccepted++;
      trace.length = 0;
      await assert.rejects(kit.resolveAmmBusinessMaterial({ ...input, controllerPublicKey: keys[0] }), /independent Pool controller/u);
      assert.deepEqual(trace, ["pool-index"]);
      explicitRejected++;
    } else {
      const result = await kit.resolveAmmBusinessMaterial(input);
      assert.deepEqual(trace, ["pool-index", "pool-ft-index"]);
      assert.equal(result.utxos.filter(u => u.classification === "pool-ft").length, 1);
      assert.deepEqual(result.parents.map(p => p.txid), result.parents.map(p => p.txid).sort());
      accepted++;
      baseTrace = [...new Set(trace)]; baseReadCount = new Set(reads).size;
      if (label.startsWith("public") && index === 0) {
        trace.length = 0;
        await assert.rejects(kit.resolveAmmBusinessMaterial({ ...input, controllerPublicKey: keys[1] }), /does not need an explicit controller/u);
        assert.deepEqual(trace, ["pool-index"]);
        explicitRejected++;
      }
    }
    reports.push({ profile: label, account: index === 0 ? "holder" : "controller", accepted: !foreignController, indexes: baseTrace, rawSet: baseReadCount });
  }
}
assert.equal(accepted, 6); assert.equal(rejected, 2);
assert.equal(explicitAccepted, 2); assert.equal(explicitRejected, 4);
console.log(JSON.stringify({ result: "AMM_CONTROLLER_MATERIAL_SOURCE_PASS", accepted, rejected, explicitAccepted, explicitRejected, cases: reports,
  scope: "Source WASM + default material; role discovery is not account authorization or signing; real HTTP=0, signing=0, POST=0" }, null, 2));
