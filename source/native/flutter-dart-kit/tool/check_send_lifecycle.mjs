// Focused offline shared-send checkpoint. Not installed native HTTP custody or
// public send capability. Always write a fresh report, preserving older proof.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
const base=resolve(import.meta.dirname,'..'),[dart,output]=process.argv.slice(2);
assert(dart&&output);
const read=p=>readFile(join(base,p)),sha=b=>createHash('sha256').update(b).digest('hex');
const opts={cwd:base,encoding:'utf8',maxBuffer:8*1024*1024};
const sources=['lib/src/signing_backend.dart','lib/src/internal/send_lifecycle.dart',
 'lib/src/internal/signing_stages.dart','lib/src/internal/signing_executor.dart',
 'lib/src/internal/workflow_executor.dart','lib/src/internal/workflow_request.dart',
 'test/send_lifecycle_test.dart','tool/send_lifecycle_oracle.mjs','tool/check_send_lifecycle.mjs'];
const fixturePath='test/fixtures/send-lifecycle.json',bytes=await read(fixturePath),oracle=JSON.parse(bytes);
assert.equal(oracle.archiveSha256,'c51e3b63dd1ed2f542d40068450685e314328686d4a3ebab2717491333a478a0');
assert.equal(oracle.wasmSha256,'f23615f64478384330efab02ee79e07bc7ed0dff0e8fbaea34d50cdd56bfd4c0');
assert.equal(oracle.cases.length,17);assert.equal(oracle.http,0);assert.equal(oracle.broadcasts,0);
for(const [f,h]of Object.entries(oracle.provenance))assert.equal(sha(await read(`test/fixtures/${f}.json`)),h);
const tests=['test/send_lifecycle_test.dart','test/signing_executor_test.dart','test/workflow_execution_test.dart',
 'test/prepared_signing_test.dart','test/broadcast_port_test.dart','test/broadcast_client_test.dart'];
const analysis=execFileSync(dart,['analyze','--fatal-infos',...new Set([...sources.filter(p=>p.endsWith('.dart')),...tests])],opts).trim();
const events=execFileSync(dart,['test',...tests,'--reporter=json'],opts).trim().split('\n').map(JSON.parse);
assert.equal(events.findLast(e=>e.type==='done')?.success,true);
const names=new Map(events.filter(e=>e.type==='testStart').map(e=>[e.test.id,e.test.name]));
const passed=events.filter(e=>e.type==='testDone'&&!e.hidden&&!e.skipped&&e.result==='success').map(e=>names.get(e.testID));
assert.equal(passed.length,207);assert.equal(passed.filter(n=>n.startsWith('frozen Core send parity')).length,17);
const protection=JSON.parse(execFileSync(process.execPath,['tool/check_protected.mjs'],opts));
const previousPath='evidence/f3-broadcast-shared-b.json',previous=JSON.parse(await read(previousPath));
const changed=new Set(sources),unchangedRouting={};
for(const [p,h]of Object.entries(previous.routingUnchanged))if(!changed.has(p)){
 assert.equal(sha(await read(p)),h,p);unchangedRouting[p]=h;
}
const sourceHashes={};for(const p of [...sources,...tests])sourceHashes[p]=sha(await read(p));
const report={status:'F3_SHARED_SEND_LIFECYCLE_OFFLINE_PARITY_PASS',recordedAt:new Date().toISOString(),
 parent:{path:previousPath,sha256:sha(await read(previousPath))},reference:{path:fixturePath,sha256:sha(bytes),cases:17},
 analysis,sourceHashes,unchangedRouting,testFiles:tests,tests:passed.length,passed,protection,
 proof:{sharedSendMethods:4,sourceNativeDispatchInstalled:false,publicDeviceMethods:17,requiredMethods:22,
  oneApproval:true,parallelPrefetchRetained:true,prepareOncePerTransactionStep:true,sendAddsChainDataRefetch:false,
  signOnlyAddsPreBroadcastValidation:false,signOnlyAddsPersistence:false,enginePreBroadcastForSend:true,
  singleUnknownMaxOneReadOnlyReconciliation:true,workflowUsesOneBatch:true,unknownSubmitNeverRetried:true},
 implemented:[
  'Optional typed operation-bound broadcast custody interface; exact immutable bundle is authorized once, subsequent calls select index or full batch instead of accepting replacement raw bytes. No default sender or page raw-send endpoint.',
  'Four send strategies reuse the existing single/Prepared/workflow executor and same native approval receipt; close only after submit/reconcile returns. Whole-batch parent receipt and finalized-result deferred bindings remain shared.',
  'Common Engine stage runner validates pre-broadcast using the terminal stage material/signatures/continuation already in memory. No refetch, second plan, second approval or signature journal. Sign-only skips this phase and broadcast material allocation.',
  'Ordered single submissions, one read-only prefix reconciliation on ambiguity, batch partial/unknown/rejected projection and blocked-child results match actual frozen Core. No automatic POST retry or batch status polling.',
  'Ordinary and Prepared send workflow explicitly require the separate sendTransaction grant as well as their signWorkflow and child grants; a signing-only grant never authorizes broadcast.',
 ],
 intentionalDifferences:[
  'Frozen Core ordinary sends validate pre-broadcast. Its workflow path directly batches already-finalized child bundles. This candidate also runs each Engine child pre-broadcast phase locally before native admission, reusing exact material. Reviewed children retain the common Rust signature/effect verification; Engine is not invoked on incompatible Reviewed bytes. This adds local validation to send workflows, no reads; device timing must measure the cost before a performance claim.',
  'Lifecycle failures remain fixed internal codes until native/public error projection is wired. Error classes and output/state semantics are checked; no claim of an enabled public error surface.',
 ],
 failedAttempts:[
  'Frozen reference harness first supplied a sign grant for send; Core correctly rejected. Corrected reference to its distinct sendTransaction grant and carried this requirement into workflow checks.',
  'Reference harness initially assumed every workflow material query was batched and only one pending call. Corrected it to process actual frozen single/multiple pending calls and find policy material by canonical child request. No production validation was weakened.',
 ],
 remaining:[
  'Wire NativeCustody result/task/receipt authorization, native journal/one-use admission and bounded no-retry/no-redirect HTTP through the private channel. Enable the four Provider/worker routes only after this native boundary is proved.',
  'Use native-only operation/source/account identities; do not accept a page/Dart-selected endpoint or a serializable admission ticket. Cancel unstarted admissions on close and preserve genuine dispatched uncertainty for status-only recovery.',
  'Thin Legacy/network switching, actual paired installed native dispatch and private Testnet, matched segmented timings/Release increment, clean paired local package and concise partner docs remain required by the unchanged final goal.',
 ],
 limits:['Offline frozen Core/WASM against actual macOS Rust Engine; native approval/submit/status are synthetic doubles, not wallet custody or actual HTTP.',
  'Public/device methods stay17 of22; no send advertised by Provider or native Host. No new real-chain/device/performance/size/final delivery proof.'],
 http:0,broadcasts:0,acceptedDeliveryChanged:false,frozenRustModified:false,published:false,goalComplete:false};
const out=JSON.stringify(report,null,2)+'\n';await writeFile(resolve(base,output),out,{flag:'wx'});
console.log(JSON.stringify({status:report.status,tests:report.tests,protectedFiles:protection.protectedFiles,output,sha256:sha(out)}));
