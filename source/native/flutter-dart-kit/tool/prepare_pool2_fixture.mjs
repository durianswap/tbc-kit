// Historical existing-pool business oracle from the immutable accepted Kit.
// Public scalar-one synthetic vectors only; no HTTP, private keys or broadcast.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {base,repo,frozenOracle,sha,hash,canonical,address,account,now} from './frozen_oracle.mjs';
const o=await frozenOracle(),cases=[];
const mode=process.argv[2]??'base';assert(['base','positive-floor','maintenance','maintenance-positive-floor'].includes(mode));
const maintenance=mode.startsWith('maintenance');
const minConfirmations=mode.endsWith('positive-floor')?'1':'0';
const bytes=await readFile(join(repo,'packages/kit/test/fixtures/controlled-pool-key1.json'));
const f=JSON.parse(bytes);assert.equal(f.address,address);
const script='76a914751e76e8199196d454941c45d1b3a323f1433bd688ac';
const value=Buffer.alloc(8);value.writeBigUInt64LE(5000000n);
const fundRaw='0a00000001'+'00'.repeat(32)+'0000000000ffffffff01'+value.toString('hex')+'19'+script+'00000000';
const fundId=o.api.inspectTbcTransaction(fundRaw).txid;
const raws={...f.rawTransactions,[fundId]:fundRaw};
let i=f.poolInfo,nativeId=fundId,nativeVout=0,nativeValue='5000000';
let precedingAdd;
if(maintenance){
 const priorBytes=await readFile(join(base,'test/fixtures/pool2-signing.json'));
 const prior=JSON.parse(priorBytes);assert.equal(prior.archiveSha256,o.archiveSha256);
 const add=prior.cases.find(s=>s.name==='pool2-add'),tx=add.result.transactions[0];
 const preview=add.nativeCalls.find(c=>c.method==='legacyPoolPreview').result;
 raws[tx.txid]=tx.rawTransaction;
 const parsed=o.api.inspectTbcTransaction(tx.rawTransaction);assert.equal(parsed.txid,tx.txid);
 const outputs=parsed.transaction.outputs;
 nativeId=tx.txid;nativeVout=outputs.length-1;nativeValue=outputs[nativeVout].satoshis.toString();
 assert.equal(Buffer.from(outputs[nativeVout].scriptPubKey).toString('hex'),script);
 i={...i,txid:tx.txid,value:preview.after.poolValueSat,tbc_balance:preview.after.tbcSat,
  token_balance:preview.after.ftARaw,lp_balance:preview.after.ftLpRaw};
 precedingAdd={oracleSha256:sha(priorBytes),txid:tx.txid,preview};
}
const info={ftAPartialHash:i.ft_a_partial_hash,ftContractId:i.ft_contract_id,ftLpPartialHash:i.ft_lp_partial_hash,
 lpBalance:String(i.lp_balance),poolCodeScript:i.pool_code_script,serviceFeeRate:i.service_fee_rate,serviceProvider:i.service_provider,
 tbcBalance:String(i.tbc_balance),tokenBalance:String(i.token_balance),txid:i.txid,value:String(i.value),version:i.version,vout:i.vout};
const descriptor=JSON.parse(await o.keyless.execute('preparePoolNft',JSON.stringify({phase:'describe',contractId:f.poolContractId,
 ownerAddress:address,info,poolPreTxraw:raws[i.txid],ftContractTxraw:raws[f.ftContractId]})));
