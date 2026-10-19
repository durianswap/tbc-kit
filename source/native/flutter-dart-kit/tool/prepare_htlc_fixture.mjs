// Public synthetic HTLC vectors only. Never read real preimages/accounts or
// submit transactions. Full private wire data belongs only in test fixtures.
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {base,frozenOracle,sha,hash,canonical,address,account,now} from './frozen_oracle.mjs';
const o=await frozenOracle(),cases=[];
const owner='751e76e8199196d454941c45d1b3a323f1433bd6',other='06afd46bcdfd22ef94ac122aa11f241244a37ecc';
const otherAddress='1cMh228HTCiwS8ZsaakH8A8wze1JR5ZsP';
const publicProof='33'.repeat(32),hashlock=sha(Buffer.from(publicProof,'hex')),id=n=>n.toString(16).padStart(64,'0');
function deposit(branch,time,tag){
 const n=Buffer.alloc(4);n.writeUInt32LE(time);
 const receiver=branch==='claim'?owner:other,sender=branch==='claim'?other:owner;
 const code='63a820'+hashlock+'8876a914'+receiver+'6704'+n.toString('hex')+'8152ba816ea0646e040065cd1da263040065cd1da269a1676d7551686700686956ba01247f778104ffffffff9e6976a914'+sender+'6888ac';
 const output='102700000000000089'+code;
 const raw='0a00000001'+tag.toString(16).padStart(2,'0').repeat(32)+'0000000000ffffffff02'+output+output+'00000000';
 return {id:o.api.inspectTbcTransaction(raw).txid,raw};
}
const specs=[
 {name:'htlc-native-lock-height',branch:'lock',time:830010},
 {name:'htlc-native-lock-time',branch:'lock',time:1791800001},
 {name:'htlc-native-lock-explicit-multiple',branch:'lock',time:830010,selected:true},
 {name:'htlc-native-claim-before-refund-height',branch:'claim',time:830001},
 {name:'htlc-native-claim-after-refund-time',branch:'claim',time:1791799999},
 {name:'htlc-native-claim-siblings',branch:'claim',time:830001,siblings:true},
 {name:'htlc-native-refund-height-equality',branch:'refund',time:830000},
 {name:'htlc-native-refund-time',branch:'refund',time:1791799999},
 {name:'htlc-native-refund-distinct-parents',branch:'refund',time:829999,distinct:true},
 {name:'htlc-native-claim-unknown-height',branch:'claim',time:830001,unknown:true},
 {name:'htlc-native-claim-positive-floor',branch:'claim',time:830001,siblings:true,unknown:true,floor:'1'},
];
for(const spec of specs){
 const {name,branch,time}=spec,locked=branch==='lock',trace=[],posts=[],snapshotId=name,minConfirmations=spec.floor??'0';
 const a=deposit(branch,time,17),b=deposit(branch,time,18);
 const points=spec.distinct?[{txid:b.id,vout:1},{txid:a.id,vout:0}]:spec.siblings?[{txid:a.id,vout:1},{txid:a.id,vout:0}]:[{txid:a.id,vout:0}];
 const replies={'/api/tbc/nodeinfo':{blocks:830000,bestblockhash:'aa'.repeat(32),mediantime:1791800000},
  ['/api/tbc/utxo/address/'+address]:{utxos:[{txid:id(2),index:0,value:'9000',height:829999},{txid:id(1),index:0,value:'20000',height:829999}]},
  '/api/tbc/txo/status':{txos:points.map(p=>({txid:p.txid,index:p.vout,value:'10000',spent:false,...(spec.unknown?{}:{height:829999})}))}};
 for(const t of [a,b]){
  replies['/api/tbc/txraw/txid/'+t.id]={txraw:t.raw};
  const tx=o.api.inspectTbcTransaction(t.raw).transaction;
  replies['/api/tbc/decode/txid/'+t.id]={txid:t.id,hex:t.raw,confirmations:2,vin:tx.inputs.map(({txid,vout})=>({txid,vout})),
   vout:tx.outputs.map((x,n)=>({n,valueSat:x.satoshis.toString(),scriptPubKey:{hex:Buffer.from(x.scriptPubKey).toString('hex'),addresses:[]}}))};
 }
 let request={version:'1.0',chainId:account.chainId,from:address,
  intent:{version:'1.0',type:'tbc-htlc-'+branch,...(locked?{to:otherAddress,amount:'1000',hashlock,lockTime:String(time)}:branch==='claim'?{preimage:publicProof}:{})},
  constraints:{maxFee:'100000',...(!locked?{inputOutpoints:points}:spec.selected?{inputOutpoints:[{txid:id(1),vout:0},{txid:id(2),vout:0}]}:{})}};
 request=(await o.call('normalizeRequest',{version:'1.0',request})).request;
 const network=o.kit.createDefaultTbcNetwork({network:o.kit.createTbcNetworkContext({network:'testnet'}),accounts:{current:async()=>[account]},
  now:()=>Date.parse(now),snapshotId:()=>snapshotId,confirmationPolicy:{minConfirmations},fetch:async(url,init)=>{
   const path=new URL(String(url)).pathname;assert(!String(url).includes(publicProof));assert(!String(init?.body??'').includes(publicProof));
   if((init?.method??'GET')==='POST'){assert.equal(path,'/api/tbc/txo/status');posts.push(JSON.parse(init.body));}else{assert.equal(init?.method??'GET','GET');trace.push(path);}
   assert(replies[path],path);return new Response(JSON.stringify({code:200,data:replies[path]}));}});
 const requirement=o.kit.chainDataRequirement(request);assert(!JSON.stringify(requirement).includes(publicProof));assert(!JSON.stringify(requirement).includes('preimage'));
 const snapshot=await network.chainData.resolve({version:'1.0',chainId:account.chainId,accountId:account.accountId,requirement},account);assert(snapshot.snapshotHash,name+':material-failed');
 const policy=await network.resolvePolicy({request,requestHash:hash(request),snapshotHash:snapshot.snapshotHash});assert(policy.policyHash);
 const signed=await o.sign(name,request,snapshot,policy,{captureStages:true}),coldTrace=[...trace],coldStatus=[...posts];trace.length=0;posts.length=0;
 assert.equal(canonical(await network.chainData.resolve({version:'1.0',chainId:account.chainId,accountId:account.accountId,requirement},account)),canonical(snapshot));
 assert.equal(canonical(signed.audit.preview.warnings),canonical(branch==='claim'?['HTLC_CLAIM_SIGNED_BYTES_DISCLOSE_PREIMAGE']:[]));
 assert(!JSON.stringify(signed.audit.preview).includes(publicProof));
 cases.push({name,network:'testnet',now,snapshotId,minConfirmations,method:'tbc_signTransaction',account,request,requirement,replies,coldTrace,warmTrace:[...trace],coldStatus,warmStatus:[...posts],...signed});
 console.log(JSON.stringify({name,gets:coldTrace.length,warmGets:trace.length,statusPosts:coldStatus.length,tasks:signed.audit.signatures.length,fee:signed.result.totalFee}));
}
await writeFile(join(base,'test/fixtures/htlc-native-signing.json'),JSON.stringify({status:'FROZEN_PUBLIC_NATIVE_HTLC_ORACLE',archiveSha256:o.archiveSha256,wasmSha256:o.wasmSha256,
 publicScalarOneAndKnownProofOnly:true,networkHttp:0,broadcasts:0,cases},null,2)+'\n',{flag:'wx'});
