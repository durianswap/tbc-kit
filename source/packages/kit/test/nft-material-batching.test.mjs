import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
const base = process.env.TBC_KIT_TEST_ROOT ? new URL(`file://${process.env.TBC_KIT_TEST_ROOT}/`) : new URL('../', import.meta.url);
const {createDefaultTbcChainDataResolver} = await import(new URL('dist/esm/wallet.js', base));
const {assertTestnetAddress, createTbcOfficialApi, turingTransactionId, inspectTbcTransaction} = await import(new URL('dist/esm/api.js', base));
const {createTbcEngine, createWasmTbcEngineBackend} = await import(new URL('dist/esm/engine.js', base));
const tbc = createRequire(import.meta.url)('tbc-lib-js');
const address='1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH', script=assertTestnetAddress(address).scriptPubKey;
const slotScript=script+'6a0d5630204d696e74204e486f6c64', chainId='tbc:testnet';
const account={accountId:`${chainId}:${address}`,address,chainId,publicKey:'0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'};
const now=Date.parse('2026-10-27T12:00:00Z');
const range=(length,start=1)=>Array.from({length},(_,i)=>i+start);
function rawWithOutputs(outputs) {
  const tx=new tbc.Transaction().from({txId:'ab'.repeat(32),outputIndex:0,script,satoshis:10000000});tx.version=10;
  for(const output of outputs)tx.addOutput(new tbc.Transaction.Output(output));
  return tx.uncheckedSerialize();
}
function harness(supply=101,{retained=true,minimum='0'}={}) {
  const raw=rawWithOutputs([{satoshis:0,script:tbc.Script.buildSafeDataOut([
    Buffer.from(JSON.stringify({collectionName:'Batch fixture',description:'public synthetic',supply,file:''})),Buffer.from('NTape')])},
    ...range(supply).map(()=>({satoshis:100,script:tbc.Script.fromHex(slotScript)}))]);
  const collectionId=turingTransactionId(raw), funding=rawWithOutputs([{satoshis:9000000,script:tbc.Script.fromHex(script)}]),fundingId=turingTransactionId(funding);
  const calls={index:0,native:0,raw:0,decoded:0,status:0}, batches=[],rawIds=[];
  const row=(index,spent=false)=>({txid:collectionId,index:String(index),value:'100',spent,scriptPubKey:slotScript});
  const state={indexed:[], nativeCount:1, alter:(_batch,rows)=>rows,failAt:undefined,active:0,maxActive:0};
  const unused=async()=>{throw Error('Unexpected extra data request')};
  const client={
    api:{poolInfo:unused,ftUtxosByCombineScript:unused,poolLpUtxosByScriptHash:unused,
      async utxosByScriptHash(){calls.index++;return{utxos:state.indexed.map(n=>row(n))}},
      async txoStatus({txos}){calls.status++;batches.push(txos);assert.ok(txos.length<=25,'API accepts at most 25 outputs');
        state.active++;state.maxActive=Math.max(state.maxActive,state.active);
        try {await new Promise(resolve=>setImmediate(resolve));if(txos[0].index===state.failAt)throw Error('status offline');
          return{txos:state.alter(txos,txos.map(p=>row(p.index)))};
        }finally{state.active--;}
      }},
    getFtUtxos:unused,getStablecoinUtxos:unused,getStablecoinInfo:unused,
    async getUtxos(){calls.native++;return{tip:{height:'1000',hash:'aa'.repeat(32)},utxos:Array.from({length:state.nativeCount},(_,i)=>({txid:i===0?fundingId:i.toString(16).padStart(64,'0'),vout:0,satoshis:'9000000',height:minimum==='0'?'0':'990'}))}},
    async getRawTransactionBytes(id){calls.raw++;rawIds.push(id);assert.ok([collectionId,fundingId].includes(id));return id===collectionId?raw:funding},
    async getRawTransaction(id){calls.decoded++;assert.equal(id,collectionId);const parsed=inspectTbcTransaction(raw).transaction;
      return{txid:id,rawTransaction:raw,confirmations:'12',inputs:parsed.inputs,outputs:parsed.outputs.map((o,vout)=>({vout,satoshis:o.satoshis.toString(),scriptPubKey:Buffer.from(o.scriptPubKey).toString('hex')}))}},
  };
  const resolver=createDefaultTbcChainDataResolver({accounts:{current:async()=>[account]},client,
    confirmationPolicy:{minConfirmations:minimum},now:()=>now,snapshotId:()=> 'slot-batch-fixture'});
  resolver.rememberFinalizedTransaction({txid:fundingId,rawTransaction:funding});
  if(retained)resolver.rememberFinalizedTransaction({txid:collectionId,rawTransaction:raw});
  const request=(slots,standard=true)=>({version:'1.0',chainId,accountId:account.accountId,requirement:{
    intentType:standard?'tbc721-standard-batch-mint':'tbc.nft.mint',contractIds:[collectionId],includeAncestry:true,
    ...(standard?{collectionSlots:slots}:{}),assets:[{kind:'native'},{kind:'collection',contractId:collectionId,minimumAmount:standard?String(slots.length):'1'}]}});
  return{raw,collectionId,funding,fundingId,calls,batches,rawIds,row,state,client,resolver,request};
}
const slotsFrom=result=>result.payload.utxos.filter(u=>u.classification==='collection-slot').map(u=>u.vout);

