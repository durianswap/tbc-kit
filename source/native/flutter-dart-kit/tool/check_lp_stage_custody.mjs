// Paired native LP continuation regression and hostile-stage checks. No network.
import {readFile,writeFile,readdir,mkdtemp} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {homedir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const run=promisify(execFile),base=resolve(import.meta.dirname,'..'),output=process.argv[2];assert(output);
const sha=b=>createHash('sha256').update(b).digest('hex');
const scratch=await mkdtemp('/private/tmp/tbc-lp-stage-custody-'),java=process.env.JAVA_HOME;assert(java);
const cache=join(homedir(),'.gradle/caches/modules-2/files-2.1');
async function jar(g,n,v){const root=join(cache,g,n,v),hits=[];for(const d of await readdir(root))for(const f of await readdir(join(root,d)))if(f===`${n}-${v}.jar`)hits.push(join(root,d,f));assert.equal(hits.length,1);return hits[0];}
const compiler=await Promise.all([['org.jetbrains.kotlin','kotlin-compiler-embeddable','2.1.20'],['org.jetbrains.kotlin','kotlin-stdlib','2.1.20'],['org.jetbrains.kotlin','kotlin-script-runtime','2.1.20'],['org.jetbrains.kotlin','kotlin-daemon-embeddable','2.1.20'],['org.jetbrains.kotlin','kotlin-reflect','1.6.10'],['org.jetbrains.intellij.deps','trove4j','1.0.20200330'],['org.jetbrains','annotations','13.0'],['org.jetbrains.kotlinx','kotlinx-coroutines-core-jvm','1.8.1']].map(v=>jar(...v)));
const json=await jar('org.json','json','20240303'),android=join(homedir(),'Library/Android/sdk/platforms/android-36/android.jar');
const names=['NativePermissions','NativePrepared','NativeReviewed','NativeCustody','NativeWalletHost','NativeWorkflow','NativeCrypto','NativeNetworkSessions','NativeNetworkWalletRouter','NativeProtocolWalletRouter'];
const swift=names.map(n=>`platform/ios/Classes/${n}.swift`),kotlin=names.map(n=>`platform/android/src/main/kotlin/io/tbc/kit/dart/${n}.kt`),opts={cwd:base,maxBuffer:3e6,timeout:120000};
await Promise.all([
 run('xcrun',['swiftc','-swift-version','6','-parse-as-library',...swift,'test/native/CustodyCheck.swift','-o',join(scratch,'check')],opts),
 run(join(java,'bin/java'),['-cp',compiler.join(':'),'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler','-language-version','1.8','-api-version','1.8','-no-stdlib','-no-reflect','-jvm-target','17','-classpath',[compiler[1],compiler[6],json,android].join(':'),'-d',join(scratch,'classes'),...kotlin,'test/native/CustodyCheck.kt'],opts)
]);
const fixtures=['test/fixtures/lp-staged-signing.json','test/fixtures/amm-alias-staged-signing.json','test/fixtures/staged-signing.json','test/fixtures/amm-dependent-signing.json'],results=[];
for(const relative of fixtures){const fixture=join(base,relative);
 for(const [platform,cmd,args] of [['swift-macos',join(scratch,'check'),[fixture,'staged']],['kotlin-jvm',join(java,'bin/java'),['-cp',[join(scratch,'classes'),compiler[1],json,android].join(':'),'io.tbc.kit.dart.CustodyCheckKt',fixture,'staged']]]){
  try{const r=await run(cmd,args,opts);results.push({platform,fixture:relative,...JSON.parse(r.stdout)});}catch(e){results.push({platform,fixture:relative,status:'FAIL',code:e.code,stderr:e.stderr.slice(0,800)});}
 }
}
const hashes={};for(const p of [...swift,...kotlin,...fixtures,'test/native/CustodyCheck.swift','test/native/CustodyCheck.kt'])hashes[p]=sha(await readFile(join(base,p)));
await writeFile(output,JSON.stringify({results,scratch,sourceHashes:hashes,broadcasts:0},null,2),{flag:'wx'});
console.log(JSON.stringify({results,evidence:output}));if(results.some(r=>r.status!=='PASS'))process.exitCode=1;
