import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {hashCanonical} from '@tbc-wallet/core';
import {REAL_FT_MINT_FIXTURE} from './fixtures/real-ft-mint.mjs';
const base=process.env.TBC_KIT_TEST_ROOT?new URL(`file://${process.env.TBC_KIT_TEST_ROOT}/`):new URL('../',import.meta.url);
const {createDefaultTbcChainDataResolver,createTbcDefaultRawTransactionReviewer,createTbcDefaultAssociatedTransactionReviewer,
  createTbcNetworkContext,createWasmTbcKeylessEngine}=await import(new URL('dist/esm/wallet.js',base));
const {assertTestnetAddress,turingTransactionId,parseTbcTransaction}=await import(new URL('dist/esm/api.js',base));
const tbc=createRequire(import.meta.url)('tbc-lib-js');
const materialNative=await createWasmTbcKeylessEngine(await readFile(new URL('artifacts/wasm/tbc_keyless_wasm.wasm',base)));
const address='1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH',script=assertTestnetAddress(address).scriptPubKey,chainId='tbc:testnet';
const account={accountId:`${chainId}:${address}`,address,chainId,publicKey:'0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'};
const context={origin:'https://reviewer.test',chainId,accountId:account.accountId,sessionId:'batch-status',navigationId:'batch-status'};
const range=n=>Array.from({length:n},(_,i)=>i),key=p=>`${p.txid}:${p.index}`;
function transaction(inputs,outputs){
  const tx=new tbc.Transaction();tx.version=10;
  for(const input of inputs)tx.from(input);
  for(const {satoshis,script:hex}of outputs)tx.addOutput(new tbc.Transaction.Output({satoshis,script:tbc.Script.fromHex(hex)}));
  return tx.uncheckedSerialize();
}
function htlcCode(time=830000){
  const bytes=Buffer.alloc(4);bytes.writeUInt32LE(time);const owner=script.slice(6,46);
  return `63a820${'cc'.repeat(32)}8876a914${owner}6704${bytes.toString('hex')}8152ba816ea0646e040065cd1da263040065cd1da269a1676d7551686700686956ba01247f778104ffffffff9e6976a914${owner}6888ac`;
}
function statusTransport(rows){
  const state={batches:[],active:0,maxActive:0,alter:(_points,result)=>result,failAt:undefined};
  const read=async({txos},options)=>{
    state.batches.push(txos);assert.ok(txos.length<=25,'API accepts at most 25 outputs');
    state.active++;state.maxActive=Math.max(state.maxActive,state.active);
    try{await new Promise(resolve=>setImmediate(resolve));
      if(txos.some(p=>key(p)===state.failAt))throw Error('status unavailable');
      return{txos:state.alter(txos,txos.map(p=>({...rows.get(key(p))})),options)};
    }finally{state.active--;}
  };
  return{state,read};
}
function htlcHarness(count,{retained=false,branch='claim'}={}){
  const code=htlcCode(),raw=transaction([{txId:'ab'.repeat(32),outputIndex:0,script,satoshis:10000000}],
    range(count).map(()=>({satoshis:10000,script:code}))),txid=turingTransactionId(raw);
  const points=range(count).map(vout=>({txid,vout})),rows=new Map(points.map(p=>[`${txid}:${p.vout}`,
    {txid,index:String(p.vout),value:'10000',height:'829999',spent:false,scriptPubKey:code}]));
  const transport=statusTransport(rows),calls={raw:0,tip:0,decoded:0};
  const unexpected=async()=>{throw Error('Unexpected extra data request')};
  const client={api:{txoStatus:async(body,options)=>{assert.deepEqual(options,{category:'asset-index',concurrencyGroup:'htlc-index'});return transport.read(body,options);},
      nodeInfo:async()=>{calls.tip++;return{blocks:'830000',bestblockhash:'bb'.repeat(32),mediantime:'1700000000'};}},
    getUtxos:unexpected,getFtUtxos:unexpected,getStablecoinUtxos:unexpected,getStablecoinInfo:unexpected,
    async getRawTransactionBytes(id){calls.raw++;assert.equal(id,txid);return raw;},
    async getRawTransaction(){calls.decoded++;return unexpected();}};
  const resolver=createDefaultTbcChainDataResolver({accounts:{current:async()=>[account]},client,
    confirmationPolicy:{minConfirmations:'0'},now:()=>Date.parse('2026-10-28T12:00:00Z'),snapshotId:()=> 'htlc-status-batch'});
  if(retained)resolver.rememberFinalizedTransaction({txid,rawTransaction:raw});
  const request={version:'1.0',chainId,accountId:account.accountId,requirement:{intentType:`tbc-htlc-${branch}`,
    includeAncestry:true,inputOutpoints:points,assets:[{kind:'htlc'}]}};
  return{...transport,calls,resolver,request,rows,points};
}
function reviewerHarness(count,{ft=false,associated=false}={}){
  const originRaw=parseTbcTransaction(REAL_FT_MINT_FIXTURE.sourceTxraw),ftRaw=parseTbcTransaction(REAL_FT_MINT_FIXTURE.txraw);
  const hex=o=>Buffer.from(o.scriptPubKey).toString('hex');
  const inputScript=ft?hex(ftRaw.outputs[0]):script,value=ft?500:1000;
  const outputs=range(count).flatMap(()=>ft?[{satoshis:value,script:inputScript},{satoshis:0,script:hex(ftRaw.outputs[1])}]:[{satoshis:value,script}]);
  const parent=transaction([{txId:'ab'.repeat(32),outputIndex:0,script,satoshis:10000000}],outputs),txid=turingTransactionId(parent);
  const points=range(count).map(i=>({txid,index:ft?i*2:i}));
  const rows=new Map(outputs.map((o,index)=>[`${txid}:${index}`,{txid,index:String(index),value:String(o.satoshis),spent:false,scriptPubKey:o.script,height:'1'}]));
  if(ft){const originId=turingTransactionId(REAL_FT_MINT_FIXTURE.sourceTxraw),o=originRaw.outputs[0];
    rows.set(`${originId}:0`,{txid:originId,index:'0',value:o.satoshis.toString(),spent:true,scriptPubKey:hex(o),height:'1'});}
  const transport=statusTransport(rows);
  const options={materialNative,network:createTbcNetworkContext({network:'testnet'}),retryPolicy:{maxAttempts:1},
    async fetch(url,init){assert.equal(new URL(String(url)).pathname,'/api/tbc/txo/status');
      const result=await transport.read(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({code:'200',data:result}),{status:200,headers:{'content-type':'application/json'}});}};
  const inputs=points.map(p=>({txId:p.txid,outputIndex:p.index,script:inputScript,satoshis:value}));
  const raws=ft?inputs.map(input=>transaction([input],[{satoshis:value,script:inputScript},{satoshis:0,script:hex(ftRaw.outputs[1])}])):
    [transaction(inputs,[{satoshis:count*value-100,script}])];
  const request={txraws:raws,utxos_satoshis:ft?inputs.map(()=>[value]):[inputs.map(()=>value)],script_pubkeys:ft?inputs.map(()=>[inputScript]):[inputs.map(()=>inputScript)]};
  const reviewer=associated?createTbcDefaultAssociatedTransactionReviewer(options):createTbcDefaultRawTransactionReviewer(options);
  const associatedRequest={sourceTxraw:raws[0],sourceUtxos:inputs.map(i=>({...i,scriptSigType:'p2pkh'})),
    inputs:[[{outputIndex:0,scriptSigType:'p2pkh'}]],outputs:[[{satoshis:count*value-200,script}]]};
  const run=()=>reviewer.review(associated?{request:associatedRequest,operationDigest:hashCanonical({kind:'signAssociated',request:associatedRequest}),context}:
    {request,transactionIds:raws.map(turingTransactionId),context});
  return{...transport,run,request,points,rows};
}

