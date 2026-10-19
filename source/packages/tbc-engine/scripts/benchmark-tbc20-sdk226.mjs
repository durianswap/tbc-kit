#!/usr/bin/env node
// Offline fixed-SDK vs exact installed226. Public scalar1/fabricated inputs
// only. Never imports wallet custody, broadcasts, or writes signed raw data.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync, execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import { join, resolve, relative, dirname, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';

const root=fileURLToPath(new URL('../../../',import.meta.url));
assert.equal(process.argv.length,4,'Usage: benchmark-tbc20-sdk226.mjs FIXED_UPSTREAM EXACT226_CONSUMER');
const upstream=resolve(process.argv[2]), installed=join(resolve(process.argv[3]),'node_modules/@tbc/kit');
const commit='af77616121db340e15bb8b73c197bc2f8d1ee986';
const sha=b=>createHash('sha256').update(b).digest('hex');
const json=p=>JSON.parse(readFileSync(p,'utf8'));
let stage='identity';
globalThis.fetch=async()=>{throw Error('Real HTTP is forbidden in this offline benchmark');};
function tree(base,dir='',out={}) {
  for(const entry of readdirSync(join(base,dir),{withFileTypes:true})) {
    if(entry.name==='node_modules'||entry.name==='.git')continue;
    const p=join(dir,entry.name);
    if(entry.isDirectory())tree(base,p,out);
    else {assert.ok(entry.isFile());out[p]=sha(readFileSync(join(base,p)));}
  }
  return out;
}
try {
  assert.equal(execFileSync('git',['-C',upstream,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),commit);
  const sourceHashes={
    'package.json':'03622bd9640146bef3def2534890600d995f629d33580ec4433b725388ccb00f',
    'lib/contract/tbc20.ts':'402b1cf1de1a284c902daf78e20e66bc36f66a2bb87180052c47328032468c2a',
    'lib/util/tbc20/tbc20unlock.ts':'0798c21eae4c76f2657a30428205fed783e2975ae28ccf3c938230090a6e404b',
  };
  for(const [p,h]of Object.entries(sourceHashes))assert.equal(sha(readFileSync(join(upstream,p))),h,p);
  assert.equal(json(join(installed,'package.json')).version,'0.1.0-candidate.226');
  const archive=join(root,'native/engine/delivery/candidate226-complete/tbc-kit-0.1.0-candidate.226.tgz');
  const archiveSha=sha(readFileSync(archive));
  assert.equal(archiveSha,'1fb39857b8326fdcbf2af2fa43d46a5d3a87d7daad81d8e012d2d69a6d5e53a4');
  const temp=mkdtempSync(join(tmpdir(),'tbc-sdk226-benchmark-'));
  execFileSync('tar',['-xzf',archive,'-C',temp]);
  const packageFiles=tree(join(temp,'package'));
  assert.equal(Object.keys(packageFiles).length,922);assert.deepEqual(tree(installed),packageFiles);
  const deps=createRequire(join(root,'packages/kit/package.json'));
  const libRoot=dirname(deps.resolve('tbc-lib-js/package.json'));
  const libFiles=tree(libRoot);
  const libSha=sha(Object.keys(libFiles).sort().map(p=>`${p.split(sep).join('/')}\0${libFiles[p]}\n`).join(''));
  assert.equal(libSha,'b73c8b5996276584981fe5b14f04db3e4cce02c94e7a19cb2b0f64e37206c7e9');
  const ts=deps('typescript');assert.equal(ts.version,'5.9.2');
  const prefix=pathToFileURL(`${upstream}${sep}`).href,consumed=new Set();
  const hooks=registerHooks({
    resolve(s,c,next){return s==='tbc-lib-js'||s.startsWith('tbc-lib-js/')?{url:pathToFileURL(deps.resolve(s)).href,shortCircuit:true}:next(s,c);},
    load(u,c,next){
      if(!u.startsWith(prefix)||!u.endsWith('.js'))return next(u,c);
      const file=fileURLToPath(u).replace(/\.js$/u,'.ts'),p=relative(upstream,file).split(sep).join('/');
      assert.ok(existsSync(file)&&Object.hasOwn(sourceHashes,p),'Unpinned executable dependency');
      const source=readFileSync(file,'utf8');assert.equal(sha(source),sourceHashes[p]);consumed.add(p);
      return {format:'commonjs',source:ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,shortCircuit:true};
    },
  });
  const {TBC20}=createRequire(join(upstream,'package.json'))('./lib/contract/tbc20.js');
  hooks.deregister();
  assert.deepEqual([...consumed].sort(),['lib/contract/tbc20.ts','lib/util/tbc20/tbc20unlock.ts']);
  const tbc=deps('tbc-lib-js');
  const key=new tbc.PrivateKey(new tbc.crypto.BN(1));
  const publicKey=key.toPublicKey().toString(),owner=key.toAddress().toString();
  assert.equal(publicKey,'0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798');
  const token=new TBC20();
  const {createWasmTbcEngineBackend}=await import(pathToFileURL(join(installed,'dist/esm/engine.js')));
  const {hashCanonical}=await import(pathToFileURL(join(installed,'dist/esm/wallet.js')));
  const wasm=readFileSync(join(installed,'artifacts/wasm/tbc_engine_wasm.wasm'));
  const wasmSha=sha(wasm);assert.equal(wasmSha,'141c862a9a8aebf83be43dde3b8ad81162a89fb9e7640008cf230ff2d3f4bda7');
  const initAt=performance.now(),engine=await createWasmTbcEngineBackend(wasm),engineInitMs=performance.now()-initAt;
  function call(method,input){
    const value=JSON.parse(engine.call(method,JSON.stringify(input)));
    assert.equal(value.ok,true,`${method} failed`);
    if(method==='validate')assert.equal(value.result.valid,true,`validation ${input.phase} failed`);
    return value.result;
  }
  stage='public Native fixture capture';
  const cargo=spawnSync('cargo',['test','--offline','--locked','-p','tbc-engine-core','--test','tbc20_public',
    'unified_current_ft_signing_matches_concrete','--','--test-threads=1','--nocapture'],
    {cwd:join(root,'packages/tbc-engine/rust'),env:{...process.env,UNIFIED_BUSINESS_DUMP_WIRE:'1'},encoding:'utf8',timeout:120000,maxBuffer:32*1024*1024});
  assert.equal(cargo.status,0,'Public native fixture gate failed; raw stdout intentionally withheld');
  const marker='UNIFIED_BUSINESS_WIRE:';
  const wires=cargo.stdout.split(/\r?\n/u).filter(l=>l.includes(marker)).map(l=>JSON.parse(l.slice(l.indexOf(marker)+marker.length)));
  const plans=wires.filter(r=>r.method==='plan'&&['tbc20.transfer','tbc20.merge'].includes(r.input.request.intent.type));
  assert.equal(plans.length,2);
  stage='Native/installed-WASM fixture parity';
  for(const r of wires){
    const result=JSON.parse(engine.call(r.method,JSON.stringify(r.input)));
    assert.deepEqual(result,r.result,`Installed parity: ${r.method}`);
  }
  const base=json(join(root,'packages/tbc-engine/rust/fixtures/tbc-transfer.json'));
  function sign(tasks){return tasks.map(task=>{
    assert.equal(task.publicKey,publicKey);assert.equal(task.signatureEncoding,'compact64');
    const sig=tbc.crypto.ECDSA.sign(Buffer.from(task.digest,'hex'),key,'big');
    return {taskId:task.taskId,signatureEncoding:'compact64',signature:Buffer.concat([
      sig.r.toBuffer({size:32}),sig.s.toBuffer({size:32})]).toString('hex')};
  });}
  function runEngine(material){
    const times={},start=performance.now();
    const input=structuredClone(material);
    function timed(name,fn){const at=performance.now(),r=fn();times[name]=(times[name]??0)+performance.now()-at;return r;}
    const normalized=timed('normalizeMs',()=>call('normalizeRequest',{version:'1.0',request:input.request}));
    input.request=normalized.request;input.requestHash=normalized.requestHash;
    const planned=timed('planMs',()=>call('plan',input));
    const params=timed('approvalBindingMs',()=>{
      const binding=structuredClone(base.finalizeInput.binding);
      Object.assign(binding.payload,{requestHash:input.requestHash,operationHash:planned.plan.planHash,expiresAt:planned.plan.payload.expiresAt});
      binding.bindingHash=hashCanonical(binding.payload);
      const approval={...base.finalizeInput.approval,bindingHash:binding.bindingHash,expiresAt:binding.payload.expiresAt};
      return {...input,plan:planned.plan,binding,approval};
    });
    timed('validatePlanMs',()=>call('validate',{...input,plan:planned.plan,phase:'plan'}));
    timed('validatePreSignMs',()=>call('validate',{...params,phase:'pre-sign'}));
    let tasks=planned.plan.payload.signingTasks,result,rounds=0,signatureCount=0;
    do {
      assert.ok(rounds<8,'Bounded signing rounds');rounds++;signatureCount+=tasks.length;
      params.signatures=timed('externalSignMs',()=>sign(tasks));
      result=timed('finalizeMs',()=>call('finalize',params));
      if(!result.bundle){params.continuation=result.continuation;tasks=result.signingRequests;}
    }while(!result.bundle);
    timed('validateFinalizedMs',()=>call('validate',{...params,bundle:result.bundle,phase:'finalized'}));
    timed('validatePreBroadcastMs',()=>call('validate',{...params,bundle:result.bundle,phase:'pre-broadcast'}));
    times.totalMs=performance.now()-start;
    return {times,bundle:result.bundle,rounds,signatureCount};
  }
  function runSdk(material){
    const at=performance.now(),snapshot=material.snapshot.payload;
    const parents=new Map(snapshot.parents.map(p=>[p.txid,new tbc.Transaction(p.rawTransaction)]));
    const native=snapshot.utxos.filter(u=>u.classification==='native');
    const utxo=u=>({txId:u.txid,outputIndex:u.vout,satoshis:Number(u.satoshis),script:u.scriptPubKey});
    const inputs=snapshot.utxos.filter(u=>u.classification==='ft').map(u=>({utxo:utxo(u),parentTx:parents.get(u.txid),ancestors:parents,signingKey:key}));
    const shared={inputs,feeInputs:native.map(u=>({utxo:utxo(u),privateKey:key})),tbcChangeAddress:owner};
    const inputDecodeMs=performance.now()-at;
    const begin=performance.now();
    const built=material.request.intent.type==='tbc20.transfer'
      ?token.transfer({...shared,receivers:[{controller:owner,amount:BigInt(material.request.intent.amount)}],tokenChangeController:owner})
      :token.merge({...shared,controller:owner});
    return {tx:built.transaction,fee:built.feeSatoshis,times:{inputDecodeMs,buildAndSignMs:performance.now()-begin,totalMs:performance.now()-at}};
  }
  function compare(material,a,b){
    assert.equal(a.bundle.transactions.length,1);
    const raw=a.bundle.transactions[0].rawTransaction;
    assert.equal(typeof raw,'string');
    const left=new tbc.Transaction(raw),right=b.tx;
    const inputs=tx=>tx.inputs.map(i=>({txid:i.prevTxId.toString('hex'),vout:i.outputIndex}));
    assert.deepEqual(inputs(left),inputs(right),'Both must spend the same ordered inputs');
    const outputs=tx=>tx.outputs.map(o=>({value:o.satoshis,script:o.script.toHex()}));
    assert.deepEqual(outputs(left),outputs(right),'Business outputs AND native change must match');
    assert.equal(left.nLockTime,right.nLockTime);assert.equal(left.version,right.version);
    assert.deepEqual(left.inputs.map(i=>i.sequenceNumber),right.inputs.map(i=>i.sequenceNumber));
    let vmInputs=0;
    const parents=new Map(material.snapshot.payload.parents.map(p=>[p.txid,new tbc.Transaction(p.rawTransaction)]));
    for(const tx of [left,right])for(let i=0;i<tx.inputs.length;i++){
      const input=tx.inputs[i],parent=parents.get(input.prevTxId.toString('hex'));assert.ok(parent);
      input.output=parent.outputs[input.outputIndex];
      const check=tx.verifyScript(i);assert.equal(check.success,true,`Independent VM input ${i}`);vmInputs++;
    }
    const sum=left.inputs.reduce((v,i)=>v+i.output.satoshis,0)-left.outputs.reduce((v,o)=>v+o.satoshis,0);
    assert.equal(sum,b.fee);assert.equal(a.signatureCount,left.inputs.length*a.rounds);
    return {inputCount:left.inputs.length,outputCount:left.outputs.length,fee:sum,vmInputs,
      engineSignedBytes:left.toBuffer().length,sdkSignedBytes:right.toBuffer().length,
      exactSignedBytesEqual:left.uncheckedSerialize()===right.uncheckedSerialize(),
      businessOutputsAndNativeChangeEqual:true,orderedInputsEqual:true,rounds:a.rounds,signatureCount:a.signatureCount};
  }
  const cases=[];
  for(const row of plans){
    const material=structuredClone(row.input);
    // Explicitly request the same fixed funding set on both sides. Do not
    // compare a no-funding Engine merge to the SDK's funded fixture.
    material.request.constraints.inputOutpoints=material.snapshot.payload.utxos.map(u=>({txid:u.txid,vout:u.vout}));
    assert.equal(material.request.from,owner);
    stage=`${material.request.intent.type} correctness`;
    const proof=compare(material,runEngine(material),runSdk(material));
    // Count SDK cryptographic calls once, outside the timing samples. Restore
    // its implementation before benchmarking; never intercept a real Signer.
    let sdkSignatureCount=0;
    const originalSign=tbc.crypto.ECDSA.sign;
    try {
      tbc.crypto.ECDSA.sign=function(...args){sdkSignatureCount++;return originalSign.apply(this,args);};
      runSdk(material);
    }finally{tbc.crypto.ECDSA.sign=originalSign;}
    assert.equal(sdkSignatureCount,proof.signatureCount,'SDK/Engine ECDSA work count differs');
    stage=`${material.request.intent.type} timing`;
    const engineSamples=[],sdkSamples=[];
    let stableProof=proof;
    for(let round=0;round<22;round++){
      const result={};
      for(const lane of round%2?['sdk','engine']:['engine','sdk'])result[lane]=lane==='engine'?runEngine(material):runSdk(material);
      const checked=compare(material,result.engine,result.sdk);assert.deepEqual(checked,stableProof);
      if(round>=2){engineSamples.push(result.engine.times);sdkSamples.push(result.sdk.times);}
    }
    function summarize(rows){return Object.fromEntries(Object.keys(rows[0]).map(k=>{
      const values=rows.map(r=>r[k]).sort((a,b)=>a-b);
      return [k,{min:values[0],median:(values[9]+values[10])/2,max:values.at(-1)}];
    }));}
    cases.push({operation:material.request.intent.type,materialSha256:sha(JSON.stringify(material)),proof:{...proof,sdkSignatureCount},
      engine:summarize(engineSamples),sdk:summarize(sdkSamples),samples:{engine:engineSamples,sdk:sdkSamples}});
  }
  const report={status:'PASS',createdAt:new Date().toISOString(),candidate:'0.1.0-candidate.226',archiveSha256:archiveSha,
    verifiedPackageFiles:922,engineWasmSha256:wasmSha,upstream:{commit,sourceHashes,tbcLibTreeSha256:libSha,typescript:ts.version},
    fixtureWireCount:wires.length,engineInitMs,samples:20,warmup:2,order:'alternating sequential',cases,
    scope:'TBC20 transfer/merge only. Warm Node WASM vs fixed JS SDK, identical explicit inputs and outputs, all parents already resident. Real HTTP/POST/custody=0.',
    comparison:'SDK total includes parent decoding, coupled build/sign and default per-input script VM verification (verify is not disabled). Engine total includes clone, normalize, plan, synthetic approval binding, four validate phases, external tbc-lib ECDSA and all finalization rounds. Engine independent script VM proof is outside timing. No production approval UI, Host, IPC, network, device or cold-start latency claims.',
    limits:['Not a comparison of equal validation work: Engine enforces separate approval/policy/finalization boundaries.',
      'Not all new contract families. TBC721/Coin/AMM/LP/HTLC/timelock/LOP fixed-SDK timings remain unproven by this report.',
      'Local 20 samples do not establish reliable p95 or device E2E performance.'],
    harnessSha256:sha(readFileSync(fileURLToPath(import.meta.url)))};
  const output=join(temp,'report.json');writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({status:report.status,report:output,sha256:sha(readFileSync(output)),cases:cases.map(c=>({operation:c.operation,proof:c.proof,engine:c.engine,sdk:c.sdk}))}));
}catch(error){
  // Do not dump assertion actual/expected: those can contain full raw fixture
  // transactions. No secrets are used, but keep benchmark logs bounded.
  console.error(JSON.stringify({status:'FAIL',stage,error:error.message?.slice(0,700)}));process.exitCode=1;
}
