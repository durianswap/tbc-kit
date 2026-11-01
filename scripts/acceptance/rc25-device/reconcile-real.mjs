import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {execFileSync as exec} from 'node:child_process';
const root=resolve(import.meta.dirname,'../../..'),out=join(root,'.verify/rc25-real'),evidence=join(root,'docs/acceptance/evidence/rc25-devices');
const json=async p=>JSON.parse(await readFile(p,'utf8'));
const c=await json(join(out,'candidate.json')),installed=join(c.consumer,'node_modules/@tbc/kit');
const tbc=createRequire(join(root,'source/package.json'))('tbc-lib-js');
const {createWasmTbcKeylessEngine}=await import(join(installed,'dist/esm/keyless.js'));
const inspector=await createWasmTbcKeylessEngine(await readFile(join(installed,'artifacts/wasm/tbc_keyless_wasm.wasm')));
const get=async path=>{const r=await fetch(c.api+path,{method:'GET',signal:AbortSignal.timeout(15000)});assert.equal(r.status,200,path);const body=await r.json();assert.equal(String(body.code),'200',path);return body.data;};
const node=await get('/api/tbc/nodeinfo'),cachePath=join(out,'private/chain-cache.json');
const cache=await json(cachePath).catch(e=>{if(e.code==='ENOENT')return {height:node.blocks,transactions:{}};throw e});
assert(node.blocks>=cache.height,'Chain regression: stop, never rebroadcast');
const changed=node.blocks!==cache.height;let queries=0;
async function decoded(id){
 const old=cache.transactions[id];if(old&&(!changed||old.confirmations>=1))return old;
 const d=await get('/api/tbc/decode/txid/'+id);queries++;assert.equal(new tbc.Transaction(d.hex).id,id);
 if(old)assert.equal(d.hex,old.hex,'Original bytes changed');cache.transactions[id]=d;
 await writeFile(cachePath,JSON.stringify(cache),{mode:0o600});return d;
}
const proofs=[];
for(const platform of ['ios','android']){
 const account=(await json(join(out,platform+'-account.json'))).account;
 const collection=(await json(join(out,'private',platform+'-collection-report.json'))).results.at(-1).publicResult.transactions[0];
 const complete=await json(join(out,'private',platform+(platform==='ios'?'-mint11-envelope':'-mint11')+'-report.json'));
 const partial=await json(join(out,'private',platform+'-partial-budget-new-process-report.json'));
 assert.equal(complete.results.at(-1).publicResult.minted,11);assert.equal(partial.results.at(-1).publicResult.minted,10);
 assert.equal(partial.results.at(-1).publicResult.reason,'fee-budget');
 const entries=[{...collection,kind:'collection'},...complete.results.at(-1).publicResult.batches.flatMap(b=>b.transactions).map((t,i)=>({...t,kind:'mint-complete',slot:i+1})),...partial.results.at(-1).publicResult.batches.flatMap(b=>b.transactions).map((t,i)=>({...t,kind:'mint-partial',slot:i+12}))];
 assert.equal(entries.length,22);assert.equal(new Set(entries.map(t=>t.txid)).size,22);
 let db;
 if(platform==='ios'){
  const container=exec('xcrun',['simctl','get_app_container',c.iosUDID,c.iosBundle,'data'],{encoding:'utf8'}).trim();db=join(container,'Library/Application Support/testnet-broadcast.sqlite');
 }else{
  const dir=join(out,'private/android-journal');await mkdir(dir,{recursive:true});
  for(const file of ['testnet-broadcast.sqlite','testnet-broadcast.sqlite-wal','testnet-broadcast.sqlite-shm']){
   try{await writeFile(join(dir,file),exec('/Users/alex/Library/Android/sdk/platform-tools/adb',['-s',c.androidSerial,'exec-out','run-as',c.androidBundle,'cat','files/'+file]),{mode:0o600});}catch(e){if(file.endsWith('.sqlite'))throw e;}
  }db=join(dir,'testnet-broadcast.sqlite');
 }
 const rows=JSON.parse(exec('sqlite3',['-readonly','-json',db,'SELECT i.txid,i.raw_hash,i.state,r.status FROM tbc_kit_broadcast_intents i LEFT JOIN tbc_kit_broadcast_results r USING(idempotency_key);'],{encoding:'utf8'}));
 assert.equal(rows.length,22);assert(rows.every(x=>x.state==='completed'&&['accepted','known'].includes(x.status)));
 await writeFile(join(evidence,platform+'-journal-summary.json'),JSON.stringify(rows,null,2));
 const change=tbc.Script.buildPublicKeyHashOut(account.address).toHex();
 for(const entry of entries){
  const d=await decoded(entry.txid),tx=new tbc.Transaction(d.hex),journal=rows.find(r=>r.txid===entry.txid);assert(journal);
  assert.equal(createHash('sha256').update(Buffer.from(d.hex,'hex')).digest('hex'),journal.raw_hash,'Node raw must match submitted journal');
  let inputValue=0;const inputs=[];
  for(let i=0;i<tx.inputs.length;i++){
   const input=tx.inputs[i],id=input.prevTxId.toString('hex'),parent=new tbc.Transaction((await decoded(id)).hex);
   input.output=parent.outputs[input.outputIndex];assert(input.output);inputValue+=input.output.satoshis;
   assert.equal(tx.verifyScript(i).success,true,'Independent Script VM '+entry.txid+':'+i);
   inputs.push(id+':'+input.outputIndex);
  }
  const fee=inputValue-tx.outputs.reduce((sum,o)=>sum+o.satoshis,0);assert.equal(fee,entry.kind==='collection'?118:80);
  assert.equal(tx.outputs.at(-1).script.toHex(),change,'Change owner');
  let nft;
  if(entry.kind!=='collection'){
   const inspected=JSON.parse(await inspector.execute('inspectNftReceipt',JSON.stringify({rawTransaction:d.hex})));
   assert.equal(inspected.txid,entry.txid);assert.equal(inspected.outputs.length,1);nft=inspected.outputs[0];
   assert.equal(nft.standardId,'tbc721-standard');assert.equal(nft.collectionId,collection.txid);assert.equal(nft.tokenId,String(entry.slot));
   assert.equal(nft.holdScript,change+'6a0d'+Buffer.from('V0 Curr NHold').toString('hex'));
   assert.equal(nft.controller,tbc.Address.fromString(account.address).hashBuffer.toString('hex')+'00');
   assert(inputs.includes(collection.txid+':'+entry.slot),'Exact unused collection slot');
  }else assert.equal(tx.outputs.length,24,'Collection tape + 22 slots + change');
  proofs.push({platform,...entry,feeAtomic:fee,confirmations:d.confirmations,rawHash:journal.raw_hash,rawMatchesJournal:true,scriptVmPass:true,inputOutpoints:inputs,outputCount:tx.outputs.length,...(nft?{nft}:{}),changeAddress:account.address});
 }
}
cache.height=node.blocks;await writeFile(cachePath,JSON.stringify(cache),{mode:0o600});
const result={at:new Date().toISOString(),network:'tbc:testnet',api:c.api,chainHeight:node.blocks,queriesThisRun:queries,transactions:proofs,accepted:proofs.length,confirmed:proofs.filter(t=>t.confirmations>=1).length,pending:proofs.filter(t=>!(t.confirmations>=1)).length,scope:'44 business transactions; funding excluded; no signing or POST',remainingUnmintedSlot:22};
await writeFile(join(evidence,'chain-reconciliation.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify({...result,transactions:undefined}));
