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
  export { resolveCoinManagementMaterial } from './packages/kit/src/coin-management-material.ts';
`, resolveDir: root, loader: "ts" }, bundle: true, write: false, format: "esm", platform: "node",
  alias: { "@tbc-wallet/core": `${root}packages/core/src/index.ts` }, logLevel: "silent" });
const virtual = new URL("./.coin-chain-data-source.mjs", import.meta.url).href;
const hooks = registerHooks({
  resolve(specifier, context, next) { return specifier === virtual ? { url: virtual, shortCircuit: true } : next(specifier, context); },
  load(url, context, next) { return url === virtual ? { source: bundled.outputFiles[0].text, format: "module", shortCircuit: true } : next(url, context); },
});
const kit = await import(virtual); hooks.deregister();
const materialNative = await kit.createWasmTbcKeylessEngine(await readFile(process.env.TBC_TEST_WASM_DIR
  ? `${process.env.TBC_TEST_WASM_DIR}/tbc_keyless_wasm.wasm`
  : `${root}packages/tbc-engine/rust/target/wasm32-unknown-unknown/release/tbc_keyless_wasm.wasm`));
const fixture = JSON.parse(await readFile(`${root}packages/tbc-engine/rust/fixtures/coin-proof.json`, "utf8"));
const address = "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH";
const account = { chainId: "tbc:testnet", address, accountId: `tbc:testnet:${address}`, publicKey: fixture.vectors[0].publicKeyHex };

test('Coin management observes unused concurrent failures without suppressing required tip validation',async()=>{
  const id='aa'.repeat(32),raw={txid:id,rawTransaction:'',inputs:[],outputs:[{vout:0,satoshis:'500',scriptPubKey:'51'}]};
  const input={mint:false,contractId:id,targetOutpoints:[{txid:id,vout:0}],minimumConfirmations:'0',
    readHistory:async()=>raw,readDecoded:async()=>raw,ancestors:()=>[],
    api:{txoStatus:async()=>({txos:[{txid:id,index:'0',value:'500',spent:false,scriptPubKey:'51',height:'1'}]})}};
  await assert.rejects(kit.resolveCoinManagementMaterial({...input,tipHeight:Promise.reject(Error('tip unavailable'))}),/tip unavailable/);
  await assert.rejects(kit.resolveCoinManagementMaterial({...input,contractId:'invalid',tipHeight:Promise.reject(Error('unused tip failure'))}),/Invalid Coin asset ID/);
  for(const spent of [true,undefined]) {
    const api={txoStatus:async()=>({txos:[{txid:id,index:'0',value:'500',spent}]})};
    await assert.rejects(kit.resolveCoinManagementMaterial({...input,api,tipHeight:Promise.resolve(10n)}),
      e=>spent===true?e.reason==='SELECTED_INPUT_SPENT':e.reason===undefined);
  }
  await new Promise(resolve=>setImmediate(resolve));
});

function setup(locks, median, floor = "0", reverseIndex = false, fragments = 2, zeros = false) {
  // Synthetic already-indexed outputs. No signatures are created or submitted.
  const tx = new tbc.Transaction(fixture.vectors[0].signedRaw);
  for (const [i, lock] of locks.entries()) {
    const tape = tx.outputs[i * 2 + 1].script.toBuffer();
    tape.writeUInt32LE(lock, tape.length - 14);
    tx.outputs[i * 2 + 1].setScript(tbc.Script.fromBuffer(tape));
  }
  if (fragments > 2) {
    const first=tx.outputs[0],tape=tx.outputs[1],fee=tx.outputs[4];tx.outputs=[];
    for(let i=0;i<fragments;i++) {
      tx.addOutput(new tbc.Transaction.Output({satoshis:500,script:first.script}));
      tx.addOutput(new tbc.Transaction.Output({satoshis:0,script:tape.script}));
    }
    tx.addOutput(fee);
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
    else if (url.pathname === `/api/tbc/utxo/address/${address}`) data = { utxos: [{ txid: parent.txid, index: fragments*2, value: parent.transaction.outputs[fragments*2].satoshis.toString(), height: 99 }] };
    else if (url.pathname.includes("/stablecoin/utxo/")) {
      const utxos = Array.from({length:fragments},(_,i)=>2*i).map((index, i) => ({ txid: parent.txid, index, tbc_value: "500", ft_value: fragments>2?"250":i === 0 ? "250" : "750", height: 99,
        lock_time: 0 })); // Deliberately false index hint: only actual Tape determines lock.
      if (zeros) utxos.unshift({ txid: '00'.repeat(32), index: 0, tbc_value: '500', ft_value: '0' });
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

test("Coin legal zero index rows preserve material and GET count; explicit zero inputs are not ignored", async () => {
  for (const merge of [false, true]) for (const floor of ['0', '1']) {
    const before = setup([0, 0], undefined, floor), after = setup([0, 0], undefined, floor, false, 2, true);
    const expected = await before.resolve(merge), actual = await after.resolve(merge);
    assert.ok(actual.snapshotHash, JSON.stringify(actual));
    assert.deepEqual(actual, expected); assert.deepEqual(after.trace, before.trace);
    after.trace.length = 0;
    const denied = await after.resolve(merge, [{ txid: '00'.repeat(32), vout: 0 }, { txid: after.parent.txid, vout: 0 }]);
    assert.equal(denied.portError?.name, 'INVALID_INPUT');
    assert.equal(denied.portError?.details?.reason, 'SELECTED_ZERO_BALANCE_INPUT');
    assert.equal(after.trace.some(p => p.endsWith('00'.repeat(32))), false);
  }
});

test("Coin holder material selects six and twenty fragments without duplicate ancestry or tip reads", async () => {
  for(const count of [6,20]) for(const merge of [false,true]) {
    const s=setup([0,0],undefined,"0",false,count),request=s.request(merge);
    if(!merge)request.requirement.assets[1].minimumAmount=String(count*250);
    const result=await s.resolver.resolve(request,account);
    assert.ok(result.snapshotHash,JSON.stringify(result));
    assert.equal(result.payload.utxos.filter(u=>u.classification==="stablecoin").length,count);
    assert.equal(s.trace.length,5);assert.equal(new Set(s.trace).size,5);
    assert.ok(!s.trace.some(p=>p.includes('nodeinfo')));
  }
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