const current=o.api.inspectTbcTransaction(raws[i.txid]).transaction;
const outputs=script=>current.outputs.flatMap((p,vout)=>Buffer.from(p.scriptPubKey).toString('hex')===script?[vout]:[]);
const poolVout=outputs(descriptor.poolFtScript);assert.equal(poolVout.length,1);
const lpVout=outputs(descriptor.ftlpScript);assert.equal(lpVout.length,1);
for(const kind of maintenance?['merge-ft','merge-lp','burn-lp']:['buy','sell','add','remove']){
 const name='pool2-'+kind+(mode==='base'?'':'-'+mode),snapshotId=name,trace=[],replies={},nativeCalls=[];
 const fields=maintenance?{type:{'merge-ft':'tbc.pool.ft.merge','merge-lp':'tbc.pool.ftlp.merge','burn-lp':'tbc.pool.ftlp.burn'}[kind]}:
  kind==='buy'?{type:'tbc.pool.swap.exactTbcForToken',tbcAmount:'1000',minimumFtAmount:'1'}:
  kind==='sell'?{type:'tbc.pool.swap.exactTokenForTbc',ftAmount:'250000',minimumTbcAmount:'1'}:
  kind==='add'?{type:'tbc.pool.liquidity.add',tbcAmount:'1000',minimumLpAmount:'1'}:
  {type:'tbc.pool.liquidity.remove',lpAmount:'1000',minimumTbcAmount:'1',minimumFtAmount:'1'};
 let request={version:'1.0',chainId:account.chainId,from:address,intent:{version:'1.0',poolContractId:f.poolContractId,...(maintenance?{}:{receiver:address}),...fields},constraints:{maxFee:'100000',expiresAt:'2026-10-12T14:02:00.123Z'}};
 request=(await o.call('normalizeRequest',{version:'1.0',request})).request;
 const fixed={
  '/api/tbc/nodeinfo':{blocks:1000,bestblockhash:'aa'.repeat(32)},
  ['/api/tbc/utxo/address/'+address]:{utxos:[{txid:nativeId,index:nativeVout,value:nativeValue,height:990}]},
  ['/api/tbc/pool/poolinfo/poolid/'+f.poolContractId]:i,
  [`/api/tbc/ft/utxo/combinescript/${descriptor.ownerCombineScript}/contract/${f.ftContractId}`]:{utxos:[{...f.ownerCandidate,height:990}]},
  [`/api/tbc/ft/utxo/combinescript/${descriptor.poolCombineScript}/contract/${f.ftContractId}`]:{utxos:[{txid:i.txid,index:poolVout[0],tbc_value:500,ft_value:i.token_balance,height:990}]},
  ['/api/tbc/pool/lputxo/scriptpubkeyhash/'+descriptor.ftlpScriptHash]:{utxos:[{txid:i.txid,index:lpVout[0],tbc_balance:500,lp_balance:i.lp_balance,lock_time:0,height:990}]},
 };
 if(maintenance){
  const before=o.api.inspectTbcTransaction(raws[f.poolInfo.txid]).transaction;
  for(const [lp,scriptHex,previousBalance,newBalance]of [
   [false,descriptor.poolFtScript,f.poolInfo.token_balance,precedingAdd.preview.ftRequiredRaw],
   [true,descriptor.ftlpScript,f.poolInfo.lp_balance,precedingAdd.preview.ftlpMintedRaw],
  ]){
   const pairs=[[f.poolInfo.txid,before,previousBalance],[i.txid,current,newBalance]];
   const rows=pairs.flatMap(([txid,tx,balance])=>tx.outputs.flatMap((out,index)=>
    Buffer.from(out.scriptPubKey).toString('hex')===scriptHex?[{txid,index,
     ...(lp?{tbc_balance:out.satoshis.toString(),lp_balance:String(balance),lock_time:0}:
      {tbc_value:out.satoshis.toString(),ft_value:String(balance)}),height:990}]:[]));
   assert.equal(rows.length,2);
   const path=lp?'/api/tbc/pool/lputxo/scriptpubkeyhash/'+descriptor.ftlpScriptHash:
    `/api/tbc/ft/utxo/combinescript/${descriptor.poolCombineScript}/contract/${f.ftContractId}`;
   fixed[path]={utxos:rows};
  }
 }
 const network=o.kit.createDefaultTbcNetwork({network:o.kit.createTbcNetworkContext({network:'testnet'}),accounts:{current:async()=>[account]},
  poolNative:{protocolInfo:()=>o.keyless.protocolInfo(),execute:async(method,input)=>{const result=await o.keyless.execute(method,input);nativeCalls.push({method,input:JSON.parse(input),result:JSON.parse(result)});return result;}},
  now:()=>Date.parse(now),snapshotId:()=>snapshotId,confirmationPolicy:{minConfirmations},
  fetch:async(url,init)=>{assert.equal(init?.method??'GET','GET');const path=new URL(String(url)).pathname;trace.push(path);
   const id=path.startsWith('/api/tbc/txraw/txid/')?path.split('/').at(-1):null;
   const decode=path.startsWith('/api/tbc/decode/txid/')?path.split('/').at(-1):null;
   const tx=decode?o.api.inspectTbcTransaction(raws[decode]).transaction:null;
   const value=id?{txraw:raws[id]}:decode?{txid:decode,hex:raws[decode],confirmations:11,
    vin:tx.inputs.map(({txid,vout})=>({txid,vout})),vout:tx.outputs.map((p,n)=>({n,valueSat:p.satoshis.toString(),scriptPubKey:{hex:Buffer.from(p.scriptPubKey).toString('hex'),addresses:[]}}))}:fixed[path];assert(value&&(!id||value.txraw),'Unexpected Pool2 read '+path);replies[path]=value;
   return new Response(JSON.stringify({code:200,data:value}));}});
 const requirement=o.kit.chainDataRequirement(request);
 const snapshot=await network.chainData.resolve({version:'1.0',chainId:account.chainId,accountId:account.accountId,requirement},account);
 assert(snapshot.snapshotHash,name+JSON.stringify(snapshot));
 const policy=await network.resolvePolicy({request,requestHash:hash(request),snapshotHash:snapshot.snapshotHash});assert(policy.policyHash,JSON.stringify(policy));
 const signed=await o.sign(name,request,snapshot,policy,{captureStages:true}),coldTrace=[...trace],calls=[...nativeCalls];trace.length=0;nativeCalls.length=0;
 const warm=await network.chainData.resolve({version:'1.0',chainId:account.chainId,accountId:account.accountId,requirement},account);
 assert.equal(canonical(warm),canonical(snapshot));
 cases.push({name,network:'testnet',now,snapshotId,minConfirmations,method:'tbc_signTransaction',account,request,requirement,replies,coldTrace,warmTrace:[...trace],nativeCalls:calls,...signed});
 console.log(JSON.stringify({name,cold:coldTrace.length,warm:trace.length,fee:signed.result.totalFee,tasks:signed.audit.stages.map(s=>s.tasks.length),warnings:signed.audit.preview.warnings,
  nativeCalls:calls.map(c=>c.method+':'+(c.input.phase??c.input.operation))}));
}
await writeFile(join(base,`test/fixtures/pool2-${mode==='base'?'signing':mode}.json`),JSON.stringify({status:'FROZEN_HISTORICAL_POOL2_BUSINESS_ORACLE',archiveSha256:o.archiveSha256,
 sourceFixtureSha256:sha(bytes),...(precedingAdd?{precedingAdd}:{}),publicScalarOneOnly:true,networkHttp:0,broadcasts:0,cases},null,2)+'\n',{flag:'wx'});
