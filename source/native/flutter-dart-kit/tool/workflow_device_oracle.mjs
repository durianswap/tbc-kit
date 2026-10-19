// New loopback-origin reference from the frozen Core/WASM. Public scalar1/2,
// synthetic inputs only; never modifies the earlier immutable workflow oracle.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {secp256k1} from '@noble/curves/secp256k1';
import {base,frozenOracle,canonical,hash,sha} from './frozen_oracle.mjs';
const o=await frozenOracle(),origin='http://127.0.0.1:41874',port=41874,provenance={};
async function load(file){const b=await readFile(join(base,'test/fixtures',file));provenance[file]=sha(b);return JSON.parse(b);}
const planning=await load('workflow-planning.json'),signing=await load('workflow-signing.json');
assert.equal(signing.planningSha256,provenance['workflow-planning.json']);
assert.equal(planning.archiveSha256,o.archiveSha256);
const selected={
 'messages-no-chain':null,
 'native-message':['native-transfers.json','transfer-single'],
 'prepared-typed':['native-transfers.json','transfer-single'],
 'staged-ft-primary':['staged-signing.json','current-ft-staged-transfer'],
 'reviewed-then-message':['reviewed-material-b.json','associated-two-dependent'],
 'controller-message':['amm-controller-signing.json','amm-controller-plain-add'],
 'independent-failure-mode':null,
};
const reviewed=(await load('reviewed-material-b.json')).cases.find(c=>c.name==='associated-two-dependent');
const cases=[];
for(const [sourceName,input]of Object.entries(selected)){
 const s=structuredClone(planning.cases.find(c=>c.name===sourceName));assert(s);
 const {request,account,accounts,method,now}=s;
 const name='workflow-'+sourceName,context={...s.context,origin,topOrigin:origin,sessionId:name};
 for(const step of request.steps)if(step.kind==='typedData')step.data.domain.origin=origin;
 const session={version:'1.0',scope:{walletProfile:'dart-partner',sessionId:name},state:{version:'1.0',sessionId:name,revision:'0',connected:true,activeChainId:account.chainId,activeAccountIds:accounts.map(a=>a.accountId)}};
 const needed=new Set(['tbc_accounts','tbc_signWorkflow']);
 for(const step of request.steps)needed.add(['transaction','preparedTransaction','reviewedTransaction'].includes(step.kind)?'tbc_signTransaction':step.kind==='message'?'tbc_signMessage':'tbc_signTypedData');
 const permissions=[...needed].map(parentCapability=>({id:'grant-'+parentCapability,parentCapability,invoker:origin,date:Date.parse(now),caveats:[{type:'restrictChains',value:[account.chainId]},{type:'restrictAccounts',value:accounts.map(a=>a.accountId)},{type:'restrictMethods',value:[parentCapability]}]}));
 const engine=Object.fromEntries(['normalizeRequest','plan','validate','finalize'].map(m=>[m,p=>o.call(m,p)]));
 const navigation={...context,webViewInstanceId:'fixture'};delete navigation.transport;
 const caps=o.kit.createTbcStandardWorkflowCapabilities({navigation,chainId:account.chainId,account,networkSourceIdentity:'reviewed-frozen',
  readCurrentAuthority:async()=>({...account,networkSourceIdentity:'reviewed-frozen'}),materialNative:o.keyless,now:()=>now,
  rawReviewer:{review(){throw Error('Use pinned review')}},associatedReviewer:{review(){throw Error('Use pinned review')}},
  privateNative:{rawSigner:{sign:async()=>({sigs:reviewed.stages.map(v=>v.finalized.sigs)})},associatedExecutor:{execute:async()=>({txraws:reviewed.stages.map(v=>v.finalized.txraw)})},cryptoAdapter:{encrypt(){throw Error('out of scope')},decrypt(){throw Error('out of scope')}}}});
 const core=o.kit.createTwsCore({transactionEngine:engine}),ports=[],signed=[];let approval,plan;
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
    plan=t.checkpoint.payload.memory.workflowPlan;
    result=approval={status:'approved',approvalId:name,approvalToken:'public-fixture-only',bindingHash:call.params.binding.bindingHash,approvedAt:now,expiresAt:call.params.binding.payload.expiresAt};break;
   case 'signer.sign':{
    const task=call.params.task,active=t.checkpoint.payload.memory.workflowProgress.steps.find(v=>v.status==='signing');assert(active);
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
 const result=t.completion.response.result;assert(result,canonical(t.completion.response));
 assert.equal(ports.filter(p=>p==='approval.request').length,1);
 // Origin changes only typed signatures/authorization commitments, not txs.
 const old=signing.cases.find(c=>c.name===sourceName).result;
 for(const row of result.steps)if(row.result.transactions){const prior=old.steps.find(r=>r.id===row.id).result;assert.deepEqual(row.result.transactions,prior.transactions);assert.equal(row.result.totalFee,prior.totalFee);}
 const source=input?(await load(input[0])).cases.find(c=>c.name===input[1]):{};assert(source);
 const queries=source.statusQueries??(source.reads??[]).filter(r=>r.path==='/api/tbc/txo/status').map(r=>r.body);
 const trace=source.coldTrace??source.trace??Object.keys(source.replies??{});
 cases.push({name,method,request,result,context,account,accounts,approval,plan,signed,
  replies:source.replies??{},statuses:source.statuses??[],statusQueries:queries,
  coldTrace:trace,warmTrace:source.warmTrace??trace,
  source:input?{file:input[0],name:input[1]}:null,
  expectedSignatures:signed.length+(sourceName==='reviewed-then-message'?reviewed.stages.reduce((n,v)=>n+v.signatures.length,0):0),
  expectedControllerSignatures:signed.filter(v=>v.task.publicKey!==account.publicKey).length,
 });
}
const report={status:'FROZEN_WORKFLOW_LOOPBACK_DEVICE_ORACLE',origin,port,archiveSha256:o.archiveSha256,wasmSha256:o.wasmSha256,provenance,cases,chainHttp:0,broadcasts:0,
 proof:'Frozen Core/WASM with public synthetic scalar1/2 signatures at the consumer origin; not new Dart/device evidence. Earlier oracles remain immutable.'};
await writeFile(join(base,'test/fixtures/workflow-device.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({status:report.status,cases:cases.length,origin,sha256:sha(JSON.stringify(report,null,2)+'\n'),scratch:o.work}));
