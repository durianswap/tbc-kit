// Real source Core/Host/Keyless; synthetic API and public scalar1/2 signatures.
// No real account custody, HTTP, device, persistence or broadcast.
import assert from 'node:assert/strict';
import {readFile,mkdtemp,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {registerHooks,createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {build} from 'esbuild';
import {secp256k1,schnorr} from '@noble/curves/secp256k1.js';
import {loadHolderInstalledHarness} from './lib/holder-installed-harness.mjs';
import {loadTokenUnlockSdkOracle} from './lib/token-unlock-sdk-oracle.mjs';
import {reviewedAdminControllerFixture,reviewedAdminCooperativeFixture} from './lib/reviewed-admin-controller-fixture.mjs';
import {createCoinMuSigFixtureSigner} from './lib/coin-musig-fixture-signer.mjs';
const root=fileURLToPath(new URL('../../../',import.meta.url)),sha=b=>createHash('sha256').update(b).digest('hex');
const env=process.env;
const rawMode=env.TBC_REVIEWED_ADMIN_FORMAT==='raw';
const controllerMode=env.TBC_REVIEWED_ADMIN_CONTROLLER==='1';
const cooperativeMode=env.TBC_REVIEWED_ADMIN_MUSIG==='1';
assert.ok(env.TBC_REVIEWED_ADMIN_FORMAT===undefined||rawMode);
const expectedVersion=env.TBC_REVIEWED_ADMIN_VERSION??'0.1.0-candidate.219';
assert.ok(['0.1.0-candidate.219','0.1.0-candidate.220','0.1.0-candidate.221','0.1.0-candidate.222','0.1.0-candidate.223','0.1.0-candidate.224'].includes(expectedVersion));
const installed=env.TBC_REVIEWED_ADMIN_CONSUMER?await loadHolderInstalledHarness({
 consumer:env.TBC_REVIEWED_ADMIN_CONSUMER,archive:env.TBC_REVIEWED_ADMIN_ARCHIVE,expectedSha:env.TBC_REVIEWED_ADMIN_SHA256,
 expectedVersion,entry:env.TBC_REVIEWED_ADMIN_ENTRY??'node',backend:env.TBC_REVIEWED_ADMIN_BACKEND??'wasm',
}):undefined;
assert.ok(!rawMode||!installed||['0.1.0-candidate.222','0.1.0-candidate.223','0.1.0-candidate.224'].includes(expectedVersion),'Raw role wiring requires222 or later pinned package/source');
const verifyMaterial=!installed||['0.1.0-candidate.220','0.1.0-candidate.221','0.1.0-candidate.222','0.1.0-candidate.223','0.1.0-candidate.224'].includes(expectedVersion);
assert.ok(!controllerMode||!installed||['0.1.0-candidate.223','0.1.0-candidate.224'].includes(expectedVersion),'Controller package support requires223/224');
if(cooperativeMode){
 assert.ok(installed&&expectedVersion==='0.1.0-candidate.224');
 assert.equal(installed.evidence.tarSha256,'aabd2d0506e567ca8773c754d0b1f70614d8c7541f010dd0689bda937cd85079');
}
const directory=await mkdtemp(join(tmpdir(),'tbc-reviewed-admin-host-')),vectorsPath=join(directory,'public-vectors.json');
if(cooperativeMode){
 await writeFile(vectorsPath,JSON.stringify(reviewedAdminCooperativeFixture(root,{controller:controllerMode})),{flag:'wx'});
}else if(installed){
 assert.ok(env.TBC_REVIEWED_ADMIN_VECTORS&&env.TBC_REVIEWED_ADMIN_VECTORS_SHA256);
 const bytes=await readFile(env.TBC_REVIEWED_ADMIN_VECTORS);assert.equal(sha(bytes),env.TBC_REVIEWED_ADMIN_VECTORS_SHA256);
 await writeFile(vectorsPath,bytes,{flag:'wx'});
}else if(controllerMode){
 await writeFile(vectorsPath,JSON.stringify(reviewedAdminControllerFixture(root)),{flag:'wx'});
}else{
execFileSync('cargo',['test','--offline','--locked','-p','tbc-keyless-core','--test','reviewed_coin_admin'],{
 cwd:join(root,'packages/tbc-engine/rust'),env:{...process.env,TBC_REVIEWED_ADMIN_OUTPUT:vectorsPath},stdio:'pipe',timeout:60000});
}
const vectors=JSON.parse(await readFile(vectorsPath));
let kit;
if(installed)kit=installed.kit;
else{
const bundled=await build({stdin:{contents:`
export {createTbcDefaultAssociatedTransactionReviewer,createTbcDefaultRawTransactionReviewer} from './packages/kit/src/reviewed-transaction-reviewer.ts';
export {createTbcNetworkContext} from './packages/kit/src/network-context.ts';
export {createWasmTbcKeylessEngine} from './packages/kit/src/keyless.ts';
export {createTbcStandardWorkflowCapabilities} from './packages/kit/src/standard-workflow-capabilities.ts';
export {createApprovedHostTaskReader} from './packages/kit/src/approved-host-task.ts';
export {createApprovalHostEvidenceReader} from './packages/kit/src/approval-host-evidence.ts';
export {createTbcWallet} from './packages/kit/src/wallet-runtime.ts';
export {createMemoryTwsHostStore} from './packages/host/src/index.ts';
export {hashCanonical,assertValidTws} from './packages/core/src/index.ts';
export {TWS_RELEASE_FINGERPRINT} from './packages/core/src/release.ts';`,resolveDir:root},
 alias:{'@tbc-wallet/core':join(root,'packages/core/src/index.ts'),'@tbc-wallet/host':join(root,'packages/host/src/index.ts'),
 '@tbc-wallet/provider':join(root,'packages/provider/src/index.ts'),'@tbc-wallet/provider/in-memory':join(root,'packages/provider/src/in-memory.ts')},
 plugins:[{name:'parser',setup(b){b.onResolve({filter:/^\.\/vendor\/tbc-tx-parser\/index\.js$/},()=>({path:join(root,'packages/kit/dist/esm/vendor/tbc-tx-parser/index.js')}));}}],
 banner:{js:"import {createRequire as ar} from 'node:module'; const require=ar(import.meta.url);"},bundle:true,write:false,format:'esm',platform:'node',logLevel:'silent'});
const url=new URL('../../../packages/kit/src/.reviewed-admin-host-source.mjs',import.meta.url).href;
const hooks=registerHooks({resolve(s,c,n){return s===url?{url,shortCircuit:true}:n(s,c)},load(u,c,n){return u===url?{source:bundled.outputFiles[0].text,format:'module',shortCircuit:true}:n(u,c)}});
kit=await import(url);hooks.deregister();
}
const wasmBytes=await readFile(installed?join(env.TBC_REVIEWED_ADMIN_CONSUMER,'node_modules/@tbc/kit/artifacts/wasm/tbc_keyless_wasm.wasm'):
 join(root,'packages/tbc-engine/rust/target/wasm32-unknown-unknown/release/tbc_keyless_wasm.wasm'));
const native=installed?.native??await kit.createWasmTbcKeylessEngine(wasmBytes),require=createRequire(join(root,'package.json')),tbc=require('tbc-lib-js');
const oracle=rawMode?await loadTokenUnlockSdkOracle('/private/tmp/tbc-associated-upstream-LdkrwT',require):undefined;
globalThis.fetch=()=>{throw Error('External HTTP forbidden');};
const network=kit.createTbcNetworkContext({network:'testnet',endpoint:{kind:'trusted-custom',apiOrigin:'https://devapi.tbcdev.org',trustId:'public-fixture'}});
const identity=publicKey=>{const address=new tbc.PublicKey(publicKey).toAddress().toString();return {chainId:network.chainId,address,accountId:`${network.chainId}:${address}`,publicKey};};
const originalFee=identity(vectors.rows[0].prepare.publicKey),admin=identity('02'+vectors.rows[0].stage.signingTasks[0].publicKey);
const cooperativeSigner=cooperativeMode?await createCoinMuSigFixtureSigner(env.TBC_COIN_MUSIG_SIGNER_SDK,tbc,kit.hashCanonical):undefined;
if(cooperativeSigner)assert.equal(cooperativeSigner.publicKey,admin.publicKey);
// Public synthetic funding rebind only. Coin parents/proofs remain fixed SDK
// material. This is not an assertion that the SDK fixture had the same txid.
function sameAccountRequest(value){
 const r=structuredClone(value),source=new tbc.Transaction(r.sourceTxraw);
 const originals=new Map();for(const input of [r.sourceUtxos,...r.inputs].flat())for(const raw of [input.preTx,...(input.ancestorTransactions??[])].filter(Boolean)){
  const tx=new tbc.Transaction(raw);originals.set(tx.id,raw);
 }
 const oldScript=tbc.Script.buildPublicKeyHashOut(originalFee.address).toHex(),newScript=tbc.Script.buildPublicKeyHashOut(admin.address).toHex();
 r.sourceUtxos.forEach((input,index)=>{
  if(input.scriptSigType!=='p2pkh')return;
  const raw=input.preTx??originals.get(input.txId);assert.ok(raw,'synthetic fee parent required');
  const parent=new tbc.Transaction(raw);parent.outputs[input.outputIndex].setScript(tbc.Script.fromHex(newScript));
  input.preTx=parent.toString();input.txId=parent.id;input.script=newScript;source.inputs[index].prevTxId=Buffer.from(parent.id,'hex');
 });
 for(const output of source.outputs)if(output.script.toHex()===oldScript)output.setScript(tbc.Script.fromHex(newScript));
 r.sourceTxraw=source.toString();
 for(const output of r.outputs.flat())if(output.script===oldScript)output.script=newScript;
 return r;
}
const publicInput=i=>({outputIndex:i.outputIndex,signingProfile:i.scriptSigType,
 ...Object.fromEntries([['txId','txid'],['script','scriptPubKey'],['preTx','previousTransaction'],['ancestorTransactions','ancestorTransactions']].filter(([a])=>Object.hasOwn(i,a)).map(([a,b])=>[b,i[a]])),
 ...(Object.hasOwn(i,'satoshis')?{satoshis:String(i.satoshis)}:{}),...(i.signingPublicKey?{signingRole:'coin-admin'}:{})});
const rows=[];let vmInputs=0,negativeChecks=0,materialBindingChecks=0;
for(const [vectorIndex,vector] of vectors.rows.entries())for(const sameAccount of cooperativeMode?[false]:[false,true]){
 if(rawMode&&vector.prepare.request.inputs.length!==0)continue;
 const fee=sameAccount?admin:originalFee,accounts=sameAccount?[fee]:[fee,admin];
 const original=sameAccount?sameAccountRequest(vector.prepare.request):vector.prepare.request,parents=new Map();
 for(const input of [original.sourceUtxos,...original.inputs].flat())for(const raw of [input.preTx,...(input.ancestorTransactions??[])].filter(Boolean)){
  const p=new tbc.Transaction(raw);parents.set(p.id,p);
 }
 const request=rawMode?{payload:{format:'raw',transactions:[{rawTransaction:original.sourceTxraw,inputs:original.sourceUtxos.map(i=>({satoshis:String(i.satoshis),scriptPubKey:i.script,
  ...(i.signingPublicKey?{signingRole:'coin-admin'}:{})}))}]}}:{payload:{format:'associated',sourceTransaction:original.sourceTxraw,sourceInputs:original.sourceUtxos.map(publicInput),
  children:original.inputs.map((inputs,n)=>({inputs:inputs.map(publicInput),outputs:original.outputs[n].map(o=>({satoshis:String(o.satoshis),scriptPubKey:o.script}))}))}};
 const assetId='bc'.repeat(32),code=original.sourceUtxos.find(i=>i.scriptSigType==='tbc20-stablecoin').script;
 for(const method of ['tbc_signReviewedTransaction','tbc_signWorkflow','tbc_signPreparedWorkflow'])
 for(const decision of sameAccount?['approve']:['approve','reject','admin-change',...(vectorIndex===0?['review-change','prepare-change','prepare-expiry','after-sign-change','close','bad-signature','forged-call','missing-grant']:[])]){
  const now=new Date().toISOString().replace(/\.\d{3}Z$/u,'Z'),store=kit.createMemoryTwsHostStore({now:()=>Date.parse(now)});
  const approvedTasks=kit.createApprovedHostTaskReader({store,releaseFingerprint:kit.TWS_RELEASE_FINGERPRINT});
  const approvalEvidence=verifyMaterial?kit.createApprovalHostEvidenceReader({store,releaseFingerprint:kit.TWS_RELEASE_FINGERPRINT,parseApprovalRequest:value=>value}):undefined;
  let reads=0,approvals=0,stages=0,signs=0,atApproval=0,changed=false,expired=false,session,lastCall,lastParams,approvedMaterial,reviewFailure;
  const forbidden=async()=>{throw Error('Unexpected fixture IO');};
  const reviewer=(rawMode?kit.createTbcDefaultRawTransactionReviewer:kit.createTbcDefaultAssociatedTransactionReviewer)({network,materialNative:native,fetch:async(url,init)=>{
   reads++;if(decision==='review-change')changed=true;const u=new URL(String(url));assert.equal(u.origin,'https://devapi.tbcdev.org');let data;
   if(u.pathname==='/api/tbc/txo/status')data={txos:JSON.parse(init.body).txos.map(p=>{const o=parents.get(p.txid)?.outputs[Number(p.index)];assert.ok(o);return {txid:p.txid,index:String(p.index),value:String(o.satoshis),scriptPubKey:o.script.toHex(),spent:false,height:'1'};})};
   else if(u.pathname.includes('/decode/txid/')){const txid=u.pathname.split('/').at(-1),p=parents.get(txid);assert.ok(p);data={txid,contract_id:assetId,output:p.outputs.map((_,vout)=>({txid,vout}))};}
   else if(u.pathname.includes('/info/'))data={stablecoin_id:assetId,code_script:code};
   else throw Error('Unexpected read');return new Response(JSON.stringify({code:'200',data}),{status:200});
  }});
  const context={origin:'https://reviewed-admin.test',sessionId:'reviewed-admin',navigationId:'reviewed-admin'};
  const executionNative={protocolInfo:()=>native.protocolInfo(),execute:async(op,json)=>{
   const result=await native.execute(op,json);if(approvals&&op==='prepareReviewedStage'){
    if(decision==='prepare-change')changed=true;if(decision==='prepare-expiry')expired=true;
   }return result;
  }};
  const caps=kit.createTbcStandardWorkflowCapabilities({chainId:network.chainId,account:fee,networkSourceIdentity:'fixture',materialNative:executionNative,
   navigation:context,readCurrentAuthority:async()=>({...fee,networkSourceIdentity:'fixture',signingAccounts:changed?[]:[admin]}),
   rawReviewer:rawMode?reviewer:{review:forbidden},associatedReviewer:rawMode?{review:forbidden}:reviewer,now:()=>expired?new Date(Date.parse(now)+600000).toISOString():now,
   privateNative:{rawSigner:{sign:forbidden},associatedExecutor:{execute:forbidden},cryptoAdapter:{encrypt:forbidden,decrypt:forbidden}},
   reviewedRoleSigner:{approvedTasks,async signStage({tasks,evidence,stage,transactionIndex,material},call){
    assert.equal(approvals,1);assert.equal(evidence.task.purpose,'reviewedTransaction');assert.equal(evidence.callId,call.callId);
    assert.equal(call.execution.type,'session-only');
    assert.equal(transactionIndex,stages);stages++;
    assert.ok(Object.isFrozen(stage));
    if(verifyMaterial){
     assert.ok(Object.isFrozen(material)&&Object.isFrozen(material.request));
     assert.deepEqual(material,approvedMaterial);materialBindingChecks++;
    }
    assert.ok(tasks.some(t=>t.accountId===admin.accountId));
    const signatures=await Promise.all(tasks.map(async t=>{signs++;const scalar=t.accountId===admin.accountId?'02':'01',key=scalar.padStart(64,'0');
     assert.ok([fee.accountId,admin.accountId].includes(t.accountId));
     if(decision==='bad-signature')return '00'.repeat(64);
     if(cooperativeSigner&&t.accountId===admin.accountId){
      assert.equal(t.algorithm,'secp256k1-schnorr');
      return cooperativeSigner.sign({approval:lastParams.approval,task:{...t,
       algorithm:'secp256k1-schnorr-bip340',signatureEncoding:'schnorr64',
       reviewedBinding:evidence.bindingHash,callId:evidence.callId,transactionIndex,materialHash:kit.hashCanonical(material)}});
     }
     return t.algorithm==='secp256k1-schnorr'?Buffer.from(schnorr.sign(t.digest,key,new Uint8Array(32))).toString('hex'):
      secp256k1.sign(t.digest,key,{prehash:false,lowS:true}).toCompactHex();}));
    if(decision==='after-sign-change')changed=true;
    return signatures;
   }}});
  const execute=async(params,call)=>{
   lastCall=call;lastParams=params;
   if(decision==='forged-call'){
    const bad={...params,task:{...params.task,reviewHash:'00'.repeat(32)}};
    return caps.reviewedTransaction.execute(bad,call);
   }
   const result=await caps.reviewedTransaction.execute(params,call);
   await assert.rejects(caps.reviewedTransaction.execute(params,call),/consumed/);negativeChecks++;
   return result;
  };
  const permissions=['tbc_accounts','tbc_signTransaction','tbc_signWorkflow'].map(capability=>({id:capability,parentCapability:capability,invoker:context.origin,date:Date.parse(now),
   caveats:[{type:'restrictChains',value:[network.chainId]},{type:'restrictAccounts',value:(decision==='missing-grant'?[fee]:accounts).map(a=>a.accountId)},{type:'restrictMethods',value:[capability]}]}));
  const wallet=kit.createTbcWallet({legacy:false,accounts:{current:async()=>accounts},
   reviewedTransaction:{review:async(...args)=>{try{return await caps.reviewedTransaction.review(...args);}catch(error){reviewFailure=String(error.message);throw error;}},execute},approval:{supportedSigningRoles:['coin-admin'],async request(params,call){
    approvals++;atApproval=reads;
    if(verifyMaterial){
     const verified=await approvalEvidence.read(call.callId,params.binding.bindingHash);
     const task=verified.memory.workflowPlan?.payload?.reviewedTransactionTasks[0]??verified.memory.walletActionPlan.payload.task;
     approvedMaterial=await caps.resolveReviewedSigningMaterial(task);
     const bad=structuredClone(task);bad.requestHash='00'.repeat(32);
     await assert.rejects(caps.resolveReviewedSigningMaterial(bad));materialBindingChecks++;
    }
    if(decision==='admin-change')changed=true;if(decision==='close')session.close();
    if(decision==='reject')return {status:'rejected',bindingHash:params.binding.bindingHash,rejectedAt:now};
    const preview=method==='tbc_signReviewedTransaction'?params.preview:params.preview.steps[0].reviewedTransactionPreview;
    assert.deepEqual(preview.signingRoles,[{role:'coin-admin',account:admin}]);
    if(controllerMode){
     const locks=preview.coinLocks.filter(lock=>lock.controller?.type==='contract');
     assert.ok(locks.length>=2,'Contract controller input/output must be disclosed');
     for(const lock of locks){assert.equal(lock.controller.hash,'22'.repeat(20));assert.equal(lock.owner,undefined);}
     assert.ok(locks.some(lock=>lock.position==='input'&&lock.authorization==='administrator'&&lock.scriptLockChecked===false));
     const fakeAddress=tbc.Address.fromPublicKeyHash(Buffer.from('22'.repeat(20),'hex')).toString();
     assert.ok(!JSON.stringify(preview).includes(fakeAddress),'Contract hash must not become a wallet address');
    }
    return {status:'approved',approvalId:'review-admin',approvalToken:'public-fixture',bindingHash:params.binding.bindingHash,approvedAt:now,expiresAt:params.binding.payload.expiresAt};
   }},signer:{sign:forbidden},storage:{loadPermissions:async()=>({revision:'0',permissions}),commitPermissions:forbidden},
   network:{resolveChainData:forbidden,resolvePolicy:forbidden,broadcastSubmit:forbidden,broadcastReconcile:forbidden},clock:()=>now,randomBytes:n=>new Uint8Array(n).fill(1)});
  session=await wallet.openSession({origin:context.origin,sessionId:context.sessionId,execution:{hostStore:store}});
  try{
   const selection=sameAccount?{}:{signingRoles:[{role:'coin-admin',accountId:admin.accountId}]},base={version:'1.0',chainId:network.chainId,from:fee.address};
   const params=method==='tbc_signReviewedTransaction'?{...base,...selection,request}:{...base,steps:[{id:'admin',kind:'reviewedTransaction',dependsOn:[],...selection,request}]};
   const response=await session.handleRequest({id:'admin-fixture',method,params}).catch(e=>{if(decision==='close')return undefined;throw e;});
   if(decision==='approve'){
    assert.equal(response.response.error,undefined,JSON.stringify({error:response.response.error,reviewFailure,id:vector.id,sameAccount,method}));
    const result=method==='tbc_signReviewedTransaction'?response.response.result:response.response.result.steps[0].result;
    assert.equal(result.transactions.length,original.inputs.length+1);assert.equal(stages,original.inputs.length+1);
    const known=new Map(parents);
    for(const [transactionIndex,row]of result.transactions.entries()){const tx=new tbc.Transaction(row.rawTransaction);
     if(rawMode){
      assert.equal(row.rawTransaction,original.sourceTxraw);assert.equal(result.detachedSignatures.length,1);
      const unsigned=new tbc.Transaction(row.rawTransaction),sigs=result.detachedSignatures[transactionIndex];
      assert.equal(sigs.length,tx.inputs.length);
      tx.inputs.forEach((input,n)=>{input.output=known.get(input.prevTxId.toString('hex')).outputs[input.outputIndex];unsigned.inputs[n].output=input.output;});
      tx.inputs.forEach((input,n)=>{
       const item=original.sourceUtxos[n];
       if(item.signingPublicKey){
        const parent=known.get(input.prevTxId.toString('hex')),ancestry=new Map(item.ancestorTransactions.map(raw=>{const p=new tbc.Transaction(raw);return[p.id,p];})),groups=[];
        for(let k=0;k<tx.outputs.length;k++){if(tx.outputs[k].satoshis===500){groups.push({codeVout:k,tapeVout:k+1});k++;}else groups.push({codeVout:k});}
        input.setScript(oracle.coin({currentTx:unsigned,inputIndex:n,preTx:parent,preTxVout:input.outputIndex,ancestorTransactions:ancestry,
         outputGroups:groups,signature:Buffer.from(sigs[n],'hex'),publicKey:Buffer.from(item.signingPublicKey,'hex')}));
       }else input.setScript(tbc.Script.fromASM(`${sigs[n]} ${fee.publicKey}`));
      });
     }
     tx.inputs.forEach((input,n)=>{input.output=known.get(input.prevTxId.toString('hex')).outputs[input.outputIndex];assert.equal(tx.verifyScript(n).success,true);vmInputs++;});known.set(tx.id,tx);
    }
    await assert.rejects(approvedTasks.readReviewed(lastCall.callId,lastParams));negativeChecks++;
   }else{
    assert.ok(!response||response.response.error,decision);if(!['bad-signature','after-sign-change'].includes(decision))assert.equal(signs,0);
   }
   assert.equal(approvals,['review-change','missing-grant'].includes(decision)?0:1,JSON.stringify(response?.response?.error));
   assert.equal(reads,decision==='missing-grant'?0:4);if(approvals)assert.equal(reads,atApproval);
   rows.push({id:vector.id,sameAccount,method,decision,approvals,signs,stages,reads,postApprovalReads:approvals?reads-atApproval:0});
  }finally{session.close();}
 }
}
const paths=['packages/kit/src/approved-host-task.ts','packages/kit/src/reviewed-role-executor.ts','packages/kit/src/standard-workflow-capabilities.ts',
 'packages/kit/src/reviewed-coin-admin.ts','packages/kit/src/reviewed-transaction-reviewer.ts','packages/kit/src/reviewed-token-holder-flows.ts',
 'packages/kit/src/reviewed-lop-flows.ts','packages/core/src/reviewed-signing-roles.ts','schemas/reviewed-transaction.schema.json',
 'packages/tbc-engine/scripts/check-reviewed-admin-host-source.mjs','schemas/integration.schema.json',
 ...(controllerMode?['packages/tbc-engine/scripts/check-coin-proof-source.mjs','packages/tbc-engine/scripts/lib/reviewed-admin-controller-fixture.mjs']:[])];
// Raw: 48 scenarios, 42 reach approval and 18 reach custody. Every one
// independently checks bound material; do not derive this from the counter.
if(rawMode){assert.equal(rows.length,cooperativeMode?42:48);assert.equal(rows.reduce((n,row)=>n+row.approvals,0),cooperativeMode?36:42);assert.equal(rows.reduce((n,row)=>n+row.stages,0),cooperativeMode?12:18);}
if(cooperativeMode&&!rawMode)assert.equal(rows.length,51);
if(verifyMaterial){
 assert.equal(materialBindingChecks,rows.reduce((n,row)=>n+row.approvals+row.stages,0),'Every approval and custody stage must check bound material');
 // Separate fee payer only: removing the same-account child case removes two
 // stage checks per entry (parent + child), not one. Aggregate ECDSA fee keys
 // are not a capability of this upstream Coin-admin fixture.
 assert.equal(materialBindingChecks,cooperativeMode?(rawMode?48:63):(rawMode?60:84),'Approval/execution material checks cannot be skipped');
}
const report={status:installed?'PASS_INSTALLED_REVIEWED_ADMIN_HOST':'PASS_SOURCE_REVIEWED_ADMIN_HOST',at:new Date().toISOString(),rows,vmInputs,negativeChecks,materialBindingChecks,
 format:rawMode?'raw':'associated',controllerMode,cooperativeMode,cooperativeSigner:cooperativeSigner?.evidence(),wasmSha256:sha(wasmBytes),protocolFingerprint:kit.TWS_RELEASE_FINGERPRINT,
 ...(oracle?{sdk:{commit:oracle.commit,files:oracle.files}}:{}),
 ...(cooperativeMode?{fixtureProvenance:{upstream:vectors.upstream,upstreamVmInputs:vectors.upstreamVmInputs,
  helpers:Object.fromEntries(await Promise.all(['packages/tbc-engine/scripts/check-coin-proof-source.mjs',
   'packages/tbc-engine/scripts/lib/reviewed-admin-controller-fixture.mjs','packages/tbc-engine/scripts/lib/coin-musig-fixture-signer.mjs']
   .map(async p=>[p,sha(await readFile(join(root,p)))])))}}:{}),
 ...(installed?{installed:installed.evidence,acceptanceScriptSha256:sha(await readFile(fileURLToPath(import.meta.url))),vectorsSha256:sha(await readFile(vectorsPath))}:
 {sourceHashes:Object.fromEntries(await Promise.all(paths.map(async p=>[p,sha(await readFile(join(root,p)))])))}),
 actualHttp:0,broadcast:0,goalComplete:false,limitations:['Synthetic API and public scalar1/2 signer, no real custody',
 ...(cooperativeMode?['Aggregate admin with separate ordinary fee payer; not aggregate-key ECDSA fee account or holder authorization by a controller']:[]),
 installed?'Package execution only; no device or chain evidence':'No new immutable candidate, device or chain evidence']};
const body=JSON.stringify(report,null,2)+'\n',path=join(directory,'report.json');await writeFile(path,body,{flag:'wx'});
console.log(JSON.stringify({status:report.status,path,sha256:sha(body),rows:rows.length,vmInputs,negativeChecks}));
