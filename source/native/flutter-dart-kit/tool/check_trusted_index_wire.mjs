// Offline replay of source-Native wire observations against source WASM and
// current public validators. Input contains only synthetic fixture transactions.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,join} from 'node:path';
import {build} from 'esbuild';
import {createWasmTbcEngineBackend} from '../../../release/kit-contract173-20261014-c/package/dist/esm/engine.js';
const repo=resolve(import.meta.dirname,'../../..');
const [wirePath,output]=process.argv.slice(2);assert(wirePath&&output,'wire log and new evidence directory required');
const wasm=await readFile(join(repo,'packages/tbc-engine/rust/target/wasm32-unknown-unknown/release/tbc_engine_wasm.wasm'));
const engine=await createWasmTbcEngineBackend(wasm);
const built=await build({entryPoints:[join(repo,'packages/core/src/index.ts')],bundle:true,write:false,format:'esm',platform:'node',logLevel:'silent'});
const {assertValidTws}=await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].contents).toString('base64'));
const rows=(await readFile(wirePath,'utf8')).split('\n').filter(line=>line.startsWith('AMM_WIRE:')).map(line=>JSON.parse(line.slice(9)));
const methods={planParams:'plan',finalizeParams:'finalize',validateParams:'validate'};
let checked=0,plans=0,finalizations=0;
for(let i=0;i<rows.length-1;i++){
 const row=rows[i],method=methods[row.definition];
 if(!method||!row.value.snapshot?.payload.contracts.some(c=>c.indexedPool))continue;
 const expected=rows[i+1];assertValidTws(row.definition,row.value);
 const actual=JSON.parse(await engine.call(method,JSON.stringify(row.value)));
 assert.equal(actual.ok,true,JSON.stringify(actual.error));
 assertValidTws(expected.definition,actual.result);assert.deepEqual(actual.result,expected.value);
 checked++;if(method==='plan')plans++;if(method==='finalize')finalizations++;
}
assert.equal(plans,8);assert.equal(finalizations,8);
await mkdir(output); // Never overwrite a frozen report directory.
const report={scope:'source Native and WASM, synthetic fixture replay',wasmSha256:createHash('sha256').update(wasm).digest('hex'),
 checked,plans,finalizations,identical:true,currentSchemasPassed:true,networkRequests:0,broadcasts:0};
await writeFile(join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
