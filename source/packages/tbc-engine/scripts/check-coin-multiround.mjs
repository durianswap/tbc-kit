// Frozen consumer + real Native/WASM ABI + independent script VM. Public
// scalar-one fixture only. No external HTTP, funded keys or real broadcasts.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {secp256k1} from '@noble/curves/secp256k1.js';
const [packageArg,evidenceArg,resourcesArg]=process.argv.slice(2);
assert(packageArg&&evidenceArg&&resourcesArg,'Usage: INSTALLED_KIT EVIDENCE ENGINE_RESOURCES');
const pkg=resolve(packageArg),out=resolve(evidenceArg),root=resolve(import.meta.dirname,'../../..');
await mkdir(out,{recursive:true});
const kit=await import(pathToFileURL(join(pkg,'dist/esm/wallet.node.js')));
const engines=await import(pathToFileURL(join(pkg,'dist/esm/engine.node.js')));
const api=await import(pathToFileURL(join(pkg,'dist/esm/api.js')));
const vm=createRequire(join(root,'packages/kit/package.json'))('tbc-lib-js');
const seed=JSON.parse(await readFile(join(root,'packages/tbc-engine/rust/fixtures/coin-proof.json')));
const mint=new vm.Transaction(seed.vectors[0].parentRaw);
const wasm=await engines.createWasmTbcEngineBackend(await readFile(join(pkg,'artifacts/wasm/tbc_engine_wasm.wasm')));
const native=join(resolve(resourcesArg),'artifacts/native/aarch64-apple-darwin/libtbc_engine_native.dylib');
const runner=join(out,'native-runner');
execFileSync('xcrun',['clang','-O2',join(import.meta.dirname,'native-artifact-runner.c'),native,
  '-I',join(root,'packages/tbc-engine/rust/crates/tbc-engine-native/include'),
  '-Wl,-rpath,'+resolve(native,'..'),'-o',runner],{stdio:'pipe'});
const nativeCall=(method,input)=>execFileSync(runner,[method,'-'],{input,encoding:'utf8',maxBuffer:64*1024*1024});
const rustOutput=execFileSync('cargo',['test','--release','--offline','--locked','-p','tbc-engine-core',
  '--test','coin_multiround','coin_multiround_artifact_vectors','--','--exact','--nocapture'],{
  cwd:join(root,'packages/tbc-engine/rust'),env:{...process.env,COIN_MULTIROUND_DUMP_WIRE:'1'},
  stdio:['ignore','pipe','pipe'],encoding:'utf8',maxBuffer:256*1024*1024});
