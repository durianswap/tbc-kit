// Acceptance helper for public synthetic fixtures ONLY. Not a Kit export or
// production adapter: the native CLI must never receive custody/preimage data.
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
export async function sourceKeylessFixtureRuntime(root,{parity=false}={}){
  const {createWasmTbcKeylessEngine}=await import(pathToFileURL(join(root,'packages/kit/dist/esm/keyless.js')));
  const wasmPath=join(root,'packages/tbc-engine/rust/target/wasm32-unknown-unknown/release/tbc_keyless_wasm.wasm');
  const wasmBytes=readFileSync(wasmPath),wasm=await createWasmTbcKeylessEngine(wasmBytes);
  const directory=mkdtempSync(join(tmpdir(),'tbc-keyless-source-fixture-'));
  const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
  const evidence={sourceOnly:true,wasmSha256:sha(wasmBytes),nativeWasmCalls:0};
  if(!parity)return {engine:wasm,evidence,directory};
  assert.equal(process.platform,'darwin');assert.equal(process.arch,'arm64');
  const native=join(root,'packages/tbc-engine/rust/target/release'),library=join(native,'libtbc_keyless_native.dylib'),runner=join(directory,'runner');
  const cc=spawnSync('cc',[join(root,'packages/tbc-engine/scripts/keyless-native-runner.c'),
    '-I'+join(root,'packages/tbc-engine/rust/crates/tbc-keyless-native/include'),library,'-Wl,-rpath,'+native,'-o',runner],{encoding:'utf8'});
  assert.equal(cc.status,0,'Synthetic native fixture runner compilation failed');evidence.nativeSha256=sha(readFileSync(library));
  const engine={protocolInfo:()=>wasm.protocolInfo(),async execute(op,json){
    let output,error;try{output=await wasm.execute(op,json);}catch(e){error=e;}
    const result=spawnSync(runner,[op,json],{encoding:'utf8',maxBuffer:16*1024*1024});
    assert.equal(result.status,0,'Synthetic Native fixture execution failed');const nativeResult=JSON.parse(result.stdout);
    if(error){assert.equal(nativeResult.error,error.message,'Native/WASM fixture rejection differs');evidence.nativeWasmCalls++;throw error;}
    assert.deepEqual(nativeResult,JSON.parse(output),'Native/WASM fixture result differs');evidence.nativeWasmCalls++;return output;
  }};
  return {engine,evidence,directory};
}
