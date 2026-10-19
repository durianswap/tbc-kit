// Real system SQLite: Swift on macOS and Kotlin under Android app_process.
// This is storage proof, not installed wallet/approval/HTTP/chain acceptance.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,readdir,mkdtemp,writeFile,mkdir} from 'node:fs/promises';
import {homedir} from 'node:os';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
const run=promisify(execFile),base=resolve(import.meta.dirname,'..'),output=process.argv[2];assert(output);
const javaHome=process.env.JAVA_HOME;assert(javaHome);
const android=process.env.ANDROID_HOME??join(homedir(),'Library/Android/sdk'),device=process.env.TBC_ANDROID_DEVICE??'emulator-5554';
assert(/^emulator-[0-9]+$/.test(device),'Explicit emulator only');
const adb=join(android,'platform-tools/adb'),jarRoot=join(homedir(),'.gradle/caches/modules-2/files-2.1');
const sha=b=>createHash('sha256').update(b).digest('hex');
async function jar(group,name,version){const root=join(jarRoot,group,name,version),hits=[];
 for(const row of await readdir(root,{withFileTypes:true}))if(row.isDirectory())for(const f of await readdir(join(root,row.name)))if(f===`${name}-${version}.jar`)hits.push(join(root,row.name,f));
 assert.equal(hits.length,1);return hits[0];}
const compiler=await Promise.all([
 ['org.jetbrains.kotlin','kotlin-compiler-embeddable','2.1.20'],['org.jetbrains.kotlin','kotlin-stdlib','2.1.20'],
 ['org.jetbrains.kotlin','kotlin-script-runtime','2.1.20'],['org.jetbrains.kotlin','kotlin-daemon-embeddable','2.1.20'],
 ['org.jetbrains.kotlin','kotlin-reflect','1.6.10'],['org.jetbrains.intellij.deps','trove4j','1.0.20200330'],
 ['org.jetbrains','annotations','13.0'],['org.jetbrains.kotlinx','kotlinx-coroutines-core-jvm','1.8.1'],
].map(v=>jar(...v)));
const scratch=await mkdtemp('/private/tmp/tbc-dart-broadcast-store-'),remote='/data/local/tmp/'+scratch.split('/').at(-1);
const options={cwd:base,maxBuffer:2**20,timeout:120000,env:{...process.env,JAVA_HOME:javaHome}};
const swift=['platform/ios/Classes/NativeBroadcastStore.swift','test/native/BroadcastStoreCheck.swift'],
 kotlin=['platform/android/src/main/kotlin/io/tbc/kit/dart/NativeBroadcastStore.kt','test/native/BroadcastStoreCheck.kt'];
