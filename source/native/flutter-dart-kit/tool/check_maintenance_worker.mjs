// Focused source/worker proof. No network, device installation or broadcasts.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,writeFile,readdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
const [dart,output,pageDirectory]=process.argv.slice(2);assert(dart&&output&&pageDirectory);
const base=resolve(import.meta.dirname,'..'),run=promisify(execFile);
const sha=b=>createHash('sha256').update(b).digest('hex');
const tests=['test/maintenance_worker_test.dart','test/maintenance_entry_test.dart','test/legacy_provider_session_test.dart','test/configuration_test.dart','test/signing_worker_test.dart',
 'test/send_worker_test.dart','test/native_wallet_binding_test.dart',
 'test/native_network_binding_test.dart','test/native_protocol_binding_test.dart',
 'test/native_broadcast_binding_test.dart','test/merge_material_test.dart',
 'test/multi_round_merge_test.dart','test/balance_read_test.dart'];
const options={cwd:base,timeout:120000,maxBuffer:12e6};
const [analysis,checked,protectedCheck,pageCheck]=await Promise.all([
 run(dart,['analyze','lib',...tests],options),
 run(dart,['test',...tests,'--reporter=json'],options),
 run(process.execPath,['tool/check_protected.mjs'],options),
 run(process.execPath,['--test','test/legacy-page.test.mjs'],{...options,env:{...process.env,TBC_DART_PAGE_DIR:resolve(pageDirectory)}}),
]);
assert.match(pageCheck.stdout,/# tests 11\n/);assert.match(pageCheck.stdout,/# fail 0\n/);
const pageManifest=JSON.parse(await readFile(join(pageDirectory,'page-provenance.json'),'utf8'));
assert.equal(sha(await readFile(join(pageDirectory,'tbc-webview-page.js'))),pageManifest.sha256);
const events=checked.stdout.trim().split('\n').map(v=>JSON.parse(v));
assert.equal(events.findLast(v=>v.type==='done').success,true);
const done=events.filter(v=>v.type==='testDone'&&!v.hidden&&!v.skipped);
assert(done.every(v=>v.result==='success'));
const suites=new Map(events.filter(v=>v.type==='suite').map(v=>[v.suite.id,v.suite.path]));
const info=new Map(events.filter(v=>v.type==='testStart').map(v=>[v.test.id,v.test]));
const checks=done.map(v=>({name:info.get(v.testID).name,suite:suites.get(info.get(v.testID).suiteID)}));
const sources={};
async function tree(path){for(const d of await readdir(join(base,path),{withFileTypes:true})){
 const p=`${path}/${d.name}`;if(d.isDirectory())await tree(p);
 else if(d.name.endsWith('.dart'))sources[p]=sha(await readFile(join(base,p)));
}}
await tree('lib');
for(const p of [...tests,'test/native_signing_test.dart','test/support/signing_replay.dart',
 'test/broadcast_port_test.dart','tool/check_maintenance_worker.mjs',
 'runtime/legacy-page.mjs','test/legacy-page.test.mjs',
 'test/fixtures/native-signing.json','test/fixtures/native-transfers.json',
 'test/fixtures/fungible-signing.json','test/fixtures/stablecoin-signing.json',
 'test/fixtures/unified-pool-signing.json']) sources[p]=sha(await readFile(join(base,p)));
// Earlier native evidence is applicable only to its unchanged native sources.
const nativeEvidence='evidence/f3-maintenance-native-20261014-g.json';
const prior=JSON.parse(await readFile(join(base,nativeEvidence),'utf8'));
const nativeSources=Object.entries(prior.sources).filter(([p])=>/\.(swift|kt)$/.test(p));
for(const [p,h]of nativeSources)assert.equal(sha(await readFile(join(base,p))),h,p);
const report={status:'SHARED_MAINTENANCE_STANDARD_AND_LEGACY_ENTRY_PASS_DEVICE_PENDING',
 recordedAt:new Date().toISOString(),tests,passed:done.length,checks,
 analysis:analysis.stdout.trim(),sources,protectedFiles:JSON.parse(protectedCheck.stdout),
 page:{directory:resolve(pageDirectory),sha256:pageManifest.sha256,bytes:pageManifest.bytes,checks:11,installed:false},
 unchangedNativeEvidence:{report:nativeEvidence,sourceFiles:nativeSources.length},
 proof:'Actual persistent isolate joins shared coordinator,material session,ordinary executor and native-owned child transport.11current/historical cases across5asset kinds preserve frozen signed bytes/fees/build-read multiset. Two fully signed Engine rounds use the public scalar-one fixture only,one consent,100+2inputs,accepted-parent dependency,remaining budget and3index+2tip reads. Private native-command port tests cover accepted,reconciled-known and unresolved POST; unresolved result retains exact native journal idempotencyKey and never resubmits.',
 boundaries:'Required tip/funding reads overlap bounded consent; mutable indexes refresh after native finish,immutable history reused. Rejection,pre-submit signing failure,native finish refusal,index lag and late owner/child cancellation close safely. Self-generated timestamps normalize to milliseconds. No normal transaction material,Engine/contract algorithm,HTTP endpoint or SQLite schema was changed.',
 proofLimit:'Current native aggregate custody is covered by the cited paired source replay; source hashes must match. Worker tests use native-shaped callbacks and synthetic journal/index transport,not installed devices or a partner Vault. Three Legacy aliases and the existing tbc_runMultiRoundMerge extension map into the same worker. Standard keeps frozen atomic:false/progress wrapper; native approves the core before projection,validates bounded progress and rechecks authority at emission. Wallet policy caps page-supplied limits,never autoapproves.22standard methods unchanged. Paired devices,private Testnet acceptance,matched timing/Release size,clean template and sealed full-scope delivery remain.',
 externalHttp:0,realBroadcasts:0,published:false,goalComplete:false};
await writeFile(resolve(base,output),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({status:report.status,passed:report.passed,
 sourceHashes:Object.keys(sources).length,unchangedNativeSources:nativeSources.length,
 protectedFiles:report.protectedFiles}));
