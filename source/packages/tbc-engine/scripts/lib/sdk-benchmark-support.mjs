// Offline benchmark support, never imported by production packages.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync,spawnSync} from 'node:child_process';
import {readFileSync,readdirSync,mkdtempSync} from 'node:fs';
import {createRequire} from 'node:module';
import {join,resolve,relative,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {tmpdir} from 'node:os';
import {performance} from 'node:perf_hooks';
import {runInThisContext} from 'node:vm';
import {build} from 'esbuild';

export const root=fileURLToPath(new URL('../../../../',import.meta.url));
export const sha=b=>createHash('sha256').update(b).digest('hex');
export const readJson=p=>JSON.parse(readFileSync(p,'utf8'));
export const commit='af77616121db340e15bb8b73c197bc2f8d1ee986';
function tree(base,dir='',out={}){
  for(const e of readdirSync(join(base,dir),{withFileTypes:true})){
    if(e.name==='node_modules'||e.name==='.git')continue;
    const p=join(dir,e.name);if(e.isDirectory())tree(base,p,out);
    else{assert.ok(e.isFile());out[p]=sha(readFileSync(join(base,p)));}
  }return out;
}
export async function openBenchmark(upstreamArg,consumerArg){
  const upstream=resolve(upstreamArg),installed=join(resolve(consumerArg),'node_modules/@tbc/kit');
  globalThis.fetch=async()=>{throw Error('Real HTTP forbidden in offline SDK benchmark');};
  assert.equal(execFileSync('git',['-C',upstream,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),commit);
  assert.equal(readJson(join(installed,'package.json')).version,'0.1.0-candidate.226');
  const archive=join(root,'native/engine/delivery/candidate226-complete/tbc-kit-0.1.0-candidate.226.tgz');
  const archiveSha256=sha(readFileSync(archive));assert.equal(archiveSha256,'1fb39857b8326fdcbf2af2fa43d46a5d3a87d7daad81d8e012d2d69a6d5e53a4');
  const outputRoot=mkdtempSync(join(tmpdir(),'tbc-sdk226-family-'));
  execFileSync('tar',['-xzf',archive,'-C',outputRoot]);
  const files=tree(join(outputRoot,'package'));assert.equal(Object.keys(files).length,922);assert.deepEqual(tree(installed),files);
  const deps=createRequire(join(root,'packages/kit/package.json'));
  const libFiles=tree(dirname(deps.resolve('tbc-lib-js/package.json')));
  const tbcLibTreeSha256=sha(Object.keys(libFiles).sort().map(p=>`${p}\0${libFiles[p]}\n`).join(''));
  assert.equal(tbcLibTreeSha256,'b73c8b5996276584981fe5b14f04db3e4cce02c94e7a19cb2b0f64e37206c7e9');
  const tbc=deps('tbc-lib-js'),sdkSourceHashes={};
  async function loadSdk(entry){
    const built=await build({entryPoints:[join(upstream,entry)],bundle:true,write:false,metafile:true,
      platform:'node',format:'cjs',target:'node22',external:['tbc-lib-js','tbc-lib-js/*','node:crypto'],
      ...(entry.endsWith('.js')?{resolveExtensions:['.js','.json']}:{}),logLevel:'silent'});
    for(const file of Object.keys(built.metafile.inputs)){
      const p=resolve(file),rel=relative(upstream,p);assert.ok(!rel.startsWith('..'));
      const bytes=readFileSync(p);
      assert.deepEqual(bytes,execFileSync('git',['-C',upstream,'show',`${commit}:${rel}`],{maxBuffer:8*1024*1024}),`Unpinned SDK ${rel}`);
      sdkSourceHashes[rel]=sha(bytes);
    }
    const module={exports:{}};
    runInThisContext(`(function(module,exports,Buffer,require){${built.outputFiles[0].text}\n})`)(module,module.exports,Buffer,name=>{
      if(name==='tbc-lib-js'||name.startsWith('tbc-lib-js/')||name==='node:crypto')return deps(name);
      throw Error(`Unexpected dependency ${name}`);
    });return module.exports;
  }
  const {createWasmTbcEngineBackend}=await import(pathToFileURL(join(installed,'dist/esm/engine.js')));
  const {hashCanonical}=await import(pathToFileURL(join(installed,'dist/esm/wallet.js')));
  const wasm=readFileSync(join(installed,'artifacts/wasm/tbc_engine_wasm.wasm')),wasmSha256=sha(wasm);
  assert.equal(wasmSha256,'141c862a9a8aebf83be43dde3b8ad81162a89fb9e7640008cf230ff2d3f4bda7');
  const at=performance.now(),engine=await createWasmTbcEngineBackend(wasm),engineInitMs=performance.now()-at;
  const keys=[1,2].map(n=>new tbc.PrivateKey(new tbc.crypto.BN(n))),key=keys[0],owner=key.toAddress().toString();
  function call(method,input){const r=JSON.parse(engine.call(method,JSON.stringify(input)));assert.equal(r.ok,true,`${method} failed`);
    if(method==='validate')assert.equal(r.result.valid,true,`validation ${input.phase} failed`);return r.result;}
  function capture(test,filter,env,marker){
    const result=spawnSync('cargo',['test','--offline','--locked','-p','tbc-engine-core','--test',test,filter,'--','--test-threads=1','--nocapture'],
      {cwd:join(root,'packages/tbc-engine/rust'),env:{...process.env,...env},encoding:'utf8',timeout:120000,maxBuffer:64*1024*1024});
    assert.equal(result.status,0,'Native public fixture failed; raw stdout withheld');
    const rows=result.stdout.split(/\r?\n/u).filter(l=>l.includes(marker)).map(l=>JSON.parse(l.slice(l.indexOf(marker)+marker.length)));
    let wires=rows;
    if(rows[0]?.definition){
      const methods={normalizeRequestParams:'normalizeRequest',planParams:'plan',validateParams:'validate',finalizeParams:'finalize'};
      wires=[];assert.equal(rows.length%2,0);
      for(let i=0;i<rows.length;i+=2){const method=methods[rows[i].definition];assert.ok(method);
        wires.push({method,input:rows[i].value,result:{ok:true,version:rows[i].value.version,result:rows[i+1].value}});}
    }
    assert.ok(wires.length);
    for(const r of wires)assert.deepEqual(JSON.parse(engine.call(r.method,JSON.stringify(r.input))),r.result,`Native/WASM ${r.method}`);
    return wires;
  }
  const base=readJson(join(root,'packages/tbc-engine/rust/fixtures/tbc-transfer.json'));
  function runEngine(material){
    const start=performance.now(),input=structuredClone(material),times={},counts={compact64:0,schnorr64:0};
    const timed=(name,fn)=>{const at=performance.now(),r=fn();times[name]=(times[name]??0)+performance.now()-at;return r;};
    const normalized=timed('normalizeMs',()=>call('normalizeRequest',{version:'1.0',request:input.request}));
    input.request=normalized.request;input.requestHash=normalized.requestHash;
    const {plan}=timed('planMs',()=>call('plan',input));
    const params=timed('approvalBindingMs',()=>{
      const binding=structuredClone(base.finalizeInput.binding);
      Object.assign(binding.payload,{requestHash:input.requestHash,operationHash:plan.planHash,expiresAt:plan.payload.expiresAt});
      binding.bindingHash=hashCanonical(binding.payload);
      return {...input,plan,binding,approval:{...base.finalizeInput.approval,bindingHash:binding.bindingHash,expiresAt:binding.payload.expiresAt}};
    });
    timed('validatePlanMs',()=>call('validate',{...input,plan,phase:'plan'}));
    timed('validatePreSignMs',()=>call('validate',{...params,phase:'pre-sign'}));
    let tasks=plan.payload.signingTasks,result,rounds=0;
    do{
      assert.ok(rounds++<8,'Bounded fixture signing');
      params.signatures=timed('externalSignMs',()=>tasks.map(task=>{
        const signer=keys.find(k=>task.publicKey===k.publicKey.toString()||task.publicKey===k.publicKey.toXOnly().toString('hex'));
        assert.ok(signer,'Only explicit public test scalars');const digest=Buffer.from(task.digest,'hex');
        let signature;assert.ok(Object.hasOwn(counts,task.signatureEncoding));counts[task.signatureEncoding]++;
        if(task.signatureEncoding==='schnorr64')signature=tbc.crypto.Schnorr.sign(digest,signer.toBuffer(),Buffer.alloc(32));
        else {const s=tbc.crypto.ECDSA.sign(digest,signer,'big');signature=Buffer.concat([s.r.toBuffer({size:32}),s.s.toBuffer({size:32})]);}
        return {taskId:task.taskId,signatureEncoding:task.signatureEncoding,signature:signature.toString('hex')};
      }));
      result=timed('finalizeMs',()=>call('finalize',params));
      if(!result.bundle){params.continuation=result.continuation;tasks=result.signingRequests;}
    }while(!result.bundle);
    timed('validateFinalizedMs',()=>call('validate',{...params,bundle:result.bundle,phase:'finalized'}));
    timed('validatePreBroadcastMs',()=>call('validate',{...params,bundle:result.bundle,phase:'pre-broadcast'}));
    times.totalMs=performance.now()-start;
    return {times,raws:result.bundle.transactions.map(tx=>tx.rawTransaction),rounds,counts};
  }
  return {tbc,key,owner,engine,call,capture,loadSdk,runEngine,outputRoot,
    identity:{archiveSha256,verifiedPackageFiles:922,wasmSha256,upstreamCommit:commit,tbcLibTreeSha256,sdkSourceHashes,engineInitMs}};
}
export async function measurePair(material,runEngine,runSdk,compare){
  const proof=compare(runEngine(material),runSdk(material)),engine=[],sdk=[];
  for(let round=0;round<22;round++){
    const r={};for(const lane of round%2?['sdk','engine']:['engine','sdk'])r[lane]=(lane==='engine'?runEngine:runSdk)(material);
    // Signatures may use random auxiliary bytes. Proof comparisons must assert
    // semantic equality, valid scripts and fees, not random txid equality.
    compare(r.engine,r.sdk);
    if(round>=2){engine.push(r.engine.times);sdk.push(r.sdk.times);}
  }
  const summary=rows=>Object.fromEntries(Object.keys(rows[0]).map(k=>{const v=rows.map(r=>r[k]).sort((a,b)=>a-b);
    return [k,{min:v[0],median:(v[9]+v[10])/2,max:v.at(-1)}];}));
  return {materialSha256:sha(JSON.stringify(material)),proof,engine:summary(engine),sdk:summary(sdk),samples:{engine,sdk}};
}
