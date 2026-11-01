import assert from 'node:assert/strict';
import test from 'node:test';
import {kit,harness,address,account,chainId,origin,NOW} from './nft-job-stress-fixture.mjs';

// Public fixture identities, synthetic chain data and submission only. No network.
const granted=(cap,chain=chainId)=>({id:cap+chain,parentCapability:cap,invoker:origin,date:NOW,
 caveats:[{type:'restrictChains',value:[chain]},{type:'restrictAccounts',value:[chain+':'+address]},{type:'restrictMethods',value:[cap]}]});
async function permissionHarness(method,expire){
 let time=NOW,commits=0,approvals=0,reads=0,chain='tbc:testnet';
 const unexpected=async()=>{throw Error('No transaction I/O allowed')};
 const runtime=kit.createTbcWallet({accounts:{current:async()=>[{...account,chainId:chain,accountId:chain+':'+address}],forChain:async c=>[{...account,chainId:c,accountId:c+':'+address}]},
  storage:{loadPermissions:async()=>{reads++;return{revision:'0',permissions:method==='tbc_switchChain'?[granted('tbc_switchChain','tbc:mainnet')]:[]}},commitPermissions:async p=>{commits++;return{revisions:p.changes.map(({scope})=>({scope,revision:'1'}))}}},
  approval:{request:async p=>{approvals++;const approvedAt=new Date(time).toISOString();if(expire)time=Date.parse(p.binding.payload.expiresAt);
   return{status:'approved',approvalId:'expire-approval',approvalToken:'expire-token',bindingHash:p.binding.bindingHash,approvedAt,expiresAt:p.binding.payload.expiresAt}}},
  signer:{sign:unexpected},network:{forChain:async c=>({network:kit.createTbcNetworkContext({network:c==='tbc:mainnet'?'mainnet':'testnet'}),resolveChainData:unexpected,resolvePolicy:unexpected,broadcastSubmit:unexpected,broadcastSubmitBatch:unexpected,broadcastReconcile:unexpected})},
  clock:()=>new Date(time).toISOString(),randomBytes:n=>new Uint8Array(n)});
 const session=await runtime.openSession({origin,sessionId:'permission-extreme'});
 return{session,stats:()=>({commits,approvals,reads}),request:()=>session.provider.request({method,params:method==='tbc_switchChain'?{chainId:'tbc:mainnet'}:[{tbc_accounts:{chains:[chainId],maxAccounts:1}}]})};
}
test('actual Provider: permission and switch expiry is typed, never commits',async()=>{
 for(const method of ['wallet_requestPermissions','tbc_switchChain']){
  const h=await permissionHarness(method,true);try{
   await assert.rejects(h.request(),e=>{assert.equal(e.code,4100,JSON.stringify(e));assert.equal(e.data.reason,'RECEIPT_EXPIRED');return true});
   assert.equal(h.stats().commits,0);assert.equal(h.stats().approvals,1);
   assert.equal(await h.session.provider.request({method:'tbc_chainId'}),'tbc:testnet');
  }finally{h.session.close()}
 }
});
test('actual Provider: nonexpired permissions and switch remain usable',async()=>{
 for(const method of ['wallet_requestPermissions','tbc_switchChain']){const h=await permissionHarness(method,false);try{
  await h.request();assert.equal(h.stats().approvals,1);assert.equal(h.stats().commits,method==='wallet_requestPermissions'?1:0);
  assert.equal(await h.session.provider.request({method:'tbc_chainId'}),method==='tbc_switchChain'?'tbc:mainnet':'tbc:testnet');
 }finally{h.session.close()}}
});
test('seeded actual Engine matrix: reject, expiry, unknown and recovered status at batch boundaries',async t=>{
 let seed=0x24c0ffee;const random=n=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return (seed>>>0)%n};
 const vectors=[];
 for(let i=0;i<40;i++){
  const count=11+random(24),at=random(count),mode=i%4;
  const options=mode===0?{rejectAt:at}:mode===1?{expireAt:at+1}:mode===2?{unknownAt:at}:{unknownAt:at,reconcileKnown:true};
  const h=await harness(count,options);try{const r=await h.wallet.tbc721.batchMint(h.input);
   assert.equal(r.minted,mode===3?count:mode===1?at+1:at);assert.equal(h.stats().approvals,1);
   assert.equal(new Set(h.dispatched).size,h.dispatched.length);assert.equal(h.calls.index,1);assert.equal(h.calls.native,1);assert.equal(h.calls.raw,0);
   const outcomes=r.batches.flatMap(b=>b.transactions),accepted=outcomes.filter(x=>['accepted','known'].includes(x.status));
   assert.equal(accepted.length,r.minted);assert.equal(r.confirmedSubmissionFee,accepted.reduce((sum,x)=>sum+BigInt(x.fee),0n).toString());
   assert.equal(h.calls.reconcile,mode>=2?1:0);assert.equal(r.reason,mode===0?'execution-failed':mode===1&&at+1<count?'expired':mode===2?'submission-uncertain':'complete');
   vectors.push({count,at,mode,minted:r.minted,reason:r.reason});
  }finally{h.close()}
 }
 t.diagnostic(JSON.stringify({seed:'24c0ffee',vectors}));
});
test('abort during accepted reply retains that txid and prevents later dispatch',async()=>{
 for(const at of [0,8,9,10]){const abort=new AbortController();const h=await harness(21,{afterSubmit:({index})=>{if(index===at)abort.abort()}});
  try{const r=await h.session.runNftMintJob({...h.input,signal:abort.signal});assert.equal(r.minted,at+1);assert.equal(r.reason,'cancelled');assert.equal(h.dispatched.length,at+1);assert.equal(h.stats().approvals,1)}finally{h.close()}
 }
});
test('late signer expiry and wrong reconciliation cannot cause a second POST',async()=>{
 const h=await harness(11,{beforeSign:({index,setClock})=>{if(index===3)setClock(NOW+120000)}});
 try{const r=await h.wallet.tbc721.batchMint(h.input);assert.equal(r.reason,'expired');assert.equal(r.minted,0);assert.equal(h.dispatched.length,0)}finally{h.close()}
 for(const rows of [[],[{txid:'ff'.repeat(32),status:'confirmed'}]]){
  const h=await harness(12,{unknownAt:1,reconcileResult:()=>({transactions:rows})});try{const r=await h.wallet.tbc721.batchMint(h.input);
   assert.equal(r.status,'uncertain');assert.equal(r.minted,1);assert.equal(h.dispatched.length,2);assert.equal(h.calls.reconcile,1);
  }finally{h.close()}
 }
});
test('500 competing requests cannot borrow one job consent; parent remains usable',async()=>{
 let entered,release;const ready=new Promise(r=>entered=r),wait=new Promise(r=>release=r);
 const h=await harness(1,{duringApprove:async()=>{entered();await wait}});try{
  const first=h.wallet.tbc721.batchMint(h.input);await ready;
  const results=await Promise.allSettled(Array.from({length:500},()=>h.wallet.tbc721.batchMint(h.input)));
  assert.ok(results.every(r=>r.status==='rejected'&&r.reason.code===-32000));assert.equal(h.stats().approvals,1);
  release();assert.equal((await first).minted,1);assert.equal(await h.provider.request({method:'tbc_chainId'}),chainId);assert.equal(h.dispatched.length,1);
 }finally{release();h.close()}
});
test('hostile parameter flood has no chain reads or signing side effects',async()=>{
 const h=await harness(1);try{
  const vectors=[p=>p.items[0].slot=-1,p=>p.items[0].slot=NaN,p=>p.items[0].slot=1.5,p=>p.items[0].to='bad',p=>p.collectionId='ab',p=>p.limits.maxTotalFee='1e6',p=>p.limits.maxItemsPerBatch=0,p=>p.items[0].name='x'.repeat(1000000)];
  const results=await Promise.allSettled(Array.from({length:160},(_,i)=>{const p=structuredClone(h.input);vectors[i%vectors.length](p);return h.wallet.tbc721.batchMint(p)}));
  assert.ok(results.every(r=>r.status==='rejected'));assert.equal(h.calls.index,0);assert.equal(h.calls.native,0);assert.equal(h.stats().approvals,0);assert.equal(h.stats().signatures,0);assert.equal(h.dispatched.length,0);
 }finally{h.close()}
});
test('large UTF-8 metadata adapts only local batches while preserving all approved items',async t=>{
 const h=await harness(31);try{
  for(const item of h.input.items){item.description='链上测试'.repeat(100);item.name='集合'+item.slot;}
  const r=await h.wallet.tbc721.batchMint(h.input);
  assert.equal(r.status,'complete');assert.equal(r.minted,31);assert.equal(h.stats().approvals,1);
  assert.equal(h.calls.index,1);assert.equal(h.calls.native,1);assert.equal(h.calls.raw,0);
  assert.deepEqual(r.batches.map(x=>x.offset),r.batches.map((_,i,a)=>a.slice(0,i).reduce((n,b)=>n+b.count,0)));
  t.diagnostic(JSON.stringify({metadataBytes:Buffer.byteLength(h.input.items[0].description),batches:r.batches.map(x=>x.count),reads:h.calls}));
 }finally{h.close()}
});
test('30 independent complete sessions release job locks without growing read or approval counts',async t=>{
 const samples=[];for(let i=0;i<30;i++){
  const h=await harness(10),start=performance.now();try{const r=await h.wallet.tbc721.batchMint(h.input);assert.equal(r.minted,10);assert.equal(r.status,'complete');assert.equal(h.stats().approvals,1);assert.equal(h.calls.index,1);assert.equal(h.calls.native,1);assert.equal(h.calls.raw,0);
  }finally{h.close()}
  if(global.gc)global.gc();samples.push({i,ms:performance.now()-start,heap:process.memoryUsage().heapUsed,rss:process.memoryUsage().rss});
 }
 const growth=samples.at(-1).heap-samples[5].heap;
 // Generous test resource ceiling, not a performance optimization or a product timeout.
 assert.ok(growth<64*1024*1024,JSON.stringify({growth,samples}));t.diagnostic(JSON.stringify({soakSessions:30,gc:!!global.gc,growth,samples}));
});
