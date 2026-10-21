// Reuse immutable public workflow vectors. Only offline freshness and its
// enclosing commitments change; no transaction/digest/signature is regenerated.
import {readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
const base=resolve(import.meta.dirname,'..');
const canonical=v=>JSON.stringify(v,(_,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
const sha=v=>createHash('sha256').update(v).digest('hex'),hash=v=>sha(canonical(v));
export async function writeWorkflowFixture(path, wasmPath=process.env.TBC_APPROVAL_ENGINE_WASM){
 const bytes=await readFile(join(base,'test/fixtures/workflow-planning.json'));
 const signing=JSON.parse(await readFile(join(base,'test/fixtures/workflow-signing.json')));
 assert.equal(signing.planningSha256,sha(bytes));
 const cases=JSON.parse(bytes).cases.filter(c=>!c.request.steps.some(s=>['encrypt','decrypt'].includes(s.kind)));
 let engineEvidence;
 if(wasmPath){
  // Optional independent candidate replan. No HTTP and no new signatures:
  // every prior unsigned transaction, fee, digest and signing stage must match.
  const {createWasmTbcEngineBackend}=await import(pathToFileURL(resolve(base,'../../../packages/kit/dist/esm/engine.js')).href);
  const wasmBytes=await readFile(wasmPath),engine=await createWasmTbcEngineBackend(wasmBytes);let plans=0;
  const call=async(method,input)=>{const envelope=JSON.parse(await engine.call(method,JSON.stringify(input)));assert(envelope.ok,JSON.stringify(envelope.error));return envelope.result;};
  for(const c of cases)for(const entry of c.plan.payload.transactionPlans){
   const step=c.request.steps.find(s=>s.id===entry.stepId),material=c.materials[entry.stepId];
   assert(step&&material);
   const request={version:'1.0',chainId:c.request.chainId,from:c.request.from,intent:step.intent,
    ...step.constraints?{constraints:step.constraints}:{},...step.signingRoles?{signingRoles:step.signingRoles}:{}};
   const normalized=await call('normalizeRequest',{version:'1.0',request});
   const input={version:'1.0',request:normalized.request,requestHash:normalized.requestHash,...material};
   const result=await call('plan',input),stripped=structuredClone(result.plan.payload);
   for(const tx of stripped.transactions)delete tx.outputReview;
   assert.deepEqual(stripped,entry.plan.payload,`${c.name}/${entry.stepId}: transaction/fee/digest regression`);
   assert((await call('validate',{...input,plan:result.plan,phase:'plan'})).valid,`${c.name}: candidate Engine validation`);
   entry.plan=result.plan;plans++;
  }
  engineEvidence={wasmSha256:sha(wasmBytes),plans,rawFeesDigestsUnchanged:true,networkReads:0};
 }
 const now=new Date().toISOString(),expiry=new Date(Date.now()+240000).toISOString();
 function recommit(c){
  for(const e of c.plan.payload.transactionPlans)e.plan.planHash=hash(e.plan.payload);
  c.plan.payload.requestHash=hash(c.request);c.plan.workflowPlanHash=hash(c.plan.payload);
  c.binding.payload.requestHash=hash(c.request);c.binding.payload.operationHash=c.plan.workflowPlanHash;c.binding.bindingHash=hash(c.binding.payload);
 }
 for(const c of cases){
  if(c.request.expiresAt)c.request.expiresAt=expiry;
  for(const s of c.request.steps)if(s.proposal){const p=s.proposal.payload;p.createdAt=now;p.expiresAt=expiry;p.evidence.observedAt=now;s.proposal.proposalHash=hash(p);}
  for(const review of Object.values(c.reviews)){review.payload.expiresAt=expiry;review.reviewHash=hash(review.payload);}
  for(const e of c.plan.payload.transactionPlans)e.plan.payload.expiresAt=expiry;
  for(const t of c.plan.payload.reviewedTransactionTasks)t.reviewHash=c.reviews[t.taskId.slice('review-'.length)].reviewHash;
  c.plan.payload.expiresAt=expiry;c.binding.payload.expiresAt=expiry;recommit(c);
  if(Object.keys(c.reviews).length)c.consentReview={kind:'workflow',steps:Object.entries(c.reviews).map(([stepId,review])=>({stepId,review})),prepared:{workflowPlanHash:c.plan.workflowPlanHash,totalFee:c.plan.payload.totalFee}};
 }
 const receiptVariants=[];
 for(const understate of [false,true]){
  const c=structuredClone(cases.find(c=>c.name==='native-message'));
  delete c.request.maxTotalFee;c.plan.payload.maxTotalFee=c.plan.payload.totalFee;recommit(c);
  c.consentReview={kind:'workflow',steps:[],prepared:{workflowPlanHash:c.plan.workflowPlanHash,totalFee:understate?'0':c.plan.payload.totalFee}};
  receiptVariants.push({accept:!understate,sample:c});
 }
 {
  const c=structuredClone(cases.find(c=>c.name==='prepared-typed')),tx=c.plan.payload.transactionPlans[0].plan.payload.transactions[0];
  tx.unsignedTransaction=tx.unsignedTransaction.slice(0,-1)+(tx.unsignedTransaction.endsWith('0')?'1':'0');recommit(c);
  receiptVariants.push({accept:false,sample:c});
 }
 {
  const c=structuredClone(cases.find(c=>c.name==='native-message')),task=c.plan.payload.transactionPlans[0].plan.payload.signingTasks[0];
  task.signatureEncoding='DER';c.plan.payload.immediateSigningTasks[0].task.signatureEncoding='DER';recommit(c);
  receiptVariants.push({accept:false,sample:c});
 }
 const htlc=JSON.parse(await readFile(join(base,'test/fixtures/htlc-token-signing.json'))).cases.find(c=>c.request.intent.type==='tbc-htlc-claim');
 cases.push({name:'token-htlc-secret-free-consent',method:'tbc_signWorkflow',account:htlc.account,accounts:[htlc.account],context:htlc.context,request:{version:'1.0',chainId:htlc.account.chainId,from:htlc.account.address,maxTotalFee:'100000000',steps:[{id:'claim',kind:'transaction',dependsOn:[],intent:htlc.request.intent,constraints:htlc.request.constraints}]},mustNotRender:htlc.request.intent.preimage});
 const stepCases=signing.cases.filter(s=>!['staged-ft-primary','reviewed-then-message'].includes(s.name)).map(s=>{
  const sample=cases.find(c=>c.name===s.name);assert(sample);
  return {sample,signed:s.signed,steps:sample.request.steps.map(step=>s.result.steps.find(r=>r.id===step.id)),deferred:s.deferred,result:s.result};
 });
 const jsonCases=JSON.parse(await readFile(join(base,'test/fixtures/workflow-json.json'))).cases;
 await writeFile(path,JSON.stringify({cases,receiptVariants,stepCases,jsonCases,engineEvidence}));
 return {cases:cases.length,steps:stepCases.length,expiresAt:expiry,engineEvidence};
}
if(process.argv[1]===import.meta.filename)console.log(JSON.stringify(await writeWorkflowFixture(resolve(process.argv[2]))));
