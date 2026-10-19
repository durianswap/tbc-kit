import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const require=createRequire(import.meta.url);
const bytes=await readFile(new URL('../artifacts/wasm/tbc_keyless_wasm.wasm',import.meta.url));

test('Node public ESM and CommonJS keyless defaults load local bytes without HTTP',async()=>{
 const original=globalThis.fetch;let requests=0;
 globalThis.fetch=async()=>{requests++;throw Error('unexpected network');};
 try {
  for(const kit of [await import('@tbc/kit'),await import('@tbc/kit/wallet'),require('@tbc/kit'),require('@tbc/kit/wallet')]){
   const engine=kit.createLazyBundledWasmTbcKeylessEngine();
   assert.equal(requests,0,'construction remains lazy');
   const [a,b]=await Promise.all([engine.protocolInfo(),engine.protocolInfo()]);
   assert.deepEqual(JSON.parse(a),JSON.parse(b));
   assert.ok(JSON.parse(a).operations.includes('inspectTokenMaterial'));
   await assert.rejects(engine.execute('sign','{}'),/KEYLESS_OPERATION_UNAVAILABLE/);
  }
  assert.equal(requests,0);
 } finally {globalThis.fetch=original;}
});

test('explicit keyless fetch remains authoritative and single-flight on every platform',async()=>{
 for(const kit of [await import('@tbc/kit'),await import('../dist/esm/index.js'),require('@tbc/kit')]){
  let requests=0;const url='https://assets.example/keyless.wasm';
  const engine=kit.createLazyBundledWasmTbcKeylessEngine({url,fetch:async input=>{
   requests++;assert.equal(String(input),url);return new Response(bytes);
  }});
  assert.equal(requests,0);
  await Promise.all([engine.protocolInfo(),engine.protocolInfo(),engine.protocolInfo()]);
  assert.equal(requests,1);
  let failures=0;const failed=kit.createLazyBundledWasmTbcKeylessEngine({url,fetch:async()=>{failures++;return new Response(null,{status:503});}});
  await assert.rejects(failed.protocolInfo(),/503/);await assert.rejects(failed.protocolInfo(),/503/);
  assert.equal(failures,1,'no silent file fallback or repeated load after explicit fetch failure');
 }
});

test('Node default reviewer keeps asset loading out of the injected API transport',async()=>{
 const api=await import('@tbc/kit/api');
 for(const kit of [await import('@tbc/kit/wallet'),require('@tbc/kit/wallet')]){
 const script='76a914'+'01'.repeat(20)+'88ac',previous='11'.repeat(32);
 const raw='0a00000001'+previous+'0000000000ffffffff01'+'8403000000000000'+'19'+script+'00000000';
 let requests=0;
 const reviewer=kit.createTbcDefaultRawTransactionReviewer({network:kit.createTbcNetworkContext({network:'testnet'}),
  fetch:async(url,init)=>{
   requests++;assert.equal(new URL(String(url)).pathname,'/api/tbc/txo/status');
   assert.deepEqual(JSON.parse(init.body),{txos:[{txid:previous,index:0}]});
   return new Response(JSON.stringify({code:'200',message:'OK',data:{txos:[{txid:previous,index:'0',spent:false,value:'1000',scriptPubKey:script}]}}));
  }});
 const result=await reviewer.review({context:{origin:'https://public.test',chainId:'tbc:testnet',accountId:'tbc:testnet:1LEF3thAWxd4WG8nvtjPb4An6kGCoweUu6',sessionId:'test',navigationId:'test'},
  transactionIds:[api.turingTransactionId(raw)],request:{txraws:[raw],utxos_satoshis:[[1000]],script_pubkeys:[[script]]}});
 assert.equal(result.verifiedInputs.length,1);assert.equal(requests,1);
 }
});

test('browser and RN conditions keep Node IO out; lightweight client construction never loads WASM',async()=>{
 const root=fileURLToPath(new URL('..',import.meta.url));
 for(const [condition,expectedRoot,expectedWallet] of [
  ['browser','index.js','wallet.js'],['react-native','index.native.js','wallet.js'],
 ]){
  const result=spawnSync(process.execPath,[`--conditions=${condition}`,'--input-type=module','-e',
   `import assert from 'node:assert/strict'; assert.ok(import.meta.resolve('@tbc/kit').endsWith('/${expectedRoot}')); assert.ok(import.meta.resolve('@tbc/kit/wallet').endsWith('/${expectedWallet}'));`],{cwd:root,encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
 }
 const bundle=async(contents,conditions)=>build({stdin:{contents,resolveDir:root},bundle:true,write:false,
  platform:'browser',format:'esm',conditions,treeShaking:true,metafile:true,logLevel:'silent',
  splitting:true,outdir:root+'/test/.virtual-keyless-platform-output'});
 const client=await bundle(`export {createTbcClient,getTbcWallets} from '@tbc/kit';`,['browser']);
 const entry=client.outputFiles.find(file=>file.path.endsWith('/stdin.js'));
 assert.ok(entry);assert.equal(entry.text.includes('node:fs'),false,'no Node IO in discovery entry');
 const originalFetch=globalThis.fetch,originalInstantiate=WebAssembly.instantiate,originalCompile=WebAssembly.compile;
 let loads=0;
 try {
  const forbidden=async()=>{loads++;throw Error('unexpected eager load');};
  globalThis.fetch=forbidden;WebAssembly.instantiate=forbidden;WebAssembly.compile=forbidden;
  const lightweight=await import(`data:text/javascript;base64,${Buffer.from(entry.text).toString('base64')}`);
  lightweight.createTbcClient({network:'tbc:testnet',provider:{request:async()=>{throw Error('unused');},on(){},removeListener(){},destroy(){}}});
  assert.equal(loads,0);
 } finally {globalThis.fetch=originalFetch;WebAssembly.instantiate=originalInstantiate;WebAssembly.compile=originalCompile;}
 for(const condition of ['browser','react-native']){
  const wallet=await bundle(`export {createTbcDefaultRawTransactionReviewer} from '@tbc/kit/wallet';`,[condition]);
  assert.ok(wallet.outputFiles.every(file=>!file.text.includes('node:fs')),'Node IO must not enter browser or RN chunks');
  assert.ok(!Object.keys(wallet.metafile.inputs).some(name=>/keyless-wasm-asset\.node|wallet\.node|\/node-[^/]+\.js$/u.test(name)));
 }
});
