for(const elapsed of [120000,120001])test(`native fence expiry ${elapsed}: typed result, no signing or submission`,async()=>{
 let h,fenceError;h=await harness(1,{duringApprove:async()=>{
  h.setClock(NOW+elapsed);
  try{await nativeCall('fence','expire',JSON.stringify({elapsed}));}catch(e){fenceError=e.message;throw e;}
  throw Error('Native fence should have rejected');
 }});
 try{const r=await h.wallet.tbc721.batchMint(h.input);assert.ok(/expired/i.test(fenceError??''),'actual native fence must expire');assert.equal(r.status,'stopped');assert.equal(r.reason,'expired');assert.equal(r.minted,0);assert.equal(h.stats().approvals,1);assert.equal(h.stats().signatures,0);assert.equal(h.dispatched.length,0);assert.deepEqual(h.calls,{index:1,native:1,raw:0,decoded:0,status:0,reconcile:0});}
 finally{metrics.push({test:activeTest,...h.stats(),reads:{...h.calls},submissions:h.dispatched.length});h.close()}
});
test('before-deadline adapter failure stays an error',async()=>{
 const h=await harness(1,{duringApprove:async()=>{throw Error('adapter failure')}});
 try{await assert.rejects(h.wallet.tbc721.batchMint(h.input),e=>e.code===-32603);assert.equal(h.stats().signatures,0);assert.equal(h.dispatched.length,0)}finally{h.close()}
});
test('tampered consent is still rejected after expiry',async()=>{
 const h=await harness(1,{badConsent:true,expireInApproval:true});try{await assert.rejects(h.wallet.tbc721.batchMint(h.input));assert.equal(h.stats().signatures,0);assert.equal(h.dispatched.length,0)}finally{h.close()}
});
test('parallel prefetch survives; rejection never signs',async()=>{
 let release;const barrier=new Promise(r=>release=r);const h=await harness(1,{reject:true,readBarrier:()=>barrier,duringApprove:async calls=>{await new Promise(r=>setTimeout(r,0));assert.equal(calls.index,1);assert.equal(calls.native,1);release()}});
 try{const r=await h.wallet.tbc721.batchMint(h.input);assert.equal(r.reason,'rejected');assert.equal(h.stats().approvals,1);assert.equal(h.stats().signatures,0);assert.equal(h.dispatched.length,0)}finally{release();h.close()}
});
test('expired after accepted prefix: preserve txids, no duplicate submit',async()=>{
 const h=await harness(4,{expireAt:2});try{const r=await h.wallet.tbc721.batchMint(h.input);assert.equal(r.status,'partial');assert.equal(r.reason,'expired');assert.equal(r.minted,2);assert.equal(h.dispatched.length,2);assert.equal(h.stats().approvals,1);assert.deepEqual(r.batches.flatMap(b=>b.transactions).filter(t=>['accepted','known'].includes(t.status)).map(t=>t.txid),h.accepted)}finally{h.close()}
});
test('101 NFT bounded job: one approval, unchanged material reads',async()=>{
 const h=await harness(101);const start=performance.now();try{const r=await h.wallet.tbc721.batchMint(h.input);assert.equal(r.status,'complete');assert.equal(r.minted,101);assert.equal(h.stats().approvals,1);assert.equal(h.stats().signatures,202);assert.equal(h.formal.length,11);assert.equal(new Set(h.dispatched).size,101);assert.deepEqual(h.calls,{index:1,native:1,raw:0,decoded:0,status:0,reconcile:0});metrics.push({test:activeTest,ms:performance.now()-start,...h.stats(),reads:{...h.calls},minted:r.minted,batches:h.formal.length,txids:[...h.accepted]})}finally{h.close()}
});
