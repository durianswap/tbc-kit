// Offline shared Kit -> Core/Host -> source WASM acceptance. Public scalar 1,
// intercepted read-only HTTP, no installed wallet, endpoint or broadcast.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {registerHooks} from 'node:module';
import {build} from 'esbuild';
import {secp256k1} from '@noble/curves/secp256k1.js';
const root=fileURLToPath(new URL('../../../',import.meta.url)),rust=`${root}packages/tbc-engine/rust/`;
function cargo(args,env={}) {const r=spawnSync('cargo',args,{cwd:rust,env:{...process.env,...env},encoding:'utf8',timeout:60000,maxBuffer:8*1024*1024});
  assert.equal(r.status,0,'Cargo source check failed; synthetic raw output withheld');return r.stdout;}
cargo(['build','--offline','--locked','--release','-p','tbc-engine-wasm','--target','wasm32-unknown-unknown'],{RUSTFLAGS:'--cfg getrandom_backend="unsupported"'});
const dump=cargo(['test','--offline','--locked','-p','tbc-engine-core','--test','timelock_public',
  'public_timelock_uses_shared_plan_approval_and_finalize','--','--exact','--nocapture'],{TIMELOCK_PUBLIC_DUMP_WIRE:'1'});
const materials=dump.split('\n').filter(l=>l.startsWith('TIMELOCK_PUBLIC_WIRE:')).map(l=>JSON.parse(l.slice('TIMELOCK_PUBLIC_WIRE:'.length)))
  .filter(r=>r.definition==='planParams').map(r=>r.value);
assert.equal(materials.length,2);
const bundle=await build({stdin:{contents:`
  export { createTbcWallet } from './packages/kit/src/wallet-runtime.ts';
  export { createDefaultTbcNetwork } from './packages/kit/src/default-network.ts';
  export { createTbcNetworkContext } from './packages/kit/src/network-context.ts';
  export { prepareTbcTransaction, prepareTbcWorkflow } from './packages/kit/src/prepared.ts';
  export { preparedChainDataRequirement } from './packages/kit/src/prepared-chain-data.ts';
  export { createApprovalHostEvidenceReader } from './packages/kit/src/approval-host-evidence.ts';
  export { projectTbcApprovalPresentation } from './packages/kit/src/approval-presentation.ts';
  export { inspectTbcTransaction } from './packages/kit/src/testnet-validation.ts';
  export { createMemoryTwsHostStore } from './packages/host/src/index.ts';
  export { chainDataRequirement, hashCanonical, assertValidTws } from './packages/core/src/index.ts';
  export { TWS_RELEASE_FINGERPRINT } from './packages/core/src/release.ts';
  export { createTbcEngine } from './packages/tbc-engine/src/facade.ts';
  export { createWasmTbcEngineBackend } from './packages/tbc-engine/src/wasm.ts';
`,resolveDir:root,loader:'ts'},alias:{'@tbc-wallet/core':`${root}packages/core/src/index.ts`,'@tbc-wallet/host':`${root}packages/host/src/index.ts`,
  '@tbc-wallet/provider':`${root}packages/provider/src/index.ts`,'@tbc-wallet/provider/in-memory':`${root}packages/provider/src/in-memory.ts`},
  bundle:true,write:false,format:'esm',platform:'node',target:'node22',logLevel:'silent'});
const virtual=new URL('../../../packages/kit/src/.timelock-source-check.mjs',import.meta.url).href;
const hooks=registerHooks({resolve(s,c,next){return s===virtual?{url:virtual,shortCircuit:true}:next(s,c);},
  load(u,c,next){return u===virtual?{source:bundle.outputFiles[0].text,format:'module',shortCircuit:true}:next(u,c);}});
