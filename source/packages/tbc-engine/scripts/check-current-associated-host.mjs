// Source Core/Host, current holder reviewer and real WASM. Public fixture keys
// only. No external network, real custody, device, persistence or broadcast.
import assert from 'node:assert/strict';
import {readFile,mkdtemp,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {registerHooks,createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {build} from 'esbuild';
import {secp256k1} from '@noble/curves/secp256k1.js';
import {loadHolderInstalledHarness} from './lib/holder-installed-harness.mjs';

const root=fileURLToPath(new URL('../../../',import.meta.url)),sha=b=>createHash('sha256').update(b).digest('hex');
const env=process.env,expectedVersion=env.TBC_ASSOCIATED_VERSION??'0.1.0-candidate.215';
assert.ok(['0.1.0-candidate.215','0.1.0-candidate.216','0.1.0-candidate.218'].includes(expectedVersion));
const installed=env.TBC_ASSOCIATED_CONSUMER?await loadHolderInstalledHarness({consumer:env.TBC_ASSOCIATED_CONSUMER,
 archive:env.TBC_ASSOCIATED_ARCHIVE,expectedSha:env.TBC_ASSOCIATED_ARCHIVE_SHA256,expectedVersion,
 entry:env.TBC_ASSOCIATED_ENTRY??'node',backend:env.TBC_ASSOCIATED_BACKEND??'wasm'}):undefined;
const dir=await mkdtemp(join(tmpdir(),'tbc-associated-host-')),vectorsPath=join(dir,'public-vectors.json');
if(installed){
 assert.ok(env.TBC_ASSOCIATED_VECTORS&&env.TBC_ASSOCIATED_VECTORS_SHA256);
 const bytes=await readFile(env.TBC_ASSOCIATED_VECTORS);assert.equal(sha(bytes),env.TBC_ASSOCIATED_VECTORS_SHA256);
 await writeFile(vectorsPath,bytes,{flag:'wx'});
}else{
execFileSync('cargo',['test','--offline','--locked','-p','tbc-keyless-core','--test','reviewed_current_token'],{
 cwd:join(root,'packages/tbc-engine/rust'),env:{...process.env,TBC_CURRENT_ASSOCIATED_OUTPUT:vectorsPath},stdio:'pipe',timeout:60000});
}
const vectors=JSON.parse(await readFile(vectorsPath));
let kit;
if(installed)kit=installed.kit;
else{
const bundled=await build({stdin:{contents:`
export {createTbcDefaultAssociatedTransactionReviewer,materializeAssociatedReviewRequest} from './packages/kit/src/reviewed-transaction-reviewer.ts';
export {createTbcNetworkContext} from './packages/kit/src/network-context.ts';
export {createWasmTbcKeylessEngine} from './packages/kit/src/keyless.ts';
export {createTbcStandardWorkflowCapabilities,normalizeTbcReviewedTransactionMaterial} from './packages/kit/src/standard-workflow-capabilities.ts';
export {hashCanonical,assertValidTws} from './packages/core/src/index.ts';
export {TWS_RELEASE_FINGERPRINT} from './packages/core/src/release.ts';
export {createTbcWallet} from './packages/kit/src/wallet-runtime.ts';
export {createApprovalHostEvidenceReader} from './packages/kit/src/approval-host-evidence.ts';
export {projectTbcApprovalPresentation} from './packages/kit/src/approval-presentation.ts';
export {createMemoryTwsHostStore} from './packages/host/src/index.ts';
`,resolveDir:root,loader:'ts'},alias:{'@tbc-wallet/core':root+'packages/core/src/index.ts','@tbc-wallet/host':root+'packages/host/src/index.ts',
 '@tbc-wallet/provider':root+'packages/provider/src/index.ts','@tbc-wallet/provider/in-memory':root+'packages/provider/src/in-memory.ts'},
 plugins:[{name:'parser',setup(b){b.onResolve({filter:/^\.\/vendor\/tbc-tx-parser\/index\.js$/},()=>({path:root+'packages/kit/dist/esm/vendor/tbc-tx-parser/index.js'}));}}],
 banner:{js:"import {createRequire as ar} from 'node:module'; const require=ar(import.meta.url);"},bundle:true,write:false,format:'esm',platform:'node',logLevel:'silent'});
const url=new URL('../../../packages/kit/src/.current-associated-host-source.mjs',import.meta.url).href;
const hooks=registerHooks({resolve(s,c,n){return s===url?{url,shortCircuit:true}:n(s,c)},load(u,c,n){return u===url?{source:bundled.outputFiles[0].text,format:'module',shortCircuit:true}:n(u,c)}});
kit=await import(url);hooks.deregister();
}
const wasmBytes=await readFile(installed?join(env.TBC_ASSOCIATED_CONSUMER,'node_modules/@tbc/kit/artifacts/wasm/tbc_keyless_wasm.wasm'):
 join(root,'packages/tbc-engine/rust/target/wasm32-unknown-unknown/release/tbc_keyless_wasm.wasm'));
const native=installed?.native??await kit.createWasmTbcKeylessEngine(wasmBytes),require=createRequire(join(root,'package.json')),tbc=require('tbc-lib-js');
const key=new tbc.PrivateKey(new tbc.crypto.BN(1)),address=key.toAddress().toString();
globalThis.fetch=()=>{throw Error('External HTTP forbidden');};
const network=kit.createTbcNetworkContext({network:'testnet',endpoint:{kind:'trusted-custom',apiOrigin:'https://devapi.tbcdev.org',trustId:'public-fixture'}});
const account={chainId:network.chainId,accountId:network.chainId+':'+address,address,publicKey:key.publicKey.toString()};
function publicInput(i){const out={outputIndex:i.outputIndex,signingProfile:i.scriptSigType};
 for(const [from,to]of [['txId','txid'],['script','scriptPubKey'],['preTx','previousTransaction'],['ancestorTransactions','ancestorTransactions']])if(Object.hasOwn(i,from))out[to]=i[from];
 if(Object.hasOwn(i,'satoshis'))out.satoshis=String(i.satoshis);return out;}
function standard(r){return {payload:{format:'associated',sourceTransaction:r.sourceTxraw,sourceInputs:r.sourceUtxos.map(publicInput),
 children:r.inputs.map((inputs,n)=>({inputs:inputs.map(publicInput),outputs:r.outputs[n].map(o=>({satoshis:String(o.satoshis),scriptPubKey:o.script}))}))}};}
const hostRows=[],negativeRows=[];let vmInputs=0;
const withLocks=!installed||expectedVersion==='0.1.0-candidate.218';
const lockCases=withLocks?vectors.rows.filter(r=>/^coin-lock-(height|time)-source-false$/.test(r.id)):[];
if(withLocks)assert.equal(lockCases.length,2);
const externalCases=withLocks?vectors.rows.filter(r=>/^coin-external-(height|time)-source$/.test(r.id)):[];
if(withLocks)assert.equal(externalCases.length,2);
const cases=[...vectors.rows.slice(0,6),...vectors.rows.filter(r=>r.id.endsWith('-parent-false')),...lockCases,...externalCases];assert.equal(cases.length,withLocks?12:8);
for(const vector of cases){
 const original=vector.prepare.request,request=standard(original),parents=new Map(vector.parents.map(raw=>{const p=new tbc.Transaction(raw);return[p.id,p];}));
 const allInputs=[original.sourceUtxos,...original.inputs].flat().filter(i=>i.script);
 const codes=JSON.parse(await native.execute('inspectTokenMaterial',JSON.stringify({phase:'inspectCodes',scripts:allInputs.map(i=>i.script)}))).codes;
 const selected=codes.findIndex(Boolean),code=codes[selected],assetScript=allInputs[selected].script;
 const assetInput=r=>[r.sourceUtxos,...r.inputs].flat().filter(i=>i.script)[selected];
 const feeInput=r=>[r.sourceUtxos,...r.inputs].find(row=>row.some(i=>i.scriptSigType===code.standardId)).find(i=>i.scriptSigType==='p2pkh');
 const assetId=code.originalOutpoint?.txid??'ab'.repeat(32);let reads=0,proofCalls=0,onRead;
 const tracked={protocolInfo:()=>native.protocolInfo(),execute:(op,json)=>{if(op==='prepareReviewedStage')proofCalls++;return native.execute(op,json);}};
 const reviewer=kit.createTbcDefaultAssociatedTransactionReviewer({network,materialNative:tracked,fetch:async(url,init)=>{
  reads++;if(onRead){const hook=onRead;onRead=undefined;hook();}const u=new URL(String(url));assert.equal(u.origin,'https://devapi.tbcdev.org');let data;
  if(u.pathname==='/api/tbc/txo/status')data={txos:JSON.parse(init.body).txos.map(p=>{const o=parents.get(p.txid)?.outputs[Number(p.index)];assert.ok(o,'must not query provisional child txids');
   return {txid:p.txid,index:String(p.index),value:String(o.satoshis),scriptPubKey:o.script.toHex(),spent:false,height:'1'};})};
  else if(u.pathname.includes('/decode/txid/')){const id=u.pathname.split('/').at(-1),p=parents.get(id);assert.ok(p,'must reuse source asset identity');
   data={txid:id,contract_id:assetId,output:p.outputs.map((_,vout)=>({txid:id,vout}))};}
  else if(u.pathname.includes('/info/'))data={stablecoin_id:assetId,code_script:assetScript};
  else throw Error('Unexpected read');return new Response(JSON.stringify({code:'200',data}),{status:200});
 }});
 const context={origin:'https://associated.test',chainId:network.chainId,accountId:account.accountId,sessionId:'associated',navigationId:'associated'};
 const before=reads,pbefore=proofCalls;
 const review=await reviewer.review({request:original,operationDigest:kit.hashCanonical({kind:'signAssociated',request:original}),context,publicKey:account.publicKey});
 assert.equal(reads-before,4);assert.equal(proofCalls-pbefore,original.inputs.length+1);
 assert.equal(review.preview.transactions.length,original.inputs.length+1);
 for(const [index,r]of review.preview.transactions.entries()){assert.equal(r.txidKind,'unsigned-preview');
  if(!vector.id.startsWith('coin-external-')||index!==0)assert.ok(r.groups.some(g=>g.asset.contractId===assetId));}
 if(vector.id.startsWith('coin-lock-')||vector.id.startsWith('coin-external-')){
  const locks=review.preview.transactions[1].coinLocks;assert.ok(locks.length>=2);
  assert.ok(locks.some(l=>l.lockTime>0));assert.ok(locks.every(l=>l.chainMaturityChecked===false));
 }
 for(const label of ['missing-key','wrong-key','missing-ancestors','unrelated-ancestor','wrong-profile','generic-template','wrong-fee-profile','changed-proof-parent']){
  const bad=structuredClone(original),asset=assetInput(bad);let publicKey=account.publicKey;
  if(label==='missing-key')publicKey=undefined;
  if(label==='wrong-key')publicKey='02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5';
  if(label==='missing-ancestors')delete asset.ancestorTransactions;
  if(label==='unrelated-ancestor')asset.ancestorTransactions.push(original.sourceTxraw);
  if(label==='wrong-profile')asset.scriptSigType=code.standardId==='tbc20-standard'?'tbc20-stablecoin':'tbc20-standard';
  if(label==='generic-template'){asset.scriptSigType='other';asset.unfinishedScriptSig='097369676e6174757265';}
  if(label==='wrong-fee-profile')feeInput(bad).scriptSigType='other';
  if(label==='changed-proof-parent')asset.preTx=original.sourceTxraw;
  const expected=['missing-key','wrong-key'].includes(label)?/bound wallet public key/:
   ['wrong-profile','generic-template','wrong-fee-profile'].includes(label)?/profile/:
   label==='changed-proof-parent'?/parent identity mismatch/:/ancestor|proof invalid/;
  await assert.rejects(reviewer.review({request:bad,operationDigest:kit.hashCanonical({kind:'signAssociated',request:bad}),context,...(publicKey?{publicKey}:{})}),expected);
  negativeRows.push({id:vector.id,label});
 }
 const mutable=structuredClone(original);
 onRead=()=>{assetInput(mutable).ancestorTransactions.length=0;};
 await reviewer.review({request:mutable,operationDigest:kit.hashCanonical({kind:'signAssociated',request:mutable}),context,publicKey:account.publicKey});
 assert.equal(assetInput(mutable).ancestorTransactions.length,0);
 for(const workflow of [false,true])for(const decision of ['approve','reject','close','account-change']){
  const now=new Date().toISOString().replace(/\.\d{3}Z$/u,'Z'),store=kit.createMemoryTwsHostStore({now:()=>Date.parse(now)});
  const evidence=kit.createApprovalHostEvidenceReader({store,releaseFingerprint:kit.TWS_RELEASE_FINGERPRINT,
   parseApprovalRequest(value){kit.assertValidTws('approvalRequestParams',value);return value;}});
  let session,approvals=0,executions=0,readsAtApproval=0,proofsAtApproval=0,finalRaws=[];
  const forbidden=async()=>{throw Error('Unexpected fixture IO');};
  const caps=kit.createTbcStandardWorkflowCapabilities({chainId:network.chainId,account,networkSourceIdentity:'fixture',materialNative:tracked,
   navigation:context,readCurrentAuthority:async()=>({...account,networkSourceIdentity:'fixture',
    ...(decision==='account-change'&&approvals?{publicKey:'02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5'}:{})}),
   rawReviewer:{review:forbidden},associatedReviewer:reviewer,now:()=>now,
   privateNative:{rawSigner:{sign:forbidden},cryptoAdapter:{encrypt:forbidden,decrypt:forbidden},associatedExecutor:{async execute({request:actual,operationDigest,policyMaterial}){
    assert.equal(approvals,1);assert.equal(decision,'approve');executions++;
    assert.equal(operationDigest,kit.hashCanonical({kind:'signAssociated',request:actual}));assert.deepEqual(actual,original);
    const known=new Map(parents);
    for(let index=0;index<actual.inputs.length+1;index++){
     const stage=JSON.parse(await tracked.execute('prepareReviewedStage',JSON.stringify({format:'associated',publicKey:account.publicKey,
      request:actual,transactionIndex:index,previousTransactions:finalRaws,resolvedOutputs:policyMaterial.resolvedOutputs})));
     const signatures=stage.digests.map(d=>secp256k1.sign(d,key.toBuffer(),{prehash:false,lowS:true}).toCompactHex());
     const result=JSON.parse(await native.execute('finalizeReviewedStage',JSON.stringify({stage,signatures,signatureEncoding:'compact64'})));
     const tx=new tbc.Transaction(result.txraw);tx.inputs.forEach((i,n)=>{i.output=known.get(i.prevTxId.toString('hex')).outputs[i.outputIndex];assert.equal(tx.verifyScript(n).success,true);vmInputs++;});
     known.set(tx.id,tx);finalRaws.push(result.txraw);
    }
    return {txraws:finalRaws};
   }}}});
  const permissions=['tbc_accounts','tbc_signTransaction','tbc_signWorkflow'].map(method=>({id:method,parentCapability:method,invoker:context.origin,date:Date.parse(now),
   caveats:[{type:'restrictChains',value:[network.chainId]},{type:'restrictAccounts',value:[account.accountId]},{type:'restrictMethods',value:[method]}]}));
  const wallet=kit.createTbcWallet({legacy:false,accounts:{current:async()=>[account]},reviewedTransaction:caps.reviewedTransaction,
   approval:{async request(params,call){approvals++;readsAtApproval=reads;proofsAtApproval=proofCalls;assert.equal(call.execution.type,'session-only');
    const model=kit.projectTbcApprovalPresentation(await evidence.read(call.callId,params.binding.bindingHash));assert.equal(model.trust,'binding-verified');
    assert.equal(model.counts.transactions.value,original.inputs.length+1);
    if(decision==='close')session.close();
    return decision==='reject'?{status:'rejected',bindingHash:params.binding.bindingHash,rejectedAt:now}:
     {status:'approved',approvalId:'current-associated',approvalToken:'public-test',bindingHash:params.binding.bindingHash,approvedAt:now,expiresAt:params.binding.payload.expiresAt};}},
   signer:{sign:forbidden},storage:{loadPermissions:async()=>({revision:'0',permissions}),commitPermissions:forbidden},
   network:{resolveChainData:forbidden,resolvePolicy:forbidden,broadcastSubmit:forbidden,broadcastReconcile:forbidden},clock:()=>now,
   randomBytes:n=>Uint8Array.from({length:n},(_,i)=>i)});
  session=await wallet.openSession({origin:context.origin,sessionId:context.sessionId,execution:{hostStore:store}});
  try{
   const params=workflow?{version:'1.0',chainId:network.chainId,from:address,steps:[{id:'holder',kind:'reviewedTransaction',dependsOn:[],request}]}:
    {version:'1.0',chainId:network.chainId,from:address,request};
   const envelope={id:'associated',method:workflow?'tbc_signWorkflow':'tbc_signReviewedTransaction',params},before=reads,pc=proofCalls;
   const delivery=await session.handleRequest(envelope).catch(error=>{if(decision==='close')return undefined;throw error;});
   assert.equal(approvals,1,JSON.stringify(delivery?.response?.error));assert.equal(executions,decision==='approve'?1:0,JSON.stringify(delivery?.response?.error));
   assert.equal(readsAtApproval-before,4);assert.equal(reads,readsAtApproval);assert.equal(proofsAtApproval-pc,original.inputs.length+1);
   if(decision==='approve'){
    assert.equal(delivery.response.error,undefined,JSON.stringify(delivery.response.error));
    const result=workflow?delivery.response.result.steps[0].result:delivery.response.result;
    assert.deepEqual(result.transactions.map(t=>t.rawTransaction),finalRaws);
   }else assert.ok(!delivery||delivery.response.error);
   session.close();const closed=await session.handleRequest({...envelope,id:'closed'}).catch(()=>undefined);
   assert.ok(!closed||closed.response.error);assert.equal(approvals,1);assert.equal(reads,readsAtApproval);
   hostRows.push({id:vector.id,workflow,decision,approvals,executions,transactions:original.inputs.length+1,reads:4,postApprovalReads:0,proofsBeforeApproval:proofsAtApproval-pc,sessionOnly:true});
  }finally{session.close();}
 }
}
assert.equal(hostRows.length,withLocks?96:64);assert.equal(negativeRows.length,withLocks?96:64);assert.equal(vmInputs,withLocks?86:50);
const paths=['packages/kit/src/reviewed-transaction-types.ts','packages/kit/src/reviewed-transaction-reviewer.ts',
 'packages/kit/src/reviewed-token-holder-flows.ts','packages/kit/src/reviewed-lop-flows.ts','packages/kit/src/standard-workflow-capabilities.ts',
 'packages/tbc-engine/scripts/check-current-associated-host.mjs'];
const report={status:installed?'PASS_INSTALLED_CURRENT_ASSOCIATED_HOST':'PASS_SOURCE_CURRENT_ASSOCIATED_HOST',at:new Date().toISOString(),hostRows,negativeRows,vmInputs,
 ...(installed?{installed:installed.evidence,acceptanceScriptSha256:sha(await readFile(join(root,paths.at(-1))))}:
 {sourceHashes:Object.fromEntries(await Promise.all(paths.map(async p=>[p,sha(await readFile(join(root,p)))])))}),
 sourceWasmSha256:sha(wasmBytes),protocolFingerprint:kit.TWS_RELEASE_FINGERPRINT,vectorsPath,actualHttp:0,broadcast:0,
 scope:installed?'Installed Core/Host and Engine, synthetic API and public scalar1 signer; no device or chain acceptance':
 'Source Core/Host, synthetic official API, public scalar1 signer, real source WASM and independent VM; not installed or chain acceptance',goalComplete:false};
const path=join(dir,'report.json'),body=JSON.stringify(report,null,2)+'\n';await writeFile(path,body,{flag:'wx'});
console.log(JSON.stringify({status:report.status,path,sha256:sha(body),hostRows:hostRows.length,negativeCases:negativeRows.length,vmInputs}));
