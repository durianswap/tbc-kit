// Protocol/Host integration over authenticated public Rust fixture snapshots.
// --http uses the production default loader with intercepted read-only HTTP.
// Neither mode proves installed-device or real-chain acceptance.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {registerHooks} from 'node:module';
import {build} from 'esbuild';
import {secp256k1} from '@noble/curves/secp256k1.js';
const root=fileURLToPath(new URL('../../../',import.meta.url)),rust=`${root}packages/tbc-engine/rust/`;
const httpMode=process.argv.includes('--http');
const conflict=process.argv.includes('--multi-conflict');
const multi=conflict||process.argv.includes('--multi');
const workflow=multi||process.argv.includes('--workflow');
const clientMode=process.argv.includes('--client');
const installed=process.env.LOP_KIT_INSTALLED_CONSUMER?join(resolve(process.env.LOP_KIT_INSTALLED_CONSUMER),'node_modules/@tbc/kit'):null;
let installedVersion;
if(installed){
  installedVersion=JSON.parse(readFileSync(join(installed,'package.json'))).version;
  assert.equal(installedVersion,'0.1.0-candidate.207');
  for(const item of JSON.parse(readFileSync(join(installed,'artifacts/provenance.json'))).artifacts)
    assert.equal(createHash('sha256').update(readFileSync(join(installed,item.path))).digest('hex'),item.sha256);
}
assert.ok(!clientMode||(httpMode&&!workflow),'Client example gate uses single Prepared calls and the default loader');
assert.ok(!multi||httpMode,'Multi-step gate requires the real default HTTP loader');
function cargo(args,env={}){const result=spawnSync('cargo',args,{cwd:rust,env:{...process.env,...env},encoding:'utf8',timeout:60000,maxBuffer:24*1024*1024});
  assert.equal(result.status,0,'Cargo failed; synthetic raw output withheld');return result.stdout;}
if(!installed)cargo(['build','--offline','--locked','--release','-p','tbc-engine-wasm','--target','wasm32-unknown-unknown'],{RUSTFLAGS:'--cfg getrandom_backend="unsupported"'});
if(httpMode&&!installed)cargo(['build','--offline','--locked','--release','-p','tbc-keyless-wasm','--target','wasm32-unknown-unknown'],{RUSTFLAGS:'--cfg getrandom_backend="unsupported"'});
const dump=cargo(['test','--offline','--locked','-p','tbc-engine-core','--test','lop_public','uses_shared_bound_signer_and_finalize','--','--test-threads=1','--nocapture'],{LOP_PUBLIC_DUMP_WIRE:'1'});
assert.ok(dump.includes('test result: ok. 3 passed; 0 failed;'));
const marker='LOP_PUBLIC_WIRE:';
const materials=dump.split('\n').filter(line=>line.includes(marker)).map(line=>JSON.parse(line.slice(line.indexOf(marker)+marker.length)))
  .filter(record=>record.definition==='planParams').map(record=>record.value);
assert.equal(materials.length,27);
const bundle=await build({stdin:{contents:`
export {createTbcWallet} from './packages/kit/src/wallet-runtime.ts';
export {createTbcClient} from './packages/kit/src/client.ts';
export {prepareLopProposal,signLopProposal} from './packages/kit/examples/lop-prepared/prepare.mjs';
export {createDefaultTbcNetwork} from './packages/kit/src/default-network.ts';
export {createTbcNetworkContext} from './packages/kit/src/network-context.ts';
export {prepareTbcTransaction,prepareTbcWorkflow} from './packages/kit/src/prepared.ts';
export {preparedChainDataRequirement} from './packages/kit/src/prepared-chain-data.ts';
export {createApprovalHostEvidenceReader} from './packages/kit/src/approval-host-evidence.ts';
export {projectTbcApprovalPresentation} from './packages/kit/src/approval-presentation.ts';
export {inspectTbcTransaction} from './packages/kit/src/testnet-validation.ts';
export {createMemoryTwsHostStore} from './packages/host/src/index.ts';
export {chainDataRequirement,hashCanonical,assertValidTws} from './packages/core/src/index.ts';
export {TWS_RELEASE_FINGERPRINT} from './packages/core/src/release.ts';
export {createTbcEngine} from './packages/tbc-engine/src/facade.ts';
export {createWasmTbcEngineBackend} from './packages/tbc-engine/src/wasm.ts';
export {createWasmTbcKeylessEngine} from './packages/kit/src/keyless.ts';`,resolveDir:root,loader:'ts'},
alias:{'@tbc/kit':installed?join(installed,'dist/esm/index.js'):`${root}packages/kit/src/index.ts`,'@tbc-wallet/core':`${root}packages/core/src/index.ts`,'@tbc-wallet/host':`${root}packages/host/src/index.ts`,
  '@tbc-wallet/provider':`${root}packages/provider/src/index.ts`,'@tbc-wallet/provider/in-memory':`${root}packages/provider/src/in-memory.ts`,
  '@tbc-wallet/provider/webview':`${root}packages/provider/src/webview.ts`},
bundle:true,write:false,format:'esm',platform:'node',target:'node22',logLevel:'silent'});
const virtual=new URL('../../../packages/kit/src/.lop-source-check.mjs',import.meta.url).href;
const hooks=registerHooks({resolve(s,c,next){return s===virtual?{url:virtual,shortCircuit:true}:next(s,c)},
  load(u,c,next){return u===virtual?{source:bundle.outputFiles[0].text,format:'module',shortCircuit:true}:next(u,c)}});
