// Focused desktop native replay only, not mobile/Provider completion evidence.
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
const scratch=await mkdtemp('/private/tmp/tbc-dart-network-'),options={cwd:base,maxBuffer:2e6,timeout:120000};
const kt='platform/android/src/main/kotlin/io/tbc/kit/dart',sw='platform/ios/Classes';
const sources=[`${kt}/NativePermissions.kt`,`${kt}/NativeNetworkSessions.kt`,`${sw}/NativePermissions.swift`,`${sw}/NativeNetworkSessions.swift`,'test/native/NetworkCheck.kt','test/native/NetworkCheck.swift','test/fixtures/network-switch.json','test/native/PermissionCheck.kt','test/native/PermissionCheck.swift'];
try{
 await Promise.all([
  run(join(java,'bin/java'),['-cp',compiler.join(':'),'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler','-no-stdlib','-no-reflect','-jvm-target','17','-classpath',[compiler[1],compiler[6],json,androidJar].join(':'),'-d',join(scratch,'classes'),...sources.filter(p=>p.endsWith('.kt'))],options),
  run('xcrun',['swiftc','-swift-version','6','-parse-as-library',`${sw}/NativePermissions.swift`,`${sw}/NativeNetworkSessions.swift`,'test/native/NetworkCheck.swift','-o',join(scratch,'network')],options),
  run('xcrun',['swiftc','-swift-version','6','-parse-as-library',`${sw}/NativePermissions.swift`,'test/native/PermissionCheck.swift','-o',join(scratch,'permissions')],options),
 ]);
 const jvm=[join(scratch,'classes'),compiler[1],json,androidJar].join(':');
 const results=await Promise.all([
  run(join(java,'bin/java'),['-cp',jvm,'io.tbc.kit.dart.NetworkCheckKt','test/fixtures/network-switch.json'],options),
  run(join(scratch,'network'),['test/fixtures/network-switch.json'],options),
  run(join(java,'bin/java'),['-cp',jvm,'io.tbc.kit.dart.PermissionCheckKt','test/fixtures/native-permissions.json'],options),
  run(join(scratch,'permissions'),['test/fixtures/native-permissions.json',join(scratch,'sqlite')],options),
 ]);
 const parsed=results.map(r=>JSON.parse(r.stdout));assert.equal(parsed[0].status,'NETWORK_SESSION_CAS_PASS');assert.deepEqual(parsed[0],parsed[1]);
 for(const r of parsed.slice(2))assert.equal(r.status,'PASS');
 const hashes={};for(const f of sources)hashes[f]=createHash('sha256').update(await readFile(join(base,f))).digest('hex');
 const report={status:'NATIVE_NETWORK_CAS_AND_PERMISSION_REGRESSION_PASS',date:new Date().toISOString(),kotlin:parsed[0],swift:parsed[1],permissionRegression:parsed.slice(2),sources:hashes,scratch,
  proof:'Compiled Swift/Kotlin native state machine + packaged Kit approval/hash parity and targeted permission-store regressions. Production Flutter router and public tbc_switchChain are not wired yet; no mobile/device or real-network claim.',broadcasts:0};
 await writeFile(resolve(base,output),JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({status:report.status,kotlin:parsed[0],swift:parsed[1],permissionRegression:parsed.slice(2),scratch}));
}catch(e){console.error(JSON.stringify({status:'FAIL',message:e.message,stderr:e.stderr?.slice(-9000),scratch}));process.exitCode=1;}
