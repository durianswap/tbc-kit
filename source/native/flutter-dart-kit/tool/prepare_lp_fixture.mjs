// Frozen public LP holder vectors: no HTTP, private funds or broadcast.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {base,repo,frozenOracle,sha,hash,canonical,address,account,publicKey,now} from './frozen_oracle.mjs';
const o=await frozenOracle(),cases=[];
const bytes=await readFile(join(repo,'packages/tbc-engine/rust/fixtures/amm-lp-proof.json'));
const f=JSON.parse(bytes),raw=txid=>({txid,rawTransaction:f.raws[txid]});
const inspect=async x=>JSON.parse(await o.keyless.execute('inspectAmmMaterial',JSON.stringify(x)));
function decoded(txid){
 const transaction=o.api.inspectTbcTransaction(f.raws[txid]).transaction;
 return {txid,hex:f.raws[txid],confirmations:2,
  vin:transaction.inputs.map(({txid,vout})=>({txid,vout})),
  vout:transaction.outputs.map((output,n)=>({n,valueSat:output.satoshis.toString(),scriptPubKey:{hex:Buffer.from(output.scriptPubKey).toString('hex'),addresses:[]}}))};
}
const specs=[
 {name:'lp-plain-transfer',label:'public-plain',kind:'transfer'},
 {name:'lp-plain-merge',label:'public-plain',kind:'merge'},
 {name:'lp-locked-transfer',label:'controller-locked',kind:'transfer'},
 {name:'lp-locked-lock',label:'controller-locked',kind:'lock'},
 {name:'lp-locked-merge',label:'controller-locked',kind:'merge'},
 {name:'lp-locked-unlock',label:'controller-locked',kind:'unlock'},
 {name:'lp-selected-transfer',label:'public-plain',kind:'transfer',selected:true},
 {name:'lp-unknown-height',label:'controller-locked',kind:'transfer',unknown:true},
 {name:'lp-positive-floor',label:'controller-locked',kind:'transfer',unknown:true,floor:'1'},
];
for(const spec of specs){
 const {name,label,kind}=spec,snapshotId=name,trace=[],replies={},minConfirmations=spec.floor??'0';
 const seq=f.sequences.find(s=>s.label===label),poolId=seq.transactions[2],genesis=raw(poolId);
 const vector=f.vectors.find(v=>v.id===label+'-'+(kind==='lock'?'transfer':kind)+'-0');assert(vector);
 const parentInputs=o.api.inspectTbcTransaction(vector.currentRaw).transaction.inputs.map(({txid,vout})=>({txid,vout}));
 const native=parentInputs.at(-1),holders=parentInputs.slice(0,-1);
 const nativeOutput=o.api.inspectTbcTransaction(f.raws[native.txid]).transaction.outputs[native.vout];
 const meta=await inspect({phase:'inspectPool',pool:genesis});
 const desc=await inspect({phase:'describe',poolGenesis:genesis,ftGenesis:raw(meta.ftContractId),publicKey});
 const rows=[];for(const p of holders){
  const item=(await inspect({phase:'inspectAssets',parents:[raw(p.txid)],outputs:[{...p,kind:'lp'}]})).items[0];assert(item);
  rows.push({txid:p.txid,index:String(p.vout),value:'500',ft_value:item.balance,...(spec.unknown?{}:{height:'829999'})});
 }
 let request={version:'1.0',chainId:account.chainId,from:address,intent:{version:'1.0',type:'tbc20-lp-'+kind,poolContractId:poolId,
  ...(['transfer','lock'].includes(kind)?{amount:'10000'}:{}),...(kind==='transfer'?{to:'1cMh228HTCiwS8ZsaakH8A8wze1JR5ZsP'}:{}),...(kind==='lock'?{lockTime:'830100'}:{})},
  constraints:{maxFee:'100000',...(spec.selected?{inputOutpoints:parentInputs}:{})}};
 request=(await o.call('normalizeRequest',{version:'1.0',request})).request;
 const fixed={
  '/api/tbc/nodeinfo':{blocks:830000,bestblockhash:'aa'.repeat(32),mediantime:1791800000},
  ['/api/tbc/utxo/address/'+address]:{utxos:[{txid:native.txid,index:native.vout,value:nativeOutput.satoshis.toString(),height:829999}]},
  ['/api/tbc/pool/lputxo/scriptpubkeyhash/'+desc.ownerLpScriptHash]:{utxos:rows},
 };
 const network=o.kit.createDefaultTbcNetwork({network:o.kit.createTbcNetworkContext({network:'testnet'}),accounts:{current:async()=>[account]},poolNative:o.keyless,now:()=>Date.parse(now),snapshotId:()=>snapshotId,confirmationPolicy:{minConfirmations},
  fetch:async(url,init)=>{assert.equal(init?.method??'GET','GET');const path=new URL(String(url)).pathname;trace.push(path);
   const tx=path.startsWith('/api/tbc/txraw/txid/')?path.split('/').at(-1):null,decode=path.startsWith('/api/tbc/decode/txid/')?path.split('/').at(-1):null;
   const value=tx?{txraw:f.raws[tx]}:decode?decoded(decode):fixed[path];assert(value&&(!tx||value.txraw)&&(!decode||value.hex),'Unexpected LP read '+path);replies[path]=value;
   return new Response(JSON.stringify({code:200,data:value}));}});
 const requirement=o.kit.chainDataRequirement(request);
 const snapshot=await network.chainData.resolve({version:'1.0',chainId:account.chainId,accountId:account.accountId,requirement},account);assert(snapshot.snapshotHash,name+JSON.stringify(snapshot));
 const policy=await network.resolvePolicy({request,requestHash:hash(request),snapshotHash:snapshot.snapshotHash});assert(policy.policyHash);
 const signed=await o.sign(name,request,snapshot,policy,{captureStages:true}),coldTrace=[...trace];trace.length=0;
 const warm=await network.chainData.resolve({version:'1.0',chainId:account.chainId,accountId:account.accountId,requirement},account);assert.equal(canonical(warm),canonical(snapshot));
 assert(!coldTrace.some(p=>p.includes('/poolinfo/')||p.includes('/ft/utxo/')));
 cases.push({name,network:'testnet',now,snapshotId,minConfirmations,method:'tbc_signTransaction',account,request,requirement,replies,coldTrace,warmTrace:[...trace],...signed});
 console.log(JSON.stringify({name,reads:coldTrace.length,warm:trace.length,fee:signed.result.totalFee,warnings:signed.audit.preview.warnings,stages:signed.audit.stages.map(s=>s.tasks.length)}));
}
await writeFile(join(base,'test/fixtures/lp-signing.json'),JSON.stringify({status:'FROZEN_PUBLIC_LP_HOLDER_ORACLE',archiveSha256:o.archiveSha256,wasmSha256:o.wasmSha256,upstreamFixtureSha256:sha(bytes),publicScalarOneOnly:true,broadcasts:0,networkHttp:0,cases},null,2)+'\n',{flag:'wx'});
