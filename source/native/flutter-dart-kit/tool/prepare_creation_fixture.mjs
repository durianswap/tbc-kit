// Immutable frozen Kit oracle for new-standard issuance, synthetic funds only.
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {frozenOracle,base,hash,canonical,address,account,now} from './frozen_oracle.mjs';
const o=await frozenOracle(),cases=[];
const row=(n,value)=>({txid:n.toString(16).padStart(64,'0'),index:0,value:String(value),height:990});
for(const spec of [
 {name:'create-tbc20-single',rows:[row(1,5000000)]},
 {name:'create-tbc20-fragmented',rows:[row(2,700),row(1,700),row(3,700)]},
 {name:'create-tbc20-selected',rows:[row(1,5000000),row(2,5000000)],points:[{txid:row(2,0).txid,vout:0}]},
 {name:'create-collection-single',nft:true,supply:'1',rows:[row(1,5000000)]},
 {name:'create-collection-three',nft:true,supply:'3',rows:[row(2,5000000),row(1,5000000)]},
 {name:'create-collection-selected',nft:true,supply:'3',rows:[row(1,5000000),row(2,5000000)],points:[{txid:row(2,0).txid,vout:0}]},
]){
 const snapshotId=spec.name,trace=[];
 const request={version:'1.0',chainId:account.chainId,from:address,
  intent:spec.nft?{version:'1.0',type:'tbc721-standard-create-collection',name:'Collection',description:'Offline public fixture',supply:spec.supply,media:{kind:'uri',uri:'ipfs://synthetic'}}:
   {version:'1.0',type:'tbc20-standard-create',name:'Token',symbol:'TBCX',decimals:6,initialSupply:'123456'},
  constraints:{maxFee:'100000',...(spec.points?{inputOutpoints:spec.points}:{})}};
 const replies={'/api/tbc/nodeinfo':{blocks:1000,bestblockhash:'aa'.repeat(32)},['/api/tbc/utxo/address/'+address]:{utxos:spec.rows}};
 const network=o.kit.createDefaultTbcNetwork({network:o.kit.createTbcNetworkContext({network:'testnet'}),accounts:{current:async()=>[account]},poolNative:o.keyless,now:()=>Date.parse(now),snapshotId:()=>snapshotId,
  fetch:async(url,init)=>{assert.equal(init?.method??'GET','GET');const p=new URL(String(url)).pathname;trace.push(p);assert(replies[p],p);return new Response(JSON.stringify({code:200,data:replies[p]}));}});
 const requirement={intentType:request.intent.type,includeAncestry:false,assets:[{kind:'native'}],...(spec.points?{inputOutpoints:spec.points}:{})};
 const snapshot=await network.chainData.resolve({version:'1.0',chainId:account.chainId,accountId:account.accountId,requirement},account);assert(snapshot.snapshotHash,spec.name+JSON.stringify(snapshot));
 const policy=await network.resolvePolicy({request,requestHash:hash(request),snapshotHash:snapshot.snapshotHash});assert(policy.policyHash);
 const signed=await o.sign(spec.name,request,snapshot,policy,{captureStages:true}),coldTrace=[...trace];trace.length=0;
 const warm=await network.chainData.resolve({version:'1.0',chainId:account.chainId,accountId:account.accountId,requirement},account);assert.equal(canonical(warm),canonical(snapshot));
 cases.push({name:spec.name,network:'testnet',now,snapshotId,minConfirmations:'0',method:'tbc_signTransaction',account,request,replies,coldTrace,warmTrace:[...trace],...signed});
 console.log(JSON.stringify({name:spec.name,reads:coldTrace.length,fee:signed.result.totalFee,preview:signed.audit.preview,stages:signed.audit.stages.map(s=>s.tasks.length)}));
}
await writeFile(join(base,'test/fixtures/creation-signing.json'),JSON.stringify({status:'FROZEN_NEW_ASSET_CREATION_ORACLE',archiveSha256:o.archiveSha256,wasmSha256:o.wasmSha256,publicScalarOneOnly:true,broadcasts:0,networkHttp:0,cases},null,2)+'\n',{flag:'wx'});
