// Public scalar-one Token HTLC fixtures; no private proof, HTTP or broadcast.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {base,frozenOracle,sha,hash,canonical,address,account,now} from './frozen_oracle.mjs';
const o=await frozenOracle(),cases=[],sources={};
const proof='33'.repeat(32),hashlock=sha(Buffer.from(proof,'hex'));
async function source(file){const bytes=await readFile(join(base,file));sources[file]=sha(bytes);return JSON.parse(bytes);}
const ft=await source('test/fixtures/fungible-signing.json'),coin=await source('test/fixtures/stablecoin-signing.json');
for(const [standard,seed]of [['tbc20-standard',ft.cases.find(c=>c.name==='current-transfer-multiple-inputs')],['tbc20-stablecoin',coin.cases.find(c=>c.name==='current-coin-transfer')]]){
 const contract=seed.request.intent.contractId,raw={};
 for(const [path,value]of Object.entries(seed.replies))if(path.startsWith('/api/tbc/txraw/txid/'))raw[path.split('/').at(-1)]=value.txraw;
 const remember=tx=>{assert.equal(o.api.turingTransactionId(tx.rawTransaction),tx.txid);raw[tx.txid]=tx.rawTransaction;return tx;};
 async function capture(label,{branch='lock',lockTime='830010',deposit,unknown=false,floor='0',explicit=false,time=false}={}){
  const name=`htlc-token-${standard}-${label}`,trace=[],posts=[],snapshotId=name;
  const indexPath=Object.keys(seed.replies).find(p=>p.includes('/utxo/combinescript/'));
  const replies={...structuredClone(seed.replies),'/api/tbc/nodeinfo':{blocks:branch==='refund'&&!time?830010:830000,bestblockhash:'aa'.repeat(32),mediantime:time?1791800020:1791800000}};
  for(const [id,txraw]of Object.entries(raw)){
   replies['/api/tbc/txraw/txid/'+id]={txraw};const tx=o.api.inspectTbcTransaction(txraw).transaction;
   replies['/api/tbc/decode/txid/'+id]={txid:id,hex:txraw,confirmations:2,vin:tx.inputs.map(x=>({txid:x.txid,vout:x.vout})),vout:tx.outputs.map((x,n)=>({n,valueSat:x.satoshis.toString(),scriptPubKey:{hex:Buffer.from(x.scriptPubKey).toString('hex'),addresses:[]}}))};
  }
  if(deposit){const tx=o.api.inspectTbcTransaction(deposit.rawTransaction).transaction;replies['/api/tbc/txo/status']={txos:[0,1].map(index=>({txid:deposit.txid,index,spent:false,value:tx.outputs[index].satoshis.toString(),scriptPubKey:Buffer.from(tx.outputs[index].scriptPubKey).toString('hex'),...(unknown?{}:{height:829999})}))};}
  const selected=explicit?[...replies[indexPath].utxos,...replies['/api/tbc/utxo/address/'+address].utxos].map(x=>({txid:x.txid,vout:x.index})):undefined;
  let request={version:'1.0',chainId:account.chainId,from:address,intent:{version:'1.0',type:'tbc-htlc-'+branch,assetStandard:standard,contractId:contract,
   ...(branch==='lock'?{to:address,amount:'250',hashlock,lockTime}:{targetOutpoints:[{txid:deposit.txid,vout:1}],...(branch==='claim'?{preimage:proof}:{})})},constraints:{maxFee:'100000',...(selected?{inputOutpoints:selected}:{})}};
  request=(await o.call('normalizeRequest',{version:'1.0',request})).request;
  const network=o.kit.createDefaultTbcNetwork({network:o.kit.createTbcNetworkContext({network:'testnet'}),accounts:{current:async()=>[account]},poolNative:o.keyless,
   now:()=>Date.parse(now),snapshotId:()=>snapshotId,confirmationPolicy:{minConfirmations:floor},fetch:async(url,init)=>{
    const path=new URL(String(url)).pathname;assert(!String(url).includes(proof));assert(!String(init?.body??'').includes(proof));
    if((init?.method??'GET')==='POST'){assert.equal(path,'/api/tbc/txo/status');posts.push(JSON.parse(init.body));}else{assert.equal(init?.method??'GET','GET');trace.push(path);}
    assert(replies[path],path);return new Response(JSON.stringify({code:200,data:replies[path]}));}});
  const requirement=o.kit.chainDataRequirement(request);assert(!JSON.stringify(requirement).includes('preimage'));
  const snapshot=await network.chainData.resolve({version:'1.0',chainId:account.chainId,accountId:account.accountId,requirement},account);assert(snapshot.snapshotHash,name+':MATERIAL');
  const policy=await network.resolvePolicy({request,requestHash:hash(request),snapshotHash:snapshot.snapshotHash});assert(policy.policyHash,name+':POLICY');
  const signed=await o.sign(name,request,snapshot,policy,{captureStages:true}),coldTrace=[...trace],coldStatus=[...posts];trace.length=0;posts.length=0;
  assert.equal(canonical(await network.chainData.resolve({version:'1.0',chainId:account.chainId,accountId:account.accountId,requirement},account)),canonical(snapshot));
  assert.equal(signed.result.transactions.length,1);assert.equal(policy.payload.dustThreshold,'42');
  assert(!JSON.stringify(signed.audit.preview).includes(proof));
  cases.push({name,network:'testnet',now,snapshotId,minConfirmations:floor,method:'tbc_signTransaction',account,request,requirement,replies,coldTrace,warmTrace:[...trace],coldStatus,warmStatus:[...posts],...signed});
  console.log(JSON.stringify({name,coldGets:coldTrace.length,warmGets:trace.length,statusPosts:coldStatus.length,tasks:signed.audit.signatures.length,fee:signed.result.totalFee}));
  return remember(signed.result.transactions[0]);
 }
 const height=await capture('lock-height'),time=await capture('lock-time',{lockTime:'1791800010'});
 await capture('lock-explicit',{explicit:true});
 await capture('claim-before-refund',{branch:'claim',deposit:height});
 await capture('refund-height-equality',{branch:'refund',deposit:height});
 await capture('claim-unknown-height',{branch:'claim',deposit:height,unknown:true});
 await capture('claim-positive-floor',{branch:'claim',deposit:height,unknown:true,floor:'1'});
 await capture('refund-time',{branch:'refund',deposit:time,time:true});
}
await writeFile(join(base,'test/fixtures/htlc-token-signing.json'),JSON.stringify({status:'FROZEN_PUBLIC_TOKEN_HTLC_ORACLE',archiveSha256:o.archiveSha256,wasmSha256:o.wasmSha256,sources,publicScalarOneAndKnownProofOnly:true,networkHttp:0,broadcasts:0,cases},null,2)+'\n',{flag:'wx'});
