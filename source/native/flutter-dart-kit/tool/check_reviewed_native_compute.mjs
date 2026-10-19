// Actual frozen Rust through the paired C-ABI/JNI adapters and native custody.
// macOS Swift/JVM execution is not an iOS/Android installed-device/Vault claim.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,readdir,mkdtemp,writeFile,symlink} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {homedir,tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
const run=promisify(execFile),base=resolve(import.meta.dirname,'..'),repo=resolve(base,'../..'),output=process.argv[2];
const read=p=>readFile(join(base,p)),sha=b=>createHash('sha256').update(b).digest('hex');
const parentPath='evidence/f3-reviewed-native-custody-source-b.json',parentBytes=await read(parentPath),parent=JSON.parse(parentBytes);
assert.equal(sha(parentBytes),'600a71b7a99dd2528f3633e0f92f4c2fc5583dfbd6332ce2f0b4d3b887fa42fd');
const publicRoutingChanges=new Set(['platform/ios/Classes/NativeCustody.swift','platform/ios/Classes/NativeWalletHost.swift','platform/android/src/main/kotlin/io/tbc/kit/dart/NativeCustody.kt','platform/android/src/main/kotlin/io/tbc/kit/dart/NativeWalletHost.kt','platform/ios/Classes/NativePermissions.swift','platform/android/src/main/kotlin/io/tbc/kit/dart/NativePermissions.kt','platform/ios/Classes/NativePrepared.swift','platform/android/src/main/kotlin/io/tbc/kit/dart/NativePrepared.kt']);
for(const p of ['platform/ios/Classes/NativeReviewed.swift','platform/android/src/main/kotlin/io/tbc/kit/dart/NativeReviewed.kt'])publicRoutingChanges.add(p);
const changedSinceParent={};
// The custody dependency is now included by this older compile driver as well.
publicRoutingChanges.add('tool/check_reviewed_native_binding.mjs');
// Private workflow enter/finish bridge is a reviewed intentional change; no
// public routing, key use or default capability was enabled by this adapter.
publicRoutingChanges.add('lib/src/internal/native_wallet_binding.dart');
publicRoutingChanges.add('test/workflow_execution_test.dart');
for(const p of ['lib/src/internal/provider_control.dart','lib/src/internal/provider_session.dart','test/native_wallet_binding_test.dart'])publicRoutingChanges.add(p);
for(const [p,h]of Object.entries(parent.sourceHashes)){
 const current=sha(await read(p));
 if(current!==h){assert(publicRoutingChanges.has(p),p);changedSinceParent[p]={before:h,after:current};}
}
const library=JSON.parse(await read('test/fixtures/signing/replay.json')).library;
assert.equal(library.sha256,'693db42b186107bdb9d41bd59a047b8925afc2e97508042126e3b843dd8a1338');
assert.equal(sha(await readFile(library.path)),library.sha256);
const artifact='92d18b12fb2823d0dce98245b6ac1b689a44dcf581c25e3e2ab9a37bb94e40fb';
const nativeManifest=await readFile(join(repo,'release/flutter-native-bridge-20261012-b/tbc_kit_flutter/native-artifacts.json'));
assert.equal(sha(nativeManifest),'1b247beb248447f838e57653da97060cba0ddcdaa55aae1b3ac56ff907ebc6a9');
assert.equal(JSON.parse(nativeManifest).artifactId,artifact);
assert.equal(JSON.parse(nativeManifest).buildInputs.libraries['aarch64-apple-darwin'],library.sha256);
const oraclePath='test/fixtures/reviewed-signing.json',oracleBytes=await read(oraclePath),oracle=JSON.parse(oracleBytes);
assert.equal(sha(oracleBytes),'637937ec493b627d2a978d0922d2ccddfd497b0be75cb12011d3adb3faa07105');
const canonical=v=>v===null?'null':Array.isArray(v)?'['+v.map(canonical).join(',')+']':typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v),hash=v=>sha(canonical(v));
const cases=[],provenance={};
for(const c of oracle.cases){
 const bytes=await read('test/fixtures/'+c.source.file);provenance[c.source.file]=sha(bytes);
 assert.equal(provenance[c.source.file],parent.provenance[c.source.file]);
 const source=JSON.parse(bytes).cases.find(s=>s.name===c.source.name),material=source.material,policy=c.audit.plan.payload.task.policyMaterial,previous=[];
 const stages=source.stages.map(({stage,signatures,finalized},i)=>{
  const prepare={format:material.format,request:material.request,publicKey:c.account.publicKey,transactionIndex:i,previousTransactions:material.format==='associated'?[...previous]:[],resolvedOutputs:policy.resolvedOutputs};
  const tasks=stage.signingInputIndexes.map((vin,j)=>({taskId:`review-single-tx-${i}-input-${vin}`,purpose:'transaction',algorithm:'secp256k1-ecdsa-sha256d',digest:stage.digests[j],signatureEncoding:'compact64',sighashType:65,transactionTemplateId:`review-tx-${i}`,inputIndex:vin,accountId:c.account.accountId,publicKey:c.account.publicKey}));
  previous.push(finalized.txraw);return {prepare,stage,tasks,signatures,finalized};
 });
 cases.push({...c,packet:{kind:'reviewed',material,policyMaterial:policy,review:c.audit.plan.payload.review,stage:stages[0].stage},stages});
}
// Compilation can exceed two minutes on a loaded developer machine. This is
// a build-driver timeout only, not a wallet/signing deadline or protocol change.
const scratch=await mkdtemp(join(tmpdir(),'tbc-dart-reviewed-compute-')),opts={cwd:base,maxBuffer:2**20,timeout:300000};
const java=process.env.JAVA_HOME??(await run('/usr/libexec/java_home',[])).stdout.trim();
const cache=join(homedir(),'.gradle/caches/modules-2/files-2.1');
async function jar(g,n,v){const r=join(cache,g,n,v),hits=[];for(const d of await readdir(r,{withFileTypes:true}))if(d.isDirectory())for(const f of await readdir(join(r,d.name)))if(f===`${n}-${v}.jar`)hits.push(join(r,d.name,f));assert.equal(hits.length,1);return hits[0];}
const compiler=await Promise.all([
 ['org.jetbrains.kotlin','kotlin-compiler-embeddable','2.1.20'],['org.jetbrains.kotlin','kotlin-stdlib','2.1.20'],['org.jetbrains.kotlin','kotlin-script-runtime','2.1.20'],
 ['org.jetbrains.kotlin','kotlin-daemon-embeddable','2.1.20'],['org.jetbrains.kotlin','kotlin-reflect','1.6.10'],['org.jetbrains.intellij.deps','trove4j','1.0.20200330'],
 ['org.jetbrains','annotations','13.0'],['org.jetbrains.kotlinx','kotlinx-coroutines-core-jvm','1.8.1']].map(a=>jar(...a)));
