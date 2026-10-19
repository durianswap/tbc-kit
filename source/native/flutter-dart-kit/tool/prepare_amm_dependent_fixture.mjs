// Public synthetic offline prerequisites, built and signed by the frozen Kit.
// No live API, production key, fund movement or mutation of existing evidence.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {base,repo,frozenOracle,sha,hash,canonical,address,account,now} from './frozen_oracle.mjs';
const o=await frozenOracle(),cases=[];
const sourceBytes=await readFile(join(base,'test/fixtures/amm-business-signing.json'));
const source=JSON.parse(sourceBytes),upstreamBytes=await readFile(join(repo,'packages/tbc-engine/rust/fixtures/amm-pool-proof.json'));
const known={...JSON.parse(upstreamBytes).raws},nativePath='/api/tbc/utxo/address/'+address;
const parse=id=>o.api.inspectTbcTransaction(known[id]).transaction;
const nativeScript='76a914751e76e8199196d454941c45d1b3a323f1433bd688ac';
const sample=(action,label='public-plain')=>structuredClone(source.cases.find(s=>s.name===`amm-${label}-${action}`));
const row=(txid,index)=>({txid,index,value:String(parse(txid).outputs[index].satoshis),height:829999});
async function run(name,request,fixed,{record=false,expectedStages}={}){
 request=(await o.call('normalizeRequest',{version:'1.0',request})).request;
 const trace=[],replies={},snapshotId=name;
 const network=o.kit.createDefaultTbcNetwork({network:o.kit.createTbcNetworkContext({network:'testnet'}),accounts:{current:async()=>[account]},poolNative:o.keyless,now:()=>Date.parse(now),snapshotId:()=>snapshotId,
  fetch:async(url,init)=>{assert.equal(init?.method??'GET','GET');const p=new URL(String(url)).pathname;trace.push(p);
   const id=p.startsWith('/api/tbc/txraw/txid/')?p.split('/').at(-1):null;
   const value=id?{txraw:known[id]}:fixed[p];assert(value&&(!id||value.txraw),'Unexpected prerequisite read '+p);replies[p]=value;
   return new Response(JSON.stringify({code:200,data:value}));}});
 const requirement=o.kit.chainDataRequirement(request);
 const snapshot=await network.chainData.resolve({version:'1.0',chainId:account.chainId,accountId:account.accountId,requirement},account);
 assert(snapshot.snapshotHash,name+JSON.stringify({snapshot,trace,missing:trace.filter(p=>!replies[p])}));
 const policy=await network.resolvePolicy({request,requestHash:hash(request),snapshotHash:snapshot.snapshotHash});assert(policy.policyHash);
 const signed=await o.sign(name,request,snapshot,policy,{captureStages:true});
 if(expectedStages!==undefined)assert.equal(signed.audit.stages.length,expectedStages,name);
 if(record){
  const coldTrace=[...trace];trace.length=0;
  const warm=await network.chainData.resolve({version:'1.0',chainId:account.chainId,accountId:account.accountId,requirement},account);
  assert.equal(canonical(warm),canonical(snapshot));
  cases.push({name,network:'testnet',now,snapshotId,minConfirmations:'0',method:'tbc_signTransaction',account,request,requirement,replies,coldTrace,warmTrace:[...trace],...signed});
  console.log(JSON.stringify({name,reads:coldTrace.length,warm:trace.length,fee:signed.result.totalFee,warnings:signed.audit.preview.warnings,stages:signed.audit.stages.map(s=>s.tasks.length)}));
 }
 for(const tx of signed.result.transactions)known[tx.txid]=tx.rawTransaction;
 return signed;
}

// Native fragments: same public fake-funding recipe as the frozen Rust test.
// Find the minimum sufficient single fee output, then provide three smaller
// alternatives. Only the preferred candidate's parent may be fetched.
function funding(index,amount){
 const vin=Buffer.alloc(4),value=Buffer.alloc(8);vin.writeUInt32LE(index);value.writeBigUInt64LE(BigInt(amount));
 const raw='0a00000001'+'aa'.repeat(32)+vin.toString('hex')+'00ffffffff01'+value.toString('hex')+'19'+nativeScript+'00000000';
 const txid=o.api.turingTransactionId(raw);known[txid]=raw;return row(txid,0);
}
for(const action of ['buy','sell','add','remove']){
 const s=sample(action),original=s.audit.material,natives=original.snapshot.payload.utxos.filter(u=>u.classification==='native');
 assert.equal(natives.length,1);
 let low=0,high=Number(natives[0].satoshis);
 while(low+1<high){
  const mid=Math.floor((low+high)/2),p=structuredClone(original),candidate=funding(0,mid);
  p.snapshot.payload.utxos=p.snapshot.payload.utxos.map(u=>u.classification==='native'?{...u,txid:candidate.txid,vout:0,satoshis:String(mid)}:u);
  p.snapshot.payload.parents.push({txid:candidate.txid,rawTransaction:known[candidate.txid]});p.snapshot.snapshotHash=hash(p.snapshot.payload);
  try{await o.call('plan',p);high=mid;}catch{low=mid;}
 }
 assert(high>1&&high<Number(natives[0].satoshis),action+' single-funding threshold');
 const fixed=structuredClone(s.replies),rows=[0,1,2].map(i=>funding(i,high-1));fixed[nativePath]={utxos:rows};
 const signed=await run('amm-native-fragmented-'+action,s.request,fixed,{record:true,expectedStages:2});
 assert.equal(signed.audit.plan.payload.transactions[0].id,'native-funding-1');
 const c=cases.at(-1),nativeIds=new Set(rows.map(r=>r.txid));
 assert.equal(c.coldTrace.filter(p=>nativeIds.has(p.split('/').at(-1))).length,1);
 c.fragmentation={kind:'native',count:3,amount:String(high-1),minimumSingle:String(high),preferredParentReads:1};
}

