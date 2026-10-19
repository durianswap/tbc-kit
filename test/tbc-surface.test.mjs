import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {webcrypto,createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import * as wallet from '../packages/kit/dist/esm/wallet.js';

const root=new URL('../',import.meta.url);
const read=p=>readFileSync(new URL(p,root));
const json=p=>JSON.parse(read(p));
const sha=b=>createHash('sha256').update(b).digest('hex');
const methods=['evm.sendTransaction','btc.sendTransaction','btc.signTransaction','btc.sendBatchRequest'];
const nav={webViewInstanceId:'view',sessionId:'session',navigationId:'document',committedUrl:'https://dapp.example',origin:'https://dapp.example',topOrigin:'https://dapp.example',frame:'top',createdAt:'2026-10-19T00:00:00Z'};

for(const [format,kit]of [['ESM',wallet],['CommonJS',createRequire(import.meta.url)('../packages/kit/dist/cjs/wallet.cjs')]]){
 test(`${format}: TBC Legacy page/controller preserve connection without other-chain facades`,async()=>{
  const window=new EventTarget(),document=new EventTarget(),requests=[];let controller,ordinal=0;
  Object.assign(window,{top:window,ReactNativeWebView:{postMessage:text=>void controller.acceptPageMessage(text)}});
  const context=vm.createContext({window,document,CustomEvent,Event,EventTarget,MessageEvent,TextEncoder,TextDecoder,Uint8Array,crypto:webcrypto,setTimeout,clearTimeout});
  vm.runInContext(kit.TBC_KIT_LEGACY_PAGE_BOOTSTRAP_SCRIPT,context);
  controller=kit.createTbcKitLegacyWebViewNativeController({navigation:nav,chainId:'tbc:testnet',platform:'ios',walletVersion:'test',
   handlers:{async send(r){requests.push(r);const result=r.method==='tbc_chainId'?'tbc:testnet':r.method==='tbc_accounts'?['account']:[];
    return{deliveryId:(++ordinal).toString(16).padStart(64,'0'),response:{jsonrpc:'2.0',id:r.id,result},events:[]};},async acknowledgeDelivery(){},async cancel(){},async close(){}},
   post:text=>window.dispatchEvent(new MessageEvent('message',{data:text}))});
  controller.initialize();await new Promise(setImmediate);
  assert.equal(window.Turing.evm,undefined);assert.equal(window.Turing.btc,undefined);
  for(const name of ['connect','disconnect','getAddress','getNetwork','signMessage','sendTransaction','signTransaction','signAssociatedTransaction','encrypt','decrypt','sendBatchRequest','mergeUtxos','mergeFtUtxos','mergeStableCoinUtxos'])assert.equal(typeof window.Turing[name],'function',name);
  assert.deepEqual(JSON.parse(JSON.stringify(await window.Turing.connect())),{tbcAddress:'account'});
  const results=await Promise.all([window.Turing.getNetwork(),window.Turing.getNetwork()]);
  assert(results.every(r=>r.network==='tbc'&&r.type==='testnet'));
  for(const method of methods)assert.equal(controller.supportsRequest(method,{}),false);
  const before=requests.length;
  await controller.acceptPageMessage(JSON.stringify({channel:kit.TBC_KIT_LEGACY_WEBVIEW_CHANNEL,type:'request',sessionId:'session',navigationId:'document',requestId:'forged',method:'evm.sendTransaction',params:{}}));
  assert.equal(requests.length,before);
  await controller.close();
 });
}

test('contract, source and package declarations share the TBC-only method set',()=>{
 const contract=json('source/contracts/legacy-window-turing/v1/contract.json');
 assert.equal(contract.version,wallet.TBC_KIT_LEGACY_CONTRACT_VERSION);
 assert.deepEqual(contract.fields,['isReady']);
 assert(!contract.profiles.some(p=>['btc','evm'].includes(p.id)));
 for(const method of methods)assert(!contract.methods.some(m=>m.path===method));
 for(const path of ['source/packages/kit/src/legacy-webview-protocol.ts','packages/kit/dist/types/legacy-webview-protocol.d.ts','packages/kit/dist/types/legacy-webview-page-bootstrap.d.ts']){
  for(const method of methods)assert(!read(path).includes(method),`${path}: ${method}`);
 }
 const manifest=json('source/contracts/legacy-window-turing/v1/manifest.json');
 for(const file of manifest.files)assert.equal(sha(read('source/contracts/legacy-window-turing/v1/'+file.path)),file.sha256);
 assert.equal(manifest.bundleSha256,wallet.TBC_KIT_LEGACY_CONTRACT_BUNDLE_SHA256);
});

test('Flutter iOS/Android ship the same page with matching integrity hashes',()=>{
 const paths=['android/src/main/assets/tbc-kit','ios/Resources'];
 const first=read('packages/flutter/'+paths[0]+'/tbc-webview-page.js');
 for(const path of paths){
  const page=read('packages/flutter/'+path+'/tbc-webview-page.js');
  assert.deepEqual(page,first);
  assert.equal(sha(page),json('packages/flutter/'+path+'/distribution.json').pageSha256);
  assert(!page.includes('evm.sendTransaction'));
 }
 const dist=json('packages/flutter/distribution.json');
 for(const[path,hash]of Object.entries(dist.nativeArtifacts))assert.equal(sha(read('packages/flutter/'+path)),hash);
});

test('public Provider and network registry contain only TBC and wallet methods',()=>{
 const registry=json('source/registry/methods.json');
 for(const method of registry.methods)assert.match(method.name,/^(tbc_|wallet_)/);
 assert.deepEqual(json('source/registry/networks.json').networks.map(n=>n.chainId),['tbc:mainnet','tbc:testnet']);
});

test('Flutter distribution describes the current SDK without patch history',()=>{
 const pubspec=read('packages/flutter/pubspec.yaml').toString();
 const version=pubspec.match(/^version: (.+)$/m)[1];
 assert(!/candidate|partner\.\d{8}/i.test(pubspec));
 assert(read('packages/flutter/android/build.gradle').toString().includes(`version '${version}'`));
 for(const path of ['distribution.json','ios/Resources/distribution.json','android/src/main/assets/tbc-kit/distribution.json']){
  const dist=json('packages/flutter/'+path);
  assert.equal(dist.version,version);
  for(const key of ['chainReadReplyPatch','lpContinuationPatch','sessionRepair','nativeWalletActions','preparedWorkflowExpiry'])assert(!(key in dist));
  assert.equal(dist.defaults.automaticApproval,false);
  assert.equal(dist.defaults.fixtureKeys,false);
 }
 for(const path of ['README.md','NOTICE.md'])assert(!/本候选|其他候选/.test(read('packages/flutter/'+path).toString()));
});
