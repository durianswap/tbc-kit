// Create-only frozen Core/WASM reference, public synthetic keys and in-memory
// port replies. No HTTP, real approval, wallet keys, submit or persistent store.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {secp256k1} from '@noble/curves/secp256k1';
import {base,frozenOracle,canonical,hash,sha} from './frozen_oracle.mjs';
const o=await frozenOracle(),provenance={},cache=new Map(),cases=[];
const device=process.argv.includes('--device'),port=41878,origin=`http://127.0.0.1:${port}`;
async function fixture(file){
 if(!cache.has(file)){const b=await readFile(join(base,'test/fixtures',file+'.json'));provenance[file]=sha(b);cache.set(file,JSON.parse(b));}
 return cache.get(file);
}
async function sample(file,name){return structuredClone((await fixture(file)).cases.find(c=>c.name===name));}
async function drive(file,sourceName,scenario){
 const source=await sample(file,sourceName),workflow=file==='workflow-planning';
 const method=source.method.replace('tbc_sign','tbc_send'),name=`${sourceName}-${scenario}`;
 const material=source.audit?.material,account=source.account??material.snapshot.payload.account;
 const accounts=source.accounts??[account,...material.snapshot.payload.signingAccounts??[]];
 const now=source.now??material.snapshot.payload.capturedAt,context=source.context,request=source.request;
 if(device){
  context.origin=origin;context.topOrigin=origin;
  for(const step of request.steps??[])if(step.kind==='typedData')step.data.domain.origin=origin;
 }
 const session={version:'1.0',scope:{walletProfile:'dart-partner',sessionId:context.sessionId},state:{version:'1.0',sessionId:context.sessionId,revision:'0',connected:true,activeChainId:account.chainId,activeAccountIds:accounts.map(a=>a.accountId)}};
 const methods=new Set(['tbc_accounts',workflow?'tbc_signWorkflow':'tbc_sendTransaction']);
 if(workflow)methods.add('tbc_sendTransaction');
 if(workflow)for(const s of request.steps)methods.add(['transaction','preparedTransaction','reviewedTransaction'].includes(s.kind)?'tbc_signTransaction':s.kind==='message'?'tbc_signMessage':'tbc_signTypedData');
 const permissions=[...methods].map(parentCapability=>({id:'grant-'+parentCapability,parentCapability,invoker:context.origin,date:Date.parse(now),caveats:[{type:'restrictChains',value:[account.chainId]},{type:'restrictAccounts',value:accounts.map(a=>a.accountId)},{type:'restrictMethods',value:[parentCapability]}]}));
 const audit={stages:[],signed:[],validations:[]},ports=[],submissions=[];
 const engine=Object.fromEntries(['normalizeRequest','plan','validate','finalize'].map(m=>[m,async p=>{
  const result=await o.call(m,p);
  if(m==='validate')audit.validations.push(p.phase);
  if(m==='finalize')audit.stages.push({requestHash:p.requestHash,args:p,result});
  return result;
 }]));
 let reviewedCaps;
 if(workflow&&source.reviews){
  const r=(await fixture('reviewed-material-b')).cases.find(s=>s.name==='associated-two-dependent');
  const navigation={...context,webViewInstanceId:'fixture'};delete navigation.transport;
  reviewedCaps=o.kit.createTbcStandardWorkflowCapabilities({navigation,chainId:account.chainId,account,networkSourceIdentity:'reviewed-frozen',readCurrentAuthority:async()=>({...account,networkSourceIdentity:'reviewed-frozen'}),materialNative:o.keyless,now:()=>now,
   rawReviewer:{review(){throw Error('Pinned review only');}},associatedReviewer:{review(){throw Error('Pinned review only');}},
   privateNative:{rawSigner:{sign:async()=>({sigs:r.stages.map(s=>s.finalized.sigs)})},associatedExecutor:{execute:async()=>({txraws:r.stages.map(s=>s.finalized.txraw)})},cryptoAdapter:{encrypt(){throw Error('Not in this fixture');},decrypt(){throw Error('Not in this fixture');}}}});
 }
 const core=o.kit.createTwsCore({transactionEngine:engine});
 let t=await core.start({version:'1.0',release:o.kit.TWS_RELEASE,request:{jsonrpc:'2.0',id:name,method,params:request},currentContext:context,currentSession:session});
 for(let i=0;t.kind!=='complete';i++){
  assert(i<500,'Core did not terminate');
  if(t.kind==='continue'){t=await core.resume({version:'1.0',checkpoint:t.checkpoint,currentContext:context,currentSession:session});continue;}
  assert.equal(t.kind,'waiting');const call=t.calls[0];ports.push(call.operation);let result,error;
  switch(call.operation){
   case 'clock.now':result={now};break;
   case 'permissionStore.load':result={revision:'0',permissions};break;
   case 'accounts.resolve':result={accounts};break;
   case 'chainData.resolve':result=workflow?(call.params.workflowSteps?{version:'1.0',steps:call.params.workflowSteps.map(s=>({stepId:s.stepId,snapshot:source.materials[s.stepId].snapshot}))}:Object.values(source.materials)[0].snapshot):material.snapshot;break;
   case 'policy.resolve':{
    const step=workflow?request.steps.find(s=>s.intent&&hash({version:'1.0',chainId:request.chainId,from:request.from,intent:s.intent,...s.constraints?{constraints:s.constraints}:{},...s.signingRoles?{signingRoles:s.signingRoles}:{}})===call.params.requestHash):null;
    const m=workflow?source.materials[step?.id]:material;assert(m);result=m.policy;break;
   }
   case 'reviewedTransaction.review':result=source.reviews[request.steps.find(s=>'review-'+s.id===call.params.taskId).id];break;
   case 'reviewedTransaction.execute':result=await reviewedCaps.reviewedTransaction.execute(call.params,call);break;
   case 'approval.request':
    audit.plan=t.checkpoint.payload.memory[workflow?'workflowPlan':'executionPlan'];audit.binding=call.params.binding;audit.preview=call.params.preview;
    result=audit.approval={status:'approved',approvalId:'send-'+name,approvalToken:'public-fixture-only',bindingHash:audit.binding.bindingHash,approvedAt:now,expiresAt:audit.binding.payload.expiresAt};break;
   case 'signer.sign':{
    const task=call.params.task,key=task.publicKey===account.publicKey?1n:task.publicKey==='02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5'?2n:null;assert(key);
    const sig=secp256k1.sign(task.digest,key,{prehash:false,lowS:true});
    result={taskId:task.taskId,signatureEncoding:task.signatureEncoding,signature:(task.signatureEncoding==='compact65-recoverable'?(31+sig.recovery).toString(16):'')+sig.toCompactHex()};
    audit.signed.push({task,result});break;
   }
   case 'broadcast.submit':{
    const index=submissions.filter(s=>s.operation==='broadcast.submit').length;
    audit.bundle??=t.checkpoint.payload.memory.finalizedBundle;
    if(scenario==='reject')result={txid:call.params.transaction.txid,status:'rejected',reason:'Synthetic rejection'};
    else if(scenario.startsWith('unknown')&&(index===0||scenario==='unknown-twice'))error={name:'UNAVAILABLE',message:'Synthetic outcome unknown',retryable:true};
    else if(scenario==='fatal')error={name:'UNAUTHORIZED',message:'Synthetic lost grant',retryable:false};
    else result={txid:call.params.transaction.txid,status:'accepted'};
    submissions.push({operation:call.operation,index,...result?{result}:{error}});break;
   }
   case 'broadcast.reconcile':
    result={transactions:call.params.txids.map(txid=>({txid,status:scenario==='unknown-unconfirmed'?'unknown':'confirmed',...scenario==='unknown-unconfirmed'?{}:{confirmations:'1'}}))};
    submissions.push({operation:call.operation,txids:call.params.txids,result});break;
   case 'broadcast.submitBatch':{
    audit.bundle=t.checkpoint.payload.memory.finalizedBundle;audit.workflow=t.checkpoint.payload.memory.workflowResult;
    if(scenario==='unknown')error={name:'UNAVAILABLE',message:'Synthetic batch outcome unknown',retryable:true};
    else if(scenario==='fatal')error={name:'UNAUTHORIZED',message:'Synthetic lost grant',retryable:false};
    else result={transactions:call.params.transactions.map((t,i)=>({txid:t.txid,status:scenario==='reject'||scenario==='parent-reject'&&i===0?'rejected':'accepted'}))};
    submissions.push({operation:call.operation,...result?{result}:{error}});break;
   }
   default:throw Error('Unexpected port '+call.operation);
  }
  t=await core.resume({version:'1.0',checkpoint:t.checkpoint,currentContext:context,currentSession:session,response:{version:'1.0',callId:call.callId,...error?{error}:{result}}});
 }
 assert.equal(ports.filter(p=>p==='approval.request').length,1,canonical({name,ports,response:t.completion.response}));
 assert.equal(audit.binding.payload.method,method);
 const response=t.completion.response;
 assert(response.result||response.error);
 cases.push({name,source:{file,name:sourceName},workflow,scenario,method,request,context,account,accounts,now,
  ...workflow?{materials:source.materials,...source.reviews?{reviews:source.reviews}:{}}:{material},audit,ports,submissions,response});
}
if(device){
 for(const [file,name,readFile,readName] of [
  ['native-signing','merge-two','native-transfers','merge-two'],
  ['amm-dependent-signing','amm-holder-fragmented-sell','amm-dependent-signing','amm-holder-fragmented-sell'],
  ['prepared-signing','current-ft-staged-transfer','staged-signing','current-ft-staged-transfer'],
  ['workflow-planning','ft-typed-ids','fungible-signing','current-transfer-multiple-inputs'],
  ['workflow-planning','prepared-typed','native-transfers','transfer-single'],
 ]){
  await drive(file,name,'accepted');const c=cases.at(-1),reads=await sample(readFile,readName);
  assert(c.response.result,canonical(c.response));
  Object.assign(c,{name:'send-'+name,result:c.response.result,replies:reads.replies,
   coldTrace:reads.coldTrace??reads.trace,warmTrace:reads.warmTrace??reads.trace,
   statusQueries:reads.statusQueries??[],expectedSignatures:c.audit.signed.length,expectedControllerSignatures:0,
   expectedPosts:c.submissions.length});
 }
 const ids=cases.flatMap(c=>c.audit.bundle.transactions.map(t=>t.txid));
 assert.equal(new Set(ids).size,ids.length,'Device cases must not collide in the journal');
 assert.equal(new Set(cases.map(c=>c.method)).size,4);
}else{
for(const scenario of ['accepted','reject','unknown-confirmed','unknown-unconfirmed','fatal'])await drive('native-signing','transfer-single',scenario);
for(const scenario of ['accepted','unknown-confirmed','unknown-twice'])await drive('amm-dependent-signing','amm-holder-fragmented-sell',scenario);
await drive('prepared-signing','current-ft-staged-transfer','accepted');
for(const scenario of ['accepted','unknown','parent-reject','reject','fatal'])await drive('workflow-planning','staged-ft-primary',scenario);
for(const name of ['native-and-ft','prepared-typed','reviewed-then-message'])await drive('workflow-planning',name,'accepted');
}
const report={status:'FROZEN_CORE_SEND_REFERENCE',archiveSha256:o.archiveSha256,wasmSha256:o.wasmSha256,provenance,cases,
 ...device?{port,origin}:{},
 publicSyntheticScalars:[1,2],http:0,broadcasts:0,
 proof:'Actual frozen Core/WASM with synthetic submit/status replies. This is an independent offline semantics reference, not native custody, device, real chain or final delivery acceptance.'};
await writeFile(join(base,'test/fixtures',device?'send-device.json':'send-lifecycle.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({status:report.status,cases:cases.length,scratch:o.work}));
