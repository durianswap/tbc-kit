test('NFT 122 fee alternatives: 1/7/100 mint plans validate on Native using the same material',async()=>{
  const h=harness(100);h.state.nativeCount=122;h.state.indexed=range(100);
  const snapshot=await h.resolver.resolve(h.request(range(100)));assert.equal(snapshot.portError,undefined);
  const engine=kit.createTbcEngine({backend});
  const payload={version:'1.0',policyId:'rc23-device',revision:'1',chainId,feeRateSatPerKb:'80',dustThreshold:'42',minConfirmations:'0',maxBundleTransactions:100,sighashType:65,contractPolicies:[],amountLimits:[{scope:'native',maximum:'2100000000000000'}],expiresAt:'2026-11-01T00:05:00Z'};
  const policy={payload,policyHash:hashCanonical(payload)};
  for(const count of [1,7,100]){
    const n=await engine.normalizeRequest({version:'1.0',request:{version:'1.0',chainId,from:address,intent:{type:'tbc721-standard-batch-mint',version:'1.0',collectionId:h.collectionId,items:range(count).map(slot=>({slot,name:'Device '+slot,symbol:'D',description:'',attributes:[]}))},constraints:{expiresAt:'2026-11-01T00:02:00Z',maxFee:'1000000',feePreference:'standard'}}});
    const params={version:'1.0',request:n.request,requestHash:n.requestHash,snapshot,policy};const result=await engine.plan(params);
    assert.equal(result.plan.payload.transactions.length,count);
    assert.deepEqual(await engine.validate({...params,phase:'plan',plan:result.plan}),{valid:true,violations:[]});
  }
  assert.deepEqual(h.calls,{index:1,native:1,raw:0,decoded:0,status:0});
});

function nftNetwork(h){return {resolveChainData:params=>h.resolver.resolve(params),resolvePolicy:()=>{
  const payload={version:'1.0',policyId:'rc23-nft-provider',revision:'1',chainId,feeRateSatPerKb:'80',dustThreshold:'42',minConfirmations:'0',maxBundleTransactions:100,sighashType:65,contractPolicies:[],amountLimits:[{scope:'native',maximum:'2100000000000000'}],expiresAt:'2026-11-01T00:05:00Z'};
  return {payload,policyHash:hashCanonical(payload)};
}}}
const nftInput=(h,slots)=>({collectionId:h.collectionId,items:slots.map(slot=>({slot,name:'Device '+slot,symbol:'D',description:'',attributes:[]})),constraints:{maxFee:'1000000',expiresAt:'2026-11-01T00:02:00Z'}});
test('NFT 7 mint Provider-to-Native-finalize: 1/122/256 fee alternatives, identical signed transactions and one approval',async()=>{
  const outcomes=[];
  for(const count of [1,122,256]){
    const h=harness(100);h.state.nativeCount=count;h.state.indexed=range(100);
    // Preserve the selected fee input across runs: alternative IDs sort after
    // the real fixture funding. Otherwise a different valid selection produces
    // different signed bytes, which is not a regression.
    const getUtxos=h.client.getUtxos;
    h.client.getUtxos=async()=>{const result=await getUtxos();return {...result,utxos:result.utxos.map((u,i)=>i?{...u,txid:'ff'.repeat(28)+i.toString(16).padStart(8,'0')}:u)}};
    const s=await setup({networkOverride:nftNetwork(h)});
    try{
      await s.wallet.tbc721.batchMint(nftInput(h,range(7)));
      assert.equal(s.counts().approvals,1);assert.equal(s.accepted.length,7);
      assert.deepEqual(h.calls,{index:1,native:1,raw:0,decoded:0,status:0});
      outcomes.push({transactions:s.accepted,reads:h.calls,counts:s.counts()});
    }finally{s.session.close()}
  }
  assert.deepEqual(outcomes[0],outcomes[1]);assert.deepEqual(outcomes[0],outcomes[2]);
});
test('NFT Provider slot conflict is typed; approval rejection never reaches signer or mock submit',async()=>{
  for(const reject of [false,true]){
    const h=harness(100);h.state.nativeCount=122;h.state.indexed=range(100);
    const s=await setup({networkOverride:nftNetwork(h),reject});
    try{
      await assert.rejects(s.wallet.tbc721.batchMint(nftInput(h,reject?range(7):[101])),e=>reject?e.code===4001:e.code===-32000&&e.data?.details?.reason==='NFT_SLOT_MISMATCH');
      assert.equal(s.counts().approvals,reject?1:0);assert.equal(s.counts().signatures,0);assert.equal(s.accepted.length,0);
      assert.deepEqual(h.calls,{index:1,native:1,raw:0,decoded:0,status:0});
    }finally{s.session.close()}
  }
});