try {
 assert.equal((await run(adb,['-s',device,'get-state'],options)).stdout.trim(),'device');
 const api=(await run(adb,['-s',device,'shell','getprop','ro.build.version.sdk'],options)).stdout.trim();
 const fixture='test/fixtures/broadcast-port.json',bytes=await readFile(join(base,fixture));assert.equal(sha(bytes),'2486ddf4794c64c250749ca0030c14b6fce896ad1646aa8ca0a95a8137ddbe8d');
 const androidJar=join(android,'platforms/android-36/android.jar');
 const compiles=await Promise.all([
  run('/usr/bin/xcrun',['swiftc','-swift-version','6','-parse-as-library',...swift,'-o',join(scratch,'store-check')],options),
  run(join(javaHome,'bin/java'),['-cp',compiler.join(':'),'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler','-language-version','1.8','-api-version','1.8','-no-stdlib','-no-reflect','-jvm-target','17','-classpath',[compiler[1],compiler[6],androidJar].join(':'),'-d',join(scratch,'classes'),...kotlin],options),
 ]);
 await run(join(javaHome,'bin/jar'),['cf',join(scratch,'store.jar'),'-C',join(scratch,'classes'),'.'],options);
 const dex=await run(join(android,'build-tools/36.0.0/d8'),['--lib',androidJar,'--min-api','26','--output',join(scratch,'store-dex.jar'),join(scratch,'store.jar'),compiler[1]],options);
 await run(adb,['-s',device,'shell','mkdir','-p',remote],options);
 await run(adb,['-s',device,'push',join(scratch,'store-dex.jar'),remote+'/store.jar'],options);
 await run(adb,['-s',device,'push',join(base,fixture),remote+'/fixture.json'],options);
 const androidRun=async(mode)=>run(adb,['-s',device,'shell',`CLASSPATH=${remote}/store.jar`,'/system/bin/app_process','/system/bin','io.tbc.kit.dart.BroadcastStoreCheckKt',remote+'/fixture.json',remote+'/db',...(mode?[mode]:[])],options);
 const swiftRun=async(mode)=>run(join(scratch,'store-check'),[join(base,fixture),join(scratch,'swift-db'),...(mode?[mode]:[])],options);
 const parse=result=>{const lines=result.stdout.trim().split('\n');const line=lines.findLast(line=>line.startsWith('{')&&line.includes('"status"'));assert(line,'Missing result: '+result.stdout.slice(-2000));return JSON.parse(line);};
 const results=[];
 for(const [name,execute]of [['swift-macos-system-sqlite',swiftRun],['kotlin-android-system-sqlite',androidRun]]){
  const normal=await execute(),normalResult=parse(normal);assert.equal(normalResult.status,'PASS');
  const seeded=await execute('seed-crash');assert.equal(parse(seeded).status,'CRASH_SEEDED');
  const recovered=await execute('verify-crash'),recovery=parse(recovered);assert.equal(recovery.status,'CRASH_REOPEN_PASS');
  results.push({platform:name,...normalResult,processRestart:recovery,diagnostics:[normal.stderr,seeded.stderr,recovered.stderr].filter(Boolean)});
 }
 assert.equal(results[0].checks,results[1].checks);assert.deepEqual(results[0].cases,results[1].cases);assert.deepEqual(results[0].identityDigests,results[1].identityDigests);
 await mkdir(join(scratch,'android-db'));
 await run(adb,['-s',device,'pull',remote+'/db/tbc-kit-broadcast.sqlite',join(scratch,'android-db/store.sqlite')],options);
 const databases=[];
 for(const path of [join(scratch,'swift-db/tbc-kit-broadcast.sqlite'),join(scratch,'android-db/store.sqlite')]){
  const audit=(await run('/usr/bin/sqlite3',['-json',path,'SELECT profile,action,code,COUNT(*) AS count FROM broadcast_audit GROUP BY profile,action,code ORDER BY profile,action,code;'],options)).stdout;
  const integrity=(await run('/usr/bin/sqlite3',[path,'PRAGMA integrity_check;'],options)).stdout.trim();assert.equal(integrity,'ok');
  const auditRows=JSON.parse(audit);assert(auditRows.some(r=>r.action==='not-submitted'));assert(!audit.includes('PRIVATE_TEST_SECRET_SENTINEL'));
  const dbBytes=await readFile(path);databases.push({path,sha256:sha(dbBytes),bytes:dbBytes.length,integrity,audit:auditRows});
 }
 assert.deepEqual(databases[0].audit,databases[1].audit);
 const sourceHashes={};for(const f of [...swift,...kotlin,'tool/check_native_broadcast_store.mjs'])sourceHashes[f]=sha(await readFile(join(base,f)));
 const protection=JSON.parse((await run(process.execPath,['tool/check_protected.mjs'],options)).stdout);
 const parent='evidence/f3-broadcast-shared-design.json',report={status:'F3_NATIVE_BROADCAST_SYSTEM_SQLITE_PASS',recordedAt:new Date().toISOString(),parent:{path:parent,sha256:sha(await readFile(join(base,parent)))},fixture:{path:fixture,sha256:sha(bytes)},sourceHashes,
  results,databases,scratch,android:{device,api,remote,runner:'test-only app_process; no wallet App installed or replaced'},protection,
  warnings:[...compiles.map(r=>r.stderr),dex.stderr].filter(Boolean),
  semantics:['Whole-batch atomic reservation/uncertainty, exact identity and network-source/account/profile partition, idempotent completion and fail-closed contradiction/corruption.',
   'Dedicated system SQLite, FULL synchronous durability; no raw tx, signatures, approval token, private key or preimage column. Only fixed enum statuses/local codes persist; node errors are not stored.',
   'Prepared local abort is auditable and releases active tx identity only for a new request. Unknown/uncertain cannot be aborted by a caller POST=0 assertion. ReadByTxids selects active records so historical not-submitted rows do not shadow a fresh approved attempt.',
   'Native process-local one-use admission tickets bridge durable uncertainty to actual dispatch. A fresh fence rejection or native cancellation before start can prove not-submitted and abort the admitted batch; after entering the synchronous start callback, any throw remains uncertain. Consumed/foreign/unknown-replayed tickets cannot enqueue again.',
   'Intentional adapter differences from frozen generic journal: account/source/profile partition is native, arbitrary node error reasons are redacted on replay, and status lookup omits terminal local abort history. By-key audit/history remains preserved.'],
  limits:['No Dart adapter or native custody/dispatch wiring yet. Provider sends remain disabled; raw arbitrary broadcast is not exposed.',
   'Swift proof is macOS system SQLite, not installed iOS App storage. Android proof uses actual emulator system SQLite under shell test runner, not wallet sandbox/lifecycle/UI. No minimum OS or physical-device claim.',
   'Process halt/reopen verifies committed uncertainty persists and is not turned into a new reservation; no actual network dispatch, read-only node reconciliation or chain broadcast was performed.',
   'Actual receipt/task/Engine pre-broadcast and HTTP integration remain next. The ticket boundary is tested with a synchronous counter/throw callback, not real transport. The native owner must call it on the same serial executor as account/grant/navigation changes and cancel outstanding unstarted tickets on normal shutdown. No signing-only persistence was added.'],
  liveHttp:0,broadcasts:0,publicExecutableMethods:17,requiredMethods:22,acceptedDeliveryChanged:false,frozenRustModified:false,published:false,goalComplete:false};
 const reportBytes=JSON.stringify(report,null,2)+'\n';await writeFile(resolve(base,output),reportBytes,{flag:'wx'});
 console.log(JSON.stringify({status:report.status,results:results.map(r=>({platform:r.platform,checks:r.checks,cases:r.cases.length,processRestart:r.processRestart})),protectedFiles:protection.protectedFiles,sha256:sha(reportBytes),scratch,output}));
}catch(e){console.error(JSON.stringify({status:'FAIL',message:e.message,stderr:e.stderr?.slice(-9000),stdout:e.stdout?.slice(-2500),scratch,remote}));process.exitCode=1;}
