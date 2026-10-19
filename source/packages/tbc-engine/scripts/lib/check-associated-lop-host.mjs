import assert from 'node:assert/strict';
import {secp256k1} from '@noble/curves/secp256k1.js';

// Real source Core/Host and reviewer, public synthetic Signer only. This helper
// cannot reach a network, Vault or broadcast adapter and is not a Kit export.
export async function checkAssociatedLopHost({kit,keyless,account,request,reviewer,signer,expectedRaw,expectedOrders,readCount,expectedReads}) {
  const results=[];
  for(const method of ['tbc_signReviewedTransaction','tbc_signWorkflow','tbc_signPreparedWorkflow'])
    for(const decision of ['approve','reject','close']) {
      const workflow=method!=='tbc_signReviewedTransaction';let session;
      const now=new Date().toISOString().replace(/\.\d{3}Z$/u,'Z'),origin='https://reviewer.test',sessionId='lop-audit';
      const store=kit.createMemoryTwsHostStore({now:()=>Date.parse(now)});
      const evidence=kit.createApprovalHostEvidenceReader({store,releaseFingerprint:kit.TWS_RELEASE_FINGERPRINT,
        parseApprovalRequest(value){kit.assertValidTws('approvalRequestParams',value);return value;}});
      let approvals=0,executions=0,signatures=0,readsAtApproval=0;
      const forbidden=async()=>{throw Error('Unexpected external IO');};
      const capabilities=kit.createTbcStandardWorkflowCapabilities({chainId:account.chainId,account,networkSourceIdentity:'fixture',materialNative:keyless,
        navigation:{origin,sessionId,navigationId:sessionId},readCurrentAuthority:async()=>({...account,networkSourceIdentity:'fixture'}),
        rawReviewer:{review:forbidden},associatedReviewer:reviewer,
        privateNative:{rawSigner:{sign:forbidden},cryptoAdapter:{encrypt:forbidden,decrypt:forbidden},associatedExecutor:{async execute({request:normalized,policyMaterial}){
          assert.equal(approvals,1);assert.equal(decision,'approve');executions++;
          const stage=JSON.parse(await keyless.execute('prepareReviewedStage',JSON.stringify({format:'associated',request:normalized,
            publicKey:account.publicKey,resolvedOutputs:policyMaterial.resolvedOutputs})));
          const matching=normalized.sourceUtxos.flatMap((input,index)=>input.scriptSigType==='tbc_lop_match'?[index]:[]);
          assert.ok(stage.signingInputIndexes.every(index=>!matching.includes(index)),'Permissionless LOP inputs never request an owner signature');
          const sigs=stage.digests.map(digest=>secp256k1.sign(digest,signer.toBuffer(),{prehash:false,lowS:true}).toCompactHex());
          signatures+=sigs.length;
          const result=JSON.parse(await keyless.execute('finalizeReviewedStage',JSON.stringify({stage,signatures:sigs,signatureEncoding:'compact64'})));
          assert.equal(result.txraw,expectedRaw);return {txraws:[result.txraw]};
        }}},now:()=>now});
      const permissions=['tbc_accounts','tbc_signTransaction','tbc_signWorkflow'].map(method=>({id:method,parentCapability:method,invoker:origin,date:Date.parse(now),
        caveats:[{type:'restrictChains',value:[account.chainId]},{type:'restrictAccounts',value:[account.accountId]},{type:'restrictMethods',value:[method]}]}));
      const wallet=kit.createTbcWallet({legacy:false,accounts:{current:async()=>[account]},
        approval:{async request(params,call){
          approvals++;readsAtApproval=readCount();assert.equal(call.execution.type,'session-only');
          const bound=await evidence.read(call.callId,params.binding.bindingHash),model=kit.projectTbcApprovalPresentation(bound);
          assert.equal(model.trust,'binding-verified');
          const terms=(workflow?model.steps[0]:model).businessTerms;
          assert.equal(terms.status,'known');assert.equal(terms.source,'engine-preview');assert.equal(terms.value.type,'tbc-lop');
          assert.deepEqual(terms.value.orders,expectedOrders,'All authenticated order terms must survive Host binding and UI projection');
          const tampered=structuredClone(bound);
          const task=workflow?tampered.memory.workflowPlan.payload.reviewedTransactionTasks[0]:tampered.memory.walletActionPlan.payload.task;
          task.request.payload.sourceInputs[0].satoshis=String(BigInt(task.request.payload.sourceInputs[0].satoshis)+1n);
          assert.throws(()=>kit.projectTbcApprovalPresentation(tampered),'Input material remains bound to approval');
          if(decision==='close')session.close();
          return decision==='reject'?{status:'rejected',bindingHash:params.binding.bindingHash,rejectedAt:now}:
            {status:'approved',approvalId:'synthetic-lop',approvalToken:'synthetic-only',bindingHash:params.binding.bindingHash,approvedAt:now,expiresAt:params.binding.payload.expiresAt};
        }},signer:{sign:forbidden},reviewedTransaction:capabilities.reviewedTransaction,
        storage:{loadPermissions:async()=>({revision:'0',permissions}),commitPermissions:forbidden},
        network:{resolveChainData:forbidden,resolvePolicy:forbidden,broadcastSubmit:forbidden,broadcastReconcile:forbidden},
        clock:()=>now,randomBytes:n=>Uint8Array.from({length:n},(_,i)=>i)});
      session=await wallet.openSession({origin,sessionId,execution:{hostStore:store}});
      try {
        const params=workflow?{version:'1.0',chainId:account.chainId,from:account.address,steps:[{id:'order',kind:'reviewedTransaction',dependsOn:[],request}]}:
          {version:'1.0',chainId:account.chainId,from:account.address,request};
        const before=readCount(),envelope={id:'synthetic-lop',method,params};
        const delivery=await session.handleRequest(envelope).catch(error=>{if(decision==='close')return undefined;throw error;});
        assert.equal(approvals,1,'One whole-operation approval');assert.equal(executions,decision==='approve'?1:0);
        assert.equal(readsAtApproval-before,expectedReads);assert.equal(readCount(),readsAtApproval,'No reads after approval');
        if(decision!=='approve'){assert.ok(!delivery||delivery.response.error);assert.equal(signatures,0);}
        else {assert.equal(delivery.response.error,undefined,JSON.stringify(delivery.response.error));
          const result=workflow?delivery.response.result.steps[0].result:delivery.response.result;
          assert.equal(result.transactions[0].rawTransaction,expectedRaw);assert.ok(signatures>0);}
        session.close();const priorExecutions=executions;
        const closed=await session.handleRequest({...envelope,id:'closed'}).catch(()=>undefined);
        assert.ok(!closed||closed.response.error);assert.equal(executions,priorExecutions);assert.equal(approvals,1);
        assert.equal(readCount(),readsAtApproval,'Closed sessions cannot fetch');
        results.push({method,decision,approvals,executions,syntheticSignatures:signatures,reads:expectedReads,postApprovalReads:0,
          boundPresentation:true,permissionlessInputsSkipSignature:true,closeBlocksExecution:true});
      }finally{session.close();}
    }
  return results;
}
