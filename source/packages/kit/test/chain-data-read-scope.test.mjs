import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const result = await build({ stdin: { contents: `export * from './packages/kit/src/chain-data-read-scope.ts';
  export {createTestnetClient} from './packages/kit/src/testnet-client.ts';`, resolveDir: root, loader: "ts" },
  alias: { "@tbc-wallet/core": `${root}packages/core/src/index.ts` },
  bundle: true, write: false, format: "esm", platform: "node", logLevel: "silent" });
const { createChainDataReadScope, createTestnetClient } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);

function client() {
  const calls = [];
  const read = method => async (...args) => { calls.push([method, args]); return { method, args }; };
  const value = Object.fromEntries(["getUtxos", "getRawTransaction", "getRawTransactionBytes", "getNativeUtxoParent",
    "getFtUtxos", "getStablecoinUtxos", "getStablecoinInfo", "broadcast"].map(method => [method, read(method)]));
  value.api = Object.fromEntries(["poolInfo", "ftUtxosByCombineScript", "poolLpUtxosByScriptHash", "nodeInfo", "timelockUtxosByAddress", "txoStatus", "broadcast"].map(method => [method, read(method)]));
  return { value, calls };
}

test("one material scope shares in-flight and completed identical reads, never later scopes", async () => {
  const { value, calls } = client(), scoped = createChainDataReadScope(value);
  const first = scoped.getUtxos("owner"), second = scoped.getUtxos("owner");
  assert.equal(first, second);
  await Promise.all([first, second]);
  await scoped.getUtxos("owner");
  assert.equal(calls.length, 1);
  await createChainDataReadScope(value).getUtxos("owner");
  assert.equal(calls.length, 2);
  assert.equal(scoped.broadcast, value.broadcast);
  assert.equal(scoped.api.broadcast, value.api.broadcast);
});

test('NFT collection index is reused inside one job scope, not across later jobs', async () => {
  const {value,calls}=client();
  value.api.utxosByScriptHash=async (...args)=>{calls.push(args);return{utxos:[]}};
  const scoped=createChainDataReadScope(value),query={scriptpubkeyhash:'ab'.repeat(32)};
  await Promise.all([scoped.api.utxosByScriptHash(query,{category:'asset-index'}),
    scoped.api.utxosByScriptHash({...query},{category:'asset-index'})]);
  assert.equal(calls.length,1);
  await createChainDataReadScope(value).api.utxosByScriptHash(query,{category:'asset-index'});
  assert.equal(calls.length,2);
});

test("omitted optional native-read options share prefetch, distinct limits never do", async () => {
  const { value, calls } = client();
  value.getNativeUtxos = async (...args) => { calls.push(['native', args]); return []; };
  value.getTip = async () => ({ height: '100', hash: '11'.repeat(32) });
  const scoped = createChainDataReadScope(value);
  const prefetch = scoped.getNativeUtxos('owner');
  assert.equal(scoped.getNativeUtxos('owner', undefined), prefetch);
  await Promise.all([prefetch, scoped.getUtxos('owner'), scoped.getNativeUtxos('owner', { limit: 100 }),
    scoped.getNativeUtxos('owner', { limit: 500 })]);
  assert.equal(calls.length, 3);
  await createChainDataReadScope(value).getNativeUtxos('owner');
  assert.equal(calls.length, 4, 'a later preparation observes mutable native UTXOs again');
});

test("account, contract and query scopes stay separate; decode feeds immutable bytes", async () => {
  const { value, calls } = client(), scoped = createChainDataReadScope(value);
  await Promise.all([scoped.getUtxos("a"), scoped.getUtxos("b"), scoped.getRawTransaction("tx"), scoped.getRawTransactionBytes("tx"),
    scoped.getFtUtxos("a", "token1"), scoped.getFtUtxos("a", "token2"),
    scoped.api.poolInfo({ pool_id: "one" }, { category: "pool" }),
    scoped.api.poolInfo({ pool_id: "one" }, { category: "pool" }),
    scoped.api.poolInfo({ pool_id: "two" }, { category: "pool" })]);
  assert.equal(calls.length, 7);
});

