// Targeted Provider/worker/native-projection checkpoint. No device/chain claim.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile, writeFile} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {createHash} from 'node:crypto';
const base=resolve(import.meta.dirname,'..'), dart=process.argv[2], output=process.argv[3];
assert(dart && output, 'Dart executable and new report path required');
const read=p=>readFile(join(base,p)), sha=b=>createHash('sha256').update(b).digest('hex');
const opts={cwd:base,encoding:'utf8',maxBuffer:8*1024*1024};
const tests=['test/workflow_provider_test.dart','test/provider_session_test.dart',
 'test/workflow_worker_test.dart','test/signing_worker_test.dart','test/native_wallet_binding_test.dart',
 'test/prepared_provider_test.dart','test/reviewed_provider_test.dart','test/typed_provider_test.dart'];
const analysis=execFileSync(dart,['analyze','lib',...tests],opts).trim();
const events=execFileSync(dart,['test',...tests,'--reporter=json'],opts).trim().split('\n').map(s=>JSON.parse(s));
assert.equal(events.findLast(e=>e.type==='done')?.success,true);
const passed=events.filter(e=>e.type==='testDone'&&!e.hidden&&!e.skipped&&e.result==='success').length;
const protection=JSON.parse(execFileSync(process.execPath,['tool/check_protected.mjs'],opts));
const parentPath='evidence/f3-workflow-native-failure-design.json',parentBytes=await read(parentPath);
for(const [p,h]of Object.entries(JSON.parse(parentBytes).reports))assert.equal(sha(await read(p)),h,p);
const nativePath='evidence/f3-workflow-provider-native-trace-a.json', nativeBytes=await read(nativePath),native=JSON.parse(nativeBytes);
assert.deepEqual(native.warnings,[]);
for(const c of native.checks){assert.equal(c.status,'PASS');assert.equal(c.workflowTraceCases,3);assert.equal(c.workflowRecoverableFailures,1);}
for(const [p,h]of Object.entries(native.sourceHashes))assert.equal(sha(await read(p)),h,p);
// Native result-emission guards commit this same capability projection.
const provider=(await read('lib/src/internal/provider_session.dart')).toString();
const methods=[...provider.match(/static const methods = \[([\s\S]*?)\];/)[1].matchAll(/'(\w+)'/g)].map(m=>m[1]).sort();
assert.equal(methods.length,15);
for(const [file,pattern]of [
 ['platform/ios/Classes/NativeWalletHost.swift',/"methods":Dictionary\(uniqueKeysWithValues:\(\[([\s\S]*?)\]\+\(custody/],
 ['platform/android/src/main/kotlin/io/tbc/kit/dart/NativeWalletHost.kt',/"methods" to \(listOf\(([\s\S]*?)\)\+if\(custody/],
]){
 const source=(await read(file)).toString();
 const selected=[...source.match(pattern)[1].matchAll(/"(\w+)"/g)].map(m=>m[1]);
 selected.push('tbc_signReviewedTransaction');
 assert.deepEqual(selected.sort(),methods,file);
 assert(/"workflowSteps"(?::| to )5/.test(source),file);
}
const files=[...tests,'lib/src/internal/provider_session.dart','lib/src/internal/provider_control.dart',
 'lib/src/internal/signing_worker.dart','lib/src/internal/workflow_request.dart','lib/src/internal/workflow_executor.dart',
 'lib/src/internal/native_wallet_binding.dart','platform/ios/Classes/NativeWalletHost.swift',
 'platform/android/src/main/kotlin/io/tbc/kit/dart/NativeWalletHost.kt','tool/check_workflow_provider.mjs'];
const sourceHashes={};for(const p of files)sourceHashes[p]=sha(await read(p));
const report={status:'F3_WORKFLOW_PROVIDER_SOURCE_PASS',recordedAt:new Date().toISOString(),
 parent:{path:parentPath,sha256:sha(parentBytes)},native:{path:nativePath,sha256:sha(nativeBytes),checks:native.checks},
 testFiles:tests,tests:passed,analysis,sourceHashes,protection,
 sourceProviderMethods:15,previousDeviceProviderMethods:13,
 implemented:[
  'Generic and Prepared sign-only workflows use the existing worker/native custody, one parent consent and live child grants. The private partial-failure result reaches the same Provider transport.',
  'Wallet-owned custom policy applies to each distinct single-call child projection, with exact policy-map coverage and authority checks. Default policy adds no callback, HTTP or persistence.',
  'Prepared proposal bytes/tasks/fees and dependent-message output match frozen references. Missing/revoked grants, malformed topology, invalid wallet policy and not-yet-installed crypto fail before signing.',
 ], observations:{messageReads:0,nativeTransferAndMessageReads:2,preparedTransferAndTypedReads:2,approvalsPerWorkflow:1},
 limits:[
  'Dart wire/worker tests use public signature replay; native host tests separately run frozen Rust C ABI/JNI. Neither proves installed iOS/Android WebView delivery or private Vault signing.',
  'Candidate sources advertise15 methods, while the last installed device checkpoint remains13. No new device, Testnet, matched speed, release size or complete handoff claim.',
  'Workflow encrypt/decrypt and send variants remain gated. The full final goal is active.',
 ],acceptedDeliveryChanged:false,frozenRustModified:false,broadcasts:0,published:false,goalComplete:false};
const bytes=JSON.stringify(report,null,2)+'\n';await writeFile(resolve(base,output),bytes,{flag:'wx'});
console.log(JSON.stringify({status:report.status,tests:passed,sourceMethods:15,deviceMethods:13,protectedFiles:protection.protectedFiles,sha256:sha(bytes)}));
