// Paired native custody checks; public replay, no device or live key claim.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,writeFile,readdir,mkdtemp} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {homedir,tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
const run=promisify(execFile),base=resolve(import.meta.dirname,'..'),output=process.argv[2];assert(output);
const sha=b=>createHash('sha256').update(b).digest('hex');
const canonical=v=>v===null?'null':Array.isArray(v)?'['+v.map(canonical).join(',')+']':typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
const hash=v=>sha(canonical(v));
const oraclePath='test/fixtures/crypto-signing.json',bytes=await readFile(join(base,oraclePath)),oracle=JSON.parse(bytes);
assert.equal(sha(bytes),'9373286892cfd6c82a93d7f5c8637f12015172b261e3463613058cb63a818bc3');
const scratch=await mkdtemp(join(tmpdir(),'tbc-dart-crypto-native-'));
const names=['NativePermissions','NativePrepared','NativeReviewed','NativeCustody','NativeWorkflow','NativeWalletHost','NativeCrypto'];
const swift=names.map(n=>'platform/ios/Classes/'+n+'.swift'),kotlin=names.map(n=>'platform/android/src/main/kotlin/io/tbc/kit/dart/'+n+'.kt');
const gradle=join(homedir(),'.gradle/caches/modules-2/files-2.1');
async function jar(g,n,v){const root=join(gradle,g,n,v),hits=[];for(const d of await readdir(root,{withFileTypes:true}))if(d.isDirectory())for(const f of await readdir(join(root,d.name)))if(f===`${n}-${v}.jar`)hits.push(join(root,d.name,f));assert.equal(hits.length,1);return hits[0];}
const java='/Users/alex/Library/Java/JavaVirtualMachines/temurin-17.jdk/Contents/Home/bin/java';
const compiler=await Promise.all([
 ['org.jetbrains.kotlin','kotlin-compiler-embeddable','2.1.20'],['org.jetbrains.kotlin','kotlin-stdlib','2.1.20'],['org.jetbrains.kotlin','kotlin-script-runtime','2.1.20'],['org.jetbrains.kotlin','kotlin-daemon-embeddable','2.1.20'],['org.jetbrains.kotlin','kotlin-reflect','1.6.10'],['org.jetbrains.intellij.deps','trove4j','1.0.20200330'],['org.jetbrains','annotations','13.0'],['org.jetbrains.kotlinx','kotlinx-coroutines-core-jvm','1.8.1']].map(v=>jar(...v)));
