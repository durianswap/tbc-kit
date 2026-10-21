import assert from 'node:assert/strict';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
const compiled=await build({entryPoints:[fileURLToPath(new URL('../src/fungible-business-route.ts',import.meta.url))],bundle:true,write:false,platform:'browser',format:'esm'});
const {resolveFungibleBusinessIntent:resolve}=await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
const ID='11'.repeat(32),TO='1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH';
const material={codeScript:'51',codeSatoshis:500,tapeScript:'006a',tapeSatoshis:0};
function identity(family='tbc20',current=true){return {family,generation:current?'current':'historical',
 protocol:family==='tbc20'?(current?'tbc20-standard':'legacy-ft'):(current?'tbc20-stablecoin':'legacy-stablecoin'),
 ...(current?{standardId:family==='tbc20'?'tbc20-standard':'tbc20-stablecoin'}:{}),protocolVersion:current?1:4,
 codeIdentity:'22'.repeat(32)+'a30b',balanceRaw:'10',verification:'exact-template',assetIdentityVerified:false};}
function engine(rows){let calls=0;return {get calls(){return calls;},async execute(op,json){calls++;assert.equal(op,'inspectTokenMaterial');assert.equal(JSON.parse(json).phase,'identifyPairs');return JSON.stringify({identities:rows});}};}
test('same operation routes current and supported historical templates without changing semantic fields',async()=>{
 for(const family of ['tbc20','tbc20Stablecoin'])for(const current of [false,true]){
  const e=engine([identity(family,current)]),prefix=current?(family==='tbc20'?'tbc20-standard-':'tbc20-stablecoin-'):(family==='tbc20'?'tbc.ft.':'tbc.stablecoin.');
  const input={family,contractId:ID,operation:'transfer',to:TO,amount:'25'};
  const result=await resolve(input,[material],{engine:e});assert.deepEqual(result.intent,{type:prefix+'transfer',version:'1.0',contractId:ID,to:TO,amount:'25'});
  assert.equal(result.recognition.assetIdentityVerified,false);assert.ok(Object.isFrozen(result.intent));assert.equal(e.calls,1);
  const merge=await resolve({family,contractId:ID,operation:'merge'},[material],{engine:e});assert.deepEqual(merge.intent,{type:prefix+'merge',version:'1.0',contractId:ID});assert.equal(e.calls,2);
  assert.deepEqual(input,{family,contractId:ID,operation:'transfer',to:TO,amount:'25'});
 }
});
test('unknown, wrong family, conflicting identity and recognized unsupported version never select a fallback',async()=>{
 const old=identity('tbc20',false);
 for(const rows of [[null],[identity('tbc20Stablecoin')],[{...old,protocolVersion:3}],[identity(),{...identity(),codeIdentity:'33'.repeat(32)+'a30b'}]]){
  const e=engine(rows);await assert.rejects(resolve({family:'tbc20',contractId:ID,operation:'merge'},rows.map((_,i)=>({...material,codeScript:i===0?'51':'52'})),{engine:e}));assert.equal(e.calls,1);
 }
});
test('payment and multiple receivers retain meanings or fail explicitly, never drop fields',async()=>{
 const common={family:'tbc20Stablecoin',contractId:ID,operation:'transfer',receivers:[{to:TO,amount:'25'}],payment:{to:TO,amount:'100'}};
 const old=await resolve(common,[material],{engine:engine([identity('tbc20Stablecoin',false)])});assert.equal(old.intent.attachedTbcAmount,'100');assert.equal(old.intent.amount,'25');
 const current=await resolve(common,[material],{engine:engine([identity('tbc20Stablecoin')])});assert.deepEqual(current.intent.receivers,common.receivers);assert.deepEqual(current.intent.payment,common.payment);
 for(const input of [{...common,receivers:[...common.receivers,...common.receivers]}, {...common,payment:{to:'different',amount:'100'}}]){
  await assert.rejects(resolve(input,[material],{engine:engine([identity('tbc20Stablecoin',false)])}));
 }
 const tbc20=await resolve({...common,family:'tbc20'},[material],{engine:engine([identity()])});
 assert.deepEqual(tbc20.intent.payment,common.payment);
 const five=Array.from({length:5},(_,i)=>({to:TO,amount:String(i+1)}));
 const ft=await resolve({family:'tbc20',contractId:ID,operation:'transfer',receivers:five},[material],{engine:engine([identity('tbc20',false)])});
 assert.equal(ft.intent.type,'tbc.ft.transfer');assert.deepEqual(ft.intent.receivers,five);
 await assert.rejects(resolve({family:'tbc20',contractId:ID,operation:'transfer',receivers:[...five,five[0]]},[material],{engine:engine([identity('tbc20',false)])}),/five|5/);
 await assert.rejects(resolve({...common,receivers:Array(8).fill(common.receivers[0])},[material],{engine:engine([identity('tbc20Stablecoin')])}),/bound/);
});
test('route snapshots the business input before async recognition and rejects issuance',async()=>{
 let finish;const wait=new Promise(r=>{finish=r;});const input={family:'tbc20',contractId:ID,operation:'transfer',receivers:[{to:TO,amount:'25'}]};
 const pending=resolve(input,[material],{engine:{async execute(){await wait;return JSON.stringify({identities:[identity()]});}}});
 input.receivers[0].amount='999';input.contractId='44'.repeat(32);finish();const result=await pending;
 assert.equal(result.intent.contractId,ID);assert.equal(result.intent.receivers[0].amount,'25');
 for(const operation of ['create','mint']){const e=engine([identity()]);await assert.rejects(resolve({family:'tbc20',contractId:ID,operation},[material],{engine:e}));assert.equal(e.calls,0);}
});
