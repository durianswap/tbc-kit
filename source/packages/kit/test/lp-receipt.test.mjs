import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {createTransferVerifier,createWasmTbcKeylessEngine,verifyTransfer} from '../dist/esm/index.js';
import {inspectTbcTransaction} from '../dist/esm/api.js';

const fixture=JSON.parse(await readFile(new URL('../../tbc-engine/rust/fixtures/amm-pool-proof.json',import.meta.url)));
const engine=await createWasmTbcKeylessEngine(await readFile(process.env.TBC_LP_RECEIPT_WASM ?? new URL('../artifacts/wasm/tbc_keyless_wasm.wasm',import.meta.url)));
const ADDRESS='1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH';
function vector(label='public-plain'){
  const row=fixture.vectors.find(r=>r.id===`${label}-add`);
  return {raw:row.currentRaw,poolRaw:fixture.raws[row.parentTxid],poolId:row.parentTxid,txid:inspectTbcTransaction(row.currentRaw).txid};
}
function api(v,options={}){
  const trace=[];let rawFailures=options.rawFailures??0;
  const response=data=>new Response(JSON.stringify({code:'200',data}),{headers:{'content-type':'application/json'}});
  const fetch=async(url,init={})=>{
    const u=new URL(String(url));trace.push({origin:u.origin,path:u.pathname,method:init.method??'GET'});
    assert.equal(init.method??'GET','GET');
    if(u.pathname===`/api/tbc/decode/txid/${v.txid}`){
      if(options.missing)return response(null);
      const {transaction}=inspectTbcTransaction(v.raw);
      return response({txid:v.txid,hex:v.raw,...(options.unknown?{}:{confirmations:options.confirmations??'2'}),
        vout:transaction.outputs.map((o,n)=>({n,valueSat:o.satoshis.toString(),scriptPubKey:{hex:Buffer.from(o.scriptPubKey).toString('hex')}}))});
    }
    if(u.pathname===`/api/tbc/txraw/txid/${v.poolId}`){
      // A malformed successful response is not transparently retried by the
      // existing safe-GET transport, so this isolates cache eviction itself.
      if(rawFailures-->0)return response({txraw:'00'});
      return response({txraw:options.wrongRaw??v.poolRaw});
    }
    throw new Error(`Unexpected query: ${u.pathname}`);
  };
  return {fetch,trace};
}
const input=v=>({txid:v.txid,asset:{kind:'lp',contractId:v.poolId},recipient:{address:ADDRESS},minimumConfirmations:'1'});

test('LP public verifier handles four current profiles with bounded reads and immutable origin reuse',async()=>{
  for(const label of ['public-plain','public-locked','controller-plain','controller-locked']){
    const v=vector(label),http=api(v);
    const verifier=createTransferVerifier({network:'testnet',baseUrl:'https://lp.example',fetch:http.fetch,assetInspector:engine});
    const result=await verifier.verify(input(v));
    assert.equal(result.content.status,'matched');assert.equal(result.policy.status,'satisfied');
    assert.equal(result.content.amount.denomination,'atomic');
    assert.equal(result.content.amount.decimals,undefined);assert.equal(result.content.amount.actualDisplay,undefined);
    assert.ok(BigInt(result.content.amount.actualAtomic)>0n);
    assert.ok(result.content.matchedOutputs.every(o=>o.lockTime===(label.endsWith('locked')?829999:0)));
    assert.deepEqual(result.queries,{decode:1,mempool:0,assetMetadata:0,transactionRaw:1,post:0});
    const exact={...input(v),amount:{mode:'exact',atomic:result.content.amount.actualAtomic}};
    const again=await verifier.verify(exact);assert.equal(again.content.status,'matched');assert.equal(again.queries.transactionRaw,0);
    assert.equal(http.trace.length,3);assert.equal(http.trace.filter(r=>r.path.includes('/txraw/')).length,1);
    assert.ok(http.trace.every(r=>r.origin==='https://lp.example'&&r.method==='GET'));
  }
});

