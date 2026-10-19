// Replay public synthetic Native vectors against an exact installed Kit WASM.
// No network, wallet key, device change or transaction broadcast.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
const [consumerArg]=process.argv.slice(2);
assert.ok(consumerArg&&process.argv.length===3,'Usage: EXACT_INSTALLED_KIT_CONSUMER');
const installed=join(resolve(consumerArg),'node_modules/@tbc/kit');
const manifest=JSON.parse(await readFile(join(installed,'package.json')));
const provenance=JSON.parse(await readFile(join(installed,'artifacts/provenance.json')));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
assert.equal(provenance.package,`@tbc/kit@${manifest.version}`);
for(const entry of provenance.artifacts)assert.equal(hash(await readFile(join(installed,entry.path))),entry.sha256,entry.path);
const {createWasmTbcEngineBackend}=await import(pathToFileURL(join(installed,'dist/esm/engine.js')));
const bytes=await readFile(join(installed,'artifacts/wasm/tbc_engine_wasm.wasm'));
const wasm=await createWasmTbcEngineBackend(bytes);
const rust=resolve(import.meta.dirname,'../rust');
const run=spawnSync('cargo',['test','--locked','--offline','-p','tbc-engine-core','--test','coin_public',
  'coin_public_management_uses_common_binding_signer_and_conserves_targets','--','--exact','--nocapture'],
  {cwd:rust,env:{...process.env,COIN_DUMP_WIRE:'1'},encoding:'utf8',timeout:60000,maxBuffer:16*1024*1024});
assert.ok(!run.error&&run.status===0&&/test result: ok\. 1 passed; 0 failed;/.test(run.stdout),'Synthetic Native source gate failed; raw material withheld');
const methods={normalizeRequestParams:['normalizeRequest','normalizeRequestResult'],planParams:['plan','planResult'],
  validateParams:['validate','validationResult'],finalizeParams:['finalize','finalizeResult']};
let pending,calls=0;const counts={};
for(const line of run.stdout.split(/\r?\n/)){
  const offset=line.indexOf('COIN_WIRE:');if(offset<0)continue;
  let wire;try{wire=JSON.parse(line.slice(offset+'COIN_WIRE:'.length));}catch{throw Error('Malformed wire; material withheld');}
  const method=methods[wire.definition];
  if(method){
    assert.equal(pending,undefined,'Missing prior result');
    const response=JSON.parse(await wasm.call(method[0],JSON.stringify(wire.value)));
    assert.equal(response.ok,true,`Packaged ${method[0]} rejected input; material withheld`);
    pending={definition:method[1],value:response.result};counts[method[0]]=(counts[method[0]]??0)+1;
  }else{
    assert.ok(pending?.definition===wire.definition&&isDeepStrictEqual(pending.value,wire.value),`Packaged ${wire.definition} differs; material withheld`);
    pending=undefined;calls++;
  }
}
assert.equal(pending,undefined);assert.equal(calls,40);assert.equal(Object.keys(counts).length,4);
console.log(JSON.stringify({status:'INSTALLED_COIN_MANAGEMENT_PASS',candidate:manifest.version,consumer:resolve(consumerArg),
  wasmSha256:hash(bytes),nativeWasmCalls:calls,counts,synthetic:true,transactionBroadcasts:0,deviceAcceptance:false}));
