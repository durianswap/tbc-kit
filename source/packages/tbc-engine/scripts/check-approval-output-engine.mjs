import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const repo=resolve(import.meta.dirname,'../../../..'),compute=resolve(process.argv[2]),out=resolve(process.argv[3]);
await mkdir(out,{recursive:true});const report={status:'RUNNING',scope:'Offline Engine plan parity and warm local computation; not mobile or API latency',cases:[],networkReads:0,broadcasts:0};
const sha=b=>createHash('sha256').update(b).digest('hex'),median=a=>[...a].sort((a,b)=>a-b)[Math.floor(a.length/2)];
const runner=join(out,'native-call');execFileSync('xcrun',['clang++','-O2','-std=c++17',join(import.meta.dirname,'approval-output-native-check.cpp'),'-o',runner]);
const {createWasmTbcEngineBackend}=await import(pathToFileURL(join(repo,'packages/kit/dist/esm/engine.js')));
const newPath=join(compute,'target/wasm32-unknown-unknown/release/tbc_engine_wasm.wasm'),oldPath=join(repo,'packages/kit/artifacts/wasm/tbc_engine_wasm.wasm');
const fresh=await createWasmTbcEngineBackend(await readFile(newPath)),old=await createWasmTbcEngineBackend(await readFile(oldPath));
const native=join(compute,'target/aarch64-apple-darwin/release/libtbc_compute_native.dylib');
const call=async(e,m,p)=>{const v=JSON.parse(await e.call(m,JSON.stringify(p)));assert(v.ok,JSON.stringify(v.error));return v.result;};
const corpus=JSON.parse(await readFile(join(repo,'source/native/flutter-dart-kit/test/fixtures/workflow-planning.json'))).cases;
const seen=new Set();
for(const c of corpus)for(const entry of c.plan.payload.transactionPlans){
 const material=c.materials[entry.stepId],step=c.request.steps.find(s=>s.id===entry.stepId);if(!material||!step)continue;
 const request={version:'1.0',chainId:c.request.chainId,from:c.request.from,intent:step.intent,...step.constraints?{constraints:step.constraints}:{},...step.signingRoles?{signingRoles:step.signingRoles}:{}};
 const n=await call(fresh,'normalizeRequest',{version:'1.0',request}),input={version:'1.0',...n,...material};
 const key=sha(JSON.stringify(input));if(seen.has(key))continue;seen.add(key);
 const expected=await call(fresh,'plan',input),nativeResult=JSON.parse(execFileSync(runner,[native,'plan','20'],{input:JSON.stringify(input),maxBuffer:20e6}));
 assert.deepEqual(nativeResult.result,{version:'1.0',ok:true,result:expected},'Native/WASM output mismatch');
 const previous=await call(old,'plan',input),stripped=structuredClone(expected.plan.payload);for(const tx of stripped.transactions)delete tx.outputReview;
 assert.deepEqual(stripped,previous.plan.payload,'Changed transaction/fee/digest');
 const times={old:[],candidate:[]};
 for(let i=0;i<21;i++)for(const name of i%2?['candidate','old']:['old','candidate']){
  const start=performance.now();await call(name==='old'?old:fresh,'plan',input);if(i)times[name].push(performance.now()-start);
 }
 const validate={...input,plan:expected.plan,phase:'plan'};assert((await call(fresh,'validate',validate)).valid);
 const checked=JSON.parse(execFileSync(runner,[native,'validate','1'],{input:JSON.stringify(validate),maxBuffer:20e6}));assert.deepEqual(checked.result,{version:'1.0',ok:true,result:await call(fresh,'validate',validate)});
 report.cases.push({name:c.name,transactions:expected.plan.payload.transactions.length,outputs:expected.plan.payload.transactions.map(t=>t.outputReview),
  rawFeesDigestsUnchanged:true,nativeWasmEqual:true,wasmMedianMs:{old:median(times.old),candidate:median(times.candidate)},nativeMedianMs:median(nativeResult.warmMs),samples:times});
}
report.status='PASS_ENGINE_OUTPUT_PARITY';report.newWasmSha256=sha(await readFile(newPath));report.oldWasmSha256=sha(await readFile(oldPath));
await writeFile(join(out,'engine-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({status:report.status,cases:report.cases.map(({outputs,samples,...r})=>r)}));
