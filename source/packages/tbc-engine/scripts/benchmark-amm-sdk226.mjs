#!/usr/bin/env node
// Fixed SDK and immutable226: synthetic AMM/LP only, no HTTP or custody.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {openBenchmark,root,sha} from './lib/sdk-benchmark-support.mjs';

assert.equal(process.argv.length,4,'Usage: FIXED_UPSTREAM EXACT226_CONSUMER');
let stage='identity';
try{
  const ctx=await openBenchmark(process.argv[2],process.argv[3]);
  const {tbc,key,owner,capture,loadSdk,runEngine}=ctx;
  stage='fixed AMM sources';
  const {PoolNFT3}=await loadSdk('lib/contract/poolNFT3.0.js');
  const {privateKeySigner}=await loadSdk('lib/util/poolnft3/transaction.js');
  const {decodePoolTape}=await loadSdk('lib/util/poolnft3/tape.js');
  const controllerKey=new tbc.PrivateKey(new tbc.crypto.BN(2));
  stage='Native/WASM public fixture parity';
  const createWires=capture('amm_public','four_public_amm_creates_bind_funded_continuation_and_match_sdk',{AMM_DUMP_WIRE:'1'},'AMM_WIRE:');
  const actionWires=capture('amm_public','unified_pool_business_preserves_current_transactions',{UNIFIED_BUSINESS_DUMP_WIRE:'1'},'UNIFIED_BUSINESS_WIRE:');
  const lpWires=capture('lp_public','unified_lp_holder_operations_preserve_current_transactions',{UNIFIED_BUSINESS_DUMP_WIRE:'1'},'UNIFIED_BUSINESS_WIRE:');
  const creates=createWires.filter(r=>r.method==='plan');assert.equal(creates.length,4);
  const actions=actionWires.filter(r=>r.method==='plan'&&r.input.request.intent.type.startsWith('amm.'));assert.equal(actions.length,16);
  const lps=lpWires.filter(r=>r.method==='plan'&&r.input.request.intent.type.startsWith('tbc20Lp.'));assert.equal(lps.length,6);

  async function runSdk(material){
    const start=performance.now(),s=material.snapshot.payload,i=material.request.intent;
    const history=new Map(s.parents.map(p=>[p.txid,new tbc.Transaction(p.rawTransaction)]));
    const signer=privateKeySigner(key);
    const selected=kind=>s.utxos.filter(u=>u.classification===kind);
    const reference=u=>{assert.ok(u);assert.ok(history.has(u.txid));return {parentTx:history.get(u.txid),outputIndex:u.vout,signer,ancestors:history};};
    const fee=selected('native');assert.equal(fee.length,1);const funding=reference(fee[0]);
    let pool;
    if(i.type==='tbc-amm-create'){
      pool=new PoolNFT3({ftGenesisTx:history.get(i.ftContractId),lp:{kind:i.lpTimelock?'timelocked':'plain'},lpPlan:i.lpPlan,
        authorization:i.controllers?{kind:'controller',controllerPubKeyHashes:i.controllers}:{kind:'public'}});
    }else{
      const genesis=history.get(i.poolContractId);assert.ok(genesis);
      const config=decodePoolTape(genesis.outputs[1].script.toBuffer());
      const ftGenesis=history.get(config.ftAContractId);assert.ok(ftGenesis);
      pool=PoolNFT3.fromPool(genesis,ftGenesis);
    }
    const decodeEnd=performance.now();let raws;
    if(i.type==='tbc-amm-create'){
      raws=(await pool.mintPoolNFT({funding})).transactions.map(tx=>tx.uncheckedSerialize());
    }else if(i.type.startsWith('tbc20Lp.')){
      const inputs=selected('ftlp').map(reference),options={inputs,funding,receiverAddress:i.to??owner};
      let prepared;
      if(i.type==='tbc20Lp.unlock')prepared=pool.prepareUnlockLP(options);
      else{
        const amountRaw=i.type==='tbc20Lp.merge'?inputs.reduce((n,input)=>n+pool.validateLP(input).tape.balance,0n):BigInt(i.amount);
        prepared=pool.prepareTransferLP({...options,amountRaw,...(i.type==='tbc20Lp.lock'?{outputLockTime:Number(i.lockTime)}:{})});
      }
      raws=[(await prepared.sign()).transaction.uncheckedSerialize()];
    }else{
      const current=reference(selected('pool')[0]).parentTx;
      const ancestorTx=history.get(current.inputs[0].prevTxId.toString('hex'));assert.ok(ancestorTx);
      const options={pool:{parentTx:current,ancestorTx},poolFT:reference(selected('pool-ft')[0]),funding};
      if(pool.config.authorization.kind==='controller'){
        assert.equal(material.request.signingRoles.length,1);
        assert.equal(s.signingAccounts[0].publicKey,controllerKey.publicKey.toString());
        options.controllerSigner=privateKeySigner(controllerKey);
      }
      let prepared;
      if(i.type==='amm.addLiquidity'){
        assert.equal(i.budgetAsset,'tbc');
        prepared=pool.prepareAddLP({...options,userFT:reference(selected('ft')[0]),incrementSat:BigInt(i.amount),
          firstFtAmountRaw:BigInt(i.initialFtAmount),lpReceiverAddress:owner,...(i.lockTime?{lpLockTime:Number(i.lockTime)}:{})});
      }else if(i.type==='amm.removeLiquidity'){
        prepared=pool.prepareRemoveLP({...options,userLP:reference(selected('ftlp')[0]),burnAmountRaw:BigInt(i.lpAmount),receiverAddress:owner});
      }else if(i.direction==='tbc-to-ft'){
        prepared=pool.prepareSwapFT({...options,inputTbcSat:BigInt(i.amount),minFtOutRaw:BigInt(i.minimumOutput),receiverAddress:owner});
      }else{
        assert.equal(i.direction,'ft-to-tbc');
        prepared=pool.prepareSwapTBC({...options,userFT:reference(selected('ft')[0]),inputFtRaw:BigInt(i.amount),minTbcOutSat:BigInt(i.minimumOutput),receiverAddress:owner});
      }
      raws=[(await prepared.sign()).transaction.uncheckedSerialize()];
    }
    const end=performance.now();return {raws,times:{decodeAndConfigMs:decodeEnd-start,buildAndSignMs:end-decodeEnd,totalMs:end-start}};
  }
  function compare(material,engine,sdk){
    assert.deepEqual(engine.raws,sdk.raws,'Complete signed bytes, fees, layout and dependent txids must match fixed SDK');
    const history=new Map(material.snapshot.payload.parents.map(p=>[p.txid,new tbc.Transaction(p.rawTransaction)]));
    const transactions=[];let totalFee=0;
    for(const raw of engine.raws){
      const tx=new tbc.Transaction(raw);let vmInputs=0;
      for(const [vin,input]of tx.inputs.entries()){
        const parent=history.get(input.prevTxId.toString('hex'));assert.ok(parent);input.output=parent.outputs[input.outputIndex];assert.ok(input.output);
        assert.equal(tx.verifyScript(vin).success,true,`Independent VM input ${vin}`);vmInputs++;
      }
      const bytes=tx.toBuffer().length,fee=tx.inputs.reduce((n,input)=>n+input.output.satoshis,0)-tx.outputs.reduce((n,o)=>n+o.satoshis,0);
      assert.ok(fee>=Math.max(80,Math.ceil(bytes*80/1000)),'Fee floor');totalFee+=fee;
      transactions.push({inputs:tx.inputs.length,outputs:tx.outputs.length,signedBytes:bytes,fee,vmInputs,exactSignedBytesEqual:true});
      history.set(tx.id,tx);
    }
    assert.ok(totalFee<=Number(material.request.constraints.maxFee));
    return {transactions,engineRounds:engine.rounds,engineSignatures:engine.counts};
  }
  async function countSdk(material){
    const originalE=tbc.crypto.ECDSA.sign,originalS=tbc.crypto.Schnorr.sign,counts={compact64:0,schnorr64:0};
    try{
      tbc.crypto.ECDSA.sign=function(...a){counts.compact64++;return originalE.apply(this,a);};
      tbc.crypto.Schnorr.sign=function(...a){counts.schnorr64++;return originalS.apply(this,a);};
      await runSdk(material);
    }finally{tbc.crypto.ECDSA.sign=originalE;tbc.crypto.Schnorr.sign=originalS;}
    return counts;
  }
  async function measure(material){
    const proof=compare(material,runEngine(material),await runSdk(material)),engine=[],sdk=[];
    for(let round=0;round<22;round++){
      const pair={};
      for(const lane of round%2?['sdk','engine']:['engine','sdk'])pair[lane]=await (lane==='engine'?runEngine:runSdk)(material);
      compare(material,pair.engine,pair.sdk);
      if(round>=2){engine.push(pair.engine.times);sdk.push(pair.sdk.times);}
    }
    const summary=rows=>Object.fromEntries(Object.keys(rows[0]).map(k=>{const v=rows.map(r=>r[k]).sort((a,b)=>a-b);return [k,{min:v[0],median:(v[9]+v[10])/2,max:v.at(-1)}];}));
    return {materialSha256:sha(JSON.stringify(material)),proof,engine:summary(engine),sdk:summary(sdk),samples:{engine,sdk}};
  }
  const cases=[];
  for(const [index,row]of [...creates,...actions,...lps].entries()){
    const material=structuredClone(row.input),i=material.request.intent;
    const operation=i.type+(i.direction?`:${i.direction}`:'');stage=`${index+1}/${26} ${operation}`;
    assert.equal(material.request.from,owner);
    const sdkSignatures=await countSdk(material),measured=await measure(material);
    cases.push({index,operation,sdkSignatures,...measured});
    console.log(JSON.stringify({stage,status:'PASS',engineMs:measured.engine.totalMs.median,sdkMs:measured.sdk.totalMs.median,proof:measured.proof,sdkSignatures}));
  }
  const report={status:'PASS',createdAt:new Date().toISOString(),...ctx.identity,cases,
    fixtureWireCount:createWires.length+actionWires.length+lpWires.length,samples:20,warmup:2,order:'alternating sequential, async SDK fully awaited',
    harnessSha256:sha(readFileSync(fileURLToPath(import.meta.url))),supportSha256:sha(readFileSync(join(root,'packages/tbc-engine/scripts/lib/sdk-benchmark-support.mjs'))),
    scope:'Four AMM creates, four actions for each public/controller and plain/locked variant, six LP holder cases. Entire signed bytes match fixed SDK every sample; independent VM once for identical pair bytes outside timings. No HTTP, real assets, Host/UI/IPC or device timing.',
    differences:['Engine includes normalize/plan, synthetic approval binding, four validation stages and external signer. SDK defaults preserved, internally signs and validates.',
      'SDK decodeAndConfig includes immutable Pool configuration reconstruction from supplied genesis; no cached ready instance is compared against a cold Engine request.',
      'Creation full source+genesis is compared, not SDK genesis-only. LP transfer/merge/lock/unlock require no current pool lookup.',
      'Twenty paired local samples do not prove p95 or end-to-end phone performance. No claim of performance change relative to older candidates.',
      'Paused custom fee/Tape changes are not enabled; original fixed SDK lpPlan/fee semantics are retained.']};
  const output=join(ctx.outputRoot,'report.json');writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({status:'AMM_SDK_BENCHMARK_PASS',report:output,sha256:sha(readFileSync(output)),cases:cases.length,fixtureWireCount:report.fixtureWireCount}));
}catch(error){console.error(JSON.stringify({status:'FAIL',stage,error:error.message?.slice(0,700)}));process.exitCode=1;}
