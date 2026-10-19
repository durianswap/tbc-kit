import * as publicKit from '@tbc/kit';
import * as walletKit from '@tbc/kit/wallet';
import {secp256k1} from '@noble/curves/secp256k1.js';
import assert from './browser-test-assert.mjs';

// Public scalar-1 fixtures only. Real browser and installed Kit; no custody.
const kit={...publicKit,...walletKit};
const reportUrl='/result';
try{
 assert.equal(typeof globalThis.Buffer,'undefined');assert.equal(typeof globalThis.process,'undefined');
 const [fixture,wasm]=await Promise.all([fetch('/fixture.json').then(r=>r.json()),fetch('/engine.wasm').then(r=>r.arrayBuffer())]);
 const native=await kit.createWasmTbcKeylessEngine(new Uint8Array(wasm));
 const secret=new Uint8Array(32);secret[31]=1;
 const network=kit.createTbcNetworkContext({network:'testnet',endpoint:{kind:'trusted-custom',apiOrigin:'https://devapi.tbcdev.org',trustId:'public-fixture'}});
 const rows=[],rejections=[];const started=performance.now();
 const forbidden=async()=>{throw Error('Unexpected IO');};
 for(const item of fixture.vectors){
  const {account,original,request}=item;let reads=0,proofCalls=0;
  const tracked={protocolInfo:()=>native.protocolInfo(),execute:(op,json)=>{if(op==='prepareReviewedStage')proofCalls++;return native.execute(op,json);}};
  const reviewer=kit.createTbcDefaultAssociatedTransactionReviewer({network,materialNative:tracked,fetch:async(url,init)=>{
   const u=new URL(String(url));assert.equal(u.origin,'https://devapi.tbcdev.org');reads++;let data;
   if(u.pathname==='/api/tbc/txo/status')data={txos:JSON.parse(init.body).txos.map(p=>{
    const o=item.parents[p.txid]?.[Number(p.index)];assert.ok(o,'Unknown fixture prevout');
    return {txid:p.txid,index:String(p.index),value:o.value,scriptPubKey:o.script,spent:false,height:'1'};
   })};
   else if(u.pathname.includes('/decode/txid/')){const id=u.pathname.split('/').at(-1);assert.ok(item.parents[id]);
    data={txid:id,contract_id:item.assetId,output:item.parents[id].map((_,vout)=>({txid:id,vout}))};}
   else if(u.pathname.includes('/info/'))data={stablecoin_id:item.assetId,code_script:item.assetScript};
   else throw Error('Unexpected fixture request');
   return new Response(JSON.stringify({code:'200',data}),{status:200});
  }});
  const context={origin:'https://associated.test',chainId:network.chainId,accountId:account.accountId,sessionId:'associated',navigationId:'associated'};
  // The same rejection reasons must survive browser/WASM, not only Node.
  for(const label of ['missing-key','missing-ancestors']){
   const bad=structuredClone(original);
   if(label==='missing-ancestors')delete [bad.sourceUtxos,...bad.inputs].flat().filter(i=>i.script)[item.selected].ancestorTransactions;
   let error;
   try{await reviewer.review({request:bad,operationDigest:kit.hashCanonical({kind:'signAssociated',request:bad}),context,
    ...(label==='missing-key'?{}:{publicKey:account.publicKey})});}catch(e){error=String(e);}
   assert.ok(label==='missing-key'?/bound wallet public key/.test(error??''):/ancestor|proof invalid/.test(error??''),label+' must reject');
   rejections.push({id:item.id,label});
  }
  for(const workflow of [false,true])for(const decision of ['approve','reject','close','account-change']){
   const now=new Date().toISOString().replace(/\.\d{3}Z$/u,'Z'),store=kit.createMemoryTwsHostStore({now:()=>Date.parse(now)});
   const evidence=kit.createApprovalHostEvidenceReader({store,releaseFingerprint:kit.TWS_RELEASE_FINGERPRINT,
    parseApprovalRequest(value){kit.assertValidTws('approvalRequestParams',value);return value;}});
   let session,approvals=0,executions=0,readsAtApproval=0,proofsAtApproval=0,approvalAt=0,finishedSigningAt=0;
   const finalRaws=[];
   const caps=kit.createTbcStandardWorkflowCapabilities({chainId:network.chainId,account,networkSourceIdentity:'fixture',materialNative:tracked,
    navigation:context,readCurrentAuthority:async()=>({...account,networkSourceIdentity:'fixture',
     ...(decision==='account-change'&&approvals?{publicKey:'02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5'}:{})}),
    rawReviewer:{review:forbidden},associatedReviewer:reviewer,now:()=>now,
    privateNative:{rawSigner:{sign:forbidden},cryptoAdapter:{encrypt:forbidden,decrypt:forbidden},associatedExecutor:{async execute({request:actual,operationDigest,policyMaterial}){
     assert.equal(approvals,1);assert.equal(decision,'approve');executions++;
     assert.equal(operationDigest,kit.hashCanonical({kind:'signAssociated',request:actual}));assert.deepEqual(actual,original);
     for(let index=0;index<actual.inputs.length+1;index++){
      const stage=JSON.parse(await tracked.execute('prepareReviewedStage',JSON.stringify({format:'associated',publicKey:account.publicKey,
       request:actual,transactionIndex:index,previousTransactions:finalRaws,resolvedOutputs:policyMaterial.resolvedOutputs})));
      const signatures=stage.digests.map(d=>secp256k1.sign(d,secret,{prehash:false,lowS:true}).toCompactHex());
      const signed=JSON.parse(await native.execute('finalizeReviewedStage',JSON.stringify({stage,signatures,signatureEncoding:'compact64'})));
      finalRaws.push(signed.txraw);
     }
     finishedSigningAt=performance.now();return {txraws:finalRaws};
    }}}});
   const permissions=['tbc_accounts','tbc_signTransaction','tbc_signWorkflow'].map(method=>({id:method,parentCapability:method,invoker:context.origin,date:Date.parse(now),
    caveats:[{type:'restrictChains',value:[network.chainId]},{type:'restrictAccounts',value:[account.accountId]},{type:'restrictMethods',value:[method]}]}));
   const wallet=kit.createTbcWallet({legacy:false,accounts:{current:async()=>[account]},reviewedTransaction:caps.reviewedTransaction,
    approval:{async request(params,call){approvals++;readsAtApproval=reads;proofsAtApproval=proofCalls;approvalAt=performance.now();
     assert.equal(call.execution.type,'session-only');
     const model=kit.projectTbcApprovalPresentation(await evidence.read(call.callId,params.binding.bindingHash));
     assert.equal(model.trust,'binding-verified');assert.equal(model.counts.transactions.value,original.inputs.length+1);
     if(decision==='close')session.close();
     return decision==='reject'?{status:'rejected',bindingHash:params.binding.bindingHash,rejectedAt:now}:
      {status:'approved',approvalId:'current-associated',approvalToken:'public-test',bindingHash:params.binding.bindingHash,approvedAt:now,expiresAt:params.binding.payload.expiresAt};}},
    signer:{sign:forbidden},storage:{loadPermissions:async()=>({revision:'0',permissions}),commitPermissions:forbidden},
    network:{resolveChainData:forbidden,resolvePolicy:forbidden,broadcastSubmit:forbidden,broadcastReconcile:forbidden},clock:()=>now,
    randomBytes:n=>Uint8Array.from({length:n},(_,i)=>i)});
   session=await wallet.openSession({origin:context.origin,sessionId:context.sessionId,execution:{hostStore:store}});
   try{
    const params=workflow?{version:'1.0',chainId:network.chainId,from:account.address,steps:[{id:'holder',kind:'reviewedTransaction',dependsOn:[],request}]}:
     {version:'1.0',chainId:network.chainId,from:account.address,request};
    const envelope={id:'associated',method:workflow?'tbc_signWorkflow':'tbc_signReviewedTransaction',params},before=reads,pc=proofCalls,t0=performance.now();
    const delivery=await session.handleRequest(envelope).catch(error=>{if(decision==='close')return undefined;throw error;});
    assert.equal(approvals,1,JSON.stringify(delivery?.response?.error));assert.equal(executions,decision==='approve'?1:0);
    assert.equal(readsAtApproval-before,4);assert.equal(reads,readsAtApproval);assert.equal(proofsAtApproval-pc,original.inputs.length+1);
    if(decision==='approve'){
     assert.equal(delivery.response.error,undefined,JSON.stringify(delivery.response.error));
     const result=workflow?delivery.response.result.steps[0].result:delivery.response.result;
     assert.deepEqual(result.transactions.map(t=>t.rawTransaction),finalRaws);
    }else assert.ok(!delivery||delivery.response.error);
    session.close();const closed=await session.handleRequest({...envelope,id:'closed'}).catch(()=>undefined);
    assert.ok(!closed||closed.response.error);assert.equal(approvals,1);assert.equal(reads,readsAtApproval);
    rows.push({id:item.id,workflow,decision,approvals,executions,reads:4,postApprovalReads:0,sessionOnly:true,finalRaws,
     preparationMs:approvalAt-t0,approvalToSignedMs:decision==='approve'?finishedSigningAt-approvalAt:null});
   }finally{session.close();}
  }
 }
 assert.equal(rows.length,fixture.expectedRows??64);assert.equal(rejections.length,fixture.expectedRejections??16);
 assert.equal(typeof globalThis.Buffer,'undefined');assert.equal(typeof globalThis.process,'undefined');
 const result={status:`PASS_BROWSER_${fixture.candidateNumber??216}_ASSOCIATED`,rows,rejections,elapsedMs:performance.now()-started,
  userAgent:navigator.userAgent,bufferGlobal:false,nodeProcessGlobal:false,actualChainHttp:0,broadcast:0};
 document.querySelector('#result').textContent=result.status;
 await fetch(reportUrl,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(result)});
}catch(error){
 const result={status:'FAIL',error:String(error),stack:error.stack};document.querySelector('#result').textContent=JSON.stringify(result);
 await fetch(reportUrl,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(result)});
}
