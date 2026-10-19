// Public current source API -> shared chain data -> keyless Rust -> separate
// fixture signer -> Engine finalize. Not an installed package or chain proof.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {sourceOracle,root,now,canonical,hash,sha,address,publicKey,account,controller} from './source-oracle.mjs';
const o=await sourceOracle(),cases=[];
const bytes=await readFile(join(root,'packages/tbc-engine/rust/fixtures/amm-explicit173-lifecycle.json')),f=JSON.parse(bytes);
const raw=id=>({txid:id,rawTransaction:f.raws[id]});
const parse=id=>o.api.inspectTbcTransaction(f.raws[id]).transaction;
const inspect=async i=>JSON.parse(await o.keyless.execute('inspectAmmMaterial',JSON.stringify(i)));
for(const row of f.cases)for(const kind of ['create','add','buy','sell','remove']){
  const name=row.label+'-'+kind,trace=[],replies={},snapshotId=name;
  const roles=row.controlled&&kind!=='create'?[{role:'pool-controller',accountId:controller.accountId}]:[];
  const signingAccounts=roles.length?[controller]:[];
  const feePolicy={...row.rates,feeAddress:row.feeAddress};
  const fields=kind==='create'?{type:'tbc-amm-create',ftContractId:row.ftGenesisId,feePolicy,lpTimelock:row.locked,
    serviceProviderTag:Buffer.from(row.serviceProviderTag,'hex').toString('utf8'),...(row.controlled?{controllers:['06afd46bcdfd22ef94ac122aa11f241244a37ecc']}: {})}:
    kind==='add'?{type:'tbc-amm-add-liquidity',budgetAsset:'tbc',amount:'100000',initialFtAmount:'200000',minimumLpAmount:'0',...(row.locked?{lockTime:'829999'}:{})}:
    kind==='remove'?{type:'tbc-amm-remove-liquidity',lpAmount:'10000',minimumTbcAmount:'0',minimumFtAmount:'0'}:
    {type:'tbc-amm-swap',direction:kind==='buy'?'tbc-to-ft':'ft-to-tbc',amount:kind==='buy'?'10000':'1000',minimumOutput:'0'};
  const request={version:'1.0',chainId:account.chainId,from:address,...(roles.length?{signingRoles:roles}:{}),
    intent:{version:'1.0',...(kind==='create'?{}:{poolContractId:row.genesisId}),...fields},constraints:{maxFee:'100000'}};
  const currentAction=row.actions.find(a=>a.operation===kind);
  const inputs=kind==='create'?null:parse(currentAction.txid).inputs;
  const funding=kind==='create'?{txid:row.ftGenesisId,vout:row.fundingVout}:inputs[kind==='buy'?1:3];
  const output=p=>parse(p.txid).outputs[p.vout];
  const fixed={
    '/api/tbc/nodeinfo':{blocks:830000,bestblockhash:'aa'.repeat(32),mediantime:1791800000},
    ['/api/tbc/utxo/address/'+address]:{utxos:[{txid:funding.txid,index:funding.vout,value:output(funding).satoshis.toString(),height:829999}]},
  };
  if(inputs){
    const current=raw(inputs[0].txid),desc=await inspect({phase:'describe',poolGenesis:raw(row.genesisId),ftGenesis:raw(row.ftGenesisId),currentPool:current,publicKey,
      ...(roles.length?{controllerPublicKey:controller.publicKey}:{}),action:kind==='add'?{kind:'addTbc',amount:'100000',initialFtAmount:'200000'}:{kind,amount:kind==='sell'?'1000':'10000'}});
    const asset=async(p,kind)=>{const result=await inspect({phase:'inspectAssets',parents:[raw(p.txid)],outputs:[{txid:p.txid,vout:p.vout,kind}]});return {txid:p.txid,index:p.vout,value:output(p).satoshis.toString(),ft_value:result.items[0].balance,height:829999};};
    fixed['/api/tbc/pool/poolinfo/poolid/'+row.genesisId]={txid:current.txid,vout:'0',value:parse(current.txid).outputs[0].satoshis.toString(),pool_code_script:desc.poolCodeScript,
      ft_contract_id:row.ftGenesisId,token_balance:desc.state.ftAmount,lp_balance:desc.state.lpAmount,tbc_balance:desc.state.tbcAmount,
      service_fee_rate:35,lp_plan:1,service_provider:'stale-legacy-index-summary'};
    fixed[`/api/tbc/ft/utxo/combinescript/${desc.poolCombineScript}/contract/${row.ftGenesisId}`]={utxos:[await asset(inputs[2],'ft')]};
    if(kind!=='buy')fixed[kind==='remove'?`/api/tbc/pool/lputxo/scriptpubkeyhash/${desc.ownerLpScriptHash}`:
      `/api/tbc/ft/utxo/combinescript/${desc.ownerCombineScript}/contract/${row.ftGenesisId}`]={utxos:[await asset(inputs[1],kind==='remove'?'lp':'ft')]};
  }
  const network=o.kit.createDefaultTbcNetwork({network:o.kit.createTbcNetworkContext({network:'testnet'}),accounts:{current:async()=>[account,...signingAccounts]},
    poolNative:o.keyless,now:()=>Date.parse(now),snapshotId:()=>snapshotId,
    fetch:async(url,init)=>{assert.equal(init?.method??'GET','GET');const u=new URL(String(url)),path=u.pathname+u.search;trace.push(path);
      const id=u.pathname.startsWith('/api/tbc/txraw/txid/')?u.pathname.split('/').at(-1):null;
      const value=id?{txraw:f.raws[id]}:fixed[path];assert(value&&(!id||value.txraw),'Unexpected read '+path);replies[path]=value;
      return new Response(JSON.stringify({code:200,data:value}));}});
  const requirement=o.kit.chainDataRequirement(request),query={version:'1.0',chainId:account.chainId,accountId:account.accountId,requirement,
    ...(roles.length?{signingRoles:roles,signingAccounts}:{})};
  const snapshot=await network.chainData.resolve(query,account);assert(snapshot.snapshotHash,name+JSON.stringify(snapshot));
  const policy=await network.resolvePolicy({request,requestHash:hash(request),snapshotHash:snapshot.snapshotHash});assert(policy.policyHash,JSON.stringify(policy));
  const signed=await o.sign(name,request,snapshot,policy);
  assert.deepEqual(signed.result.transactions.map(tx=>tx.rawTransaction),kind==='create'?[f.raws[row.sourceId],f.raws[row.genesisId]]:[f.raws[currentAction.txid]],name+' upstream bytes');
  const coldTrace=[...trace];trace.length=0;const warm=await network.chainData.resolve(query,account);assert.equal(canonical(warm),canonical(snapshot));
  cases.push({name,kind,feePolicy,signingAccounts,network:'testnet',now,snapshotId,minConfirmations:'0',method:'tbc_signTransaction',account,request,requirement,replies,coldTrace,warmTrace:[...trace],...signed});
  console.log(JSON.stringify({name,reads:coldTrace.length,warm:trace.length,stages:signed.audit.stages.map(s=>s.tasks.length)}));
}
const report={status:'CURRENT_SOURCE_KIT_WASM_HIGH_LEVEL_PASS',upstreamFixtureSha256:sha(bytes),engineWasmSha256:o.wasmSha256,keylessWasmSha256:o.keylessWasmSha256,
  scope:'Public source entry/mocked HTTP/material/sign/finalize with exact upstream bytes; not packaged, device or real chain',publicFixtureScalars:[1,2],liveHttp:0,broadcasts:0,cases};
await writeFile(join(import.meta.dirname,'high-level173.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({status:report.status,cases:cases.length}));
