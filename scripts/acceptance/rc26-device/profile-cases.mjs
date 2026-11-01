for(let repeat=0;repeat<3;repeat++)test(`local 11-NFT batch ${repeat+1}`,async()=>{
 const h=await harness(11); const started=performance.now();
 try {
  const result=await h.wallet.tbc721.batchMint(h.input);
  assert.equal(result.status,'complete'); assert.equal(result.minted,11);
  assert.equal(h.stats().approvals,1);assert.equal(h.stats().signatures,22);
  assert.deepEqual(h.calls,{index:1,native:1,raw:0,decoded:0,status:0,reconcile:0});
  profileRuns.push({repeat,elapsedMs:performance.now()-started,stats:h.stats(),reads:{...h.calls},profile:takeProfile(),txids:[...h.accepted],bindings:[...h.formal]});
 } finally { h.close(); }
});
