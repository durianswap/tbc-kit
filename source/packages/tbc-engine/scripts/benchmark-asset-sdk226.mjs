#!/usr/bin/env node
// Fixed SDK vs installed226 NFT lifecycle and Coin holder paths. Offline,
// fabricated inputs/public test keys; no custody, network or delivery mutation.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {openBenchmark,measurePair,root,sha} from './lib/sdk-benchmark-support.mjs';

assert.equal(process.argv.length,4,'Usage: FIXED_UPSTREAM EXACT226_CONSUMER');
let stage='identity';
try{
  const ctx=await openBenchmark(process.argv[2],process.argv[3]);
  const {tbc,key,owner,capture,loadSdk,runEngine}=ctx;
  stage='fixed NFT and Coin source';
  const NFT=await loadSdk('lib/contract/tbc721.ts');
  const Coin=await loadSdk('lib/contract/coinTbc20.js');
  stage='Native public fixture parity';
  const nftWires=capture('tbc721_public','public_nft_lifecycle_four_phases_and_external_batch_continuation',
    {TBC721_DUMP_WIRE:'1'},'TBC721_WIRE:');
  const coinWires=capture('coin_public','unified_current_coin_signing_matches_concrete',
    {UNIFIED_BUSINESS_DUMP_WIRE:'1'},'UNIFIED_BUSINESS_WIRE:');
  const adminWires=capture('coin_public','coin_explicit_admin_lifecycle_binds_both_roles_and_continuation',
    {COIN_DUMP_WIRE:'1'},'COIN_WIRE:');
  const nftPlans=nftWires.filter(r=>r.method==='plan');assert.equal(nftPlans.length,5);
  const coinPlans=coinWires.filter(r=>r.method==='plan'&&r.input.request.intent.type.startsWith('tbc20Stablecoin.'));assert.equal(coinPlans.length,2);
  const adminPlans=adminWires.filter(r=>r.method==='plan');assert.equal(adminPlans.length,4);
  const adminKey=new tbc.PrivateKey(new tbc.crypto.BN(2));
  const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
  const metadata=v=>({nftName:v.name,symbol:v.symbol,description:v.description,attributes:JSON.stringify(canonical(v.attributes)),
    ...(v.media?{file:JSON.stringify(canonical(v.media))}:{})});
  const ref=u=>({txId:u.txid,outputIndex:u.vout,script:u.scriptPubKey,satoshis:Number(u.satoshis)});
  const decimal=(amount,digits)=>{const s=String(amount).padStart(digits+1,'0');return digits?`${s.slice(0,-digits)}.${s.slice(-digits)}`:s;};
  function runSdk(material){
    const start=performance.now(),s=material.snapshot.payload,i=material.request.intent;
    const parents=new Map(s.parents.map(p=>[p.txid,new tbc.Transaction(p.rawTransaction)]));
    const funding=s.utxos.filter(u=>u.classification==='native').map(ref);
    const decodeEnd=performance.now();let raws;
    if(i.type==='tbc721-standard-create-collection'){
      raws=[NFT.createCollection(owner,key,{collectionName:i.name,description:i.description,supply:Number(i.supply),file:JSON.stringify(canonical(i.media))},funding)];
    }else if(['tbc721-standard-mint','tbc721-standard-batch-mint'].includes(i.type)){
      const items=i.items??[i];
      const slots=items.map(item=>{const u=s.utxos.find(u=>u.classification==='collection-slot'&&u.vout===item.slot);assert.ok(u);return ref(u);});
      raws=i.items?NFT.batchCreateNFT(i.collectionId,owner,key,items.map(metadata),funding,slots).map(r=>r.txraw)
        :[NFT.createNFT(i.collectionId,owner,key,metadata(i),funding,slots[0])];
    }else if(i.type==='tbc721-standard-transfer'){
      const u=s.utxos.find(u=>u.classification==='nft'&&u.vout===0);assert.ok(u);
      const parent=parents.get(u.txid),grandparent=parents.get(parent.inputs[0].prevTxId.toString('hex'));assert.ok(grandparent);
      const nft=new NFT(i.contractId);
      raws=[i.payment?nft.transferNFTWithTBC(owner,i.to,i.payment.to,key,funding,parent,grandparent,decimal(i.payment.amount,6))
        :nft.transferNFT(owner,i.to,key,funding,parent,grandparent)];
    }else if(i.type.startsWith('tbc20-stablecoin-')){
      assert.equal(material.request.signingRoles.length,1);
      const account=s.signingAccounts.find(a=>a.accountId===material.request.signingRoles[0].accountId);
      assert.equal(account.publicKey,adminKey.publicKey.toString());
      const admin=adminKey.publicKey.toXOnly();
      const finish=prepared=>prepared.finalize(prepared.sighashes.map(item=>tbc.crypto.Schnorr.sign(item.sighash,adminKey.toBuffer(),Buffer.alloc(32))));
      assert.equal(funding.length,1);
      if(i.type==='tbc20-stablecoin-create'){
        const coin=new Coin({name:i.name,symbol:i.symbol,decimal:i.decimals,amount:decimal(i.initialSupply,i.decimals)});
        raws=finish(coin.createCoin(admin,key,i.to??owner,funding[0],parents.get(funding[0].txId),i.message));
      }else{
        const certificate=[...parents.values()].find(tx=>{
          try{return JSON.parse(tx.outputs[2].script.chunks[2].buf.toString()).coinDecimal!==undefined;}catch{return false;}
        });assert.ok(certificate,'Pinned Coin certificate');
        const info=JSON.parse(certificate.outputs[2].script.chunks[2].buf.toString());
        const targets=(i.targetOutpoints??[]).map(p=>s.utxos.find(u=>u.txid===p.txid&&u.vout===p.vout));
        const holder=targets[0];
        const minted=[...parents.values()].find(tx=>tx.outputs.length>=6&&tx.outputs[3].satoshis===500&&tx.outputs[4].satoshis===0);
        const tokenParent=holder?parents.get(holder.txid):minted,codeVout=holder?holder.vout:3;assert.ok(tokenParent);
        const coin=new Coin({name:'Offline Coin',symbol:'OFF',decimal:info.coinDecimal,amount:'1'});
        coin.initialize({name:'Offline Coin',symbol:'OFF',decimal:info.coinDecimal,totalSupply:BigInt(info.coinTotalSupply),contractTxid:i.contractId,
          codeScript:tokenParent.outputs[codeVout].script.toHex(),tapeScript:tokenParent.outputs[codeVout+1].script.toHex()});
        let prepared;
        if(i.type==='tbc20-stablecoin-mint'){
          const parent=parents.get(i.certificateOutpoint.txid),grandparent=parents.get(parent.inputs[0].prevTxId.toString('hex'));assert.ok(grandparent);
          prepared=coin.mintCoin(admin,key,i.to,decimal(i.amount,info.coinDecimal),funding[0],parent,grandparent,i.message);
        }else{
          const utxos=targets.map(u=>Coin.buildUTXO(parents.get(u.txid),u.vout)),previous=targets.map(u=>parents.get(u.txid)),proofs=[...parents.values()];
          prepared=i.type==='tbc20-stablecoin-freeze'?coin.freezeCoinUTXO(admin,key,Number(i.lockTime),utxos,funding[0],previous,proofs)
            :coin.unfreezeCoinUTXO(admin,key,utxos,funding[0],previous,proofs);
        }
        raws=[finish(prepared)];
      }
    }else{
      const coins=s.utxos.filter(u=>u.classification==='stablecoin');assert.ok(coins.length);
      const parentList=coins.map(u=>parents.get(u.txid)),first=parentList[0];
      // The pinned public fixture is Offline Coin/OFF with decimal0, supply1000.
      // initialize validates actual Code/Tape identity; no synthetic creation is
      // hidden inside this holder benchmark.
      const coin=new Coin({name:'Offline Coin',symbol:'OFF',decimal:0,amount:'1000'});
      coin.initialize({name:'Offline Coin',symbol:'OFF',decimal:0,totalSupply:1000n,contractTxid:i.contractId,
        codeScript:first.outputs[coins[0].vout].script.toHex(),tapeScript:first.outputs[coins[0].vout+1].script.toHex()});
      const utxos=coins.map(u=>Coin.buildUTXO(parents.get(u.txid),u.vout)),proofs=[...parents.values()];
      assert.equal(funding.length,1);
      raws=i.type==='tbc20Stablecoin.transfer'?[coin.transfer(key,i.to,i.amount,utxos,funding[0],parentList,proofs)]
        :coin.mergeCoin(key,utxos,funding[0],parentList,proofs).map(r=>r.txraw);
    }
    const end=performance.now();return {raws,times:{inputDecodeMs:decodeEnd-start,buildAndSignMs:end-decodeEnd,totalMs:end-start}};
  }
  const nativeScript=tbc.Script.buildPublicKeyHashOut(owner).toHex();
  function compare(material,engine,sdk){
    assert.equal(engine.raws.length,sdk.raws.length,'Transaction count');
    const parentMaps=[engine,sdk].map(()=>new Map(material.snapshot.payload.parents.map(p=>[p.txid,new tbc.Transaction(p.rawTransaction)])));
    const logicalMaps=[new Map(),new Map()],transactions=[];
    for(let index=0;index<engine.raws.length;index++){
      const pair=[new tbc.Transaction(engine.raws[index]),new tbc.Transaction(sdk.raws[index])];
      const inputs=pair.map((tx,lane)=>tx.inputs.map(input=>({txid:logicalMaps[lane].get(input.prevTxId.toString('hex'))??input.prevTxId.toString('hex'),vout:input.outputIndex})));
      assert.deepEqual(inputs[0],inputs[1],'External inputs and parent-child dependency topology must match');
      assert.equal(pair[0].version,pair[1].version);assert.equal(pair[0].nLockTime,pair[1].nLockTime);
      assert.deepEqual(pair[0].inputs.map(i=>i.sequenceNumber),pair[1].inputs.map(i=>i.sequenceNumber));
      const outputs=pair.map(tx=>tx.outputs.map(o=>({value:o.satoshis,script:o.script.toHex()})));
      // The only allowed output difference is the final P2PKH fee change.
      // The SDK's provisional DER reservations can differ from keyless bounds.
      for(const out of outputs)assert.equal(out.at(-1).script,nativeScript);
      assert.deepEqual(outputs[0].slice(0,-1),outputs[1].slice(0,-1),'All business outputs must match');
      const fees=[],sizes=[];let vmInputs=0;
      for(const [lane,tx]of pair.entries()){
        for(const [vin,input]of tx.inputs.entries()){
          const parent=parentMaps[lane].get(input.prevTxId.toString('hex'));assert.ok(parent,'Required parent');
          input.output=parent.outputs[input.outputIndex];assert.ok(input.output);
          const result=tx.verifyScript(vin);assert.equal(result.success,true,`Independent VM transaction ${index} input ${vin}`);vmInputs++;
        }
        const fee=tx.inputs.reduce((n,i)=>n+i.output.satoshis,0)-tx.outputs.reduce((n,o)=>n+o.satoshis,0),size=tx.toBuffer().length;
        assert.ok(fee>=Math.max(80,Math.ceil(size*80/1000)),'Actual size fee lower bound');
        assert.ok(fee<=Number(material.request.constraints.maxFee),'Request fee cap');
        fees.push(fee);sizes.push(size);parentMaps[lane].set(tx.id,tx);logicalMaps[lane].set(tx.id,`earlier-transaction-${index}`);
      }
      transactions.push({inputCount:pair[0].inputs.length,outputCount:pair[0].outputs.length,fees,signedBytes:sizes,vmInputs,
        exactSignedBytesEqual:engine.raws[index]===sdk.raws[index],businessOutputsEqual:true,dependencyTopologyEqual:true});
    }
    const totalFees=transactions.reduce((n,t)=>n+t.fees[0],0);assert.ok(totalFees<=Number(material.request.constraints.maxFee));
    return {transactions,engineRounds:engine.rounds,engineSignatures:engine.counts};
  }
  function countSdk(material){
    const originalE=tbc.crypto.ECDSA.sign,originalS=tbc.crypto.Schnorr.sign,counts={compact64:0,schnorr64:0};
    try{
      tbc.crypto.ECDSA.sign=function(...args){counts.compact64++;return originalE.apply(this,args);};
      tbc.crypto.Schnorr.sign=function(...args){counts.schnorr64++;return originalS.apply(this,args);};
      runSdk(material);
    }finally{tbc.crypto.ECDSA.sign=originalE;tbc.crypto.Schnorr.sign=originalS;}
    return counts;
  }
  const cases=[];
  for(const row of [...nftPlans,...coinPlans,...adminPlans]){
    const material=structuredClone(row.input),operation=material.request.intent.type+(material.request.intent.payment?':payment':'');
    if(operation.startsWith('tbc20Stablecoin.'))material.request.constraints.inputOutpoints=material.snapshot.payload.utxos.map(u=>({txid:u.txid,vout:u.vout}));
    assert.equal(material.request.from,owner);stage=operation;
    const counts=countSdk(material);
    const measured=await measurePair(material,runEngine,runSdk,(a,b)=>compare(material,a,b));
    cases.push({operation,sdkSignatures:counts,...measured});
    console.log(JSON.stringify({operation,status:'PASS',engineMs:measured.engine.totalMs.median,sdkMs:measured.sdk.totalMs.median,
      engineSignatures:measured.proof.engineSignatures,sdkSignatures:counts,transactions:measured.proof.transactions}));
  }
  const report={status:'PASS',createdAt:new Date().toISOString(),...ctx.identity,fixtureWireCount:nftWires.length+coinWires.length+adminWires.length,
    samples:20,warmup:2,order:'alternating sequential',cases,
    harnessSha256:sha(readFileSync(fileURLToPath(import.meta.url))),supportSha256:sha(readFileSync(join(root,'packages/tbc-engine/scripts/lib/sdk-benchmark-support.mjs'))),
    scope:'Five NFT lifecycle cases, two Coin holder cases, four independent-admin Coin lifecycle cases. No HTTP/POST, real custody, Host/IPC/UI or device measurements. Engine four validation phases included; independent VM outside timing. SDK defaults unchanged.',
    differences:['Engine is keyless, includes four approval/policy/material validation phases and external signer. SDK internally signs, with provisional callbacks in NFT.',
      'NFT fee reservations can change native change and dependent txids; all business outputs and normalized parent-child input dependencies checked.',
      'Coin SDK signatures may use random Schnorr aux; byte equality is informative, not required. Independent scripts must pass each sample.',
      'Twenty local samples per path do not establish reliable p95. AMM/LP/special contracts and cooperative MuSig performance not proven by this report.']};
  const output=join(ctx.outputRoot,'report.json');writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({status:'ASSET_SDK_BENCHMARK_PASS',report:output,sha256:sha(readFileSync(output)),cases:cases.length,fixtureWireCount:report.fixtureWireCount}));
}catch(error){console.error(JSON.stringify({status:'FAIL',stage,error:error.message?.slice(0,600)}));process.exitCode=1;}
