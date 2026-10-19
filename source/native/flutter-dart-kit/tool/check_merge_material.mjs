import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
const [dart,output]=process.argv.slice(2); assert(dart&&output);
const base=resolve(import.meta.dirname,'..'),run=promisify(execFile),sha=b=>createHash('sha256').update(b).digest('hex');
const tests=['test/merge_material_test.dart','test/multi_round_merge_test.dart',
 'test/native_signing_test.dart','test/fungible_signing_test.dart','test/stablecoin_signing_test.dart',
 'test/unified_pool_material_test.dart','test/pool2_material_test.dart'];
const opts={cwd:base,timeout:120000,maxBuffer:8e6};
const [analysis,checked,protectedCheck]=await Promise.all([
 run(dart,['analyze','lib',...tests],opts),run(dart,['test',...tests,'--reporter=json'],opts),
 run(process.execPath,['tool/check_protected.mjs'],opts),
]);
const events=checked.stdout.trim().split('\n').map(v=>JSON.parse(v));
assert.equal(events.findLast(v=>v.type==='done').success,true);
const finished=events.filter(v=>v.type==='testDone'&&!v.hidden&&!v.skipped);
assert(finished.every(v=>v.result==='success'));
const suites=new Map(events.filter(v=>v.type==='suite').map(v=>[v.suite.id,v.suite.path]));
const testInfo=new Map(events.filter(v=>v.type==='testStart').map(v=>[v.test.id,v.test]));
const names=finished.map(v=>({name:testInfo.get(v.testID).name,suite:suites.get(testInfo.get(v.testID).suiteID)}));
const sources={};
for(const p of ['lib/src/internal/merge_material.dart','lib/src/internal/multi_round_merge.dart',
 'lib/src/internal/signing_executor.dart','lib/src/internal/pool2_material.dart',
 'lib/src/internal/asset_metadata.dart','lib/src/internal/native_material.dart',
 'lib/src/internal/tbc20_material.dart','lib/src/internal/stablecoin_material.dart',
 'lib/src/internal/unified_pool_material.dart','lib/src/internal/lp_material.dart',
 'lib/src/internal/protocol_codec.dart','lib/src/internal/transaction_read.dart',
 'lib/src/internal/transaction_policy.dart','lib/src/internal/utxo_pages.dart',
 ...tests,'tool/check_merge_material.mjs','test/fixtures/native-signing.json','test/fixtures/native-transfers.json',
 'test/fixtures/fungible-signing.json','test/fixtures/stablecoin-signing.json','test/fixtures/unified-pool-signing.json',
 'test/fixtures/multi-round-frozen-kit.json','evidence/f3-multi-round-integration-plan.json']) {
 sources[p]=sha(await readFile(join(base,p)));
}
const currentEngine={path:'/private/tmp/tbc-contract173-compute-20261014-a/target/aarch64-apple-darwin/release/libtbc_compute_native.dylib',
 sha256:'413559859a0fa0fed61220485ea482ca8c28f305b4145f600ff706ca3a8bd0db'};
assert.equal(sha(await readFile(currentEngine.path)),currentEngine.sha256);
const report={status:'SHARED_MERGE_MATERIAL_ENGINE_PARITY_PASS_NATIVE_CONSENT_PENDING',recordedAt:new Date().toISOString(),
 tests,passed:finished.length,checks:names,analysis:analysis.stdout.trim(),sources,currentEngine,
 protectedFiles:JSON.parse(protectedCheck.stdout),
 implemented:'Shared per-run index/material adapter for all5 maintenance assets where the actual profile supports merge. Generic FT/Coin/AMM/LP intent, immutable metadata/history reuse, bounded ascending selection, request identity tied to approval/scope/step, per-round mutable cache discard and pre-sign actual Engine input check. Ordinary readers and selection defaults unchanged. Tip/funding futures can overlap the one bounded-consent UI and are reused once.',
 evidence:'11 current/historical maintenance cases use current1.7.3Native Engine and replay prior public WASM signatures; signed bytes,fees and GET multiset exactly match frozen fixtures. Current LP adds no poolinfo read. Two sequential native rounds use actual unsigned Engine plan/validation and synthetic acceptance/index publication, one approval callback,3fresh index+2tip GETs. Paging,cancellation,revocation,one-use round and rejected plan before custody binding/signing tested.',
 corrections:['Existing native maintenance already caps100 even though general reader default is128; no global cap change was needed.',
 'Historical FT as well as Pool2 rejects explicit inputOutpoints. Reuse wallet-owned selected index rows and verify actual snapshot/template consumption; do not insert unsupported parameters.',
 'Current AMM has no pool-held FT merge operation in this profile; reject before consent/signing rather than inventing support. Current LP identity uses authenticated genesis,not an unnecessary live-reserve query.',
 'First two-round test called normalizeRequest with a Provider-shaped method/context object. Corrected test to actual Engine version/request ABI; production code was not changed to accommodate it.'],
 notProved:'No native bounded-consent owner,production worker/Provider registration,installed device,real broadcasts or matched timing/Release-size proof for multi-round. Single-step replay signatures are not native key-use approval proof. Historical fixtures do not establish new LP6 economics; contract173 has separate exact evidence. Source changes do not update prior installed Apps.',
 performance:'Same GET counts in11representative cases and concurrent tip/funding future reuse; actual wall-clock and native UI timings still pending. No Rust algorithm,SQLite,HTTP stack,normal-transaction query or broad selection change.',
 externalHttp:0,broadcasts:0,signatureSource:'public frozen replay only',published:false,goalComplete:false};
await writeFile(resolve(base,output),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({status:report.status,passed:report.passed,sourceHashes:Object.keys(sources).length,protectedFiles:report.protectedFiles}));
