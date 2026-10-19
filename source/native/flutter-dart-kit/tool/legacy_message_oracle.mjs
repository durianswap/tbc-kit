// Immutable current Kit comparator; only public scalar 1 and synthetic inputs.
// No wallet, external API, transport POST or real transaction broadcast.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {secp256k1} from '@noble/curves/secp256k1';
import {verifiedKitCandidate} from '../../flutter/scripts/candidate-inputs.mjs';
import {canonical,hash,sha,account} from './frozen_oracle.mjs';
const base=resolve(import.meta.dirname,'..'),root=join(base,'../../release/kit-contract173-20261014-c');
assert.equal(sha(await readFile(join(root,'tbc-kit-0.1.0-platform-slim.20261014.3.tgz'))),'65441bc8dec3cf659f9ab2d65f722559b52eb68af4ab2b95e04470e3c4acf7fa');
const kitIdentity=await verifiedKitCandidate(join(root,'package'));
const load=p=>import(pathToFileURL(join(root,'package/dist/esm',p)));
const kit=await load('wallet.node.js'),eng=await load('engine.node.js');
const backend=await eng.createWasmTbcEngineBackend(await readFile(join(root,'package/artifacts/wasm/tbc_engine_wasm.wasm')));
const engine=Object.fromEntries(['normalizeRequest','plan','validate','finalize'].map(m=>[m,async p=>{const r=JSON.parse(await backend.call(m,canonical(p)));assert.equal(r.ok,true);return r.result;}]));
const oldPlanning=JSON.parse(await readFile(join(base,'test/fixtures/workflow-planning.json')));
async function drive(source){
 const s=structuredClone(source),{name,method,request,context,now}=s,a=s.account??account;
 const workflow=method==='tbc_signWorkflow';
 const session={version:'1.0',scope:{walletProfile:'dart-partner',sessionId:context.sessionId},state:{version:'1.0',sessionId:context.sessionId,revision:'0',connected:true,activeChainId:a.chainId,activeAccountIds:[a.accountId]}};
 const permissions=['tbc_accounts','tbc_signMessage','tbc_signTypedData','tbc_signTransaction','tbc_signWorkflow'].map(parentCapability=>({id:'grant-'+parentCapability,parentCapability,invoker:context.origin,date:Date.parse(now),caveats:[{type:'restrictChains',value:[a.chainId]},{type:'restrictAccounts',value:[a.accountId]},{type:'restrictMethods',value:[parentCapability]}]}));
 const core=kit.createTwsCore({transactionEngine:engine,legacyBitcoinMessageDigest:input=>kit.digestTbcLegacyBitcoinMessage(input)});
 const ports=[],audit={tasks:[],signatures:[]},signed=[],deferred=[];
 let t=await core.start({version:'1.0',release:kit.TWS_RELEASE,request:{jsonrpc:'2.0',id:name,method,params:request},currentContext:context,currentSession:session});
 for(let i=0;t.kind!=='complete';i++){
  assert(i<150);if(t.kind==='continue'){t=await core.resume({version:'1.0',checkpoint:t.checkpoint,currentContext:context,currentSession:session});continue;}
  assert.equal(t.kind,'waiting');const call=t.calls[0];ports.push(call.operation);let result;
  switch(call.operation){
   case 'clock.now':result={now};break;
   case 'permissionStore.load':result={revision:'0',permissions};break;
   case 'accounts.resolve':result={accounts:[a]};break;
   case 'chainData.resolve':result=call.params.workflowSteps?{version:'1.0',steps:call.params.workflowSteps.map(v=>({stepId:v.stepId,snapshot:s.materials[v.stepId].snapshot}))}:Object.values(s.materials)[0].snapshot;break;
   case 'policy.resolve':result=Object.values(s.materials)[0].policy;break;
   case 'approval.request':
    audit.binding=call.params.binding;audit.preview=call.params.preview;
    audit.plan=t.checkpoint.payload.memory.workflowPlan??null;
    if(!workflow)audit.envelope=t.checkpoint.payload.memory.messageEnvelope;
    s.operationExpiresAt=t.checkpoint.payload.expiresAt;
    result=audit.approval={status:'approved',approvalId:'legacy-'+name,approvalToken:'public-fixture-only',bindingHash:audit.binding.bindingHash,approvedAt:now,expiresAt:audit.binding.payload.expiresAt};break;
   case 'signer.sign':{
    const task=call.params.task;assert.equal(task.publicKey,a.publicKey);
    const sig=secp256k1.sign(task.digest,1n,{prehash:false,lowS:true});
    result={taskId:task.taskId,signatureEncoding:task.signatureEncoding,signature:(task.signatureEncoding==='compact65-recoverable'?(31+sig.recovery).toString(16):'')+sig.toCompactHex()};
    audit.tasks.push(task);audit.signatures.push(result);
    if(workflow){const steps=t.checkpoint.payload.memory.workflowProgress.steps,active=steps.find(v=>v.status==='signing');assert(active);
     signed.push({stepId:active.stepId,task,result});
     if(active.resolvedDeferredSigningTasks?.length){const resolved=active.resolvedDeferredSigningTasks[0],src=steps.find(v=>v.stepId===resolved.source.stepId);assert.equal(src.status,'completed');deferred.push({stepId:active.stepId,resolved,sourceBundle:src.finalizedBundle});}
    }break;
   }
   default:throw Error('Unexpected port '+call.operation);
  }
  t=await core.resume({version:'1.0',checkpoint:t.checkpoint,currentContext:context,currentSession:session,response:{version:'1.0',callId:call.callId,result}});
 }
 assert(t.completion.response.result,canonical(t.completion.response));assert.equal(ports.filter(p=>p==='approval.request').length,1);
 if(workflow)return {...s,plan:audit.plan,binding:audit.binding,preview:audit.preview,expected:{name,approval:audit.approval,signed,deferred,result:t.completion.response.result},ports};
 // Dart's immutable native registration selects the profile, not Core's
 // private marker. Preserve the reference input and explicitly rebind only
 // its removed private client ID. Digests/tasks/signatures/results stay exact.
 const referenceRequest=structuredClone(request);delete request.clientRequestId;
 audit.binding=structuredClone(audit.binding);audit.approval=structuredClone(audit.approval);
 audit.binding.payload.requestHash=hash(request);audit.binding.bindingHash=hash(audit.binding.payload);audit.approval.bindingHash=audit.binding.bindingHash;
 return {...s,account:a,referenceRequest,audit,result:t.completion.response.result,ports};
}
const singles=[],workflows=[];
for(const [name,message] of Object.entries({unicode:{encoding:'utf8',data:'hello 钱包 💰'},binary:{encoding:'hex',data:'00ff'},base64:{encoding:'base64',data:'AP8='},compactSize:{encoding:'utf8',data:'a'.repeat(253)}})){
 const now='2026-10-14T00:00:00.123Z',context={sessionId:'legacy-'+name,navigationId:'document-1',origin:'https://partner.example',topOrigin:'https://partner.example',transport:'webview',frame:'top',createdAt:now};
 const request={version:'1.0',chainId:account.chainId,from:account.address,message,clientRequestId:'legacy-bitcoin:'+kit.digestTbcLegacyBitcoinMessage({version:'1.0',message})};
 singles.push(await drive({name,method:'tbc_signMessage',request,context,now}));
}
for(const name of ['messages-no-chain','native-message'])workflows.push(await drive(oldPlanning.cases.find(s=>s.name===name)));
const report={status:'CURRENT_KIT_LEGACY_MESSAGE_REFERENCE',kitIdentity,singles,workflows,publicSyntheticScalar:1,externalHttp:0,broadcasts:0,proof:'Current frozen Core/WASM + independent Noble ECDSA reference. Not Dart, native custody, installed channel or real-chain proof.'};
const dest=join(base,'test/fixtures/legacy-message-signing.json');
if(process.argv[2]==='--check')assert.deepEqual(JSON.parse(await readFile(dest)),report);
else{assert.equal(process.argv.length,2);await writeFile(dest,JSON.stringify(report,null,2)+'\n',{flag:'wx'});}
console.log(JSON.stringify({status:report.status,singles:singles.length,workflows:workflows.length}));
