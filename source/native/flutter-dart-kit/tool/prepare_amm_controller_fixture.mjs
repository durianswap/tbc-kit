// Independent-controller frozen oracle. No runtime key lookup or default grant.
// Upstream public fixtures
// are not spendable funds; this generator has no network or broadcast callback.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {base,repo,frozenOracle,sha,hash,canonical,address,account,publicKey,now} from './frozen_oracle.mjs';
const o=await frozenOracle(),cases=[];
const controller={chainId:account.chainId,address:'1cMh228HTCiwS8ZsaakH8A8wze1JR5ZsP',accountId:account.chainId+':1cMh228HTCiwS8ZsaakH8A8wze1JR5ZsP',publicKey:'02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5'};
const signingRoles=[{role:'pool-controller',accountId:controller.accountId}];
const source=await readFile(join(repo,'packages/tbc-engine/rust/fixtures/amm-pool-proof.json'));
const upstream=JSON.parse(source);
const parse=id=>o.api.inspectTbcTransaction(upstream.raws[id]).transaction;
const raw=id=>({txid:id,rawTransaction:upstream.raws[id]});
const inspect=async x=>JSON.parse(await o.keyless.execute('inspectAmmMaterial',JSON.stringify(x)));
for(const label of ['controller-plain','controller-locked'])for(const kind of ['add','buy','sell','remove']){
 const name='amm-'+label+'-'+kind,snapshotId=name,trace=[],replies={};
 const vector=upstream.vectors.find(v=>v.id===label+'-'+kind);
 const poolId=upstream.vectors.find(v=>v.id===label+'-add').parentTxid;
 const current=raw(vector.parentTxid),genesis=raw(poolId),meta=await inspect({phase:'inspectPool',pool:genesis});
 const action=kind==='add'?{kind:'addTbc',amount:'100000',initialFtAmount:'200000'}:
   {kind,amount:kind==='sell'?'1000':'10000'};
 const desc=await inspect({phase:'describe',poolGenesis:genesis,ftGenesis:raw(meta.ftContractId),currentPool:current,publicKey,controllerPublicKey:controller.publicKey,action});
 const fields=kind==='add'?{type:'tbc-amm-add-liquidity',budgetAsset:'tbc',amount:'100000',initialFtAmount:'200000',minimumLpAmount:'0',...(label.endsWith('locked')?{lockTime:'829999'}:{})}:
   kind==='remove'?{type:'tbc-amm-remove-liquidity',lpAmount:'10000',minimumTbcAmount:'0',minimumFtAmount:'0'}:
   {type:'tbc-amm-swap',direction:kind==='buy'?'tbc-to-ft':'ft-to-tbc',amount:action.amount,minimumOutput:'0'};
 const request={version:'1.0',chainId:account.chainId,from:address,signingRoles,intent:{version:'1.0',poolContractId:poolId,...fields},constraints:{maxFee:'100000'}};
 const inputs=o.api.inspectTbcTransaction(vector.currentRaw).transaction.inputs;
 const native=inputs[kind==='buy'?1:3],poolFt=inputs[2],holder=kind==='buy'?null:inputs[1];
 const output=p=>parse(p.txid).outputs[p.vout];
 const asset=async(p,kind)=>{
  const parsed=await inspect({phase:'inspectAssets',parents:[raw(p.txid)],outputs:[{txid:p.txid,vout:p.vout,kind}]});
  assert.equal(parsed.items.length,1);
  return {txid:p.txid,index:p.vout,value:output(p).satoshis.toString(),ft_value:parsed.items[0].balance,height:829999};
 };
 const fixed={
  '/api/tbc/nodeinfo':{blocks:830000,bestblockhash:'aa'.repeat(32),mediantime:1791800000},
  ['/api/tbc/utxo/address/'+address]:{utxos:[{txid:native.txid,index:native.vout,value:output(native).satoshis.toString(),height:829999}]},
  ['/api/tbc/pool/poolinfo/poolid/'+poolId]:{txid:current.txid,vout:'0',value:parse(current.txid).outputs[0].satoshis.toString(),pool_code_script:desc.poolCodeScript,
   ft_contract_id:meta.ftContractId,token_balance:desc.state.ftAmount,lp_balance:desc.state.lpAmount,tbc_balance:desc.state.tbcAmount,service_fee_rate:desc.serviceFeeRate},
  [`/api/tbc/ft/utxo/combinescript/${desc.poolCombineScript}/contract/${meta.ftContractId}`]:{utxos:[await asset(poolFt,'ft')]},
 };
 if(holder){const path=kind==='remove'?`/api/tbc/pool/lputxo/scriptpubkeyhash/${desc.ownerLpScriptHash}`:
  `/api/tbc/ft/utxo/combinescript/${desc.ownerCombineScript}/contract/${meta.ftContractId}`;
  fixed[path]={utxos:[await asset(holder,kind==='remove'?'lp':'ft')]};}
 const network=o.kit.createDefaultTbcNetwork({network:o.kit.createTbcNetworkContext({network:'testnet'}),accounts:{current:async()=>[account,controller]},poolNative:o.keyless,now:()=>Date.parse(now),snapshotId:()=>snapshotId,
  fetch:async(url,init)=>{assert.equal(init?.method??'GET','GET');const path=new URL(String(url)).pathname;trace.push(path);
   const id=path.startsWith('/api/tbc/txraw/txid/')?path.split('/').at(-1):null;
   const value=id?{txraw:upstream.raws[id]}:fixed[path];assert(value&&(!id||value.txraw),'Unexpected AMM read '+path);replies[path]=value;
   return new Response(JSON.stringify({code:200,data:value}));}});
 const requirement=o.kit.chainDataRequirement(request);
 const snapshot=await network.chainData.resolve({version:'1.0',chainId:account.chainId,accountId:account.accountId,requirement,signingRoles,signingAccounts:[controller]},account);assert(snapshot.snapshotHash,name+JSON.stringify(snapshot));
 const policy=await network.resolvePolicy({request,requestHash:hash(request),snapshotHash:snapshot.snapshotHash});assert(policy.policyHash);
 const signed=await o.sign(name,request,snapshot,policy,{captureStages:true,fixtureRoleAccounts:[controller]}),coldTrace=[...trace];trace.length=0;
 const warm=await network.chainData.resolve({version:'1.0',chainId:account.chainId,accountId:account.accountId,requirement,signingRoles,signingAccounts:[controller]},account);assert.equal(canonical(warm),canonical(snapshot));
 cases.push({name,network:'testnet',now,snapshotId,minConfirmations:'0',method:'tbc_signTransaction',account,additionalAccounts:[controller],request,requirement,replies,coldTrace,warmTrace:[...trace],...signed});
 console.log(JSON.stringify({name,reads:coldTrace.length,warm:trace.length,fee:signed.result.totalFee,warnings:signed.audit.preview.warnings,stages:signed.audit.stages.map(s=>s.tasks.length)}));
}
await writeFile(join(base,'test/fixtures/amm-controller-signing.json'),JSON.stringify({status:'FROZEN_INDEPENDENT_CONTROLLER_AMM_ORACLE',archiveSha256:o.archiveSha256,wasmSha256:o.wasmSha256,upstreamFixtureSha256:sha(source),publicFixtureScalars:[1,2],broadcasts:0,networkHttp:0,cases},null,2)+'\n',{flag:'wx'});
