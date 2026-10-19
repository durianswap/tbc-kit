// Frozen LOP oracle: public scalar-one and synthetic unbroadcast fee stocks.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {secp256k1} from '@noble/curves/secp256k1';
import {base,frozenOracle,sha,hash,canonical,address,account,now} from './frozen_oracle.mjs';
const o=await frozenOracle(),cases=[],sources={},raw={},common={};
async function source(file,name){const b=await readFile(join(base,file));sources[file]=sha(b);return JSON.parse(b).cases.find(c=>c.name===name);}
const ft=await source('test/fixtures/fungible-signing.json','current-transfer-multiple-inputs');
const coin=await source('test/fixtures/stablecoin-signing.json','current-coin-transfer');
for(const s of [ft,coin])for(const [p,v]of Object.entries(s.replies)){
 if(p.includes('/txraw/'))raw[p.split('/').at(-1)]=v.txraw;
 else if(p.includes('/utxo/combinescript/'))common[p]=structuredClone(v);
}
const ftAsset={standard:'tbc20-standard',contractId:ft.request.intent.contractId};
const coinAsset={standard:'tbc20-stablecoin',contractId:coin.request.intent.contractId};
const coinRow=Object.values(common).flatMap(x=>x.utxos).find(x=>x.txid==='de29edd2bf9eba8f1b1da00839a12bb420958f2e58ecebd57d392e7d415cdefe');assert(coinRow);
common['/api/tbc/stablecoin/info/stablecoinid/'+coinAsset.contractId]={stablecoin_id:coinAsset.contractId,utxo:{txid:coinRow.txid,vout:coinRow.index}};
const remember=t=>{assert.equal(o.api.turingTransactionId(t.rawTransaction),t.txid);raw[t.txid]=t.rawTransaction;return t;};
function publicFixtureWallet(scalar){
 assert([2n,3n].includes(scalar));const publicKey=Buffer.from(secp256k1.getPublicKey(scalar,true)).toString('hex');
 const owner=createHash('ripemd160').update(Buffer.from(sha(Buffer.from(publicKey,'hex')),'hex')).digest('hex');
 const payload=Buffer.from('00'+owner,'hex'),check=Buffer.from(sha(Buffer.from(sha(payload),'hex')).slice(0,8),'hex');let n=BigInt('0x'+Buffer.concat([payload,check]).toString('hex')),value='';
 const alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';while(n){value=alphabet[Number(n%58n)]+value;n/=58n;}const address='1'+value;
 return {chainId:account.chainId,address,accountId:account.chainId+':'+address,publicKey,owner};
}
async function signSecondary(name,request,snapshot,policy,scalar){
 assert([2n,3n].includes(scalar));const wallet=publicFixtureWallet(scalar);assert.equal(request.from,wallet.address);assert.equal(snapshot.payload.account.publicKey,wallet.publicKey);
 const normalized=await o.call('normalizeRequest',{version:'1.0',request}),material={version:'1.0',...normalized,snapshot,policy};const {plan}=await o.call('plan',material);
 assert.equal(plan.payload.transactions.length,1);assert.equal((await o.call('validate',{...material,plan,phase:'plan'})).valid,true);
 const context={sessionId:'offline-'+name,navigationId:'document-1',origin:'https://partner.example',topOrigin:'https://partner.example',transport:'webview',frame:'top',createdAt:now};
 const payload={version:'1.0',method:'tbc_signTransaction',operationKind:'transaction',contextHash:hash(context),origin:context.origin,sessionId:context.sessionId,chainId:wallet.chainId,accountId:wallet.accountId,requestHash:normalized.requestHash,operationHash:plan.planHash,expiresAt:plan.payload.expiresAt};
 const binding={payload,bindingHash:hash(payload)},approval={status:'approved',approvalId:'offline-'+name,approvalToken:'public-fixture-only',bindingHash:binding.bindingHash,approvedAt:now,expiresAt:payload.expiresAt};
 assert.equal((await o.call('validate',{...material,plan,binding,approval,phase:'pre-sign'})).valid,true);
 const signatures=plan.payload.signingTasks.map(t=>{assert.equal(t.publicKey,wallet.publicKey);return{taskId:t.taskId,signatureEncoding:t.signatureEncoding,signature:secp256k1.sign(t.digest,scalar,{prehash:false,lowS:true}).toCompactHex()};});
 const args={...material,plan,binding,approval,signatures},final=await o.call('finalize',args);assert(final.bundle);assert.equal((await o.call('validate',{...args,bundle:final.bundle,phase:'finalized'})).valid,true);
 return {context,result:final.bundle,audit:{material,plan,preview:plan.payload.preview,binding,approval,signatures}};
}
async function capture(name,intent,{floor='0',unknown=false,explicit=false,wallet=account,scalar=1n,record=true}={}){
 const trace=[],posts=[],replies=structuredClone(common),snapshotId=name;
 replies['/api/tbc/nodeinfo']={blocks:830000,bestblockhash:'aa'.repeat(32),mediantime:1791800000};
 replies['/api/tbc/utxo/address/'+wallet.address]={utxos:[{txid:hash({publicFixtureFunding:name}),index:0,value:'1000000',height:829999}]};
 for(const [id,txraw]of Object.entries(raw)){
  replies['/api/tbc/txraw/txid/'+id]={txraw};const tx=o.api.inspectTbcTransaction(txraw).transaction;
  replies['/api/tbc/decode/txid/'+id]={txid:id,hex:txraw,confirmations:2,vin:tx.inputs.map(({txid,vout})=>({txid,vout})),vout:tx.outputs.map((x,n)=>({n,valueSat:x.satoshis.toString(),scriptPubKey:{hex:Buffer.from(x.scriptPubKey).toString('hex'),addresses:[]}}))};
 }
 // Native fee stock is always confirmed; unknown-height cases target the order.
 const points=[];
 for(const point of intent.targetOutpoints??[]){
  const inspection=JSON.parse(await o.keyless.execute('inspectLopMaterial',JSON.stringify({phase:'inspectOrder',parent:{txid:point.txid,rawTransaction:raw[point.txid]},vout:point.vout})));
  const tx=o.api.inspectTbcTransaction(raw[point.txid]).transaction;
  for(const index of [point.vout,...(inspection.escrow?[point.vout+1]:[])])points.push({txid:point.txid,index,spent:false,value:tx.outputs[index].satoshis.toString(),scriptPubKey:Buffer.from(tx.outputs[index].scriptPubKey).toString('hex'),...(unknown?{}:{height:829999})});
 }
 if(points.length)replies['/api/tbc/txo/status']={txos:points};
 const inputOutpoints=explicit?[{txid:replies['/api/tbc/utxo/address/'+wallet.address].utxos[0].txid,vout:0},...points.map(p=>({txid:p.txid,vout:p.index}))]:undefined;
 let request={version:'1.0',chainId:wallet.chainId,from:wallet.address,intent:{version:'1.0',...intent},constraints:{maxFee:'100000',...(inputOutpoints?{inputOutpoints}:{})}};
 request=(await o.call('normalizeRequest',{version:'1.0',request})).request;
 const network=o.kit.createDefaultTbcNetwork({network:o.kit.createTbcNetworkContext({network:'testnet'}),accounts:{current:async()=>[wallet]},poolNative:o.keyless,
  now:()=>Date.parse(now),snapshotId:()=>snapshotId,confirmationPolicy:{minConfirmations:floor},fetch:async(url,init)=>{
   const p=new URL(String(url)).pathname;if((init?.method??'GET')==='POST'){assert.equal(p,'/api/tbc/txo/status');posts.push(JSON.parse(init.body));}else{assert.equal(init?.method??'GET','GET');trace.push(p);}
   assert(replies[p],'Missing LOP fixture '+p);return new Response(JSON.stringify({code:200,data:replies[p]}));}});
 const requirement=o.kit.chainDataRequirement(request);
 const snapshot=await network.chainData.resolve({version:'1.0',chainId:wallet.chainId,accountId:wallet.accountId,requirement},wallet);assert(snapshot.snapshotHash,name+':'+JSON.stringify(snapshot));
 const policy=await network.resolvePolicy({request,requestHash:hash(request),snapshotHash:snapshot.snapshotHash});assert(policy.policyHash);
 const signed=scalar===1n?await o.sign(name,request,snapshot,policy,{captureStages:true}):await signSecondary(name,request,snapshot,policy,scalar),coldTrace=[...trace],coldStatus=[...posts];trace.length=0;posts.length=0;
 const warm=await network.chainData.resolve({version:'1.0',chainId:wallet.chainId,accountId:wallet.accountId,requirement},wallet);assert.equal(canonical(warm),canonical(snapshot));
 if(record){assert.equal(scalar,1n);cases.push({name,network:'testnet',now,snapshotId,minConfirmations:floor,method:'tbc_signTransaction',account,request,requirement,replies,coldTrace,warmTrace:[...trace],coldStatus,warmStatus:[...posts],...signed});}
 console.log(JSON.stringify({name,coldGets:coldTrace.length,warmGets:trace.length,statusPosts:coldStatus.length,tasks:signed.audit.signatures.length,fee:signed.result.totalFee}));
 assert.equal(signed.result.transactions.length,1);return remember(signed.result.transactions[0]);
}
// The match account remains public scalar one. Orders belong to two distinct
// public fixture holders so frozen covenant ownership is exercised, not bypassed.
for(const scalar of [2n,3n])for(const asset of [ftAsset,coinAsset]){
 const wallet=publicFixtureWallet(scalar),coin=asset.standard==='tbc20-stablecoin';
 const tx=await capture(`lop-public-handoff-${scalar}-${coin?'coin':'ft'}`,{type:coin?'tbc20Stablecoin.transfer':'tbc20.transfer',contractId:asset.contractId,to:wallet.address,amount:'400'},{record:false});
 const item=JSON.parse(await o.keyless.execute('inspectLopMaterial',JSON.stringify({phase:'inspectAsset',parent:{txid:tx.txid,rawTransaction:tx.rawTransaction},vout:0})));
 assert.equal(item.controller,wallet.owner+'00');
 const p=coin?`/api/tbc/stablecoin/utxo/combinescript/${wallet.owner}00/stablecoinid/${asset.contractId}`:`/api/tbc/ft/utxo/combinescript/${wallet.owner}00/contract/${asset.contractId}`;
 common[p]={utxos:[{txid:tx.txid,index:0,tbc_value:'500',ft_value:'400',height:829999}]};
}
for(const pair of [false,true])for(const coinFirst of [false,true]){
 const label=`lop-${pair?'token-token':'native-token'}-${coinFirst?'coin':'ft'}`,orders={};
 for(const side of ['buy','sell']){
  const order={side,market:pair?'token-token':'native-token',assetA:coinFirst?coinAsset:ftAsset,...(pair?{assetB:coinFirst?ftAsset:coinAsset}:{}),saleVolume:side==='sell'?'150':'100',unitPrice:'1000000',feeRate:'100000',feeRecipient:address};
  const own=await capture(label+'-create-'+side,{type:'tbc-lop-create',order});
  await capture(label+'-cancel-'+side,{type:'tbc-lop-cancel',targetOutpoints:[{txid:own.txid,vout:0}]});
  const scalar=side==='buy'?2n:3n;
  orders[side]=await capture(label+'-third-party-'+side,{type:'tbc-lop-create',order},{scalar,wallet:publicFixtureWallet(scalar),record:false});
  if(!pair&&!coinFirst&&side==='buy')await capture(label+'-cancel-unknown',{type:'tbc-lop-cancel',targetOutpoints:[{txid:own.txid,vout:0}]},{unknown:true});
 }
 const targets=['buy','sell'].map(side=>({txid:orders[side].txid,vout:0}));
 await capture(label+'-match',{type:'tbc-lop-match',targetOutpoints:targets});
 if(!pair&&!coinFirst){
  await capture(label+'-match-positive-floor',{type:'tbc-lop-match',targetOutpoints:targets},{unknown:true,floor:'1'});
  await capture(label+'-match-explicit',{type:'tbc-lop-match',targetOutpoints:targets},{explicit:true});
 }
}
await writeFile(join(base,'test/fixtures/lop-signing.json'),JSON.stringify({status:'FROZEN_PUBLIC_LOP_ORACLE',archiveSha256:o.archiveSha256,wasmSha256:o.wasmSha256,sources,requestSignerPublicScalarOne:true,syntheticOrderSetupPublicScalars:[1,2,3],networkHttp:0,broadcasts:0,cases},null,2)+'\n',{flag:'wx'});
