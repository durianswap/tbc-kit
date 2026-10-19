// Public synthetic height-lock oracle from immutable accepted Kit/WASM.
// No HTTP, wallet secrets, chain funds or broadcast. Create-only evidence.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {base,frozenOracle,sha,hash,canonical,address,account,now} from './frozen_oracle.mjs';
const o=await frozenOracle(),cases=[];
// The frozen wallet entry bundles its internal material resolver.
const frozenMaterial=await readFile(join(o.work,'package/dist/esm/wallet.node.js'));
function deposit(height=829999,tag=17){
 const n=Buffer.alloc(4);n.writeUInt32LE(height);
 const code='76a914751e76e8199196d454941c45d1b3a323f1433bd688ad56ba01247f778104ffffffff819e518804'+n.toString('hex')+'8152ba81a15187';
 const output='102700000000000035'+code;
 const raw='0a00000001'+tag.toString(16).padStart(2,'0').repeat(32)+'0000000000ffffffff02'+output+output+'00000000';
 return {id:o.api.inspectTbcTransaction(raw).txid,raw};
}
const a=deposit(),b=deposit(830000,18),id=n=>n.toString(16).padStart(64,'0');
const specs=[
 {name:'timelock-lock-default',lock:true},
 {name:'timelock-lock-exact',lock:true,selected:true},
 {name:'timelock-lock-multiple',lock:true,multiple:true},
 {name:'timelock-unlock-one',points:[{txid:a.id,vout:0}]},
 {name:'timelock-unlock-siblings',points:[{txid:a.id,vout:1},{txid:a.id,vout:0}]},
 {name:'timelock-unlock-distinct-mature',points:[{txid:b.id,vout:1},{txid:a.id,vout:0}]},
 {name:'timelock-unlock-unknown-height',points:[{txid:a.id,vout:0}],unknown:true},
 {name:'timelock-unlock-positive-floor',points:[{txid:a.id,vout:1},{txid:a.id,vout:0}],unknown:true,floor:'1'},
];
for(const spec of specs){
 const name=spec.name,trace=[],snapshotId=name,minConfirmations=spec.floor??'0';
 const rows=[{txid:id(2),index:0,value:'9000',height:829999},{txid:id(1),index:0,value:'20000',height:829999}];
 const deposits=[a,b].flatMap(t=>[0,1].map(index=>({txid:t.id,index,value:'10000',...(spec.unknown?{}:{height:829999})})));
 const replies={'/api/tbc/nodeinfo':{blocks:830000,bestblockhash:'aa'.repeat(32)},
  ['/api/tbc/utxo/address/'+address]:{utxos:rows},
  ['/api/tbc/frozenUtxo/address/'+address+'/piggyBank']:{utxos:deposits}};
 for(const t of [a,b]){
  replies['/api/tbc/txraw/txid/'+t.id]={txraw:t.raw};
  const tx=o.api.inspectTbcTransaction(t.raw).transaction;
  replies['/api/tbc/decode/txid/'+t.id]={txid:t.id,hex:t.raw,confirmations:2,
   vin:tx.inputs.map(({txid,vout})=>({txid,vout})),vout:tx.outputs.map((x,n)=>({n,valueSat:x.satoshis.toString(),scriptPubKey:{hex:Buffer.from(x.scriptPubKey).toString('hex'),addresses:[]}}))};
 }
 let request={version:'1.0',chainId:account.chainId,from:address,
  intent:{version:'1.0',type:'tbc-timelock-'+(spec.lock?'lock':'unlock'),...(spec.lock?{amount:spec.multiple?'27000':'1000',lockTime:'830010'}:{})},
  constraints:{maxFee:'100000',...(spec.points?{inputOutpoints:spec.points}:spec.selected?{inputOutpoints:[{txid:id(2),vout:0}]}:{})}};
 request=(await o.call('normalizeRequest',{version:'1.0',request})).request;
 const network=o.kit.createDefaultTbcNetwork({network:o.kit.createTbcNetworkContext({network:'testnet'}),accounts:{current:async()=>[account]},
  now:()=>Date.parse(now),snapshotId:()=>snapshotId,confirmationPolicy:{minConfirmations},fetch:async(url,init)=>{
   assert.equal(init?.method??'GET','GET');const path=new URL(String(url)).pathname;trace.push(path);assert(replies[path],path);
   return new Response(JSON.stringify({code:200,data:replies[path]}));}});
 const requirement=o.kit.chainDataRequirement(request);
 const snapshot=await network.chainData.resolve({version:'1.0',chainId:account.chainId,accountId:account.accountId,requirement},account);
 assert(snapshot.snapshotHash,name+JSON.stringify(snapshot));
 const policy=await network.resolvePolicy({request,requestHash:hash(request),snapshotHash:snapshot.snapshotHash});assert(policy.policyHash);
 const signed=await o.sign(name,request,snapshot,policy,{captureStages:true}),coldTrace=[...trace];trace.length=0;
 assert.equal(canonical(await network.chainData.resolve({version:'1.0',chainId:account.chainId,accountId:account.accountId,requirement},account)),canonical(snapshot));
 const warmTrace=[...trace];
 if(!spec.lock)assert(!coldTrace.some(p=>p.includes('/utxo/address/')));
 cases.push({name,network:'testnet',now,snapshotId,minConfirmations,method:'tbc_signTransaction',account,request,requirement,replies,coldTrace,warmTrace,...signed});
 console.log(JSON.stringify({name,reads:coldTrace.length,warm:warmTrace.length,tasks:signed.audit.signatures.length,fee:signed.result.totalFee}));
}
await writeFile(join(base,'test/fixtures/timelock-signing.json'),JSON.stringify({status:'FROZEN_PUBLIC_TIMELOCK_ORACLE',archiveSha256:o.archiveSha256,wasmSha256:o.wasmSha256,
 frozenWalletEntrySha256:sha(frozenMaterial),publicScalarOneOnly:true,networkHttp:0,broadcasts:0,cases},null,2)+'\n',{flag:'wx'});
