// Private native/worker checkpoint only. Public methods and devices are not
// promoted by source tests. Never overwrite an existing report.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,join} from 'node:path';
const base=resolve(import.meta.dirname,'..'),[dart,output]=process.argv.slice(2);assert(dart&&output);
const sha=b=>createHash('sha256').update(b).digest('hex'),read=p=>readFile(join(base,p));
const nativePath='evidence/f3-bie1-native-custody-b.json',bytes=await read(nativePath),native=JSON.parse(bytes);
assert.equal(sha(bytes),'0b02bce3a2e2046ff6fcd51b36e5eeac7bc7b1d29c336aabd8dbbab107af1222');
for(const [p,pin]of Object.entries(native.sourceHashes))assert.equal(sha(await read(p)),pin,p);
assert.deepEqual(native.results.map(r=>r.checks),[180,180]);
const sources=['lib/src/internal/crypto_action.dart','lib/src/internal/signing_executor.dart','lib/src/signing_backend.dart',
 'lib/src/internal/signing_worker.dart','lib/src/internal/native_wallet_binding.dart','lib/src/internal/provider_control.dart',
 'lib/src/internal/provider_session.dart','test/crypto_action_test.dart','test/crypto_rust_test.dart','test/crypto_worker_test.dart',
 'test/native_wallet_binding_test.dart','test/signing_worker_test.dart','test/workflow_worker_test.dart',
 'tool/check_crypto_routing.mjs','tool/check_native_permissions.mjs','tool/check_workflow_native_binding.mjs',
 'tool/check_reviewed_native_binding.mjs','tool/check_reviewed_native_compute.mjs'];
const sourceHashes={};for(const p of sources)sourceHashes[p]=sha(await read(p));
const opts={cwd:base,encoding:'utf8',maxBuffer:8*1024*1024};
const analysis=execFileSync(dart,['analyze','--fatal-infos','lib',...sources.filter(p=>p.startsWith('test/'))],opts).trim();
const files=['crypto_action','crypto_rust','crypto_worker','native_wallet_binding','signing_worker','workflow_worker'];
const events=execFileSync(dart,['test',...files.map(p=>'test/'+p+'_test.dart'),'--reporter=json'],opts).trim().split('\n').map(JSON.parse);
assert.equal(events.findLast(e=>e.type==='done')?.success,true);
const passed=events.filter(e=>e.type==='testDone'&&!e.hidden&&!e.skipped&&e.result==='success');
const names=Object.fromEntries(events.filter(e=>e.type==='testStart').map(e=>[e.test.id,e.test.name]));
const actual=passed.map(e=>names[e.testID]);
assert.equal(actual.filter(n=>n.startsWith('private worker frozen ')).length,12);
assert.equal(actual.filter(n=>n.startsWith('actual frozen Rust ')).length,12);
assert.equal(actual.filter(n=>n.startsWith('actual Rust rejects ')).length,5);
const protectedState=JSON.parse(execFileSync(process.execPath,['tool/check_protected.mjs'],opts));
const report={status:'F3_BIE1_NATIVE_AND_PRIVATE_WORKER_PASS',recordedAt:new Date().toISOString(),
 native:{path:nativePath,sha256:sha(bytes),results:native.results,regression:native.regression},sourceHashes,
 tests:passed.length,testFiles:files,analysis,protectedState,
 proof:{nativeAssertionsPerPlatform:180,nativeHostCryptoDispatch:true,nativeExactResultEmission:true,
  privateWorkerFrozenCases:12,actualMacRustCases:12,actualMacRustNegativeCases:5,
  oneCryptoApproval:true,chainReads:0,signingJournalWrites:0,publicExecutableMethods:15,requiredMethods:22},
 limits:['Native optional BIE1 executor and private Dart worker/channel are connected; public Provider capabilities and workflow BIE1 remain gated.',
  'Native host checks replay public crypto results; actual macOS Rust checks are separate. Neither proves paired mobile BIE1 Vault/WebView integration.',
  'Flutter UI/MethodChannel framework constructors are hashed but not compiled in this host check. Existing paired device evidence remains historical.',
  'No new private Testnet, matched performance/size, minimum-OS/physical-device or final handoff proof.'],
 broadcasts:0,acceptedDeliveryChanged:false,frozenRustModified:false,published:false,goalComplete:false};
const out=JSON.stringify(report,null,2)+'\n';await writeFile(resolve(base,output),out,{flag:'wx'});
console.log(JSON.stringify({status:report.status,tests:report.tests,sha256:sha(out),protectedFiles:protectedState.protectedFiles,output}));
