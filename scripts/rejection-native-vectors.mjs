// Only public synthetic normalization vectors; no account keys, network or signing.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const [kitArg,outArg]=process.argv.slice(2),kit=resolve(kitArg);
const {createWasmTbcEngineBackend}=await import(pathToFileURL(kit+'/dist/esm/engine.js'));
const backend=await createWasmTbcEngineBackend(await readFile(kit+'/artifacts/wasm/tbc_engine_wasm.wasm'));
const hashes=['378f9624c2004981bc2a23117e4d41247de4f3ad','a3c16b99f8af5abafece1dcb9b46756e3f28f2e8',
  '4cb59d2f28f69a64862b99e94e90886856fe1111','11'.repeat(20),'ee'.repeat(20)];
const from='1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH',vectors=[];
for(const n of [1,2,3,4,5])for(const order of [hashes.slice(0,n),hashes.slice(0,n).reverse()]) {
  const input=JSON.stringify({version:'1.0',request:{version:'1.0',chainId:'tbc:testnet',from,
    intent:{type:'tbc-amm-create',version:'1.0',ftContractId:'ab'.repeat(32),lpTimelock:false,controllers:order,
      feePolicy:{lpFeeRate:30,taxFeeRate:0,serviceProviderFeeRate:0,protocolFeeRate:0,feeAddress:from}}}});
  const expected=await backend.call('normalizeRequest',input);const decoded=JSON.parse(expected);assert.equal(decoded.ok,true);
  assert.deepEqual(decoded.result.request.intent.controllers,[...order].sort());vectors.push({method:'normalizeRequest',input,expected});
}
for(const controllers of [[],[hashes[0],hashes[0]],[...hashes,'ff'.repeat(20)],['invalid']]) {
  const parsed=JSON.parse(vectors[0].input);parsed.request.intent.controllers=controllers;
  const input=JSON.stringify(parsed),expected=await backend.call('normalizeRequest',input);assert.equal(JSON.parse(expected).ok,false);
  vectors.push({method:'normalizeRequest',input,expected});
}
await writeFile(resolve(outArg),JSON.stringify(vectors,null,2)+'\n');console.log(JSON.stringify({vectors:vectors.length,realBroadcasts:0}));
