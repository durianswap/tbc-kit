// Focused public Provider and private Flutter/worker send integration. Native HTTP and
// Flutter-framework compilation are separate evidence, not installed acceptance.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,join} from 'node:path';
const base=resolve(import.meta.dirname,'..'),[dart,nativePath,flutterPath,output]=process.argv.slice(2);
assert(dart&&nativePath&&flutterPath&&output);
const read=p=>readFile(join(base,p)),sha=b=>createHash('sha256').update(b).digest('hex');
const opts={cwd:base,encoding:'utf8',maxBuffer:8*1024*1024};
const tests=['test/native_broadcast_binding_test.dart','test/send_worker_test.dart',
 'test/native_wallet_binding_test.dart','test/signing_worker_test.dart','test/workflow_worker_test.dart',
 'test/send_lifecycle_test.dart','test/broadcast_port_test.dart','test/broadcast_client_test.dart',
 'test/provider_send_test.dart','test/provider_session_test.dart'];
const sources=['lib/src/internal/native_broadcast_binding.dart','lib/src/internal/native_wallet_binding.dart',
 'lib/src/internal/signing_worker.dart','lib/src/internal/provider_control.dart','lib/src/signing_backend.dart',
 'lib/src/internal/send_lifecycle.dart','lib/src/internal/broadcast_port.dart','lib/src/internal/broadcast_client.dart',
 'lib/src/internal/signing_executor.dart','lib/src/internal/signing_stages.dart','lib/src/internal/workflow_executor.dart',
 'lib/src/internal/workflow_request.dart','lib/src/internal/provider_session.dart',
 'lib/src/internal/wire_session.dart','tool/check_send_channel.mjs',...tests];
const parents=[];
for(const [path,expected,key]of [[nativePath,'F3_NATIVE_SEND_RESULT_LOOPBACK_PASS','sourceHashes'],
 [flutterPath,'F1_FLUTTER_NATIVE_SOURCES_COMPILE_PASS','sources']]){
 const bytes=await read(path),r=JSON.parse(bytes);assert.equal(r.status,expected);
 for(const [p,h]of Object.entries(r[key]))assert.equal(sha(await read(p)),h,`Stale evidence: ${p}`);
 parents.push({path,sha256:sha(bytes),status:r.status,sourceFiles:Object.keys(r[key]).length});
}
const analysis=execFileSync(dart,['analyze','--fatal-infos',...new Set(sources.filter(p=>p.endsWith('.dart')))],opts).trim();
const events=execFileSync(dart,['test',...tests,'--reporter=json'],opts).trim().split('\n').map(JSON.parse);
assert.equal(events.findLast(e=>e.type==='done')?.success,true);
const names=new Map(events.filter(e=>e.type==='testStart').map(e=>[e.test.id,e.test.name]));
const passed=events.filter(e=>e.type==='testDone'&&!e.hidden&&!e.skipped&&e.result==='success').map(e=>names.get(e.testID));
assert.equal(passed.filter(n=>n.startsWith('private worker preserves shared preparation')).length,4);
assert.equal(passed.filter(n=>n.startsWith('native private transport keeps shared port')).length,4);
assert.equal(passed.filter(n=>n.startsWith('public send reuses one approval')).length,4);
assert.equal(passed.filter(n=>n.startsWith('public send disabled without native sender')).length,4);
const protection=JSON.parse(execFileSync(process.execPath,['tool/check_protected.mjs'],opts));
const sourceHashes={};for(const p of sources)sourceHashes[p]=sha(await read(p));
const report={status:'F3_PUBLIC_SEND_ROUTING_PASS',recordedAt:new Date().toISOString(),parents,
 sourceHashes,analysis,tests:passed.length,testFiles:tests,passed,protection,
 proof:{sharedSendMethods:4,oneApproval:true,parallelPrefetchRetained:true,workerParsing:true,
  nativeTransferMaterialReads:2,normalSendExtraStatusReads:0,ambiguousSingleMaxStatusReads:1,
  automaticPostRetry:false,signOnlyBroadcastAllocation:false,signOnlyJournal:false,
  sourceVectors:['official-mainnet','official-testnet','trusted-custom-api-and-rpc'],
  implementedPublicMethods:21,installedPublicMethods:17,requiredMethods:22},
 implemented:[
  'Native-only source configuration and lazy account/source/profile-partitioned storage; exact private open/guard/journal/wire commands, one-use native admission and actual dispatch receipt/account/grant/session fences.',
  'Swift/Kotlin source identity matches frozen Kit/Dart vectors. Opposite official network and malformed/custom-without-trust origins reject. Native endpoint/store/account selection is never deserialized from a page.',
  'Shared Dart BroadcastJournal/BroadcastWireTransport adapters reuse the existing port and REST codec. Only public response bytes cross as bounded base64. A queued/expired wire deadline cannot start a POST.',
  'Four sends now cross the same private non-UI worker and native binding. Package-owned native backend uses command transport so raw preflight, port and REST work stay in the worker. Other explicitly supplied broadcast backends retain the typed operation callbacks.',
  'Single, Prepared, workflow and Prepared-workflow preserve exact frozen transactions/tasks/fees, one approval and two native-transfer material reads in the worker samples. Send grant is distinct; missing support, revoked grant, navigation and late result fail without retry.',
  'Uncertain single submission retains the original identity and performs one bounded read-only reconciliation. Opaque errors stay redacted; only two fixed wire failure codes cross the private worker. No native admission ticket is exposed.',
  'Every shared send success/partial/unknown result requires finishBroadcast on the same operation before returning. Native validates exact signed metadata and owned journal outcomes, then hashes only the final result for emission. Failure does not trigger another approval, POST or GET.',
  'Four optional public sends route through the same Provider, policy, worker and lifecycle. Discovery and send-grant requests require a native-configured sender installed before document navigation; default/sign-only hosts stay send-disabled. Workflow sign permissions do not imply broadcast. Duplicate page requests do not repeat POST, and sends participate in sensitive-request revocation.',
 ],
 limits:[
  'Dart channel/worker tests use replay custody and test-only HTTP/journal doubles. Native report uses actual SQLite/HTTP on macOS Foundation and AndroidAPI36 app_process, not installed Flutter send or private Testnet.',
  'Framework compilation targets iOS15 simulator and Android36. This is not minimum-OS, physical-device or production partner Vault acceptance; existing delegate warnings are preserved in that report.',
  'Native send-result completion/emission and all-stage single sends are covered in separate native socket checks. Four public Provider routes are implemented and tested with the frozen Engine plus replay custody; installed end-to-end sending remains pending. Source count21 is not installed acceptance; installed public-method evidence remains17 of22.',
  'No new matched speed or Release-size claim. Bound raw/channel copies and native storage costs still need same-device measurement. Accepted delivery and frozen Rust remain unchanged.',
 ],
 remaining:['Install targeted paired consumers for the four public sends using actual platform channel/custody/store/HTTP and frozen Rust.',
  'Finish thin Legacy and network/status integration; authorized private Testnet, matched segmented timings, Release increment, clean paired local artifacts and concise partner docs.'],
 http:0,broadcasts:0,acceptedDeliveryChanged:false,frozenRustModified:false,published:false,goalComplete:false};
const bytes=JSON.stringify(report,null,2)+'\n';await writeFile(resolve(base,output),bytes,{flag:'wx'});
console.log(JSON.stringify({status:report.status,tests:passed.length,protectedFiles:protection.protectedFiles,
 output,sha256:sha(bytes),parents}));