test('NFT fee alternatives do not consume the mint-slot budget; exact inputs and candidate bounds remain strict',async()=>{
  for(const count of [122,128,256]) {
    const h=harness(100);h.state.nativeCount=count;h.state.indexed=range(100);
    const result=await h.resolver.resolve(h.request(range(100)));
    assert.equal(result.portError,undefined,`native alternatives ${count}`);
    assert.deepEqual(slotsFrom(result),range(100));
    assert.equal(result.payload.utxos.length,count+100);
    assert.deepEqual(h.calls,{index:1,native:1,raw:0,decoded:0,status:0});
  }
  const h=harness(100);h.state.nativeCount=257;h.state.indexed=range(100);
  assert.ok((await h.resolver.resolve(h.request(range(100)))).portError,'candidate bound remains');
  h.state.nativeCount=122;
  const exact=h.request(range(100));exact.requirement.inputOutpoints=[{txid:h.fundingId,vout:0},...range(100).map(vout=>({txid:h.collectionId,vout}))];
  const result=await h.resolver.resolve(exact);assert.equal(result.portError,undefined);
  assert.equal(result.payload.utxos.filter(u=>u.classification==='native').length,1);
  exact.requirement.inputOutpoints.push(...range(28).map(i=>({txid:i.toString(16).padStart(64,'0'),vout:0})));
  assert.ok((await h.resolver.resolve(exact)).portError,'129 exact inputs must not be silently truncated');
});

test('public resolver splits exact new-NFT missing slots at 25/26/100 without substituting slots',async()=>{
  for(const count of [25,26,100]){
    const h=harness(125),selected=range(count,2),result=await h.resolver.resolve(h.request(selected));
    assert.equal(result.portError,undefined);assert.deepEqual(slotsFrom(result),selected);
    assert.deepEqual(h.batches.flat().map(p=>p.index),selected);assert.equal(h.calls.status,Math.ceil(count/25));
    assert.deepEqual(h.calls,{index:1,native:1,raw:0,decoded:0,status:Math.ceil(count/25)});
    assert.equal(h.state.active,0);assert.ok(h.state.maxActive<=4);
  }
});

test('indexed and partial-index paths reuse retained bytes and never requery known slots',async()=>{
  const h=harness(100);h.state.indexed=range(100);
  const all=await h.resolver.resolve(h.request(range(100)));assert.equal(all.portError,undefined);assert.equal(h.calls.status,0);
  h.state.indexed=range(74);
  const partial=await h.resolver.resolve(h.request(range(100)));assert.equal(partial.portError,undefined);
  assert.deepEqual(h.batches.map(b=>b.length),[25,1]);assert.deepEqual(h.batches.flat().map(p=>p.index),range(26,75));
  assert.equal(h.calls.raw,0);assert.equal(h.calls.decoded,0);
});

