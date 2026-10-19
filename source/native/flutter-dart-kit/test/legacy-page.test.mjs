import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createHash,webcrypto} from 'node:crypto';
import {createContext,runInContext} from 'node:vm';
import {canonical,LEGACY_CHANNEL,projection,projectResult} from '../runtime/legacy-page.mjs';
const dir=process.env.TBC_DART_PAGE_DIR;assert(dir,'Build the independent page first');
const base=resolve(import.meta.dirname,'..'),root=resolve(base,'../..');
const source=await readFile(join(dir,'tbc-webview-page.js'),'utf8'),manifest=JSON.parse(await readFile(join(dir,'page-provenance.json')));
const kit=resolve(process.env.TBC_DART_KIT_DIR??join(root,'release/kit-contract173-20261014-c/package'));
const sha=s=>createHash('sha256').update(s).digest('hex');assert.equal(sha(source),manifest.sha256);
for(const [id,hash]of Object.entries(manifest.sources))assert.equal(sha(await readFile(join(id.startsWith('kit:')?kit:root,id.slice(id.indexOf(':')+1)))),hash,id);
const address='1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH';
const descriptor={name:'Partner Wallet',productId:'org.partner.wallet',icon:'data:image/svg+xml,<svg/>',chains:['tbc:testnet','tbc:mainnet'],platform:'ios',walletVersion:'2.4.0'};
function fixture({android=false,subframe=false}={}){
 const target=new EventTarget(),posted=[],wallets=[],document=new EventTarget();
 target.location={origin:'https://partner.example'};target.top=subframe?{}:target;
 target.webkit={messageHandlers:{tbcKitNative:{postMessage(text){posted.push(JSON.parse(text));}}}};
 if(android){target.tbcKitNative=target.webkit.messageHandlers.tbcKitNative;delete target.webkit;}
 const CustomEvent=class extends Event{constructor(type,options={}){super(type);this.detail=options.detail;}};
 const context=createContext({window:target,document,Event,MessageEvent,CustomEvent,TextEncoder,TextDecoder,
  Uint8Array,ArrayBuffer,setTimeout,clearTimeout,URL,crypto:webcrypto,atob,btoa});
 target.addEventListener('wallet-standard:register-wallet',e=>e.detail({register(w){wallets.push(w);}}));
 runInContext(source,context);const bridge=target.__tbcFlutterPage;let sequence=0;
 const frame=(type,extra={},channel=LEGACY_CHANNEL)=>canonical({channel,type,sessionId:'session',navigationId:'document',messageId:'native-'+(++sequence),...extra});
 const init=(channel=LEGACY_CHANNEL,chainId='tbc:testnet')=>frame('initialize',{origin:target.location.origin,chainId},channel);
 function ready(){assert.equal(bridge.arm('epoch'),true);assert.equal(bridge.receive('epoch',init('tws-webview/1')),true);assert.equal(bridge.describe('epoch',descriptor),true);}
 const requests=()=>posted.map(p=>JSON.parse(p.serialized)).filter(m=>m.type==='request');
 function request(method,params){return runInContext(`window.Turing[${JSON.stringify(method)}](${params===undefined?'undefined':JSON.stringify(params)})`,context);}
 function delivery(id,result,{events=[],error}={}){const payload={response:{jsonrpc:'2.0',id,...(error?{error}:{result})},events};return frame('delivery',{...payload,deliveryId:sha(canonical(payload))});}
 const receive=text=>bridge.receiveLegacy('epoch',text);
 return {target,context,posted,wallets,bridge,frame,init,ready,requests,request,delivery,receive};
}
const json=v=>JSON.parse(JSON.stringify(v));
test('2200 sequential Legacy calls survive with replay protection and bounded concurrency',async()=>{
 const h=fixture();h.ready();assert(h.receive(h.init()));let first;
 for(let i=0;i<2200;i++){
  const p=h.request('getNetwork'),q=h.requests().at(-1).request;
  const reply=h.delivery(q.id,'tbc:testnet');first??=reply;
  assert(h.receive(reply));assert.deepEqual(json(await p),{network:'tbc',type:'testnet'});
 }
 assert(h.receive(first));assert.equal(h.target.Turing.isReady,true);
 const pending=Array.from({length:128},()=>h.request('getNetwork'));
 assert.deepEqual(json(await h.request('getNetwork')),{error:'Another wallet request is already pending'});
 for(const q of h.requests().slice(-128))assert(h.receive(h.delivery(q.request.id,'tbc:testnet')));
 await Promise.all(pending);
 const changed=JSON.parse(first);changed.response.result='tbc:mainnet';
 assert.equal(h.receive(canonical(changed)),false);assert.equal(h.target.Turing.isReady,false);
});
test('page is dormant, source-pinned and has no private runtime; Standard discovery still works',async()=>{
 assert.equal(manifest.privilegedRuntime,false);assert.equal(manifest.signer,false);assert.equal(manifest.businessExecution,false);
 for(const id of manifest.retainedSources)assert.doesNotMatch(id,/native-driver|wallet-runtime|private-host|custody|sqlite/);
 assert.equal(fixture({subframe:true}).bridge,undefined);
 const h=fixture();h.ready();assert.equal(h.target.Turing,undefined);assert.equal(h.wallets.length,1);
 const pending=h.wallets[0].features['tbc:provider'].provider.request({method:'tbc_chainId'});await Promise.resolve();
 const q=h.requests().at(-1).request,payload={response:{jsonrpc:'2.0',id:q.id,result:'tbc:testnet'},events:[]};
 assert(h.bridge.receive('epoch',h.frame('delivery',{...payload,deliveryId:sha(canonical(payload))},'tws-webview/1')));
 assert.equal(await pending,'tbc:testnet');h.bridge.close('epoch');
});
test('Legacy connect returns committed address and events with one named discovery wallet',async()=>{
 const h=fixture();let readiness=0,event;
 h.target.addEventListener('TuringReady',()=>readiness++);h.target.addEventListener('TuringAccountChanged',e=>event=e.detail);
 h.ready();const init=h.init();assert(h.receive(init));assert(h.receive(init));assert.equal(readiness,1);assert.equal(h.wallets.length,1);
 const p=h.request('connect',{domain:'spoof.example'}),q=h.requests().at(-1).request;
 assert.equal(q.method,'connect');assert.equal(q.params.legacyJson,'{"domain":"spoof.example"}');
 const grants=[{parentCapability:'tbc_accounts',caveats:[{type:'restrictAccounts',value:['tbc:testnet:'+address]}]}];
 assert(h.receive(h.delivery(q.id,grants,{events:[{name:'accountsChanged',payload:[address]}]})));
 assert.deepEqual(json(await p),{tbcAddress:address});assert.deepEqual(json(event),{addresses:{tbcAddress:address}});
 const info=h.request('getInfo'),iq=h.requests().at(-1).request;assert(h.receive(h.delivery(iq.id,'tbc:testnet')));
 assert.deepEqual(json(await info),{name:'Partner Wallet',platform:'ios',version:'2.4.0'});
 h.bridge.close('epoch');assert.equal(h.target.Turing.isReady,false);
});
test('both native posts and both network displays retain independent correlation',async()=>{
 for(const android of [false,true]){
  const h=fixture({android});h.ready();assert(h.receive(h.init()));
  const p=h.request('getNetwork'),q=h.request('getNetwork'),requests=h.requests();
  assert.notEqual(requests[0].request.id,requests[1].request.id);
  assert(h.receive(h.delivery(requests[1].request.id,'tbc:mainnet')));
  assert(h.receive(h.delivery(requests[0].request.id,'tbc:testnet')));
  assert.deepEqual(json(await p),{network:'tbc',type:'testnet'});assert.deepEqual(json(await q),{network:'tbc',type:'mainnet'});
  h.bridge.close('epoch');
 }
});
test('four frozen Bitcoin message results preserve historical aliases without another execution',async()=>{
 const rows=JSON.parse(await readFile(join(base,'test/fixtures/legacy-message-signing.json'))).singles;
 const h=fixture();h.ready();h.receive(h.init());
 for(const row of rows){
  const pending=h.request('signMessage',{encoding:row.request.message.encoding,message:row.request.message.data}),q=h.requests().at(-1).request;
  const reply=h.delivery(q.id,row.result);assert(h.receive(reply));assert(h.receive(reply));
  const value=await pending;assert.deepEqual(json(value),{address:row.result.address,maddress:row.result.address,
   pubkey:row.result.publicKey,pubKey:row.result.publicKey,message:row.result.envelope.message.data,sig:row.result.signature});
 }
 assert.equal(h.requests().length,4);h.bridge.close('epoch');
});
test('balance preserves the frozen numeric display only after canonical native delivery',async()=>{
 const h=fixture();h.ready();assert(h.receive(h.init()));
 assert.deepEqual(json(await h.request('getBalance',null)),{error:'Invalid parameters'});
 assert.equal(h.requests().length,0);
 for(const atomic of ['0','1','1000000','1000001','9007199254740991']){
  const pending=h.request('getBalance'),q=h.requests().at(-1).request;
  assert(h.receive(h.delivery(q.id,{chainId:'tbc:testnet',address,balanceAtomic:atomic,decimals:6})));
  const padded=atomic.padStart(7,'0');
  assert.deepEqual(json(await pending),{tbc:Number(padded.slice(0,-6)+'.'+padded.slice(-6))});
 }
 assert.throws(()=>projectResult({method:'getBalance'},{chainId:'tbc:mainnet',address,balanceAtomic:'1',decimals:6},{chainId:'tbc:testnet'}));
 assert.throws(()=>projectResult({method:'getBalance'},{chainId:'tbc:testnet',address,balanceAtomic:'9007199254740992',decimals:6},{chainId:'tbc:testnet'}));
 h.bridge.close('epoch');
 const oracle=JSON.parse(await readFile(join(base,'test/fixtures/balance-frozen-kit.json')));
 for(const row of oracle.cases.filter(c=>c.result)){
  assert.deepEqual(projectResult({method:'getBalance'},{chainId:'tbc:'+row.network,address:row.address,
   balanceAtomic:String(row.response.balance),decimals:6},{chainId:'tbc:'+row.network}),row.result);
 }
});
test('business/user rejection resolves an error; authority termination and navigation reject',async()=>{
 const h=fixture();h.ready();h.receive(h.init());
 const rejected=h.request('sendTransaction',{});let q=h.requests().at(-1).request;
 assert(h.receive(h.delivery(q.id,null,{error:{code:4001,message:'Request rejected'}})));
 assert.deepEqual(json(await rejected),{error:'User cancelled the transaction'});
 const denied=h.request('getBalance');q=h.requests().at(-1).request;
 assert(h.receive(h.delivery(q.id,null,{error:{code:4200,message:'Unsupported method or profile'}})));
 assert.deepEqual(json(await denied),{error:'Unsupported legacy operation'});
 const cancelled=h.request('signMessage','hello'),closed=assert.rejects(cancelled,/Legacy wallet session closed/);q=h.requests().at(-1).request;
 assert(h.receive(h.delivery(q.id,null,{error:{code:4100,message:'Authorization changed'}})));await closed;
 const pending=h.request('getAddress'),gone=assert.rejects(pending,/Legacy wallet session closed/);
 h.target.dispatchEvent(new Event('pagehide'));await gone;assert(!h.receive(h.init()));
});
test('three merge aliases project canonical aggregates only, without execution logic',async()=>{
 const h=fixture();h.ready();h.receive(h.init());
 assert.deepEqual(json(await h.request('mergeUtxos',null)),{error:'Invalid parameters'});
 assert.equal(h.requests().length,0);
 for(const method of ['mergeUtxos','mergeFtUtxos','mergeStableCoinUtxos']){
  for(const [status,reason,initial,final,success]of [
   ['complete','target-reached',5,1,true],['complete','already-below-target',0,0,true],
   ['partial','index-stalled',5,3,false],['uncertain','broadcast-uncertain',5,5,false]]){
   const p=h.request(method,method==='mergeUtxos'?undefined:{contract_id:'a'.repeat(64)}),q=h.requests().at(-1).request;
   const result={version:'1.0',status,reason,initialUtxoCount:initial,finalUtxoCount:final,totalFee:'0',scopeHash:'b'.repeat(64),steps:[]};
   assert(h.receive(h.delivery(q.id,result)));const v=json(await p);
   assert.equal(v.success,success);assert(Number.isSafeInteger(v.duration)&&v.duration>=0);
   assert.deepEqual(Object.keys(v).sort(),method==='mergeStableCoinUtxos'?['duration','success','successCount']:['duration','success']);
   if(method==='mergeStableCoinUtxos')assert.equal(v.successCount,initial-final);
  }
  const p=h.request(method,method==='mergeUtxos'?undefined:'a'.repeat(64)),q=h.requests().at(-1).request;
  assert(h.receive(h.delivery(q.id,null,{error:{code:4001,message:'Request rejected'}})));
  assert.equal((await p).success,false);
 }
 h.bridge.close('epoch');
});
test('page input accessors are not invoked, decimals survive and source objects are snapshotted',async()=>{
 const h=fixture();h.ready();h.receive(h.init());
 const bad=runInContext('window.n=0;window.Turing.sendTransaction({get flag(){window.n++;return "P2PKH"}})',h.context);
 assert.deepEqual(json(await bad),{error:'Invalid parameters'});assert.equal(runInContext('window.n',h.context),0);
 const pending=runInContext('window.input={flag:"P2PKH",tbc_amount:0.001};window.promise=window.Turing.sendTransaction(window.input);window.input.tbc_amount=100;window.promise',h.context);
 const q=h.requests().at(-1).request;assert.equal(JSON.parse(q.params.legacyJson).tbc_amount,0.001);
 assert(h.receive(h.delivery(q.id,{transactions:[{rawTransaction:'00'},{rawTransaction:'01'}]})));
 assert.deepEqual(json(await pending),{txraw:'00,01'});h.bridge.close('epoch');
});
test('frozen atomic workflow rows have implicit success and preserve message signatures',async()=>{
 const reference=JSON.parse(await readFile(join(base,'test/fixtures/legacy-message-signing.json'))).workflows[0].expected.result;
 const rows=reference.steps.slice(0,2);assert(rows.every(s=>!Object.hasOwn(s,'status')));
 const context=projection('sendBatchRequest',rows.map(()=>({method:'signMessage'})));
 const result=projectResult(context,{...reference,steps:rows});
 assert.deepEqual(result.map(r=>r.sig),rows.map(s=>s.result.signature));
 assert.throws(()=>projectResult(context,{steps:rows.map(s=>({...s,status:'pending'}))}));
});
test('thin projections cover raw/associated/BIE1/broadcast/workflow without builders',()=>{
 assert.deepEqual(projectResult(projection('signTransaction'),{detachedSignatures:[['aa'],['bb']]}),{sigs:[['aa'],['bb']]});
 assert.deepEqual(projectResult(projection('signAssociatedTransaction'),{transactions:[{rawTransaction:'aa'}]}),{txraws:['aa']});
 assert.deepEqual(projectResult(projection('sendTransaction'),{transactions:[{txid:'a'.repeat(64)}]}),{txid:'a'.repeat(64)});
 assert.deepEqual(projectResult(projection('encrypt'),{ciphertext:'BIE1'}),{encryptedMessage:'BIE1'});
 assert.deepEqual(projectResult(projection('decrypt'),{message:{encoding:'hex',data:'e992b1e58c85'}}),{decryptedMessage:'钱包'});
 const context=projection('sendBatchRequest',[{method:'encrypt'},{method:'sendTransaction'},{method:'signMessage'}]);
 assert.deepEqual(projectResult(context,{steps:[{status:'completed',result:{ciphertext:'BIE1'}},{status:'failed',error:{message:'Request rejected'}},{status:'skipped'}]}),
  [{encryptedMessage:'BIE1'},{error:'Request rejected'},{error:'Previous request failed or produced no txids'}]);
});
test('stale epoch, historical channel, foreign scope and conflicting replay cannot reuse pending promises',async()=>{
 const h=fixture();h.ready();assert.equal(h.bridge.receiveLegacy('old',h.init()),false);assert.equal(h.target.Turing,undefined);
 assert(h.receive(h.init()));const pending=h.request('getAddress'),failed=assert.rejects(pending);
 assert.equal(h.receive(h.frame('delivery',{deliveryId:'a'.repeat(64),response:{jsonrpc:'2.0',id:'bad',result:[]},events:[]})),false);await failed;
 const other=fixture();other.ready();assert.equal(other.receive(other.init('legacy-window-turing-webview/1')),false);assert.equal(other.target.Turing,undefined);
});
