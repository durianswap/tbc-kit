#!/usr/bin/env node
// Synthetic public fixtures in memory. Optional exact225 installed runtime;
// default source mode retained. No real network, custody or broadcasts.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { measureUnifiedRoute } from './lib/measure-unified-route.mjs';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const rust = `${root}packages/tbc-engine/rust/`;
const benchmark=process.argv.includes('--benchmark');
assert.ok(process.argv.length===2||process.argv.length===3||(process.argv.length===4&&benchmark),'Optional EXACT_KIT_CONSUMER [--benchmark]');
const installed=process.argv[2]?join(resolve(process.argv[2]),'node_modules/@tbc/kit'):undefined;
const sha=b=>createHash('sha256').update(b).digest('hex');
let archiveProof,installedVersion;
const timings=[];
// Fail closed if a tested dependency silently reaches global networking.
globalThis.fetch=async()=>{throw Error('External HTTP forbidden in this fixture gate');};
let stage = 'source fixtures';
function cargo(args, env = {}) {
  const r = spawnSync('cargo', args, { cwd: rust, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 120_000, maxBuffer: 32 * 1024 * 1024 });
  if (r.error || r.status !== 0) throw Error('Source Rust gate failed');
  return r.stdout;
}
try {
  if(installed){
    stage='frozen installed identity';
    installedVersion=JSON.parse(readFileSync(join(installed,'package.json'),'utf8')).version;
    const pinned={
      '0.1.0-candidate.225':['candidate225','0505dc865db6604403994121a8da14f014381a25e0bfb63cd1025b6a937c46c4'],
      '0.1.0-candidate.226':['candidate226-complete','1fb39857b8326fdcbf2af2fa43d46a5d3a87d7daad81d8e012d2d69a6d5e53a4'],
    }[installedVersion];assert.ok(pinned,'Only pinned candidates');
    const archive=join(root,'native/engine/delivery',pinned[0],`tbc-kit-${installedVersion}.tgz`);
    const digest=sha(readFileSync(archive));
    assert.equal(digest,pinned[1]);
    const unpacked=mkdtempSync(join(tmpdir(),'tbc-fungible225-identity-'));
    assert.equal(spawnSync('tar',['-xzf',archive,'-C',unpacked],{encoding:'utf8'}).status,0);
    function hashes(base,relative='',result={}){
      for(const entry of readdirSync(join(base,relative),{withFileTypes:true})){
        const p=join(relative,entry.name);
        if(entry.isDirectory())hashes(base,p,result);
        else{assert.ok(entry.isFile());result[p]=sha(readFileSync(join(base,p)));}
      }
      return result;
    }
    const expected=hashes(join(unpacked,'package'));
    assert.deepEqual(hashes(installed),expected);assert.equal(Object.keys(expected).length,922);
    archiveProof={sha256:digest,files:922};
  }
  stage='source public fixtures';
  const output = cargo(['test', '--offline', '--locked', '-p', 'tbc-engine-core', '--test', 'ft', '--test', 'nft_stablecoin',
    '--test', 'tbc20_public', '--test', 'coin_public', '--test', 'tbc721_public', 'unified_', '--', '--test-threads=1', '--nocapture'], { UNIFIED_BUSINESS_DUMP_WIRE: '1' });
  const extract = marker => output.split(/\r?\n/u).filter(line => line.includes(marker)).map(line => JSON.parse(line.slice(line.indexOf(marker) + marker.length)));
  const plans = extract('UNIFIED_BUSINESS_WIRE:').filter(r => r.method === 'plan' &&
    !['tbc.nft.transfer','tbc721-standard-transfer','tbc721.transfer'].includes(r.input.request.intent.type));
  const origins = extract('UNIFIED_ORIGIN_WIRE:');
  const nftPlans=extract('UNIFIED_BUSINESS_WIRE:').filter(r=>r.method==='plan' &&
    ['tbc.nft.transfer','tbc721-standard-transfer','tbc721.transfer'].includes(r.input.request.intent.type));
  const nftOrigins=extract('UNIFIED_NFT_ORIGIN_WIRE:');
  assert.equal(plans.length, 16); assert.equal(origins.length, 8);
  assert.equal(nftPlans.length,10);assert.equal(nftOrigins.length,5);
  let kit;
  if(installed){
    const wallet=await import(pathToFileURL(join(installed,'dist/esm/wallet.js')));
    const engineModule=await import(pathToFileURL(join(installed,'dist/esm/engine.js')));
    const api=await import(pathToFileURL(join(installed,'dist/esm/api.js')));
    kit={...wallet,createWasmTbcEngineBackend:engineModule.createWasmTbcEngineBackend,inspectTbcTransaction:api.inspectTbcTransaction};
  }else{
  stage = 'source WASM build';
  cargo(['build', '--offline', '--locked', '--release', '-p', 'tbc-keyless-wasm', '-p', 'tbc-engine-wasm', '--target', 'wasm32-unknown-unknown'],
    { RUSTFLAGS: '--cfg getrandom_backend="unsupported"' });
  const bundled = await build({ stdin: { contents: `
    export { createDefaultTbcChainDataResolver } from './packages/kit/src/default-chain-data.ts';
    export { createDefaultTbcNetwork } from './packages/kit/src/default-network.ts';
    export { createWasmTbcKeylessEngine } from './packages/kit/src/keyless.ts';
    export { createWasmTbcEngineBackend } from './packages/tbc-engine/src/wasm.ts';
    export { identifyTbcFungibleContracts } from './packages/kit/src/contract-identification.ts';
    export { inspectTbcTransaction } from './packages/kit/src/testnet-validation.ts';
    export { createTbcNetworkContext } from './packages/kit/src/network-context.ts';
    export { chainDataRequirement, hashCanonical } from './packages/core/src/index.ts';
  `, resolveDir: root, loader: 'ts' }, alias: { '@tbc-wallet/core': `${root}packages/core/src/index.ts` },
    bundle: true, write: false, platform: 'node', format: 'esm', target: 'es2022', logLevel: 'silent' });
  const url = new URL('./.unified-loader-source.mjs', import.meta.url).href;
  const hooks = registerHooks({ resolve(s,c,next) { return s === url ? { url, shortCircuit:true } : next(s,c); },
    load(u,c,next) { return u === url ? { source:bundled.outputFiles[0].text,format:'module',shortCircuit:true } : next(u,c); } });
  kit = await import(url); hooks.deregister();
  }
  const wasmRoot=installed?join(installed,'artifacts/wasm'):`${rust}target/wasm32-unknown-unknown/release`;
  const keylessBytes=readFileSync(join(wasmRoot,'tbc_keyless_wasm.wasm'));
  const engineBytes=readFileSync(join(wasmRoot,'tbc_engine_wasm.wasm'));
  const keyless = await kit.createWasmTbcKeylessEngine(keylessBytes);
  const engine = await kit.createWasmTbcEngineBackend(engineBytes);
  stage = 'origin Native/WASM parity';
  for (const r of origins) assert.deepEqual(JSON.parse(await keyless.execute('inspectTokenMaterial', JSON.stringify(r.input))), r.result);
  for (const r of nftOrigins) assert.deepEqual(JSON.parse(await keyless.execute('inspectTokenMaterial', JSON.stringify(r.input))), r.result);
  let rejectedBindings=0,originMismatchRejected=0;
  stage='installed authenticated-material negative boundaries';
  for(const rows of [plans,nftPlans])for(let i=1;i<rows.length;i+=2){
    for(const mutation of ['duplicate','label','parent','family']){
      const bad=structuredClone(rows[i].input),records=bad.snapshot.payload.contracts;
      if(mutation==='duplicate')records.push(structuredClone(records[0]));
      else if(mutation==='label')records[0].protocolVersion='fictional-version';
      else if(mutation==='parent')records[0].currentOutpoint.txid='00'.repeat(32);
      else records[0].family=bad.request.intent.type==='tbc721.transfer'?'ft':'nft';
      bad.snapshot.snapshotHash=kit.hashCanonical(bad.snapshot.payload);
      const result=JSON.parse(await engine.call('plan',JSON.stringify(bad)));
      assert.equal(result.ok,false,`Conflicting ${mutation} must not select an alternate builder`);
      rejectedBindings++;
    }
  }
  for(const row of [...origins,...nftOrigins]){
    await assert.rejects(keyless.execute('inspectTokenMaterial',JSON.stringify({...row.input,contractId:'00'.repeat(32)})));
    originMismatchRejected++;
  }
  const summaries = [];
  for (let pair = 0; pair < plans.length; pair += 2) {
    const concrete = structuredClone(plans[pair].input), unified = structuredClone(plans[pair+1].input);
    stage = `fixture ${pair/2} preparation`;
    const snapshot = concrete.snapshot.payload, raws = new Map(snapshot.parents.map(p => [p.txid, p.rawTransaction]));
    const account = snapshot.account, chainId = account.chainId;
    const read = id => {
      const raw = raws.get(id);
      if (!raw) console.error(JSON.stringify({diagnostic:'missing synthetic parent',fixture:pair/2,txid:id}));
      assert.ok(raw, 'Fixture is missing a required parent');
      const { txid, transaction } = kit.inspectTbcTransaction(raw);
      assert.equal(txid, id);
      return { txid, rawTransaction: raw, confirmations: '100',
        inputs: transaction.inputs.map(p => ({ txid: p.txid, vout: p.vout })),
        outputs: transaction.outputs.map((o,vout) => ({ vout, satoshis: o.satoshis.toString(), scriptPubKey: Buffer.from(o.scriptPubKey).toString('hex') })) };
    };
    const tokens = snapshot.utxos.filter(u => ['ft','stablecoin'].includes(u.classification));
    const identities = await kit.identifyTbcFungibleContracts(tokens.map(u => {
      const p = read(u.txid), code = p.outputs[u.vout], tape = p.outputs[u.vout+1];
      return { codeScript: code.scriptPubKey, codeSatoshis: Number(code.satoshis), tapeScript: tape.scriptPubKey, tapeSatoshis: Number(tape.satoshis) };
    }), { engine: keyless });
    const height = String(Math.max(1, Number(snapshot.block.height)-1));
    const nativeUtxos = snapshot.utxos.filter(u => u.classification === 'native').map(u => ({ ...u, height }));
    const assetUtxos = tokens.map((u,i) => ({ txid:u.txid, vout:u.vout, satoshis:u.satoshis, ftAmount:identities[i].balanceRaw, height }));
    // Engine's six-input fixture deliberately needs more than the existing
    // historical default loader's five-asset selection window. Keep that
    // Engine continuation proof in the separate wire gate. Here exercise its
    // largest supported five-asset transfer without changing selection policy.
    if (concrete.request.intent.type === 'tbc.ft.transfer') {
      const selectedTotal = assetUtxos.map(u=>BigInt(u.ftAmount)).sort((a,b)=>a>b?-1:a<b?1:0).slice(0,5).reduce((a,b)=>a+b,0n);
      if (BigInt(concrete.request.intent.amount) > selectedTotal) {
        for (const input of [concrete,unified]) {
          input.request.intent.amount=selectedTotal.toString();
          const normalized=JSON.parse(await engine.call('normalizeRequest',JSON.stringify({version:'1.0',request:input.request})));
          assert.equal(normalized.ok,true);input.request=normalized.result.request;input.requestHash=normalized.result.requestHash;
        }
      }
    }
    function setup() {
      const calls=[], codecs=[]; let accounts=0;
      const trace = (name, id='') => calls.push(`${name}:${id}`);
      const client = {
        async getUtxos() { trace('native'); return { tip:snapshot.block, utxos:nativeUtxos }; },
        async getFtUtxos() { trace('ft'); return assetUtxos; },
        async getStablecoinUtxos() { trace('coin'); return assetUtxos; },
        async getStablecoinInfo() { trace('coin-info'); return { contractId:concrete.request.intent.contractId, stateVout:0, stateTxid:snapshot.contracts[0].creationTxid }; },
        async getRawTransactionBytes(id) { trace('raw', id); return read(id).rawTransaction; },
        async getRawTransaction(id) { trace('decoded', id); return read(id); },
      };
      const resolver = kit.createDefaultTbcChainDataResolver({ client, accounts:{current:async()=>{accounts++;return [account];}},
        network:kit.createTbcNetworkContext({network:chainId==='tbc:mainnet'?'mainnet':'testnet'}),
        materialNative:{protocolInfo:keyless.protocolInfo,execute:async(op,input)=>{codecs.push(op);return keyless.execute(op,input);}},
        confirmationPolicy:{minConfirmations:'0'}, now:()=>Date.parse(snapshot.capturedAt), snapshotId:()=> 'unified-loader-test' });
      return { resolver, calls, codecs, accounts:()=>accounts };
    }
    const normal=setup(), generic=setup();
    const params = request => ({version:'1.0',chainId,accountId:account.accountId,requirement:kit.chainDataRequirement(request)});
    stage = `fixture ${pair/2} concrete loader`;
    const before = await normal.resolver.resolve(params(concrete.request));
    if (!before.snapshotHash) console.error(JSON.stringify({fixture:pair/2,tip:snapshot.block.height,selectedNative:nativeUtxos.length,selectedAssets:assetUtxos.length,readKinds:normal.calls.map(c=>c.split(':')[0]),code:before.portError?.name}));
    assert.ok(before.snapshotHash, `Concrete loader rejected fixture: ${before.portError?.name}`);
    stage = `fixture ${pair/2} unified loader`;
    const after = await generic.resolver.resolve(params(unified.request));
    assert.ok(after.snapshotHash, `Unified loader rejected fixture: ${after.portError?.name}`);
    assert.deepEqual(after, before, 'Unified read routing must preserve the concrete snapshot');
    assert.deepEqual([...generic.calls].sort(), [...normal.calls].sort(), 'Cold read count/set changed');
    assert.equal(generic.accounts(), 1); assert.equal(generic.codecs.length, 1);
    assert.deepEqual(generic.calls.slice(0,2).sort(),normal.calls.slice(0,2).sort(), 'Indexes must launch together');
    const oldCount=generic.calls.length;
    const warm=await generic.resolver.resolve(params(unified.request));
    assert.deepEqual(warm,after); assert.equal(generic.codecs.length,1,'Reuse byte-bound origin hint');
    const warmReads=generic.calls.slice(oldCount);
    assert.ok(!warmReads.some(c=>c.startsWith('raw:')), 'Warm immutable parents must be reused');
    stage = `fixture ${pair/2} workflow read reuse`;
    const batch=setup();
    const batchResult=await batch.resolver.resolve({...params(unified.request),workflowSteps:[
      {stepId:'first',requirement:kit.chainDataRequirement(unified.request)},
      {stepId:'second',requirement:kit.chainDataRequirement(unified.request)},
    ]});
    assert.equal(batchResult.steps?.length,2,`Unified workflow preparation failed: ${batchResult.portError?.name}`);
    for(const step of batchResult.steps) assert.deepEqual(step.snapshot,after);
    assert.deepEqual([...batch.calls].sort(),[...normal.calls].sort(),'Same-asset workflow must share its read set');
    assert.equal(batch.accounts(),1,'Workflow must reuse its bound account');
    assert.equal(batch.codecs.length,1,'Concurrent workflow steps must share origin identification');
    stage = `fixture ${pair/2} Engine plan`;
    const plan = async (input, bound) => JSON.parse(await engine.call('plan',JSON.stringify({...input,snapshot:bound})));
    const a=await plan(concrete,before), b=await plan(unified,after);
    assert.equal(a.ok,true, `Concrete loaded plan failed: ${a.error?.code}`);
    assert.equal(b.ok,true, `Unified loaded plan failed: ${b.error?.code}`);
    assert.deepEqual(a.result.plan.payload.transactions,b.result.plan.payload.transactions);
    assert.deepEqual(a.result.plan.payload.signingTasks,b.result.plan.payload.signingTasks);
    assert.equal(b.result.plan.payload.requestHash,unified.requestHash);
    assert.deepEqual(b.result.plan.payload.preview.contractExecution,{businessType:unified.request.intent.type,
      implementation:concrete.request.intent.type,generation:concrete.request.intent.type.startsWith('tbc.')?'historical':'current'});
    stage = `fixture ${pair/2} default network and policy`;
    function configuredNetwork() {
      const trace=[]; let clock=Date.parse(snapshot.capturedAt);
      const network=kit.createDefaultTbcNetwork({network:kit.createTbcNetworkContext({network:chainId==='tbc:mainnet'?'mainnet':'testnet'}),
        accounts:{current:async()=>[account]},poolNative:keyless,now:()=>clock,snapshotId:()=> 'unified-network-test',
        poolMaterial:{resolveLiquidityAdd:async()=>{throw Error('Unrelated Pool call');}},
        fetch:async(input,init)=>{
          assert.equal(init?.method??'GET','GET');
          const path=new URL(String(input)).pathname;trace.push(path);let data;
          if(path==='/api/tbc/nodeinfo') data={blocks:snapshot.block.height,bestblockhash:snapshot.block.hash};
          else if(path.startsWith('/api/tbc/utxo/address/')) data={utxos:nativeUtxos.map(u=>({txid:u.txid,index:u.vout,value:u.satoshis,height:u.height}))};
          else if(path.includes('/utxo/combinescript/')) data={utxos:assetUtxos.map(u=>({txid:u.txid,index:u.vout,tbc_value:u.satoshis,ft_value:u.ftAmount,height:u.height}))};
          else if(path.startsWith('/api/tbc/txraw/txid/')) data={txraw:read(path.split('/').at(-1)).rawTransaction};
          else if(path.startsWith('/api/tbc/stablecoin/info/')) data={stablecoin_id:concrete.request.intent.contractId,utxo:{txid:snapshot.contracts[0].creationTxid,vout:0}};
          else { console.error(JSON.stringify({unexpectedFixtureEndpoint:path}));throw Error('Unexpected fixture endpoint'); }
          return new Response(JSON.stringify({code:'200',data}),{status:200});
        }});
      return {network,trace,expire:()=>{clock+=120_001;}};
    }
    const normalNetwork=configuredNetwork(), unifiedNetwork=configuredNetwork();
    const normalSnapshot=await normalNetwork.network.resolveChainData(params(concrete.request));
    const unifiedSnapshot=await unifiedNetwork.network.resolveChainData(params(unified.request));
    assert.ok(normalSnapshot.snapshotHash, 'Concrete full-network material failed');
    assert.deepEqual(unifiedSnapshot,normalSnapshot);
    assert.deepEqual([...unifiedNetwork.trace].sort(),[...normalNetwork.trace].sort(),'Full API read set differs');
    const policyParams=(input,snapshotHash)=>({version:'1.0',request:input.request,requestHash:input.requestHash,snapshotHash});
    const httpBefore=unifiedNetwork.trace.length;
    const normalPolicy=await normalNetwork.network.resolvePolicy(policyParams(concrete,normalSnapshot.snapshotHash));
    const unifiedPolicy=await unifiedNetwork.network.resolvePolicy(policyParams(unified,unifiedSnapshot.snapshotHash));
    assert.ok(normalPolicy.policyHash,'Concrete default policy failed');
    assert.deepEqual(unifiedPolicy,normalPolicy,'Dust, fees and template policy must stay identical');
    assert.equal(unifiedNetwork.trace.length,httpBefore,'Policy must not query version or origin again');
    for(const change of [
      {chainId:chainId==='tbc:mainnet'?'tbc:testnet':'tbc:mainnet'},
      {from:unified.request.intent.to??'1BoatSLRHtKNngkdXEeobR76b53LETtpyT'},
      {intent:{...unified.request.intent,contractId:'11'.repeat(32)}},
    ]) {
      const request={...unified.request,...change};
      if(request.from===unified.request.from && 'from' in change) continue;
      assert.ok((await unifiedNetwork.network.resolvePolicy({version:'1.0',request,requestHash:kit.hashCanonical(request),snapshotHash:unifiedSnapshot.snapshotHash})).portError,
        'Other network/account/asset must not consume the cached policy');
    }
    const fullPlan=async(input,snapshot,policy)=>JSON.parse(await engine.call('plan',JSON.stringify({...input,snapshot,policy})));
    const fullA=await fullPlan(concrete,normalSnapshot,normalPolicy),fullB=await fullPlan(unified,unifiedSnapshot,unifiedPolicy);
    assert.equal(fullA.ok,true,`Concrete default policy plan: ${fullA.error?.code}`);
    assert.equal(fullB.ok,true,`Unified default policy plan: ${fullB.error?.code}`);
    assert.deepEqual(fullB.result.plan.payload.transactions,fullA.result.plan.payload.transactions);
    assert.deepEqual(fullB.result.plan.payload.signingTasks,fullA.result.plan.payload.signingTasks);
    assert.ok((await unifiedNetwork.network.resolvePolicy(policyParams(unified,'00'.repeat(32)))).portError,'Unknown snapshot may not select policy');
    unifiedNetwork.expire();
    assert.ok((await unifiedNetwork.network.resolvePolicy(policyParams(unified,unifiedSnapshot.snapshotHash))).portError,'Expired snapshot may not select policy');
    assert.equal(unifiedNetwork.trace.length,httpBefore);
    if(benchmark) timings.push({fixture:`fungible-${pair/2}`,concreteIntent:concrete.request.intent.type,unifiedIntent:unified.request.intent.type,
      ...await measureUnifiedRoute([concrete,unified].map(input=>()=>{
        const run=configuredNetwork();return {reads:()=>run.trace.length,
          prepare:async()=>{const snapshot=await run.network.resolveChainData(params(input.request));
            assert.ok(snapshot.snapshotHash);const policy=await run.network.resolvePolicy(policyParams(input,snapshot.snapshotHash));
            assert.ok(policy.policyHash);return {snapshot,policy};},
          plan:({snapshot,policy})=>fullPlan(input,snapshot,policy)};
      }))});
    summaries.push({intent:unified.request.intent.type,concrete:concrete.request.intent.type,coldReads:normal.calls.length,warmReads:warmReads.length,
      codecCalls:generic.codecs.length,apiRequests:httpBefore,policyEqual:true});
  }
  const nftSummaries=[];
  for(let pair=0;pair<nftPlans.length;pair+=2){
    stage=`NFT fixture ${pair/2} loader/policy/plan`;
    const concrete=nftPlans[pair].input,unified=nftPlans[pair+1].input;
    const snapshot=concrete.snapshot.payload,account=snapshot.account,chainId=account.chainId;
    const raws=new Map(snapshot.parents.map(p=>[p.txid,p.rawTransaction]));
    const record=snapshot.contracts.find(r=>r.contractId===concrete.request.intent.contractId);
    const current=record.currentOutpoint.txid;
    const parse=id=>{assert.ok(raws.has(id),'NFT fixture parent missing');return kit.inspectTbcTransaction(raws.get(id)).transaction;};
    const native=snapshot.utxos.filter(u=>u.classification==='native');
    const height=String(Math.max(1,Number(snapshot.block.height)-1));
    function setupNft(){
      const trace=[];let codecs=0;
      const network=kit.createDefaultTbcNetwork({network:kit.createTbcNetworkContext({network:chainId==='tbc:mainnet'?'mainnet':'testnet'}),
        accounts:{current:async()=>[account]},now:()=>Date.parse(snapshot.capturedAt),snapshotId:()=> 'nft-route-test',
        poolNative:{protocolInfo:keyless.protocolInfo,execute:(op,input)=>{codecs++;return keyless.execute(op,input);}},
        poolMaterial:{resolveLiquidityAdd:async()=>{throw Error('Unrelated pool call');}},
        fetch:async(input,init)=>{
          const path=new URL(String(input)).pathname,method=init?.method??'GET';trace.push(`${method}:${path}`);let data;
          assert.ok(method==='GET'||method==='POST'&&path==='/api/tbc/txo/status','Unexpected NFT POST');
          if(path==='/api/tbc/nodeinfo') data={blocks:snapshot.block.height,bestblockhash:snapshot.block.hash};
          else if(path.startsWith('/api/tbc/utxo/address/')) data={utxos:native.map(u=>({txid:u.txid,index:u.vout,value:u.satoshis,height}))};
          else if(path.startsWith('/api/tbc/nft/utxo/scriptpubkeyhash/')) data={utxos:[{txid:current,index:0,nft_id:record.contractId,value:'200',height}]};
          else if(path.startsWith('/api/tbc/txraw/txid/')){const id=path.split('/').at(-1);parse(id);data={txraw:raws.get(id)};}
          else if(path==='/api/tbc/txo/status') data={txos:JSON.parse(init.body).txos.map(p=>({txid:p.txid,index:String(p.index),value:parse(p.txid).outputs[p.index].satoshis.toString(),spent:false,height}))};
          else throw Error('Unexpected NFT endpoint');
          return new Response(JSON.stringify({code:'200',data}),{status:200});
        }});
      return {network,trace,codecs:()=>codecs};
    }
    const a=setupNft(),b=setupNft();
    const params=request=>({version:'1.0',chainId,accountId:account.accountId,requirement:kit.chainDataRequirement(request)});
    const sa=await a.network.resolveChainData(params(concrete.request)),sb=await b.network.resolveChainData(params(unified.request));
    assert.ok(sa.snapshotHash,`Concrete NFT material ${sa.portError?.name}`);assert.deepEqual(sb,sa);
    assert.deepEqual([...b.trace].sort(),[...a.trace].sort(),'NFT route added reads');assert.equal(b.codecs(),1);
    const policy=async(run,input,s)=>run.network.resolvePolicy({version:'1.0',request:input.request,requestHash:input.requestHash,snapshotHash:s.snapshotHash});
    const pa=await policy(a,concrete,sa),pb=await policy(b,unified,sb);assert.ok(pa.policyHash);assert.deepEqual(pb,pa);
    const plan=async(input,snapshot,policy)=>JSON.parse(await engine.call('plan',JSON.stringify({...input,snapshot,policy})));
    const before=await plan(concrete,sa,pa),after=await plan(unified,sb,pb);
    assert.equal(before.ok,true,`NFT concrete plan ${before.error?.code}`);assert.equal(after.ok,true,`NFT unified plan ${after.error?.code}`);
    assert.deepEqual(after.result.plan.payload.transactions,before.result.plan.payload.transactions);
    assert.deepEqual(after.result.plan.payload.signingTasks,before.result.plan.payload.signingTasks);
    assert.deepEqual(after.result.plan.payload.preview.contractExecution,{businessType:unified.request.intent.type,
      implementation:concrete.request.intent.type,generation:concrete.request.intent.type.startsWith('tbc.')?'historical':'current'});
    const reads=b.trace.length;
    assert.deepEqual(await b.network.resolveChainData(params(unified.request)),sb);assert.equal(b.codecs(),1);
    assert.ok(b.trace.slice(reads).every(path=>!path.includes('/txraw/')),'NFT cache lost immutable material');
    const batch=setupNft(),r=params(unified.request);
    const both=await batch.network.resolveChainData({...r,workflowSteps:[{stepId:'a',requirement:r.requirement},{stepId:'b',requirement:r.requirement}]});
    assert.equal(both.steps?.length,2);assert.deepEqual([...batch.trace].sort(),[...a.trace].sort(),'NFT workflow duplicate reads');
    assert.equal(batch.codecs(),1);
    if(benchmark) timings.push({fixture:`nft-${pair/2}`,concreteIntent:concrete.request.intent.type,unifiedIntent:unified.request.intent.type,
      ...await measureUnifiedRoute([concrete,unified].map(input=>()=>{
        const run=setupNft();return {reads:()=>run.trace.length,
          prepare:async()=>{const snapshot=await run.network.resolveChainData(params(input.request));
            assert.ok(snapshot.snapshotHash);const boundPolicy=await policy(run,input,snapshot);
            assert.ok(boundPolicy.policyHash);return {snapshot,policy:boundPolicy};},
          plan:({snapshot,policy})=>plan(input,snapshot,policy)};
      }))});
    nftSummaries.push({concrete:concrete.request.intent.type,apiRequests:reads,warmReads:b.trace.length-reads,codecCalls:1,policyEqual:true});
  }
  const report={result:installed?'UNIFIED_FUNGIBLE_LOADER_INSTALLED_PASS':'UNIFIED_FUNGIBLE_LOADER_SOURCE_PASS',operationPairs:summaries.length,originNativeWasm:origins.length,summaries,
    nftOperationPairs:nftSummaries.length,nftOriginNativeWasm:nftOrigins.length,nftSummaries,rejectedBindings,originMismatchRejected,
    http:0,broadcast:0,deliveryArtifactsChanged:false,
    ...(benchmark?{timings,engineInstances:1,keylessInstances:1,benchmarkHarnessSha256:sha(readFileSync(new URL('./lib/measure-unified-route.mjs',import.meta.url)))}:{}),
    ...(installed?{candidate:installedVersion,archiveProof,wasmSha256:sha(engineBytes),keylessSha256:sha(keylessBytes),
      fixtureSha256:sha(JSON.stringify({plans,origins,nftPlans,nftOrigins})),verifierSha256:sha(readFileSync(fileURLToPath(import.meta.url))),
      scope:'Installed Kit/Core/Engine/Keyless preparation and plan equality; public source fixtures and native origin oracle only. No approval, Signer, independent VM or chain acceptance.'}: {})};
  if(installed){
    const output=mkdtempSync(join(tmpdir(),`tbc-unified-fungible${installedVersion.split('.').at(-1)}-`)),body=JSON.stringify(report,null,2)+'\n';
    writeFileSync(join(output,'report.json'),body,{flag:'wx'});console.log(JSON.stringify({result:report.result,candidate:installedVersion,operationPairs:summaries.length,nftOperationPairs:nftSummaries.length,timingPairs:timings.length,output,sha256:sha(body)}));
  }else console.log(JSON.stringify(report));
} catch(error) {
  console.error(`Unified loader source gate failed at ${stage}; fixture material withheld.`);
  if(error instanceof assert.AssertionError) console.error(error.message.split('\n')[0]);
  process.exitCode=1;
}
