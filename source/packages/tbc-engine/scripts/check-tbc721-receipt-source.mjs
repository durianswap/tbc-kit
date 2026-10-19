#!/usr/bin/env node
// Source-only controlled receipt integration. Never writes delivery artifacts.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {build} from 'esbuild';
const root=fileURLToPath(new URL('../../../',import.meta.url)),rust=join(root,'packages/tbc-engine/rust');
async function main() {
assert.equal(process.argv.length,2);
const compiled=spawnSync('cargo',['build','--offline','--locked','--release','-p','tbc-keyless-wasm','--target','wasm32-unknown-unknown'],{
  cwd:rust,env:{...process.env,RUSTFLAGS:'--cfg getrandom_backend="unsupported"'},encoding:'utf8',timeout:60000,maxBuffer:8*1024*1024});
assert.ok(!compiled.error&&compiled.status===0,'Source-only keyless WASM compile failed');
const bundle=await build({stdin:{contents:`
  export {createWasmTbcKeylessEngine} from './packages/kit/src/keyless.ts';
  export {verifyTransfer} from './packages/kit/src/receipt-verification.ts';
  export {inspectTbcTransaction} from './packages/kit/src/testnet-validation.ts';
  export {createTestnetClient} from './packages/kit/src/testnet-client.ts';
`,resolveDir:root,loader:'ts'},bundle:true,write:false,format:'esm',platform:'node',target:'node22',logLevel:'silent'});
const kit=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].contents).toString('base64'));
const inspector=await kit.createWasmTbcKeylessEngine(readFileSync(join(rust,'target/wasm32-unknown-unknown/release/tbc_keyless_wasm.wasm')));
const f=JSON.parse(readFileSync(join(rust,'fixtures/tbc721-standard-proof.json')));
const mint=kit.inspectTbcTransaction(f.vectors[0].parentRaw);
const collection=mint.transaction.inputs[0].txid,contractId=mint.txid,address='1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH';
let cases=0;
for(const network of ['mainnet','testnet'])for(const v of f.vectors){
  const tx=kit.inspectTbcTransaction(v.signedRaw),trace=[];
  const origin=network==='mainnet'?'https://api.turingbitchain.io':'https://api.tbcdev.org';
  const fetch=async(input,init)=>{
    const url=new URL(input instanceof Request?input.url:String(input));
    assert.equal(url.origin,origin);assert.equal(init?.method??'GET','GET');trace.push(url.pathname);
    let data;
    if(url.pathname===`/api/tbc/decode/txid/${tx.txid}`)data={txid:tx.txid,hex:v.signedRaw,confirmations:'0',
      vout:tx.transaction.outputs.map((o,n)=>({n,valueSat:o.satoshis.toString(),scriptPubKey:{hex:Buffer.from(o.scriptPubKey).toString('hex'),addresses:[]}}))};
    else if(url.pathname===`/api/tbc/nft/nftinfo/nftid/${contractId}`)data={collection_id:collection,collection_index:3,
      nft_contract_id:contractId,nft_holder:address,nft_transfer_count:1};
    else if(url.pathname.startsWith(`/api/tbc/nft/history/address/${address}/nftid/${contractId}/start/0/end/`))data={
      address,collection_id:collection,collection_index:3,nft_contract_id:contractId,history_count:1,
      result:[{txid:tx.txid,sender_address:address,recipient_address:address}]};
    else throw new Error('Unexpected NFT receipt query: '+url.pathname);
    return new Response(JSON.stringify({code:'200',data}),{status:200});
  };
  let inspected=0;
  const result=await kit.verifyTransfer({network,fetch,txid:tx.txid,recipient:{address},asset:{kind:'nft',contractId},minimumConfirmations:'0',
    assetInspector:{execute:async(op,json)=>{inspected++;assert.equal(op,'inspectNftReceipt');const raw=await inspector.execute(op,json);
      const body=JSON.parse(raw);assert.equal(body.outputs.length,1);assert.equal(body.outputs[0].standardId,'tbc721-standard');return raw;}}});
  assert.equal(result.content.status,'matched');assert.equal(result.content.amount.actualAtomic,'1');
  assert.equal(result.policy.status,'satisfied');assert.equal(result.observation.status,'mempool');
  assert.deepEqual(result.queries,{decode:1,mempool:0,assetMetadata:2,transactionRaw:0,post:0});
  assert.equal(trace.length,3);assert.equal(inspected,1);cases++;
}
console.log(`TBC721_RECEIPT_SOURCE_PASS cases=${cases} readsPerCase=3 inspectionsPerCase=1 POST=0 sourceOnly=true`);

// Actual indexer shape: mint rows have no previous sender. Ordinary transfers
// must still provide a valid address; wrong/missing identity is not a mint.
for(const [id,sender,allowed] of [[contractId,'',true],[contractId,address,true],['11'.repeat(32),'',false],[contractId,null,false]]) {
  let calls=0;
  const client=kit.createTestnetClient({baseUrl:'https://api.tbcdev.org',allowedOrigins:['https://api.tbcdev.org'],fetch:async()=>{
    calls++;
    return new Response(JSON.stringify({code:'200',data:{address,nft_contract_id:contractId,history_count:1,
      result:[{txid:id,sender_address:sender,recipient_address:address}]}}),{status:200});
  }});
  if(allowed){const history=await client.getNftHistory(address,contractId,id);
    assert.equal(history.entries[0].sender,sender===''?null:address);
  } else await assert.rejects(client.getNftHistory(address,contractId,id));
  assert.equal(calls,1);
}
console.log('NFT_HISTORY_SOURCE_PASS mint=nullable-sender transfer=strict-address reads=1');
}
main().catch(error=>{
  console.error(`TBC721_RECEIPT_SOURCE_FAIL ${error instanceof Error?error.message:'unknown failure'}`);
  process.exitCode=1;
});
