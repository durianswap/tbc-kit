// Frozen Kit + WASM oracle, fabricated funds/public scalar 1; never broadcast.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {frozenOracle,base,sha,hash,canonical,address,account,now} from './frozen_oracle.mjs';
const o=await frozenOracle(),cases=[];
const creationBytes=await readFile(join(base,'test/fixtures/creation-signing.json'));
const creation=JSON.parse(creationBytes).cases.find(s=>s.name==='create-collection-three').result.transactions[0];
const collectionId=creation.txid,tx=o.api.inspectTbcTransaction(creation.rawTransaction).transaction;
const script=Buffer.from(tx.outputs[1].scriptPubKey).toString('hex');
const scriptHash=Buffer.from(sha(Buffer.from(script,'hex')),'hex').reverse().toString('hex');
const native={txid:'22'.repeat(32),index:0,value:'10000000',height:990};
const metadata=slot=>({slot,name:'NFT '+slot,symbol:'N'+slot,description:'Offline public NFT',attributes:[{traitType:'kind',value:'synthetic'},{traitType:'number',value:-1},{traitType:'flag',value:true}],media:{kind:'uri',uri:'ipfs://synthetic-'+slot}});
for(const spec of [
 {name:'mint-single',slots:[1]},
 {name:'mint-batch',slots:[1,3],batch:true},
 {name:'mint-batch-reversed',slots:[3,1],batch:true},
 {name:'mint-single-index-lag',slots:[1],missing:[1]},
 {name:'mint-batch-index-lag',slots:[1,3],missing:[3],batch:true},
 {name:'mint-unknown-zero',slots:[2],unknown:true},
 {name:'mint-unknown-positive',slots:[2],unknown:true,floor:'1'},
]){
 const minConfirmations=spec.floor??'0',snapshotId=spec.name,trace=[];
 const request={version:'1.0',chainId:account.chainId,from:address,
  intent:spec.batch?{type:'tbc721-standard-batch-mint',version:'1.0',collectionId,items:spec.slots.map(metadata)}:
   {type:'tbc721-standard-mint',version:'1.0',collectionId,...metadata(spec.slots[0])},constraints:{maxFee:'10000'}};
 const replies={'/api/tbc/nodeinfo':{blocks:1000,bestblockhash:'aa'.repeat(32)},
  ['/api/tbc/utxo/address/'+address]:{utxos:[native]},
  ['/api/tbc/txraw/txid/'+collectionId]:{txraw:creation.rawTransaction},
  ['/api/tbc/decode/txid/'+collectionId]:{txid:collectionId,hex:creation.rawTransaction,confirmations:11,
   vin:tx.inputs.map(i=>({txid:i.txid,vout:i.vout})),
   vout:tx.outputs.map((o,n)=>({n,valueSat:o.satoshis.toString(),scriptPubKey:{hex:Buffer.from(o.scriptPubKey).toString('hex'),addresses:[]}}))},
  ['/api/tbc/utxo/scriptpubkeyhash/'+scriptHash]:{utxos:[1,2,3].filter(i=>!spec.missing?.includes(i)).map(i=>({txid:collectionId,index:i,value:100,...(spec.unknown?{}:{height:990})}))},
 };
 const statusBody={txos:(spec.missing??[]).map(index=>({txid:collectionId,index}))};
 const statusReply={results:(spec.missing??[]).map(index=>({txid:collectionId,index,value:100,scriptpubkey:script,status:{spent:false},height:990}))};
 const network=o.kit.createDefaultTbcNetwork({network:o.kit.createTbcNetworkContext({network:'testnet'}),accounts:{current:async()=>[account]},poolNative:o.keyless,now:()=>Date.parse(now),snapshotId:()=>snapshotId,confirmationPolicy:{minConfirmations},
  fetch:async(input,init)=>{const path=new URL(String(input)).pathname,method=init?.method??'GET';trace.push({method,path});
   if(path==='/api/tbc/txo/status'){assert.equal(method,'POST');assert.equal(canonical(JSON.parse(init.body)),canonical(statusBody));return new Response(JSON.stringify({code:200,data:statusReply}));}
   assert.equal(method,'GET');assert(replies[path],path);return new Response(JSON.stringify({code:200,data:replies[path]}));}});
 const requirement={intentType:request.intent.type,includeAncestry:true,contractIds:[collectionId],collectionSlots:spec.slots,assets:[{kind:'native'},{kind:'collection',contractId:collectionId,minimumAmount:String(spec.slots.length)}]};
 const snapshot=await network.chainData.resolve({version:'1.0',chainId:account.chainId,accountId:account.accountId,requirement},account);assert(snapshot.snapshotHash,spec.name+JSON.stringify(snapshot));
 const policy=await network.resolvePolicy({request,requestHash:hash(request),snapshotHash:snapshot.snapshotHash});assert(policy.policyHash);
 const signed=await o.sign(spec.name,request,snapshot,policy,{captureStages:true}),coldTrace=[...trace];trace.length=0;
 const warm=await network.chainData.resolve({version:'1.0',chainId:account.chainId,accountId:account.accountId,requirement},account);assert.equal(canonical(warm),canonical(snapshot));
 cases.push({name:spec.name,network:'testnet',now,snapshotId,minConfirmations,method:'tbc_signTransaction',account,request,replies,statusBody,statusReply,coldTrace,warmTrace:[...trace],...signed});
 console.log(JSON.stringify({name:spec.name,reads:coldTrace,warm:trace,fee:signed.result.totalFee,warnings:signed.audit.preview.warnings,stages:signed.audit.stages.map(s=>s.tasks.length),family:signed.audit.stages[0].result.continuation?.family}));
}
await writeFile(join(base,'test/fixtures/nft-mint-signing.json'),JSON.stringify({status:'FROZEN_CURRENT_NFT_MINT_ORACLE',archiveSha256:o.archiveSha256,wasmSha256:o.wasmSha256,creationSourceSha256:sha(creationBytes),publicScalarOneOnly:true,broadcasts:0,networkHttp:0,cases},null,2)+'\n',{flag:'wx'});
