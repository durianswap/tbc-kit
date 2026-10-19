#!/usr/bin/env node
// Default historical Pool versus unified AMM routing with public, frozen test
// material. Real source keyless/Engine WASM, synthetic GETs only; no custody.
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,writeFileSync,readdirSync} from 'node:fs';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {resolve,join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {registerHooks} from 'node:module';
import {spawnSync} from 'node:child_process';
import {build} from 'esbuild';
import {measureUnifiedRoute} from './lib/measure-unified-route.mjs';

const root=fileURLToPath(new URL('../../../',import.meta.url)), rust=`${root}packages/tbc-engine/rust/`;
const benchmark=process.argv.includes('--benchmark'),timings=[];
assert.ok(process.argv.length===2||process.argv.length===3||(process.argv.length===4&&benchmark),'Optional EXACT_KIT_CONSUMER [--benchmark]');
globalThis.fetch=async()=>{throw Error('No real HTTP in public fixture gate');};
const installed=process.argv[2]?join(resolve(process.argv[2]),'node_modules/@tbc/kit'):undefined;
const sha=b=>createHash('sha256').update(b).digest('hex');
let installedVersion,archiveProof;
if(installed){
 installedVersion=JSON.parse(readFileSync(join(installed,'package.json'),'utf8')).version;
 assert.ok(['0.1.0-candidate.217','0.1.0-candidate.225','0.1.0-candidate.226'].includes(installedVersion),'Only pinned acceptance candidates');
 if(installedVersion!=='0.1.0-candidate.217'){
  const pinned=installedVersion==='0.1.0-candidate.225'
   ? ['candidate225','0505dc865db6604403994121a8da14f014381a25e0bfb63cd1025b6a937c46c4']
   : ['candidate226-complete','1fb39857b8326fdcbf2af2fa43d46a5d3a87d7daad81d8e012d2d69a6d5e53a4'];
  const archive=join(root,'native/engine/delivery',pinned[0],`tbc-kit-${installedVersion}.tgz`);
  const digest=sha(readFileSync(archive));
  assert.equal(digest,pinned[1]);
  const unpacked=mkdtempSync(join(tmpdir(),'tbc-pool225-identity-'));
  const unpack=spawnSync('tar',['-xzf',archive,'-C',unpacked],{encoding:'utf8'});
  assert.equal(unpack.status,0,'Frozen archive extraction failed');
  function hashes(base,relative='',result={}){
   for(const entry of readdirSync(join(base,relative),{withFileTypes:true})){
    const p=join(relative,entry.name);
    if(entry.isDirectory())hashes(base,p,result);
    else {assert.ok(entry.isFile(),'Unexpected non-file');result[p]=sha(readFileSync(join(base,p)));}
   }
   return result;
  }
  const expected=hashes(join(unpacked,'package'));
  assert.deepEqual(hashes(installed),expected,'Installed files must exactly match frozen225');
  assert.equal(Object.keys(expected).length,922);
  archiveProof={sha256:digest,files:922};
 }
 const provenance=JSON.parse(readFileSync(join(installed,'artifacts/provenance.json'),'utf8'));
 for(const a of provenance.artifacts)assert.equal(sha(readFileSync(join(installed,a.path))),a.sha256);
}else{
 const built=spawnSync('cargo',['build','--offline','--locked','--release','-p','tbc-engine-wasm','-p','tbc-keyless-wasm','--target','wasm32-unknown-unknown'],{
 cwd:rust,env:{...process.env,RUSTFLAGS:'--cfg getrandom_backend="unsupported"'},encoding:'utf8',timeout:120000,maxBuffer:8*1024*1024,
});
assert.equal(built.status,0,'Source WASM build failed; output withheld');
}
const bundled=await build({stdin:{contents:installed?`
 export {createControlledTestnetFetch} from './packages/kit/test/controlled-testnet.ts';
`: `
 export {createDefaultTbcNetwork} from './packages/kit/src/default-network.ts';
 export {createTbcNetworkContext} from './packages/kit/src/network-context.ts';
 export {createWasmTbcKeylessEngine} from './packages/kit/src/keyless.ts';
 export {createWasmTbcEngineBackend} from './packages/tbc-engine/src/wasm.ts';
 export {createControlledTestnetFetch} from './packages/kit/test/controlled-testnet.ts';
 export {chainDataRequirement,hashCanonical} from './packages/core/src/index.ts';
`,resolveDir:root,loader:'ts'},alias:{'@tbc-wallet/core':`${root}packages/core/src/index.ts`},bundle:true,write:false,format:'esm',platform:'node',logLevel:'silent'});
const url=new URL('./.unified-pool-source.mjs',import.meta.url).href;
const hooks=registerHooks({resolve(s,c,next){return s===url?{url,shortCircuit:true}:next(s,c);},
 load(u,c,next){return u===url?{source:bundled.outputFiles[0].text,format:'module',shortCircuit:true}:next(u,c);}});
let kit=await import(url);hooks.deregister();
if(installed){
 const wallet=await import(pathToFileURL(join(installed,'dist/esm/wallet.js'))),index=await import(pathToFileURL(join(installed,'dist/esm/index.js'))),engine=await import(pathToFileURL(join(installed,'dist/esm/engine.js')));
 kit={...kit,createDefaultTbcNetwork:wallet.createDefaultTbcNetwork,createTbcNetworkContext:wallet.createTbcNetworkContext,
  chainDataRequirement:wallet.chainDataRequirement,hashCanonical:wallet.hashCanonical,
  createWasmTbcKeylessEngine:index.createWasmTbcKeylessEngine,createWasmTbcEngineBackend:engine.createWasmTbcEngineBackend};
}
const keyless=await kit.createWasmTbcKeylessEngine(readFileSync(installed?join(installed,'artifacts/wasm/tbc_keyless_wasm.wasm'):`${rust}target/wasm32-unknown-unknown/release/tbc_keyless_wasm.wasm`));
const engine=await kit.createWasmTbcEngineBackend(readFileSync(installed?join(installed,'artifacts/wasm/tbc_engine_wasm.wasm'):`${rust}target/wasm32-unknown-unknown/release/tbc_engine_wasm.wasm`));
const fixtures=['controlled-pool','controlled-pool-remove'].map(name=>JSON.parse(readFileSync(`${root}packages/kit/test/fixtures/${name}.json`,'utf8')));
const generated=spawnSync('cargo',['test','--offline','--locked','-p','tbc-engine-core','--test','pool','unified_pool_loader_fragmented_fixture','--','--nocapture'],{
 cwd:rust,env:{...process.env,UNIFIED_POOL_LOADER_FIXTURE:'1'},encoding:'utf8',timeout:120000,maxBuffer:8*1024*1024,
});
assert.equal(generated.status,0,'Synthetic fragmented fixture build failed; material withheld');
const marker='UNIFIED_POOL_LOADER_FIXTURE:';
const rows=generated.stdout.split(/\r?\n/u).filter(line=>line.includes(marker));
assert.equal(rows.length,1);
const fragmented=JSON.parse(rows[0].slice(rows[0].indexOf(marker)+marker.length));
function fragmentedFetch(input,init){
 assert.equal(init?.method??'GET','GET');
 const path=new URL(String(input)).pathname;
 let data;
 if(path===`/api/tbc/pool/poolinfo/poolid/${fragmented.poolContractId}`)data=fragmented.poolInfo;
 else if(path==='/api/tbc/nodeinfo')data={blocks:800000,bestblockhash:'aa'.repeat(32)};
 else if(path===`/api/tbc/utxo/address/${fragmented.address}`)data={utxos:[fragmented.native]};
 else if(path.startsWith('/api/tbc/txraw/txid/')){const raw=fragmented.rawTransactions[path.split('/').at(-1)];assert.ok(raw,'Unknown synthetic parent');data={txraw:raw};}
 else if(path.startsWith('/api/tbc/ft/utxo/combinescript/')&&path.endsWith(`/contract/${fragmented.poolInfo.ft_contract_id}`))data={utxos:fragmented.poolFt};
 else if(/^\/api\/tbc\/pool\/lputxo\/scriptpubkeyhash\/[0-9a-f]{64}$/u.test(path))data={utxos:fragmented.poolLp};
 else throw new Error(`Unexpected synthetic maintenance GET: ${path}`);
 return Promise.resolve(new Response(JSON.stringify({code:'200',message:'OK',data}),{headers:{'content-type':'application/json'}}));
}
const now=Date.now(), expires=new Date(now+120000).toISOString().replace(/\.\d{3}Z$/u,'Z');
const ordinaryAccount={chainId:'tbc:testnet',address:fixtures[0].address,accountId:`tbc:testnet:${fixtures[0].address}`,
 publicKey:'02f4854f6efa9c17e519c401c20b01ee166054a1fcda490f564504239be8e30e42'};
const summaries=[];
for(const operation of ['add','remove','swap-to-token','swap-to-tbc','merge-token','merge-lp','burn-lp']){
 const maintenance=operation==='merge-token'||operation==='merge-lp'||operation==='burn-lp';
 const fixture=maintenance?fragmented:fixtures[operation==='add'?0:1];
 const account=maintenance?{chainId:'tbc:testnet',address:fixture.address,accountId:`tbc:testnet:${fixture.address}`,publicKey:fixture.publicKey}:ordinaryAccount;
 const common={version:'1.0',poolContractId:fixture.poolContractId,receiver:account.address};
 const specific=maintenance?{version:'1.0',poolContractId:fixture.poolContractId,type:operation==='merge-token'?'tbc.pool.ft.merge':operation==='merge-lp'?'tbc.pool.ftlp.merge':'tbc.pool.ftlp.burn'}
  :operation==='add'?{...common,type:'tbc.pool.liquidity.add',tbcAmount:'1000',minimumLpAmount:'1'}
  :operation==='remove'?{...common,type:'tbc.pool.liquidity.remove',lpAmount:'1000',minimumTbcAmount:'1',minimumFtAmount:'1'}
  :operation==='swap-to-token'?{...common,type:'tbc.pool.swap.exactTbcForToken',tbcAmount:'1000',minimumFtAmount:'1'}
  :{...common,type:'tbc.pool.swap.exactTokenForTbc',ftAmount:'250000',minimumTbcAmount:'1'};
 const unified=maintenance?{...specific,type:operation==='merge-token'?'amm.mergeToken':operation==='merge-lp'?'tbc20Lp.merge':'tbc20Lp.burn'}
  :operation==='add'?{...common,type:'amm.addLiquidity',budgetAsset:'tbc',amount:'1000',minimumLpAmount:'1'}
  :operation==='remove'?{...specific,type:'amm.removeLiquidity'}
  :{...common,type:'amm.swap',direction:operation==='swap-to-token'?'tbc-to-ft':'ft-to-tbc',amount:operation==='swap-to-token'?'1000':'250000',minimumOutput:'1'};
 const results=[],timingFactories=[];
 function setupNetwork(){
  const trace=[], codec=[], base=maintenance?fragmentedFetch:kit.createControlledTestnetFetch({nativeUtxoSatoshis:20000000,
   ...(operation==='add'?{}:{poolOperation:operation})});
  let accountReads=0,clock=now,serial=0;
  const network=kit.createDefaultTbcNetwork({network:kit.createTbcNetworkContext({network:'testnet'}),accounts:{current:async()=>{accountReads++;return[account];}},
   poolNative:{protocolInfo:()=>keyless.protocolInfo(),execute:async(op,json)=>{codec.push(`${op}:${JSON.parse(json).phase}`);return keyless.execute(op,json);}},
   now:()=>clock,snapshotId:()=>`pool-route-${serial++}`,confirmationPolicy:{minConfirmations:'0'},
   fetch:async(input,init)=>{assert.equal(init?.method??'GET','GET','No POST permitted');trace.push(new URL(String(input)).pathname);return base(input,init);}});
  return {network,trace,codec,accountReads:()=>accountReads,expire:()=>{clock+=121000;}};
 }
 for(const intent of [specific,unified]){
  const run=setupNetwork(),{network,trace,codec}=run;
  const request={version:'1.0',chainId:account.chainId,from:account.address,intent,constraints:{maxFee:'100000',expiresAt:expires}};
  const norm=JSON.parse(await engine.call('normalizeRequest',JSON.stringify({version:'1.0',request})));
  assert.equal(norm.ok,true,JSON.stringify(norm.error));
  const normalized=norm.result;
  const params={version:'1.0',accountId:account.accountId,chainId:account.chainId,requirement:kit.chainDataRequirement(normalized.request)};
  const snapshot=await network.resolveChainData(params);
  assert.ok(snapshot.snapshotHash,`${operation}/${intent.type}: ${JSON.stringify(snapshot)}`);
  assert.equal(run.accountReads(),1,'Route must not resolve accounts twice');
  const policyInput={version:'1.0',request:normalized.request,requestHash:normalized.requestHash,snapshotHash:snapshot.snapshotHash};
  const policy=await network.resolvePolicy(policyInput);
  assert.ok(policy.policyHash,`${operation} policy: ${JSON.stringify(policy)}`);
  const plan=JSON.parse(await engine.call('plan',JSON.stringify({version:'1.0',...normalized,snapshot,policy})));
  assert.equal(plan.ok,true,`${operation}/${intent.type}: ${JSON.stringify(plan.error)}`);
  const initialTrace=[...trace];
  assert.equal(trace.filter(p=>p.endsWith(`/poolid/${fixture.poolContractId}`)).length,1);
  assert.equal(trace.filter(p=>p===`/api/tbc/txraw/txid/${fixture.poolContractId}`).length,1,'Origin must not be reread by historical loader');
  assert.equal(trace.some(p=>p.includes('/decode/')),false,'Zero floor must not add decode');
  // Another successful request must not overwrite the first policy. It is
  // snapshot-bound, not a mutable singleton; wrong identity and expiry reject.
  const second=await network.resolveChainData(params);
  assert.ok(second.snapshotHash);assert.notEqual(second.snapshotHash,snapshot.snapshotHash);
  assert.deepEqual(await network.resolvePolicy(policyInput),policy);
  const afterReads=trace.length;
  assert.equal((await network.resolvePolicy({...policyInput,snapshotHash:'00'.repeat(32)})).portError.name,'INVALID_INPUT');
  run.expire();
  assert.ok((await network.resolvePolicy(policyInput)).portError);
  assert.equal(trace.length,afterReads,'Policy verification must never read network');
  if(intent.type.startsWith('amm.')||intent.type.startsWith('tbc20Lp.'))assert.equal(codec.filter(p=>p==='inspectAmmMaterial:identifyPoolOrigin').length,1,'Immutable classification must be reused');
  results.push({trace:initialTrace,warmTrace:trace.slice(initialTrace.length),plan:plan.result.plan.payload,policy:policy.payload});
  timingFactories.push(()=>{const timed=setupNetwork();return {
   reads:()=>timed.trace.length,
   prepare:async()=>{const snapshot=await timed.network.resolveChainData(params);assert.ok(snapshot.snapshotHash);
    const policy=await timed.network.resolvePolicy({...policyInput,snapshotHash:snapshot.snapshotHash});assert.ok(policy.policyHash);
    return {snapshot,policy};},
   plan:async({snapshot,policy})=>JSON.parse(await engine.call('plan',JSON.stringify({version:'1.0',...normalized,snapshot,policy}))),
  };});
 }
 if(benchmark)timings.push({operation,...await measureUnifiedRoute(timingFactories)});
 assert.deepEqual([...results[1].trace].sort(),[...results[0].trace].sort(),`${operation}: unified must use the same GET multiset`);
 assert.deepEqual(results[1].plan.transactions,results[0].plan.transactions);
 assert.deepEqual(results[1].plan.signingTasks,results[0].plan.signingTasks);
 assert.deepEqual(results[1].policy,results[0].policy);
 const readCategories={};
 for(const path of results[1].trace){
  const txid=path.match(/^\/api\/tbc\/txraw\/txid\/([a-f0-9]{64})$/u)?.[1];
  const category=txid===undefined?path.replace(/\/[a-f0-9]{64}(?=\/|$)/gu,'/<id>').replace(/\/address\/.+$/u,'/address/<account>')
   :txid===fixture.poolContractId?'raw:pool-origin':txid===fixture.poolInfo.txid?'raw:pool-current'
   :txid===fixture.poolInfo.ft_contract_id?'raw:ft-origin':txid===fixture.native?.txid?'raw:fee-funding':'raw:ancestor';
  readCategories[category]=(readCategories[category]??0)+1;
 }
 assert.deepEqual([...results[1].warmTrace].sort(),[...results[0].warmTrace].sort(),`${operation}: warm unified route must preserve the original GET multiset`);
 summaries.push({operation,get:results[1].trace.length,warmGet:results[1].warmTrace.length,plansEqual:true,readCategories});
}
const report={result:'UNIFIED_HISTORICAL_POOL_LOADER_PASS',operations:summaries,sourceWasm:!installed,post:0,installed:!!installed,
 ...(benchmark?{timings,engineInstances:1,keylessInstances:1,benchmarkHarnessSha256:sha(readFileSync(new URL('./lib/measure-unified-route.mjs',import.meta.url)))}:{}),
 ...(installed?{candidate:installedVersion,archiveProof,scope:'Installed Kit/Core/Engine/Keyless; synthetic source fixture generator only, preparation and plan equality not signatures or chain.',
  wasmSha256:sha(readFileSync(join(installed,'artifacts/wasm/tbc_engine_wasm.wasm'))),
  keylessSha256:sha(readFileSync(join(installed,'artifacts/wasm/tbc_keyless_wasm.wasm'))),fixtureSha256:sha(JSON.stringify(fragmented)),
  verifierSha256:sha(readFileSync(fileURLToPath(import.meta.url))),realChain:false}: {})};
if(installed){const output=mkdtempSync(join(tmpdir(),`tbc-unified-pool${installedVersion.split('.').at(-1)}-`)),body=JSON.stringify(report,null,2)+'\n';
 writeFileSync(join(output,'report.json'),body,{flag:'wx'});console.log(JSON.stringify({result:report.result,candidate:installedVersion,operations:summaries,timingPairs:timings.length,output,sha256:sha(body)}));
}else console.log(JSON.stringify(report));