const kit={...await import(virtual)};hooks.deregister();
if(installed){
  const modules=await Promise.all(['index','wallet','api','engine'].map(name=>import(pathToFileURL(join(installed,`dist/esm/${name}.js`)))));
  const published=Object.assign({},...modules);
  assert.equal(published.TWS_RELEASE_FINGERPRINT,kit.TWS_RELEASE_FINGERPRINT,'Fixture schema differs from frozen delivery');
  // Only fixture requirement assertions remain source helpers; every executed
  // client/prepare/wallet/Host/store/approval/parser/Engine uses package exports.
  const fixtureOnly=new Set(['chainDataRequirement','preparedChainDataRequirement','prepareLopProposal','signLopProposal']);
  for(const key of Object.keys(kit))if(!fixtureOnly.has(key)){assert.ok(key in published,`Missing published export ${key}`);kit[key]=published[key];}
}
const engineBytes=installed?join(installed,'artifacts/wasm/tbc_engine_wasm.wasm'):`${rust}target/wasm32-unknown-unknown/release/tbc_engine_wasm.wasm`;
const sourceEngine=kit.createTbcEngine({backend:await kit.createWasmTbcEngineBackend(readFileSync(engineBytes))});
let engineFailure;
const successfulPlans=[];
const engine=Object.fromEntries(Object.entries(sourceEngine).map(([method,fn])=>[method,async(params)=>{try{const result=await fn(params);if(method==='plan')successfulPlans.push(result);return result}catch(error){engineFailure=`${method}: ${error.message}`;throw error}}]));
const keyless=httpMode?await kit.createWasmTbcKeylessEngine(readFileSync(installed?join(installed,'artifacts/wasm/tbc_keyless_wasm.wasm'):`${rust}target/wasm32-unknown-unknown/release/tbc_keyless_wasm.wasm`)):undefined;
let materialParity=0;
if(httpMode){
  const native=cargo(['test','--offline','--locked','-p','tbc-keyless-core','--test','lop_material','--','--nocapture'],{LOP_MATERIAL_DUMP_WIRE:'1'});
  const rows=native.split('\n').filter(line=>line.startsWith('LOP_MATERIAL_WIRE:')).map(line=>JSON.parse(line.slice('LOP_MATERIAL_WIRE:'.length)));
  assert.equal(rows.length,4);
  for(const row of rows){assert.deepEqual(JSON.parse(await keyless.execute('inspectLopMaterial',JSON.stringify(row.input))),row.result);materialParity++;}
  await assert.rejects(keyless.execute('inspectLopMaterial',JSON.stringify({...rows[0].input,privateKey:'forbidden'})));
  await assert.rejects(keyless.execute('inspectLopMaterial',JSON.stringify({...rows[0].input,parent:{...rows[0].input.parent,txid:'00'.repeat(32)}})));
}
const now=new Date().toISOString().replace(/\.\d{3}Z$/u,'Z'),expires=new Date(Date.parse(now)+120000).toISOString().replace(/\.\d{3}Z$/u,'Z');
// Rust fixtures use public scalar 1 for owners and 4 for the independent matcher.
const keys=new Map([1,4].map(n=>{const scalar=String(n).padStart(64,'0');return[Buffer.from(secp256k1.getPublicKey(scalar)).toString('hex'),scalar]}));
let checked=0,totalSignatures=0;const requestCounts=[];
for(const material of materials.filter(m=>!multi||(m.request.intent.type==='tbc-lop-create'&&m.request.intent.order.market==='native-token'&&m.request.intent.order.side==='sell')))for(const prepared of clientMode?[true]:[false,true])for(const chain of ['mainnet','testnet']){
  successfulPlans.length=0;engineFailure=undefined;
  const request=structuredClone(material.request),snapshot=structuredClone(material.snapshot);
  request.chainId=`tbc:${chain}`;request.constraints={...request.constraints,expiresAt:expires};
  const account={...snapshot.payload.account,chainId:request.chainId,accountId:`${request.chainId}:${request.from}`};
  let second;
  if(multi){
    // Public synthetic funding with two distinct outputs, no chain claim.
    // It makes the two orders independent while sharing asset identity reads.
    const template=snapshot.payload.utxos.find(u=>u.classification==='native');assert.ok(template);
    const amount=Buffer.alloc(8);amount.writeBigUInt64LE(BigInt(template.satoshis));
    const output=amount.toString('hex')+(template.scriptPubKey.length/2).toString(16).padStart(2,'0')+template.scriptPubKey;
    const raw='0a00000001'+'ff'.repeat(32)+'0000000000ffffffff02'+output+output+'00000000';
    const txid=kit.inspectTbcTransaction(raw).txid;
    snapshot.payload.utxos=snapshot.payload.utxos.filter(u=>u.classification!=='native');
    snapshot.payload.utxos.push(...[0,1].map(vout=>({...template,txid,vout})));
    snapshot.payload.parents.push({txid,rawTransaction:raw});
    request.constraints.inputOutpoints=[{txid,vout:0}];second=structuredClone(request);
    second.constraints.inputOutpoints=[{txid,vout:conflict?0:1}];second.intent.order.saleVolume=String(BigInt(second.intent.order.saleVolume)+1n);
  }
  snapshot.payload.chainId=request.chainId;snapshot.payload.account=account;snapshot.payload.capturedAt=now;snapshot.payload.expiresAt=expires;
  snapshot.snapshotHash=kit.hashCanonical(snapshot.payload);
  let approvals=0,signatures=0,materialCalls=0,approvalFailure,materialFailure;
  const trace=[],raws=new Map(snapshot.payload.parents.map(p=>[p.txid,p.rawTransaction]));
  const defaults=kit.createDefaultTbcNetwork({network:kit.createTbcNetworkContext({network:chain}),accounts:{current:async()=>[account]},
    ...(httpMode?{poolNative:keyless,confirmationPolicy:{minConfirmations:'0'}}:{}),
    now:()=>Date.parse(now),fetch:async(input,init)=>{
      assert.ok(httpMode,'Protocol-only gate must not make HTTP requests');assert.equal(approvals,0,'Read after approval');
      const url=new URL(String(input));assert.equal(url.origin,chain==='mainnet'?'https://api.turingbitchain.io':'https://api.tbcdev.org');
      assert.equal(init?.method??'GET',url.pathname==='/api/tbc/txo/status'?'POST':'GET');trace.push(url.pathname);let data;
      if(url.pathname==='/api/tbc/nodeinfo')data={blocks:snapshot.payload.block.height,bestblockhash:snapshot.payload.block.hash,...(snapshot.payload.block.medianTimePast===undefined?{}:{mediantime:snapshot.payload.block.medianTimePast})};
      else if(url.pathname===`/api/tbc/utxo/address/${account.address}`)data={utxos:snapshot.payload.utxos.filter(u=>u.classification==='native').map(u=>({txid:u.txid,index:u.vout,value:u.satoshis,height:'1'}))};
      else if(url.pathname==='/api/tbc/txo/status'){
        const requested=JSON.parse(init.body).txos;
        const expected=[];for(const p of request.intent.targetOutpoints){
          expected.push({txid:p.txid,index:p.vout});const order=JSON.parse(await keyless.execute('inspectLopMaterial',JSON.stringify({phase:'inspectOrder',parent:{txid:p.txid,rawTransaction:raws.get(p.txid)},vout:p.vout})));
          if(order.escrow!==null)expected.push({txid:p.txid,index:p.vout+1});
        }
        assert.deepEqual(requested,expected);data={txos:requested.map(p=>{const u=snapshot.payload.utxos.find(u=>u.txid===p.txid&&u.vout===p.index);assert.ok(u);return {txid:p.txid,index:String(p.index),value:u.satoshis,height:'1',spent:false,scriptPubKey:u.scriptPubKey}})};
      }else if(url.pathname.startsWith('/api/tbc/ft/utxo/combinescript/')||url.pathname.startsWith('/api/tbc/stablecoin/utxo/combinescript/')){
        const id=url.pathname.split('/').at(-1),hint=kit.chainDataRequirement(request).lopAssets?.find(a=>a.contractId===id);
        assert.equal(hint?.purpose,'escrow','Quote-only assets must not query account holdings');
        const rows=snapshot.payload.utxos.filter(u=>u.contractId===id&&['ft','stablecoin'].includes(u.classification));
        data={utxos:await Promise.all(rows.map(async u=>{
          const asset=JSON.parse(await keyless.execute('inspectLopMaterial',JSON.stringify({phase:'inspectAsset',parent:{txid:u.txid,rawTransaction:raws.get(u.txid)},vout:u.vout})));
          return {txid:u.txid,index:u.vout,tbc_value:u.satoshis,ft_value:asset.balance,height:'1'};
        }))};
      }else if(url.pathname.startsWith('/api/tbc/stablecoin/info/stablecoinid/')){
        const id=url.pathname.split('/').at(-1),record=snapshot.payload.contracts.find(c=>c.contractId===id);assert.ok(record);
        assert.equal(kit.chainDataRequirement(request).lopAssets?.find(a=>a.contractId===id)?.purpose,'identity');
        data={stablecoin_id:id,utxo:{txid:record.currentOutpoint.txid,vout:0}};
      }else if(url.pathname.startsWith('/api/tbc/txraw/txid/')){
        const id=url.pathname.split('/').at(-1);assert.ok(raws.has(id),'Unrelated parent read');
        assert.equal(trace.filter(p=>p===url.pathname).length,1,'Immutable raw was read more than once');data={txraw:raws.get(id)};
      }else throw new Error(`Unexpected material endpoint: ${url.pathname}`);
      return new Response(JSON.stringify({code:'200',data}),{status:200});
    }});
  const network={...defaults,async resolveChainData(params){
    try{
    assert.equal(approvals,0,'Material accessed after approval');materialCalls++;
    if(params.workflowSteps){assert.ok(multi);assert.equal(params.workflowSteps.length,2);
      assert.deepEqual(params.workflowSteps.map(s=>s.requirement),[request,second].map(kit.chainDataRequirement));
    }else{
      assert.ok([request,...(second?[second]:[])].some(r=>kit.hashCanonical(params.requirement)===kit.hashCanonical(kit.chainDataRequirement(r))),'Canonical material requirement differs');
      assert.deepEqual(kit.chainDataRequirement(request),kit.preparedChainDataRequirement(request));
    }
    return httpMode?defaults.resolveChainData(params):structuredClone(snapshot);
    }catch(error){materialFailure=error.message;throw error;}
  },async broadcast(){throw new Error('Offline gate prohibits broadcasting')}};
  const operation=workflow?{version:'1.0',chainId:request.chainId,from:request.from,maxTotalFee:String(BigInt(request.constraints.maxFee)*(multi?2n:1n)),expiresAt:expires,
    steps:[{id:'order',kind:'transaction',dependsOn:[],intent:request.intent,constraints:request.constraints},
      ...(multi?[{id:'second',kind:'transaction',dependsOn:[],intent:second.intent,constraints:second.constraints}]:[]),
      {id:'receipt',kind:'message',dependsOn:['order'],message:{encoding:'utf8',data:JSON.stringify({txids:[]})},
        bindings:[{target:'txids',source:{stepId:'order',output:'transactionIds'}}]},
      ...(multi?[{id:'secondReceipt',kind:'message',dependsOn:['second'],message:{encoding:'utf8',data:JSON.stringify({txids:[]})},
        bindings:[{target:'txids',source:{stepId:'second',output:'transactionIds'}}]}]:[])]}:request;
  if(workflow)kit.assertValidTws('workflowRequest',operation);
  if(conflict&&prepared){
    await assert.rejects(kit.prepareTbcWorkflow({request:operation,engine,network}),/same input outpoint/);
    assert.equal(approvals+signatures,0);checked++;continue;
  }
  const params=prepared?await (clientMode?kit.prepareLopProposal:workflow?kit.prepareTbcWorkflow:kit.prepareTbcTransaction)({request:operation,engine,network}):operation;
  const store=kit.createMemoryTwsHostStore({now:()=>Date.parse(now)});
  const evidence=kit.createApprovalHostEvidenceReader({store,releaseFingerprint:kit.TWS_RELEASE_FINGERPRINT,
    parseApprovalRequest(value){kit.assertValidTws('approvalRequestParams',value);return value}});
  const permissions=['tbc_accounts','tbc_signTransaction',...(workflow?['tbc_signWorkflow','tbc_signMessage']:[])].map(capability=>({id:`lop-${capability}`,parentCapability:capability,
    invoker:'https://wallet.test',date:Date.parse(now),caveats:[{type:'restrictChains',value:[account.chainId]},
      {type:'restrictAccounts',value:[account.accountId]},{type:'restrictMethods',value:[capability]}]}));
  const runtime=kit.createTbcWallet({legacy:false,accounts:{current:async()=>[account]},engine,
    capabilities:{version:'1.0',scopes:[{chainId:account.chainId,intents:['tbc.transfer','tbc-lop-create','tbc-lop-cancel','tbc-lop-match'],profiles:['core']}]},
    approval:{async request(input,call){try{
      approvals++;const bound=await evidence.read(call.callId,input.binding.bindingHash),model=kit.projectTbcApprovalPresentation(bound);
      assert.equal(model.trust,'binding-verified');const shown=workflow?model.steps.find(step=>step.id==='order'):model;
      assert.equal(shown.businessType.value,request.intent.type);assert.deepEqual(shown.businessTerms.value,request.intent);
      if(multi)assert.deepEqual(model.steps.find(step=>step.id==='second').businessTerms.value,second.intent);
      if(!workflow){const altered=structuredClone(bound);altered.memory.normalizedTransaction.request.intent.version='tampered';
        assert.throws(()=>kit.projectTbcApprovalPresentation(altered),'Changed terms cannot reuse approval evidence');}
      return{status:'approved',approvalId:'lop',approvalToken:'lop-token',bindingHash:input.binding.bindingHash,approvedAt:now,expiresAt:input.binding.payload.expiresAt};
    }catch(e){approvalFailure=e.message;throw e}}},
    signer:{async sign(input){assert.equal(approvals,1);signatures++;const scalar=keys.get(input.task.publicKey);assert.ok(scalar,'Only public test keys allowed');
      assert.ok(['compact64','compact65-recoverable'].includes(input.task.signatureEncoding));
      const signature=secp256k1.sign(input.task.digest,scalar,{prehash:false,lowS:true});
      return{taskId:input.task.taskId,signatureEncoding:input.task.signatureEncoding,
        signature:(input.task.signatureEncoding==='compact65-recoverable'?(31+signature.recovery).toString(16):'')+signature.toCompactHex()}}},
    storage:{async loadPermissions(){return{revision:'0',permissions}},async commitPermissions(){throw new Error('Unexpected grant mutation')}},
    network,clock:()=>now,randomBytes:length=>Uint8Array.from({length},(_,i)=>i)});
  let id=0;const session=await runtime.openSession({origin:'https://wallet.test',sessionId:`lop-${checked}`,requestIdFactory:()=>`lop-${++id}`,execution:{hostStore:store}});
  try{
    const envelope={id:`req-${++id}`,method:workflow?(prepared?'tbc_signPreparedWorkflow':'tbc_signWorkflow'):(prepared?'tbc_signPreparedTransaction':'tbc_signTransaction'),params};
    if(conflict){
      // Core reserves full planned input sets and throws before approval. The
      // current wallet surfaces that terminal Host failure as an exception.
      await assert.rejects(session.handleRequest(envelope),/Host operation did not produce a response: failed/);
      assert.equal(engineFailure,undefined);assert.equal(successfulPlans.length,2);
      const inputs=successfulPlans.map(p=>kit.inspectTbcTransaction(p.plan.payload.transactions[0].unsignedTransaction).transaction.inputs);
      assert.deepEqual(inputs[0],inputs[1],'Both successful plans must select the same synthetic input');
      assert.equal(approvals+signatures,0);checked++;continue;
    }
    if(!prepared&&!workflow){const prefetched=session.prefetchRequest(envelope);assert.equal(await prefetched.ready,'ready',`LOP source prefetch failed ${checked}/${request.intent.type}`);assert.equal(approvals+signatures,0)}
    let delivery;try{
      if(clientMode){
        let calls=0;
        const connection=await kit.createTbcClient({network:chain,provider:{async request(message){
          if(message.method==='tbc_requestAccounts')return[account.address];
          assert.equal(message.method,'tbc_signPreparedTransaction');calls++;
          const result=await session.handleRequest({id:`client-${++id}`,...message});
          if(result.response.error)throw new Error(JSON.stringify(result.response.error));
          return result.response.result;
        }}}).connect();
        await assert.rejects(kit.signLopProposal({...connection,chainId:'tbc:wrong'},params),/account\/network/);assert.equal(calls,0);
        delivery={response:{result:await kit.signLopProposal(connection,params)}};assert.equal(calls,1);
      }else delivery=await session.handleRequest(envelope);
    }catch(error){throw new Error(`LOP ${checked}/${request.intent.type}/${chain}/prepared=${prepared}: ${error.message}; engine=${engineFailure}; material=${materialFailure}; approval=${approvalFailure??approvals}; reads=${JSON.stringify(trace)}`)}
    assert.equal(delivery.response.error,undefined,`${request.intent.type}/${chain}/prepared=${prepared}: ${approvalFailure??JSON.stringify(delivery.response.error)}`);
    assert.equal(approvals,1);assert.ok(signatures>0);assert.equal(materialCalls,prepared?(multi?3:2):1);
    const txs=workflow?delivery.response.result.steps.find(step=>step.id==='order').result.transactions:delivery.response.result.transactions;assert.equal(txs.length,1);
    if(workflow){const receipt=delivery.response.result.steps.find(step=>step.id==='receipt').result;
      assert.ok(receipt.signature);const data=JSON.parse(receipt.envelope.message.data);assert.deepEqual(data.txids,txs.map(tx=>tx.txid));
      if(multi){const others=delivery.response.result.steps.find(step=>step.id==='second').result.transactions;assert.equal(others.length,1);
        assert.equal(kit.inspectTbcTransaction(others[0].rawTransaction).txid,others[0].txid);assert.notEqual(others[0].txid,txs[0].txid);
        const otherReceipt=delivery.response.result.steps.find(step=>step.id==='secondReceipt').result;
        assert.ok(otherReceipt.signature);assert.deepEqual(JSON.parse(otherReceipt.envelope.message.data).txids,others.map(tx=>tx.txid));assert.equal(signatures,4);}}
    assert.equal(kit.inspectTbcTransaction(txs[0].rawTransaction).txid,txs[0].txid);
    if(httpMode){
      assert.equal(trace.filter(p=>p==='/api/tbc/nodeinfo').length,prepared?2:1);
      assert.equal(trace.filter(p=>p===`/api/tbc/utxo/address/${account.address}`).length,prepared?2:1);
      assert.equal(trace.filter(p=>p==='/api/tbc/txo/status').length,request.intent.type==='tbc-lop-create'?0:prepared?2:1);
      const budgets={
        'tbc-lop-create':prepared?[6,8,10,12]:[4,5,7,8],
        'tbc-lop-cancel':prepared?[7,9]:[4,6],
        'tbc-lop-match':prepared?[10,11,12,13]:[7,8,9,10],
      };
      assert.ok(budgets[request.intent.type].includes(trace.length),'LOP fixture read budget regressed');
    }
    totalSignatures+=signatures;checked++;
    requestCounts.push({intent:request.intent.type,prepared,reads:trace.length});
  }finally{await session.close()}
}
console.log(JSON.stringify({status:installed?'LOP_KIT_INSTALLED_PASS':conflict?'LOP_WORKFLOW_CONFLICT_SOURCE_PASS':httpMode?'LOP_KIT_DEFAULT_HTTP_SOURCE_PASS':'LOP_KIT_PROTOCOL_SOURCE_PASS',installedVersion,scenarios:checked,signatures:totalSignatures,approvals:conflict?0:checked,
  material:httpMode?'production default HTTP loader; intercepted public fixtures':'bound Rust fixture snapshots; NOT default HTTP loader',
  requestCounts:[...new Set(requestCounts.map(v=>`${v.intent}/prepared=${v.prepared}:${v.reads}`))],
  workflow,multi,conflict,clientMode,materialNativeWasmParity:materialParity,externalRequests:0,broadcasts:0,deviceAcceptance:false}));
