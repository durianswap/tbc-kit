// Read actual frozen contract configuration for native review data parity.
// Public synthetic signatures only; no API, private account or broadcast.
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import assert from 'node:assert/strict';
import {base,frozenOracle} from './frozen_oracle.mjs';
const o=await frozenOracle(),s=JSON.parse(await readFile(join(base,'test/fixtures/amm-creation-signing.json'))).cases[0],presets=[];
for(let lpPlan=1;lpPlan<=6;lpPlan++){
 const request=structuredClone(s.request);request.intent.lpPlan=lpPlan;
 const signed=await o.sign('amm-fee-'+lpPlan,request,s.audit.material.snapshot,s.audit.material.policy,{captureStages:true});
 const tx=signed.result.transactions.at(-1);
 const parsed=JSON.parse(await o.keyless.execute('inspectAmmMaterial',JSON.stringify({phase:'inspectPool',pool:{txid:tx.txid,rawTransaction:tx.rawTransaction}})));
 assert.equal(parsed.standardId,'tbc-amm');assert.equal(parsed.lpPlan,lpPlan);
 const quote=await o.kit.quoteTbcAmm({pool:{txid:tx.txid,rawTransaction:tx.rawTransaction},action:{kind:'addTbc',amount:'10000',initialFtAmount:'10000'}},{engine:o.keyless});
 assert.equal(quote.feePolicy.totalFeeBps,parsed.serviceFeeRate);
 presets.push({lpPlan,...quote.feePolicy});
}
await writeFile(join(base,'test/fixtures/amm-fee-review.json'),JSON.stringify({status:'FROZEN_AMM_CONTRACT_FEE_REVIEW_DATA',archiveSha256:o.archiveSha256,wasmSha256:o.wasmSha256,publicScalarOneOnly:true,broadcasts:0,presets},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({status:'PASS',presets}));
