test('101 NFT task: actual Native plan/validate/finalize, one approval, shared material',async()=>{
 const h=await harness(101);try{const r=await h.wallet.tbc721.batchMint(h.input);assert.equal(r.status,'complete');assert.equal(r.minted,101);assert.equal(h.stats().approvals,1);assert.equal(h.stats().signatures,202);assert.equal(h.formal.length,11);assert.deepEqual(h.calls,{index:1,native:1,raw:0,decoded:0,status:0,reconcile:0});}finally{h.close()}
});
for(const prefix of [1,10,11])test(`expiry after ${prefix} accepted: retain successful prefix and stop`,async()=>{
 const h=await harness(12,{expireAt:prefix});try{const r=await h.wallet.tbc721.batchMint(h.input);assert.equal(r.status,'partial');assert.equal(r.reason,'expired');assert.equal(r.minted,prefix);assert.equal(h.dispatched.length,prefix);assert.equal(h.stats().approvals,1);assert.deepEqual(r.batches.flatMap(b=>b.transactions).filter(t=>['accepted','known'].includes(t.status)).map(t=>t.txid),h.accepted);}finally{h.close()}
});
test('approval expires before submission: zero signatures and zero submit',async()=>{
 const h=await harness(11,{expireInApproval:true});try{const r=await h.wallet.tbc721.batchMint(h.input);assert.equal(r.reason,'expired');assert.equal(r.minted,0);assert.equal(h.stats().signatures,0);assert.equal(h.dispatched.length,0);}finally{h.close()}
});
for(const mode of ['rejected','unknown','known'])test(`transport ${mode}: retain results, no duplicate submit`,async()=>{
 const o=mode==='rejected'?{rejectAt:3}:{unknownAt:3,reconcileKnown:mode==='known'};const h=await harness(11,o);
 try{const r=await h.wallet.tbc721.batchMint(h.input);assert.equal(r.status,mode==='known'?'complete':mode==='unknown'?'uncertain':'partial');assert.equal(r.minted,mode==='known'?11:3);assert.equal(h.stats().approvals,1);assert.equal(new Set(h.dispatched).size,h.dispatched.length);assert.equal(h.calls.reconcile,mode==='rejected'?0:1);}finally{h.close()}
});
test('low-level broadcast expiry contains accepted and not-submitted txids',async()=>{
 const h=await harness(4,{expireAt:2});try{await assert.rejects(h.provider.request({method:'tbc_sendTransaction',params:{version:'1.0',chainId,from:address,intent:{type:'tbc721-standard-batch-mint',version:'1.0',collectionId:h.input.collectionId,items:h.input.items},constraints:{maxFee:'1000000',expiresAt:h.input.limits.expiresAt}}}),e=>{assert.equal(e.code,4100);assert.equal(e.data.reason,'RECEIPT_EXPIRED');assert.deepEqual(e.data.submittedTransactionIds,h.accepted);assert.equal(e.data.notSubmittedTransactionIds.length,2);return true;});}finally{h.close()}
});
test('approval and prefetch overlap; rejected job never signs',async()=>{
 let release;const gate=new Promise(r=>release=r);const h=await harness(11,{reject:true,readBarrier:()=>gate,duringApprove:async calls=>{await new Promise(r=>setTimeout(r,0));assert.equal(calls.index,1);assert.equal(calls.native,1);release();}});
 try{const r=await h.wallet.tbc721.batchMint(h.input);assert.equal(r.reason,'rejected');assert.equal(h.stats().approvals,1);assert.equal(h.stats().signatures,0);assert.equal(h.dispatched.length,0);}finally{release();h.close()}
});
test('tampered whole-job consent cannot sign or submit',async()=>{
 const h=await harness(2,{badConsent:true});try{await assert.rejects(h.wallet.tbc721.batchMint(h.input));assert.equal(h.stats().signatures,0);assert.equal(h.dispatched.length,0);}finally{h.close()}
});
