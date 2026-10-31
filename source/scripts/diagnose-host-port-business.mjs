// Read-only reproduction of the reported rc.20 public inputs. Never signs/posts.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire, registerHooks } from 'node:module';
import { build } from 'esbuild';
import { join, resolve } from 'node:path';
const root=resolve(import.meta.dirname,'..');
const built=await build({stdin:{contents:`
export {createDefaultTbcTestnetNetwork} from './packages/kit/src/default-network.ts';
export {createWasmTbcKeylessEngine} from './packages/kit/src/keyless.ts';
export {createTbcEngine,createWasmTbcEngineBackend} from './packages/kit/src/engine.ts';
export {chainDataRequirement,hashCanonical,assertValidTws} from './packages/core/src/index.ts';
export {dispatchHostPort} from './packages/host/src/port-dispatch.ts';
export {createMemoryTwsHostStore} from './packages/host/src/index.ts';
export {createTbcWallet} from './packages/kit/src/wallet-runtime.ts';
export {createTbcClient} from './packages/kit/src/client.ts';
`,resolveDir:root,loader:'ts'},bundle:true,write:false,platform:'node',format:'esm',logLevel:'silent',alias:{
 '@tbc-wallet/core':join(root,'packages/core/src/index.ts'),
 '@tbc-wallet/host':join(root,'packages/host/src/index.ts'),
 '@tbc-wallet/provider/in-memory':join(root,'packages/provider/src/in-memory.ts'),
 '@tbc-wallet/provider':join(root,'packages/provider/src/index.ts'),
 '@tbc-wallet/wallet-standard':join(root,'packages/wallet-standard/src/index.ts'),
 '@tbc-wallet/tbc-engine/native':join(root,'packages/tbc-engine/src/native.ts'),
 '@tbc-wallet/tbc-engine/wasm':join(root,'packages/tbc-engine/src/wasm.ts'),
 '@tbc-wallet/tbc-engine':join(root,'packages/tbc-engine/src/index.ts'),
}});
const url=new URL('./.diagnose-runtime.mjs',import.meta.url).href;
const hooks=registerHooks({resolve(s,c,n){return s===url?{url,shortCircuit:true}:n(s,c)},load(u,c,n){return u===url?{source:built.outputFiles[0].text,format:'module',shortCircuit:true}:n(u,c)}});
const kit=await import(url);hooks.deregister();
const tbc=createRequire(import.meta.url)('tbc-lib-js');
const origin='https://api.tbcdev.org',address='164nB7hUpDSx3neWu293wKqW1sRNBg1e3X';
const trace=[];
async function readonlyFetch(input,init){
 const u=new URL(String(input));assert.equal(u.origin,origin);assert.equal(init?.method??'GET','GET');
 const start=performance.now();const response=await fetch(input,{...init,signal:AbortSignal.timeout(20000)});
 trace.push({path:u.pathname,ms:Math.round(performance.now()-start),status:response.status});return response;
}
const successful='3d1875251f4cb3d479871c428102573dc42fdbf2954fe8b0909cce00ac6933ce';
const response=await readonlyFetch(`${origin}/api/tbc/txraw/txid/${successful}`),body=await response.json();
const tx=new tbc.Transaction(body.data.txraw);
const publicKeys=tx.inputs.flatMap(i=>i.script.chunks.filter(c=>c.buf?.length===33).map(c=>c.buf.toString('hex')));
const publicKey=publicKeys.find(hex=>{try{return /^(02|03)/.test(hex)&&new tbc.PublicKey(hex).toAddress().toString()===address}catch{return false}});
assert.ok(publicKey,'Reported transaction must expose the reported account public key');
const account={accountId:`tbc:testnet:${address}`,chainId:'tbc:testnet',address,publicKey};
const assets=process.env.TBC_TEST_WASM_DIR??join(root,'packages/kit/artifacts/wasm');
const native=await kit.createWasmTbcKeylessEngine(await readFile(join(assets,'tbc_keyless_wasm.wasm')));
const engine=kit.createTbcEngine({backend:await kit.createWasmTbcEngineBackend(await readFile(join(assets,'tbc_engine_wasm.wasm')))});
const network=kit.createDefaultTbcTestnetNetwork({accounts:{current:async()=>[account]},fetch:readonlyFetch,poolNative:native,
 broadcast:{submit(){throw Error('Broadcast forbidden')},reconcile(){throw Error('Not required')}},snapshotId:()=>`readonly-${Date.now()}`});
