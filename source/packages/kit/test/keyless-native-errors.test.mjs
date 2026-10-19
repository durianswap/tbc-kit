import assert from 'node:assert/strict';
import test from 'node:test';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
const result=await build({entryPoints:[fileURLToPath(new URL('../src/keyless.ts',import.meta.url))],
 bundle:true,write:false,platform:'node',format:'esm',logLevel:'silent'});
const {createNativeTbcKeylessEngine}=await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);

test('native error envelopes reject with the original sanitized Rust reason',async()=>{
 let calls=0;
 const engine=createNativeTbcKeylessEngine(async()=>{calls++;return '{"error":"Current associated ancestor set required"}';});
 await assert.rejects(engine.execute('prepareReviewedStage','{}'),{message:'Current associated ancestor set required'});
 assert.equal(calls,1);
});
test('native malformed result rejects at the ABI boundary',async()=>{
 const engine=createNativeTbcKeylessEngine(async()=>'not-json');
 await assert.rejects(engine.execute('prepareReviewedStage','{}'),{message:'Invalid TBC keyless response'});
});
test('native successful bytes are unchanged and transport errors are not retried',async()=>{
 const raw=' { "digests": ["public-fixture"] }\n';let calls=0;
 const engine=createNativeTbcKeylessEngine(async()=>{calls++;return raw;});
 assert.equal(await engine.execute('prepareReviewedStage','{}'),raw);assert.equal(calls,1);
 const failure=new Error('transport-closed');
 const closed=createNativeTbcKeylessEngine(async()=>{calls++;throw failure;});
 await assert.rejects(closed.execute('prepareReviewedStage','{}'),error=>error===failure);assert.equal(calls,2);
 await assert.rejects(engine.execute('sign','{}'),/KEYLESS_OPERATION_UNAVAILABLE/);assert.equal(calls,2);
});
