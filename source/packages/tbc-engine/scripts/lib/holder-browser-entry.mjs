import * as publicKit from '@tbc/kit';
import * as wallet from '@tbc/kit/wallet';
import * as engine from '@tbc/kit/engine';
import {secp256k1} from '@noble/curves/secp256k1.js';
import assert from './browser-test-assert.mjs';
import {checkRawHolderHost} from './check-raw-holder-host.mjs';

// Real browser, installed package, public scalar 1 and in-memory chain fixtures.
// No node globals, real keys, network indexer, custody UI or broadcast.
try{
 const kit={...publicKit,...wallet,...engine};
 assert.equal(typeof globalThis.Buffer,'undefined');
 assert.equal(typeof globalThis.process,'undefined');
 const [fixture,wasm]=await Promise.all([fetch('/fixture.json').then(r=>r.json()),fetch('/engine.wasm').then(r=>r.arrayBuffer())]);
 const native=await kit.createWasmTbcKeylessEngine(new Uint8Array(wasm));
 const secret=new Uint8Array(32);secret[31]=1;
 const network=kit.createTbcNetworkContext({network:'testnet',endpoint:{kind:'trusted-custom',apiOrigin:'https://devapi.tbcdev.org',trustId:'public-fixture'}});
 const rows=[],hostRows=[];let negativeCases=0;
 const started=performance.now();
 for(const item of fixture.vectors){
  let reads=0;
  const reviewer=kit.createTbcDefaultRawTransactionReviewer({network,materialNative:native,fetch:async(url,init)=>{
   const u=new URL(String(url));assert.equal(u.origin,'https://devapi.tbcdev.org');reads++;let data;
   if(u.pathname==='/api/tbc/txo/status')data={txos:JSON.parse(init.body).txos.map(p=>{
    const output=item.parents[p.txid]?.[Number(p.index)];assert.ok(output,'Unknown fixture prevout');
    return {txid:p.txid,index:String(p.index),value:output.value,scriptPubKey:output.script,spent:false,height:'1'};
   })};
   else if(u.pathname.includes('/decode/txid/')){
    const id=u.pathname.split('/').at(-1);assert.ok(item.parents[id]);
    data={txid:id,contract_id:item.assetId,output:item.parents[id].map((_,vout)=>({txid:id,vout}))};
   }else if(u.pathname.includes('/info/'))data={stablecoin_id:item.assetId,code_script:item.assetScript};
   else throw Error('Unexpected fixture request');
   return new Response(JSON.stringify({code:'200',data}),{status:200});
  }});
  const context={origin:'https://review.test',chainId:'tbc:testnet',accountId:item.account.accountId,sessionId:'review',navigationId:'review'};
  const result=await reviewer.review({request:item.request,context,transactionIds:[item.txid]});
  assert.equal(reads,4);assert.equal(result.preview.transactions[0].classification.protocol,item.protocol);
  assert.ok(result.preview.transactions[0].groups.some(g=>g.asset.contractId===item.assetId));
  const stage=JSON.parse(await native.execute('prepareReviewedStage',JSON.stringify({format:'raw',publicKey:item.account.publicKey,
   resolvedOutputs:result.policyMaterial.resolvedOutputs,request:{txraws:item.request.txraws,utxosSatoshis:item.request.utxos_satoshis,scriptPubkeys:item.request.script_pubkeys}})));
  const signatures=stage.digests.map(d=>secp256k1.sign(d,secret,{prehash:false,lowS:true}).toCompactHex());
  const signed=JSON.parse(await native.execute('finalizeReviewedStage',JSON.stringify({stage,signatures,signatureEncoding:'compact64'})));
  assert.equal(signed.txraw,item.request.txraws[0]);assert.deepEqual(signed.sigs,item.expectedSignatures);
  if(item.host){
   const envelope={payload:{format:'raw',transactions:[{rawTransaction:item.request.txraws[0],inputs:item.request.script_pubkeys[0].map((scriptPubKey,i)=>({scriptPubKey,satoshis:String(item.request.utxos_satoshis[0][i])}))}]}};
   hostRows.push(...(await checkRawHolderHost({kit,native,account:item.account,request:envelope,reviewer,signer:{toBuffer:()=>secret},
    expectedSignatures:item.expectedSignatures,readCount:()=>reads})).map(r=>({id:item.id,...r})));
  }
  let rejected=false;
  try{await reviewer.review({request:item.request,context:{...context,accountId:'tbc:testnet:1cMh228HTCiwS8ZsaakH8A8wze1JR5ZsP'},transactionIds:[item.txid]});}catch{rejected=true;}
  assert.ok(rejected,'Wrong account must be rejected');negativeCases++;
  rows.push({id:item.id,sigs:signed.sigs,rawUnchanged:signed.txraw===item.request.txraws[0],readBudget:4});
 }
 assert.equal(hostRows.length,12);assert.equal(rows.length,6);
 assert.equal(typeof globalThis.Buffer,'undefined');assert.equal(typeof globalThis.process,'undefined');
 document.querySelector('#result').textContent=JSON.stringify({status:'PASS_BROWSER_214_HOLDER',rows,hostRows,negativeCases,
  elapsedMs:performance.now()-started,userAgent:navigator.userAgent,bufferGlobal:false,nodeProcessGlobal:false,actualChainHttp:0,broadcast:0});
}catch(error){document.querySelector('#result').textContent=JSON.stringify({status:'FAIL',error:String(error),stack:error.stack});}