const kit=await import(virtual);hooks.deregister();
const engine=kit.createTbcEngine({backend:await kit.createWasmTbcEngineBackend(readFileSync(`${rust}target/wasm32-unknown-unknown/release/tbc_engine_wasm.wasm`))});
const now=new Date().toISOString().replace(/\.\d{3}Z$/u,'Z'),expires=new Date(Date.parse(now)+120000).toISOString().replace(/\.\d{3}Z$/u,'Z');
const checks=[];
for(const material of materials) for(const prepared of [false,true]) for(const chain of ['mainnet','testnet']) for(const workflow of [false,true,'mixed']) {
  if(workflow==='mixed'&&material.request.intent.type==='tbc-timelock-unlock')continue;
  const mixed=workflow==='mixed',unlockMaterial=materials.find(m=>m.request.intent.type==='tbc-timelock-unlock');
  const request=structuredClone(material.request),snapshot=structuredClone(material.snapshot);
  request.chainId=`tbc:${chain}`;request.constraints={...request.constraints,expiresAt:expires};
  const account={...snapshot.payload.account,chainId:request.chainId,accountId:`${request.chainId}:${request.from}`};
  const trace=[];let approvals=0,signatures=0,approvedReads,readFailure,approvalFailure;
  const unlocked=request.intent.type==='tbc-timelock-unlock';
  const raws=new Map([...snapshot.payload.parents,...(mixed?unlockMaterial.snapshot.payload.parents:[])].map(p=>[p.txid,p.rawTransaction]));
  const network=kit.createDefaultTbcNetwork({network:kit.createTbcNetworkContext({network:chain}),accounts:{current:async()=>[account]},
    now:()=>Date.parse(now),confirmationPolicy:{minConfirmations:'0'},fetch:async(input,init)=>{
      assert.equal(approvedReads,undefined,'Read after approval');assert.equal(init?.method??'GET','GET');
      const url=new URL(String(input));assert.equal(url.origin,chain==='mainnet'?'https://api.turingbitchain.io':'https://api.tbcdev.org');
      trace.push(url.pathname);let data;
      if(url.pathname==='/api/tbc/nodeinfo')data={blocks:snapshot.payload.block.height,bestblockhash:snapshot.payload.block.hash};
      else if(url.pathname===`/api/tbc/${unlocked?'frozenUtxo':'utxo'}/address/${account.address}${unlocked?'/piggyBank':''}`)
        data={utxos:snapshot.payload.utxos.map(u=>({txid:u.txid,index:u.vout,value:u.satoshis,height:'1'}))};
      else if(mixed&&url.pathname===`/api/tbc/frozenUtxo/address/${account.address}/piggyBank`)
        data={utxos:unlockMaterial.snapshot.payload.utxos.map(u=>({txid:u.txid,index:u.vout,value:u.satoshis,height:'1'}))};
      else if((unlocked||mixed)&&url.pathname.startsWith('/api/tbc/txraw/txid/')){
        const id=url.pathname.split('/').at(-1);assert.ok(raws.has(id),'Unrelated parent read');data={txraw:raws.get(id)};
      }else throw new Error(`Unexpected material endpoint: ${url.pathname}`);
      return new Response(JSON.stringify({code:'200',data}),{status:200});
    }});
  assert.deepEqual(kit.preparedChainDataRequirement(request),kit.chainDataRequirement(request));
  const observed={...network,async resolveChainData(...args){try {const result=await network.resolveChainData(...args);if(result.portError)readFailure=JSON.stringify({result,params:args[0]});return result;}
    catch(error){readFailure=error.message;throw error;}},
    async broadcast(){throw new Error('Forbidden offline broadcast');}};
  const operation=workflow?{version:'1.0',chainId:request.chainId,from:request.from,maxTotalFee:String(BigInt(request.constraints.maxFee)*(mixed?2n:1n)),expiresAt:expires,
    steps:[{id:'deposit',kind:'transaction',dependsOn:[],intent:request.intent,constraints:request.constraints},
      ...(mixed?[{id:'withdraw',kind:'transaction',dependsOn:[],intent:unlockMaterial.request.intent,
        constraints:{...unlockMaterial.request.constraints,expiresAt:expires}}]:[]),
      {id:'receipt',kind:'message',dependsOn:['deposit'],message:{encoding:'utf8',data:JSON.stringify({txids:[]})},
        bindings:[{target:'txids',source:{stepId:'deposit',output:'transactionIds'}}]}]}:request;
  const params=prepared?await (workflow?kit.prepareTbcWorkflow:kit.prepareTbcTransaction)({request:operation,engine,network:observed}):operation;
  const store=kit.createMemoryTwsHostStore({now:()=>Date.parse(now)});
  const evidence=kit.createApprovalHostEvidenceReader({store,releaseFingerprint:kit.TWS_RELEASE_FINGERPRINT,
    parseApprovalRequest(value){kit.assertValidTws('approvalRequestParams',value);return value;}});
  const permissions=['tbc_accounts','tbc_signTransaction',...(workflow?['tbc_signWorkflow','tbc_signMessage']:[])].map(capability=>({id:`tl-${capability}`,parentCapability:capability,
    invoker:'https://wallet.test',date:Date.parse(now),caveats:[{type:'restrictChains',value:[account.chainId]},
      {type:'restrictAccounts',value:[account.accountId]},{type:'restrictMethods',value:[capability]}]}));
  const runtime=kit.createTbcWallet({legacy:false,accounts:{current:async()=>[account]},engine,
    capabilities:{version:'1.0',scopes:[{chainId:account.chainId,intents:['tbc.transfer','tbc-timelock-lock','tbc-timelock-unlock'],profiles:['core']}]},
    approval:{async request(input,call){try{
      approvals++;approvedReads=trace.length;
      const bound=await evidence.read(call.callId,input.binding.bindingHash),model=kit.projectTbcApprovalPresentation(bound);
      assert.equal(model.trust,'binding-verified');
      const shown=workflow?model.steps.find(step=>step.id==='deposit'):model;
      assert.equal(shown.businessType.value,request.intent.type);
      assert.deepEqual(shown.businessTerms.value,request.intent);
      if(mixed)assert.deepEqual(model.steps.find(step=>step.id==='withdraw').businessTerms.value,unlockMaterial.request.intent);
      return {status:'approved',approvalId:'timelock',approvalToken:'timelock-token',bindingHash:input.binding.bindingHash,approvedAt:now,expiresAt:input.binding.payload.expiresAt};
    }catch(error){approvalFailure=error.message;throw error;}}},
    signer:{async sign(input){assert.equal(approvals,1);signatures++;assert.equal(input.task.publicKey,account.publicKey);
      const signature=secp256k1.sign(input.task.digest,'1'.padStart(64,'0'),{prehash:false,lowS:true});
      assert.ok(['compact64','compact65-recoverable'].includes(input.task.signatureEncoding));
      return {taskId:input.task.taskId,signatureEncoding:input.task.signatureEncoding,
        signature:(input.task.signatureEncoding==='compact65-recoverable'?(31+signature.recovery).toString(16):'')+signature.toCompactHex()};}},
    storage:{async loadPermissions(){return {revision:'0',permissions};},async commitPermissions(){throw new Error('Unexpected grant mutation');}},
    network:observed,clock:()=>now,randomBytes:length=>Uint8Array.from({length},(_,i)=>i)});
  let ids=0;const session=await runtime.openSession({origin:'https://wallet.test',sessionId:`tl-${checks.length}`,requestIdFactory:()=>`tl-${++ids}`,execution:{hostStore:store}});
  try {
    const envelope={id:`request-${++ids}`,method:workflow?(prepared?'tbc_signPreparedWorkflow':'tbc_signWorkflow'):(prepared?'tbc_signPreparedTransaction':'tbc_signTransaction'),params};
    // Explicit transaction prefetch is a single-transaction API. Workflows
    // use the shared Host workflow material preparation path instead.
    if(!prepared&&!workflow){const p=session.prefetchRequest(envelope);assert.equal(await p.ready,'ready',readFailure??JSON.stringify(await p.diagnostic));assert.equal(approvals+signatures,0);}
    const response=(await session.handleRequest(envelope)).response;
    assert.equal(response.error,undefined,`${readFailure??''} ${approvalFailure??''} ${JSON.stringify(response.error)}`);
    assert.equal(approvals,1);assert.equal(signatures,mixed?3:workflow?2:1);assert.equal(trace.length,approvedReads);
    const txs=workflow?response.result.steps.find(step=>step.id==='deposit').result.transactions:response.result.transactions;
    assert.equal(txs.length,1);
    for(const tx of txs)assert.equal(kit.inspectTbcTransaction(tx.rawTransaction).txid,tx.txid);
    if(mixed){const withdrawals=response.result.steps.find(step=>step.id==='withdraw').result.transactions;
      assert.equal(withdrawals.length,1);assert.notEqual(withdrawals[0].txid,txs[0].txid);
      assert.equal(kit.inspectTbcTransaction(withdrawals[0].rawTransaction).txid,withdrawals[0].txid);}
    if(workflow){const receipt=response.result.steps.find(step=>step.id==='receipt').result;
      assert.ok(receipt.signature);assert.deepEqual(JSON.parse(receipt.envelope.message.data).txids,txs.map(tx=>tx.txid));}
    const expected=mixed?(prepared?7:4):(prepared?4:2)+(unlocked?1:0);
    assert.equal(trace.length,expected,JSON.stringify(trace));
    checks.push({type:request.intent.type,chain,prepared,workflow,approvals,signatures,reads:trace.length,postApprovalReads:0});
  } finally {await session.close();}
}
console.log(JSON.stringify({status:'TIMELOCK_KIT_SOURCE_PASS',checks,externalRequests:0,broadcasts:0,deviceAcceptance:false}));
