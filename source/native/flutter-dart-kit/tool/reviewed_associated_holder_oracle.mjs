// Public synthetic holder fixtures. Frozen Engine bytes are an independent
// reference for the associated keyless witness assembler, not a chain claim.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {secp256k1} from '@noble/curves/secp256k1';
import {base,frozenOracle,sha,account,publicKey} from './frozen_oracle.mjs';
const o=await frozenOracle(),provenance={},cases=[];
function template(script,signature){
 const bytes=Buffer.from(script),sig=Buffer.from(signature,'hex');let cursor=0,found=[];
 while(cursor<bytes.length){const start=cursor,op=bytes[cursor++];let length;
  if(op<=75)length=op;else if(op<=78){const width=1<<(op-76);assert(cursor+width<=bytes.length);length=bytes.readUIntLE(cursor,width);cursor+=width;}else continue;
  const end=cursor+length;assert(end<=bytes.length);
  if(bytes.subarray(cursor,end).equals(sig))found.push([start,end]);cursor=end;
 }
 assert.equal(found.length,1,'exact one signed push');const[start,end]=found[0];
 return Buffer.concat([bytes.subarray(0,start),Buffer.from('097369676e6174757265','hex'),bytes.subarray(end)]).toString('hex');
}
for(const [file,reviewFile]of [['nft-signing.json','reviewed-nft.json'],['fungible-signing.json','reviewed-historical-fungible.json'],['stablecoin-signing.json','reviewed-historical-fungible.json']]){
 const bytes=await readFile(join(base,'test/fixtures',file)),reviewBytes=await readFile(join(base,'test/fixtures',reviewFile));
 provenance[file]=sha(bytes);provenance[reviewFile]=sha(reviewBytes);
 const rawCases=JSON.parse(reviewBytes).cases;
 for(const s of JSON.parse(bytes).cases.filter(s=>file.startsWith('nft')||s.name.startsWith('historical'))){
  const raw=rawCases.find(r=>r.name===s.name);assert(raw);
  const unsigned=s.audit.plan.payload.transactions[0].unsignedTransaction,parsed=o.api.parseTbcTransaction(unsigned),
   finalRaw=s.result.transactions[0].rawTransaction,final=o.api.parseTbcTransaction(finalRaw),snapshot=s.audit.material.snapshot.payload;
  const sourceInputs=parsed.inputs.map((p,i)=>{
   const u=snapshot.utxos.find(u=>u.txid===p.txid&&u.vout===p.vout);assert(u);
   const base={txid:u.txid,outputIndex:u.vout,satoshis:u.satoshis,scriptPubKey:u.scriptPubKey};
   if(/^76a914[0-9a-f]{40}88ac(?:6a0d56302043757272204e486f6c64)?$/.test(u.scriptPubKey))return {...base,signingProfile:'p2pkh'};
   const task=s.audit.plan.payload.signingTasks.find(t=>t.inputIndex===i),signature=s.audit.signatures.find(t=>t.taskId===task.taskId);
   const der=secp256k1.Signature.fromCompact(signature.signature).toDERHex()+'41';
   return {...base,signingProfile:'contract-template',unlockingScriptTemplate:template(final.inputs[i].scriptSig,der)};
  });
  const request={payload:{format:'associated',sourceTransaction:unsigned,sourceInputs,children:[]}},material=o.kit.normalizeTbcReviewedTransactionMaterial(request);
  const resolvedOutputs=raw.policyInput.resolvedOutputs;
  const stage=JSON.parse(await o.keyless.execute('prepareReviewedStage',JSON.stringify({format:'associated',request:material.request,publicKey,transactionIndex:0,previousTransactions:[],resolvedOutputs})));
  assert(stage.digests);const signatures=stage.digests.map(d=>secp256k1.sign(d,1n,{prehash:false,lowS:true}).toCompactHex());
  const finalized=JSON.parse(await o.keyless.execute('finalizeReviewedStage',JSON.stringify({stage,signatures,signatureEncoding:'compact64'})));
  assert.equal(finalized.txraw,finalRaw,s.name+': Engine/keyless final bytes differ');
  cases.push({name:'associated-'+s.name,source:{file,name:s.name},reviewSource:{file:reviewFile,name:s.name},account,request,material,stage,signatures,finalized,
   expectedDigestTasks:s.audit.plan.payload.signingTasks.map(t=>({inputIndex:t.inputIndex,digest:t.digest})),publicSyntheticScalar:1});
 }
}
const report={status:'FROZEN_ASSOCIATED_HOLDER_ENGINE_KEYLESS_ORACLE',archiveSha256:o.archiveSha256,provenance,cases,
 proof:'Exact frozen wallet Engine and keyless finalized bytes using public signatures. NFT/history review identity and policy come from the prior fixture, not a claim about the frozen default parser.',chainHttp:0,broadcasts:0};
await writeFile(join(base,'test/fixtures/reviewed-associated-holder.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({cases:cases.length,exactEngineKeylessBytes:true,chainHttp:0}));
