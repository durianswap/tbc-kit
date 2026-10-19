import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'../..');
const bundled=await build({entryPoints:[resolve(root,'packages/kit/src/official-api.ts')],bundle:true,write:false,format:'esm',platform:'node',target:'node22',logLevel:'silent'});
const {createTbcOfficialApi}=await import('data:text/javascript;base64,'+Buffer.from(bundled.outputFiles[0].text).toString('base64'));
let requests=0;
const api=payload=>createTbcOfficialApi({network:'testnet',fetch:async()=>{requests++;return new Response(JSON.stringify(payload));}});
const params={scriptpubkeyhash:'22'.repeat(32)};
const empty=await api({code:200,data:{utxos:null}}).poolLpUtxosByScriptHash(params);
assert.deepEqual(empty.utxos,[]);assert.ok(Object.isFrozen(empty.utxos));assert.equal(requests,1);
await assert.rejects(()=>api({code:500,message:'index unavailable',data:{utxos:null}}).poolLpUtxosByScriptHash(params));
const normal=await api({code:200,data:{utxos:[{txid:'11'.repeat(32),index:4,tbc_balance:'500',lp_balance:'9007199254740993',height:-1}]}}).poolLpUtxosByScriptHash(params);
assert.equal(normal.utxos[0].ft_value,'9007199254740993');assert.equal(normal.utxos[0].height,'0');
await assert.rejects(()=>api({code:200,data:{utxos:[{txid:'11'.repeat(32),index:4,tbc_balance:'500',lp_balance:'12',ft_value:'13'}]}}).poolLpUtxosByScriptHash(params));
// A missing list is not interpreted as proof of an empty balance.
assert.equal((await api({code:200,data:{}}).poolLpUtxosByScriptHash(params)).utxos,undefined);
assert.equal(requests,5);
const paging=await build({entryPoints:[resolve(root,'packages/kit/src/utxo-pages.ts')],bundle:true,write:false,format:'esm',platform:'node',target:'node22',logLevel:'silent'});
const {collectTbcUtxoPages}=await import('data:text/javascript;base64,'+Buffer.from(paging.outputFiles[0].text).toString('base64'));
const urls=[];
const queried=createTbcOfficialApi({network:'testnet',fetch:async url=>{
  urls.push(new URL(url));return new Response(JSON.stringify({code:200,data:{utxos:[],next_cursor:'next /+'}}));
}});
const query={address:'fixture',limit:1000,target:'9007199254740993',after:'page /+'};
const response=await queried.utxosByAddress(query);
assert.equal(urls.length,1);assert.equal(urls[0].searchParams.get('target'),query.target);assert.equal(urls[0].searchParams.get('after'),query.after);
assert.equal(response.next_cursor,'next /+');
for(const invalid of [{limit:0},{limit:1001},{limit:1.5},{target:10},{target:'0'},{target:'1.1'},{after:''}]){
  await assert.rejects(()=>queried.utxosByAddress({address:'fixture',...invalid}));
}
assert.equal(urls.length,1,'invalid query never dispatches');
const row=n=>({txid:'11'.repeat(32),index:String(n),value:'100'});
let pages=0;
const single=await collectTbcUtxoPages(async after=>{assert.equal(after,undefined);pages++;return {utxos:[row(0)]};},{maxRows:128});
assert.equal(single.utxos.length,1);assert.equal(pages,1,'unpaged response must remain one GET');
pages=0;
const complete=await collectTbcUtxoPages(async after=>{pages++;return after===undefined?{utxos:[row(0),row(1)],next_cursor:'a'}:{utxos:[row(1),row(2)]};},{maxRows:128});
assert.deepEqual(complete.utxos.map(r=>r.index),['0','1','2']);assert.equal(pages,2);
for(const read of [async()=>({utxos:[row(0),row(0)]}),async()=>({utxos:[row(0)],next_cursor:42}),async()=>({utxos:[row(0)],next_cursor:'loop'})]){
  await assert.rejects(()=>collectTbcUtxoPages(read,{maxRows:128}));
}
await assert.rejects(()=>collectTbcUtxoPages(async()=>({utxos:[row(0),row(1)]}),{maxRows:1}));
await assert.rejects(()=>collectTbcUtxoPages(async after=>({utxos:[],next_cursor:after===undefined?'a':'b'}),{maxRows:128,maxPages:2}));
console.log(JSON.stringify({status:'API173_PASS',lpChecks:requests,queryDispatches:urls.length,unpagedRequests:1,pagedRequests:2,
  liveHttp:0,broadcasts:0,scope:'null LP, exact target/cursor query, existing row bound, cross-page dedup, same-page duplicate/cycle/bounds reject'}));
