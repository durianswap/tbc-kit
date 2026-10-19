// Frozen Core, public synthetic signatures and independently checked BIE1
// bytes only. No current Dart/native workflow implementation supplies results.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {secp256k1} from '@noble/curves/secp256k1';
import {base,frozenOracle,canonical,hash,sha} from './frozen_oracle.mjs';
const o=await frozenOracle(),planningBytes=await readFile(join(base,'test/fixtures/workflow-planning.json'));
const cryptoBytes=await readFile(join(base,'test/fixtures/crypto-signing.json'));
assert.equal(sha(cryptoBytes),'9373286892cfd6c82a93d7f5c8637f12015172b261e3463613058cb63a818bc3');
const planning=JSON.parse(planningBytes),crypto=JSON.parse(cryptoBytes).cases,cases=[];
const device=process.argv.includes('--device'),port=41876,origin=`http://127.0.0.1:${port}`;
function source(name){return structuredClone(planning.cases.find(s=>s.name===name));}
function step(id,index,dependsOn=[]){const s=crypto[index],field=s.method==='tbc_encrypt'?'message':'ciphertext';return {id,kind:s.method.slice(4),dependsOn,algorithm:s.request.algorithm,[field]:s.request[field]};}
const pair=source('messages-no-chain');pair.name='crypto-pair';pair.request.steps=[step('encrypt',0),step('decrypt',1,['encrypt'])];
const mixed=source('five-mixed-kinds');mixed.name='mixed-crypto';mixed.request.steps[3]=step('encrypt',0);mixed.request.steps[4]=step('decrypt',1,['encrypt']);
const prepared=source('prepared-typed');prepared.name='prepared-crypto';prepared.request.steps.push(step('encrypt',4),step('decrypt',5,['encrypt']));
const failure=source('messages-no-chain');failure.name='crypto-independent-failure';failure.request.failureMode='continue-independent';failure.request.steps=[step('fails',0),step('blocked',1,['fails']),step('independent',4)];failure.failAt='fails';
for(const s of [pair,mixed,prepared,failure]){
 const {name,request,context,account,accounts,method,now}=s,ports=[],signed=[],cryptoCalls=[],deferred=[];
 context.sessionId='workflow-'+name;
 if(device){context.origin=origin;context.topOrigin=origin;for(const step of request.steps)if(step.kind==='typedData')step.data.domain.origin=origin;}
 const session={version:'1.0',scope:{walletProfile:'dart-partner',sessionId:context.sessionId},state:{version:'1.0',sessionId:context.sessionId,revision:'0',connected:true,activeChainId:account.chainId,activeAccountIds:accounts.map(a=>a.accountId)}};
 const required=new Set(['tbc_accounts','tbc_signWorkflow']);
 for(const step of request.steps)required.add(['transaction','preparedTransaction'].includes(step.kind)?'tbc_signTransaction':step.kind==='message'?'tbc_signMessage':step.kind==='typedData'?'tbc_signTypedData':'tbc_crypto');
 const permissions=[...required].map(parentCapability=>({id:'grant-'+parentCapability,parentCapability,invoker:context.origin,date:Date.parse(now),caveats:[{type:'restrictChains',value:[account.chainId]},{type:'restrictAccounts',value:accounts.map(a=>a.accountId)},{type:'restrictMethods',value:[parentCapability]}]}));
 const engine=Object.fromEntries(['normalizeRequest','plan','validate','finalize'].map(m=>[m,p=>o.call(m,p)]));
 const core=o.kit.createTwsCore({transactionEngine:engine});let approval,plan,binding,preview;
 let t=await core.start({version:'1.0',release:o.kit.TWS_RELEASE,request:{jsonrpc:'2.0',id:name,method,params:request},currentContext:context,currentSession:session});
 for(let i=0;t.kind!=='complete';i++){
  assert(i<500);if(t.kind==='continue'){t=await core.resume({version:'1.0',checkpoint:t.checkpoint,currentContext:context,currentSession:session});continue;}
  assert.equal(t.kind,'waiting');const call=t.calls[0];ports.push(call.operation);let result,error;
  switch(call.operation){
   case 'clock.now':result={now};break;
   case 'permissionStore.load':result={revision:'0',permissions};break;
   case 'accounts.resolve':result={accounts};break;
   case 'chainData.resolve':result=call.params.workflowSteps?{version:'1.0',steps:call.params.workflowSteps.map(step=>({stepId:step.stepId,snapshot:s.materials[step.stepId].snapshot}))}:Object.values(s.materials)[0].snapshot;break;
   case 'policy.resolve':{const step=request.steps.find(step=>step.intent&&hash({version:'1.0',chainId:request.chainId,from:request.from,intent:step.intent,...step.constraints?{constraints:step.constraints}:{},...step.signingRoles?{signingRoles:step.signingRoles}:{}})===call.params.requestHash);assert(step);result=s.materials[step.id].policy;break;}
   case 'approval.request':
    plan=t.checkpoint.payload.memory.workflowPlan;binding=call.params.binding;preview=call.params.preview;
    result=approval={status:'approved',approvalId:'workflow-'+name,approvalToken:'public-fixture-only',bindingHash:binding.bindingHash,approvedAt:now,expiresAt:binding.payload.expiresAt};break;
   case 'signer.sign':{
    const task=call.params.task,progress=t.checkpoint.payload.memory.workflowProgress,active=progress.steps.find(step=>step.status==='signing');assert(active);
    if(active.resolvedDeferredSigningTasks?.length){const resolved=active.resolvedDeferredSigningTasks[0],source=progress.steps.find(step=>step.stepId===resolved.source.stepId);assert.equal(source.status,'completed');deferred.push({stepId:active.stepId,resolved,sourceBundle:source.finalizedBundle});}
    assert.equal(task.publicKey,account.publicKey);const sig=secp256k1.sign(task.digest,1n,{prehash:false,lowS:true});
    result={taskId:task.taskId,signatureEncoding:task.signatureEncoding,signature:(task.signatureEncoding==='compact65-recoverable'?(31+sig.recovery).toString(16):'')+sig.toCompactHex()};signed.push({stepId:active.stepId,task,result});break;
   }
   case 'crypto.execute':{
    const task=call.params.task,stepId=task.taskId.slice(7),field=task.purpose==='encrypt'?'message':'ciphertext';
    const ref=crypto.find(c=>c.method==='tbc_'+task.purpose&&c.account.publicKey===task.publicKey&&canonical(c.request[field])===canonical(task[field]));assert(ref);
    if(stepId===s.failAt){error={name:'UNAVAILABLE',message:'public unavailable fixture',retryable:false};cryptoCalls.push({stepId,task,unavailable:true});}
    else{result={...ref.audit.cryptoResult,taskId:task.taskId};cryptoCalls.push({stepId,task,result});}break;
   }
   default:throw Error('Unexpected port '+call.operation);
  }
  t=await core.resume({version:'1.0',checkpoint:t.checkpoint,currentContext:context,currentSession:session,response:{version:'1.0',callId:call.callId,...error?{error}:{result}}});
 }
 assert(t.completion.response.result,canonical(t.completion.response));assert.equal(ports.filter(p=>p==='approval.request').length,1);
 let deviceInput={};
 if(device){
  const b=await readFile(join(base,'test/fixtures/native-transfers.json')),source=JSON.parse(b).cases.find(c=>c.name==='transfer-single');
  const usesChain=Object.keys(s.materials).length>0;
  deviceInput={replies:usesChain?source.replies:{},statuses:[],statusQueries:[],coldTrace:usesChain?source.trace:[],warmTrace:usesChain?source.trace:[],materialSourceSha256:sha(b),expectedSignatures:signed.length,expectedControllerSignatures:0,expectedCryptoCalls:cryptoCalls.filter(c=>!c.unavailable).length};
 }
 cases.push({...s,...deviceInput,plan,binding,preview,approval,signed,crypto:cryptoCalls,deferred,result:t.completion.response.result,ports});
}
const report={status:'FROZEN_CORE_CRYPTO_WORKFLOW_REFERENCE',archiveSha256:o.archiveSha256,wasmSha256:o.wasmSha256,planningSha256:sha(planningBytes),cryptoSha256:sha(cryptoBytes),cases,chainHttp:0,broadcasts:0,proof:'Frozen Core outputs; public synthetic keys and preverified BIE1 results. Not new native/worker/device acceptance.'};
if(device){report.status='FROZEN_CRYPTO_LOOPBACK_DEVICE_REFERENCE';report.origin=origin;report.port=port;report.cases=[...crypto.filter(s=>s.request.chainId==='tbc:testnet'&&!s.request.expiresAt).map(s=>({...s,name:'crypto-'+s.name,replies:{},statuses:[],statusQueries:[],coldTrace:[],warmTrace:[],expectedSignatures:0,expectedControllerSignatures:0,expectedCryptoCalls:1})),...cases];}
const bytes=JSON.stringify(report,null,2)+'\n';await writeFile(join(base,'test/fixtures',device?'crypto-device.json':'crypto-workflow.json'),bytes,{flag:'wx'});
console.log(JSON.stringify({status:report.status,cases:report.cases.length,sha256:sha(bytes),scratch:o.work}));
