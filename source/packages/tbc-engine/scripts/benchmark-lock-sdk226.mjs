#!/usr/bin/env node
// Public synthetic lock fixtures only. Never load wallet keys or real preimages.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {runInThisContext} from 'node:vm';
import {performance} from 'node:perf_hooks';
import {openBenchmark,root,sha,commit} from './lib/sdk-benchmark-support.mjs';

assert.equal(process.argv.length,4,'Usage: FIXED_UPSTREAM EXACT226_CONSUMER');
let stage='identity';
try{
  const ctx=await openBenchmark(process.argv[2],process.argv[3]);
  const {tbc,key,owner,capture,loadSdk,call}=ctx;
  const {hashCanonical}=await import(pathToFileURL(join(resolve(process.argv[3]),'node_modules/@tbc/kit/dist/esm/wallet.js')));
  const keys=[key,new tbc.PrivateKey(new tbc.crypto.BN(2))];
  const HTLC=await loadSdk('lib/contract/htlc.js');
  const util=await loadSdk('lib/util/common/util.js');
  let snapshotHeight,stubbedHeightReads=0;
  // The SDK class is byte-exact. Only its API dependency is an explicit stub
  // so both lanes receive the same height rather than timing a live endpoint.
  const piggyPath='lib/contract/piggyBank.js',piggyBytes=readFileSync(join(resolve(process.argv[2]),piggyPath));
  assert.deepEqual(piggyBytes,execFileSync('git',['-C',resolve(process.argv[2]),'show',`${commit}:${piggyPath}`]));
  ctx.identity.sdkSourceHashes[piggyPath]=sha(piggyBytes);
  const mod={exports:{}};
  runInThisContext(`(function(module,exports,require){${piggyBytes.toString()}\n})`)(mod,mod.exports,name=>{
    if(name==='tbc-lib-js')return tbc;
    if(name==='../util/common/util')return util;
    assert.equal(name,'../api/api');return {async fetchBlockHeaders(){stubbedHeightReads++;assert.ok(Number.isInteger(snapshotHeight));return [{height:snapshotHeight}];}};
  });
  const TimeLock=mod.exports;
  stage='Native/WASM lock fixtures';
  const native=capture('htlc_public','public_htlc_uses_shared_plan_approval_and_finalize',{HTLC_PUBLIC_DUMP_WIRE:'1'},'HTLC_PUBLIC_WIRE:');
  const token=capture('htlc_public','public_htlc_token_lifecycle_uses_shared_bound_signatures',{HTLC_PUBLIC_DUMP_WIRE:'1'},'HTLC_PUBLIC_WIRE:');
  const time=capture('timelock_public','public_timelock_uses_shared_plan_approval_and_finalize',{TIMELOCK_PUBLIC_DUMP_WIRE:'1'},'TIMELOCK_PUBLIC_WIRE:');
  const all=[...native,...token,...time],plans=all.filter(r=>r.method==='plan'&&r.input.request.chainId==='tbc:mainnet');assert.equal(plans.length,14);
  // Reuse each public fixture's genuine binding shape, including claimant
  // account2. Do not force all operations into scalar1's approval context.
  function runEngine(material){
    const start=performance.now(),input=structuredClone(material),times={},counts={compact64:0,schnorr64:0};
    const timed=(name,fn)=>{const at=performance.now(),v=fn();times[name]=(times[name]??0)+performance.now()-at;return v;};
    const normalized=timed('normalizeMs',()=>call('normalizeRequest',{version:'1.0',request:input.request}));
    input.request=normalized.request;input.requestHash=normalized.requestHash;
    const {plan}=timed('planMs',()=>call('plan',input));
    const params=timed('approvalBindingMs',()=>{
      const source=all.find(r=>r.method==='finalize'&&r.input.requestHash===material.requestHash);assert.ok(source);
      const binding=structuredClone(source.input.binding);
      Object.assign(binding.payload,{requestHash:input.requestHash,operationHash:plan.planHash,expiresAt:plan.payload.expiresAt});binding.bindingHash=hashCanonical(binding.payload);
      assert.equal(binding.payload.accountId,input.snapshot.payload.account.accountId);
      return {...input,plan,binding,approval:{...source.input.approval,bindingHash:binding.bindingHash,expiresAt:binding.payload.expiresAt}};
    });
    timed('validatePlanMs',()=>call('validate',{...input,plan,phase:'plan'}));
    timed('validatePreSignMs',()=>call('validate',{...params,phase:'pre-sign'}));
    let tasks=plan.payload.signingTasks,result,rounds=0;
    do{
      assert.ok(rounds++<8);
      params.signatures=timed('externalSignMs',()=>tasks.map(task=>{
        assert.equal(task.signatureEncoding,'compact64');
        const signer=keys.find(k=>k.publicKey.toString()===task.publicKey);assert.ok(signer);counts.compact64++;
        const sig=tbc.crypto.ECDSA.sign(Buffer.from(task.digest,'hex'),signer,'big');
        return {taskId:task.taskId,signatureEncoding:task.signatureEncoding,signature:Buffer.concat([sig.r.toBuffer({size:32}),sig.s.toBuffer({size:32})]).toString('hex')};
      }));
      result=timed('finalizeMs',()=>call('finalize',params));
      if(!result.bundle){params.continuation=result.continuation;tasks=result.signingRequests;}
    }while(!result.bundle);
    timed('validateFinalizedMs',()=>call('validate',{...params,bundle:result.bundle,phase:'finalized'}));
    timed('validatePreBroadcastMs',()=>call('validate',{...params,bundle:result.bundle,phase:'pre-broadcast'}));
    times.totalMs=performance.now()-start;
    return {times,raws:result.bundle.transactions.map(t=>t.rawTransaction),rounds,counts};
  }
  const decimal=n=>{const s=String(n).padStart(7,'0');return `${s.slice(0,-6)}.${s.slice(-6)}`;};
  async function runSdk(material){
    const start=performance.now(),s=material.snapshot.payload,i=material.request.intent;
    const signer=keys.find(k=>k.toAddress().toString()===material.request.from);assert.ok(signer);
    const address=signer.toAddress().toString(),history=new Map(s.parents.map(p=>[p.txid,new tbc.Transaction(p.rawTransaction)]));
    const ref=u=>({txId:u.txid,outputIndex:u.vout,script:u.scriptPubKey,satoshis:Number(u.satoshis)});
    const fee=s.utxos.filter(u=>u.classification==='native'),deposits=s.utxos.filter(u=>u.classification==='htlc');
    const assets=s.utxos.filter(u=>['ft','stablecoin'].includes(u.classification));
    const tokenRef=u=>{const p=history.get(u.txid);assert.ok(p);return {...ref(u),ftBalance:util.getFtBalanceFromTape(p.outputs[u.vout+1].script.toHex()).toString()};};
    const resolver=id=>{assert.ok(history.has(id));return history.get(id);};
    const decodeEnd=performance.now(),beforeReads=stubbedHeightReads;let raw;
    // Fixed upstream wrappers log diagnostics; never forward raw-sensitive SDK
    // messages. This scope is sequential and always restores console.log.
    const originalLog=console.log;console.log=()=>{};
    try{
      if(i.type.startsWith('tbc-timelock-')){
        snapshotHeight=Number(s.block.height);const inputs=s.utxos.map(ref);
        raw=i.type==='tbc-timelock-lock'?TimeLock.freezeTBC(address,decimal(i.amount),Number(i.lockTime),inputs):await TimeLock.unfreezeTBC(address,inputs,'mainnet');
        const tx=new tbc.Transaction(raw);
        for(const [vin,input]of tx.inputs.entries()){
          const u=inputs.find(u=>u.txId===input.prevTxId.toString('hex')&&u.outputIndex===input.outputIndex);assert.ok(u);
          input.output=new tbc.Transaction.Output({satoshis:u.satoshis,script:tbc.Script.fromHex(u.script)});
          input.setScript(tbc.Script.fromASM(`${tx.getSignature(vin,signer)} ${signer.publicKey.toString()}`));
        }
        raw=tx.uncheckedSerialize();
      }else if(!i.assetStandard){
        if(i.type==='tbc-htlc-lock'){
          assert.equal(fee.length,1);raw=HTLC.deployHTLCWithSign(address,i.to,i.hashlock,Number(i.lockTime),decimal(i.amount),ref(fee[0]),signer);
        }else if(i.type==='tbc-htlc-claim'){
          assert.equal(deposits.length,1);raw=HTLC.withdrawWithSign(signer.toWIF(),address,ref(deposits[0]),i.preimage);
        }else{
          assert.equal(deposits.length,1);const lock=tbc.Script.fromHex(deposits[0].scriptPubKey).toBuffer().readUInt32LE(61);
          raw=HTLC.refundWithSign(address,ref(deposits[0]),signer.toWIF(),lock);
        }
      }else{
        assert.equal(fee.length,1);
        if(i.type==='tbc-htlc-lock'){
          raw=HTLC.deployHTLCTokenWithSign(address,i.to,i.hashlock,Number(i.lockTime),decimal(i.amount),
            assets.map(tokenRef),ref(fee[0]),assets.map(u=>history.get(u.txid)),assets.map(()=>resolver),signer.toWIF());
        }else{
          assert.equal(deposits.length,1);assert.equal(assets.length,1);const parent=history.get(deposits[0].txid);assert.ok(parent);
          raw=i.type==='tbc-htlc-claim'?HTLC.withdrawHTLCTokenWithSign(signer.toWIF(),address,ref(deposits[0]),tokenRef(assets[0]),parent,resolver,ref(fee[0]),i.preimage)
            :HTLC.refundHTLCTokenWithSign(signer.toWIF(),address,ref(deposits[0]),tokenRef(assets[0]),parent,resolver,ref(fee[0]),parent.outputs[0].script.toBuffer().readUInt32LE(61));
        }
      }
    }finally{console.log=originalLog;}
    const end=performance.now();return {raws:[raw],heightReads:stubbedHeightReads-beforeReads,times:{decodeMs:decodeEnd-start,buildAndSignMs:end-decodeEnd,totalMs:end-start}};
  }
  function compare(material,e,s){
    assert.equal(e.raws.length,1);assert.equal(s.raws.length,1);
    const pair=[e,s].map(v=>new tbc.Transaction(v.raws[0]));
    assert.equal(pair[0].version,pair[1].version);assert.equal(pair[0].nLockTime,pair[1].nLockTime);
    const inputs=pair.map(tx=>tx.inputs.map(i=>({id:i.prevTxId.toString('hex'),vout:i.outputIndex,sequence:i.sequenceNumber})));
    assert.deepEqual(inputs[0],inputs[1],'Input topology');
    const outputs=pair.map(tx=>tx.outputs.map(o=>({value:o.satoshis,script:o.script.toHex()})));
    assert.deepEqual(outputs[0].map(o=>o.script),outputs[1].map(o=>o.script),'Every output script');
    assert.deepEqual(outputs[0].slice(0,-1),outputs[1].slice(0,-1),'Business outputs');
    assert.equal(outputs[0].at(-1).script,tbc.Script.buildPublicKeyHashOut(material.request.from).toHex());
    const fees=[],sizes=[];let vmInputs=0;
    for(const tx of pair){
      for(const [vin,input]of tx.inputs.entries()){
        const u=material.snapshot.payload.utxos.find(u=>u.txid===input.prevTxId.toString('hex')&&u.vout===input.outputIndex);assert.ok(u);
        input.output=new tbc.Transaction.Output({satoshis:Number(u.satoshis),script:tbc.Script.fromHex(u.scriptPubKey)});
        assert.equal(tx.verifyScript(vin).success,true,`Independent VM input ${vin}`);vmInputs++;
      }
      const fee=tx.inputs.reduce((n,i)=>n+i.output.satoshis,0)-tx.outputs.reduce((n,o)=>n+o.satoshis,0),bytes=tx.toBuffer().length;
      assert.ok(fee>=Math.max(80,Math.ceil(bytes*80/1000)));assert.ok(fee<=Number(material.request.constraints.maxFee));fees.push(fee);sizes.push(bytes);
    }
    if(material.request.intent.assetStandard){assert.ok(fees[1]>=fees[0]&&fees[1]-fees[0]<=4,'Known SDK compressed-key fee reserve difference');}
    else assert.equal(e.raws[0],s.raws[0],'Native HTLC/TimeLock complete signed bytes');
    return {inputs:pair[0].inputs.length,outputs:pair[0].outputs.length,fees,signedBytes:sizes,vmInputs,exactSignedBytesEqual:e.raws[0]===s.raws[0],engineRounds:e.rounds,engineSignatures:e.counts,sdkHeightReads:s.heightReads};
  }
  async function countSdk(material){
    const old=tbc.crypto.ECDSA.sign;let count=0;
    try{tbc.crypto.ECDSA.sign=function(...a){count++;return old.apply(this,a);};await runSdk(material);}
    finally{tbc.crypto.ECDSA.sign=old;}return {compact64:count,schnorr64:0};
  }
  async function measure(material){
    const proof=compare(material,runEngine(material),await runSdk(material)),engine=[],sdk=[];
    for(let round=0;round<22;round++){
      const pair={};for(const lane of round%2?['sdk','engine']:['engine','sdk'])pair[lane]=await(lane==='engine'?runEngine:runSdk)(material);
      compare(material,pair.engine,pair.sdk);if(round>=2){engine.push(pair.engine.times);sdk.push(pair.sdk.times);}
    }
    const summary=rows=>Object.fromEntries(Object.keys(rows[0]).map(k=>{const v=rows.map(r=>r[k]).sort((a,b)=>a-b);return[k,{min:v[0],median:(v[9]+v[10])/2,max:v.at(-1)}];}));
    return {materialSha256:sha(JSON.stringify(material)),proof,engine:summary(engine),sdk:summary(sdk),samples:{engine,sdk}};
  }
  const cases=[];
  for(const [index,row]of plans.entries()){
    const i=row.input.request.intent,operation=i.type,asset=i.assetStandard??'tbc',clock=row.input.snapshot.payload.block.medianTimePast?'timestamp-context':'height-context';
    stage=`${index+1}/14 ${asset} ${operation} ${clock}`;
    const sdkSignatures=await countSdk(row.input),measured=await measure(row.input);
    cases.push({operation,asset,clock,sdkSignatures,...measured});
    console.log(JSON.stringify({stage,status:'PASS',engineMs:measured.engine.totalMs.median,sdkMs:measured.sdk.totalMs.median,proof:measured.proof,sdkSignatures}));
  }
  const report={status:'PASS',createdAt:new Date().toISOString(),...ctx.identity,fixtureWireCount:all.length,cases,samples:20,warmup:2,order:'alternating sequential, async SDK awaited',
    harnessSha256:sha(readFileSync(fileURLToPath(import.meta.url))),supportSha256:sha(readFileSync(join(root,'packages/tbc-engine/scripts/lib/sdk-benchmark-support.mjs'))),
    scope:'Six native HTLC height/time cases, six TBC20/Coin HTLC lock/claim/refund cases, two TimeLock cases; 14 mainnet-labelled synthetic materials. Native/WASM parity includes both token network labels. No actual network, assets, Host/UI/IPC or device timings.',
    differences:['Engine includes four validation phases and external signer; SDK with-sign wrappers retain default computations and known fee reservation.',
      'TimeLock SDK API.fetchBlockHeaders is explicitly stubbed with the same snapshot height. Logical read counted, no HTTP or network latency measured.',
      'Public synthetic HTLC preimage and raw are memory-only, not report fields; SDK diagnostic logs suppressed in a sequential try/finally.',
      'Only native fee-change may differ for token HTLC, with fixed known 0..4 atomic bound and both lanes independently VM-checked.',
      'Native HTLC uses SDK with-sign claim OP_TRUE, not its non-minimal separate filler. No source correction hidden in timings.',
      'LOP and cooperative MuSig performance remain outside this report. Twenty local samples do not prove p95 or phone E2E.']};
  const output=join(ctx.outputRoot,'report.json'),encoded=JSON.stringify(report,null,2)+'\n';
  assert.ok(!encoded.includes('33'.repeat(32)),'Synthetic preimage must not appear in report');writeFileSync(output,encoded,{flag:'wx'});
  console.log(JSON.stringify({status:'LOCK_SDK_BENCHMARK_PASS',report:output,sha256:sha(readFileSync(output)),cases:cases.length,fixtureWireCount:report.fixtureWireCount}));
}catch(error){console.error(JSON.stringify({status:'FAIL',stage,reason:error.code??error.name}));process.exitCode=1;}