const poolContractId='8c53ed166e6f68c65f0d70a0a05d7b4766ac5fa9ebff15ecac2ce00aaf348a78';
if(process.argv.includes('--replay')){
 const ftId='ed722043633ee989c86b72bf60b63c9728bd2a710e13749c5d76103f203c05f0';
 const ft=await (await readonlyFetch(`${origin}/api/tbc/ft/info/contract/${ftId}`)).json();
 const pool=JSON.parse(await native.execute('inspectAmmMaterial',JSON.stringify({phase:'inspectPool',pool:{txid:successful,rawTransaction:body.data.txraw}})));
 const gross=BigInt(pool.state.tbcAmount)/(BigInt(pool.state.ftAmount)+1n);
 const rates=pool.feePolicy,total=BigInt(rates.lpFeeRate+rates.taxFeeRate+rates.serviceProviderFeeRate+rates.protocolFeeRate);
 console.log(JSON.stringify({stage:'historical-funded-state',state:pool.state,feePolicy:rates,
  sellOne:{grossAtomic:String(gross),totalFeeAtomic:String(gross*total/10000n),lpFeeAtomic:String(gross*BigInt(rates.lpFeeRate)/10000n)}}));
 for(const kind of ['buy','sell']){
  try {const descriptor=JSON.parse(await native.execute('inspectAmmMaterial',JSON.stringify({phase:'describe',poolContractId,publicKey,indexedPool:{ftCodeScript:ft.data.code_script,ftTapeScript:ft.data.tape_script},currentPool:{txid:successful,rawTransaction:body.data.txraw},action:{kind,amount:'1'}})));
   console.log(JSON.stringify({stage:'historical-funded-quote',kind,state:descriptor.state,requirements:descriptor.requirements,authorization:descriptor.authorization,feePolicy:descriptor.feePolicy,quote:descriptor.quote}));
  }catch(e){console.log(JSON.stringify({stage:'historical-funded-quote',kind,code:e.code,message:e.message}));}
 }
 process.exit(0);
}
const intents=[
 {type:'tbc20-stablecoin-create',name:'ReadOnlyCoin',symbol:'ROC',decimals:0,initialSupply:'20'},
 {type:'tbc20-stablecoin-create',name:'ReadOnlyCoin',symbol:'ROC',decimals:6,initialSupply:'1000000'},
 {type:'amm.swap',poolContractId,direction:'ft-to-tbc',amount:'1',minimumOutput:'1',receiver:address},
 {type:'amm.mergeToken',poolContractId},
 {type:'tbc20Lp.burn',poolContractId},
];
for(const [i,intent] of intents.entries()){
 trace.length=0;const result={case:intent.type,decimals:intent.decimals};
 try{
  const normalized=await engine.normalizeRequest({version:'1.0',request:{version:'1.0',chainId:account.chainId,from:address,clientRequestId:`readonly-${i}`,intent:{...intent,version:'1.0'},constraints:{maxFee:'100000'}}});
  const params={version:'1.0',chainId:account.chainId,accountId:account.accountId,requirement:kit.chainDataRequirement(normalized.request)};
  const snapshot=await network.resolveChainData(params,account);
  result.chainData=snapshot.portError??{utxos:snapshot.payload?.utxos?.length,parents:snapshot.payload?.parents?.length};
  const dispatched=await kit.dispatchHostPort({chainData:async()=>snapshot},{version:'1.0',callId:'A'.repeat(43),operation:'chainData.resolve',params});
  result.dispatch=dispatched.error??'pass';
  if(!snapshot.portError){
   const policy=await network.resolvePolicy({version:'1.0',...normalized,snapshotHash:snapshot.snapshotHash});
   result.policy=policy.portError??'pass';
   if(!policy.portError){const plan=await engine.plan({version:'1.0',...normalized,snapshot,policy});result.plan={transactions:plan.plan?.payload.transactions?.length,keys:Object.keys(plan)};}
  }
 }catch(error){result.failure={name:error.name,code:error.code,message:error.message};}
 result.reads=trace;console.log(JSON.stringify(result));
}
const portTrace=[];let approvals=0;
const ORIGIN='https://readonly-repro.tbc.example',now=()=>new Date().toISOString();
const permission=capability=>({id:`readonly-${capability}`,parentCapability:capability,invoker:ORIGIN,date:Date.now()-10000,caveats:[
 {type:'restrictChains',value:[account.chainId]},{type:'restrictAccounts',value:[account.accountId]},{type:'restrictMethods',value:[capability]}]});
const runtime=kit.createTbcWallet({accounts:{current:async()=>[account]},engine,
 storage:{hostStore:kit.createMemoryTwsHostStore({now:Date.now}),loadPermissions:async()=>({revision:'0',permissions:['tbc_accounts','tbc_sendTransaction'].map(permission)}),commitPermissions:async(params)=>({revisions:params.changes.map(({scope})=>({scope,revision:'1'}))})},
 network:{resolveChainData:(params,_call,active)=>{portTrace.push('chainData.resolve');return network.resolveChainData(params,active)},resolvePolicy:(...args)=>{portTrace.push('policy.resolve');return network.resolvePolicy(...args)},broadcastSubmit(){throw Error('Broadcast forbidden')},broadcastReconcile(){throw Error('Reconcile forbidden')}},
 approval:{request:async(params)=>{portTrace.push('approval.request');approvals++;if(params.binding.payload.operationKind==='permission')return {status:'approved',approvalId:'readonly-connect',approvalToken:'readonly-token',bindingHash:params.binding.bindingHash,approvedAt:now(),expiresAt:params.binding.payload.expiresAt};return {status:'rejected',bindingHash:params.binding.bindingHash,rejectedAt:now()}}},
 signer:{sign:async()=>{throw Error('Signing forbidden')}},clock:now,randomBytes:n=>Uint8Array.from({length:n},(_,i)=>i)});
const session=await runtime.openSession({origin:ORIGIN,sessionId:'readonly-full-runtime'});
let id=0;
const provider={async request({method,params}){const d=await session.handleRequest({id:`readonly-provider-${++id}`,method,params});if(d.response.error)throw Object.assign(new Error(d.response.error.message),{code:d.response.error.code,data:d.response.error.data});return d.response.result},on(){},removeListener(){},destroy(){}};
const wallet=await kit.createTbcClient({network:'testnet',provider}).connect();
for(const [i,intent] of intents.entries()){
 portTrace.length=0;trace.length=0;const before=approvals;
 try{const {type,...input}=intent;
  if(i<2)await wallet.tbc20Stablecoin.create({...input,constraints:{maxFee:'100000'}});
  else if(i===2)await wallet.amm.swap({...input,constraints:{maxFee:'100000'}});
  else if(i===3)await wallet.amm.mergeToken(input);
  else await wallet.tbc20Lp.burn(input);
 }catch(e){console.log(JSON.stringify({stage:'public-wallet',case:intent.type,decimals:intent.decimals,code:e.code,message:e.message,data:e.data,ports:portTrace,approvals:approvals-before,reads:trace}));}
}
session.close();