test('historical NFT slot selection batches 26/101/4095 outputs and still chooses the first unspent slot',async()=>{
  for(const count of [26,101,4095]){
    const h=harness(count);h.state.alter=(_b,rows)=>rows.map(r=>({...r,spent:Number(r.index)<26}));
    const result=await h.resolver.resolve(h.request([],false));assert.equal(result.portError,undefined);
    assert.deepEqual(slotsFrom(result),[26]);assert.equal(h.calls.status,Math.ceil(count/25));
    assert.deepEqual(h.batches.flat().map(p=>p.index),range(count));assert.ok(h.state.maxActive<=4);
    assert.equal(h.calls.raw,0);assert.equal(h.calls.decoded,0);
  }
});

test('failures, missing rows and spent selected slots stop before a usable snapshot without retry',async()=>{
  for(const standard of [true,false])for(const fail of ['offline','missing','spent','invalid-spent']){
    const h=harness(100);
    if(fail==='offline')h.state.failAt=26;
    else h.state.alter=(batch,rows)=>batch[0].index===26?(fail==='missing'?rows.slice(1):rows.map(r=>({...r,spent:fail==='spent'?true:'false'}))):rows;
    if(!standard&&fail==='spent')h.state.alter=(_b,rows)=>rows.map(r=>({...r,spent:true}));
    const result=await h.resolver.resolve(h.request(range(100),standard));
    assert.ok(result.portError,`${standard}/${fail}`);assert.equal(result.snapshotHash,undefined);
    if(standard&&fail==='spent')assert.equal(result.portError.details.reason,'NFT_SLOT_SPENT');
    if(!standard&&fail==='spent')assert.equal(result.portError.details.reason,'NFT_NO_AVAILABLE_SLOT');
    assert.equal(h.calls.status,4);assert.equal(h.state.active,0);
    h.state.failAt=undefined;h.state.alter=(_b,rows)=>rows;
    assert.equal((await h.resolver.resolve(h.request(range(100),standard))).portError,undefined,'a later preparation can recover');
  }
});

test('a selected slot outside its collection is a typed conflict without substitute reads',async()=>{
  const h=harness(100);h.state.indexed=range(100);
  const result=await h.resolver.resolve(h.request([101]));
  assert.equal(result.portError.details.reason,'NFT_SLOT_MISMATCH');
  assert.deepEqual(h.calls,{index:1,native:1,raw:0,decoded:0,status:0});
});

test('each chunk rejects cross-chunk identities, duplicates, wrong txid/value/script and noncanonical index',async()=>{
  const changes=[(h,rows)=>[h.row(26),...rows.slice(1)],(_h,rows)=>[rows[0],rows[0],...rows.slice(2)],
    (_h,rows)=>[{...rows[0],txid:'ef'.repeat(32)},...rows.slice(1)],(_h,rows)=>[{...rows[0],index:'01'},...rows.slice(1)],
    (_h,rows)=>[{...rows[0],value:'101'},...rows.slice(1)],(_h,rows)=>[{...rows[0],scriptPubKey:'51'},...rows.slice(1)]];
  for(const standard of [true,false])for(const change of changes){
    const h=harness(100);h.state.alter=(batch,rows)=>batch[0].index===1?change(h,rows):rows;
    const result=await h.resolver.resolve(h.request(range(100),standard));assert.ok(result.portError);assert.equal(h.state.active,0);
  }
});

test('positive confirmation policy still observes confirmation once, zero floor does not fetch it',async()=>{
  for(const minimum of ['0','1']){
    const h=harness(100,{retained:false,minimum});const result=await h.resolver.resolve(h.request(range(100)));
    assert.equal(result.portError,undefined);assert.equal(h.calls.raw,minimum==='0'?1:0);assert.equal(h.calls.decoded,minimum==='1'?1:0);
    assert.equal(h.calls.status,4);
  }
});

