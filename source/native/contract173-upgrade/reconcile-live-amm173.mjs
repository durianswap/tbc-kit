// Read-only actual Testnet result/fee/configuration reconciliation. No signer.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {resolve,join} from 'node:path';
import {verifiedKitCandidate} from '../flutter/scripts/candidate-inputs.mjs';
const [evidenceArg,outArg]=process.argv.slice(2);assert(evidenceArg&&outArg);
const root=resolve(import.meta.dirname,'../..'),kit=join(root,'release/kit-contract173-20261014-c/package');
const evidence=JSON.parse(await readFile(resolve(evidenceArg))),{report}=evidence;
const identity=await verifiedKitCandidate(kit);assert.deepEqual(identity,evidence.provenance.kitIdentity);
const {request}=report.plan,create=JSON.parse(await readFile(process.argv[4]?resolve(process.argv[4]):new URL('./live/create-plan.json',import.meta.url))).request;
assert.equal(report.status,'RETURNED_RECONCILIATION_REQUIRED');assert.equal(report.result.ok,true);
assert.equal(report.plan.method,'tbc_sendTransaction');assert.equal(request.chainId,'tbc:testnet');
const accounts=JSON.parse(await readFile(new URL('../flutter-dart-live-token-exploration/evidence/private-accounts-20261012-a/accounts.json',import.meta.url))).accounts;
assert(['ios','android'].includes(evidence.provenance.platform));
assert.equal(request.from,accounts[evidence.provenance.platform].address);assert.equal(report.approvalDelta,1);
const {createTbcChainClient,inspectTbcTransaction}=createRequire(import.meta.url)(join(kit,'dist/cjs/api.cjs'));
const {createLazyBundledWasmTbcKeylessEngine,quoteTbcAmm}=createRequire(import.meta.url)(join(kit,'dist/cjs/index.cjs'));
const keyless=createLazyBundledWasmTbcKeylessEngine();
const client=createTbcChainClient({baseUrl:'https://devapi.tbcdev.org',allowedOrigins:['https://devapi.tbcdev.org'],fetch:(u,o)=>{
 assert.equal(o?.method??'GET','GET');return fetch(u,{...o,redirect:'error',signal:AbortSignal.timeout(20000)});
}});
const cache=new Map();
const raw=txid=>{if(!cache.has(txid))cache.set(txid,client.getRawTransaction(txid).then(r=>{const p=inspectTbcTransaction(r.rawTransaction);assert.equal(p.txid,txid);return {raw:r.rawTransaction,...p};}));return cache.get(txid);};
const rows=[],transactions=report.result.value.transactions;let totalFee=0n;
assert(transactions.length>=1&&transactions.length<=8);
for(const t of transactions){
 assert.equal(t.status,'submitted');
 const [p,status]=await Promise.all([raw(t.txid),client.getTransactionStatus(t.txid)]);
 const parents=await Promise.all(p.transaction.inputs.map(async i=>{
  const parent=await raw(i.txid),output=parent.transaction.outputs[i.vout];assert(output);
  return {txid:i.txid,vout:i.vout,atomic:output.satoshis.toString()};
 }));
 const fee=parents.reduce((s,x)=>s+BigInt(x.atomic),0n)-p.transaction.outputs.reduce((s,x)=>s+x.satoshis,0n);assert(fee>=0n);totalFee+=fee;
 rows.push({id:t.id,txid:t.txid,role:t.role,dependsOn:t.dependsOn,status,inputs:parents,outputCount:p.transaction.outputs.length,feeAtomic:fee.toString()});
}
assert.equal(totalFee.toString(),report.result.value.totalFee);assert(totalFee<=BigInt(request.constraints.maxFee));
const primary=transactions.filter(t=>t.role==='primary');assert.equal(primary.length,1);
const current=await raw(primary[0].txid);
const pool=JSON.parse(await keyless.execute('inspectAmmMaterial',JSON.stringify({phase:'inspectPool',pool:{txid:current.txid,rawTransaction:current.raw}})));
assert.equal(pool.standardId,'tbc-amm');assert.equal(pool.templateRevision,'a821abdb280268430ad7ea7a9421068a719a8e959b84c11265d4456e8d740db7');
assert.deepEqual(pool.feePolicy,create.intent.feePolicy);assert.equal(pool.ftContractId,create.intent.ftContractId);
assert.equal(pool.serviceProviderTagHex,Buffer.from(create.intent.serviceProviderTag,'utf8').toString('hex'));
assert.equal(pool.lpTimelock,false);assert.deepEqual(pool.controllers,[]);
const poolContractId=request.intent.type==='tbc-amm-create'?current.txid:request.intent.poolContractId;
assert.match(poolContractId,/^[0-9a-f]{64}$/);
let quote;
if(request.intent.type==='tbc-amm-create'){
 assert.equal(transactions.length,2);assert.equal(pool.state.ftAmount,'0');assert.equal(pool.state.tbcAmount,'0');assert.equal(pool.state.lpAmount,'0');
}else{
 const genesis=await raw(poolContractId);
 const g=JSON.parse(await keyless.execute('inspectAmmMaterial',JSON.stringify({phase:'inspectPool',pool:{txid:genesis.txid,rawTransaction:genesis.raw}})));
 assert.equal(pool.poolCodeHash,g.poolCodeHash);assert.deepEqual(pool.feePolicy,g.feePolicy);
 const previous=await raw(pool.parentOutpoint.txid),intent=request.intent;
 const action=intent.type==='tbc-amm-add-liquidity'?{kind:intent.budgetAsset==='tbc'?'addTbc':'addFt',amount:intent.amount,...intent.initialFtAmount===undefined?{}:{initialFtAmount:intent.initialFtAmount}}:
  intent.type==='tbc-amm-remove-liquidity'?{kind:'remove',amount:intent.lpAmount}:
  {kind:intent.direction==='tbc-to-ft'?'buy':'sell',amount:intent.amount};
 quote=await quoteTbcAmm({pool:{txid:previous.txid,rawTransaction:previous.raw},action},{engine:keyless});
 assert.deepEqual(pool.state,{ftAmount:quote.quote.nextState.ftAAmount,lpAmount:quote.quote.nextState.ftLpAmount,
  tbcAmount:quote.quote.nextState.tbcAmount,poolValue:quote.quote.nextState.poolValue});
}
const receipt={checkedAt:new Date().toISOString(),status:'LIVE_AMM_CONFIG_AND_FEE_VERIFIED',runId:report.runId,kitIdentity:identity,
 poolContractId,intentType:request.intent.type,rows,pool,quote,totalFeeAtomic:totalFee.toString(),approvalCount:report.approvalDelta,signatureCount:report.signatureDelta,
 timing:{pageRequestMs:report.result.ms,approvalToLastSignatureUs:report.approvalToLastSignatureUs,nativeSignUs:report.nativeSignUs},
 scope:'Actual configured Testnet API and local raw txid, prevout/value/fee, new template, immutable fees/address/tag and contract-state checks. Confirmation is explicit per transaction. Not independent consensus or full lifecycle proof until all stages pass.'};
await writeFile(resolve(outArg),JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({status:receipt.status,runId:receipt.runId,poolContractId,rows,totalFeeAtomic:receipt.totalFeeAtomic,
 approvalCount:receipt.approvalCount,signatureCount:receipt.signatureCount,timing:receipt.timing,state:pool.state}));
