// Frozen Core action plan/binding/result. Review and signatures are immutable
// public offline fixtures; no live source, wallet or approval is involved.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {base,frozenOracle,sha,account,canonical} from './frozen_oracle.mjs';
const o=await frozenOracle(),cases=[],provenance={};
const inputs=[['reviewed-material-b.json',['raw-transfer-single','associated-source-only','associated-two-dependent','associated-explicit-and-local']],
 ['reviewed-native-lock.json',['associated-native-lock-then-refund']],
 ['reviewed-associated-contract.json',['associated-htlc-token-tbc20-standard-claim-before-refund','associated-lop-token-token-ft-match']]];
for(const[file,names]of inputs){
 const bytes=await readFile(join(base,'test/fixtures',file));provenance[file]=sha(bytes);
 for(const s of JSON.parse(bytes).cases.filter(s=>names.includes(s.name))){
  const now='2026-10-13T00:00:00.123Z',name=s.name,method='tbc_signReviewedTransaction';
  const request={version:'1.0',chainId:account.chainId,from:account.address,request:s.request,maxFee:s.review.payload.totalFee};
  const context={sessionId:'reviewed-'+name,navigationId:'document-1',origin:'https://partner.example',topOrigin:'https://partner.example',transport:'webview',frame:'top',createdAt:now};
  const session={version:'1.0',scope:{walletProfile:'dart-partner',sessionId:context.sessionId},state:{version:'1.0',sessionId:context.sessionId,revision:'0',connected:true,activeChainId:account.chainId,activeAccountIds:[account.accountId]}};
  const permissions=['tbc_accounts','tbc_signTransaction'].map(parentCapability=>({id:'permit-'+parentCapability,parentCapability,invoker:context.origin,date:Date.parse(now),caveats:[{type:'restrictChains',value:[account.chainId]},{type:'restrictAccounts',value:[account.accountId]},{type:'restrictMethods',value:[parentCapability]}]}));
  const navigation={...context,webViewInstanceId:'fixture'};delete navigation.transport;
  const caps=o.kit.createTbcStandardWorkflowCapabilities({navigation,chainId:account.chainId,account,networkSourceIdentity:'reviewed-frozen',
   readCurrentAuthority:async()=>({...account,networkSourceIdentity:'reviewed-frozen'}),materialNative:o.keyless,now:()=>now,
   rawReviewer:{review(){throw Error('Use pinned review')}},associatedReviewer:{review(){throw Error('Use pinned review')}},
   privateNative:{rawSigner:{sign:async()=>({sigs:s.stages.map(v=>v.finalized.sigs)})},associatedExecutor:{execute:async()=>({txraws:s.stages.map(v=>v.finalized.txraw)})},cryptoAdapter:{encrypt(){throw Error('unused')},decrypt(){throw Error('unused')}}}});
  const core=o.kit.createTwsCore(),audit={},ports=[];
  let t=await core.start({version:'1.0',release:o.kit.TWS_RELEASE,request:{jsonrpc:'2.0',id:name,method,params:request},currentContext:context,currentSession:session});
  for(let i=0;t.kind!=='complete';i++){
   assert(i<128);if(t.kind==='continue'){t=await core.resume({version:'1.0',checkpoint:t.checkpoint,currentContext:context,currentSession:session});continue;}
   assert.equal(t.kind,'waiting');assert.equal(t.calls.length,1);const call=t.calls[0];ports.push(call.operation);let result;
   switch(call.operation){
    case 'clock.now':result={now};break;
    case 'permissionStore.load':result={revision:'0',permissions};break;
    case 'accounts.resolve':result={accounts:[account]};break;
    case 'reviewedTransaction.review':audit.reviewParams=call.params;result=s.review;break;
    case 'approval.request':audit.binding=call.params.binding;audit.preview=call.params.preview;audit.plan=t.checkpoint.payload.memory.walletActionPlan;
     result={status:'approved',approvalId:'reviewed-'+name,approvalToken:'public-fixture-only',bindingHash:audit.binding.bindingHash,approvedAt:now,expiresAt:audit.binding.payload.expiresAt};audit.approval=result;break;
    case 'reviewedTransaction.execute':audit.execution=call.params;result=await caps.reviewedTransaction.execute(call.params,call);audit.innerResult=result;break;
    default:throw Error('Unexpected port '+call.operation);
   }
   t=await core.resume({version:'1.0',checkpoint:t.checkpoint,currentContext:context,currentSession:session,response:{version:'1.0',callId:call.callId,result}});
  }
  assert(t.completion.response.result,canonical(t.completion.response));
  assert.equal(ports.filter(p=>p==='approval.request').length,1);
  cases.push({name,source:{file,name:s.name},method,request,account,context,now,audit,result:t.completion.response.result});
 }
}
await writeFile(join(base,'test/fixtures/reviewed-signing.json'),JSON.stringify({status:'FROZEN_CORE_REVIEWED_SIGNING_ORACLE',archiveSha256:o.archiveSha256,provenance,cases,chainHttp:0,broadcasts:0},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({cases:cases.length,coreBindingAndResult:true,chainHttp:0}));
