// Frozen, public-fixture staged signing oracle. Never broadcasts or rewrites
// historical evidence. Existing single-stage oracle supplies public raw history.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {secp256k1} from '@noble/curves/secp256k1';
import {frozenOracle,base,sha,hash,canonical,address,publicKey,account,now} from './frozen_oracle.mjs';
const o=await frozenOracle(),sourceFile='test/fixtures/fungible-signing.json',sourceBytes=await readFile(join(base,sourceFile));
const source=JSON.parse(sourceBytes).cases.find(c=>c.name==='current-transfer-receivers'),contract=source.request.intent.contractId;
// A genuine public-key split makes six small inputs. Merely asking for six
// recipients is single-stage in this contract and cannot prove continuation.
const splitRequest=structuredClone(source.request);
splitRequest.intent.receivers=Array.from({length:6},(_,i)=>({to:address,amount:String(1000+i)}));
const split=await o.sign('current-public-split',splitRequest,source.audit.material.snapshot,source.audit.material.policy);
const splitTx=split.result.transactions[0],outs=o.api.inspectTbcTransaction(splitTx.rawTransaction).transaction.outputs,rows=[];
for(let i=0;i<outs.length-1;i++)if(outs[i].satoshis===500n&&outs[i+1].satoshis===0n){
 const pair=JSON.parse(await o.keyless.execute('inspectTokenMaterial',JSON.stringify({phase:'identifyPairs',pairs:[{
  codeScript:Buffer.from(outs[i].scriptPubKey).toString('hex'),codeSatoshis:500,
  tapeScript:Buffer.from(outs[i+1].scriptPubKey).toString('hex'),tapeSatoshis:0}]}))).identities[0];
 rows.push({txid:splitTx.txid,index:i,tbc_value:'500',ft_value:pair.balanceRaw,height:990});
}
assert(rows.length>=6);
const cases=[];
for(const merge of [false,true]){
 const name=merge?'current-ft-staged-merge':'current-ft-staged-transfer',snapshotId='staged-'+name,trace=[];
 const replies=structuredClone(source.replies);
 replies['/api/tbc/txraw/txid/'+splitTx.txid]={txraw:splitTx.rawTransaction};
 replies['/api/tbc/utxo/address/'+address]={utxos:[{txid:splitTx.txid,index:outs.length-1,value:String(outs.at(-1).satoshis),height:990}]};
 replies['/api/tbc/ft/utxo/combinescript/751e76e8199196d454941c45d1b3a323f1433bd600/contract/'+contract]={utxos:rows};
 const request={version:'1.0',chainId:account.chainId,from:address,intent:{version:'1.0',type:merge?'tbc20.merge':'tbc20.transfer',contractId:contract,
  ...(merge?{}:{to:address,amount:'6016'})},constraints:{maxFee:'10000'}};
 const network=o.kit.createDefaultTbcNetwork({network:o.kit.createTbcNetworkContext({network:'testnet'}),accounts:{current:async()=>[account]},poolNative:o.keyless,
  now:()=>Date.parse(now),snapshotId:()=>snapshotId,fetch:async(url,init)=>{assert.equal(init?.method??'GET','GET');const p=new URL(String(url)).pathname;trace.push(p);assert(replies[p],p);return new Response(JSON.stringify({code:200,data:replies[p]}));}});
 const requirement={intentType:request.intent.type,includeAncestry:true,contractIds:[contract],
  assets:[{kind:'native'},{kind:'ft',contractId:contract,...(merge?{}:{minimumAmount:'6016'})}]};
 const snapshot=await network.chainData.resolve({version:'1.0',chainId:account.chainId,accountId:account.accountId,requirement},account);assert(snapshot.snapshotHash,JSON.stringify({snapshot,trace,missing:trace.filter(p=>!replies[p])}));
 const policy=await network.resolvePolicy({request,requestHash:hash(request),snapshotHash:snapshot.snapshotHash});assert(policy.policyHash);
 const normalized=await o.call('normalizeRequest',{version:'1.0',request});assert.equal(canonical(normalized.request),canonical(request));
 const material={version:'1.0',...normalized,snapshot,policy},{plan}=await o.call('plan',material);
 assert.equal((await o.call('validate',{...material,plan,phase:'plan'})).valid,true);
 const context={sessionId:'offline-'+name,navigationId:'document-1',origin:'https://partner.example',topOrigin:'https://partner.example',transport:'webview',frame:'top',createdAt:now};
 const payload={version:'1.0',method:'tbc_signTransaction',operationKind:'transaction',contextHash:hash(context),origin:context.origin,sessionId:context.sessionId,
  chainId:account.chainId,accountId:account.accountId,requestHash:normalized.requestHash,operationHash:plan.planHash,expiresAt:plan.payload.expiresAt};
 const binding={payload,bindingHash:hash(payload)},approval={status:'approved',approvalId:'offline-'+name,approvalToken:'public-fixture-only',bindingHash:binding.bindingHash,approvedAt:now,expiresAt:payload.expiresAt};
 assert.equal((await o.call('validate',{...material,plan,binding,approval,phase:'pre-sign'})).valid,true);
 let continuation,tasks=plan.payload.signingTasks,result;const stages=[];
 for(let stage=0;stage<plan.payload.transactions.length;stage++){
  const signatures=tasks.map(t=>{assert.equal(t.publicKey,publicKey);assert.equal(t.signatureEncoding,'compact64');return {taskId:t.taskId,signatureEncoding:t.signatureEncoding,signature:secp256k1.sign(t.digest,1n,{lowS:true,prehash:false}).toCompactHex()};});
  const args={...material,plan,binding,approval,signatures,...(continuation?{continuation}:{})},final=await o.call('finalize',args);
  const check={...args,phase:'finalized',...(final.status==='pending'?{pending:final}:{bundle:final.bundle})};
  assert.equal((await o.call('validate',check)).valid,true);
  stages.push({stage,tasks,signatures,...(continuation?{continuation}:{}),result:final});
  if(final.bundle){result=final.bundle;break;}
  assert.equal(final.status,'pending');continuation=final.continuation;tasks=final.signingRequests;
 }
 assert(result&&stages.length>1);const coldTrace=[...trace];trace.length=0;
 const warm=await network.chainData.resolve({version:'1.0',chainId:account.chainId,accountId:account.accountId,requirement},account);assert.equal(canonical(warm),canonical(snapshot));
 cases.push({name,network:'testnet',now,snapshotId,minConfirmations:'0',method:'tbc_signTransaction',account,request,context,replies,coldTrace,warmTrace:[...trace],result,
  audit:{material,plan,preview:plan.payload.preview,binding,approval,signatures:stages.flatMap(s=>s.signatures),stages}});
 console.log(JSON.stringify({name,reads:coldTrace.length,warm:trace.length,preview:plan.payload.preview,stages:stages.map(s=>s.tasks.length),fee:result.totalFee}));
}
await writeFile(join(base,'test/fixtures/staged-signing.json'),JSON.stringify({status:'FROZEN_STAGED_FT_ORACLE',archiveSha256:o.archiveSha256,wasmSha256:o.wasmSha256,
 sources:{[sourceFile]:sha(sourceBytes)},publicScalarOneOnly:true,broadcasts:0,networkHttp:0,cases},null,2)+'\n',{flag:'wx'});