test("decoded bytes are shared but raw-only observations never impersonate confirmations", async () => {
  const {value} = client(); let raws=0, decodes=0;
  value.getRawTransactionBytes=async()=>{raws++;return '00'};
  value.getRawTransaction=async()=>{decodes++;return{rawTransaction:'00',confirmations:'12'}};
  const a=createChainDataReadScope(value);
  const [observed,bytes]=await Promise.all([a.getRawTransaction('tx'),a.getRawTransactionBytes('tx')]);
  assert.equal(observed.confirmations,'12');assert.equal(bytes,'00');assert.equal(raws,0);assert.equal(decodes,1);
  const b=createChainDataReadScope(value);await b.getRawTransactionBytes('tx');await b.getRawTransaction('tx');
  assert.equal(raws,1);assert.equal(decodes,2,'Another preparation needs its own confirmation observation');
});

test("a failed observation is shared within the scope and does not poison a later request", async () => {
  const { value } = client();
  let reads = 0;
  value.getUtxos = async () => { if (++reads === 1) throw new Error("Synthetic read failure"); return []; };
  const scoped = createChainDataReadScope(value);
  const results = await Promise.allSettled([scoped.getUtxos("a"), scoped.getUtxos("a")]);
  assert.ok(results.every(r => r.status === "rejected"));
  await assert.rejects(scoped.getUtxos("a"));
  assert.equal(reads, 1);
  assert.deepEqual(await createChainDataReadScope(value).getUtxos("a"), []);
  assert.equal(reads, 2);
});
test("read-only batch output status is shared only inside preparation, never broadcast", async () => {
  const { value, calls } = client(), scoped = createChainDataReadScope(value);
  const query = { txos: [{ txid: '11'.repeat(32), index: 0 }] };
  await Promise.all([scoped.api.txoStatus(query), scoped.api.txoStatus(structuredClone(query))]);
  assert.equal(calls.length, 1);
  await scoped.api.txoStatus({ txos: [{ ...query.txos[0], index: 1 }] });
  assert.equal(calls.length, 2);
  await createChainDataReadScope(value).api.txoStatus(query); assert.equal(calls.length, 3);
  assert.equal(scoped.api.broadcast, value.api.broadcast);
});
test("timelock deposits and tip share reads within one preparation, not across preparations", async () => {
  const { value, calls } = client(), scoped = createChainDataReadScope(value);
  await Promise.all([scoped.api.nodeInfo(), scoped.api.nodeInfo(),
    scoped.api.timelockUtxosByAddress({ address: "a" }), scoped.api.timelockUtxosByAddress({ address: "a" })]);
  assert.equal(calls.length, 2);
  await scoped.api.timelockUtxosByAddress({ address: "b" });
  assert.equal(calls.length, 3);
  const next = createChainDataReadScope(value);
  await Promise.all([next.api.nodeInfo(), next.api.timelockUtxosByAddress({ address: "a" })]);
  assert.equal(calls.length, 5);
});

test("real client shares nested native tip and direct timelock tip only in a bounded read scope", async () => {
  const calls = [];
  const raw = createTestnetClient({ baseUrl: "https://api.tbcdev.org", fetch: async input => {
    const path = new URL(String(input)).pathname; calls.push(path);
    const data = path.endsWith("/nodeinfo") ? { blocks: 830000, bestblockhash: "aa".repeat(32) } : { utxos: [] };
    return new Response(JSON.stringify({ code: 200, data }));
  } });
  const address = "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH";
  for (let n = 1; n <= 2; n++) {
    const scoped = createChainDataReadScope(raw);
    const [native, tip] = await Promise.all([scoped.getUtxos(address),
      scoped.api.nodeInfo({ category: "tip", concurrencyGroup: "timelock-index" })]);
    assert.equal(native.tip.height, tip.blocks);
    assert.equal(calls.filter(p => p.endsWith("/nodeinfo")).length, n);
    assert.equal(calls.filter(p => p.includes("/utxo/address/")).length, n);
    assert.equal(scoped.broadcast, raw.broadcast);
    assert.equal(scoped.preflightBroadcast, raw.preflightBroadcast);
  }
  await raw.getUtxos(address);
  await raw.api.nodeInfo();
  assert.equal(calls.filter(p => p.endsWith("/nodeinfo")).length, 4, "Unscoped reads must stay fresh");
});
