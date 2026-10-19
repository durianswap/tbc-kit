// Package control/worker conformance; not a Flutter channel or device claim.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
const run=promisify(execFile),base=resolve(import.meta.dirname,'..');
const [dart,output]=process.argv.slice(2);assert(dart&&output,'Dart binary and new report path required');
const tests=['test/provider_network_test.dart','test/provider_session_test.dart','test/wire_session_test.dart','test/native_wallet_binding_test.dart','test/native_network_binding_test.dart'];
const sources=[...tests,'test/support/signing_replay.dart','lib/src/internal/provider_control.dart','lib/src/internal/provider_session.dart','lib/src/internal/wire_session.dart','lib/src/internal/native_wallet_binding.dart','lib/src/internal/signing_worker.dart','lib/src/configuration.dart','lib/src/flutter/wallet_host.dart','lib/flutter_wallet.dart','../../standards/TWS-001-provider.md','tool/check_provider_network.mjs'];
const sha=b=>createHash('sha256').update(b).digest('hex');
const buildPath=process.env.TBC173_BUILD_REPORT??'/private/tmp/tbc-contract173-compute-20261014-a/build-report.json';
const build=JSON.parse(await readFile(buildPath));
const library=build.builds.find(v=>v.target==='aarch64-apple-darwin');assert(library);assert.equal(sha(await readFile(library.path)),library.sha256);
const options={cwd:base,maxBuffer:4e6,timeout:120000};
const checked=await run(dart,['analyze',...sources.filter(p=>p.endsWith('.dart'))],options);
const result=await run(dart,['test',...tests,'--reporter=json'],options);
const events=result.stdout.trim().split('\n').map(v=>JSON.parse(v));
assert.equal(events.filter(e=>e.type==='done').at(-1)?.success,true);
const completed=events.filter(e=>e.type==='testDone'&&!e.hidden&&!e.skipped);
assert(completed.length>=75);assert(completed.every(e=>e.result==='success'));
const hashes={};for(const p of sources)hashes[p]=sha(await readFile(join(base,p)));
const report={status:'DART_PROVIDER_NETWORK_CONTROL_PASS',recordedAt:new Date().toISOString(),tests,passed:completed.length,
 analysis:checked.stdout.trim(),sources:hashes,
 currentCompute:{buildReport:buildPath,buildReportSha256:sha(await readFile(buildPath)),path:library.path,sha256:library.sha256},
 proof:'Real immutable-network Dart workers and pinned current Rust compute with native-shaped, keyless test control, plus production Dart network binding over a MethodChannel envelope double. Source routing, target grants/capabilities, fixed errors, cancellation, immutable per-operation network stamps and late callback rejection verified. Native routing/emission and actual Flutter SDK registration compile are checked separately. No installed multi-network channel or device proof. Existing single-network binding/Provider/wire regressions retained.',
 execution:'Dart VM tests. flutter test could not bootstrap this macOS dynamic compute library; direct Dart VM verified its pinned hash and executed it. This is not iOS/Android installation proof.',
 newSignatures:0,liveHttp:0,broadcasts:0,deviceAcceptance:false,acceptedDeliveryChanged:false,published:false};
await writeFile(resolve(base,output),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({status:report.status,passed:report.passed,currentComputeSha256:library.sha256,liveHttp:0,broadcasts:0,deviceAcceptance:false}));
