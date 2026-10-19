// Targeted native integration: actual custody + host + network router, no keys,
// node requests or mobile installation. Also run existing message/TBC guards.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,readdir,mkdtemp,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {homedir} from 'node:os';
import {createHash} from 'node:crypto';
const run=promisify(execFile),base=resolve(import.meta.dirname,'..'),output=process.argv[2];
const java=process.env.JAVA_HOME,android=process.env.ANDROID_HOME;assert(java&&android&&output);
const cache=join(homedir(),'.gradle/caches/modules-2/files-2.1');
async function jar(group,name,version){const root=join(cache,group,name,version),hits=[];for(const d of await readdir(root))for(const f of await readdir(join(root,d)))if(f===`${name}-${version}.jar`)hits.push(join(root,d,f));assert.equal(hits.length,1);return hits[0];}
const compiler=await Promise.all([
 ['org.jetbrains.kotlin','kotlin-compiler-embeddable','2.1.20'],['org.jetbrains.kotlin','kotlin-stdlib','2.1.20'],['org.jetbrains.kotlin','kotlin-script-runtime','2.1.20'],['org.jetbrains.kotlin','kotlin-daemon-embeddable','2.1.20'],['org.jetbrains.kotlin','kotlin-reflect','1.6.10'],['org.jetbrains.intellij.deps','trove4j','1.0.20200330'],['org.jetbrains','annotations','13.0'],['org.jetbrains.kotlinx','kotlinx-coroutines-core-jvm','1.8.1'],
].map(a=>jar(...a)));
const json=await jar('org.json','json','20240303'),androidJar=join(android,'platforms/android-36/android.jar');
const scratch=await mkdtemp('/private/tmp/tbc-dart-network-router-'),options={cwd:base,maxBuffer:2e6,timeout:120000};
const names=['NativePermissions','NativeCustody','NativePrepared','NativeReviewed','NativeWorkflow','NativeWalletHost','NativeCrypto','NativeNetworkSessions','NativeNetworkWalletRouter','NativeProtocolWalletRouter'];
const kt=names.map(n=>`platform/android/src/main/kotlin/io/tbc/kit/dart/${n}.kt`),sw=names.map(n=>`platform/ios/Classes/${n}.swift`);
// The frozen Prepared corpus includes one superseded preset-based AMM create.
// Preserve that evidence; current1.7.3 explicitly requires four-rate feePolicy.
// Replay the other21 unchanged samples and separately replay all40 current AMM
// cases rather than weakening current approval validation to pass an old input.
const originalPrepared=JSON.parse(await readFile(join(base,'test/fixtures/prepared-signing.json')));
const obsolete=originalPrepared.cases.filter(c=>c.request.intent.type==='tbc-amm-create');
assert.equal(obsolete.length,1);assert.equal(obsolete[0].name,'amm-create-public');assert.equal(obsolete[0].request.intent.feePolicy,undefined);
const prepared={...originalPrepared,cases:originalPrepared.cases.filter(c=>c!==obsolete[0])};
assert.equal(prepared.cases.length,21);
const preparedPath=join(scratch,'prepared-current-scope.json');
await writeFile(preparedPath,JSON.stringify(prepared),{flag:'wx'});
try{
 const compiled=await Promise.allSettled([
  run(join(java,'bin/java'),['-cp',compiler.join(':'),'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler','-no-stdlib','-no-reflect','-jvm-target','17','-classpath',[compiler[1],compiler[6],json,androidJar].join(':'),'-d',join(scratch,'classes'),...kt,'test/native/NetworkRouterCheck.kt','test/native/CustodyCheck.kt','test/native/PermissionCheck.kt','test/native/ProtocolIsolationCheck.kt'],options),
  run('xcrun',['swiftc','-swift-version','6','-parse-as-library',...sw,'test/native/ProtocolIsolationCheck.swift','-o',join(scratch,'protocol')],options),
  run('xcrun',['swiftc','-swift-version','6','-parse-as-library',...sw,'test/native/NetworkRouterCheck.swift','-o',join(scratch,'network')],options),
  run('xcrun',['swiftc','-swift-version','6','-parse-as-library',...sw,'test/native/CustodyCheck.swift','-o',join(scratch,'custody')],options),
  run('xcrun',['swiftc','-swift-version','6','-parse-as-library',sw[0],'test/native/PermissionCheck.swift','-o',join(scratch,'permission')],options),
  run('xcrun',['swiftc','-swift-version','6','-parse-as-library',sw[0],'test/native/PermissionGroupSqliteCheck.swift','-o',join(scratch,'permission-group')],options),
 ]);for(const r of compiled)if(r.status==='rejected')throw r.reason;
 const jvm=[join(scratch,'classes'),compiler[1],json,androidJar].join(':');
 const results=await Promise.all([
  run(join(java,'bin/java'),['-cp',jvm,'io.tbc.kit.dart.NetworkRouterCheckKt','test/fixtures/signing/replay.json'],options),
  run(join(scratch,'network'),['test/fixtures/signing/replay.json'],options),
  ...[['test/fixtures/signing/replay.json'],['test/fixtures/native-signing.json','native'],['test/fixtures/amm-controller-signing.json','controller'],[preparedPath,'prepared'],['../contract173-upgrade/high-level173.json','contract173']].flatMap(args=>[
   run(join(java,'bin/java'),['-cp',jvm,'io.tbc.kit.dart.CustodyCheckKt',...args],options),run(join(scratch,'custody'),args,options),
  ]),
 ]);
 const parsed=results.map(r=>JSON.parse(r.stdout));assert.equal(parsed[0].status,'NATIVE_NETWORK_CUSTODY_ROUTER_PASS');assert.deepEqual(parsed[0],parsed[1]);
 for(const r of parsed.slice(2))assert.equal(r.status,'PASS');
 const permissionResults=await Promise.all([
  run(join(java,'bin/java'),['-cp',jvm,'io.tbc.kit.dart.PermissionCheckKt','test/fixtures/native-permissions.json'],options),
  run(join(scratch,'permission'),['test/fixtures/native-permissions.json',join(scratch,'single-sqlite')],options),
  run(join(scratch,'permission-group'),[join(scratch,'group-sqlite')],options),
 ]);
 const permissions=permissionResults.map(r=>JSON.parse(r.stdout));assert.equal(permissions[0].status,'PASS');assert.equal(permissions[1].status,'PASS');assert.equal(permissions[2].status,'PERMISSION_GROUP_SQLITE_PASS');
 const protocolResults=await Promise.all([
  run(join(java,'bin/java'),['-cp',jvm,'io.tbc.kit.dart.ProtocolIsolationCheckKt'],options),
  run(join(scratch,'protocol'),[join(scratch,'protocol-sqlite')],options),
 ]);
 const protocolIsolation=protocolResults.map(r=>JSON.parse(r.stdout));for(const r of protocolIsolation)assert.equal(r.status,'NATIVE_PROTOCOL_ISOLATION_PASS');
 const legacyResults=await Promise.all([
  run(join(java,'bin/java'),['-cp',jvm,'io.tbc.kit.dart.CustodyCheckKt','test/fixtures/legacy-message-signing.json','legacy-message'],options),
  run(join(scratch,'custody'),['test/fixtures/legacy-message-signing.json','legacy-message'],options),
 ]);
 const legacyMessages=legacyResults.map(r=>JSON.parse(r.stdout));for(const r of legacyMessages){assert.equal(r.status,'PASS');assert.equal(r.legacyMessages,4);assert.equal(r.legacyWorkflows,2);}assert.equal(legacyMessages[0].checks,legacyMessages[1].checks);
 const sources={};for(const p of [...kt,...sw,'test/native/NetworkRouterCheck.kt','test/native/NetworkRouterCheck.swift','test/native/CustodyCheck.kt','test/native/CustodyCheck.swift','test/native/PermissionCheck.kt','test/native/PermissionCheck.swift','test/native/PermissionGroupSqliteCheck.swift','test/fixtures/native-permissions.json','test/fixtures/signing/replay.json','test/fixtures/native-signing.json','test/fixtures/amm-controller-signing.json','test/fixtures/prepared-signing.json','../contract173-upgrade/high-level173.json','tool/check_network_router.mjs'])sources[p]=createHash('sha256').update(await readFile(join(base,p))).digest('hex');
 for(const p of ['test/native/ProtocolIsolationCheck.kt','test/native/ProtocolIsolationCheck.swift'])sources[p]=createHash('sha256').update(await readFile(join(base,p))).digest('hex');
 for(const p of ['test/fixtures/legacy-message-signing.json','tool/legacy_message_oracle.mjs'])sources[p]=createHash('sha256').update(await readFile(join(base,p))).digest('hex');
 const report={status:'NETWORK_ROUTER_CUSTODY_INTEGRATION_PASS',recordedAt:new Date().toISOString(),kotlin:parsed[0],swift:parsed[1],existingMessageAndTbcRegression:parsed.slice(2),permissionRegression:permissions,protocolIsolation,legacyMessages,sources,scratch,
  preparedScope:{retained:21,excluded:[{name:'amm-create-public',reason:'Superseded pre1.7.3 preset creation; rejected AMM_FEE_FIELDS. Frozen input unchanged. Current explicit-fee creation is covered by40-case contract173 replay.'}],path:preparedPath,sha256:createHash('sha256').update(await readFile(preparedPath)).digest('hex')},
  proof:'Actual native custody/host/private-channel dispatch; chain/account selection, committed result/event binding, signer fences, grants, revoke and peer projection. Group grants use one approval and reject stale/cancelled/failed acknowledgements on both language hosts. Real SQLite single/group rollback, replay and restart run on macOS only; Android SQLite still requires device execution. Flutter registration is compiled separately; no installed mobile-channel or real-chain proof.',broadcasts:0};
 await writeFile(resolve(base,output),JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({status:report.status,kotlin:parsed[0],swift:parsed[1],existingMessageAndTbcRegression:parsed.slice(2),permissionRegression:permissions,protocolIsolation,legacyMessages,scratch}));
}catch(e){console.error(JSON.stringify({status:'FAIL',message:e.message?.slice(-3500),stderr:e.stderr?.slice(-8000),stdout:e.stdout?.slice(-1000),scratch}));process.exitCode=1;}
