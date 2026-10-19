// Public scalar-one Rust vectors -> independent frozen WASM replay. No HTTP.
import {readFile,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {frozenOracle,base,now,account,hash,sha} from './frozen_oracle.mjs';
const bytes=await readFile(process.argv[2]);assert(bytes.toString().includes('test result: ok'));
const rows=bytes.toString().split('\n').filter(l=>l.startsWith('LP_WIRE:')).map(l=>JSON.parse(l.slice(8)));
const inputs=rows.filter(r=>r.definition==='planParams').map(r=>r.value);
const rustBundles=rows.filter(r=>r.definition==='finalizeResult'&&r.value.bundle).map(r=>r.value.bundle);
assert.equal(inputs.length,4);assert.equal(rustBundles.length,4);
const o=await frozenOracle(),cases=[];
for(let n=0;n<inputs.length;n++)for(const alias of [false,true]){
 const p=structuredClone(inputs[n]),kind=p.request.intent.type.slice('tbc20-lp-'.length),name=`lp-multi-${kind}${alias?'-alias':''}`;
 p.request.chainId=account.chainId;if(alias)p.request.intent.type='tbc20Lp.'+kind;
 const expiry=new Date(Date.parse(now)+120000).toISOString();
 delete p.request.constraints.expiresAt;
 Object.assign(p.snapshot.payload,{account,chainId:account.chainId,capturedAt:now,expiresAt:expiry});
 Object.assign(p.policy.payload,{chainId:account.chainId,expiresAt:expiry});
 p.snapshot.snapshotHash=hash(p.snapshot.payload);p.policy.policyHash=hash(p.policy.payload);
 const signed=await o.sign(name,p.request,p.snapshot,p.policy,{captureStages:true});
 assert.deepEqual(signed.result.transactions.map(t=>t.rawTransaction),rustBundles[n].transactions.map(t=>t.rawTransaction),'Rust/WASM signed bytes changed');
 assert.equal(signed.result.totalFee,rustBundles[n].totalFee);
 cases.push({name,method:'tbc_signTransaction',account,now,request:p.request,...signed});
}
const out=join(base,'test/fixtures/lp-staged-signing.json');
await writeFile(out,JSON.stringify({sourceSha256:sha(bytes),wasmSha256:o.wasmSha256,archiveSha256:o.archiveSha256,publicSyntheticScalar:1,networkReads:0,broadcasts:0,cases}),{flag:'wx'});
console.log(JSON.stringify({out,cases:cases.map(c=>({name:c.name,stages:c.audit.stages.length,tasks:c.audit.signatures.length}))}));
