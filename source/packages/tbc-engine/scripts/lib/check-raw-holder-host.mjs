import assert from 'node:assert/strict';
import {secp256k1} from '@noble/curves/secp256k1.js';

// Real source Core/Host and reviewer; isolated public fixture signer only.
export async function checkRawHolderHost({kit,native,account,request,reviewer,signer,expectedSignatures,readCount}) {
 const rows=[];
 for(const workflow of [false,true])for(const decision of ['approve','reject','close']){
  const now=new Date().toISOString().replace(/\.\d{3}Z$/u,'Z'),origin='https://review.test',sessionId='holder-host';
  const store=kit.createMemoryTwsHostStore({now:()=>Date.parse(now)});
  const evidence=kit.createApprovalHostEvidenceReader({store,releaseFingerprint:kit.TWS_RELEASE_FINGERPRINT,
   parseApprovalRequest(value){kit.assertValidTws('approvalRequestParams',value);return value;}});
  let session,approvals=0,executions=0,readsAtApproval=0;
  const forbidden=async()=>{throw Error('Unexpected fixture IO');};
  const caps=kit.createTbcStandardWorkflowCapabilities({chainId:account.chainId,account,networkSourceIdentity:'fixture',materialNative:native,
   navigation:{origin,sessionId,navigationId:sessionId},readCurrentAuthority:async()=>({...account,networkSourceIdentity:'fixture'}),
   rawReviewer:reviewer,associatedReviewer:{review:forbidden},now:()=>now,
   privateNative:{associatedExecutor:{execute:forbidden},cryptoAdapter:{encrypt:forbidden,decrypt:forbidden},rawSigner:{async sign({binding,policyMaterial}){
    assert.equal(approvals,1);assert.equal(decision,'approve');executions++;
    const stage=JSON.parse(await native.execute('prepareReviewedStage',JSON.stringify({format:'raw',publicKey:account.publicKey,
     request:binding.request,resolvedOutputs:policyMaterial.resolvedOutputs})));
    const signatures=stage.digests.map(d=>secp256k1.sign(d,signer.toBuffer(),{prehash:false,lowS:true}).toCompactHex());
    const result=JSON.parse(await native.execute('finalizeReviewedStage',JSON.stringify({stage,signatures,signatureEncoding:'compact64'})));
    assert.deepEqual(result.sigs,expectedSignatures);assert.equal(result.txraw,request.payload.transactions[0].rawTransaction);
    return {sigs:[result.sigs]};
   }}}});
  const permissions=['tbc_accounts','tbc_signTransaction','tbc_signWorkflow'].map(method=>({id:method,parentCapability:method,
   invoker:origin,date:Date.parse(now),caveats:[{type:'restrictChains',value:[account.chainId]},{type:'restrictAccounts',value:[account.accountId]},
    {type:'restrictMethods',value:[method]}]}));
  const wallet=kit.createTbcWallet({legacy:false,accounts:{current:async()=>[account]},reviewedTransaction:caps.reviewedTransaction,
   approval:{async request(params,call){
    approvals++;readsAtApproval=readCount();assert.equal(call.execution.type,'session-only');
    const bound=await evidence.read(call.callId,params.binding.bindingHash),model=kit.projectTbcApprovalPresentation(bound);
    assert.equal(model.trust,'binding-verified');
    if(decision==='close')session.close();
    return decision==='reject'?{status:'rejected',bindingHash:params.binding.bindingHash,rejectedAt:now}:
     {status:'approved',approvalId:'public-holder',approvalToken:'synthetic-only',bindingHash:params.binding.bindingHash,approvedAt:now,expiresAt:params.binding.payload.expiresAt};
   }},signer:{sign:forbidden},storage:{loadPermissions:async()=>({revision:'0',permissions}),commitPermissions:forbidden},
   network:{resolveChainData:forbidden,resolvePolicy:forbidden,broadcastSubmit:forbidden,broadcastReconcile:forbidden},clock:()=>now,
   randomBytes:n=>Uint8Array.from({length:n},(_,i)=>i)});
  session=await wallet.openSession({origin,sessionId,execution:{hostStore:store}});
  try{
   const params=workflow?{version:'1.0',chainId:account.chainId,from:account.address,steps:[{id:'holder',kind:'reviewedTransaction',dependsOn:[],request}]}:
    {version:'1.0',chainId:account.chainId,from:account.address,request};
   const envelope={id:'holder',method:workflow?'tbc_signWorkflow':'tbc_signReviewedTransaction',params},before=readCount();
   const delivery=await session.handleRequest(envelope).catch(error=>{if(decision==='close')return undefined;throw error;});
   assert.equal(approvals,1,JSON.stringify(delivery?.response?.error));assert.equal(executions,decision==='approve'?1:0);
   assert.equal(readsAtApproval-before,4);assert.equal(readCount(),readsAtApproval);
   if(decision==='approve'){
    assert.equal(delivery.response.error,undefined,JSON.stringify(delivery.response.error));
    const result=workflow?delivery.response.result.steps[0].result:delivery.response.result;
    assert.deepEqual(result.detachedSignatures,[expectedSignatures]);
   }else assert.ok(!delivery||delivery.response.error);
   session.close();const closed=await session.handleRequest({...envelope,id:'closed'}).catch(()=>undefined);
   assert.ok(!closed||closed.response.error);assert.equal(approvals,1);assert.equal(readCount(),readsAtApproval);
   rows.push({workflow,decision,approvals,executions,reads:4,postApprovalReads:0,sessionOnly:true});
  }finally{session.close();}
 }
 return rows;
}
