// Isolated frozen comparator for AMM funding alternatives; no live requests.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {base,frozenOracle,sha,hash,canonical,address,account,now} from './frozen_oracle.mjs';
const o=await frozenOracle(),cases=[];
const source=await readFile(join(base,'test/fixtures/amm-business-signing.json'));
const sample=JSON.parse(source).cases.find(c=>c.name==='amm-public-plain-buy');
const nativePath='/api/tbc/utxo/address/'+address;
const preferred=sample.replies[nativePath].utxos[0];
const row=(n,value,height=829999)=>({txid:n.toString(16).padStart(64,'0'),index:0,value:String(value),height});
for(const spec of [
 {name:'amm-funding-largest-first',rows:[row(1,1000),preferred,row(2,2000)]},
 {name:'amm-funding-cap-100',rows:[...Array.from({length:101},(_,i)=>row(i+1,1000+i)),preferred]},
 {name:'amm-funding-confirmed-only',floor:'1',rows:[row(1,Number(preferred.value)*2,0),preferred,row(2,2000)]},
 {name:'amm-funding-explicit-one',rows:[row(1,1000),preferred],selected:[preferred]},
 {name:'amm-funding-explicit-two-rejected',rows:[row(1,1000),preferred],selected:[row(1,1000),preferred],reject:true},
]){
 const replies=structuredClone(sample.replies),request=structuredClone(sample.request),trace=[],snapshotId=spec.name,minConfirmations=spec.floor??'0';
 replies[nativePath]={utxos:spec.rows};
 if(spec.selected){
  request.constraints.inputOutpoints=[...spec.selected.map(p=>({txid:p.txid,vout:p.index})),
   ...sample.audit.material.snapshot.payload.utxos.filter(u=>u.classification!=='native').map(({txid,vout})=>({txid,vout}))].sort((a,b)=>a.txid.localeCompare(b.txid)||a.vout-b.vout);
 }
 const network=o.kit.createDefaultTbcNetwork({network:o.kit.createTbcNetworkContext({network:'testnet'}),accounts:{current:async()=>[account]},
  poolNative:o.keyless,now:()=>Date.parse(now),snapshotId:()=>snapshotId,confirmationPolicy:{minConfirmations},
  fetch:async(url,init)=>{assert.equal(init?.method??'GET','GET');const path=new URL(String(url)).pathname;trace.push(path);
   if(path.startsWith('/api/tbc/decode/txid/')){
    const txid=path.split('/').at(-1),hex=replies['/api/tbc/txraw/txid/'+txid]?.txraw;assert(hex,path);
    const tx=o.api.inspectTbcTransaction(hex).transaction;
    replies[path]={txid,hex,confirmations:2,vin:tx.inputs.map(({txid,vout})=>({txid,vout})),
     vout:tx.outputs.map((p,n)=>({n,valueSat:p.satoshis.toString(),scriptPubKey:{hex:Buffer.from(p.scriptPubKey).toString('hex'),addresses:[]}}))};
   }
   assert(replies[path],path);return new Response(JSON.stringify({code:200,data:replies[path]}));}});
 const snapshot=await network.chainData.resolve({version:'1.0',chainId:account.chainId,accountId:account.accountId,requirement:o.kit.chainDataRequirement(request)},account);
 if(spec.reject)assert.equal(snapshot.portError?.name,'CONFLICT');else assert(snapshot.snapshotHash,JSON.stringify(snapshot));
 let signed;
 if(!spec.reject){const policy=await network.resolvePolicy({request,requestHash:hash(request),snapshotHash:snapshot.snapshotHash});
  signed=await o.sign(spec.name,request,snapshot,policy,{captureStages:true});
  assert.equal(canonical(signed.result.transactions),canonical(sample.result.transactions));
  assert.equal(snapshot.payload.utxos.filter(u=>u.classification==='native')[0].txid,preferred.txid);
 }
 cases.push({name:spec.name,request,account,now,snapshotId,minConfirmations,replies,trace,snapshot,...(signed??{})});
 console.log(JSON.stringify({name:spec.name,reads:trace.length,native:snapshot.payload?.utxos.filter(u=>u.classification==='native').length,status:snapshot.snapshotHash?'pass':snapshot.portError}));
}
await writeFile(join(base,'test/fixtures/amm-funding.json'),JSON.stringify({status:'FROZEN_AMM_FUNDING_ORACLE',archiveSha256:o.archiveSha256,
 sourceSha256:sha(source),networkHttp:0,broadcasts:0,cases},null,2)+'\n',{flag:'wx'});