const json=await jar('org.json','json','20240303'),androidJar=join(homedir(),'Library/Android/sdk/platforms/android-36/android.jar');
const sdk=(await run('/usr/bin/xcrun',['--sdk','macosx','--show-sdk-path'])).stdout.trim(),opts={cwd:base,maxBuffer:2**20,timeout:120000};
try{
 const compiles=await Promise.all([
  run('/usr/bin/xcrun',['swiftc','-sdk',sdk,'-swift-version','6','-parse-as-library',...swift,'test/native/CryptoCustodyCheck.swift','-o',join(scratch,'crypto-check')],opts),
  run('/usr/bin/xcrun',['swiftc','-sdk',sdk,'-swift-version','6','-parse-as-library',...swift,'test/native/CustodyCheck.swift','-o',join(scratch,'custody-check')],opts),
  run(java,['-cp',compiler.join(':'),'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler','-language-version','1.8','-api-version','1.8','-no-stdlib','-no-reflect','-jvm-target','17','-classpath',[compiler[1],compiler[6],json,androidJar].join(':'),'-d',join(scratch,'classes'),...kotlin,'test/native/CryptoCustodyCheck.kt','test/native/CustodyCheck.kt'],opts)
 ]);
 // Native custody owns its actual clock. Refresh deadlines and enclosing
 // commitments only; all messages/ciphertexts/tasks/accounts stay unchanged.
 const fresh=structuredClone(oracle.cases),expiry=new Date(Date.now()+240000).toISOString();
 for(const s of fresh){const a=s.audit;if(s.request.expiresAt)s.request.expiresAt=expiry;
  a.plan.payload.expiresAt=expiry;a.plan.payload.requestHash=hash(s.request);a.plan.planHash=hash(a.plan.payload);
  a.binding.payload.expiresAt=expiry;a.binding.payload.requestHash=hash(s.request);a.binding.payload.operationHash=a.plan.planHash;a.binding.bindingHash=hash(a.binding.payload);
 }
 const fixture=join(scratch,'crypto.json');await writeFile(fixture,JSON.stringify({original:oracle.cases,fresh}),{flag:'wx'});
 const classpath=[join(scratch,'classes'),compiler[1],json,androidJar].join(':');
 const pair=await Promise.all([run(join(scratch,'crypto-check'),[fixture],opts),run(java,['-cp',classpath,'io.tbc.kit.dart.CryptoCustodyCheckKt',fixture],opts)]);
 const results=pair.map(r=>JSON.parse(r.stdout));for(const r of results){assert.equal(r.status,'PASS');assert.equal(r.cases,12);}assert.equal(results[0].checks,results[1].checks);
 const regression=[];
 for(const [f,mode]of (process.argv.includes('--crypto-only')?[]:[['prepared-signing.json','prepared'],['typed-signing.json','typed'],['signing/replay.json',null]])){
  const args=[join(base,'test/fixtures',f),...(mode?[mode]:[])];
  const checked=await Promise.all([run(join(scratch,'custody-check'),args,opts),run(java,['-cp',classpath,'io.tbc.kit.dart.CustodyCheckKt',...args],opts)]);
  const results=checked.map(r=>JSON.parse(r.stdout));for(const r of results)assert.equal(r.status,'PASS');assert.equal(results[0].checks,results[1].checks);regression.push({file:f,results});
 }
 const sourceHashes={};for(const f of [...swift,...kotlin,'platform/ios/Classes/TbcDartWalletHost.swift','platform/android/src/main/kotlin/io/tbc/kit/dart/TbcDartWalletHost.kt','test/native/CryptoCustodyCheck.swift','test/native/CryptoCustodyCheck.kt','tool/check_crypto_native.mjs'])sourceHashes[f]=sha(await readFile(join(base,f)));
 const protectedState=JSON.parse((await run(process.execPath,['tool/check_protected.mjs'],opts)).stdout);
 const report={status:'F3_BIE1_NATIVE_CUSTODY_HOST_PASS',cryptoOnly:process.argv.includes('--crypto-only'),recordedAt:new Date().toISOString(),oracle:{path:oraclePath,sha256:sha(bytes)},sourceHashes,
  results,regression,warnings:compiles.map(r=>r.stderr).filter(Boolean),scratch,fixtureSha256:sha(await readFile(fixture)),protectedState,
  proof:'Optional native crypto executor reuses one shared consent/receipt/one-use task owner. Frozen plan/result parity, exact account/key/task, grant, reject, altered plan/task, lock before/after callback, navigation, failure and exact result-delivery hash. Private signing.crypto dispatch, delivery.prepare and actual host emission gate reject early/wrong-method/altered/locked results; errors are fixed and redacted. Recorded public crypto bytes, no actual Vault computation in this check.',
  limits:['Shared native custody and private host dispatch compile on Swift/macOS and Kotlin/JVM; Flutter MethodChannel/UI frameworks are not compiled by this check. Separate Dart worker tests, public Provider/device routing and crypto workflow remain separately scoped.',
   'Host Swift/Kotlin replay is not physical-device/minimum-OS, production Vault, private Testnet, matched speed/size or final delivery proof.'],
  chainHttp:0,broadcasts:0,acceptedDeliveryChanged:false,goalComplete:false,published:false};
 const reportBytes=JSON.stringify(report,null,2)+'\n';await writeFile(resolve(base,output),reportBytes,{flag:'wx'});
 console.log(JSON.stringify({status:report.status,results,regression,sha256:sha(reportBytes),scratch}));
}catch(e){console.error(JSON.stringify({status:'FAIL',message:e.message,stderr:e.stderr?.slice(-12000),stdout:e.stdout?.slice(-2000),scratch}));process.exitCode=1;}
