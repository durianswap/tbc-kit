// Offline installed-consumer check: no sockets, live APIs, custody or broadcast.
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {build} from 'esbuild';
import {gzipSync} from 'node:zlib';
import {verifiedKitCandidate} from '../../../native/flutter/scripts/candidate-inputs.mjs';
const [consumerArg,outArg]=process.argv.slice(2);assert.ok(outArg,'INSTALLED_CONSUMER NEW_EVIDENCE');
const consumer=resolve(consumerArg),out=resolve(outArg),kit=join(consumer,'node_modules/@tbc/kit');
await mkdir(out);const identity=await verifiedKitCandidate(kit);
const cases={api:[`export{createTbcOfficialApi}from'@tbc/kit/api'`,43000],rpc:[`export*from'@tbc/kit/rpc'`,32000],
  connect:[`export{createTbcClient,getTbcWallets}from'@tbc/kit'`,101000]};
const bundles=[];
for(const [name,[contents,limit]]of Object.entries(cases)){
  const b=await build({stdin:{contents,resolveDir:consumer},bundle:true,write:false,minify:true,format:'esm',platform:'browser',target:'es2020',metafile:true,logLevel:'silent'});
  const text=b.outputFiles[0].text;
  assert.ok(Buffer.byteLength(text)<=limit,`${name} size regressed`);
  assert.ok(!/node:fs/.test(text),`${name} includes Node file IO`);
  // Client also exposes receipt verification, so its JS legitimately retains
  // a lazy Keyless adapter. Do not mistake that for eager binary loading.
  if(name!=='connect')assert.ok(!/WebAssembly|tbc_\w+_wasm/.test(text),`${name} includes an unnecessary engine adapter`);
  const oldFetch=globalThis.fetch,oldCompile=WebAssembly.compile,oldInstantiate=WebAssembly.instantiate;let loads=0;
  try{
    const forbidden=async()=>{loads++;throw new Error('Unexpected eager loading');};
    globalThis.fetch=forbidden;WebAssembly.compile=forbidden;WebAssembly.instantiate=forbidden;
    const m=await import(`data:text/javascript;base64,${Buffer.from(text).toString('base64')}`);
    if(name==='connect')m.createTbcClient({network:'tbc:testnet',provider:{request:async()=>null,on(){},removeListener(){},destroy(){}}});
    assert.equal(loads,0);
  }finally{globalThis.fetch=oldFetch;WebAssembly.compile=oldCompile;WebAssembly.instantiate=oldInstantiate;}
  bundles.push({name,bytes:Buffer.byteLength(text),gzipBytes:gzipSync(text).length,wasmFetches:loads,
    containsLazyKeylessAdapter:/tbc_keyless_wasm/.test(text)});
}
// Exercise browser exports with explicit asset URLs, just as bundlers deploy
// copied WASM assets. The fetch implementation reads only frozen local bytes.
const b=await build({stdin:{contents:`export{createTbcEngine,createLazyBundledWasmTbcEngineBackend}from'@tbc/kit/engine';
export{createLazyBundledWasmTbcKeylessEngine,createNativeTbcKeylessEngine}from'@tbc/kit';`,resolveDir:consumer},
  bundle:true,write:false,format:'esm',platform:'browser',target:'es2020',minify:true,logLevel:'silent'});
const api=await import(`data:text/javascript;base64,${Buffer.from(b.outputFiles[0].contents).toString('base64')}`);
const urls={engine:'https://assets.invalid/engine.wasm',keyless:'https://assets.invalid/keyless.wasm'},loads={engine:0,keyless:0};
const bytes={engine:await readFile(join(kit,'artifacts/wasm/tbc_engine_wasm.wasm')),keyless:await readFile(join(kit,'artifacts/wasm/tbc_keyless_wasm.wasm'))};
const fetch=async url=>{const kind=Object.keys(urls).find(k=>String(url)===urls[k]);assert.ok(kind,'Unexpected resource URL');loads[kind]++;
  return {ok:true,arrayBuffer:async()=>Uint8Array.from(bytes[kind]).buffer};};
const engine=api.createLazyBundledWasmTbcEngineBackend({url:urls.engine,fetch});
const keyless=api.createLazyBundledWasmTbcKeylessEngine({url:urls.keyless,fetch});
assert.deepEqual(loads,{engine:0,keyless:0},'Construction must not load either WASM');
const engineResults=await Promise.all(Array.from({length:8},()=>engine.call('normalizeRequest','{}')));
assert.ok(engineResults.every(v=>v===engineResults[0]));assert.deepEqual(loads,{engine:1,keyless:0});
await engine.call('normalizeRequest','{}');assert.equal(loads.engine,1);
const keylessResults=await Promise.all(Array.from({length:8},()=>keyless.protocolInfo()));
assert.ok(keylessResults.every(v=>v===keylessResults[0]));assert.deepEqual(loads,{engine:1,keyless:1});
await keyless.protocolInfo();assert.equal(loads.keyless,1);
let nativeCalls=0;const oldCompile=WebAssembly.compile,oldInstantiate=WebAssembly.instantiate,oldFetch=globalThis.fetch;
try{
  const forbidden=async()=>{throw new Error('Native path must not load WASM');};
  globalThis.fetch=forbidden;WebAssembly.compile=forbidden;WebAssembly.instantiate=forbidden;
  api.createTbcEngine({backend:{call(){nativeCalls++;return '{}';}}});
  const native=api.createNativeTbcKeylessEngine(async()=>{nativeCalls++;return '{}';});
  await native.protocolInfo();assert.equal(nativeCalls,0);await native.execute('inspectTokenMaterial','{}');assert.equal(nativeCalls,1);
}finally{globalThis.fetch=oldFetch;WebAssembly.compile=oldCompile;WebAssembly.instantiate=oldInstantiate;}
const report={status:'PASS_ON_DEMAND_LOADING',identity,bundles,wasm:{zeroAtConstruction:true,independentFirstUse:true,loads,concurrentCalls:8,repeatedUseAddsNoFetch:true},
  native:{noWasm:true,protocolInfoBridgeCalls:0},realNetwork:false,realBroadcast:false,deviceAcceptance:false};
await writeFile(join(out,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
