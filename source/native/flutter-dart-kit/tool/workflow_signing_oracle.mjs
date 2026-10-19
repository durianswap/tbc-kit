// Offline frozen-Core continuation reference. Explicit public scalars 1/2,
// immutable synthetic inputs only; no HTTP, private wallet or broadcast.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {secp256k1} from '@noble/curves/secp256k1';
import {base,frozenOracle,canonical,hash,sha} from './frozen_oracle.mjs';
async function main(){
 const o=await frozenOracle(),bytes=await readFile(join(base,'test/fixtures/workflow-planning.json'));
 const planning=JSON.parse(bytes),cases=[];
 assert.equal(planning.archiveSha256,o.archiveSha256);
 const reviewed=JSON.parse(await readFile(join(base,'test/fixtures/reviewed-material-b.json'))).cases.find(s=>s.name==='associated-two-dependent');
 for(const s of planning.cases.filter(s=>s.name!=='five-mixed-kinds')){
  const {name,request,context,account,accounts,method,now}=s,ports=[],signed=[],deferred=[];
  const session={version:'1.0',scope:{walletProfile:'dart-partner',sessionId:context.sessionId},state:{version:'1.0',sessionId:context.sessionId,revision:'0',connected:true,activeChainId:account.chainId,activeAccountIds:accounts.map(a=>a.accountId)}};
  const needed=new Set(['tbc_accounts','tbc_signWorkflow']);
  for(const step of request.steps)needed.add(['transaction','preparedTransaction','reviewedTransaction'].includes(step.kind)?'tbc_signTransaction':step.kind==='message'?'tbc_signMessage':'tbc_signTypedData');
  const permissions=[...needed].map(parentCapability=>({id:'grant-'+parentCapability,parentCapability,invoker:context.origin,date:Date.parse(now),caveats:[{type:'restrictChains',value:[account.chainId]},{type:'restrictAccounts',value:accounts.map(a=>a.accountId)},{type:'restrictMethods',value:[parentCapability]}]}));
  const engine=Object.fromEntries(['normalizeRequest','plan','validate','finalize'].map(m=>[m,p=>o.call(m,p)]));
  const navigation={...context,webViewInstanceId:'fixture'};delete navigation.transport;
  const caps=o.kit.createTbcStandardWorkflowCapabilities({navigation,chainId:account.chainId,account,networkSourceIdentity:'reviewed-frozen',
   readCurrentAuthority:async()=>({...account,networkSourceIdentity:'reviewed-frozen'}),materialNative:o.keyless,now:()=>now,
   rawReviewer:{review(){throw Error('Use pinned review')}},associatedReviewer:{review(){throw Error('Use pinned review')}},
   privateNative:{rawSigner:{sign:async()=>({sigs:reviewed.stages.map(v=>v.finalized.sigs)})},associatedExecutor:{execute:async()=>({txraws:reviewed.stages.map(v=>v.finalized.txraw)})},cryptoAdapter:{encrypt(){throw Error('out of scope')},decrypt(){throw Error('out of scope')}}}});
  const core=o.kit.createTwsCore({transactionEngine:engine});let approval;
  let t=await core.start({version:'1.0',release:o.kit.TWS_RELEASE,request:{jsonrpc:'2.0',id:name,method,params:request},currentContext:context,currentSession:session});
  for(let i=0;t.kind!=='complete';i++){
   assert(i<500);if(t.kind==='continue'){t=await core.resume({version:'1.0',checkpoint:t.checkpoint,currentContext:context,currentSession:session});continue;}
   assert.equal(t.kind,'waiting');const call=t.calls[0];ports.push(call.operation);let result;
   switch(call.operation){
    case 'clock.now':result={now};break;
    case 'permissionStore.load':result={revision:'0',permissions};break;
    case 'accounts.resolve':result={accounts};break;
    case 'chainData.resolve':result=call.params.workflowSteps?{version:'1.0',steps:call.params.workflowSteps.map(step=>({stepId:step.stepId,snapshot:s.materials[step.stepId].snapshot}))}:Object.values(s.materials)[0].snapshot;break;
    case 'policy.resolve':{const step=request.steps.find(step=>step.intent&&hash({version:'1.0',chainId:request.chainId,from:request.from,intent:step.intent,...step.constraints?{constraints:step.constraints}:{},...step.signingRoles?{signingRoles:step.signingRoles}:{}})===call.params.requestHash);assert(step);result=s.materials[step.id].policy;break;}
    case 'reviewedTransaction.review':result=s.reviews[request.steps.find(step=>'review-'+step.id===call.params.taskId).id];break;
    case 'approval.request':
     assert.deepEqual(t.checkpoint.payload.memory.workflowPlan,s.plan);assert.deepEqual(call.params.binding,s.binding);
     result=approval={status:'approved',approvalId:'workflow-'+name,approvalToken:'public-fixture-only',bindingHash:s.binding.bindingHash,approvedAt:now,expiresAt:s.binding.payload.expiresAt};break;
    case 'signer.sign':{
     const task=call.params.task,progress=t.checkpoint.payload.memory.workflowProgress;
     const active=progress.steps.find(step=>step.status==='signing');assert(active);
     const resolved=active.resolvedDeferredSigningTasks;
     if(resolved?.length){const source=progress.steps.find(step=>step.stepId===resolved[0].source.stepId);assert.equal(source.status,'completed');deferred.push({stepId:active.stepId,resolved:resolved[0],sourceBundle:source.finalizedBundle??source.reviewedTransactionResult.bundle});}
     const key=task.publicKey===account.publicKey?1n:task.publicKey==='02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5'?2n:null;assert(key);
     const sig=secp256k1.sign(task.digest,key,{prehash:false,lowS:true});
     result={taskId:task.taskId,signatureEncoding:task.signatureEncoding,signature:(task.signatureEncoding==='compact65-recoverable'?(31+sig.recovery).toString(16):'')+sig.toCompactHex()};
     signed.push({stepId:active.stepId,task,result});break;
    }
    case 'reviewedTransaction.execute':result=await caps.reviewedTransaction.execute(call.params,call);break;
    default:throw Error('Unexpected port '+call.operation);
   }
   t=await core.resume({version:'1.0',checkpoint:t.checkpoint,currentContext:context,currentSession:session,response:{version:'1.0',callId:call.callId,result}});
  }
  assert(t.completion.response.result,canonical(t.completion.response));
  assert.equal(ports.filter(p=>p==='approval.request').length,1);
  cases.push({name,approval,signed,deferred,result:t.completion.response.result,ports});
 }
 await writeFile(join(base,'test/fixtures/workflow-signing.json'),JSON.stringify({status:'FROZEN_CORE_WORKFLOW_SIGNING_REFERENCE',archiveSha256:o.archiveSha256,wasmSha256:o.wasmSha256,planningSha256:sha(bytes),cases,chainHttp:0,broadcasts:0,proof:'Frozen Core offline execution with public synthetic signatures; not new Dart workflow execution or device proof.'},null,2)+'\n',{flag:'wx'});
 console.log(JSON.stringify({status:'FROZEN_CORE_WORKFLOW_SIGNING_REFERENCE',cases:cases.length,deferred:cases.reduce((n,s)=>n+s.deferred.length,0),scratch:o.work}));
}
await main().catch(e=>{console.error(e.name+': '+e.message);console.error(String(e.stack).split('\n').slice(-4).join('\n'));process.exitCode=1;});
