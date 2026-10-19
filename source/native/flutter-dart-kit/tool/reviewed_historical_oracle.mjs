// Offline historical holder recognition, from immutable Engine-built fixtures.
// No API, signatures, network or changes to accepted delivery artifacts.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {base,frozenOracle,sha,account} from './frozen_oracle.mjs';
const o=await frozenOracle(),cases=[],provenance={};
for(const file of ['fungible-signing.json','stablecoin-signing.json']){
 const bytes=await readFile(join(base,'test/fixtures',file));provenance[file]=sha(bytes);
 for(const s of JSON.parse(bytes).cases.filter(s=>s.name.startsWith('historical'))){
  const snapshot=s.audit.material.snapshot.payload;
  assert.equal(s.audit.plan.payload.transactions.length,1);
  const raw=s.audit.plan.payload.transactions[0].unsignedTransaction,tx=o.api.parseTbcTransaction(raw),
    rows=tx.inputs.map(p=>{const u=snapshot.utxos.find(u=>u.txid===p.txid&&u.vout===p.vout);assert(u);return u;});
  const all=new Map(rows.map(u=>[`${u.txid}:${u.vout}`,{txid:u.txid,index:String(u.vout),spent:false,value:u.satoshis,scriptPubKey:u.scriptPubKey,height:'1'}]));
  for(const p of snapshot.parents)o.api.parseTbcTransaction(p.rawTransaction).outputs.forEach((v,i)=>all.set(`${p.txid}:${i}`,{txid:p.txid,index:String(i),spent:false,value:String(v.satoshis),scriptPubKey:Buffer.from(v.scriptPubKey).toString('hex'),height:'1'}));
  for(const u of rows)assert.deepEqual({script:all.get(`${u.txid}:${u.vout}`).scriptPubKey,value:all.get(`${u.txid}:${u.vout}`).value},{script:u.scriptPubKey,value:u.satoshis});
  const selected=rows.filter(u=>u.satoshis==='500'&&!u.scriptPubKey.startsWith('76a914'));
  assert(selected.length);
  const pairs=selected.map(u=>({codeScript:u.scriptPubKey,codeSatoshis:500,tapeScript:all.get(`${u.txid}:${u.vout+1}`).scriptPubKey,tapeSatoshis:0}));
  tx.outputs.forEach((v,i)=>{if(v.satoshis===500n&&!Buffer.from(v.scriptPubKey).toString('hex').startsWith('76a914'))pairs.push({codeScript:Buffer.from(v.scriptPubKey).toString('hex'),codeSatoshis:500,tapeScript:Buffer.from(tx.outputs[i+1].scriptPubKey).toString('hex'),tapeSatoshis:0});});
  const identityInput={phase:'identifyPairs',pairs},identities=JSON.parse(await o.keyless.execute('inspectTokenMaterial',JSON.stringify(identityInput)));
  assert(identities.identities.every(i=>i.generation==='historical'&&i.verification==='exact-template'));
  const receipts=[];
  for(const rawTransaction of new Set([raw,...selected.map(u=>snapshot.parents.find(p=>p.txid===u.txid).rawTransaction)])){
   const input={rawTransaction},result=JSON.parse(await o.keyless.execute('inspectTokenReceipt',JSON.stringify(input)));
   receipts.push({input,result});
  }
  const id=s.request.intent.contractId,coin=file.startsWith('stablecoin'),family=coin?'stablecoin':'ft',replies={};
  for(const txid of new Set(selected.map(u=>u.txid)))replies[`/api/tbc/${family}/decode/txid/${txid}`]={txid,contract_id:id,output:selected.filter(u=>u.txid===txid).map(u=>({txid,vout:u.vout})),balance:'999999999999999',decimal:99};
  replies[coin?`/api/tbc/stablecoin/info/stablecoinid/${id}`:`/api/tbc/ft/info/contract/${id}`]={code_script:selected[0].scriptPubKey,...coin?{stablecoin_id:id}:{},symbol:'UNTRUSTED_LABEL_NOT_USED'};
  const request={payload:{format:'raw',transactions:[{rawTransaction:raw,inputs:rows.map(u=>({satoshis:u.satoshis,scriptPubKey:u.scriptPubKey}))}]}};
  const policyInput={phase:'checkHistoricalIssuance',transactions:[{rawTransaction:raw}],resolvedOutputs:[...rows,...selected.map(u=>({txid:u.txid,vout:u.vout+1,satoshis:'0',scriptPubKey:all.get(`${u.txid}:${u.vout+1}`).scriptPubKey}))].map(u=>({txid:u.txid,vout:u.vout,satoshis:u.satoshis,scriptPubKey:u.scriptPubKey}))};
  const policyResult=JSON.parse(await o.keyless.execute('inspectTokenMaterial',JSON.stringify(policyInput)));
  cases.push({name:s.name,source:{file,name:s.name},account,request,intent:s.request.intent,statuses:[...all.values()],replies,identityInput,identities,receipts,policyInput,policyResult});
 }
}
const report={status:'FROZEN_REVIEWED_HISTORICAL_FUNGIBLE_ORACLE',archiveSha256:o.archiveSha256,provenance,cases,networkHttp:0,broadcasts:0};
await writeFile(join(base,'test/fixtures/reviewed-historical-fungible.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({cases:cases.length,identities:cases.map(s=>({name:s.name,identity:s.identities.identities[0],locks:s.receipts[0].result.outputs.map(o=>o.lockTime)}))}));
