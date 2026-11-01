globalThis.rc23Diagnostics=[];
const fullProvider=globalThis.rc23Scenario==='expiry-provider';
const fault=globalThis.rc23Scenario.startsWith('expiry');
for(const mode of fullProvider?['provider']:['provider','direct-host'])test('REPRO: 300 collection / slots 200..299 / 100 NFT / '+mode,async()=>{
  const h=harness(300);h.state.nativeCount=1;h.state.indexed=range(100,200);
  let virtualElapsed=0,firstSubmitMs;
  const started=performance.now();
  const s=await setup({networkOverride:nftNetwork(h),clockOverride:()=>new Date(nowMs+virtualElapsed).toISOString(),
    broadcastHook(_params,accepted){firstSubmitMs??=performance.now()-started;if(fault)virtualElapsed=accepted.length*1000;}});
  const input={...nftInput(h,range(100,200)),items:range(100,200).map(slot=>({slot,name:'B'+slot,symbol:'N',description:'',attributes:[{traitType:'s',value:'one'}],media:{kind:'uri',uri:'https://example.com/matrix.png'}}))};
  if(fault)input.constraints={...input.constraints,expiresAt:new Date(nowMs+33000).toISOString()};
  let publicProvider,connected=s.wallet;
  if(fullProvider){
    let id=0;
    publicProvider=kit.createTbcProvider({requestIdFactory:()=>`expiry-full-${++id}`,transport:{
      send:({id,method,params})=>s.rawSession.handleRequest({id,method,...(params===undefined?{}:{params})}),
      subscribe:()=>()=>{},
    }});
    connected=await kit.createTbcClient({network:'testnet',provider:publicProvider}).connect();
  }
  let error,result;
  try{
    if(mode==='provider')result=await connected.tbc721.batchMint(input);
    else result=await s.rawSession.startOperation({id:'diagnostic-100',method:'tbc_sendTransaction',params:{version:'1.0',chainId,from:address,clientRequestId:'diagnostic-100',intent:{type:'tbc721-standard-batch-mint',version:'1.0',collectionId:input.collectionId,items:input.items},constraints:input.constraints}});
  }catch(e){error={message:e.message,code:e.code,data:e.data}}
  finally{publicProvider?.destroy();s.session.close()}
  const record={mode,fullProvider,scenario:fault?'controlled expiry after 33 accepted transactions (not proof of colleague deadline)':'no injected failure',ms:performance.now()-started,firstSubmitMs,virtualElapsed,counts:s.counts(),accepted:s.accepted.length,reads:h.calls,error,
    host:mode==='direct-host'?{status:result?.status,error:result?.error,revision:result?.revision}:undefined,
    publicResult:mode==='provider'?result:undefined,
    syntheticTxids:s.accepted.map(t=>t.txid),realBroadcasts:0};
  globalThis.rc23Diagnostics.push(record);send({kind:'progress',text:JSON.stringify(record)});
  assert.equal(s.counts().approvals,1);assert.equal(s.counts().signatures,200);
  assert.equal(s.accepted.length,fault?33:100);
  if(fault)assert.ok(mode==='provider'?error?.message===(fullProvider?'The Provider request failed.':'Host operation did not produce a response: failed'):result?.status==='failed');
});
