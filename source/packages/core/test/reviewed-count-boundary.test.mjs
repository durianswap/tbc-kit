import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import * as tws from '../dist/esm/index.js';
import {TWS_RELEASE} from '../dist/esm/release.js';
const fixture=n=>JSON.parse(readFileSync(new URL(`../../../test-vectors/${n}.json`,import.meta.url)));
const integration=fixture('integration'),provider=fixture('provider'),owner=integration.canonicalTransfer.snapshot.payload.account;
function params(method,count){
 const request={payload:{format:'associated',sourceTransaction:'00',sourceInputs:[],children:Array.from({length:count},()=>({inputs:[{outputIndex:0,signingProfile:'p2pkh'}],outputs:[]}))}};
 const common={version:'1.0',chainId:owner.chainId,from:owner.address};
 return method==='tbc_signReviewedTransaction'?{...common,request}:{...common,steps:[{id:'review',kind:'reviewedTransaction',dependsOn:[],request}]};
}
for(const method of ['tbc_signReviewedTransaction','tbc_signWorkflow','tbc_signPreparedWorkflow']){
 test(`${method} rejects 33 total transactions before account, chain, approval or signer work`,async()=>{
  const schema=method==='tbc_signReviewedTransaction'?'signReviewedTransactionRequest':method.includes('Prepared')?'preparedWorkflowRequest':'workflowRequest';
  tws.assertValidTws(schema,params(method,31));
  assert.throws(()=>tws.assertValidTws(schema,params(method,32)),e=>e.code==='TWS_SCHEMA_INVALID');
  const core=tws.createTwsCore();
  const started=await core.start({version:'1.0',release:TWS_RELEASE,
   request:{jsonrpc:'2.0',id:'too-many-reviewed',method,params:params(method,32)},
   currentContext:provider.trustedContexts[0].context,currentSession:provider.providerSessions.sessionA});
  // Core's existing trusted clock bootstrap precedes method validation. Do not
  // remove it or claim zero platform calls; no business port should follow it.
  assert.equal(started.kind,'waiting');assert.equal(started.calls.length,1);assert.equal(started.calls[0].operation,'clock.now');
  let result=await core.resume({version:'1.0',checkpoint:started.checkpoint,
   currentContext:provider.trustedContexts[0].context,currentSession:provider.providerSessions.sessionA,
   response:{version:'1.0',callId:started.calls[0].callId,result:{now:'2026-08-31T12:00:00Z'}}});
  for(let n=0;result.kind==='continue';n++){
   assert.ok(n<5);assert.ok(!result.calls||result.calls.length===0);
   result=await core.resume({version:'1.0',checkpoint:result.checkpoint,
    currentContext:provider.trustedContexts[0].context,currentSession:provider.providerSessions.sessionA});
  }
  assert.equal(result.kind,'complete');assert.equal(result.completion.response.error.code,-32602);
  assert.ok(!result.calls||result.calls.length===0);
 });
}
