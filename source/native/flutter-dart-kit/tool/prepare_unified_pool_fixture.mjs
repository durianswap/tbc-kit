// Generic AMM/LP oracles from the immutable accepted Kit, not this Dart router.
// Public synthetic materials only. No HTTP, private account or broadcast.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {base,frozenOracle,sha,hash,canonical} from './frozen_oracle.mjs';
const o=await frozenOracle(),cases=[],sources={},unsupportedExplicit=[];
function unified(s){
 const r=structuredClone(s.request),i=r.intent,t=i.type;
 const direct={'tbc-amm-swap':'amm.swap','tbc-amm-add-liquidity':'amm.addLiquidity',
  'tbc-amm-remove-liquidity':'amm.removeLiquidity','tbc.pool.ft.merge':'amm.mergeToken',
  'tbc.pool.ftlp.merge':'tbc20Lp.merge','tbc.pool.ftlp.burn':'tbc20Lp.burn',
  'tbc20-lp-transfer':'tbc20Lp.transfer','tbc20-lp-merge':'tbc20Lp.merge',
  'tbc20-lp-lock':'tbc20Lp.lock','tbc20-lp-unlock':'tbc20Lp.unlock',
  'tbc.pool.liquidity.remove':'amm.removeLiquidity'};
 if(direct[t])i.type=direct[t];
 else if(t==='tbc.pool.liquidity.add'){
  i.type='amm.addLiquidity';i.budgetAsset='tbc';i.amount=i.tbcAmount;delete i.tbcAmount;
  if(i.lockUntilHeight!==undefined){i.lockTime=i.lockUntilHeight;delete i.lockUntilHeight;}
 }else{
  const buy=t==='tbc.pool.swap.exactTbcForToken';assert(buy||t==='tbc.pool.swap.exactTokenForTbc');
  i.type='amm.swap';i.direction=buy?'tbc-to-ft':'ft-to-tbc';
  i.amount=i[buy?'tbcAmount':'ftAmount'];i.minimumOutput=i[buy?'minimumFtAmount':'minimumTbcAmount'];
  delete i.tbcAmount;delete i.ftAmount;delete i.minimumFtAmount;delete i.minimumTbcAmount;
 }
 return r;
}
for(const file of ['pool2-signing','pool2-maintenance','amm-business-signing','lp-signing']){
 const bytes=await readFile(join(base,`test/fixtures/${file}.json`));sources[file]=sha(bytes);
 const f=JSON.parse(bytes);assert.equal(f.archiveSha256,o.archiveSha256);
 for(const s of f.cases){
  const name='unified-'+s.name,trace=[],nativeCalls=[],request=(await o.call('normalizeRequest',{version:'1.0',request:unified(s)})).request;
  const origin=s.replies['/api/tbc/txraw/txid/'+request.intent.poolContractId];assert(origin?.txraw);
  const hint=JSON.parse(await o.keyless.execute('inspectAmmMaterial',JSON.stringify({phase:'identifyPoolOrigin',pool:{txid:request.intent.poolContractId,rawTransaction:origin.txraw}})));
  const native={protocolInfo:()=>o.keyless.protocolInfo(),execute:async(method,input)=>{
   const result=await o.keyless.execute(method,input);nativeCalls.push({method,input:JSON.parse(input),result:JSON.parse(result)});return result;}};
  const network=o.kit.createDefaultTbcNetwork({network:o.kit.createTbcNetworkContext({network:'testnet'}),accounts:{current:async()=>[s.account]},poolNative:native,
   now:()=>Date.parse(s.now),snapshotId:()=>s.snapshotId,confirmationPolicy:{minConfirmations:s.minConfirmations},
   fetch:async(url,init)=>{assert.equal(init?.method??'GET','GET');const path=new URL(String(url)).pathname;trace.push(path);
    assert(s.replies[path],'Unexpected unified read '+path);return new Response(JSON.stringify({code:200,data:s.replies[path]}));}});
  const requirement=o.kit.chainDataRequirement(request);
  const snapshot=await network.chainData.resolve({version:'1.0',chainId:s.account.chainId,accountId:s.account.accountId,requirement},s.account);
  assert(snapshot.snapshotHash,name+JSON.stringify(snapshot));
  const policy=await network.resolvePolicy({request,requestHash:hash(request),snapshotHash:snapshot.snapshotHash});assert(policy.policyHash);
  const signed=await o.sign(name,request,snapshot,policy,{captureStages:true});
  // Different request/binding identifiers must not change transaction economics.
  assert.deepEqual(signed.result.transactions,s.result.transactions,name);
  assert.equal(signed.result.totalFee,s.result.totalFee,name);
  const coldTrace=[...trace],calls=[...nativeCalls];trace.length=0;nativeCalls.length=0;
  const warm=await network.chainData.resolve({version:'1.0',chainId:s.account.chainId,accountId:s.account.accountId,requirement},s.account);
  assert.equal(canonical(warm),canonical(snapshot));
  cases.push({name,source:file,concreteName:s.name,concreteRequest:s.request,generation:hint.generation,
   network:s.network,now:s.now,snapshotId:s.snapshotId,minConfirmations:s.minConfirmations,method:s.method,
   account:s.account,request,requirement,replies:s.replies,coldTrace,warmTrace:[...trace],nativeCalls:calls,...signed});
  console.log(JSON.stringify({name,generation:hint.generation,cold:coldTrace.length,warm:trace.length,fee:signed.result.totalFee}));
  if(file.startsWith('pool2')){
   const r=structuredClone(s.request),u=s.audit.material.snapshot.payload.utxos[0];
   r.constraints.inputOutpoints=[{txid:u.txid,vout:u.vout}];
   let error;try{await o.call('normalizeRequest',{version:'1.0',request:r});}catch(e){error=JSON.parse(e.message.split('\n')[0]);}
   assert.equal(error?.code,'INVALID_INPUT');assert.equal(error?.path,'request.constraints.inputOutpoints');
   unsupportedExplicit.push({name:s.name,request:r,error,networkReads:0,signatures:0});
  }
 }
}
await writeFile(join(base,'test/fixtures/unified-pool-signing.json'),JSON.stringify({
 status:'FROZEN_UNIFIED_POOL_ORACLE',archiveSha256:o.archiveSha256,wasmSha256:o.wasmSha256,sources,
 publicScalarOneOnly:true,networkHttp:0,broadcasts:0,unsupportedExplicit,cases},null,2)+'\n',{flag:'wx'});
