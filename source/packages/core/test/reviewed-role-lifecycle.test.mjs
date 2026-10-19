// Controlled Core ports only: authority/approval binding, not transaction validity.
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import * as tws from '../dist/esm/index.js';
import {TWS_RELEASE} from '../dist/esm/release.js';
const fixture=n=>JSON.parse(readFileSync(new URL(`../../../test-vectors/${n}.json`,import.meta.url)));
const integration=fixture('integration'),provider=fixture('provider'),baseGrant=fixture('permissions').result[0];
const owner=integration.canonicalTransfer.snapshot.payload.account;
const admin={chainId:owner.chainId,address:'1cMh228HTCiwS8ZsaakH8A8wze1JR5ZsP',accountId:`${owner.chainId}:1cMh228HTCiwS8ZsaakH8A8wze1JR5ZsP`,publicKey:'02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5'};
const roles=[{role:'coin-admin',accountId:admin.accountId}],resolved=[{role:'coin-admin',account:admin}];
const reviewed={payload:{format:'associated',sourceTransaction:'00',sourceInputs:[],children:[{inputs:[{
 outputIndex:0,signingProfile:'tbc20-stablecoin',signingRole:'coin-admin'}],outputs:[]}]}};
function request(method,defaultAccount=false,format='associated'){
 const common={version:'1.0',chainId:owner.chainId,from:owner.address};
  const selection=defaultAccount?{}:{signingRoles:roles};
 const material=format==='associated'?reviewed:{payload:{format:'raw',transactions:[{rawTransaction:'00',inputs:[{satoshis:'500',scriptPubKey:'51',signingRole:'coin-admin'}]}]}};
 return method==='tbc_signReviewedTransaction'?{...common,...selection,request:material}:
  {...common,steps:[{id:'review',kind:'reviewedTransaction',dependsOn:[],...selection,request:material}]};
}
async function drive(method,options={}){
 const accounts=options.defaultAccount?[owner]:[owner,admin];
 const session=structuredClone(provider.providerSessions.sessionA);
 session.state.activeAccountIds=(options.active??accounts).map(a=>a.accountId).sort();
 const permissions=['tbc_accounts','tbc_signTransaction','tbc_signWorkflow'].map(capability=>({...baseGrant,id:`role-${capability}`,parentCapability:capability,
  caveats:baseGrant.caveats.map(c=>c.type==='restrictMethods'?{...c,value:[capability]}:c.type==='restrictAccounts'?{...c,value:(options.granted??accounts).map(a=>a.accountId)}:c)}));
 const value=request(method,options.defaultAccount,options.format),context=provider.trustedContexts[0].context,core=tws.createTwsCore();
 let transition=await core.start({version:'1.0',release:TWS_RELEASE,request:{jsonrpc:'2.0',id:'review-roles',method,params:value},currentContext:context,currentSession:session});
 const calls=[];
 for(let n=0;transition.kind!=='complete';n++){
  assert.ok(n<25);const resume={version:'1.0',checkpoint:transition.checkpoint,currentContext:context,currentSession:session};
  if(transition.kind==='waiting'){
   const call=transition.calls[0];calls.push(call);let result;
   switch(call.operation){
    case 'clock.now':result={now:'2026-08-31T12:00:00Z'};break;
    case 'permissionStore.load':result={revision:'0',permissions};break;
    case 'accounts.resolve':result={accounts:options.accounts??accounts};break;
    case 'reviewedTransaction.review':{
     assert.deepEqual(call.params.signingRoles,options.defaultAccount?[{role:'coin-admin',account:owner}]:resolved);
     const payload={preview:{operationKind:'transaction',assetFlows:[],totalFee:'0',transactionCount:2,warnings:[],irreversible:true,
      signingRoles:structuredClone(call.params.signingRoles)},totalFee:'0',expiresAt:'2026-08-31T12:02:00Z',policyMaterial:{resolvedOutputs:[]}};
     options.review?.(payload);result={payload,reviewHash:tws.hashCanonical(payload)};break;
    }
    case 'approval.request':return {transition,calls,call};
    default:throw Error(`Unexpected port ${call.operation}`);
   }
   resume.response={version:'1.0',callId:call.callId,result};
  }
  transition=await core.resume(resume);
 }
 return {transition,calls};
}
test('Reviewed role wire accepts only current Coin input role and no supplied key',()=>{
 for(const method of ['tbc_signReviewedTransaction','tbc_signWorkflow','tbc_signPreparedWorkflow'])for(const format of ['raw','associated']){
  const schema=method==='tbc_signReviewedTransaction'?'signReviewedTransactionRequest':method.includes('Prepared')?'preparedWorkflowRequest':'workflowRequest';
  tws.assertValidTws(schema,request(method,false,format));
 }
 const raw=request('tbc_signReviewedTransaction',false,'raw').request;
 for(const mutate of [r=>r.payload.transactions[0].inputs[0].signingPublicKey=admin.publicKey,r=>r.payload.transactions[0].inputs[0].signingRole='pool-controller']){
  const bad=structuredClone(raw);mutate(bad);assert.throws(()=>tws.assertValidTws('reviewedTransactionRequest',bad));
 }
 for(const mutate of [r=>r.payload.children[0].inputs[0].signingProfile='p2pkh',r=>r.payload.children[0].inputs[0].signingPublicKey=admin.publicKey]){
  const bad=structuredClone(reviewed);mutate(bad);assert.throws(()=>tws.assertValidTws('reviewedTransactionRequest',bad));
 }
});
test('standalone and both workflows resolve roles once and bind the exact approval task',async()=>{
 for(const method of ['tbc_signReviewedTransaction','tbc_signWorkflow','tbc_signPreparedWorkflow'])for(const defaultAccount of [false,true])for(const format of ['raw','associated']){
  const r=await drive(method,{defaultAccount,format}),expected=defaultAccount?[{role:'coin-admin',account:owner}]:resolved;
  assert.equal(r.call.operation,'approval.request');
  assert.equal(r.calls.filter(c=>c.operation==='accounts.resolve').length,1);
  assert.deepEqual(r.calls.find(c=>c.operation==='accounts.resolve').params.accountIds,(defaultAccount?[owner]:[owner,admin]).map(a=>a.accountId));
  const memory=r.transition.checkpoint.payload.memory;
  const task=method==='tbc_signReviewedTransaction'?memory.walletActionPlan.payload.task:memory.workflowPlan.payload.reviewedTransactionTasks[0];
  assert.deepEqual(task.signingRoles,expected);
  const preview=method==='tbc_signReviewedTransaction'?memory.walletActionPlan.payload.preview:memory.workflowPlan.payload.preview.steps[0].reviewedTransactionPreview;
  assert.deepEqual(preview.signingRoles,expected);
  if(method!=='tbc_signReviewedTransaction')assert.deepEqual(memory.workflowPlan.payload.preview.signingRoles,
   expected.map(role=>({stepId:'review',...role})));
  assert.ok(!r.calls.some(c=>['chainData.resolve','signer.sign','broadcast.submit','reviewedTransaction.execute'].includes(c.operation)));
 }
});
test('missing grant/session stops before reads; missing/ambiguous account and forged preview reject',async()=>{
 for(const method of ['tbc_signReviewedTransaction','tbc_signWorkflow','tbc_signPreparedWorkflow'])for(const format of ['raw','associated']){
  for(const options of [{granted:[owner]},{active:[owner]}]){
   const r=await drive(method,{...options,format});assert.equal(r.transition.completion.response.error.code,4100);
   assert.ok(r.calls.every(c=>['clock.now','permissionStore.load'].includes(c.operation)));
  }
  for(const options of [{accounts:[owner]},{accounts:[owner,admin,admin]},
   {review:p=>delete p.preview.signingRoles},{review:p=>p.preview.signingRoles=[{role:'coin-admin',account:owner}]}]){
   await assert.rejects(drive(method,{...options,format}));
  }
 }
});
