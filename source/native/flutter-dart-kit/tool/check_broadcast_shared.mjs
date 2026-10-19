// Narrow source checkpoint only; no live HTTP, native store or Provider send.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,join} from 'node:path';
const base=resolve(import.meta.dirname,'..'),[dart,output]=process.argv.slice(2);
assert(dart&&output);
const sha=b=>createHash('sha256').update(b).digest('hex'),read=p=>readFile(join(base,p));
const sources=['lib/src/internal/broadcast_port.dart','lib/src/internal/broadcast_client.dart',
 'test/broadcast_port_test.dart','test/broadcast_client_test.dart',
 'tool/broadcast_port_oracle.mjs','tool/broadcast_client_oracle.mjs','tool/check_broadcast_shared.mjs'];
const sourceHashes={};for(const path of sources)sourceHashes[path]=sha(await read(path));
const references=[];
for(const [path,expected,count] of [
 ['test/fixtures/broadcast-port.json','2486ddf4794c64c250749ca0030c14b6fce896ad1646aa8ca0a95a8137ddbe8d',29],
 ['test/fixtures/broadcast-client.json','77a837d28f587f3d6f476cc1a4b48c2e1704424913de56b589d63eab1fff6f07',43],
]){
 const bytes=await read(path),oracle=JSON.parse(bytes);assert.equal(sha(bytes),expected);
 assert.equal(oracle.archiveSha256,'c51e3b63dd1ed2f542d40068450685e314328686d4a3ebab2717491333a478a0');
 assert.equal(oracle.cases.length,count);assert.equal(oracle.broadcasts,0);
 references.push({path,sha256:expected,cases:count});
}
const analysis=execFileSync(dart,['analyze','--fatal-infos',...sources.filter(p=>p.endsWith('.dart'))],{cwd:base,encoding:'utf8',maxBuffer:1024*1024});
const files=['test/broadcast_port_test.dart','test/broadcast_client_test.dart'];
const events=execFileSync(dart,['test',...files,'--reporter=json'],{cwd:base,encoding:'utf8',maxBuffer:4*1024*1024}).trim().split('\n').map(JSON.parse);
assert.equal(events.findLast(e=>e.type==='done')?.success,true);
const names=new Map(events.filter(e=>e.type==='testStart').map(e=>[e.test.id,e.test.name]));
const passed=events.filter(e=>e.type==='testDone'&&!e.hidden&&!e.skipped&&e.result==='success').map(e=>names.get(e.testID));
assert.equal(passed.length,87);assert.equal(passed.filter(n=>n.startsWith('frozen REST client ')).length,43);
const protection=JSON.parse(execFileSync(process.execPath,['tool/check_protected.mjs'],{cwd:base,encoding:'utf8'}));
const parentPath='evidence/f3-bie1-device-design.json',parent=await read(parentPath),routingUnchanged={};
for(const path of ['lib/src/internal/provider_session.dart','lib/src/internal/signing_worker.dart','lib/src/internal/signing_executor.dart',
 'lib/src/internal/workflow_executor.dart','lib/src/internal/native_wallet_binding.dart','lib/src/flutter/wallet_host.dart',
 'lib/src/signing_backend.dart','lib/src/internal/read_api.dart','platform/ios/Classes/NativeCustody.swift',
 'platform/android/src/main/kotlin/io/tbc/kit/dart/NativeCustody.kt'])routingUnchanged[path]=sha(await read(path));
const report={status:'F3_BROADCAST_SHARED_PORT_REST_PARITY_PASS',recordedAt:new Date().toISOString(),
 parent:{path:parentPath,sha256:sha(parent)},references,sourceHashes,analysis:analysis.trim(),testFiles:files,passed,tests:passed.length,
 protection,routingUnchanged,
 proof:{portOracleCases:29,restOracleCases:43,focusedExtraCases:15,exactStateAndResponseParity:true,
  batchUsesOnePost:true,unknownSubmissionNeverResent:true,duplicateInFlightSubmitOnce:true,
  recoveryStatusGetOnly:true,networkSourceAndAccountPartition:true,restLargeIntegerLossless:true,
  preflightAddsChainReads:0,publicExecutableMethods:17,requiredMethods:22},
 semantics:[
  'Required explicit BroadcastJournal and native-authorized transport adapters; no default memory/HTTP journal or arbitrary page raw-send method.',
  'Frozen single/batch identity, replay, uncertainty, local preflight abort and read-only reconciliation behavior preserved. Journal doubles are TEST-only.',
  'All REST requests bind the configured network source. Single POST validates local TBC10 txid; batch sends once and validates each ordered response instead of inferring success from aggregate counts.',
  'Missing/invalid confirmation count fails closed; 404 is unknown, zero is mempool and positive is confirmed. No extra node-info/read or implicit poll. Native transport must enforce no retry/redirect, deadline and streaming bound.',
  'The REST source interface models one request. Unlike frozen transport optional read retry, this candidate has no automatic retries, matching its existing Dart read policy. This does not weaken broadcast uncertainty handling.',
 ],
 failedAttempts:[
  'Port test harness initially called Map.values as a function and used expect outside a test; corrected without weakening production behavior.',
  'REST oracle initially imported createTbcChainClient from wallet.node.js; corrected to the actual frozen api.js export before generating the immutable fixture.',
  'One REST source-mismatch test expected Exception while shared need() throws StateError; the implementation already rejected correctly. Corrected the test type; all43 independent result/trace cases passed on that first run.',
 ],
 remaining:[
  'Native system-SQLite journal and operation-bound dispatch fence, then receipt/binding/Engine pre-broadcast integration on the existing shared single/workflow lifecycle. Sends remain disabled until this is established.',
  'At native integration, prove cancellation/storage failure before network dispatch can be audited not-submitted; actual post-dispatch ambiguity remains uncertainty. Current frozen-compatible prepared behavior is not a completed recovery UX.',
  'Wallet network switching and thin Legacy mapping, private Testnet acceptance, matched speed/Release App increment and paired clean local handoff remain in the unchanged final goal.',
 ],
 limits:[
  'No actual native durable store/process crash/transport dispatch, Provider send, device or chain acceptance in this checkpoint.',
  'No new performance claim. Existing signing/approval/prefetch/native routes and accepted delivery are unchanged;17 of22 device methods remain the previous proof.',
  'No final delivery, production Vault, physical-device or minimum-OS proof.',
 ],
 liveHttp:0,broadcasts:0,acceptedDeliveryChanged:false,frozenRustModified:false,published:false,goalComplete:false};
const bytes=JSON.stringify(report,null,2)+'\n';await writeFile(resolve(base,output),bytes,{flag:'wx'});
console.log(JSON.stringify({status:report.status,tests:report.tests,protectedFiles:protection.protectedFiles,sha256:sha(bytes),output}));
