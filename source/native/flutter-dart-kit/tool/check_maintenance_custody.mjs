// Focused native custody/private host replay. Never reads a key or sends HTTP.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,readdir,mkdtemp,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {homedir} from 'node:os';
import {createHash} from 'node:crypto';
const run=promisify(execFile),base=resolve(import.meta.dirname,'..'),output=process.argv[2],dart=process.argv[3];
const java=process.env.JAVA_HOME,android=process.env.ANDROID_HOME;assert(java&&android&&output&&dart);
const cache=join(homedir(),'.gradle/caches/modules-2/files-2.1');
async function jar(group,name,version){const root=join(cache,group,name,version),hits=[];for(const d of await readdir(root))for(const f of await readdir(join(root,d)))if(f===`${name}-${version}.jar`)hits.push(join(root,d,f));assert.equal(hits.length,1);return hits[0];}
const compiler=await Promise.all([
 ['org.jetbrains.kotlin','kotlin-compiler-embeddable','2.1.20'],['org.jetbrains.kotlin','kotlin-stdlib','2.1.20'],['org.jetbrains.kotlin','kotlin-script-runtime','2.1.20'],['org.jetbrains.kotlin','kotlin-daemon-embeddable','2.1.20'],['org.jetbrains.kotlin','kotlin-reflect','1.6.10'],['org.jetbrains.intellij.deps','trove4j','1.0.20200330'],['org.jetbrains','annotations','13.0'],['org.jetbrains.kotlinx','kotlinx-coroutines-core-jvm','1.8.1'],
].map(a=>jar(...a)));
const json=await jar('org.json','json','20240303'),androidJar=join(android,'platforms/android-36/android.jar');
const scratch=await mkdtemp('/private/tmp/tbc-dart-maintenance-custody-'),options={cwd:base,maxBuffer:2e6,timeout:120000};
const names=['NativePermissions','NativeCustody','NativePrepared','NativeReviewed','NativeWorkflow','NativeWalletHost','NativeCrypto','NativeNetworkSessions','NativeNetworkWalletRouter','NativeProtocolWalletRouter'];
const kt=names.map(n=>`platform/android/src/main/kotlin/io/tbc/kit/dart/${n}.kt`),sw=names.map(n=>`platform/ios/Classes/${n}.swift`);
const sources={},sha=b=>createHash('sha256').update(b).digest('hex'),cases=[];
for(const [file,indices] of [['native-signing',[3,4]],['fungible-signing',[2,3,6]],['stablecoin-signing',[3,8]],['unified-pool-signing',[4,5,16,19]]]){
 const path=`test/fixtures/${file}.json`,bytes=await readFile(join(base,path));sources[path]=sha(bytes);const rows=JSON.parse(bytes).cases;
 for(const index of indices){
  const c=rows[index],intent=c.request.intent,kind=({'tbc.maintenance.merge':'tbc','tbc20.merge':'ft','tbc20Stablecoin.merge':'stablecoin','amm.mergeToken':'pool-ft','tbc20Lp.merge':'ftlp'})[intent.type];assert(kind);
  const p=c.audit.material.snapshot.payload,pool=['pool-ft','ftlp'].includes(kind),asset={kind,...kind==='tbc'?{}:pool?{poolContractId:intent.poolContractId}:{contractId:intent.contractId}};
  const selectedInputs=p.utxos.filter(u=>u.classification===(kind==='tbc'?'native':kind)).map(u=>`${u.txid}:${u.vout}`);assert(selectedInputs.length>=2,c.name);
  const current=p.contracts.find(v=>v.family==='pool'),ft=p.contracts.find(v=>v.family==='ft');
  const poolIdentity=pool?{poolContractId:intent.poolContractId,ftContractId:ft?.contractId??intent.poolContractId,currentPoolTxid:current?.currentOutpoint.txid??intent.poolContractId}:null;
  const owner=kind==='pool-ft'?'pool-contract':'active-account';
  const consent={version:'1.0',operationKind:'multi-round-merge',authority:{chainId:c.account.chainId,accountId:c.account.accountId,origin:c.context.origin,sessionId:c.context.sessionId},asset,
   impact:{custody:owner,resultOwner:owner,maxAssetInputsPerTransaction:kind==='tbc'?100:kind==='pool-ft'?4:5,...poolIdentity?{poolIdentity}:{}},
   limits:{targetUtxoCount:1,maxTransactions:3,maxTotalFee:'100000',expiresAt:'2026-10-14T00:00:00Z',maxIndexRefreshes:6,indexRefreshDelayMs:1000},initialStateHash:'b'.repeat(64),initialUtxoCount:selectedInputs.length+1};
  cases.push({...c,consent,selectedInputs});
 }
}
const fixture=join(scratch,'maintenance.json');await writeFile(fixture,JSON.stringify({cases}),{flag:'wx'});
try{
 const compiled=await Promise.allSettled([
  run(join(java,'bin/java'),['-cp',compiler.join(':'),'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler','-no-stdlib','-no-reflect','-jvm-target','17','-classpath',[compiler[1],compiler[6],json,androidJar].join(':'),'-d',join(scratch,'classes'),...kt,'test/native/MaintenanceCheck.kt','test/native/CustodyCheck.kt'],options),
  run('xcrun',['swiftc','-swift-version','6','-parse-as-library',...sw,'test/native/MaintenanceCheck.swift','-o',join(scratch,'maintenance')],options),
  run('xcrun',['swiftc','-swift-version','6','-parse-as-library',...sw,'test/native/CustodyCheck.swift','-o',join(scratch,'custody')],options),
 ]);for(const r of compiled)if(r.status==='rejected')throw r.reason;
 const jvm=[join(scratch,'classes'),compiler[1],json,androidJar].join(':');
 const results=await Promise.all([
  run(join(java,'bin/java'),['-cp',jvm,'io.tbc.kit.dart.MaintenanceCheckKt',fixture],options),run(join(scratch,'maintenance'),[fixture],options),
  ...[['test/fixtures/signing/replay.json'],['test/fixtures/native-signing.json','native'],['../contract173-upgrade/high-level173.json','contract173']].flatMap(args=>[
   run(join(java,'bin/java'),['-cp',jvm,'io.tbc.kit.dart.CustodyCheckKt',...args],options),run(join(scratch,'custody'),args,options)]),
 ]);
 const parsed=results.map(r=>JSON.parse(r.stdout));assert.equal(parsed[0].status,'NATIVE_MAINTENANCE_PASS');assert.deepEqual(parsed[0],parsed[1]);for(const r of parsed.slice(2))assert.equal(r.status,'PASS');
 for(const p of [...kt,...sw,'test/native/MaintenanceCheck.kt','test/native/MaintenanceCheck.swift','test/native/CustodyCheck.kt','test/native/CustodyCheck.swift','tool/check_maintenance_custody.mjs'])sources[p]=sha(await readFile(join(base,p)));
 const tests=['test/native_wallet_binding_test.dart','test/native_network_binding_test.dart','test/native_protocol_binding_test.dart','test/native_broadcast_binding_test.dart','test/merge_material_test.dart','test/multi_round_merge_test.dart'];
 const [analyzed,checked,protectedCheck]=await Promise.all([
  run(dart,['analyze','lib',...tests],options),run(dart,['test',...tests,'--reporter=json'],{...options,maxBuffer:8e6}),run(process.execPath,['tool/check_protected.mjs'],options),
 ]);
 const events=checked.stdout.trim().split('\n').map(v=>JSON.parse(v));assert.equal(events.findLast(v=>v.type==='done').success,true);
 const done=events.filter(v=>v.type==='testDone'&&!v.hidden&&!v.skipped);assert(done.every(v=>v.result==='success'));
 const dartChecks={tests,passed:done.length,analysis:analyzed.stdout.trim()};
 for(const p of ['lib/src/internal/native_wallet_binding.dart','lib/src/internal/merge_material.dart','lib/src/internal/multi_round_merge.dart','lib/src/internal/signing_executor.dart',...tests])sources[p]=sha(await readFile(join(base,p)));
 const protectedFiles=JSON.parse(protectedCheck.stdout);
 const report={status:'NATIVE_MAINTENANCE_RESULT_ATTESTATION_PASS_ENTRY_DEVICE_PENDING',recordedAt:new Date().toISOString(),kotlin:parsed[0],swift:parsed[1],affectedCustodyRegression:parsed.slice(2),dartChecks,sources,protectedFiles,scratch,
  fixture:{path:fixture,sha256:sha(await readFile(fixture)),cases:cases.map(c=>c.name)},
  proof:'Paired native custody and private Host dispatch. One bounded native approval; ordinary child binding/task/signature replay and native journal-result advancement. Aggregate complete/partial/pre-submit failure/uncertainty attestation, exact txid/fee/dependency/order/scope/approval fields, conservative unknown exposure, native-owned recovery identity, separate result hash delivery permit with account/grant fences. Zero/one index-count no-op returns without consent/signature; exact native Host envelope, duplicate/tampered result, revoked emission and parent child-permit cleanup tested. All5 asset kinds/current and historical exact plans. No additional network or durable result write.',
  notProved:'No installed mobile runtime,actual multi-round chain execution,native key creation or final performance/size proof. Worker/Legacy source-entry proof is separate; public Standard maintenance extension remains pending. Signatures replay public fixtures; native journal outcomes are synthetic and no-op index count is informational,not independent ledger proof. Native current-fee assets and LP6only330/200 are covered separately by contract173 evidence.',externalHttp:0,broadcasts:0,published:false,goalComplete:false};
 await writeFile(resolve(base,output),JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({status:report.status,kotlin:parsed[0],swift:parsed[1],affectedCustodyRegression:parsed.slice(2),dartChecks,protectedFiles,scratch}));
}catch(e){console.error(JSON.stringify({status:'FAIL',message:e.message?.slice(-1500),stderr:e.stderr?.slice(-5500),stdout:e.stdout?.slice(-800),scratch}));process.exitCode=1;}
