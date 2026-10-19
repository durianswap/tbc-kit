// Validate the actual archive's public validator and Core, not source aliases.
import assert from 'node:assert/strict';
import {readFile,mkdtemp,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {loadHolderInstalledHarness} from './lib/holder-installed-harness.mjs';
const [consumer,archive,expectedSha]=process.argv.slice(2);
const {kit,evidence}=await loadHolderInstalledHarness({consumer,archive,expectedSha,expectedVersion:'0.1.0-candidate.221'});
globalThis.fetch=()=>{throw Error('No external HTTP permitted in boundary acceptance');};
const root=resolve(import.meta.dirname,'../../..'),sha=b=>createHash('sha256').update(b).digest('hex');
const fixtureHashes={};
async function fixture(name){const p=`test-vectors/${name}.json`,bytes=await readFile(join(root,p));fixtureHashes[p]=sha(bytes);return JSON.parse(bytes);}
const integration=await fixture('integration'),provider=await fixture('provider'),owner=integration.canonicalTransfer.snapshot.payload.account;
const schemas={tbc_signReviewedTransaction:'signReviewedTransactionRequest',tbc_signWorkflow:'workflowRequest',tbc_signPreparedWorkflow:'preparedWorkflowRequest'};
function params(method,format,count){
 const payload=format==='associated'?{format,sourceTransaction:'00',sourceInputs:[],children:Array.from({length:count},()=>({inputs:[{outputIndex:0,signingProfile:'p2pkh'}],outputs:[]}))}:
  {format,transactions:Array.from({length:count},()=>({rawTransaction:'00',inputs:[{satoshis:'1',scriptPubKey:'51'}]}))};
 const request={payload},common={version:'1.0',chainId:owner.chainId,from:owner.address};
 return method==='tbc_signReviewedTransaction'?{...common,request}:{...common,steps:[{id:'review',kind:'reviewedTransaction',dependsOn:[],request}]};
}
const rows=[];let coreRejects=0,clockCalls=0;
for(const [method,schema]of Object.entries(schemas)){
 for(const format of ['associated','raw'])for(const count of [0,1,30,31,32,33]){
  const expected=format==='associated'?count<=31:count>=1&&count<=32;
  if(expected)kit.assertValidTws(schema,params(method,format,count));
  else assert.throws(()=>kit.assertValidTws(schema,params(method,format,count)),e=>e.code==='TWS_SCHEMA_INVALID');
  rows.push({method,format,count,accepted:expected});
 }
 const core=kit.createTwsCore(),currentContext=provider.trustedContexts[0].context,currentSession=provider.providerSessions.sessionA;
 let result=await core.start({version:'1.0',release:kit.TWS_RELEASE,currentContext,currentSession,
  request:{jsonrpc:'2.0',id:'invalid-associated-count',method,params:params(method,'associated',32)}});
 assert.equal(result.kind,'waiting');assert.equal(result.calls.length,1);assert.equal(result.calls[0].operation,'clock.now');clockCalls++;
 result=await core.resume({version:'1.0',checkpoint:result.checkpoint,currentContext,currentSession,
  response:{version:'1.0',callId:result.calls[0].callId,result:{now:'2026-08-31T12:00:00Z'}}});
 for(let n=0;result.kind==='continue';n++){
  assert.ok(n<5);assert.ok(!result.calls||result.calls.length===0);
  result=await core.resume({version:'1.0',checkpoint:result.checkpoint,currentContext,currentSession});
 }
 assert.equal(result.kind,'complete');assert.equal(result.completion.response.error.code,-32602);
 assert.ok(!result.calls||result.calls.length===0);coreRejects++;
}
const directory=await mkdtemp(join(tmpdir(),'tbc-reviewed-count-installed-'));
const report={status:'PASS_INSTALLED_COUNT_BOUNDARY',...evidence,fixtureHashes,scriptSha256:sha(await readFile(new URL(import.meta.url))),
 rows,coreRejects,clockCalls,businessPortCalls:0,httpRequests:0,approvals:0,signatures:0,broadcasts:0,
 note:'Schema acceptance is not transaction validity. This test proves early count rejection, not a 32-transaction chain lifecycle.'};
await writeFile(join(directory,'report.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({directory,status:report.status,schemaCases:rows.length,coreRejects,clockCalls,businessPortCalls:0}));