// Asset fragments are real frozen Engine transfer outputs. Keep only those
// smaller outputs in the fresh index; the split change is outside selection.
for(const spec of [{action:'add',count:2,needed:200000,label:'public-plain'},
 {action:'sell',count:6,needed:1000,label:'public-plain'},
 {action:'remove',count:6,needed:10000,label:'public-locked'}]){
 const s=sample(spec.action,spec.label),lp=spec.action==='remove',fixed=structuredClone(s.replies),payload=s.audit.material.snapshot.payload;
 const holder=payload.utxos.find(u=>u.classification===(lp?'ftlp':'ft'));assert(holder);
 const holderPath=Object.keys(fixed).find(p=>lp?p.includes('/pool/lputxo/'):p.includes('/ft/utxo/combinescript/751e76e8199196d454941c45d1b3a323f1433bd600/'));
 assert(holderPath);let selected={txid:holder.txid,index:holder.vout},fee=structuredClone(fixed[nativePath].utxos[0]);
 const fragments=[],amount=String(Math.floor(spec.needed/spec.count)+1);
 async function asset(point){
  const inspected=JSON.parse(await o.keyless.execute('inspectAmmMaterial',JSON.stringify({phase:'inspectAssets',parents:[{txid:point.txid,rawTransaction:known[point.txid]}],outputs:[{txid:point.txid,vout:point.index,kind:lp?'lp':'ft'}]}))).items[0];
  return {...row(point.txid,point.index),tbc_value:String(parse(point.txid).outputs[point.index].satoshis),ft_value:inspected.balance};
 }
 for(let i=0;i<spec.count;i++){
  const inputs={...fixed,[holderPath]:{utxos:[await asset(selected)]},[nativePath]:{utxos:[fee]}};
  const request={version:'1.0',chainId:account.chainId,from:address,intent:{version:'1.0',type:lp?'tbc20-lp-transfer':'tbc20.transfer',
   ...(lp?{poolContractId:holder.contractId}:{contractId:holder.contractId}),to:address,amount},constraints:{maxFee:'100000'}};
  const split=await run(`amm-public-${spec.action}-split-${i}`,request,inputs,{expectedStages:1});
  const tx=split.result.transactions[0],outputs=parse(tx.txid).outputs;
  fragments.push(await asset({txid:tx.txid,index:0}));selected={txid:tx.txid,index:2};
  const feeIndex=outputs.findIndex(out=>Buffer.from(out.scriptPubKey).toString('hex')===nativeScript);assert(feeIndex>=0);fee=row(tx.txid,feeIndex);
 }
 fixed[holderPath]={utxos:fragments};fixed[nativePath]={utxos:[fee]};
 // Do not include the unselected asset change or an unrelated native input.
 s.request.constraints.inputOutpoints=[...payload.utxos.filter(u=>['pool','pool-ft'].includes(u.classification)).map(({txid,vout})=>({txid,vout})),
  ...fragments.map(({txid,index})=>({txid,vout:index})),{txid:fee.txid,vout:fee.index}];
 await run('amm-holder-fragmented-'+spec.action,s.request,fixed,{record:true,expectedStages:spec.count===2?2:3});
 cases.at(-1).fragmentation={kind:lp?'lp':'ft',count:spec.count,amount,selectedOnly:true};
}
await writeFile(join(base,'test/fixtures/amm-dependent-signing.json'),JSON.stringify({status:'FROZEN_DEPENDENT_AMM_ORACLE',archiveSha256:o.archiveSha256,wasmSha256:o.wasmSha256,
 sourceSha256:sha(sourceBytes),upstreamFixtureSha256:sha(upstreamBytes),publicScalarOneOnly:true,broadcasts:0,networkHttp:0,cases},null,2)+'\n',{flag:'wx'});
