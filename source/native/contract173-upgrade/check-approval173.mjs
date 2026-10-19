import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {source,hash} from './source-oracle.mjs';
const {projectTbcApprovalPresentation}=await source('packages/kit/src/approval-presentation.ts');
const data=JSON.parse(await readFile(new URL('./high-level173.json',import.meta.url)));
let checked=0;
for(const s of data.cases.filter(s=>s.kind==='create')){
  const {audit,request,context}=s,callId='offline-call',operationId='offline-operation';
  const params={version:'1.0',binding:audit.binding,preview:audit.preview,
    requester:{transport:context.transport,origin:context.origin,topOrigin:context.topOrigin,frame:context.frame}};
  const evidence={callId,operationId,releaseFingerprint:'11'.repeat(32),
    call:{callId,operation:'approval.request',params},params,
    operation:{operationId,releaseFingerprint:'11'.repeat(32),transition:{checkpoint:{payload:{}}}},
    payload:{operationId,operation:{method:s.method,params:request}},
    memory:{requestHash:hash(request),approvalBinding:audit.binding,approvalPreview:audit.preview,
      normalizedTransaction:{request,requestHash:hash(request)},executionPlan:audit.plan}};
  const view=projectTbcApprovalPresentation(evidence),f=request.intent.feePolicy;
  assert.equal(view.trust,'binding-verified');
  assert.deepEqual(view.businessTerms.value.feePolicy,f);
  assert.deepEqual(view.businessTerms.value.feeSummary,{feePolicy:f,totalFeeBps:f.lpFeeRate+f.taxFeeRate+f.serviceProviderFeeRate+f.protocolFeeRate,
    lpFeeBps:f.lpFeeRate,nonLpFeeBps:f.taxFeeRate+f.serviceProviderFeeRate+f.protocolFeeRate,feeAddress:f.feeAddress});
  assert(Object.isFrozen(view.businessTerms.value.feeSummary));
  const bad=structuredClone(evidence);bad.memory.normalizedTransaction.request.intent.feePolicy.lpFeeRate++;
  assert.throws(()=>projectTbcApprovalPresentation(bad));
  checked++;
}
console.log(JSON.stringify({status:'APPROVAL173_PASS',creates:checked,tamperedBoundRequestsRejected:checked,addedHttp:0,
  scope:'Formal Host evidence projection; not rendered device UI'}));
