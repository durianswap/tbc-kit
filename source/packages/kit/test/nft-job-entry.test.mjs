import assert from 'node:assert/strict';
import test from 'node:test';
import {build} from 'esbuild';
import {registerHooks} from 'node:module';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../../',import.meta.url));
const built=await build({stdin:{contents:"export {createTbcClient} from './packages/kit/src/client.ts'",resolveDir:root},bundle:true,write:false,format:'esm',platform:'node',logLevel:'silent'});
const url=new URL('.nft-entry-source.mjs',import.meta.url).href;
const hooks=registerHooks({resolve(s,c,n){return s===url?{url,shortCircuit:true}:n(s,c)},load(s,c,n){return s===url?{source:built.outputFiles[0].text,format:'module',shortCircuit:true}:n(s,c)}});
const {createTbcClient}=await import(url);hooks.deregister();
const items=n=>Array.from({length:n},(_,i)=>({slot:i+1,name:`B${i}`,symbol:'N',description:'',attributes:[]}));
const limits={maxTotalFee:'100000',expiresAt:'2099-01-01T00:00:00Z'};
async function setup(){const calls=[];const provider={async request(r){calls.push(r);return r.method==='tbc_requestAccounts'?['1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH']:{status:'complete'}},on(){},removeListener(){},destroy(){}};return {calls,wallet:await createTbcClient({network:'testnet',provider}).connect()};}
test('all 1/10/33/100/101/300 batchMint sizes use the same bounded job entry',async()=>{
 for(const count of [1,10,33,100,101,300])for(const style of ['limits','constraints']){
  const s=await setup();await s.wallet.tbc721.batchMint({collectionId:'ab'.repeat(32),items:items(count),...(style==='limits'?{limits}:{constraints:{maxFee:limits.maxTotalFee,expiresAt:limits.expiresAt}})});
  assert.equal(s.calls.at(-1).method,'tbc_runNftMintJob');assert.deepEqual(s.calls.at(-1).params.limits,limits);
 }
});
test('missing budgets and unrepresentable exact/fee constraints cannot be silently dropped',async()=>{
 for(const extra of [{},{constraints:{maxFee:'100'}},{constraints:{expiresAt:limits.expiresAt}},{limits,constraints:{}},
  {constraints:{maxFee:'100',expiresAt:limits.expiresAt,inputOutpoints:[{txid:'ab'.repeat(32),vout:1}]}},
  {constraints:{maxFee:'100',expiresAt:limits.expiresAt,feePreference:'slow'}}]){
  const s=await setup();assert.throws(()=>s.wallet.tbc721.batchMint({collectionId:'ab'.repeat(32),items:items(100),...extra}),e=>e.code===-32602);assert.equal(s.calls.length,1);
 }
});
