// Immutable, offline Core oracle from the accepted archive. Public scalar one
// only; never queries a node, opens a wallet, signs transactions or broadcasts.
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {secp256k1} from '@noble/curves/secp256k1';
import {base,canonical,frozenOracle,account,now} from './frozen_oracle.mjs';

const o=await frozenOracle(),method='tbc_signTypedData';
const names=['Z','aB','Ab','ab','AB','a_b','a0b','a9','a10','a2','A','a','Aa','AA','aA','aa','a_','a','aB'];
const plain={domain:{name:'Partner',chainId:account.chainId,origin:'https://partner.example'},
 types:{Transfer:[{name:'to',type:'address'},{name:'amount',type:'uint256'}]},
 primaryType:'Transfer',message:{to:account.address,amount:'123456789012345678901234567890'}};
const examples=[
 ['simple',plain],
 ['origin-optional',{...plain,domain:{name:'Partner',chainId:account.chainId}}],
 ['sorting',{...plain,types:{zType:[{name:'x',type:'string'}],Transfer:names.map((name,i)=>({name,type:i%2?'bool':'string'})),AType:[{name:'z',type:'bytes32'}]}}],
 ['unicode-nested',{...plain,domain:{name:'钱包😀e\u0301',chainId:account.chainId,origin:'https://partner.example',version:'draft.1',verifyingContract:'ab'.repeat(32),salt:'00'.repeat(32)},
  types:{Transfer:[{name:'rows',type:'Record[12]'},{name:'flags',type:'bool[]'}],Record:[{name:'text',type:'string'}]},
  message:{rows:[{text:'组合😀\n\u0000"\\ é e\u0301'}],flags:[true,false],empty:{},array:[],number:'-1.25',unicode:{'😀':'值','\ue000':'tail'}}}],
 ['schema-opaque-types',{...plain,primaryType:'NotDeclared',types:{Transfer:[{name:'same',type:'Unknown'},{name:'same',type:'Different[]'}]},message:{unexpected:true}}],
 ['maximum-array',{...plain,message:{values:Array.from({length:256},(_,i)=>String(i))}}],
 ['mainnet',{...plain,domain:{...plain.domain,chainId:'tbc:mainnet'}}],
];
async function drive(name,request){
 const a={...account,chainId:request.chainId,accountId:`${request.chainId}:${account.address}`};
 const context={sessionId:`typed-${name}`,navigationId:'document-1',origin:'https://partner.example',topOrigin:'https://partner.example',transport:'webview',frame:'top',createdAt:now};
 const session={version:'1.0',scope:{walletProfile:'dart-partner',sessionId:context.sessionId},
  state:{version:'1.0',sessionId:context.sessionId,revision:'0',connected:true,activeChainId:a.chainId,activeAccountIds:[a.accountId]}};
 const permissions=['tbc_accounts',method].map(parentCapability=>({id:`permission-${parentCapability}`,parentCapability,invoker:context.origin,date:Date.parse(now),
  caveats:[{type:'restrictChains',value:[a.chainId]},{type:'restrictAccounts',value:[a.accountId]},{type:'restrictMethods',value:[parentCapability]}]}));
 const core=o.kit.createTwsCore(),ports=[],audit={signatures:[],tasks:[]};
 let t=await core.start({version:'1.0',release:o.kit.TWS_RELEASE,
  request:{jsonrpc:'2.0',id:name,method,params:request},currentContext:context,currentSession:session});
 for(let i=0;t.kind!=='complete';i++){
  assert(i<20,'Core failed to terminate');
  if(t.kind==='continue') {t=await core.resume({version:'1.0',checkpoint:t.checkpoint,currentContext:context,currentSession:session});continue;}
  assert.equal(t.kind,'waiting');assert.equal(t.calls.length,1);
  const call=t.calls[0];ports.push(call.operation);let result;
  switch(call.operation){
   case 'clock.now':result={now};break;
   case 'permissionStore.load':result={revision:'0',permissions};break;
   case 'accounts.resolve':result={accounts:[a]};break;
   case 'approval.request':
    audit.binding=call.params.binding;audit.preview=call.params.preview;
    audit.envelope=t.checkpoint.payload.memory.typedDataEnvelope;
    result={status:'approved',approvalId:`typed-${name}`,approvalToken:'public-fixture-only',bindingHash:audit.binding.bindingHash,approvedAt:now,expiresAt:audit.binding.payload.expiresAt};
    audit.approval=result;break;
   case 'signer.sign':{
    const task=call.params.task,s=secp256k1.sign(task.digest,1n,{prehash:false,lowS:true});
    result={taskId:task.taskId,signatureEncoding:'compact65-recoverable',signature:(31+s.recovery).toString(16)+s.toCompactHex()};
    audit.tasks.push(task);audit.signatures.push(result);break;
   }
   default:throw new Error(`Unexpected port ${call.operation}`);
  }
  t=await core.resume({version:'1.0',checkpoint:t.checkpoint,currentContext:context,currentSession:session,response:{version:'1.0',callId:call.callId,result}});
 }
 return {name,method,account:a,request,context,ports,audit,response:t.completion.response};
}
const cases=[];
for(const [name,data]of examples){
 const request={version:'1.0',chainId:data.domain.chainId,from:account.address,data,clientRequestId:`typed-${name}`};
 o.kit.assertValidTws('typedDataRequest',request);
 const sample=await drive(name,request);assert(sample.response.result,JSON.stringify(sample.response));
 const {response,...rest}=sample;assert.equal(sample.ports.filter(x=>x==='signer.sign').length,1);
 assert.equal(sample.ports.filter(x=>x==='approval.request').length,1);
 cases.push({...rest,result:response.result});
}
// Same semantic type map in a different insertion/field order must sign the
// same bytes. Duplicate equal field names intentionally keep source order.
const reordered=structuredClone(cases[0].request);
reordered.data.types.Transfer.reverse();
const ordered=await drive('reordered',reordered);
assert.equal(canonical(ordered.response.result),canonical(cases[0].result));
cases.push({...ordered,result:ordered.response.result});delete cases.at(-1).response;
const invalid=[];
const bad=(name,change)=>{const request=structuredClone(cases[0].request);change(request);invalid.push({name,request});};
bad('numeric-value',r=>r.data.message.amount=123);
bad('null-value',r=>r.data.message.amount=null);
bad('unknown-data-field',r=>r.data.extra=true);
bad('constraints-not-defined',r=>r.constraints={});
bad('unknown-domain-field',r=>r.data.domain.extra=true);
bad('empty-name',r=>r.data.domain.name='');
bad('long-name',r=>r.data.domain.name='😀'.repeat(65));
bad('invalid-version',r=>r.data.domain.version='bad version');
bad('bad-salt',r=>r.data.domain.salt='AB'.repeat(32));
bad('bad-contract',r=>r.data.domain.verifyingContract='abcd');
bad('origin-path',r=>r.data.domain.origin='https://partner.example/path');
bad('empty-types',r=>r.data.types={});
bad('too-many-types',r=>r.data.types=Object.fromEntries(Array.from({length:33},(_,i)=>[`Type${i}`,[{name:'x',type:'string'}]])));
bad('bad-type-name',r=>r.data.types={'9Wrong':[{name:'x',type:'string'}]});
bad('empty-fields',r=>r.data.types.Transfer=[]);
bad('too-many-fields',r=>r.data.types.Transfer=Array.from({length:65},()=>({name:'x',type:'string'})));
bad('bad-field-name',r=>r.data.types.Transfer[0].name='_bad');
bad('bad-field-type',r=>r.data.types.Transfer[0].type='string[0]');
bad('extra-field-property',r=>r.data.types.Transfer[0].extra='x');
bad('bad-primary-type',r=>r.data.primaryType='_bad');
bad('array-message',r=>r.data.message=[]);
bad('too-many-message-keys',r=>r.data.message=Object.fromEntries(Array.from({length:65},(_,i)=>[`k${i}`,'v'])));
bad('too-many-array-items',r=>r.data.message={list:Array(257).fill('x')});
bad('invalid-client-id',r=>r.clientRequestId='');
for(const v of invalid)assert.throws(()=>o.kit.assertValidTws('typedDataRequest',v.request),v.name);
for(const [name,change]of [['wrong-origin',r=>r.data.domain.origin='https://evil.example'],['wrong-chain',r=>r.data.domain.chainId='tbc:mainnet']]){
 const request=structuredClone(cases[0].request);change(request);const failed=await drive(name,request);
 assert.equal(failed.response.error.code,-32602);assert(!failed.ports.includes('approval.request'));assert(!failed.ports.includes('signer.sign'));
 invalid.push({name,request,errorCode:-32602});
}
// Frozen English comparison corpus for the ASCII names allowed by schema.
let state=1963;const chars='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_0123456789';
const random=()=>((state=(Math.imul(state,1664525)+1013904223)>>>0)/4294967296);
const sortNames=[...names];for(let i=0;i<768;i++){let name=chars[Math.floor(random()*52)];for(let j=0,n=Math.floor(random()*12);j<n;j++)name+=chars[Math.floor(random()*chars.length)];sortNames.push(name);}
const report={status:'FROZEN_TYPED_DATA_CORE_ORACLE',archiveSha256:o.archiveSha256,release:o.kit.TWS_RELEASE,
 publicSyntheticScalar:1,cases,invalid,sort:{input:sortNames,expected:sortNames.slice().sort((a,b)=>a.localeCompare(b,'en'))},
 proof:'Frozen Core schema/reducer and Noble public-fixture signer. No native device, network or broadcast.',networkReads:0,broadcasts:0};
await writeFile(join(base,'test/fixtures/typed-signing.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({cases:cases.length,invalid:invalid.length,archiveSha256:o.archiveSha256,output:'test/fixtures/typed-signing.json'}));
