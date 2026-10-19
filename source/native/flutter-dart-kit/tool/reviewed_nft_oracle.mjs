// Frozen Rust recognition/policy and wallet-build NFT identities, not a claim
// that the frozen default Reviewed parser already supports all these rows.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {base,frozenOracle,sha,account} from './frozen_oracle.mjs';
const o=await frozenOracle(),bytes=await readFile(join(base,'test/fixtures/nft-signing.json'));
const cases=[];
for(const s of JSON.parse(bytes).cases){
  const snapshot=s.audit.material.snapshot.payload;
  const raw=s.audit.plan.payload.transactions[0].unsignedTransaction;
  assert.equal(s.audit.plan.payload.transactions.length,1);
  const parsed=o.api.parseTbcTransaction(raw),statuses=new Map();
  const parents={};
  for(const p of snapshot.parents){
    parents[p.txid]=p.rawTransaction;
    o.api.parseTbcTransaction(p.rawTransaction).outputs.forEach((out,index)=>
      statuses.set(`${p.txid}:${index}`,{txid:p.txid,index:String(index),value:String(out.satoshis),
        scriptPubKey:Buffer.from(out.scriptPubKey).toString('hex'),spent:false}));
  }
  const selected=parsed.inputs.map(p=>{
    const u=snapshot.utxos.find(u=>u.txid===p.txid&&u.vout===p.vout);assert(u);
    statuses.set(`${p.txid}:${p.vout}`,{txid:p.txid,index:String(p.vout),value:u.satoshis,scriptPubKey:u.scriptPubKey,spent:false});
    return {satoshis:u.satoshis,scriptPubKey:u.scriptPubKey};
  });
  const id=s.request.intent.contractId,mint=parents[id];assert(mint);
  const inspection={phase:'identifyNftOrigin',contractId:id,rawTransaction:mint};
  const identity=JSON.parse(await o.keyless.execute('inspectTokenMaterial',JSON.stringify(inspection)));
  const primary=parsed.inputs.map((p,i)=>({txid:p.txid,vout:p.vout,...selected[i]}));
  const dependencies=primary.filter(u=>u.satoshis==='200').map(u=>{
    const t=statuses.get(`${u.txid}:${u.vout+2}`);assert(t);
    return {txid:t.txid,vout:Number(t.index),satoshis:t.value,scriptPubKey:t.scriptPubKey};
  });
  const policyInput={phase:'checkHistoricalIssuance',transactions:[{rawTransaction:raw}],resolvedOutputs:[...primary,...dependencies]};
  const policyResult=JSON.parse(await o.keyless.execute('inspectTokenMaterial',JSON.stringify(policyInput)));
  const replies=Object.fromEntries(Object.entries(s.replies).filter(([p])=>p.includes('/nft/utxo/')));
  assert.equal(Object.keys(replies).length,1);
  cases.push({name:s.name,account,request:{payload:{format:'raw',transactions:[{rawTransaction:raw,inputs:selected}]}},
    expectedIdentity:{contractId:id,generation:identity.generation,collectionId:o.api.parseTbcTransaction(mint).inputs[0].txid,
      tokenId:String(o.api.parseTbcTransaction(mint).inputs[0].vout)},
    originalEnginePreview:s.audit.preview,inspection,identity,policyInput,policyResult,
    statuses:[...statuses.values()],parents,replies});
}
const report={status:'FROZEN_NFT_ORIGIN_AND_ISSUANCE_ORACLE',archiveSha256:o.archiveSha256,
  provenance:{'nft-signing.json':sha(bytes)},cases,chainHttp:0,broadcasts:0,
  proof:'Ten existing Engine-validated holder transfers, frozen WASM full-origin recognition and exact issuance-policy result. This does not claim complete default Reviewed preview parity; its current NFT missing Tape is independently diagnosed.'};
await writeFile(join(base,'test/fixtures/reviewed-nft.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({cases:cases.length,originAndPolicy:'frozen WASM pass',chainHttp:0}));
