import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {createRequire,registerHooks} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {join} from 'node:path';
import {build} from 'esbuild';
import {signControlledTask} from '../examples/shared/controlled-signer.mjs';
const root=fileURLToPath(new URL('../../../',import.meta.url));
const aliases=Object.fromEntries([['core','core/src/index.ts'],['host','host/src/index.ts'],['provider/in-memory','provider/src/in-memory.ts'],['provider','provider/src/index.ts'],['wallet-standard','wallet-standard/src/index.ts'],['tbc-engine/native','tbc-engine/src/native.ts'],['tbc-engine/wasm','tbc-engine/src/wasm.ts'],['tbc-engine','tbc-engine/src/index.ts']].map(([n,p])=>['@tbc-wallet/'+n,join(root,'packages',p)]));
const built=await build({stdin:{contents:`export {createTbcWallet} from './packages/kit/src/wallet-runtime.ts';export {createDefaultTbcChainDataResolver} from './packages/kit/src/default-chain-data.ts';export {createTbcProvider} from './packages/provider/src/index.ts';export {hashCanonical} from './packages/core/src/index.ts';export * from './packages/kit/src/client.ts';export * from './packages/kit/src/engine.ts';export {inspectTbcTransaction,turingTransactionId,assertTestnetAddress} from './packages/kit/src/testnet-validation.ts';`,resolveDir:root,loader:'ts'},bundle:true,write:false,format:'esm',platform:'node',alias:aliases,logLevel:'silent'});
const url=new URL('.nft-stress-source.mjs',import.meta.url).href;
const hook=registerHooks({resolve(s,c,n){return s===url?{url,shortCircuit:true}:n(s,c)},load(s,c,n){return s===url?{source:built.outputFiles[0].text,format:'module',shortCircuit:true}:n(s,c)}});
let kit=await import(url);hook.deregister();
if(process.env.TBC_TEST_INSTALLED_KIT){const p=process.env.TBC_TEST_INSTALLED_KIT;kit={...await import(pathToFileURL(join(p,'dist/esm/index.node.js'))),...await import(pathToFileURL(join(p,'dist/esm/wallet.node.js'))),...await import(pathToFileURL(join(p,'dist/esm/engine.node.js'))),...await import(pathToFileURL(join(p,'dist/esm/api.js')))};}
const wasm=process.env.TBC_TEST_WASM_DIR??join(root,'packages/kit/artifacts/wasm');
const backend=await kit.createWasmTbcEngineBackend(await readFile(join(wasm,'tbc_engine_wasm.wasm')));
const tbc=createRequire(import.meta.url)('tbc-lib-js');
const address='1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH',chainId='tbc:testnet',origin='https://nft-stress.example';
const account={address,chainId,accountId:chainId+':'+address,publicKey:'0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'};
const script=kit.assertTestnetAddress(address).scriptPubKey,slotScript=script+'6a0d5630204d696e74204e486f6c64';
const NOW=Date.parse('2026-11-01T00:00:00Z'),range=n=>Array.from({length:n},(_,i)=>i+1);
function raw(outputs){const tx=new tbc.Transaction().from({txId:'ab'.repeat(32),outputIndex:0,script,satoshis:10000000});tx.version=10;for(const output of outputs)tx.addOutput(new tbc.Transaction.Output(output));return tx.uncheckedSerialize();}
async function harness(count=100,options={}){
 let clock=NOW,approvals=0,signatures=0,policyCalls=0,accountCalls=0;
 const calls={index:0,native:0,raw:0,decoded:0,status:0,reconcile:0},accepted=[],dispatched=[],formal=[];
 const collection=raw([{satoshis:0,script:tbc.Script.buildSafeDataOut([Buffer.from(JSON.stringify({collectionName:'Stress',description:'public synthetic',supply:count,file:''})),Buffer.from('NTape')])},...range(count).map(()=>({satoshis:100,script:tbc.Script.fromHex(slotScript)}))]);
 const funding=raw([{satoshis:9000000,script:tbc.Script.fromHex(script)}]),collectionId=kit.turingTransactionId(collection),fundingId=kit.turingTransactionId(funding);
 const unused=async()=>{throw Error('Unexpected extra read')};
 const row=index=>({txid:collectionId,index:String(index),value:'100',scriptPubKey:slotScript});
 const accounts={current:async()=>{accountCalls++;return [account]}};
 const client={api:{poolInfo:unused,ftUtxosByCombineScript:unused,poolLpUtxosByScriptHash:unused,
  async utxosByScriptHash(){calls.index++;await options.readBarrier?.();return{utxos:range(count).map(row)}},
  async txoStatus(){calls.status++;throw Error('All slots already indexed')}},
  getFtUtxos:unused,getStablecoinUtxos:unused,getStablecoinInfo:unused,
  async getUtxos(){calls.native++;return{tip:{height:'1000',hash:'aa'.repeat(32)},utxos:[{txid:fundingId,vout:0,satoshis:'9000000',height:'0'}]}},
  async getRawTransactionBytes(id){calls.raw++;return id===collectionId?collection:id===fundingId?funding:await unused()},getRawTransaction:unused};
 const resolver=kit.createDefaultTbcChainDataResolver({accounts,client,confirmationPolicy:{minConfirmations:'0'},now:()=>clock,snapshotId:()=> 'stress-shared'});
 resolver.rememberFinalizedTransaction({txid:collectionId,rawTransaction:collection});resolver.rememberFinalizedTransaction({txid:fundingId,rawTransaction:funding});
 const permission=capability=>({id:'stress-'+capability,parentCapability:capability,invoker:origin,date:NOW,caveats:[{type:'restrictChains',value:[chainId]},{type:'restrictAccounts',value:[account.accountId]},{type:'restrictMethods',value:[capability]}]});
 const receipt=params=>({status:'approved',approvalId:'stress-consent',approvalToken:'stress-token',bindingHash:params.binding.bindingHash,approvedAt:new Date(clock).toISOString(),expiresAt:params.binding.payload.expiresAt});
 const baseEngine=kit.createTbcEngine({backend});const engine=Object.fromEntries(['normalizeRequest','plan','validate','finalize'].map(name=>[name,async p=>{try{const r=await baseEngine[name](p);return name==='plan'&&options.tamperPlan?options.tamperPlan(r):r}catch(e){if(process.env.TBC_STRESS_DIAG)console.log(name,e.message,e.rustCode);throw e}}]));
 const runtime=kit.createTbcWallet({accounts,engine,
  storage:{loadPermissions:async()=>({revision:'0',permissions:options.noPermission?[]:['tbc_accounts','tbc_sendTransaction','tbc_signTransaction'].map(permission)}),commitPermissions:async p=>({revisions:p.changes.map(({scope})=>({scope,revision:'1'}))})},
  network:{resolveChainData:async p=>{const r=await resolver.resolve(p);if(r.portError&&process.env.TBC_STRESS_DIAG)console.log('material',r.portError);return r},prepareNftMintJob:async(scope,a)=>{try{return await resolver.prepareNftMintJob(scope,a)}catch(e){if(process.env.TBC_STRESS_DIAG)console.log('job-material',e.message);throw e}},
   async resolvePolicy(){policyCalls++;const payload={version:'1.0',policyId:'stress',revision:'1',chainId,feeRateSatPerKb:'80',dustThreshold:'42',minConfirmations:'0',maxBundleTransactions:100,sighashType:65,contractPolicies:[],amountLimits:[{scope:'native',maximum:'2100000000000000'}],expiresAt:new Date(NOW+300000).toISOString()};return {payload,policyHash:kit.hashCanonical(payload)}},
   async broadcastSubmit(p){const i=dispatched.length;assert.ok(!dispatched.includes(p.transaction.txid),'no retransmission');dispatched.push(p.transaction.txid);
    if(options.rejectAt===i)return{txid:p.transaction.txid,status:'rejected'};
    if(options.unknownAt===i)return{portError:{name:'UNAVAILABLE',retryable:true,message:'controlled transport unknown'}};
    accepted.push(p.transaction.txid);if(options.expireAt===accepted.length)clock=NOW+120000;
    return{txid:p.transaction.txid,status:'accepted'};},
   async broadcastSubmitBatch(){throw Error('Not ordered')},
   async broadcastReconcile(p){calls.reconcile++;return{transactions:p.txids.map(txid=>({txid,status:dispatched.indexOf(txid)===options.unknownAt?(options.reconcileKnown?'mempool':'unknown'):'mempool'}))}},
  },
  ...(options.noAdapter?{}:{nftMintJob:{async approve({scope,scopeHash}){approvals++;await options.duringApprove?.(calls);const approvedAt=new Date(clock).toISOString();if(options.expireInApproval)clock=NOW+120000;return options.reject?{status:'rejected',scopeHash}:{status:'approved',scopeHash:options.badConsent?'ff'.repeat(32):scopeHash,approvalId:'stress-consent',approvedAt,expiresAt:scope.limits.expiresAt}},
   async authorizeBatch({params}){formal.push(params.binding.bindingHash);return receipt(params)}}}),
  approval:{async request(p){if(p.binding.payload.operationKind!=='permission')approvals++;return receipt(p)}},
  signer:{async sign(p){signatures++;return signControlledTask(p.task,'01'.padStart(64,'0'))}},clock:()=>new Date(clock).toISOString(),randomBytes:n=>Uint8Array.from({length:n},(_,i)=>i)});
 const session=await runtime.openSession({origin,sessionId:'stress'});
 let id=0;const provider=kit.createTbcProvider({requestIdFactory:()=>`stress-${++id}`,transport:{send:({id,method,params})=>session.handleRequest({id,method,params}),subscribe:()=>()=>{}}});
 const wallet=await kit.createTbcClient({network:'testnet',provider}).connect();
 const input={collectionId,items:range(count).map(slot=>({slot,name:'B'+slot,symbol:'N',description:'',attributes:[]})),limits:{maxTotalFee:'1000000',expiresAt:new Date(NOW+120000).toISOString()}};
 return {input,wallet,provider,session,calls,accepted,dispatched,formal,stats:()=>({approvals,signatures,policyCalls,accountCalls}),close(){provider.destroy();session.close()}};
}
test('real Engine/Host/Provider: 1/10/33/100/101/300 complete with one approval and identical read budget',async t=>{
 for(const count of [1,10,33,100,101,300]){
  const h=await harness(count),start=performance.now();try{const r=await h.wallet.tbc721.batchMint(h.input);
   assert.equal(r.status,'complete',JSON.stringify(r));assert.equal(r.minted,count);assert.equal(h.accepted.length,count);assert.equal(h.stats().approvals,1);assert.equal(h.stats().signatures,2*count);
   assert.deepEqual(h.calls,{index:1,native:1,raw:0,decoded:0,status:0,reconcile:0});assert.equal(new Set(h.formal).size,Math.ceil(count/10));
   t.diagnostic(JSON.stringify({count,ms:performance.now()-start,...h.stats(),reads:h.calls}));
  }finally{h.close()}
 }
});
test('expiry after 1/9/10/11/33 accepted: explicit partial result, no repeat or next batch',async()=>{
 for(const prefix of [1,9,10,11,33]){
  const h=await harness(40,{expireAt:prefix});try{const r=await h.wallet.tbc721.batchMint(h.input);
   assert.equal(r.status,'partial');assert.equal(r.reason,'expired',JSON.stringify(r));assert.equal(r.minted,prefix);assert.equal(h.dispatched.length,prefix);assert.equal(h.stats().approvals,1);
   assert.deepEqual(r.batches.flatMap(b=>b.transactions).filter(t=>['accepted','known'].includes(t.status)).map(t=>t.txid),h.accepted);
   assert.equal(h.calls.index,1);assert.equal(h.calls.native,1);
  }finally{h.close()}
 }
});
test('expiry before submission is explicit; no sign or broadcast after approval wait',async()=>{
 const h=await harness(100,{expireInApproval:true});try{const r=await h.wallet.tbc721.batchMint(h.input);assert.equal(r.reason,'expired');assert.equal(r.minted,0);assert.equal(h.stats().signatures,0);assert.equal(h.dispatched.length,0)}finally{h.close()}
});
test('actual Engine total-fee exhaustion preserves the successful prefix and a fee-budget reason',async()=>{
 for(const [maxTotalFee,minted]of [['0',0],['1000',10]]){
  const h=await harness(20);try{h.input.limits.maxTotalFee=maxTotalFee;const r=await h.wallet.tbc721.batchMint(h.input);
   assert.equal(r.reason,'fee-budget',JSON.stringify({reason:r.reason,minted:r.minted}));assert.equal(r.minted,minted);assert.equal(h.dispatched.length,minted);
   assert.ok(BigInt(r.confirmedSubmissionFee)<=BigInt(maxTotalFee));assert.equal(h.calls.index,1);assert.equal(h.calls.native,1);
  }finally{h.close()}
 }
});
test('invalid boundaries and unsupported exact input fail before reads/approval',async()=>{
 const h=await harness(2);try{
  for(const alter of [p=>p.items=[],p=>p.items=range(2001).map(slot=>({...p.items[0],slot})),p=>p.items[1].slot=1,p=>p.items[1].to='bad',p=>p.limits.maxItemsPerBatch=101,p=>p.limits.expiresAt='2026-02-30T00:00:00Z',p=>p.limits.maxTotalFee='-1']){
   const p=structuredClone(h.input);alter(p);await assert.rejects(h.wallet.tbc721.batchMint(p),e=>e.code===-32602);
  }assert.equal(h.calls.index,0);assert.equal(h.stats().approvals,0);assert.equal(h.stats().signatures,0);
 }finally{h.close()}
});
test('tampered consent and tampered Engine plan cannot sign or submit',async()=>{
 for(const options of [{badConsent:true},{tamperPlan:r=>{const copy=structuredClone(r);copy.plan.payload.preview.totalFee='1';return copy}}]){
  const h=await harness(2,options);try{
   if(options.badConsent)await assert.rejects(h.wallet.tbc721.batchMint(h.input));
   else{const r=await h.wallet.tbc721.batchMint(h.input);assert.equal(r.minted,0);assert.notEqual(r.status,'complete')}
   assert.equal(h.stats().signatures,0);assert.equal(h.dispatched.length,0);
  }finally{h.close()}
 }
});
test('concurrent tasks cannot share approval; cancellation before first effect is terminal',async()=>{
 let release,entered;const wait=new Promise(r=>release=r),ready=new Promise(r=>entered=r),abort=new AbortController();
 const h=await harness(2,{duringApprove:async()=>{entered();await wait}});
 try{
  const first=h.session.runNftMintJob({...h.input,signal:abort.signal});await ready;
  await assert.rejects(h.wallet.tbc721.batchMint(h.input),e=>e.code===-32000&&e.data.name==='CONFLICT'&&e.data.details.reason==='NFT_JOB_BUSY');
  abort.abort();release();const r=await first;assert.equal(r.reason,'cancelled');assert.equal(h.stats().approvals,1);assert.equal(h.stats().signatures,0);assert.equal(h.dispatched.length,0);
 }finally{release();h.close()}
});
test('2000-item hard-limit execution retains bounded resources and complete progress', {skip:!process.env.TBC_STRESS_MAX},async t=>{
 const h=await harness(2000),start=performance.now();try{const r=await h.wallet.tbc721.batchMint(h.input);
  assert.ok(['complete','resource-limit','expired'].includes(r.reason),r.reason);assert.equal(r.minted,h.accepted.length);assert.equal(h.stats().approvals,1);
  assert.equal(h.calls.index,1);assert.equal(h.calls.native,1);assert.equal(h.calls.raw,0);assert.equal(new Set(h.dispatched).size,h.dispatched.length);
  t.diagnostic(JSON.stringify({count:2000,status:r.status,reason:r.reason,minted:r.minted,ms:performance.now()-start,...h.stats(),reads:h.calls}));
 }finally{h.close()}
});
test('rejection/unknown/reconciled-known retain exact accepted prefix without re-send',async()=>{
 for(const options of [{rejectAt:3},{unknownAt:3},{unknownAt:3,reconcileKnown:true}]){
  const h=await harness(11,options);try{const r=await h.wallet.tbc721.batchMint(h.input);
   assert.equal(r.status,options.reconcileKnown?'complete':options.unknownAt!==undefined?'uncertain':'partial');
   assert.equal(r.minted,options.reconcileKnown?11:3);assert.equal(h.stats().approvals,1);assert.equal(new Set(h.dispatched).size,h.dispatched.length);
   assert.equal(h.calls.reconcile,options.unknownAt===undefined?0:1);
  }finally{h.close()}
 }
});
test('approval and material reads overlap; reject prevents signatures and submission',async()=>{
 let release;const wait=new Promise(r=>release=r);
 const h=await harness(101,{reject:true,readBarrier:()=>wait,duringApprove:async calls=>{await new Promise(r=>setImmediate(r));assert.equal(calls.index,1);assert.equal(calls.native,1);release()}});
 try{const r=await h.wallet.tbc721.batchMint(h.input);assert.equal(r.reason,'rejected');assert.equal(h.stats().approvals,1);assert.equal(h.stats().signatures,0);assert.equal(h.dispatched.length,0)}finally{release();h.close()}
});
test('unconfigured task adapter is typed and fails before any material, signer or submit',async()=>{
 const h=await harness(100,{noAdapter:true});try{await assert.rejects(h.wallet.tbc721.batchMint(h.input),e=>e.code===4200&&e.data.reason==='NFT_JOB_UNAVAILABLE');assert.equal(h.calls.index,0);assert.equal(h.stats().signatures,0)}finally{h.close()}
});
test('low-level send expiry is typed and includes accepted and unsubmitted IDs',async()=>{
 const h=await harness(4,{expireAt:2});try{
  await assert.rejects(h.provider.request({method:'tbc_sendTransaction',params:{version:'1.0',chainId,from:address,intent:{type:'tbc721-standard-batch-mint',version:'1.0',collectionId:h.input.collectionId,items:h.input.items},constraints:{maxFee:'1000000',expiresAt:h.input.limits.expiresAt}}}),e=>{
   assert.equal(e.code,4100,JSON.stringify(e));assert.equal(e.data.reason,'RECEIPT_EXPIRED');assert.deepEqual(e.data.submittedTransactionIds,h.accepted);assert.equal(e.data.notSubmittedTransactionIds.length,2);assert.deepEqual(e.data.uncertainTransactionIds,[]);return true});
 }finally{h.close()}
});
