// Focused host compile/replay: public fixtures only, no device or network claim.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,readdir,mkdtemp,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {homedir,tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
const run=promisify(execFile),root=resolve(import.meta.dirname,'../..'),base=join(root,'native/flutter-dart-kit');
const javaHome=process.env.JAVA_HOME,androidHome=process.env.ANDROID_HOME;
assert(javaHome&&androidHome,'JAVA_HOME and ANDROID_HOME are required');
const cache=join(homedir(),'.gradle/caches/modules-2/files-2.1');
async function jar(group,name,version){
 const dir=join(cache,group,name,version),hits=[];
 for(const e of await readdir(dir,{withFileTypes:true}))if(e.isDirectory())for(const f of await readdir(join(dir,e.name)))if(f===`${name}-${version}.jar`)hits.push(join(dir,e.name,f));
 assert.equal(hits.length,1,`${group}:${name}:${version}`);return hits[0];
}
const compiler=await Promise.all([
 ['org.jetbrains.kotlin','kotlin-compiler-embeddable','2.1.20'],
 ['org.jetbrains.kotlin','kotlin-stdlib','2.1.20'],
 ['org.jetbrains.kotlin','kotlin-script-runtime','2.1.20'],
 ['org.jetbrains.kotlin','kotlin-daemon-embeddable','2.1.20'],
 ['org.jetbrains.kotlin','kotlin-reflect','1.6.10'],
 ['org.jetbrains.intellij.deps','trove4j','1.0.20200330'],
 ['org.jetbrains','annotations','13.0'],
 ['org.jetbrains.kotlinx','kotlinx-coroutines-core-jvm','1.8.1'],
].map(v=>jar(...v)));
const json=await jar('org.json','json','20240303'),androidJar=join(androidHome,'platforms/android-36/android.jar');
const swiftc=(await run('/usr/bin/xcrun',['--find','swiftc'])).stdout.trim(),sdk=(await run('/usr/bin/xcrun',['--sdk','macosx','--show-sdk-path'])).stdout.trim();
const scratch=await mkdtemp(join(tmpdir(),'tbc-contract173-native-review-'));
const names=['NativePermissions','NativeCustody','NativePrepared','NativeReviewed','NativeWorkflow','NativeWalletHost','NativeCrypto'];
const kotlin=names.map(n=>`platform/android/src/main/kotlin/io/tbc/kit/dart/${n}.kt`).concat('test/native/CustodyCheck.kt');
const swift=names.map(n=>`platform/ios/Classes/${n}.swift`).concat('test/native/CustodyCheck.swift');
const options={cwd:base,maxBuffer:2**20,timeout:120000};
const compiled=await Promise.allSettled([
 run(join(javaHome,'bin/java'),['-cp',compiler.join(':'),'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler','-no-stdlib','-no-reflect','-jvm-target','17','-classpath',[compiler[1],compiler[6],json,androidJar].join(':'),'-d',join(scratch,'classes'),...kotlin],options),
 run(swiftc,['-sdk',sdk,'-swift-version','6','-parse-as-library',...swift,'-o',join(scratch,'custody-check')],options),
]);
for(const r of compiled)if(r.status==='rejected')throw r.reason;
const fixture=join(import.meta.dirname,'high-level173.json');
const checks=await Promise.all([
 run(join(javaHome,'bin/java'),['-cp',[join(scratch,'classes'),compiler[1],json,androidJar].join(':'),'io.tbc.kit.dart.CustodyCheckKt',fixture,'contract173'],options),
 run(join(scratch,'custody-check'),[fixture,'contract173'],options),
]);
const results=checks.map(r=>JSON.parse(r.stdout));
for(const r of results){assert.equal(r.status,'PASS');assert.equal(r.cases,40);assert.equal(r.deviceAcceptance,false)}
assert.equal(results[0].checks,results[1].checks);
const sha=b=>createHash('sha256').update(b).digest('hex'),sourceHashes={};
for(const p of [...kotlin,...swift])sourceHashes[p]=sha(await readFile(join(base,p)));
const report={status:'PASS_HOST_COMPILE_REPLAY_NOT_DEVICE_ACCEPTANCE',results,sourceHashes,fixtureSha256:sha(await readFile(fixture)),scope:'40 explicit-fee public/controller plain/timelocked create/add/buy/sell/remove cases; bounded one-consent and continuation checks; creation fee display and invalid config rejection',scratch,broadcasts:0};
if(process.argv[2])await writeFile(resolve(process.argv[2]),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({status:report.status,results,scratch,broadcasts:0}));
