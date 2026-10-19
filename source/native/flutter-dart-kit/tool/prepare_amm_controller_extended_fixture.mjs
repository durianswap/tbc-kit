// Frozen Kit oracle: controller aliases and controller appearing only after a
// signed native-funding prerequisite. Public synthetic keys 1/2, zero network.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {base,frozenOracle,sha,hash,canonical,address} from './frozen_oracle.mjs';
const o=await frozenOracle(),sourceBytes=await readFile(join(base,'test/fixtures/amm-controller-signing.json'));
const source=JSON.parse(sourceBytes),cases=[],known={};
assert.equal(source.archiveSha256,o.archiveSha256);
for(const s of source.cases)for(const [p,v]of Object.entries(s.replies))if(p.startsWith('/api/tbc/txraw/txid/'))known[p.split('/').at(-1)]=v.txraw;
const nativePath='/api/tbc/utxo/address/'+address,script='76a914751e76e8199196d454941c45d1b3a323f1433bd688ac';
function funding(index,amount){
 const vin=Buffer.alloc(4),value=Buffer.alloc(8);vin.writeUInt32LE(index);value.writeBigUInt64LE(BigInt(amount));
 const raw='0a00000001'+'aa'.repeat(32)+vin.toString('hex')+'00ffffffff01'+value.toString('hex')+'19'+script+'00000000';
 const txid=o.api.turingTransactionId(raw);known[txid]=raw;return {txid,index:0,value:String(amount),height:829999};
}
async function record(s,name,request,fixed,stages){
 request=(await o.call('normalizeRequest',{version:'1.0',request})).request;
 const trace=[],replies={},controller=s.additionalAccounts[0];
 const network=o.kit.createDefaultTbcNetwork({network:o.kit.createTbcNetworkContext({network:'testnet'}),
  accounts:{current:async()=>[s.account,controller]},poolNative:o.keyless,now:()=>Date.parse(s.now),snapshotId:()=>name,
  fetch:async(url,init)=>{assert.equal(init?.method??'GET','GET');const path=new URL(String(url)).pathname;trace.push(path);
   const id=path.startsWith('/api/tbc/txraw/txid/')?path.split('/').at(-1):null;
   const value=id?{txraw:known[id]}:fixed[path];assert(value&&(!id||value.txraw),'Unexpected controller read '+path);
   replies[path]=value;return new Response(JSON.stringify({code:200,data:value}));}});
 const requirement=o.kit.chainDataRequirement(request);
 const args={version:'1.0',chainId:s.account.chainId,accountId:s.account.accountId,requirement,signingRoles:request.signingRoles,signingAccounts:[controller]};
 const snapshot=await network.chainData.resolve(args,s.account);assert(snapshot.snapshotHash,name+JSON.stringify(snapshot));
 const policy=await network.resolvePolicy({request,requestHash:hash(request),snapshotHash:snapshot.snapshotHash});assert(policy.policyHash);
 const signed=await o.sign(name,request,snapshot,policy,{captureStages:true,fixtureRoleAccounts:[controller]});
 assert.equal(signed.audit.stages.length,stages);
 if(stages===2){
  assert(signed.audit.stages[0].tasks.every(t=>t.accountId===s.account.accountId));
  assert.equal(signed.audit.stages[1].tasks.filter(t=>t.accountId===controller.accountId).length,1);
 }else{assert.deepEqual(signed.result.transactions,s.result.transactions);assert.equal(signed.result.totalFee,s.result.totalFee);}
 const coldTrace=[...trace];trace.length=0;
 const warm=await network.chainData.resolve(args,s.account);assert.equal(canonical(warm),canonical(snapshot));
 cases.push({name,network:'testnet',now:s.now,snapshotId:name,minConfirmations:'0',method:s.method,
  account:s.account,additionalAccounts:[controller],request,requirement,replies,coldTrace,warmTrace:[...trace],...signed});
 console.log(JSON.stringify({name,reads:coldTrace.length,warm:trace.length,stages:signed.audit.stages.map(x=>x.tasks.length),fee:signed.result.totalFee}));
}
for(const s of source.cases){
 const request=structuredClone(s.request);
 request.intent.type={'tbc-amm-add-liquidity':'amm.addLiquidity','tbc-amm-remove-liquidity':'amm.removeLiquidity','tbc-amm-swap':'amm.swap'}[request.intent.type];
 await record(s,'unified-'+s.name,request,s.replies,1);
}
for(const s of source.cases.filter(s=>s.name.includes('controller-plain'))){
 const original=s.audit.material,natives=original.snapshot.payload.utxos.filter(u=>u.classification==='native');assert.equal(natives.length,1);
 let low=0,high=Number(natives[0].satoshis);
 while(low+1<high){
  const mid=Math.floor((low+high)/2),p=structuredClone(original),candidate=funding(0,mid);
  p.snapshot.payload.utxos=p.snapshot.payload.utxos.map(u=>u.classification==='native'?{...u,txid:candidate.txid,vout:0,satoshis:String(mid)}:u);
  p.snapshot.payload.parents.push({txid:candidate.txid,rawTransaction:known[candidate.txid]});p.snapshot.snapshotHash=hash(p.snapshot.payload);
  try{await o.call('plan',p);high=mid;}catch{low=mid;}
 }
 assert(high>1&&high<Number(natives[0].satoshis));
 const fixed=structuredClone(s.replies),rows=[0,1,2].map(i=>funding(i,high-1));fixed[nativePath]={utxos:rows};
 await record(s,'dependent-'+s.name,s.request,fixed,2);
 const ids=new Set(rows.map(r=>r.txid));assert.equal(cases.at(-1).coldTrace.filter(p=>ids.has(p.split('/').at(-1))).length,1);
}
await writeFile(join(base,'test/fixtures/amm-controller-extended.json'),JSON.stringify({status:'FROZEN_CONTROLLER_ALIAS_DEPENDENT_ORACLE',
 archiveSha256:o.archiveSha256,wasmSha256:o.wasmSha256,sourceSha256:sha(sourceBytes),publicFixtureScalars:[1,2],networkHttp:0,broadcasts:0,cases},null,2)+'\n',{flag:'wx'});