test('HTLC public resolver splits 25/26/100/101/128 selected outputs and reuses a single direct parent',async()=>{
  for(const branch of ['claim','refund'])for(const count of [1,25,26,100,101,128])for(const retained of [false,true]){
    const h=htlcHarness(count,{branch,retained}),r=await h.resolver.resolve(h.request);
    assert.equal(r.portError,undefined);assert.equal(r.payload.utxos.length,count);assert.equal(r.payload.parents.length,1);
    assert.deepEqual(h.state.batches.flat(),h.points.map(p=>({txid:p.txid,index:p.vout})));
    assert.equal(h.state.batches.length,Math.ceil(count/25));assert.ok(h.state.maxActive<=4);assert.equal(h.state.active,0);
    assert.deepEqual(h.calls,{raw:retained?0:1,decoded:0,tip:branch==='refund'?1:0});
  }
});
test('HTLC rejects malformed batches before parent reads, drains in-flight reads, and keeps 128-input bound',async()=>{
  for(const failure of ['missing','duplicate','cross-batch','spent','failed']){
    const h=htlcHarness(128);
    if(failure==='failed')h.state.failAt=key({txid:h.points[0].txid,index:25});
    else h.state.alter=(points,rows)=>points[0].index!==0?rows:failure==='missing'?rows.slice(1):
      failure==='duplicate'?[rows[0],...rows.slice(0,-1)]:failure==='spent'?rows.map(r=>({...r,spent:true})):
      rows.map((r,i)=>i===0?{...r,index:'25'}:r);
    const result=await h.resolver.resolve(h.request);assert.ok(result.portError);assert.equal(h.calls.raw,0);
    assert.equal(h.state.active,0);assert.equal(h.state.batches.length,4,'never reads next window after failure');
  }
  const h=htlcHarness(129);assert.ok((await h.resolver.resolve(h.request)).portError);assert.equal(h.state.batches.length,0);
});
test('raw reviewer splits unique inputs, preserves exact review, and coalesces concurrent identical reads',async()=>{
  for(const count of [1,25,26,100,101,128]){
    const h=reviewerHarness(count),[a,b]=await Promise.all([h.run(),h.run()]);
    assert.deepEqual(a,b);assert.equal(a.verifiedInputs[0].length,count);
    assert.deepEqual(h.state.batches.flat(),h.points);assert.equal(h.state.batches.length,Math.ceil(count/25));
    assert.ok(h.state.maxActive<=4);assert.equal(h.state.active,0);
  }
});
test('raw FT dependency phase batches tapes plus one shared origin without duplicate primary reads',async()=>{
  const h=reviewerHarness(26,{ft:true}),result=await h.run();
  assert.equal(result.preview.transactions.length,26);assert.equal(result.verifiedInputs.length,26);
  assert.deepEqual(h.state.batches.map(b=>b.length),[25,1,25,2]);
  const keys=h.state.batches.flat().map(key);assert.equal(keys.length,53);assert.equal(new Set(keys).size,53);
  assert.ok(result.preview.transactions.every(t=>t.groups.some(g=>g.asset.type==='ft')));
});
test('associated reviewer reuses local child outputs and only queries the external source inputs',async()=>{
  const h=reviewerHarness(26,{associated:true}),result=await h.run();
  assert.equal(result.preview.transactions.length,2);assert.equal(result.verifiedInputs[1].length,1);
  assert.deepEqual(h.state.batches.map(b=>b.length),[25,1]);assert.deepEqual(h.state.batches.flat(),h.points);
});
test('raw reviewer rejects missing, duplicate, cross-batch and spent primary rows before approval',async()=>{
  for(const failure of ['missing','duplicate','cross-batch','spent','failed']){
    const h=reviewerHarness(128);
    if(failure==='failed')h.state.failAt=key(h.points[25]);
    else h.state.alter=(points,rows)=>points[0].index!==0?rows:failure==='missing'?rows.slice(1):
      failure==='duplicate'?[rows[0],...rows.slice(0,-1)]:failure==='spent'?rows.map(r=>({...r,spent:true})):
      rows.map((r,i)=>i===0?{...r,index:'25'}:r);
    await assert.rejects(h.run());assert.equal(h.state.active,0);
    assert.ok(h.state.batches.length<=Math.ceil(128/25));
  }
});
test('rows swapped between batches are rejected even if the aggregate set would be complete',async()=>{
  for(const make of [()=>htlcHarness(26),()=>reviewerHarness(26)]){
    const h=make();h.state.alter=(_points,rows)=>rows.map(r=>({...r,index:r.index==='0'?'25':r.index==='25'?'0':r.index}));
    if(h.run)await assert.rejects(h.run());else assert.ok((await h.resolver.resolve(h.request)).portError);
    assert.equal(h.state.active,0);
  }
});
test('in-batch row order is not trusted and valid reordered results preserve exact material',async()=>{
  for(const make of [()=>htlcHarness(26),()=>reviewerHarness(26)]){
    const h=make();const before=h.run?await h.run():await h.resolver.resolve(h.request);
    h.state.alter=(_points,rows)=>rows.reverse();
    const after=h.run?await h.run():await h.resolver.resolve(h.request);assert.deepEqual(after,before);
  }
});
test('dependency batch cannot substitute another tape, omit its origin, or duplicate a row',async()=>{
  for(const failure of ['missing','duplicate','swapped']){
    const h=reviewerHarness(26,{ft:true});let phase=0;
    h.state.alter=(points,rows)=>{phase++;if(phase<=2)return rows;
      if(failure==='missing')return rows.slice(1);
      if(failure==='duplicate')return [rows[0],...rows.slice(0,-1)];
      return rows.map(r=>({...r,index:r.index==='1'?'51':r.index==='51'?'1':r.index}));};
    await assert.rejects(h.run());assert.equal(h.state.active,0);assert.equal(h.state.batches.length,4);
  }
});
