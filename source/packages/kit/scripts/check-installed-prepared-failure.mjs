// Exact installed-package regression: all Ports are synthetic, no HTTP/signing.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
const [consumer,version]=process.argv.slice(2);
assert.ok(consumer&&version&&process.argv.length===4);
const root=join(resolve(consumer),'node_modules/@tbc/kit');
assert.equal(JSON.parse(await readFile(join(root,'package.json'))).version,version);
const {prepareTbcTransaction,prepareTbcWorkflow}=await import(pathToFileURL(join(root,'dist/esm/index.js')));
const {hashCanonical}=await import(pathToFileURL(join(root,'dist/esm/wallet.js')));
const from='1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH';
const intent={version:'1.0',type:'tbc20-standard-transfer',contractId:'11'.repeat(32),to:from,amount:'1'};
let cases=0;
for(const workflow of [false,true])for(const stage of ['chain-data','policy']){
 const counts={reads:0,policies:0,plans:0};
 const failure={portError:{name:'UNAVAILABLE',retryable:true,message:'synthetic-private-detail',details:{secret:'synthetic-secret'}}};
 const request={version:'1.0',chainId:'tbc:testnet',from,...(workflow
  ?{steps:[{id:'send',kind:'transaction',dependsOn:[],intent}]}:{intent})};
 await assert.rejects((workflow?prepareTbcWorkflow:prepareTbcTransaction)({request,network:{
  resolveChainData:async()=>{counts.reads++;return stage==='chain-data'?failure:{payload:{},snapshotHash:hashCanonical({})};},
  resolvePolicy:async()=>{counts.policies++;return failure;},
 },engine:{normalizeRequest:({request})=>({request,requestHash:hashCanonical(request)}),
  plan:()=>{counts.plans++;throw Error('Must not plan after failure');}}}),error=>{
   assert.equal(error.code,'UNAVAILABLE');assert.equal(error.retryable,true);assert.equal(error.stage,stage);
   assert.equal(error.message,`TBC preparation ${stage} failed: UNAVAILABLE`);
   assert.equal(error.cause,undefined);assert.equal(error.details,undefined);
   assert.doesNotMatch(JSON.stringify(error),/synthetic/);return true;
 });
 assert.deepEqual(counts,{reads:1,policies:stage==='policy'?1:0,plans:0});cases++;
}
console.log(JSON.stringify({status:'INSTALLED_PREPARED_FAILURE_PASS',version,cases,http:0,signatures:0,broadcasts:0,automaticRetries:0}));
