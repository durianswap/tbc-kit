// Freeze public unified AMM continuation vectors from independent WASM.
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import assert from 'node:assert/strict';
import {frozenOracle,base,sha} from './frozen_oracle.mjs';
const bytes=await readFile(join(base,'test/fixtures/amm-dependent-signing.json'));
const source=JSON.parse(bytes),o=await frozenOracle(),cases=[];
const types={'tbc-amm-swap':'amm.swap','tbc-amm-add-liquidity':'amm.addLiquidity','tbc-amm-remove-liquidity':'amm.removeLiquidity'};
for(const s of source.cases){
 const request=structuredClone(s.request);request.intent.type=types[request.intent.type];assert(request.intent.type);
 const name=s.name+'-unified';
 const signed=await o.sign(name,request,s.audit.material.snapshot,s.audit.material.policy,{captureStages:true});
 assert.deepEqual(signed.result.transactions.map(t=>t.rawTransaction),s.result.transactions.map(t=>t.rawTransaction));
 assert.equal(signed.result.totalFee,s.result.totalFee);
 cases.push({...s,name,request,...signed});
}
const out=join(base,'test/fixtures/amm-alias-staged-signing.json');
await writeFile(out,JSON.stringify({sourceSha256:sha(bytes),wasmSha256:o.wasmSha256,archiveSha256:o.archiveSha256,publicSyntheticScalar:1,networkReads:0,broadcasts:0,cases}),{flag:'wx'});
console.log(JSON.stringify({out,cases:cases.length}));