test('LP mismatch, confirmation unknown and wrong origin never become payment success',async()=>{
  const v=vector(),http=api(v);
  const verifier=createTransferVerifier({network:'testnet',baseUrl:'https://lp.example',fetch:http.fetch,assetInspector:engine});
  const good=await verifier.verify(input(v));assert.equal(good.content.status,'matched');
  const unknown=api(v,{unknown:true});
  const unconfirmed=await verifyTransfer({network:'testnet',baseUrl:'https://lp.example',fetch:unknown.fetch,assetInspector:engine,...input(v)});
  assert.equal(unconfirmed.content.status,'unavailable');assert.equal(unconfirmed.policy.status,'unavailable');
  assert.equal(unconfirmed.observation.status,'invalid-response');assert.equal(unknown.trace.length,1);
  const amount=await verifier.verify({...input(v),amount:{mode:'exact',atomic:'1'}});
  assert.equal(amount.content.status,'mismatched');assert.ok(amount.content.reasons.includes('AMOUNT_MISMATCH'));
  const owner=await verifier.verify({...input(v),recipient:{address:'1BitcoinEaterAddressDontSendf59kuE'}});
  assert.equal(owner.content.recipient.status,'mismatched');assert.equal(owner.content.asset.status,'matched');
  const invalid=api(v,{wrongRaw:vector('controller-locked').poolRaw});
  const result=await verifyTransfer({network:'testnet',baseUrl:'https://lp.example',fetch:invalid.fetch,assetInspector:engine,...input(v)});
  assert.equal(result.content.status,'unavailable');assert.equal(result.queries.transactionRaw,1);
});

test('LP origins deduplicate in flight, are isolated by network and failed reads are not cached',async()=>{
  const v=vector(),http=api(v,{rawFailures:1});
  const verifier=createTransferVerifier({network:'testnet',fetch:http.fetch,assetInspector:engine});
  assert.equal((await verifier.verify(input(v))).content.status,'unavailable');
  const results=await Promise.all([verifier.verify(input(v)),verifier.verify(input(v))]);
  assert.ok(results.every(r=>r.content.status==='matched'));assert.equal(results.reduce((n,r)=>n+r.queries.transactionRaw,0),1);
  assert.equal(http.trace.filter(r=>r.path.includes('/txraw/')).length,2);
  const main=api(v);const mainResult=await createTransferVerifier({network:'mainnet',fetch:main.fetch,assetInspector:engine}).verify(input(v));
  assert.equal(mainResult.source.chainId,'tbc:mainnet');assert.equal(mainResult.queries.transactionRaw,1);
  assert.ok(main.trace.every(r=>r.origin==='https://api.turingbitchain.io'));
});

test('LP unsupported recipients and missing transactions do not load extra material or inspect',async()=>{
  const v=vector();let inspections=0;const assetInspector={execute(){inspections++;throw new Error('Unexpected inspector');}};
  for(const missing of [true,false]){
    const http=api(v,{missing});const result=await verifyTransfer({network:'testnet',baseUrl:'https://lp.example',fetch:http.fetch,assetInspector,
      ...input(v),recipient:{scriptPubKey:'51'}});
    assert.equal(result.content.status,missing?'unavailable':'unsupported');assert.equal(http.trace.length,1);
    assert.equal(result.queries.transactionRaw,0);
  }
  assert.equal(inspections,0);
});

test('LP rejects malformed inspector identity and duplicate output amounts',async()=>{
  const v=vector();
  for(const mutate of [r=>{r.txid='00'.repeat(32);},r=>{r.outputs.push(r.outputs[0]);},r=>{r.outputs[0].balanceRaw='-1';}]){
    const http=api(v),assetInspector={async execute(op,input){const r=JSON.parse(await engine.execute(op,input));mutate(r);return JSON.stringify(r);}};
    const result=await verifyTransfer({network:'testnet',baseUrl:'https://lp.example',fetch:http.fetch,assetInspector,...input(v)});
    assert.equal(result.content.status,'unavailable');assert.ok(result.content.reasons.includes('ASSET_INSPECTION_FAILED'));
  }
});