test('public resolver and official API normalization handle the 25-output HTTP contract together',async()=>{
  const h=harness(100),requests=[];
  h.client.api=createTbcOfficialApi({baseUrl:'https://material.test',fetch:async(input,init)=>{
    const url=new URL(String(input));assert.equal(url.origin,'https://material.test');
    if(url.pathname.includes('/utxo/scriptpubkeyhash/'))return new Response(JSON.stringify({code:200,data:{utxos:[]}}));
    assert.equal(url.pathname,'/api/tbc/txo/status');assert.equal(init.method,'POST');
    const {txos}=JSON.parse(init.body);requests.push(txos);assert.ok(txos.length<=25);
    return new Response(JSON.stringify({code:200,data:{results:txos.map(p=>({txid:p.txid,index:p.index,value:100,
      scriptpubkey:slotScript,status:{spent:false}}))}}));
  }});
  const result=await h.resolver.resolve(h.request(range(100)));assert.equal(result.portError,undefined);
  assert.deepEqual(slotsFrom(result),range(100));assert.deepEqual(requests.map(b=>b.length),[25,25,25,25]);
  assert.equal(h.calls.raw,0);assert.equal(h.calls.decoded,0);
});

test('201-item public mint preparation shares one native/index/raw observation across subgroups and snapshots',async()=>{
  const h=harness(201,{retained:false});
  const scope={authority:{chainId,accountId:account.accountId,address,origin:'https://mint.test',sessionId:'batch-test'},collectionId:h.collectionId,
    items:range(201).map(slot=>({slot,name:`NFT ${slot}`,symbol:'N',description:'',attributes:[]})),
    limits:{maxTotalFee:'100000',expiresAt:'2026-10-27T12:05:00Z'}};
  const material=await h.resolver.prepareNftMintJob(scope,account);
  assert.deepEqual(h.calls,{index:1,native:1,raw:1,decoded:0,status:9});
  const points=h.batches.flat().map(p=>p.index);assert.equal(points.length,201);assert.equal(new Set(points).size,201);
  assert.deepEqual([...points].sort((a,b)=>a-b),range(201));
  const before={...h.calls};
  assert.deepEqual(slotsFrom(material.snapshot(range(100))),range(100));
  assert.deepEqual(slotsFrom(material.snapshot([201])),[201]);assert.deepEqual(h.calls,before,'using prepared subsets adds no reads');
  await h.resolver.prepareNftMintJob(scope,account);assert.equal(h.calls.index,2);assert.equal(h.calls.status,18,'new task refreshes mutable observations');
});

test('batched fallback and fully indexed path produce identical validated Engine plans',async()=>{
  const backend=await createWasmTbcEngineBackend(await readFile(new URL('artifacts/wasm/tbc_engine_wasm.wasm',base)));
  const engine=createTbcEngine({backend}),h=harness(30);
  const selected=range(26),fallback=await h.resolver.resolve(h.request(selected));assert.equal(fallback.portError,undefined);
  h.state.indexed=selected;const indexed=await h.resolver.resolve(h.request(selected));assert.equal(indexed.portError,undefined);
  assert.deepEqual(indexed,fallback,'not just final totals: exact authenticated snapshot equality');
  // Plan a bounded subset from identical snapshots; Engine work size is not the API batch size.
  const singleIntent={type:'tbc721-standard-mint',version:'1.0',collectionId:h.collectionId,slot:1,name:'NFT 1',symbol:'N',description:'',attributes:[]};
  const normalized=await engine.normalizeRequest({version:'1.0',request:{version:'1.0',chainId,from:address,intent:singleIntent,
    constraints:{expiresAt:'2026-10-27T12:02:00Z',maxFee:'50000',feePreference:'standard'}}});
  const {hashCanonical}=await import('@tbc-wallet/core');
  const payload={version:'1.0',policyId:'batch-fallback-parity',revision:'1',chainId,feeRateSatPerKb:'80',dustThreshold:'42',minConfirmations:'0',
    maxBundleTransactions:32,sighashType:65,contractPolicies:[],amountLimits:[{scope:'native',maximum:'2100000000000000'}],expiresAt:'2026-10-27T12:05:00Z'};
  const policy={payload,policyHash:hashCanonical(payload)};
  const plan=async snapshot=>{const args={version:'1.0',request:normalized.request,requestHash:normalized.requestHash,snapshot,policy};
    const result=await engine.plan(args);assert.deepEqual(await engine.validate({...args,phase:'plan',plan:result.plan}),{valid:true,violations:[]});return result;};
  assert.deepEqual(await plan(fallback),await plan(indexed));
});

