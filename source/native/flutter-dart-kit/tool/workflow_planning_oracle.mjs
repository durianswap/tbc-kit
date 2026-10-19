// Frozen Core/WASM planning oracle only. No approval, private signer or HTTP.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {base,frozenOracle,account,canonical,hash,sha} from './frozen_oracle.mjs';
const o=await frozenOracle(),now='2026-10-13T00:00:00.123Z',expiresAt='2026-10-13T00:02:00.123Z';
const provenance={},sources={};
async function source(file,name){
 if(!sources[file]){const bytes=await readFile(join(base,'test/fixtures',file));provenance[file]=sha(bytes);sources[file]=JSON.parse(bytes).cases;}
 const s=structuredClone(sources[file].find(s=>s.name===name));assert(s,name);return s;
}
function material(s){const m=structuredClone(s.audit.material);
 m.snapshot.payload.capturedAt=now;m.snapshot.payload.expiresAt=expiresAt;m.snapshot.snapshotHash=hash(m.snapshot.payload);
 m.policy.payload.expiresAt=expiresAt;m.policy.policyHash=hash(m.policy.payload);return {snapshot:m.snapshot,policy:m.policy};}
const prepared=await import(pathToFileURL(join(o.work,'package/dist/esm/prepared.js')));
const engine=Object.fromEntries(['normalizeRequest','plan','validate','finalize'].map(m=>[m,p=>o.call(m,p)]));
async function tx(file,name,id,kind='transaction'){
 const s=await source(file,name),m=material(s),r=structuredClone(s.request);
 if(r.constraints?.expiresAt)r.constraints.expiresAt=expiresAt;
 const p=kind==='preparedTransaction'?await prepared.prepareTbcTransaction({request:r,engine,network:{resolveChainData:async()=>m.snapshot,resolvePolicy:async()=>m.policy}}):r;
 return {step:{id,kind,dependsOn:[],intent:r.intent,...r.constraints?{constraints:r.constraints}:{},...r.signingRoles?{signingRoles:r.signingRoles}:{},...p.proposal?{proposal:p.proposal}:{}},material:m};
}
const message=(id,sourceId,encoding='utf8')=>({id,kind:'message',dependsOn:sourceId?[sourceId]:[],message:{encoding,data:sourceId?'{"purpose":"settlement","txids":[]}':encoding==='base64'?'aGVsbG8=':'hello'},...sourceId?{bindings:[{target:'txids',source:{stepId:sourceId,output:'transactionIds'}}]}:{}});
const typed=(id,sourceId,output='primaryTransactionId')=>({id,kind:'typedData',dependsOn:sourceId?[sourceId]:[],data:{domain:{name:'Workflow',chainId:account.chainId,origin:'https://partner.example'},types:{Receipt:[{name:'tx',type:output==='transactionIds'?'bytes32[]':'bytes32'}]},primaryType:'Receipt',message:{tx:sourceId?{$tbcBinding:'unresolved'}:'11'.repeat(32)}},bindings:sourceId?[{target:'/message/tx',source:{stepId:sourceId,output}}]:[]});
const crypto=id=>({id,kind:'encrypt',dependsOn:[],algorithm:'tbc-bie1-secp256k1-aes128-cbc-hmac-sha256-v1',message:{encoding:'utf8',data:'public-fixture'}});
const cases=[],invalid=[];
async function drive(name,steps,materials={},reviews={},options={}){
 const method=options.method??'tbc_signWorkflow';
 const request={version:'1.0',chainId:account.chainId,from:account.address,expiresAt,maxTotalFee:'100000000',steps,...options.request};
 const context={sessionId:'workflow-'+name,navigationId:'document-1',origin:'https://partner.example',topOrigin:'https://partner.example',transport:'webview',frame:'top',createdAt:now};
 const accounts=[account,...Object.values(materials).flatMap(m=>m.snapshot.payload.signingAccounts??[])].filter((a,i,all)=>all.findIndex(v=>v.accountId===a.accountId)===i);
 const session={version:'1.0',scope:{walletProfile:'dart-partner',sessionId:context.sessionId},state:{version:'1.0',sessionId:context.sessionId,revision:'0',connected:true,activeChainId:account.chainId,activeAccountIds:accounts.map(a=>a.accountId)}};
 // Frozen Core requires both the batch permission and each included operation
 // permission. This is fixture authorization, not a production permission bypass.
 const required=new Set(['tbc_accounts','tbc_signWorkflow']);
 for(const s of steps)required.add(['transaction','preparedTransaction','reviewedTransaction'].includes(s.kind)?'tbc_signTransaction':s.kind==='message'?'tbc_signMessage':s.kind==='typedData'?'tbc_signTypedData':'tbc_crypto');
 const permissions=[...required].map(parentCapability=>({id:'grant-'+parentCapability,parentCapability,invoker:context.origin,date:Date.parse(now),caveats:[{type:'restrictChains',value:[account.chainId]},{type:'restrictAccounts',value:accounts.map(a=>a.accountId)},{type:'restrictMethods',value:[parentCapability]}]}));
 const core=o.kit.createTwsCore({transactionEngine:engine}),ports=[];
 let t=await core.start({version:'1.0',release:o.kit.TWS_RELEASE,request:{jsonrpc:'2.0',id:name,method,params:request},currentContext:context,currentSession:session});
 for(let i=0;t.kind!=='complete';i++){
  assert(i<200);if(t.kind==='continue'){t=await core.resume({version:'1.0',checkpoint:t.checkpoint,currentContext:context,currentSession:session});continue;}
  assert.equal(t.kind,'waiting');const call=t.calls[0];ports.push(call.operation);let result;
  switch(call.operation){
   case 'clock.now':result={now};break;
   case 'permissionStore.load':result={revision:'0',permissions};break;
   case 'accounts.resolve':result={accounts};break;
   case 'chainData.resolve':result=call.params.workflowSteps?{version:'1.0',steps:call.params.workflowSteps.map(s=>({stepId:s.stepId,snapshot:materials[s.stepId].snapshot}))}:Object.values(materials)[0].snapshot;break;
   case 'policy.resolve':{const step=steps.find(s=>s.intent&&hash({version:'1.0',chainId:request.chainId,from:request.from,intent:s.intent,...s.constraints?{constraints:s.constraints}:{},...s.signingRoles?{signingRoles:s.signingRoles}:{}})===call.params.requestHash);assert(step);result=materials[step.id].policy;break;}
   case 'reviewedTransaction.review':result=reviews[steps.find(s=>'review-'+s.id===call.params.taskId).id];break;
   case 'approval.request':return {name,method,request,context,account,accounts,now,operationExpiresAt:t.checkpoint.payload.expiresAt,materials,reviews,plan:t.checkpoint.payload.memory.workflowPlan,binding:call.params.binding,preview:call.params.preview,ports};
   default:throw Error('Unexpected port '+call.operation);
  }
  t=await core.resume({version:'1.0',checkpoint:t.checkpoint,currentContext:context,currentSession:session,response:{version:'1.0',callId:call.callId,result}});
 }
 return {name,method,request,context,account,accounts,now,materials,reviews,error:t.completion.response.error,ports};
}
async function accept(name,steps,materials={},reviews={},options={}){const c=await drive(name,steps,materials,reviews,options);assert(c.plan,canonical(c.error));cases.push(c);return c;}
const n=await tx('native-signing.json','transfer-single','payment'),f=await tx('fungible-signing.json','current-transfer-multiple-inputs','token'),staged=await tx('staged-signing.json','current-ft-staged-transfer','staged');
await accept('messages-no-chain',[message('hello'),message('base64',null,'base64'),typed('typed')]);
await accept('native-message',[n.step,message('receipt','payment')],{payment:n.material});
await accept('ft-typed-ids',[f.step,typed('receipt','token','transactionIds')],{token:f.material});
await accept('staged-ft-primary',[staged.step,typed('receipt','staged')],{staged:staged.material});
await accept('five-mixed-kinds',[n.step,message('receipt','payment'),typed('typed','payment'),crypto('encrypt'),{id:'decrypt',kind:'decrypt',dependsOn:['encrypt'],algorithm:crypto('x').algorithm,ciphertext:Buffer.alloc(85,9).toString('base64')}],{payment:n.material});
await accept('independent-failure-mode',[message('one'),{...message('two'),dependsOn:['one']},message('three')],{},{},{request:{failureMode:'continue-independent'}});
const reviewSample=await source('reviewed-signing.json','associated-two-dependent'),review=structuredClone(reviewSample.audit.plan.payload.review);review.payload.expiresAt=expiresAt;review.reviewHash=hash(review.payload);
await accept('reviewed-then-message',[{id:'review',kind:'reviewedTransaction',dependsOn:[],request:reviewSample.request.request},message('receipt','review')],{},{review});
const p=await tx('native-signing.json','transfer-single','prepared','preparedTransaction');
await accept('prepared-typed',[p.step,typed('receipt','prepared')],{prepared:p.material},{},{method:'tbc_signPreparedWorkflow'});
const controller=await tx('amm-controller-signing.json','amm-controller-plain-add','pool');
await accept('controller-message',[controller.step,message('receipt','pool')],{pool:controller.material});
await accept('native-and-ft',[n.step,f.step,message('receipt','payment')],{payment:n.material,token:f.material});
async function bad(name,change){
 const r=structuredClone(cases.find(c=>c.name==='native-message'));change(r);
 let c;try{c=await drive(name,r.request.steps,r.materials,r.reviews,{method:r.method,request:r.request});}
 catch(e){assert.equal(e.name,'TwsEngineError');assert(['ENGINE_INPUT_INVALID','ENGINE_ARTIFACT_MISMATCH'].includes(e.code),e.code);c={...r,name,error:{code:e.code,message:e.message}};}
 assert(c.error,name);invalid.push(c);
}
await bad('duplicate-step',r=>r.request.steps[1].id='payment');
await bad('forward-edge',r=>r.request.steps.reverse());
await bad('unknown-edge',r=>r.request.steps[1].dependsOn=['missing']);
await bad('duplicate-edge',r=>r.request.steps[1].dependsOn=['payment','payment']);
await bad('too-many',r=>r.request.steps=Array.from({length:6},(_,i)=>message('m'+i)));
await bad('empty',r=>r.request.steps=[]);
await bad('fee-cap',r=>r.request.maxTotalFee='0');
await bad('binding-source-message',r=>r.request.steps=[message('payment'),message('receipt','payment')]);
await bad('binding-without-edge',r=>r.request.steps[1].dependsOn=[]);
await bad('binding-target-scalar',r=>r.request.steps[1].message.data='{"txids":"forged"}');
await bad('binding-prototype',r=>r.request.steps[1].bindings[0].target='constructor');
await bad('wrong-method-kind',r=>r.method='tbc_signPreparedWorkflow');
await bad('duplicate-input',r=>{r.request.steps=[r.request.steps[0],{...r.request.steps[0],id:'second'}];r.materials.second=r.materials.payment;});
await bad('typed-placeholder',r=>{r.request.steps[1]=typed('receipt','payment');r.request.steps[1].data.message.tx='11'.repeat(32)});
const report={status:'FROZEN_WORKFLOW_PLANNING_ORACLE',archiveSha256:o.archiveSha256,wasmSha256:o.wasmSha256,provenance,cases,invalid,approvalExecuted:0,signatures:0,chainHttp:0,broadcasts:0,proof:'Frozen Core request/plan/binding and WASM plan validation, not workflow signing/device/chain acceptance.'};
await writeFile(join(base,'test/fixtures/workflow-planning.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({status:report.status,cases:cases.length,invalid:invalid.length,scratch:o.work}));
