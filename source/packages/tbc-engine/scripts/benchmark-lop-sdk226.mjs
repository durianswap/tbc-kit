#!/usr/bin/env node
// Offline, public synthetic scalars only. No wallet keys, HTTP or broadcast.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {join,resolve,relative} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {runInThisContext} from 'node:vm';
import {performance} from 'node:perf_hooks';
import {build} from 'esbuild';
import {openBenchmark,root,sha,commit,measurePair} from './lib/sdk-benchmark-support.mjs';

assert.equal(process.argv.length,4,'Usage: FIXED_UPSTREAM EXACT226_CONSUMER');
let stage='identity';
try{
  const ctx=await openBenchmark(process.argv[2],process.argv[3]);
  const {tbc,capture,call}=ctx,upstream=resolve(process.argv[2]);
  const {hashCanonical}=await import(pathToFileURL(join(resolve(process.argv[3]),'node_modules/@tbc/kit/dist/esm/wallet.js')));
  const keys=[1,2,4].map(n=>new tbc.PrivateKey(new tbc.crypto.BN(n)));
  const deps=createRequire(join(root,'packages/kit/package.json'));
  function pinned(path){
    const bytes=readFileSync(join(upstream,path));
    assert.deepEqual(bytes,execFileSync('git',['-C',upstream,'show',`${commit}:${path}`],{maxBuffer:8*1024*1024}));
    ctx.identity.sdkSourceHashes[path]=sha(bytes);return bytes.toString();
  }
  // Same exact-source extraction as the independent LOP oracle. Only online
  // convenience wrappers are omitted; pure builders/fillers/matchers are intact.
  const source=pinned('lib/contract/orderBook.ts');
  function section(start,end){const a=source.indexOf(start),b=source.indexOf(end,a+start.length);assert.ok(a>=0&&b>a);return source.slice(a,b);}
  const constants=section('const token_order_prefix_length','class OrderBook {');
  const fields=section('class OrderBook {','\n  buildSellOrderTX(');
  const native=section('\n  buildSellOrderTX(','\n  async makeSellOrder_privateKeyOnline(');
  const tokens=section('\n  private getTokenPartialHash(','\n  async makeTokenSellOrder_privateKeyOnline(');
  const codec=section('\n  getOrderUnlock(','\n  static placeHolderP2PKHOutput(');
  const placeholder=section('\n  static placeHolderP2PKHOutput(','\n  // makeSellOrder_privateKey(');
  const numeric=section('\nfunction _isPositiveBigInt(','\nmodule.exports =');
  const compiled=await build({stdin:{contents:`import * as tbc from 'tbc-lib-js';
import {ContractToken as FT,tokenKind,isTokenProof,getFTPartialOffset,getFTVersion,isCoinCodeScript,modernCodeOffsets} from './lib/util/common/contractToken.js';
import {getPreTxdata,getCurrentTxOutputsData} from './lib/util/orderbook/orderbookunlock.js';
import {CoinTBC20} from './lib/util/coin/coinTbc20Code.js';
import {_isValidHexString,_isValidSHA256Hash,getFtBalanceFromTape} from './lib/util/common/util.js';
const BN=tbc.crypto.BN,partial_sha256=require('tbc-lib-js/lib/util/partial-sha256');
const stableCoin={getLockTimeFromTape(){throw Error('Legacy Coin outside oracle scope');}};
${constants}\n${numeric}\n${fields}\n${native}\n${tokens}\n${codec}\n${placeholder}\n}\nexport {OrderBook,getFtBalanceFromTape};`,loader:'ts',resolveDir:upstream},
    bundle:true,write:false,metafile:true,platform:'node',format:'cjs',target:'node22',
    external:['tbc-lib-js','tbc-lib-js/*','node:crypto'],resolveExtensions:['.js','.json'],logLevel:'silent'});
  for(const file of Object.keys(compiled.metafile.inputs)){
    if(file==='<stdin>')continue;const rel=relative(upstream,resolve(file));assert.ok(!rel.startsWith('..'));pinned(rel);
  }
  const module={exports:{}};
  runInThisContext(`(function(module,exports,require){${compiled.outputFiles[0].text}\n})`)(module,module.exports,name=>{
    assert.ok(name==='tbc-lib-js'||name.startsWith('tbc-lib-js/')||name==='node:crypto');return deps(name);
  });
  const {OrderBook,getFtBalanceFromTape}=module.exports;
  stage='Native/WASM fixtures';
  const all=[],cases=[];
  function collect(filter,metadata){
    const wires=capture('lop_public',filter,{LOP_PUBLIC_DUMP_WIRE:'1'},'LOP_PUBLIC_WIRE:');all.push(...wires);
    const plans=wires.filter(r=>r.method==='plan');assert.equal(plans.length,metadata.length);
    plans.forEach((row,index)=>cases.push({...metadata[index],material:row.input}));
  }
  const creates=[];
  for(const pair of [false,true])for(const buy of [false,true])for(const coinFirst of [false,true])creates.push({operation:'create',pair,buy,coinFirst});
  collect('public_lop_create_uses_shared_bound_signer_and_finalize',creates);
  collect('public_lop_cancel_uses_shared_bound_signer_and_finalize',[
    [false,false,false],[false,true,false],[false,true,true],[true,false,false],[true,false,true],[true,true,false],[true,true,true]
  ].map(([pair,buy,coin])=>({operation:'cancel',pair,buy,coin})));
  const matches=[];
  for(const pair of [false,true])for(const quoteCoin of [false,true])for(const [buyVolume,sellVolume]of [[100,100],[200,100],[100,200]])matches.push({operation:'match',pair,quoteCoin,buyVolume,sellVolume});
  collect('public_lop_match_uses_shared_bound_signer_and_finalize',matches);assert.equal(cases.length,27);
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
  function runSdk(material,meta){
    const start=performance.now(),s=material.snapshot.payload,i=material.request.intent;
    assert.equal(i.type,`tbc-lop-${meta.operation}`);
    const signer=keys.find(k=>k.toAddress().toString()===material.request.from);assert.ok(signer);
    const owner=signer.toAddress().toString(),pub=signer.publicKey.toString(),sdk=new OrderBook();
    const history=new Map(s.parents.map(p=>[p.txid,new tbc.Transaction(p.rawTransaction)]));
    const resolver=id=>{assert.ok(history.has(id));return history.get(id);};
    const ref=u=>({txId:u.txid,outputIndex:u.vout,script:u.scriptPubKey,satoshis:Number(u.satoshis)});
    const tokenRef=u=>({...ref(u),ftBalance:getFtBalanceFromTape(resolver(u.txid).outputs[u.vout+1].script.toHex())});
    const funding=s.utxos.filter(u=>u.classification==='native');assert.equal(funding.length,1);
    const fee=ref(funding[0]),tax=tbc.Address.fromHex('00'+'03'.repeat(20)).toString();
    const decodeEnd=performance.now();let raw,fill;
    const log=console.log;console.log=()=>{};
    try{
      if(meta.operation==='create'){
        const o=i.order;assert.equal(o.market,meta.pair?'token-token':'native-token');assert.equal(o.side,meta.buy?'buy':'sell');assert.equal(o.feeRecipient,tax);
        const asset=a=>{const u=s.utxos.find(u=>u.contractId===a.contractId);assert.ok(u);return u;};
        const a=asset(o.assetA),b=meta.pair?asset(o.assetB):null;
        const volume=BigInt(o.saleVolume),price=BigInt(o.unitPrice),rate=BigInt(o.feeRate);
        if(!meta.pair&&!meta.buy){
          raw=sdk.buildSellOrderTX(owner,tax,volume,price,rate,o.assetA.contractId,a.scriptPubKey,[fee]);
          fill=sigs=>sdk.fillSigsSellOrder(raw,sigs,pub,'make');
        }else{
          const selected=meta.pair&&meta.buy?b:a,parent=resolver(selected.txid);
          if(meta.pair)raw=sdk[meta.buy?'buildTokenBuyOrderTX':'buildTokenSellOrderTX'](owner,tax,volume,price,rate,o.assetA.contractId,o.assetB.contractId,a.scriptPubKey,b.scriptPubKey,[fee],[tokenRef(selected)],[parent]);
          else raw=sdk.buildBuyOrderTX(owner,tax,volume,price,rate,o.assetA.contractId,[fee],[tokenRef(selected)],[parent]);
          fill=sigs=>sdk[meta.pair?(meta.buy?'fillSigsMakeTokenBuyOrder':'fillSigsMakeTokenSellOrder'):'fillSigsMakeBuyOrder'](raw,sigs,pub,[parent],[resolver]);
        }
      }else{
        const orders=i.targetOutpoints.map(p=>{const u=s.utxos.find(u=>u.txid===p.txid&&u.vout===p.vout);assert.ok(u&&u.classification==='lop');return ref(u);});
        const escrow=order=>{const u=s.utxos.find(u=>u.txid===order.txId&&u.vout===order.outputIndex+1);assert.ok(u);return tokenRef(u);};
        if(meta.operation==='cancel'){
          assert.equal(orders.length,1);const order=orders[0],parent=resolver(order.txId);
          const parsed=OrderBook[meta.pair?'getTokenOrderData':'getOrderData'](order.script);assert.equal(parsed.holdAddress,owner);
          if(!meta.pair&&!meta.buy){
            raw=sdk.buildCancelSellOrderTX(order,[fee]);fill=sigs=>sdk.fillSigsSellOrder(raw,sigs,pub,'cancel');
          }else{
            raw=sdk[meta.pair?(meta.buy?'buildCancelTokenBuyOrderTX':'buildCancelTokenSellOrderTX'):'buildCancelBuyOrderTX'](order,escrow(order),parent,[fee]);
            fill=sigs=>sdk[meta.pair?(meta.buy?'fillSigsCancelTokenBuyOrder':'fillSigsCancelTokenSellOrder'):'fillSigsCancelBuyOrder'](raw,sigs,pub,parent,parent,resolver);
          }
        }else{
          assert.equal(orders.length,2);const [buy,sell]=orders,bp=resolver(buy.txId),sp=resolver(sell.txId);
          const parser=meta.pair?'getTokenOrderData':'getOrderData';
          assert.equal(OrderBook[parser](buy.script).saleVolume,BigInt(meta.buyVolume));assert.equal(OrderBook[parser](sell.script).saleVolume,BigInt(meta.sellVolume));
          raw=meta.pair?sdk.matchTokenOrder(signer,buy,bp,escrow(buy),bp,resolver,sell,sp,escrow(sell),sp,resolver,[fee],tax,tax)
            :sdk.matchOrder(signer,buy,bp,escrow(buy),bp,resolver,sell,sp,[fee],tax,tax);
        }
      }
      if(fill){
        const tx=new tbc.Transaction(raw);
        tx.inputs.forEach(input=>{const u=s.utxos.find(u=>u.txid===input.prevTxId.toString('hex')&&u.vout===input.outputIndex);assert.ok(u);
          input.output=new tbc.Transaction.Output({satoshis:Number(u.satoshis),script:tbc.Script.fromHex(u.scriptPubKey)});});
        raw=fill(tx.inputs.map((_,vin)=>tx.getSignature(vin,signer)));
      }
    }finally{console.log=log;}
    assert.equal(typeof raw,'string');const end=performance.now();
    return {raws:[raw],times:{decodeMs:decodeEnd-start,buildAndSignMs:end-decodeEnd,totalMs:end-start}};
  }
  function compare(material,e,s){
    assert.equal(e.raws.length,1);assert.equal(s.raws.length,1);
    const pair=[e,s].map(v=>new tbc.Transaction(v.raws[0]));
    assert.equal(pair[0].version,pair[1].version);assert.equal(pair[0].nLockTime,pair[1].nLockTime);
    const inputs=pair.map(tx=>tx.inputs.map(i=>({id:i.prevTxId.toString('hex'),vout:i.outputIndex,sequence:i.sequenceNumber})));
    assert.deepEqual(inputs[0],inputs[1],'Input topology');
    const outputs=pair.map(tx=>tx.outputs.map(o=>({value:o.satoshis,script:o.script.toHex()})));
    assert.deepEqual(outputs[0].map(o=>o.script),outputs[1].map(o=>o.script),'Every output script');
    const own=tbc.Script.buildPublicKeyHashOut(material.request.from).toHex();
    // In partial matches, an order continuation follows funding change.
    // Locate the last exact payer P2PKH, never blindly exempt the last output.
    const change=outputs[0].findLastIndex(o=>o.script===own);assert.ok(change>=0);
    assert.deepEqual(outputs[0].filter((_,i)=>i!==change),outputs[1].filter((_,i)=>i!==change),'All business and continuation outputs');
    const fees=[],sizes=[];let vmInputs=0;
    for(const tx of pair){
      for(const [vin,input]of tx.inputs.entries()){
        const u=material.snapshot.payload.utxos.find(u=>u.txid===input.prevTxId.toString('hex')&&u.vout===input.outputIndex);assert.ok(u);
        input.output=new tbc.Transaction.Output({satoshis:Number(u.satoshis),script:tbc.Script.fromHex(u.scriptPubKey)});
        assert.equal(tx.verifyScript(vin).success,true,`Independent VM input ${vin}`);vmInputs++;
      }
      const fee=tx.inputs.reduce((n,i)=>n+i.output.satoshis,0)-tx.outputs.reduce((n,o)=>n+o.satoshis,0),bytes=tx.toBuffer().length;
      assert.ok(fee>=Math.max(80,Math.ceil(bytes*80/1000)),'Minimum serialized fee');assert.ok(fee<=Number(material.request.constraints.maxFee),'Approved maxFee');fees.push(fee);sizes.push(bytes);
    }
    return {inputs:pair[0].inputs.length,outputs:pair[0].outputs.length,changeOutput:change,fees,signedBytes:sizes,vmInputs,exactSignedBytesEqual:e.raws[0]===s.raws[0],engineRounds:e.rounds,engineSignatures:e.counts};
  }
  const results=[];
  for(const [index,item]of cases.entries()){
    const {material,...meta}=item;stage=`${index+1}/27 ${JSON.stringify(meta)}`;
    const old=tbc.crypto.ECDSA.sign;let signatures=0;
    try{tbc.crypto.ECDSA.sign=function(...a){signatures++;return old.apply(this,a);};runSdk(material,meta);}finally{tbc.crypto.ECDSA.sign=old;}
    const measured=await measurePair(material,runEngine,m=>runSdk(m,meta),(e,s)=>compare(material,e,s));
    results.push({...meta,sdkSignatures:{compact64:signatures,schnorr64:0},...measured});
    console.log(JSON.stringify({stage,status:'PASS',engineMs:measured.engine.totalMs.median,sdkMs:measured.sdk.totalMs.median,proof:measured.proof,sdkSignatures:signatures}));
  }
  const report={status:'PASS',createdAt:new Date().toISOString(),...ctx.identity,fixtureWireCount:all.length,cases:results,samples:20,warmup:2,order:'alternating sequential',
    harnessSha256:sha(readFileSync(fileURLToPath(import.meta.url))),supportSha256:sha(readFileSync(join(root,'packages/tbc-engine/scripts/lib/sdk-benchmark-support.mjs'))),
    scope:'Eight creates, seven cancellations, twelve full/partial matches with native-token/token-token and TBC20/Coin roles. Synthetic mainnet-labelled materials, no network, funds, Host/UI/IPC or device timings.',
    differences:['Engine includes normalization, binding and four validation phases; SDK pure builders/fillers or matcher retain fixed-source computation.',
      'SDK orderBook exact pure sections and every transitive source are pinned. Online API wrappers omitted; historical stableCoin helper explicitly unavailable, current Coin paths retained.',
      'Only native payer change may differ. All other outputs, including partial-order continuations, must match. Both lanes independently VM-checked; serialized minimum and approved maximum fees enforced.',
      'Public scalars1/2/4 used only outside Engine. Actual fixture account/approval binding retained; no raw or private keys in report.',
      'Twenty local samples do not prove p95, phone E2E, production throughput or an advantage over SDK. Cooperative MuSig timings not included.']};
  const output=join(ctx.outputRoot,'report.json');writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({status:'LOP_SDK_BENCHMARK_PASS',report:output,sha256:sha(readFileSync(output)),cases:results.length,fixtureWireCount:all.length}));
}catch(error){console.error(JSON.stringify({status:'FAIL',stage,reason:error.code??error.name,location:error.stack?.split('\n').find(l=>l.includes('benchmark-lop-sdk226.mjs:'))?.trim()}));process.exitCode=1;}