const json=await jar('org.json','json','20240303');
const androidJar=join(process.env.ANDROID_HOME??join(homedir(),'Library/Android/sdk'),'platforms/android-36/android.jar');
const sdk=(await run('/usr/bin/xcrun',['--sdk','macosx','--show-sdk-path'])).stdout.trim();
const names=['NativePermissions','NativePrepared','NativeReviewed','NativeCustody','NativeWorkflow','NativeReviewedRust','NativeWalletHost','NativeCrypto'];
const swift=names.map(n=>`platform/ios/Classes/${n}.swift`),kotlin=names.map(n=>`platform/android/src/main/kotlin/io/tbc/kit/dart/${n}.kt`);
const include=join(repo,'packages/tbc-engine/rust/crates/tbc-keyless-native/include');
const flags=['-std=c++17','-O2','-fno-exceptions','-fno-rtti','-Wall','-Wextra','-Werror','-Iplatform/native','-I'+include,`-DTBC_DART_REVIEWED_ARTIFACT="${artifact}"`];
try{
 await symlink(library.path,join(scratch,'libtbc_compute_native.dylib'));
 const cpp=await run('/usr/bin/xcrun',['clang++',...flags,'-c','platform/native/reviewed_compute.cpp','-o',join(scratch,'reviewed.o')],opts);
 const results=await Promise.all([
  run('/usr/bin/xcrun',['swiftc','-sdk',sdk,'-swift-version','6','-parse-as-library','-I','platform/native',...swift,'test/native/ReviewedComputeCheck.swift',join(scratch,'reviewed.o'),library.path,'-Xlinker','-rpath','-Xlinker',dirname(library.path),'-o',join(scratch,'swift-check')],opts),
  run('/usr/bin/xcrun',['clang++',...flags,'-nostdlib++','-dynamiclib','-I'+join(java,'include'),'-I'+join(java,'include/darwin'),'platform/android/src/main/cpp/reviewed-jni.cpp',join(scratch,'reviewed.o'),library.path,'-Wl,-rpath,'+dirname(library.path),'-o',join(scratch,'libtbc_dart_reviewed.dylib')],opts),
  run(join(java,'bin/java'),['-cp',compiler.join(':'),'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler','-no-stdlib','-no-reflect','-jvm-target','17','-classpath',[compiler[1],compiler[6],json,androidJar].join(':'),'-d',join(scratch,'classes'),...kotlin,'test/native/ReviewedComputeCheck.kt'],opts)
 ]);
 // Capture real shared-Dart staged execution against the frozen Rust. Only
 // public fixture signatures are replayed; no chain service is connected.
 const tracePath=join(scratch,'public-workflow-traces.json');
 const dart=process.env.TBC_DART??'/private/tmp/tbc-kit7-compute-integration.vw447P/flutter-sdk/bin/dart';
 await run(dart,['test','test/workflow_execution_test.dart','--name','record public native workflow traces','--reporter','expanded'],{...opts,env:{...process.env,TBC_WORKFLOW_TRACE_OUTPUT:tracePath}});
 const traceBytes=await readFile(tracePath),trace=JSON.parse(traceBytes);
 assert.equal(trace.status,'OFFLINE_PUBLIC_EXECUTOR_TRACE');assert.equal(trace.library.sha256,library.sha256);assert.equal(trace.cases.length,3);
 // Refresh only review/receipt deadlines, after compilation. Transaction
 // bytes, digests, signatures and exact frozen Engine outputs stay untouched.
 const now=new Date(),expiry=new Date(+now+120000).toISOString();
 for(const c of cases){c.now=now.toISOString();const p=c.audit.plan.payload;p.expiresAt=expiry;p.review.payload.expiresAt=expiry;p.review.reviewHash=hash(p.review.payload);p.task.reviewHash=p.review.reviewHash;c.audit.plan.planHash=hash(p);c.packet.review=p.review;const b=c.audit.binding.payload;b.expiresAt=expiry;b.operationHash=c.audit.plan.planHash;c.audit.binding.bindingHash=hash(b);}
 const workflowOracleBytes=await read('test/fixtures/workflow-planning.json');
 const workflow=structuredClone(JSON.parse(workflowOracleBytes).cases.find(c=>c.name==='reviewed-then-message'));assert(workflow);
 workflow.request.expiresAt=expiry;const wp=workflow.plan.payload;wp.expiresAt=expiry;wp.requestHash=hash(workflow.request);
 for(const review of Object.values(workflow.reviews)){review.payload.expiresAt=expiry;review.reviewHash=hash(review.payload);}
 for(const task of wp.reviewedTransactionTasks)task.reviewHash=workflow.reviews[task.taskId.slice('review-'.length)].reviewHash;
 workflow.plan.workflowPlanHash=hash(wp);const wb=workflow.binding.payload;wb.requestHash=wp.requestHash;wb.expiresAt=expiry;wb.operationHash=workflow.plan.workflowPlanHash;workflow.binding.bindingHash=hash(wb);
 const fixture=join(scratch,'public-actual-compute.json');await writeFile(fixture,JSON.stringify({cases,workflow,workflowTraces:trace.cases}),{flag:'wx'});
 const executed=await Promise.all([
  run(join(scratch,'swift-check'),[fixture],opts),
  run(join(java,'bin/java'),['-Djava.library.path='+scratch,'-cp',[join(scratch,'classes'),compiler[1],json,androidJar].join(':'),'io.tbc.kit.dart.ReviewedComputeCheckKt',fixture],opts)
 ]);
 const checks=executed.map(r=>JSON.parse(r.stdout));for(const c of checks){assert.equal(c.status,'PASS');assert.equal(c.cases,7);assert.equal(c.workflowReceiptCases,1);assert.equal(c.workflowInterruptedCases,1);assert.equal(c.workflowTraceCases,3);assert.equal(c.workflowSteps,6);assert.equal(c.workflowAdvances,3);assert.equal(c.workflowReplayedSignatures,17);assert.equal(c.workflowRecoverableFailures,1);}assert.equal(checks[0].checks,checks[1].checks);
 const files=[...swift,...kotlin,'platform/native/reviewed_compute.h','platform/native/reviewed_compute.cpp','platform/native/module.modulemap','platform/android/src/main/cpp/reviewed-jni.cpp','test/native/ReviewedComputeCheck.swift','test/native/ReviewedComputeCheck.kt','test/workflow_execution_test.dart','lib/src/internal/workflow_executor.dart','lib/src/internal/workflow_plan.dart','lib/src/internal/workflow_request.dart','lib/src/internal/workflow_json.dart','lib/src/internal/signing_stages.dart','lib/src/internal/native_wallet_binding.dart','lib/src/internal/provider_control.dart','lib/src/internal/provider_session.dart','test/native_wallet_binding_test.dart','tool/check_reviewed_native_compute.mjs'];
 const sourceHashes={};for(const p of files)sourceHashes[p]=sha(await read(p));
 const header='packages/tbc-engine/rust/crates/tbc-keyless-native/include/tbc_keyless.h';
 const report={status:'F3_WORKFLOW_STAGED_AND_FAILURE_NATIVE_TRACE_PASS',recordedAt:new Date().toISOString(),parent:{path:parentPath,sha256:sha(parentBytes)},changedSinceParent,sourceHashes,library,artifact,header:{path:header,sha256:sha(await readFile(join(repo,header)))},oracle:{path:oraclePath,sha256:sha(oracleBytes)},workflowOracle:{path:'test/fixtures/workflow-planning.json',sha256:sha(workflowOracleBytes)},executorTrace:{sha256:sha(traceBytes),cases:trace.cases.map(c=>({name:c.name,reads:c.reads,preparations:c.preparations}))},provenance,checks,warnings:[cpp,...results].map(r=>r.stderr).filter(Boolean),scratch,
  limits:['Actual frozen Rust prepare/finalize through Swift C ABI and Kotlin JNI, with native custody, owner callbacks and delivery fencing, runs on the macOS host, not installed mobile devices.','Signatures are public fixture replay; this is not newly generated Vault signing, script-VM/chain validation, performance or package delivery.','Three real shared-Dart executor traces replay staged FT, Reviewed and one recoverable signer failure through native continuation/completion and exact WebView delivery. Native derives the failed/skipped rows independently. Only ephemeral approvalId is rebound; transaction bytes/digests stay unchanged. Candidate Provider workflow routes are now wired; paired installed-device acceptance is still pending and is not proved by this native host trace.'],chainHttp:0,broadcasts:0,frozenRustModified:false,acceptedDeliveryChanged:false,goalComplete:false};
 const bytes=JSON.stringify(report,null,2)+'\n';if(output)await writeFile(resolve(base,output),bytes,{flag:'wx'});
 console.log(JSON.stringify({status:report.status,checks,warnings:report.warnings,sha256:sha(bytes),scratch}));
}catch(e){console.error(JSON.stringify({status:'FAIL',code:e.code,message:e.stderr?undefined:e.message,stderr:e.stderr?.slice(-6500),stdout:e.stdout?.slice(-1000),scratch}));process.exitCode=1;}
