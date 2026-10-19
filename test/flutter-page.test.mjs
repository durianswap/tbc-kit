import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {createHash,webcrypto} from 'node:crypto';
import {createContext,runInContext} from 'node:vm';
import {canonical} from '../source/native/flutter-dart-kit/runtime/legacy-page.mjs';
const sha=s=>createHash('sha256').update(s).digest('hex');
const legacy='legacy-window-turing-shared/1';

for(const platform of ['ios','android']){
 const path=platform==='ios'?'ios/Resources':'android/src/main/assets/tbc-kit';
 const code=readFileSync(new URL(`../packages/flutter/${path}/tbc-webview-page.js`,import.meta.url),'utf8');
 function fixture(){
  const target=new EventTarget(),document=new EventTarget(),posted=[],wallets=[];
  target.location={origin:'https://wallet.example'};target.top=target;
  const postMessage=text=>posted.push(JSON.parse(text));
  if(platform==='ios')target.webkit={messageHandlers:{tbcKitNative:{postMessage}}};
  else target.tbcKitNative={postMessage};
  target.addEventListener('wallet-standard:register-wallet',e=>e.detail({register:w=>wallets.push(w)}));
  const ctx=createContext({window:target,document,Event,MessageEvent,CustomEvent,TextEncoder,TextDecoder,Uint8Array,ArrayBuffer,setTimeout,clearTimeout,URL,crypto:webcrypto,atob,btoa});
  runInContext(code,ctx);
  const bridge=target.__tbcFlutterPage;let sequence=0;
  const frame=(type,extra={},channel=legacy)=>canonical({channel,type,sessionId:'session',navigationId:'document',messageId:'native-'+(++sequence),...extra});
  const init=channel=>frame('initialize',{origin:target.location.origin,chainId:'tbc:testnet'},channel);
  assert(bridge.arm('epoch'));assert(bridge.receive('epoch',init('tws-webview/1')));
  assert(bridge.describe('epoch',{name:'Example Wallet',productId:'org.example.wallet',icon:'data:image/svg+xml,<svg/>',chains:['tbc:testnet'],platform,walletVersion:'1.0.0'}));
  const requests=()=>posted.map(p=>JSON.parse(p.serialized)).filter(m=>m.type==='request');
  const request=(method,params)=>runInContext(`window.Turing[${JSON.stringify(method)}](${params===undefined?'undefined':JSON.stringify(params)})`,ctx);
  const delivery=(id,result,channel=legacy)=>{const payload={response:{jsonrpc:'2.0',id,result},events:[]};return frame('delivery',{...payload,deliveryId:sha(canonical(payload))},channel);};
  const receive=text=>bridge.receiveLegacy('epoch',text);
  return{target,bridge,wallets,requests,request,delivery,receive,init,frame};
 }

 test(`${platform}: packaged WebView keeps Standard discovery and TBC-only Legacy`,async()=>{
  const h=fixture();assert.equal(h.wallets.length,1);assert.equal(h.target.Turing,undefined);
  const p=h.wallets[0].features['tbc:provider'].provider.request({method:'tbc_chainId'});
  await Promise.resolve();const q=h.requests().at(-1).request;
  assert(h.bridge.receive('epoch',h.delivery(q.id,'tbc:testnet','tws-webview/1')));
  assert.equal(await p,'tbc:testnet');
  assert(h.receive(h.init(legacy)));
  assert.equal(h.target.Turing.evm,undefined);assert.equal(h.target.Turing.btc,undefined);
  for(const method of ['sendTransaction','signTransaction','signAssociatedTransaction','sendBatchRequest','signMessage','encrypt','decrypt','mergeFtUtxos'])assert.equal(typeof h.target.Turing[method],'function');
  const pending=h.request('getNetwork'),rq=h.requests().at(-1).request;
  assert(h.receive(h.delivery(rq.id,'tbc:testnet')));
  assert.deepEqual(JSON.parse(JSON.stringify(await pending)),{network:'tbc',type:'testnet'});
  h.bridge.close('epoch');
 });

 test(`${platform}: Legacy signing result, correlation and navigation cancellation unchanged`,async()=>{
  const h=fixture();h.receive(h.init(legacy));
  const a=h.request('signMessage',{message:'hello',encoding:'utf8'}),b=h.request('getNetwork');
  const [qa,qb]=h.requests().map(r=>r.request);
  assert.notEqual(qa.id,qb.id);assert(h.receive(h.delivery(qb.id,'tbc:testnet')));
  assert(h.receive(h.delivery(qa.id,{address:'account',publicKey:'pubkey',signature:'signature',envelope:{message:{data:'hello'}}})));
  assert.deepEqual(JSON.parse(JSON.stringify(await a)),{address:'account',maddress:'account',pubkey:'pubkey',pubKey:'pubkey',sig:'signature',message:'hello'});
  assert.equal((await b).type,'testnet');
  const pending=h.request('getAddress'),cancelled=assert.rejects(pending,/Legacy wallet session closed/);
  h.target.dispatchEvent(new Event('pagehide'));await cancelled;
  assert.equal(h.target.Turing.isReady,false);
 });
}
