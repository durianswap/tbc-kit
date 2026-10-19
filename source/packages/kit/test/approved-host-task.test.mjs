import assert from 'node:assert/strict';
import test from 'node:test';
import {secp256k1} from '@noble/curves/secp256k1';
import {createTbcWallet,createApprovedHostTaskReader,TWS_RELEASE_FINGERPRINT} from '../dist/esm/wallet.js';
import {createTbcKitMemoryHostStore} from '../dist/esm/sqlite.js';

test('native task reader binds real Core workflow calls and rejects detached, changed, stale and wrong-release evidence',async()=>{
 const origin='https://native.example',chainId='tbc:testnet',address='1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH';
 const account={chainId,address,accountId:`${chainId}:${address}`,publicKey:'0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'};
 const now='2026-09-27T00:00:00Z',store=createTbcKitMemoryHostStore({now:()=>Date.parse(now)});
 const reader=createApprovedHostTaskReader({store,releaseFingerprint:TWS_RELEASE_FINGERPRINT});
 const forbidden=async()=>{throw Error('Unexpected IO')};let approvals=0,signs=0,last;
 const wallet=createTbcWallet({legacy:false,accounts:{current:async()=>[account]},
  approval:{request:async params=>{approvals++;return {status:'approved',approvalId:'native-task-test',approvalToken:'one-session',bindingHash:params.binding.bindingHash,approvedAt:now,expiresAt:params.binding.payload.expiresAt};}},
  signer:{sign:async(params,call)=>{
   const evidence=await reader.read(call.callId,params);assert.equal(evidence.stepId,signs===0?'one':'two');
   assert.deepEqual(evidence.task,params.task);last={call,params};
   await assert.rejects(reader.read('missing-call',params));
   await assert.rejects(reader.read(call.callId,{...params,task:{...params.task,digest:'00'.repeat(32)}}));
   await assert.rejects(createApprovedHostTaskReader({store,releaseFingerprint:'00'.repeat(32)}).read(call.callId,params));
   const badStore={...store,readOperation:async id=>{const value=structuredClone(await store.readOperation(id));value.transition.checkpoint.payload.state='completed';return value;}};
   await assert.rejects(createApprovedHostTaskReader({store:badStore,releaseFingerprint:TWS_RELEASE_FINGERPRINT}).read(call.callId,params));
   signs++;const signature=secp256k1.sign(params.task.digest,'01'.padStart(64,'0'),{prehash:false,lowS:true});
   return {taskId:params.task.taskId,signatureEncoding:'compact65-recoverable',signature:(31+signature.recovery).toString(16)+signature.toCompactHex()};
  }},
  storage:{loadPermissions:async()=>({revision:'0',permissions:['tbc_accounts','tbc_signWorkflow','tbc_signMessage'].map(capability=>({id:capability,parentCapability:capability,invoker:origin,date:Date.parse(now),caveats:[{type:'restrictChains',value:[chainId]},{type:'restrictAccounts',value:[account.accountId]},{type:'restrictMethods',value:[capability]}]}))}),commitPermissions:forbidden},
  network:{resolveChainData:forbidden,resolvePolicy:forbidden,broadcastSubmit:forbidden,broadcastReconcile:forbidden},clock:()=>now,randomBytes:n=>new Uint8Array(n).fill(1)});
 const session=await wallet.openSession({origin,sessionId:'native-task-session',execution:{hostStore:store}});
 const delivery=await session.handleRequest({id:'native-task-request',method:'tbc_signWorkflow',params:{version:'1.0',chainId,from:address,
  steps:[{id:'one',kind:'message',dependsOn:[],message:{encoding:'utf8',data:'one'}},{id:'two',kind:'message',dependsOn:['one'],message:{encoding:'utf8',data:'two'}}]}});
 assert.equal('error' in delivery.response,false,JSON.stringify(delivery.response));assert.equal(approvals,1);assert.equal(signs,2);
 await assert.rejects(reader.read(last.call.callId,last.params));session.close();
});
