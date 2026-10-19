// Current packaged receipt verifier, read only, never retries funding.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {resolve,join} from 'node:path';
import {verifiedKitCandidate} from '../flutter/scripts/candidate-inputs.mjs';
const root=resolve(import.meta.dirname,'../..'),kit=join(root,'release/kit-contract173-20261014-c/package');
const dir=join(root,'release/contract173-live-20261014-a/funding'),out=resolve(process.argv[2]);
const identity=await verifiedKitCandidate(kit),{verifyTransfer}=createRequire(import.meta.url)(join(kit,'dist/cjs/index.cjs'));
const rows=[];
for(const asset of ['native','token']){
 const start=JSON.parse(await readFile(join(dir,`ios-${asset}173-a.started.json`)));
 const result=JSON.parse(await readFile(join(dir,`ios-${asset}173-a.result.json`)));
 assert.equal(result.status,'returned');assert.equal(result.transactions.length,1);assert.equal(result.transactions[0].status,'submitted');
 const receipt=await verifyTransfer({network:'testnet',baseUrl:'https://devapi.tbcdev.org',allowedOrigins:['https://devapi.tbcdev.org'],
  fetch:(u,o)=>{assert.equal(o?.method??'GET','GET');return fetch(u,{...o,signal:AbortSignal.timeout(20000),redirect:'error'});},
  txid:result.transactions[0].txid,recipient:{address:start.intent.to},
  asset:asset==='native'?{kind:'tbc'}:{kind:'ft',contractId:start.intent.contractId},
  amount:{mode:'exact',atomic:start.intent.amount},minimumConfirmations:'0'});
 assert.equal(receipt.content.status,'matched');
 assert.equal(receipt.policy.status,'satisfied');
 rows.push({asset,intent:start.intent,result,receipt});
}
const report={checkedAt:new Date().toISOString(),kitIdentity:identity,scope:'Funding through existing accepted wallet; current packaged read-only receipt checks. Not new AMM chain acceptance.',rows};
await writeFile(out,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(report));
