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
const built=await build({stdin:{contents:`export {createTbcNetworkContext} from './packages/kit/src/network-context.ts';export {createTbcWallet} from './packages/kit/src/wallet-runtime.ts';export {createDefaultTbcChainDataResolver} from './packages/kit/src/default-chain-data.ts';export {createTbcProvider} from './packages/provider/src/index.ts';export {hashCanonical} from './packages/core/src/index.ts';export * from './packages/kit/src/client.ts';export * from './packages/kit/src/engine.ts';export {inspectTbcTransaction,turingTransactionId,assertTestnetAddress} from './packages/kit/src/testnet-validation.ts';`,resolveDir:root,loader:'ts'},bundle:true,write:false,format:'esm',platform:'node',alias:aliases,logLevel:'silent'});
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
 const accounts={current:async()=>{accountCalls++;return options.accounts?.(accountCalls)??[account]}};
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
    await options.afterSubmit?.({index:i,txid:p.transaction.txid,setClock:v=>clock=v});
    return options.submitResult?.(p,i)??{txid:p.transaction.txid,status:'accepted'};},
   async broadcastSubmitBatch(){throw Error('Not ordered')},
   async broadcastReconcile(p){calls.reconcile++;return options.reconcileResult?.(p)??{transactions:p.txids.map(txid=>({txid,status:dispatched.indexOf(txid)===options.unknownAt?(options.reconcileKnown?'mempool':'unknown'):'mempool'}))}},
  },
  ...(options.noAdapter?{}:{nftMintJob:{async approve({scope,scopeHash}){approvals++;await options.duringApprove?.(calls);const approvedAt=new Date(clock).toISOString();if(options.expireInApproval)clock=NOW+120000;return options.reject?{status:'rejected',scopeHash}:{status:'approved',scopeHash:options.badConsent?'ff'.repeat(32):scopeHash,approvalId:'stress-consent',approvedAt,expiresAt:scope.limits.expiresAt}},
   async authorizeBatch({params}){formal.push(params.binding.bindingHash);await options.beforeAuthorize?.({index:formal.length,setClock:v=>clock=v});return receipt(params)}}}),
  approval:{async request(p){if(p.binding.payload.operationKind!=='permission')approvals++;return receipt(p)}},
  signer:{async sign(p){signatures++;await options.beforeSign?.({index:signatures,setClock:v=>clock=v});return signControlledTask(p.task,'01'.padStart(64,'0'))}},clock:()=>new Date(clock).toISOString(),randomBytes:n=>Uint8Array.from({length:n},(_,i)=>i)});
 const session=await runtime.openSession({origin,sessionId:'stress'});
 let id=0;const provider=kit.createTbcProvider({requestIdFactory:()=>`stress-${++id}`,transport:{send:({id,method,params})=>session.handleRequest({id,method,params}),subscribe:()=>()=>{}}});
 const wallet=await kit.createTbcClient({network:'testnet',provider}).connect();
 const input={collectionId,items:range(count).map(slot=>({slot,name:'B'+slot,symbol:'N',description:'',attributes:[]})),limits:{maxTotalFee:'1000000',expiresAt:new Date(NOW+120000).toISOString()}};
 return {input,wallet,provider,session,runtime,calls,accepted,dispatched,formal,setClock:v=>clock=v,stats:()=>({approvals,signatures,policyCalls,accountCalls}),close(){provider.destroy();session.close()}};
}

export {kit,harness,address,chainId,origin,account,NOW,range};