const marker='COIN_MULTIROUND_WIRE:';
const wires=rustOutput.split('\n').filter(l=>l.includes(marker)).map(l=>JSON.parse(l.slice(l.indexOf(marker)+marker.length)));
assert(wires.length>20);
const vectors=[];let vmTransactions=0,vmInputs=0;
function verify(p,bundle){
  const parents=new Map(p.snapshot.payload.parents.map(x=>[x.txid,new vm.Transaction(x.rawTransaction)]));
  const originals=new Map(p.snapshot.payload.utxos.map(u=>[`${u.txid}:${u.vout}`,u]));
  for(const row of bundle.transactions){
    const tx=new vm.Transaction(row.rawTransaction);assert.equal(tx.id,row.txid);
    for(const [index,input] of tx.inputs.entries()){
      const id=input.prevTxId.toString('hex'),parent=parents.get(id),u=originals.get(`${id}:${input.outputIndex}`);
      input.output=parent?.outputs[input.outputIndex]??(u&&new vm.Transaction.Output({satoshis:Number(u.satoshis),script:vm.Script.fromHex(u.scriptPubKey)}));
      assert(input.output,'Missing VM input');assert.equal(tx.verifyScript(index).success,true,`Coin independent VM input ${index}`);vmInputs++;
    }
    parents.set(tx.id,tx);vmTransactions++;
  }
}
for(const w of wires){
  const input=JSON.stringify(w.input),expected=await wasm.call(w.method,input);
  assert.deepEqual(JSON.parse(expected),w.result,'Source and frozen WASM differ');
  assert.equal(nativeCall(w.method,input),expected,'Native and WASM wire bytes differ');
  vectors.push({method:w.method,input,expected});
  if(w.method==='finalize'&&w.result.ok&&w.result.result.bundle)verify(w.input,w.result.result.bundle);
}
await writeFile(join(out,'vectors.json'),JSON.stringify(vectors));
const plans=wires.filter(w=>w.method==='plan'&&w.result.ok);
const rows=[],recoveryRows=[];
for(const [index,wire] of plans.entries()){
  const p=structuredClone(wire.input),now=new Date().toISOString().replace(/\.\d{3}Z$/,'Z');
  p.request.constraints.expiresAt=new Date(Date.parse(now)+300000).toISOString().replace(/\.\d{3}Z$/,'Z');
  // Reuse a historic public fixture in the isolated Testnet-labelled transport;
  // actual artifact parity above replays its original canonical network bytes.
  p.request.chainId='tbc:testnet';p.snapshot.payload.account.chainId='tbc:testnet';
  p.snapshot.payload.account.accountId=`tbc:testnet:${p.request.from}`;
  const account=p.snapshot.payload.account;
  const accounts=[{...account,chainId:p.request.chainId,address:p.request.from}];
  const address=accounts[0].address,contractId=p.request.intent.contractId;
  const rawMap=new Map(p.snapshot.payload.parents.map(x=>[x.txid,x.rawTransaction]));
  const tokens=p.snapshot.payload.utxos.filter(u=>u.classification==='stablecoin');
  const nativeUtxos=p.snapshot.payload.utxos.filter(u=>u.classification==='native');
  let approvals=0,signatures=0,approvedAt=0,lastSign=0,lastPlan,lastInput;
  const trace=[];
  const fetch=async(input,init)=>{
    assert.equal(approvals,0,'No fresh HTTP after preparation/approval');
    assert.equal(init?.method??'GET','GET');const u=new URL(String(input));
    assert.equal(u.origin,'https://api.tbcdev.org');trace.push(u.pathname);let data;
    if(u.pathname===`/api/tbc/utxo/address/${address}`)data={utxos:nativeUtxos.map(u=>({txid:u.txid,index:u.vout,value:u.satoshis,height:0}))};
    else if(u.pathname.includes('/stablecoin/utxo/'))data={utxos:tokens.map((u,i)=>({txid:u.txid,index:u.vout,tbc_value:u.satoshis,ft_value:String(i+1===tokens.length?1001-tokens.length:1),height:0,lock_time:0}))};
    else if(u.pathname.includes('/stablecoin/info/'))data={stablecoin_id:contractId,utxo:{txid:mint.id,vout:0},supply:'1000',decimal:0,
      name:'Coin',symbol:'COIN',code_script:mint.outputs[3].script.toHex(),tape_script:mint.outputs[4].script.toHex()};
    else if(u.pathname.startsWith('/api/tbc/txraw/txid/')){const id=u.pathname.split('/').at(-1);assert(rawMap.has(id),'Unexpected ancestry fetch');data={txraw:rawMap.get(id)};}
    else throw Error('Unnecessary read '+u.pathname);
    return new Response(JSON.stringify({code:'200',data}),{status:200});
  };
  const network=kit.createDefaultTbcNetwork({network:kit.createTbcNetworkContext({network:'testnet'}),
    accounts:{current:async()=>accounts},fetch,now:()=>Date.parse(now),snapshotId:()=>`coin-multiround-${index}`});
  const engine=engines.createTbcEngine({backend:engines.createNativeTbcEngineBackend(nativeCall)});
  const tracked=Object.fromEntries(['normalizeRequest','plan','validate','finalize'].map(m=>[m,async value=>{
    const result=await engine[m](value);if(m==='plan'){lastPlan=result.plan;lastInput=value;}return result;
  }]));
  const permissions=['tbc_accounts','tbc_signTransaction'].map(capability=>({id:capability,parentCapability:capability,
    invoker:'https://wallet.test',date:Date.parse(now),caveats:[{type:'restrictChains',value:[p.request.chainId]},
      {type:'restrictAccounts',value:[account.accountId]},{type:'restrictMethods',value:[capability]}]}));
  const store=kit.createMemoryTwsHostStore({now:()=>Date.parse(now)});
  const evidence=kit.createApprovalHostEvidenceReader({store,releaseFingerprint:kit.TWS_RELEASE_FINGERPRINT,
    parseApprovalRequest(v){kit.assertValidTws('approvalRequestParams',v);return v}});
  const wallet=kit.createTbcWallet({legacy:false,accounts:{current:async()=>accounts},engine:tracked,network,
    capabilities:{version:'1.0',scopes:[{chainId:p.request.chainId,intents:['tbc.transfer',p.request.intent.type],profiles:['core']}]},
    storage:{loadPermissions:async()=>({revision:'0',permissions}),commitPermissions:async()=>{throw Error('Unexpected permission mutation')}},
    clock:()=>now,randomBytes:n=>new Uint8Array(n).fill(7),
    approval:{async request(input,call){approvals++;assert.equal(approvals,1);assert.equal(input.binding.payload.operationHash,lastPlan.planHash);
      const review=kit.projectTbcApprovalPresentation(await evidence.read(call.callId,input.binding.bindingHash));
      assert.equal(review.trust,'binding-verified');assert.equal(review.counts.transactions.value,lastPlan.payload.transactions.length);
      assert.equal(review.businessTerms.value.contractId,contractId);approvedAt=performance.now();
      return{status:'approved',approvalId:'coin-batch',approvalToken:'public-fixture-token',bindingHash:input.binding.bindingHash,approvedAt:now,expiresAt:input.binding.payload.expiresAt};}},
    signer:{async sign({task}){assert.equal(approvals,1);signatures++;assert.equal(task.publicKey,account.publicKey);
      const signature=secp256k1.sign(task.digest,'1'.padStart(64,'0'),{prehash:false,lowS:true}).toCompactHex();lastSign=performance.now();
      return{taskId:task.taskId,signatureEncoding:'compact64',signature};}},
  });
  let n=0;const session=await wallet.openSession({origin:'https://wallet.test',sessionId:`batch-${index}`,requestIdFactory:()=>`coin-${index}-${++n}`,execution:{hostStore:store}});
  try{
    const exact={id:`request-${index}`,method:'tbc_signTransaction',params:p.request};
    const preparation=session.prefetchRequest(exact);
    assert.equal(await preparation.ready,'ready',JSON.stringify(await preparation.diagnostic));
    assert.equal(approvals+signatures,0);const before=trace.length;
    const response=(await session.handleRequest(exact)).response;const returned=performance.now();
    assert.equal(response.error,undefined,JSON.stringify(response.error));assert.equal(approvals,1);
    assert.equal(trace.length,before,'Preparation material must be reused');
    assert.equal(new Set(trace).size,trace.length,'Duplicate immutable downloads');
    assert.equal(response.result.transactions.length,wire.result.result.plan.payload.transactions.length);
    verify(p,response.result);
    rows.push({coinInputs:tokens.length,nativeInputs:nativeUtxos.length,intent:p.request.intent.type,transactions:response.result.transactions.length,
      approvals,signatures,httpReads:trace.length,afterPreparationReads:trace.length-before,
      approvalToSignMs:lastSign-approvedAt,approvalToReturnMs:returned-approvedAt});
    if(tokens.length===6&&nativeUtxos.length===1)for(const suffix of ['unknown','rejected']){
      let authorizations=0,submits=0,reconciles=0;const records=new Map();
      const controlled={resolveChainData:async()=>lastInput.snapshot,resolvePolicy:async()=>lastInput.policy,
        async broadcastSubmit(params){submits++;assert(submits<=2,'Duplicate POST');const tx=params.transaction;
          assert(!records.has(tx.txid),'Already submitted transaction');
          if(submits===1){records.set(tx.txid,'accepted');return{txid:tx.txid,status:'accepted'}}
          records.set(tx.txid,suffix);
          return{portError:{name:'UNAVAILABLE',message:'controlled suffix failure',retryable:true}};
        },
        async broadcastReconcile(params){reconciles++;return{transactions:params.txids.map(txid=>({txid,status:records.get(txid)==='accepted'?'mempool':records.get(txid)??'unknown'}))}},
      };
      const service=kit.createTbcBackendService({serviceId:`coin-recovery-${suffix}`,account:accounts[0],network:controlled,engine,
        authorize:async()=>{authorizations++;return{status:'approved',decisionId:'entire-bundle',approvedAt:now}},clock:()=>now,
        randomBytes:n=>new Uint8Array(n).fill(11),signer:{async sign({task}){return{taskId:task.taskId,signatureEncoding:'compact64',
          signature:secp256k1.sign(task.digest,'1'.padStart(64,'0'),{prehash:false,lowS:true}).toCompactHex()}}}});
      try{
        const prepared=await service.prepareTransaction(p.request);let outcome;
        try{outcome=await service.executePrepared({kind:'transaction',action:'send',prepared})}
        catch(error){outcome={error:{code:error.code,message:error.message,data:error.data}}}
        assert(!JSON.stringify(outcome).includes('Required Host Port failed'),'Fixture did not reach valid reconciliation');
        assert.equal(authorizations,1);assert.equal(submits,2);assert.equal(reconciles,1);
        try{await service.executePrepared({kind:'transaction',action:'send',prepared})}catch{}
        assert.equal(submits,2,'Same operation replay must not POST again');assert.equal(authorizations,1);
        assert.equal([...records.values()].filter(v=>v==='accepted').length,1);
        recoveryRows.push({suffix,authorizations,submits,reconciles,records:[...records].map(([txid,status])=>({txid,status})),outcome});
      }finally{service.close()}
    }
  } finally{await session.close()}
}
const report={status:'PASS',scope:'offline packed Kit Provider/Host, actual macOS Native ABI, WASM, independent script VM; no chain broadcast',
  version:JSON.parse(await readFile(join(pkg,'package.json'))).version,wireVectors:vectors.length,vmTransactions,vmInputs,rows,recoveryRows};
await writeFile(join(out,'report.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report));
