// Compile actual mobile-facing registration/boundary sources with the installed
// Flutter SDK and platform SDKs. This is not execution on an iOS/Android device.
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,readdir,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir,homedir} from 'node:os';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const run=promisify(execFile),base=resolve(import.meta.dirname,'..'),sdk=process.argv[2],output=process.argv[3];
const javaHome=process.env.JAVA_HOME,androidHome=process.env.ANDROID_HOME;
assert(javaHome&&androidHome&&sdk,'Flutter SDK, JAVA_HOME and ANDROID_HOME required');
const cache=join(homedir(),'.gradle/caches/modules-2/files-2.1');
async function artifact(group,name,version,extension='jar'){
 const root=join(cache,group,name,version),hits=[];
 for(const e of await readdir(root,{withFileTypes:true}))if(e.isDirectory())
  for(const f of await readdir(join(root,e.name)))if(f===`${name}-${version}.${extension}`)hits.push(join(root,e.name,f));
 assert.equal(hits.length,1,`${group}:${name}:${version}`);return hits[0];
}
const kotlin=await Promise.all([
 ['org.jetbrains.kotlin','kotlin-compiler-embeddable','2.1.20'],['org.jetbrains.kotlin','kotlin-stdlib','2.1.20'],
 ['org.jetbrains.kotlin','kotlin-script-runtime','2.1.20'],['org.jetbrains.kotlin','kotlin-daemon-embeddable','2.1.20'],
 ['org.jetbrains.kotlin','kotlin-reflect','1.6.10'],['org.jetbrains.intellij.deps','trove4j','1.0.20200330'],
 ['org.jetbrains','annotations','13.0'],['org.jetbrains.kotlinx','kotlinx-coroutines-core-jvm','1.8.1'],
].map(a=>artifact(...a)));
const engine=(await readFile(join(sdk,'bin/internal/engine.version'),'utf8')).trim();
const flutter=await artifact('io.flutter','flutter_embedding_release',`1.0.0-${engine}`);
const webkit=await artifact('androidx.webkit','webkit','1.12.1','aar');
const androidJar=join(androidHome,'platforms/android-36/android.jar');
const rootKotlin='platform/android/src/main/kotlin/io/tbc/kit/dart',rootSwift='platform/ios/Classes';
const kt=(await readdir(join(base,rootKotlin))).filter(f=>f.endsWith('.kt')).map(f=>join(rootKotlin,f));
const swift=(await readdir(join(base,rootSwift))).filter(f=>f.endsWith('.swift')).map(f=>join(rootSwift,f));
const iosSdk=(await run('/usr/bin/xcrun',['--sdk','iphonesimulator','--show-sdk-path'])).stdout.trim();
const scratch=await mkdtemp(join(tmpdir(),'tbc-dart-flutter-compile-'));
const options={cwd:base,maxBuffer:2**20,timeout:120000};
try{
 await run('/usr/bin/unzip',['-q',webkit,'classes.jar','-d',scratch],options);
 const results=await Promise.allSettled([
  run(join(javaHome,'bin/java'),['-cp',kotlin.join(':'),'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler',
   '-no-stdlib','-no-reflect','-jvm-target','17','-classpath',[kotlin[1],kotlin[6],androidJar,flutter,join(scratch,'classes.jar')].join(':'),
   '-d',join(scratch,'classes'),...kt],options),
  run('/usr/bin/xcrun',['swiftc','-sdk',iosSdk,'-swift-version','6','-typecheck','-I','platform/native',
   '-target','arm64-apple-ios15.0-simulator','-module-cache-path',join(scratch,'swift-cache'),
   '-F',join(sdk,'bin/cache/artifacts/engine/ios/Flutter.xcframework/ios-arm64_x86_64-simulator'),...swift],options),
 ]);
 for(const r of results)if(r.status==='rejected')throw r.reason;
 const sha=b=>createHash('sha256').update(b).digest('hex'),sources={};
 for(const p of [...kt,...swift,'platform/native/reviewed_compute.h','platform/native/module.modulemap'])sources[p]=sha(await readFile(join(base,p)));
 const report={status:'F1_FLUTTER_NATIVE_SOURCES_COMPILE_PASS',recordedAt:new Date().toISOString(),
  flutterEngine:engine,kotlinSources:kt.length,swiftSources:swift.length,sources,
  iosTarget:'arm64-apple-ios15.0-simulator',androidCompileSdk:36,webkit:'1.12.1',
  warnings:results.map(r=>r.value.stderr).filter(Boolean),
  proofLimit:'Compile/typecheck against actual mobile Flutter/platform SDKs only. No device channel/UI/Vault/chain/minimum-OS-runtime proof.',
  acceptedDeliveryChanged:false,broadcasts:0};
 if(output)await writeFile(resolve(base,output),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
 console.log(JSON.stringify(report));
}catch(e){console.error(JSON.stringify({status:'FAIL',message:e.message,stderr:e.stderr?.slice(-8000)}));process.exitCode=1;}
finally{await rm(scratch,{recursive:true,force:true});}
