// Frozen Core plus independent Node/Noble BIE1. Public scalar1 only, offline.
// No wallet, private account, transaction signing or broadcast is reachable.
import assert from 'node:assert/strict';
import {createHash,createCipheriv,createDecipheriv,createHmac,timingSafeEqual} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {secp256k1} from '@noble/curves/secp256k1';
import {base,canonical,frozenOracle,account,now,sha} from './frozen_oracle.mjs';
const o=await frozenOracle(),algorithm='tbc-bie1-secp256k1-aes128-cbc-hmac-sha256-v1';
const key='1'.padStart(64,'0'),publicKey=Buffer.from(secp256k1.getPublicKey(key,true));
const bytes=m=>Buffer.from(m.data,m.encoding==='utf8'?'utf8':m.encoding==='hex'?'hex':'base64');
function bie1(input,decrypt){
 const peer=decrypt?input.subarray(4,37):publicKey;
 const material=createHash('sha512').update(secp256k1.getSharedSecret(key,peer,true)).digest();
 const mac=v=>createHmac('sha256',material.subarray(32)).update(v).digest();
 if(decrypt){
  assert.equal(input.subarray(0,4).toString(),'BIE1');
  assert(timingSafeEqual(mac(input.subarray(0,-32)),input.subarray(-32)));
  const d=createDecipheriv('aes-128-cbc',material.subarray(16,32),material.subarray(0,16));
  return Buffer.concat([d.update(input.subarray(37,-32)),d.final()]);
 }
 const e=createCipheriv('aes-128-cbc',material.subarray(16,32),material.subarray(0,16));
 const body=Buffer.concat([Buffer.from('BIE1'),publicKey,e.update(input),e.final()]);return Buffer.concat([body,mac(body)]);
}
async function drive(name,method,request){
 const a={...account,chainId:request.chainId,accountId:`${request.chainId}:${account.address}`};
 const context={sessionId:'crypto-'+name,navigationId:'document-1',origin:'https://partner.example',topOrigin:'https://partner.example',transport:'webview',frame:'top',createdAt:now};
 const session={version:'1.0',scope:{walletProfile:'dart-partner',sessionId:context.sessionId},state:{version:'1.0',sessionId:context.sessionId,revision:'0',connected:true,activeChainId:a.chainId,activeAccountIds:[a.accountId]}};
 const permissions=['tbc_accounts','tbc_crypto'].map(parentCapability=>({id:'grant-'+parentCapability,parentCapability,invoker:context.origin,date:Date.parse(now),caveats:[{type:'restrictChains',value:[a.chainId]},{type:'restrictAccounts',value:[a.accountId]},{type:'restrictMethods',value:[parentCapability]}]}));
 o.kit.assertValidTws(method==='tbc_encrypt'?'encryptRequest':'decryptRequest',request);
 const core=o.kit.createTwsCore(),ports=[],audit={};
 let t=await core.start({version:'1.0',release:o.kit.TWS_RELEASE,request:{jsonrpc:'2.0',id:name,method,params:request},currentContext:context,currentSession:session});
 for(let n=0;t.kind!=='complete';n++){
  assert(n<30);if(t.kind==='continue'){t=await core.resume({version:'1.0',checkpoint:t.checkpoint,currentContext:context,currentSession:session});continue;}
  assert.equal(t.kind,'waiting');assert.equal(t.calls.length,1);const call=t.calls[0];ports.push(call.operation);let result;
  switch(call.operation){
   case 'clock.now':result={now};break;
   case 'permissionStore.load':result={revision:'0',permissions};break;
   case 'accounts.resolve':result={accounts:[a]};break;
   case 'approval.request':
    audit.plan=t.checkpoint.payload.memory.walletActionPlan;audit.binding=call.params.binding;audit.preview=call.params.preview;
    result=audit.approval={status:'approved',approvalId:'crypto-'+name,approvalToken:'public-fixture-only',bindingHash:audit.binding.bindingHash,approvedAt:now,expiresAt:audit.binding.payload.expiresAt};break;
   case 'crypto.execute':{
    const task=call.params.task;assert.equal(task.publicKey,a.publicKey);assert.equal(task.accountId,a.accountId);assert.equal(task.origin,context.origin);
    const output=bie1(task.purpose==='encrypt'?bytes(task.message):Buffer.from(task.ciphertext,'base64'),task.purpose==='decrypt');
    result={taskId:task.taskId,algorithm,...(task.purpose==='encrypt'?{ciphertext:output.toString('base64')}:{message:{encoding:'base64',data:output.toString('base64')}})};
    audit.task=task;audit.cryptoResult=result;break;
   }
   default:throw Error('Forbidden crypto fixture port '+call.operation);
  }
  t=await core.resume({version:'1.0',checkpoint:t.checkpoint,currentContext:context,currentSession:session,response:{version:'1.0',callId:call.callId,result}});
 }
 assert(t.completion.response.result,canonical(t.completion.response));
 assert.equal(ports.filter(p=>p==='approval.request').length,1);assert.equal(ports.filter(p=>p==='crypto.execute').length,1);
 return {name,method,now,request,context,account:a,audit,ports,result:t.completion.response.result};
}
const common={version:'1.0',chainId:account.chainId,from:account.address,algorithm};
const messages=[['utf8',{encoding:'utf8',data:'Dart public BIE1 测试😀\n\u0000'}],['empty',{encoding:'utf8',data:''}],['hex',{encoding:'hex',data:'0001ff000080'}],['base64',{encoding:'base64',data:'AAH/AACA'}],['empty-base64',{encoding:'base64',data:''}]];
const cases=[];
for(const [name,message]of messages){
 const encrypted=await drive('encrypt-'+name,'tbc_encrypt',{...common,message});cases.push(encrypted);
 const decrypted=await drive('decrypt-'+name,'tbc_decrypt',{...common,ciphertext:encrypted.result.ciphertext});cases.push(decrypted);
 assert.equal(decrypted.result.message.data,bytes(message).toString('base64'));
}
cases.push(await drive('mainnet','tbc_encrypt',{...common,chainId:'tbc:mainnet',message:messages[0][1]}));
cases.push(await drive('deadline','tbc_encrypt',{...common,message:messages[0][1],clientRequestId:'crypto-client',expiresAt:'2026-10-12T14:01:00.456Z'}));
const invalid=[];
const bad=(name,method,change)=>{const r=structuredClone(cases[method==='tbc_decrypt'?1:0].request);change(r);assert.throws(()=>o.kit.assertValidTws(method==='tbc_encrypt'?'encryptRequest':'decryptRequest',r));invalid.push({name,method,request:r});};
bad('algorithm','tbc_encrypt',r=>r.algorithm='other');bad('unknown','tbc_encrypt',r=>r.privateKey='not-a-key');
bad('constraint','tbc_encrypt',r=>r.constraints={});bad('missing-message','tbc_encrypt',r=>delete r.message);
bad('empty-hex','tbc_encrypt',r=>r.message={encoding:'hex',data:''});bad('odd-hex','tbc_encrypt',r=>r.message={encoding:'hex',data:'001'});
bad('upper-hex','tbc_encrypt',r=>r.message={encoding:'hex',data:'AA'});bad('bad-base64','tbc_encrypt',r=>r.message={encoding:'base64',data:'a==='});
bad('extra-message','tbc_encrypt',r=>r.message.preview='wrong');bad('both-payloads','tbc_decrypt',r=>r.message=messages[0][1]);
bad('cipher-short','tbc_decrypt',r=>r.ciphertext='AAAA');bad('cipher-malformed','tbc_decrypt',r=>r.ciphertext='!'.repeat(116));
bad('bad-time','tbc_encrypt',r=>r.expiresAt='2026-10-12');bad('empty-client','tbc_encrypt',r=>r.clientRequestId='');
const encrypted=Buffer.from(cases[0].result.ciphertext,'base64'),nativeReject=[];
for(const [name,index]of [['header',0],['peer',4],['body',37],['mac',encrypted.length-1]]){const v=Buffer.from(encrypted);v[index]^=1;assert.throws(()=>bie1(v,true));nativeReject.push({name,ciphertext:v.toString('base64')});}
const report={status:'FROZEN_STANDALONE_BIE1_ORACLE',archiveSha256:o.archiveSha256,wasmSha256:o.wasmSha256,cases,invalid,nativeReject,chainHttp:0,broadcasts:0,
 proof:'Frozen Core plan/binding/task/public result; independently computed Node/Noble self-BIE1 public scalar1. No Dart/native/device integration claim.'};
const data=JSON.stringify(report,null,2)+'\n';await writeFile(join(base,'test/fixtures/crypto-signing.json'),data,{flag:'wx'});
console.log(JSON.stringify({status:report.status,cases:cases.length,invalid:invalid.length,nativeReject:nativeReject.length,sha256:sha(data),scratch:o.work}));