test('reported attribute/media/recipient matrix and 1/2/100 mint plans reuse one material observation',async t=>{
  const backend=await createWasmTbcEngineBackend(await readFile(new URL('artifacts/wasm/tbc_engine_wasm.wasm',base)));
  const engine=createTbcEngine({backend}),h=harness(100);h.state.nativeCount=122;h.state.indexed=range(100);
  const snapshot=await h.resolver.resolve(h.request(range(100)));assert.equal(snapshot.portError,undefined);
  const {hashCanonical}=await import('@tbc-wallet/core');
  const payload={version:'1.0',policyId:'matrix',revision:'1',chainId,feeRateSatPerKb:'80',dustThreshold:'42',minConfirmations:'0',
    maxBundleTransactions:100,sighashType:65,contractPolicies:[],amountLimits:[{scope:'native',maximum:'2100000000000000'}],expiresAt:'2026-10-27T12:05:00Z'};
  const policy={payload,policyHash:hashCanonical(payload)};
  const plan=async intent=>{
    const n=await engine.normalizeRequest({version:'1.0',request:{version:'1.0',chainId,from:address,intent,
      constraints:{expiresAt:'2026-10-27T12:02:00Z',maxFee:'1000000',feePreference:'standard'}}});
    const params={version:'1.0',request:n.request,requestHash:n.requestHash,snapshot,policy};
    const result=await engine.plan(params);assert.deepEqual(await engine.validate({...params,phase:'plan',plan:result.plan}),{valid:true,violations:[]});return result.plan;
  };
  const attributes=[[],[{traitType:'s',value:'one'}],[{traitType:'n',value:1}],[{traitType:'b',value:true}],
    [{traitType:'s',value:'one'},{traitType:'n',value:1},{traitType:'b',value:true}],range(64).map(i=>({traitType:'a'+i,value:i}))];
  const medias=[undefined,{kind:'uri',uri:'https://example.com/matrix.png'},
    {kind:'uri',uri:'https://example.com/matrix.png',sha256:'ab'.repeat(32)},
    {kind:'base64',mediaType:'text/plain',data:Buffer.from('fixture').toString('base64'),sha256:createHash('sha256').update('fixture').digest('hex')}];
  let variants=0;
  for(const attrs of attributes)for(const media of medias)for(const to of [undefined,'1cMh228HTCiwS8ZsaakH8A8wze1JR5ZsP']) {
    const result=await plan({type:'tbc721-standard-mint',version:'1.0',collectionId:h.collectionId,slot:1,
      name:'Matrix',symbol:'M',description:'',attributes:attrs,...(media?{media}:{}),...(to?{to}:{})});
    assert.equal(result.payload.transactions.length,1);variants++;
  }
  for(const count of [1,2,100])for(const to of [undefined,'1cMh228HTCiwS8ZsaakH8A8wze1JR5ZsP']) {
    const result=await plan({type:'tbc721-standard-batch-mint',version:'1.0',collectionId:h.collectionId,
      items:range(count).map(slot=>({slot,name:'Batch '+slot,symbol:'B',description:'',attributes:attributes[4],...(to?{to}:{})}))});
    assert.equal(result.payload.transactions.length,count);variants++;
  }
  assert.deepEqual(h.calls,{index:1,native:1,raw:0,decoded:0,status:0});
  t.diagnostic(`NFT_MATRIX ${JSON.stringify({variants,reads:h.calls,signatures:0,broadcasts:0})}`);
});
