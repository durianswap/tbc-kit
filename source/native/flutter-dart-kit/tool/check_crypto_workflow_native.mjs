// Compile affected native hosts, using the immutable standalone proof's exact
// sources and cached toolchain. No mobile framework or real Vault claim.
import assert from 'node:assert/strict';
import {readFile,writeFile,readdir,mkdtemp} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {resolve,join} from 'node:path';
import {homedir,tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
const run=promisify(execFile),base=resolve(import.meta.dirname,'..'),output=process.argv[2];assert(output);
const sha=b=>createHash('sha256').update(b).digest('hex');
const canonical=v=>JSON.stringify(v,(_,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
const hash=v=>sha(canonical(v));
const parentPath='evidence/f3-bie1-native-custody-c.json',parentBytes=await readFile(join(base,parentPath)),parent=JSON.parse(parentBytes);
assert.equal(sha(parentBytes),'299080312178ca5d400702838a670f9102453cc2e07ca93f570e22043328afc3');
for(const [p,h]of Object.entries(parent.sourceHashes))assert.equal(sha(await readFile(join(base,p))),h,p);
const oraclePath='test/fixtures/crypto-workflow.json',bytes=await readFile(join(base,oraclePath)),oracle=JSON.parse(bytes);
assert.equal(sha(bytes),'be69533af3b37464b048a9d811998f2d961869427d39e004db8216ddb8b1bc1e');
const scratch=await mkdtemp(join(tmpdir(),'tbc-dart-crypto-workflow-')),opts={cwd:base,maxBuffer:2**20,timeout:120000};
const names=['NativePermissions','NativePrepared','NativeReviewed','NativeCustody','NativeWorkflow','NativeWalletHost','NativeCrypto'];
const swift=names.map(n=>'platform/ios/Classes/'+n+'.swift'),kotlin=names.map(n=>'platform/android/src/main/kotlin/io/tbc/kit/dart/'+n+'.kt');
const gradle=join(homedir(),'.gradle/caches/modules-2/files-2.1');
async function jar(g,n,v){const root=join(gradle,g,n,v),hits=[];for(const d of await readdir(root,{withFileTypes:true}))if(d.isDirectory())for(const f of await readdir(join(root,d.name)))if(f===`${n}-${v}.jar`)hits.push(join(root,d.name,f));assert.equal(hits.length,1);return hits[0];}
const java='/Users/alex/Library/Java/JavaVirtualMachines/temurin-17.jdk/Contents/Home/bin/java';
const compiler=await Promise.all([['org.jetbrains.kotlin','kotlin-compiler-embeddable','2.1.20'],['org.jetbrains.kotlin','kotlin-stdlib','2.1.20'],['org.jetbrains.kotlin','kotlin-script-runtime','2.1.20'],['org.jetbrains.kotlin','kotlin-daemon-embeddable','2.1.20'],['org.jetbrains.kotlin','kotlin-reflect','1.6.10'],['org.jetbrains.intellij.deps','trove4j','1.0.20200330'],['org.jetbrains','annotations','13.0'],['org.jetbrains.kotlinx','kotlinx-coroutines-core-jvm','1.8.1']].map(v=>jar(...v)));
const json=await jar('org.json','json','20240303'),androidJar=join(homedir(),'Library/Android/sdk/platforms/android-36/android.jar');
const sdk=(await run('/usr/bin/xcrun',['--sdk','macosx','--show-sdk-path'])).stdout.trim();
try{
 const compiled=await Promise.all([
  run('/usr/bin/xcrun',['swiftc','-sdk',sdk,'-swift-version','6','-parse-as-library',...swift,'test/native/CryptoWorkflowCheck.swift','-o',join(scratch,'check')],opts),
  run(java,['-cp',compiler.join(':'),'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler','-language-version','1.8','-api-version','1.8','-no-stdlib','-no-reflect','-jvm-target','17','-classpath',[compiler[1],compiler[6],json,androidJar].join(':'),'-d',join(scratch,'classes'),...kotlin,'test/native/CryptoWorkflowCheck.kt'],opts)
 ]);
 const fresh=structuredClone(oracle.cases.filter(s=>['crypto-pair','crypto-independent-failure'].includes(s.name)));
 const expiry=new Date(Date.now()+240000).toISOString();
 for(const s of fresh){s.request.expiresAt=expiry;s.plan.payload.expiresAt=expiry;s.plan.payload.requestHash=hash(s.request);s.plan.workflowPlanHash=hash(s.plan.payload);s.binding.payload.expiresAt=expiry;s.binding.payload.requestHash=hash(s.request);s.binding.payload.operationHash=s.plan.workflowPlanHash;s.binding.bindingHash=hash(s.binding.payload);s.result.requestHash=hash(s.request);s.result.workflowPlanHash=s.plan.workflowPlanHash;}
 const fixture=join(scratch,'fixture.json');await writeFile(fixture,JSON.stringify({original:oracle.cases,fresh}),{flag:'wx'});
 const pair=await Promise.all([run(join(scratch,'check'),[fixture],opts),run(java,['-cp',[join(scratch,'classes'),compiler[1],json,androidJar].join(':'),'io.tbc.kit.dart.CryptoWorkflowCheckKt',fixture],opts)]);
 const results=pair.map(r=>JSON.parse(r.stdout));for(const r of results)assert.equal(r.status,'PASS');assert.equal(results[0].checks,results[1].checks);
 const sourceHashes={...parent.sourceHashes};for(const p of ['test/native/CryptoWorkflowCheck.swift','test/native/CryptoWorkflowCheck.kt','tool/check_crypto_workflow_native.mjs'])sourceHashes[p]=sha(await readFile(join(base,p)));
 const report={status:'F3_BIE1_WORKFLOW_NATIVE_HOST_PASS',recordedAt:new Date().toISOString(),parent:{path:parentPath,sha256:sha(parentBytes)},oracle:{path:oraclePath,sha256:sha(bytes)},sourceHashes,results,warnings:compiled.map(r=>r.stderr).filter(Boolean),scratch,
  proof:'Four frozen binding comparisons, two crypto-only native workflow executions including native unavailable/skipped/independent continuation. One batch approval, exact active child, native result commitment, replay/task tamper/lock/navigation and no digest fallback. Fixed private dispatch failure classification.',
  limits:['Public replay native callback, not installed mobile, partner Vault, actual BIE1 computation, chain or performance proof. Mixed transaction/crypto execution has shared Dart/Rust proof, but only binding comparison in this native check.'],chainHttp:0,broadcasts:0,goalComplete:false};
 const reportBytes=JSON.stringify(report,null,2)+'\n';await writeFile(resolve(base,output),reportBytes,{flag:'wx'});console.log(JSON.stringify({status:report.status,results,sha256:sha(reportBytes),scratch}));
}catch(e){console.error(JSON.stringify({status:'FAIL',message:e.message?.slice(-1000),stderr:e.stderr?.slice(-9000),stdout:e.stdout?.slice(-2000),scratch}));process.exitCode=1;}
