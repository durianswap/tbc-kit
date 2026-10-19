import assert from 'node:assert/strict';
import {secp256k1} from '@noble/curves/secp256k1.js';

// Public synthetic fixture only. Real Core/Host, actual reviewer and source
// keyless WASM; no SQLite, real Vault, transport or broadcast.
export async function checkAssociatedHtlcHost({kit,keyless,account,request,reviewer,signer,expectedRaw,expectedRaws=[expectedRaw],claim=true,preimage,reads}) {
  const results=[];
  for(const method of ['tbc_signReviewedTransaction','tbc_signWorkflow','tbc_signPreparedWorkflow'])for(const decision of ['approve','reject','close']) {
    const workflow=method!=='tbc_signReviewedTransaction';
    const reject=decision==='reject',closeDuringApproval=decision==='close';let session;
    const now=new Date().toISOString().replace(/\.\d{3}Z$/u,'Z'),origin='https://reviewer.test',sessionId='audit';
    const store=kit.createMemoryTwsHostStore({now:()=>Date.parse(now)});
    const evidence=kit.createApprovalHostEvidenceReader({store,releaseFingerprint:kit.TWS_RELEASE_FINGERPRINT,
      parseApprovalRequest(value){kit.assertValidTws('approvalRequestParams',value);return value;}});
    let approvals=0,executions=0,readsAtApproval=0;const performance=[];
    const forbidden=async()=>{throw Error('Unexpected IO');};
    const capabilities=kit.createTbcStandardWorkflowCapabilities({chainId:account.chainId,account,networkSourceIdentity:'fixture',materialNative:keyless,
      navigation:{origin,sessionId,navigationId:sessionId},readCurrentAuthority:async()=>({...account,networkSourceIdentity:'fixture'}),
      rawReviewer:{review:forbidden},associatedReviewer:reviewer,
      privateNative:{rawSigner:{sign:forbidden},cryptoAdapter:{encrypt:forbidden,decrypt:forbidden},associatedExecutor:{async execute({request:normalized,policyMaterial}){
        assert.equal(approvals,1);assert.equal(reject,false);executions++;
        const txraws=[];
        for(let transactionIndex=0;transactionIndex<=normalized.inputs.length;transactionIndex++){
          const stage=JSON.parse(await keyless.execute('prepareReviewedStage',JSON.stringify({format:'associated',request:normalized,publicKey:account.publicKey,
            transactionIndex,previousTransactions:txraws,resolvedOutputs:policyMaterial.resolvedOutputs})));
          // Only digests cross this synthetic independent signer boundary.
          const signatures=stage.digests.map(digest=>secp256k1.sign(digest,signer.toBuffer(),{prehash:false,lowS:true}).toCompactHex());
          const finalized=JSON.parse(await keyless.execute('finalizeReviewedStage',JSON.stringify({stage,signatures,signatureEncoding:'compact64'})));
          assert.equal(finalized.txraw,expectedRaws[transactionIndex]);txraws.push(finalized.txraw);
        }
        assert.deepEqual(txraws,expectedRaws);return {txraws};
      }}},now:()=>now});
    const permissions=['tbc_accounts','tbc_signTransaction','tbc_signWorkflow'].map(method=>({id:method,parentCapability:method,invoker:origin,date:Date.parse(now),
      caveats:[{type:'restrictChains',value:[account.chainId]},{type:'restrictAccounts',value:[account.accountId]},{type:'restrictMethods',value:[method]}]}));
    const runtime=kit.createTbcWallet({legacy:false,accounts:{current:async()=>[account]},
      onPerformance:event=>performance.push(event),
      approval:{async request(params,call){
        approvals++;readsAtApproval=reads.length;
        assert.equal(call.execution.type,'session-only');
        const bound=await evidence.read(call.callId,params.binding.bindingHash),model=kit.projectTbcApprovalPresentation(bound);
        assert.equal(model.trust,'binding-verified');assert.equal(JSON.stringify(model).includes(preimage),false);
        assert.equal(model.warnings.includes('HTLC_CLAIM_SIGNED_BYTES_DISCLOSE_PREIMAGE'),claim);
        // Hidden template still participates in full Core/Host binding.
        const changed=structuredClone(bound);
        const task=workflow?changed.memory.workflowPlan.payload.reviewedTransactionTasks[0]:changed.memory.walletActionPlan.payload.task;
        if(expectedRaws.length>1)task.request.payload.children[0].inputs[0].unlockingScriptTemplate='51';
        else task.request.payload.sourceInputs[0].unlockingScriptTemplate='51';
        assert.throws(()=>kit.projectTbcApprovalPresentation(changed));
        if(closeDuringApproval)session.close();
        return reject?{status:'rejected',bindingHash:params.binding.bindingHash,rejectedAt:now}:
          {status:'approved',approvalId:'synthetic-htlc',approvalToken:'synthetic-only',bindingHash:params.binding.bindingHash,approvedAt:now,expiresAt:params.binding.payload.expiresAt};
      }},signer:{sign:forbidden},reviewedTransaction:capabilities.reviewedTransaction,
      storage:{loadPermissions:async()=>({revision:'0',permissions}),commitPermissions:forbidden},
      network:{resolveChainData:forbidden,resolvePolicy:forbidden,broadcastSubmit:forbidden,broadcastReconcile:forbidden},
      clock:()=>now,randomBytes:n=>Uint8Array.from({length:n},(_,i)=>i)});
    session=await runtime.openSession({origin,sessionId,execution:{hostStore:store}});
    try {
      const params=workflow?{version:'1.0',chainId:account.chainId,from:account.address,steps:[{id:'claim',kind:'reviewedTransaction',dependsOn:[],request}]}:
        {version:'1.0',chainId:account.chainId,from:account.address,request};
      const before=reads.length,envelope={id:'synthetic-claim',method,params};
      const delivery=await session.handleRequest(envelope).catch(error=>{if(closeDuringApproval)return undefined;throw error;});
      assert.equal(approvals,1,'Exactly one real Host approval');assert.equal(executions,reject||closeDuringApproval?0:1);
      assert.equal(readsAtApproval-before,4);assert.equal(reads.length,readsAtApproval,'No post-approval reads');
      if(reject||closeDuringApproval)assert.ok(!delivery||delivery.response.error);
      else {assert.equal(delivery.response.error,undefined,JSON.stringify(delivery.response.error));
        const result=workflow?delivery.response.result.steps[0].result:delivery.response.result;
        assert.deepEqual(result.transactions.map(t=>t.rawTransaction),expectedRaws);
      }
      assert.equal(JSON.stringify(performance).includes(preimage),false);
      session.close();const oldExecutions=executions;
      const closed=await session.handleRequest({...envelope,id:'after-close'}).catch(()=>undefined);
      assert.ok(!closed||closed.response.error);assert.equal(executions,oldExecutions);
      assert.equal(approvals,1,'Closed sessions must not open another approval');
      assert.equal(reads.length,readsAtApproval,'Closed sessions must not fetch');
      results.push({method,workflow,decision,approvals,executions,reads:readsAtApproval-before,postApprovalReads:0,secretFreePresentation:true,closeBlocksExecution:true});
    }finally{session.close();}
  }
  return results;
}
