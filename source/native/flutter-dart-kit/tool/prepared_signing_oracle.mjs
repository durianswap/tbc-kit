// Frozen DApp preparation + Core verification + WASM finalization. Public
// synthetic keys only; no node, wallet, transport or broadcast. Create-only.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {secp256k1} from '@noble/curves/secp256k1';
import {base,canonical,frozenOracle,sha} from './frozen_oracle.mjs';

const o=await frozenOracle();
const prepared=await import(pathToFileURL(join(o.work,'package/dist/esm/prepared.js')));
const inputs=[
 ['native-signing.json',['transfer-single','transfer-exact-requested','merge-two','mainnet-transfer']],
 ['fungible-signing.json',['current-transfer-multiple-inputs','historical-transfer']],
 ['staged-signing.json',['current-ft-staged-transfer']],
 ['nft-signing.json',['current-nft-mint-output','historical-nft-v2']],
 ['stablecoin-signing.json',null],
 ['creation-signing.json',['create-tbc20-fragmented','create-collection-three']],
 ['nft-mint-signing.json',null],
 ['amm-creation-signing.json',null],
 ['amm-dependent-signing.json',['amm-holder-fragmented-sell']],
 ['amm-controller-signing.json',['amm-controller-plain-add']],
 ['pool2-signing.json',['pool2-sell']],
 ['lp-signing.json',null],
 ['timelock-signing.json',null],
 ['htlc-native-signing.json',null],
 ['htlc-token-signing.json',null],
 ['lop-signing.json',['lop-native-token-ft-match']],
];
const provenance={},cases=[],unsupported=[];
const keys=new Map([
 ['0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',1n],
 ['02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5',2n],
]);
const engine=Object.fromEntries(['normalizeRequest','plan','validate','finalize'].map(m=>[m,p=>o.call(m,p)]));
async function drive(source,request,name){
 const method='tbc_signPreparedTransaction',material=structuredClone(source.audit.material),account=material.snapshot.payload.account;
 const now=material.snapshot.payload.capturedAt;
 const accounts=[account,...material.snapshot.payload.signingAccounts??[]];
 const context={...source.context,sessionId:`prepared-${name}`,createdAt:now};
 const session={version:'1.0',scope:{walletProfile:'dart-partner',sessionId:context.sessionId},
  state:{version:'1.0',sessionId:context.sessionId,revision:'0',connected:true,activeChainId:account.chainId,activeAccountIds:accounts.map(a=>a.accountId)}};
 const permissions=['tbc_accounts','tbc_signTransaction'].map(parentCapability=>({id:`permission-${parentCapability}`,parentCapability,invoker:context.origin,date:Date.parse(now),
  caveats:[{type:'restrictChains',value:[account.chainId]},{type:'restrictAccounts',value:accounts.map(a=>a.accountId)},{type:'restrictMethods',value:[parentCapability]}]}));
 const audit={material,signatures:[],tasks:[],stages:[]},ports=[];
 const core=o.kit.createTwsCore({transactionEngine:{...engine,async finalize(args){const result=await engine.finalize(args);
  audit.stages.push({stage:args.continuation?.stage??0,tasks:args.continuation?audit.stages.at(-1).result.signingRequests:audit.plan.payload.signingTasks,
   signatures:args.signatures,...args.continuation?{continuation:args.continuation}:{},result});return result;}}});
 let t=await core.start({version:'1.0',release:o.kit.TWS_RELEASE,
  request:{jsonrpc:'2.0',id:name,method,params:request},currentContext:context,currentSession:session});
 for(let i=0;t.kind!=='complete';i++){
  assert(i<512,'Core did not terminate');
  if(t.kind==='continue'){t=await core.resume({version:'1.0',checkpoint:t.checkpoint,currentContext:context,currentSession:session});continue;}
  assert.equal(t.kind,'waiting');assert.equal(t.calls.length,1);const call=t.calls[0];ports.push(call.operation);let result;
  switch(call.operation){
   case 'clock.now':result={now};break;
   case 'permissionStore.load':result={revision:'0',permissions};break;
   case 'accounts.resolve':result={accounts};break;
   case 'chainData.resolve':result=material.snapshot;break;
   case 'policy.resolve':result=material.policy;break;
   case 'approval.request':
    audit.binding=call.params.binding;audit.preview=call.params.preview;audit.plan=t.checkpoint.payload.memory.executionPlan;
    result={status:'approved',approvalId:`prepared-${name}`,approvalToken:'public-fixture-only',bindingHash:audit.binding.bindingHash,approvedAt:now,expiresAt:audit.binding.payload.expiresAt};
    audit.approval=result;break;
   case 'signer.sign':{
    const task=call.params.task,key=keys.get(task.publicKey);assert(key,'Unknown public fixture identity');
    assert.equal(task.signatureEncoding,'compact64');
    result={taskId:task.taskId,signatureEncoding:task.signatureEncoding,signature:secp256k1.sign(task.digest,key,{prehash:false,lowS:true}).toCompactHex()};
    audit.tasks.push(task);audit.signatures.push(result);break;
   }
   default:throw new Error(`Unexpected port ${call.operation}`);
  }
  t=await core.resume({version:'1.0',checkpoint:t.checkpoint,currentContext:context,currentSession:session,response:{version:'1.0',callId:call.callId,result}});
 }
 return {name,method,account,context,now,request,audit,ports,response:t.completion.response};
}
for(const [file,names]of inputs){
 const bytes=await readFile(join(base,'test/fixtures',file));provenance[file]=sha(bytes);
 const sourceCases=JSON.parse(bytes).cases;
 for(const source of names?sourceCases.filter(c=>names.includes(c.name)):sourceCases.slice(0,1)){
  let request;
  try{request=await prepared.prepareTbcTransaction({request:source.request,engine,network:{
   resolveChainData:async()=>source.audit.material.snapshot,resolvePolicy:async()=>source.audit.material.policy}});}
  catch(e){unsupported.push({file,name:source.name,stage:'frozen-prepare',reason:e.message});continue;}
  const sample=await drive(source,request,source.name);
  assert(sample.response.result,JSON.stringify(sample.response));
  const {response,...rest}=sample;
  assert.equal(sample.ports.filter(p=>p==='approval.request').length,1);
  assert.equal(canonical({...response.result,approvalId:source.result.approvalId}),canonical(source.result),source.name);
  cases.push({...rest,result:response.result,source:{file,name:source.name}});
 }
}
assert(cases.length>=16,JSON.stringify(unsupported));
const invalid=[];
const first=cases[0],source=JSON.parse(await readFile(join(base,'test/fixtures',first.source.file))).cases.find(s=>s.name===first.source.name);
const bad=async(name,change,{rehash=true}={})=>{
 const request=structuredClone(first.request);change(request);
 if(rehash&&request.proposal?.payload)request.proposal.proposalHash=o.kit.hashCanonical(request.proposal.payload);
 let schema=true;try{o.kit.assertValidTws('preparedTransactionRequest',request);}catch{schema=false;}
 let response,thrown;
 try{response=(await drive(source,request,'bad-'+name)).response;}catch(e){thrown={name:e.name,code:e.code};}
 assert(!response?.result,name);
 invalid.push({name,request,schema,...response?{errorCode:response.error.code}:{thrown}});
};
await bad('hash-mismatch',r=>r.proposal.proposalHash='00'.repeat(32),{rehash:false});
await bad('extra-proposal-field',r=>r.proposal.extra=true);
await bad('extra-payload-field',r=>r.proposal.payload.extra=true);
await bad('wrong-profile',r=>r.proposal.payload.engineProfile='different');
await bad('wrong-intent-hash',r=>r.proposal.payload.intentHash='00'.repeat(32));
await bad('wrong-fee',r=>r.proposal.payload.estimatedTotalFee='0');
await bad('wrong-raw',r=>r.proposal.payload.transactions[0].unsignedTransaction+='00');
await bad('wrong-role',r=>r.proposal.payload.transactions[0].role='different');
await bad('wrong-edge',r=>r.proposal.payload.transactions[0].dependsOn=['unknown']);
await bad('wrong-parent-evidence',r=>r.proposal.payload.evidence.parentTransactions.push({txid:'00'.repeat(32),rawTransaction:'00'}));
await bad('wrong-observation',r=>r.proposal.payload.evidence.observedAt='2026-10-11T00:00:00Z');
await bad('expired',r=>r.proposal.payload.expiresAt=first.now);
await bad('reversed-window',r=>r.proposal.payload.createdAt='2030-01-01T00:00:00Z');
await bad('invalid-time',r=>r.proposal.payload.createdAt='invalid');
await bad('empty-transactions',r=>r.proposal.payload.transactions=[]);
await bad('number-fee',r=>r.proposal.payload.transactions[0].fee=80);
await bad('unknown-contract-field',r=>r.proposal.payload.evidence.contracts=[{contractId:'00'.repeat(32),family:'ft',sourceTransactionId:'00'.repeat(32),extra:true}]);
const report={status:'FROZEN_PREPARED_CORE_WASM_ORACLE',archiveSha256:o.archiveSha256,wasmSha256:o.wasmSha256,
 publicSyntheticScalars:[1,2],provenance,cases,invalid,unsupported,networkReads:0,broadcasts:0,
 proof:'Frozen prepareTbcTransaction and Core with controlled material and actual frozen WASM/Noble. Invalid responses are not treated as successful signatures. No device or live-chain claim.'};
await writeFile(join(base,'test/fixtures/prepared-signing.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({cases:cases.length,invalid:invalid.length,unsupported,output:'test/fixtures/prepared-signing.json'}));
