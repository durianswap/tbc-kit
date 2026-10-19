#!/usr/bin/env node
// Public synthetic participants only. Not a custody implementation or transport.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';
import {openBenchmark,root,sha,commit} from '../../../packages/tbc-engine/scripts/lib/sdk-benchmark-support.mjs';

assert.equal(process.argv.length,5,'Usage: FIXED_UPSTREAM EXACT226_CONSUMER LOCAL5_SDK');
let stage='identity';
try{
  const ctx=await openBenchmark(process.argv[2],process.argv[3]),{tbc}=ctx;
  const sdk=resolve(process.argv[4]),identity=JSON.parse(readFileSync(join(sdk,'identity.json')));
  assert.equal(identity.sdkVersion,'0.1.0-local.5');assert.equal(identity.artifactSetId,'b1e6fa0d78a85b4702eabea52aa16cfae74fbfee82c90edb37142218c9fd0bfd');
  const delivery=join(root,'native/signer/delivery/local5'),archive=join(delivery,'wasm-signer.tgz');
  const archiveHash=sha(readFileSync(archive));assert.equal(archiveHash,'a9275eb60babd5d1914b327eb5b8e25c6d63085112e432082a199fc8c297ab05');
  const extracted=join(ctx.outputRoot,'local5');mkdirSync(extracted);execFileSync('tar',['-xzf',archive,'-C',extracted]);
  const extractedIdentity=JSON.parse(readFileSync(join(extracted,'identity.json')));assert.deepEqual(extractedIdentity,identity);
  const wasm=readFileSync(join(extracted,'wasm/tbc_signer_kernel.wasm'));
  assert.equal(sha(wasm),'fde7b3c63a0a9a1a585b7d62de6d9f39cac0646fa7892bab1892d9b6f73ec580');
  const adapter=join(extracted,'wasm/musig-adapter.mjs');assert.equal(sha(readFileSync(adapter)),'5457aeb7beffaef2526afe53143f1c8c78f9f28524f327ef5e25395bcfce2122');
  // SDK's documented protocol calls the same pinned tbc-lib-js MuSig2 primitive.
  const docs=readFileSync(join(resolve(process.argv[2]),'docs/coinTbc20.md'));
  assert.deepEqual(docs,execFileSync('git',['-C',resolve(process.argv[2]),'show',`${commit}:docs/coinTbc20.md`]));
  ctx.identity.sdkSourceHashes['docs/coinTbc20.md']=sha(docs);
  // Compile only the frozen public-fixture C probe against the frozen dylib.
  // This supplies an independent native/WASM transcript parity check, not
  // native performance or a phone measurement.
  const fixedFiles=['scripts/check-musig-abi-parity.mjs','fixtures/musig-abi-probe.c','include/tbc_signer_musig.h','wasm/musig-adapter.mjs'];
  for(const file of fixedFiles)assert.equal(sha(readFileSync(join(sdk,'kernel',file))),identity.extension.files[file]);
  const native=join(sdk,'kernel/artifacts/native/aarch64-apple-darwin');
  assert.equal(sha(readFileSync(join(native,'libtbc_signer_kernel.dylib'))),'28083ed6d4eafc8140b7c69ba3ec382b2864546d795c9f54dd221d65d868a375');
  stage='native parity';
  const parityOutput=execFileSync(process.execPath,[join(sdk,'kernel/scripts/check-musig-abi-parity.mjs'),native,join(extracted,'wasm/tbc_signer_kernel.wasm')],{encoding:'utf8',timeout:60000,maxBuffer:1024*1024});
  const parity=JSON.parse(parityOutput.trim());assert.equal(parity.status,'PASS');assert.equal(parity.nativeWasmIdentical,true);
  const parityBytes=readFileSync(join(parity.output,'report.json'));
  writeFileSync(join(ctx.outputRoot,'native-parity.json'),parityBytes,{flag:'wx'});
  const {createWasmMuSigSigner}=await import(pathToFileURL(adapter)),{MuSig2,Schnorr}=tbc.crypto;
  const compiled=new WebAssembly.Module(wasm),at=performance.now();
  const peers=await Promise.all(Array.from({length:32},()=>createWasmMuSigSigner(compiled)));
  const peerInitMs=performance.now()-at,buf=h=>Buffer.from(h,'hex');
  const parties=Array.from({length:32},(_,i)=>{const sk=Buffer.alloc(32);sk[31]=i+1;return {sk,pk:MuSig2.pubkeyFromSk(sk)};});
  const digest=Buffer.alloc(32,0x37),binding='20'.repeat(32);
  const summarize=rows=>Object.fromEntries(Object.keys(rows[0]).map(k=>{const v=rows.map(r=>r[k]).sort((a,b)=>a-b);return[k,{min:v[0],median:(v[9]+v[10])/2,max:v.at(-1)}];}));
  function timedRun(fn){const start=performance.now(),times={};
    const timed=(name,work)=>{const at=performance.now(),out=work();times[name]=(times[name]??0)+performance.now()-at;return out;};
    const out=fn(timed);times.totalMs=performance.now()-start;return {...out,times};}
  function runKernel(group){return timedRun(timed=>{
    const publicKeys=group.map(p=>p.pk.toString('hex'));
    const aggregateKey=timed('aggregateKeyMs',()=>peers[0].aggregateKey(publicKeys));
    const common={publicKeys,aggregateKey,digest:digest.toString('hex'),binding,expiresAt:Math.floor(performance.now())+120000};
    let sessions=[],complete=false;
    try{
      sessions=timed('nonceAndBindingMs',()=>group.map((p,i)=>peers[i].begin({...common,scalar:p.sk})));
      const publicNonces=sessions.map(s=>s.publicNonce);
      const partialSignatures=timed('partialSignMs',()=>group.map((p,i)=>peers[i].sign({handle:sessions[i].handle,binding,digest:common.digest,scalar:p.sk,publicNonces})));
      const signature=timed('verifyAndCombineMs',()=>peers[0].combine({...common,publicNonces,partialSignatures}));
      complete=true;
      return {common,sessions,publicNonces,partialSignatures,signature};
    }finally{
      // Successful sign consumes each session inside Rust. Do not cancel first:
      // the untimed reuse test must demonstrate consumption, not cancellation.
      if(!complete)group.forEach((_,i)=>peers[i].cancelAll());
    }
  });}
  function runSdk(group){return timedRun(timed=>{
    const context=timed('aggregateKeyMs',()=>MuSig2.keyAgg(group.map(p=>p.pk)));
    const aggregateKey=MuSig2.getAggPubkey(context),nonces=[];
    try{
      timed('nonceMs',()=>group.forEach(p=>nonces.push(MuSig2.nonceGen({pk:p.pk,sk:p.sk,aggpk:aggregateKey,msg:digest}))));
      const session=timed('sessionMs',()=>MuSig2.buildSession(context,MuSig2.nonceAgg(nonces.map(n=>n.pubnonce)),digest));
      const partialSignatures=timed('partialSignMs',()=>group.map((p,i)=>MuSig2.partialSign(nonces[i].secnonce,p.sk,session)));
      const signature=timed('verifyAndCombineMs',()=>{
        // Explicit SDK share verification matches the kernel combine boundary;
        // the short upstream documentation example shows only final verify.
        group.forEach((p,i)=>assert.equal(MuSig2.partialVerify(partialSignatures[i],nonces[i].pubnonce,p.pk,session),true));
        const sig=MuSig2.partialSigAgg(partialSignatures,session);assert.equal(Schnorr.verify(digest,sig,aggregateKey),true);return sig;
      });
      return {aggregateKey:aggregateKey.toString('hex'),publicNonces:nonces.map(n=>n.pubnonce.toString('hex')),partialSignatures:partialSignatures.map(p=>p.toString('hex')),signature:signature.toString('hex')};
    }finally{timed('cleanupMs',()=>nonces.forEach(n=>n.secnonce.fill(0)));}
  });}
  function verify(group,k,s){
    assert.equal(k.common.aggregateKey,s.aggregateKey);
    const context=MuSig2.keyAgg(group.map(p=>p.pk));
    const session=MuSig2.buildSession(context,MuSig2.nonceAgg(k.publicNonces.map(buf)),digest);
    group.forEach((p,i)=>assert.equal(MuSig2.partialVerify(buf(k.partialSignatures[i]),buf(k.publicNonces[i]),p.pk,session),true));
    assert.equal(MuSig2.partialSigAgg(k.partialSignatures.map(buf),session).toString('hex'),k.signature);
    const fromSdk=peers[0].combine({...k.common,publicNonces:s.publicNonces,partialSignatures:s.partialSignatures});
    assert.equal(fromSdk,s.signature);
    for(const value of [k.signature,s.signature]){
      assert.equal(Schnorr.verify(digest,buf(value),buf(s.aggregateKey)),true);
      assert.equal(Schnorr.verify(Buffer.alloc(32,0x38),buf(value),buf(s.aggregateKey)),false);
    }
    assert.throws(()=>peers[0].sign({handle:k.sessions[0].handle,binding,digest:k.common.digest,scalar:group[0].sk,publicNonces:k.publicNonces}),/106/);
    assert.throws(()=>peers[0].combine({...k.common,publicNonces:s.publicNonces,partialSignatures:s.partialSignatures.slice(1)}));
    const tampered=[...s.partialSignatures],changed=buf(tampered[0]);changed[31]^=1;tampered[0]=changed.toString('hex');
    assert.throws(()=>peers[0].combine({...k.common,publicNonces:s.publicNonces,partialSignatures:tampered}),/105/);
  }
  const results=[];
  try{
    for(const count of [2,3,32]){
      stage=`${count}-of-${count}`;const group=parties.slice(0,count).sort((a,b)=>Buffer.compare(a.pk,b.pk)),kernel=[],sdkSamples=[];
      for(let round=0;round<22;round++){
        const output={};for(const lane of round%2?['sdk','kernel']:['kernel','sdk'])output[lane]=(lane==='kernel'?runKernel:runSdk)(group);
        verify(group,output.kernel,output.sdk);
        if(round>=2){kernel.push(output.kernel.times);sdkSamples.push(output.sdk.times);}
      }
      const result={members:count,mode:'n-of-n',kernel:summarize(kernel),sdk:summarize(sdkSamples),samples:{kernel,sdk:sdkSamples},
        proof:{mutualPartialAndFinalInterop:true,wrongDigestRejected:true,consumedHandleRejected:true,missingShareRejected:true,tamperedShareRejected:true,signatureBytes:64,nonceRounds:1,partialRounds:1,secretNonceExported:false,publicFixtureOnly:true}};
      results.push(result);console.log(JSON.stringify({stage,status:'PASS',kernelMs:result.kernel.totalMs.median,sdkMs:result.sdk.totalMs.median}));
    }
  }finally{parties.forEach(p=>p.sk.fill(0));peers.forEach(p=>p.cancelAll());}
  const report={status:'PASS',createdAt:new Date().toISOString(),...ctx.identity,signerVersion:identity.sdkVersion,signerArtifactSetId:identity.artifactSetId,signerArchiveSha256:archiveHash,
    signerWasmSha256:sha(wasm),adapterSha256:sha(readFileSync(adapter)),nativeParityReportSha256:sha(parityBytes),nativeWasmParity:true,
    peerInitMs,instantiatedPeers:32,cases:results,samples:20,warmup:2,order:'alternating sequential',
    harnessSha256:sha(readFileSync(fileURLToPath(import.meta.url))),supportSha256:sha(readFileSync(join(root,'packages/tbc-engine/scripts/lib/sdk-benchmark-support.mjs'))),
    scope:'Frozen local5 optional signer vs fixed SDK MuSig2, 2/3/32 public participants; no transaction building, Host, custody, UI, peer network, node or broadcast latency included.',
    differences:['Kernel aggregate/begin/sign/combine include FFI, encoding, group checks, task binding, deadline and one-use registry. SDK primitive has no equivalent custody/approval lifecycle.',
      'SDK share verification is explicitly included before final aggregation; upstream short Coin documentation example verifies only final signature. This is not a literal timing of that example.',
      'Every participant is sequential in one Node process with separate WASM instances. No claim of independent custody or distributed wall-clock latency.',
      'Both use fresh secure platform randomness. No deterministic nonce override or secret nonce export. Public transcript cross-checks and negative cases are outside timing.',
      'Native/WASM parity uses the frozen two-member C fixture, not a 32-member native timing claim. No new device work.',
      'Engine transaction costs remain in previous Coin/AMM reports. Signer timings cannot be added to medians as an exact end-to-end measurement.']};
  const output=join(ctx.outputRoot,'report.json');writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({status:'MUSIG_SDK_BENCHMARK_PASS',report:output,sha256:sha(readFileSync(output)),cases:3,nativeParity:true}));
}catch(error){console.error(JSON.stringify({status:'FAIL',stage,reason:error.code??error.name,location:error.stack?.split('\n').find(l=>l.includes('benchmark-musig-sdk226.mjs:'))?.trim()}));process.exitCode=1;}
