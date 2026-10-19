// Offline frozen-Core vectors for the consumer's fixed loopback origin. This
// changes domain/origin binding, never edits the earlier immutable oracle.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {secp256k1} from '@noble/curves/secp256k1';
import {base,sha,frozenOracle,account,now} from './frozen_oracle.mjs';
const o=await frozenOracle(),source=await readFile(join(base,'test/fixtures/typed-signing.json'));
assert.equal(sha(source),'5e63a773af68fa6bda3b46532ffc28d2b4adf3a7e19063d06a6264f4e528d478');
const origin='http://127.0.0.1:41873',method='tbc_signTypedData',cases=[];
for(const original of JSON.parse(source).cases.filter(s=>s.request.chainId===account.chainId)){
 const name=`typed-device-${original.name}`,request=structuredClone(original.request);
 if(request.data.domain.origin!==undefined)request.data.domain.origin=origin;
 const context={...original.context,origin,topOrigin:origin,sessionId:name};
 const session={version:'1.0',scope:{walletProfile:'dart-partner',sessionId:name},state:{version:'1.0',sessionId:name,revision:'0',connected:true,activeChainId:account.chainId,activeAccountIds:[account.accountId]}};
 const permissions=['tbc_accounts',method].map(parentCapability=>({id:`permission-${parentCapability}`,parentCapability,invoker:origin,date:Date.parse(now),
  caveats:[{type:'restrictChains',value:[account.chainId]},{type:'restrictAccounts',value:[account.accountId]},{type:'restrictMethods',value:[parentCapability]}]}));
 o.kit.assertValidTws('typedDataRequest',request);
 const core=o.kit.createTwsCore(),audit={tasks:[],signatures:[]},ports=[];
 let t=await core.start({version:'1.0',release:o.kit.TWS_RELEASE,request:{jsonrpc:'2.0',id:name,method,params:request},currentContext:context,currentSession:session});
 for(let i=0;t.kind!=='complete';i++){
  assert(i<20);if(t.kind==='continue'){t=await core.resume({version:'1.0',checkpoint:t.checkpoint,currentContext:context,currentSession:session});continue;}
  assert.equal(t.kind,'waiting');assert.equal(t.calls.length,1);const call=t.calls[0];ports.push(call.operation);let result;
  switch(call.operation){
   case 'clock.now':result={now};break;
   case 'permissionStore.load':result={revision:'0',permissions};break;
   case 'accounts.resolve':result={accounts:[account]};break;
   case 'approval.request':
    audit.binding=call.params.binding;audit.preview=call.params.preview;audit.envelope=t.checkpoint.payload.memory.typedDataEnvelope;
    result={status:'approved',approvalId:name,approvalToken:'public-fixture-only',bindingHash:audit.binding.bindingHash,approvedAt:now,expiresAt:audit.binding.payload.expiresAt};audit.approval=result;break;
   case 'signer.sign':{
    const task=call.params.task,s=secp256k1.sign(task.digest,1n,{prehash:false,lowS:true});
    result={taskId:task.taskId,signatureEncoding:'compact65-recoverable',signature:(31+s.recovery).toString(16)+s.toCompactHex()};audit.tasks.push(task);audit.signatures.push(result);break;
   }
   default:throw Error(`Unexpected port ${call.operation}`);
  }
  t=await core.resume({version:'1.0',checkpoint:t.checkpoint,currentContext:context,currentSession:session,response:{version:'1.0',callId:call.callId,result}});
 }
 assert(t.completion.response.result,JSON.stringify(t.completion.response));assert.equal(audit.signatures.length,1);assert.equal(ports.filter(p=>p==='approval.request').length,1);
 cases.push({name,method,account,request,context,audit,result:t.completion.response.result});
}
const report={status:'FROZEN_TYPED_LOOPBACK_DEVICE_ORACLE',origin,port:41873,publicSyntheticScalar:1,
 archiveSha256:o.archiveSha256,sourceOracleSha256:sha(source),cases,networkReads:0,broadcasts:0,
 proof:'Actual frozen Core and Noble, for later real Native Rust signatures. Not device acceptance by itself.'};
await writeFile(join(base,'test/fixtures/typed-device-signing.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({cases:cases.length,origin,archiveSha256:o.archiveSha256}));
