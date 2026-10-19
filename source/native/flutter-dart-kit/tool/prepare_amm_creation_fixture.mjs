// Frozen accepted AMM contract creation; not the deferred custom-Tape redesign.
// Reuse a fabricated current FT identity, public scalar one and no transport.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {frozenOracle,base,sha,hash,canonical,address,account,now} from './frozen_oracle.mjs';
const o=await frozenOracle(),cases=[];
const creationBytes=await readFile(join(base,'test/fixtures/creation-signing.json'));
const ft=JSON.parse(creationBytes).cases.find(s=>s.name==='create-tbc20-single');
const source=ft.result.transactions[0],genesis=ft.result.transactions[1];
const row=(n,value)=>({txid:n.toString(16).padStart(64,'0'),index:0,value:String(value),height:990});
for(const spec of [
 {name:'amm-create-public',lpPlan:1,lpTimelock:false},
 {name:'amm-create-locked',lpPlan:2,lpTimelock:true},
 {name:'amm-create-controlled',lpPlan:3,lpTimelock:false,controllers:['751e76e8199196d454941c45d1b3a323f1433bd6']},
 {name:'amm-create-selected',lpPlan:6,lpTimelock:true,points:[{txid:row(8,0).txid,vout:0}]},
]){
 const snapshotId=spec.name,trace=[];
 const request={version:'1.0',chainId:account.chainId,from:address,
  intent:{version:'1.0',type:'tbc-amm-create',ftContractId:genesis.txid,lpPlan:spec.lpPlan,lpTimelock:spec.lpTimelock,...(spec.controllers?{controllers:spec.controllers}:{})},
  constraints:{maxFee:'10000',...(spec.points?{inputOutpoints:spec.points}:{})}};
 const replies={'/api/tbc/nodeinfo':{blocks:1000,bestblockhash:'aa'.repeat(32)},
  ['/api/tbc/utxo/address/'+address]:{utxos:[row(8,5000000),row(7,7000000)]},
  ['/api/tbc/txraw/txid/'+genesis.txid]:{txraw:genesis.rawTransaction},
  ['/api/tbc/txraw/txid/'+source.txid]:{txraw:source.rawTransaction}};
 const network=o.kit.createDefaultTbcNetwork({network:o.kit.createTbcNetworkContext({network:'testnet'}),accounts:{current:async()=>[account]},poolNative:o.keyless,now:()=>Date.parse(now),snapshotId:()=>snapshotId,
  fetch:async(url,init)=>{assert.equal(init?.method??'GET','GET');const p=new URL(String(url)).pathname;trace.push(p);assert(replies[p],p);return new Response(JSON.stringify({code:200,data:replies[p]}));}});
 const requirement=o.kit.chainDataRequirement(request);
 const snapshot=await network.chainData.resolve({version:'1.0',chainId:account.chainId,accountId:account.accountId,requirement},account);assert(snapshot.snapshotHash,spec.name+JSON.stringify(snapshot));
 const policy=await network.resolvePolicy({request,requestHash:hash(request),snapshotHash:snapshot.snapshotHash});assert(policy.policyHash);
 const signed=await o.sign(spec.name,request,snapshot,policy,{captureStages:true}),coldTrace=[...trace];trace.length=0;
 const warm=await network.chainData.resolve({version:'1.0',chainId:account.chainId,accountId:account.accountId,requirement},account);assert.equal(canonical(warm),canonical(snapshot));
 cases.push({name:spec.name,network:'testnet',now,snapshotId,minConfirmations:'0',method:'tbc_signTransaction',account,request,requirement,replies,coldTrace,warmTrace:[...trace],...signed});
 console.log(JSON.stringify({name:spec.name,reads:coldTrace.length,warm:trace.length,fee:signed.result.totalFee,preview:signed.audit.preview,stages:signed.audit.stages.map(s=>s.tasks.length),policy:policy.payload}));
}
await writeFile(join(base,'test/fixtures/amm-creation-signing.json'),JSON.stringify({status:'FROZEN_ACCEPTED_AMM_CREATION_ORACLE',archiveSha256:o.archiveSha256,wasmSha256:o.wasmSha256,creationSourceSha256:sha(creationBytes),publicScalarOneOnly:true,broadcasts:0,networkHttp:0,cases},null,2)+'\n',{flag:'wx'});
