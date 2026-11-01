import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
const root=resolve(import.meta.dirname,'../../..'),out=join(root,'.verify/rc23-mint100-repro');
const engine=await import(pathToFileURL(join(root,'packages/kit/dist/esm/engine.node.js')));
const wallet=await import(pathToFileURL(join(root,'packages/kit/dist/esm/wallet.node.js')));
const native=await engine.createWasmTbcEngineBackend(await readFile(join(root,'packages/kit/artifacts/wasm/tbc_engine_wasm.wasm')));
const keyless=await wallet.createWasmTbcKeylessEngine(await readFile(join(root,'packages/kit/artifacts/wasm/tbc_keyless_wasm.wasm')));
let resolveDone;const done=new Promise(r=>resolveDone=r);
const scenario=process.env.TBC_RC23_SCENARIO??'baseline';
if(!['baseline','expiry','expiry-provider'].includes(scenario))throw Error('Unknown scenario');
globalThis.rc23Scenario=scenario;
globalThis.document={querySelector:()=>({textContent:''})};globalThis.window=globalThis;
const events=new EventTarget();globalThis.addEventListener=events.addEventListener.bind(events);globalThis.dispatchEvent=events.dispatchEvent.bind(events);globalThis.removeEventListener=events.removeEventListener.bind(events);
globalThis.TbcProbe={postMessage:raw=>{const m=JSON.parse(raw);if(m.kind==='call'){
  Promise.resolve(m.family==='engine'?native.call(m.method,m.input):keyless.execute(m.method,m.input)).then(v=>globalThis.__nativeComplete(m.id,v,null),e=>globalThis.__nativeComplete(m.id,null,String(e.message)));
}else if(m.kind==='progress'){const r=JSON.parse(m.text);console.log(JSON.stringify(r.syntheticTxids?{...r,publicResult:r.publicResult?{type:r.publicResult.type,txids:r.publicResult.txids?.length}:undefined,syntheticTxids:r.syntheticTxids.length}:r))}
else if(m.kind==='report')resolveDone(JSON.parse(m.text));}};
await import(pathToFileURL(join(out,'suite.js')));
const report=await done;report.environment='Node.js controlled browser-bundle execution with frozen WASM; not a device or chain run';
await writeFile(join(out,scenario+'-report.json'),JSON.stringify(report,null,2));
const evidence=join(root,'docs/acceptance/evidence/rc23-mint100-repro');await mkdir(evidence,{recursive:true});
await writeFile(join(evidence,scenario+'-report.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify({status:report.status,tests:report.tests}));
