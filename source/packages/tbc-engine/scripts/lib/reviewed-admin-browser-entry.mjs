import * as publicKit from '@tbc/kit';
import * as walletKit from '@tbc/kit/wallet';
import {secp256k1,schnorr} from '@noble/curves/secp256k1.js';
import assert from './browser-test-assert.mjs';
// Browser acceptance only: public scalars1/2, controlled approval and API.
const kit={...publicKit,...walletKit};
const rejects=async f=>{let denied=false;try{await f();}catch{denied=true;}assert.ok(denied,'Expected rejection');};
try{
 assert.equal(typeof globalThis.Buffer,'undefined');assert.equal(typeof globalThis.process,'undefined');
 const [fixture,bytes]=await Promise.all([fetch('/fixture.json').then(r=>r.json()),fetch('/engine.wasm').then(r=>r.arrayBuffer())]);
 const native=await kit.createWasmTbcKeylessEngine(new Uint8Array(bytes)),rows=[];
 const network=kit.createTbcNetworkContext({network:'testnet',endpoint:{kind:'trusted-custom',apiOrigin:'https://devapi.tbcdev.org',trustId:'public-fixture'}});
 const forbidden=async()=>{throw Error('Unexpected IO');};let materialChecks=0,replayChecks=0;
 const start=performance.now();
 for(const item of fixture.vectors)for(const method of ['tbc_signReviewedTransaction','tbc_signWorkflow','tbc_signPreparedWorkflow'])
 for(const decision of item.sameAccount?['approve']:['approve','reject','admin-change',...(item.vectorIndex===0?['prepare-change','prepare-expiry']:[])]){
  const {fee,admin,request,original,parents}=item,accounts=item.sameAccount?[fee]:[fee,admin];
  const now=new Date().toISOString().replace(/\.\d{3}Z$/u,'Z'),store=kit.createMemoryTwsHostStore({now:()=>Date.parse(now)});
  const approvedTasks=kit.createApprovedHostTaskReader({store,releaseFingerprint:kit.TWS_RELEASE_FINGERPRINT});
  const approvalEvidence=kit.createApprovalHostEvidenceReader({store,releaseFingerprint:kit.TWS_RELEASE_FINGERPRINT,parseApprovalRequest:v=>v});
  let reads=0,approvals=0,signs=0,stages=0,atApproval=0,changed=false,expired=false,session,approvedMaterial,lastCall,lastParams;
  const context={origin:'https://reviewed-admin.test',sessionId:'reviewed-admin',navigationId:'reviewed-admin'};
  const tracked={protocolInfo:()=>native.protocolInfo(),execute:async(op,json)=>{
   const result=await native.execute(op,json);if(approvals&&op==='prepareReviewedStage'){
    if(decision==='prepare-change')changed=true;if(decision==='prepare-expiry')expired=true;
   }return result;
  }};
  const reviewer=kit.createTbcDefaultAssociatedTransactionReviewer({network,materialNative:native,fetch:async(url,init)=>{
   reads++;const u=new URL(String(url));assert.equal(u.origin,'https://devapi.tbcdev.org');let data;
   if(u.pathname==='/api/tbc/txo/status')data={txos:JSON.parse(init.body).txos.map(p=>{const o=parents[p.txid]?.[Number(p.index)];assert.ok(o);return {txid:p.txid,index:String(p.index),value:o.satoshis,scriptPubKey:o.script,spent:false,height:'1'};})};
   else if(u.pathname.includes('/decode/txid/')){const txid=u.pathname.split('/').at(-1);assert.ok(parents[txid]);data={txid,contract_id:item.assetId,output:parents[txid].map((_,vout)=>({txid,vout}))};}
   else if(u.pathname.includes('/info/'))data={stablecoin_id:item.assetId,code_script:item.code};else throw Error('Unexpected fixture read');
   return new Response(JSON.stringify({code:'200',data}),{status:200});
  }});
  const caps=kit.createTbcStandardWorkflowCapabilities({chainId:network.chainId,account:fee,networkSourceIdentity:'fixture',navigation:context,materialNative:tracked,
   readCurrentAuthority:async()=>({...fee,networkSourceIdentity:'fixture',signingAccounts:changed?[]:[admin]}),
   now:()=>expired?new Date(Date.parse(now)+600000).toISOString():now,
   rawReviewer:{review:forbidden},associatedReviewer:reviewer,privateNative:{rawSigner:{sign:forbidden},associatedExecutor:{execute:forbidden},cryptoAdapter:{encrypt:forbidden,decrypt:forbidden}},
   reviewedRoleSigner:{approvedTasks,async signStage({tasks,evidence,stage,transactionIndex,material},call){
    assert.equal(approvals,1);assert.equal(evidence.callId,call.callId);assert.equal(call.execution.type,'session-only');assert.equal(transactionIndex,stages++);
    assert.ok(Object.isFrozen(stage)&&Object.isFrozen(material)&&Object.isFrozen(material.request));assert.deepEqual(material,approvedMaterial);materialChecks++;
    return tasks.map(t=>{assert.ok([fee.accountId,admin.accountId].includes(t.accountId));const key=new Uint8Array(32);key[31]=t.accountId===admin.accountId?2:1;signs++;
     const signature=t.algorithm==='secp256k1-schnorr'?schnorr.sign(t.digest,key,new Uint8Array(32)):secp256k1.sign(t.digest,key,{prehash:false,lowS:true}).toCompactRawBytes();
     return Array.from(signature,b=>b.toString(16).padStart(2,'0')).join('');
    });
   }}});
  const permissions=['tbc_accounts','tbc_signTransaction','tbc_signWorkflow'].map(c=>({id:c,parentCapability:c,invoker:context.origin,date:Date.parse(now),caveats:[
   {type:'restrictChains',value:[network.chainId]},{type:'restrictAccounts',value:accounts.map(a=>a.accountId)},{type:'restrictMethods',value:[c]}]}));
  const wallet=kit.createTbcWallet({legacy:false,accounts:{current:async()=>accounts},reviewedTransaction:{review:caps.reviewedTransaction.review,async execute(p,c){
   lastCall=c;lastParams=p;const result=await caps.reviewedTransaction.execute(p,c);await rejects(()=>caps.reviewedTransaction.execute(p,c));replayChecks++;return result;
  }},approval:{supportedSigningRoles:['coin-admin'],async request(params,call){
   approvals++;atApproval=reads;const verified=await approvalEvidence.read(call.callId,params.binding.bindingHash);
   const task=verified.memory.workflowPlan?.payload?.reviewedTransactionTasks[0]??verified.memory.walletActionPlan.payload.task;
   approvedMaterial=await caps.resolveReviewedSigningMaterial(task);const bad=structuredClone(task);bad.requestHash='00'.repeat(32);
   await rejects(()=>caps.resolveReviewedSigningMaterial(bad));materialChecks++;
   if(decision==='admin-change')changed=true;
   if(decision==='reject')return {status:'rejected',bindingHash:params.binding.bindingHash,rejectedAt:now};
   return {status:'approved',approvalId:'browser-admin',approvalToken:'public-fixture',bindingHash:params.binding.bindingHash,approvedAt:now,expiresAt:params.binding.payload.expiresAt};
  }},signer:{sign:forbidden},storage:{loadPermissions:async()=>({revision:'0',permissions}),commitPermissions:forbidden},
   network:{resolveChainData:forbidden,resolvePolicy:forbidden,broadcastSubmit:forbidden,broadcastReconcile:forbidden},clock:()=>now,randomBytes:n=>new Uint8Array(n).fill(1)});
  session=await wallet.openSession({origin:context.origin,sessionId:context.sessionId,execution:{hostStore:store}});
  try{
   const selected=item.sameAccount?{}:{signingRoles:[{role:'coin-admin',accountId:admin.accountId}]},base={version:'1.0',chainId:network.chainId,from:fee.address};
   const params=method==='tbc_signReviewedTransaction'?{...base,...selected,request}:{...base,steps:[{id:'admin',kind:'reviewedTransaction',dependsOn:[],...selected,request}]};
   const delivery=await session.handleRequest({id:'browser-admin',method,params});let finalRaws=[];
   if(decision==='approve'){
    assert.equal(delivery.response.error,undefined,JSON.stringify(delivery.response.error));
    const result=method==='tbc_signReviewedTransaction'?delivery.response.result:delivery.response.result.steps[0].result;
    finalRaws=result.transactions.map(t=>t.rawTransaction);assert.equal(finalRaws.length,original.inputs.length+1);assert.equal(stages,original.inputs.length+1);
    await rejects(()=>approvedTasks.readReviewed(lastCall.callId,lastParams));replayChecks++;
   }else{assert.ok(delivery.response.error,decision);assert.equal(signs,0);}
   assert.equal(approvals,1);assert.equal(reads,4);assert.equal(reads,atApproval);
   rows.push({vectorIndex:item.vectorIndex,sameAccount:item.sameAccount,id:item.id,method,decision,reads,postApprovalReads:reads-atApproval,approvals,signs,stages,finalRaws});
  }finally{session.close();}
 }
 assert.equal(rows.length,42);assert.equal(replayChecks,36);assert.equal(materialChecks,66);
 assert.equal(typeof globalThis.Buffer,'undefined');assert.equal(typeof globalThis.process,'undefined');
 const report={status:'PASS_BROWSER_220_REVIEWED_ADMIN',rows,replayChecks,materialChecks,elapsedMs:performance.now()-start,userAgent:navigator.userAgent,bufferGlobal:false,nodeProcessGlobal:false};
 document.querySelector('#result').textContent=report.status;await fetch('/result',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(report)});
}catch(e){await fetch('/result',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({status:'FAIL',error:String(e),stack:e.stack})});}
