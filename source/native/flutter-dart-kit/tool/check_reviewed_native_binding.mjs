// Compile and compare both native binding strategies against frozen Core/WASM.
// Does not install, enable public routing, use a Vault, or perform HTTP.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,readdir,mkdtemp,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {homedir,tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
const run=promisify(execFile),base=resolve(import.meta.dirname,'..'),output=process.argv[2];
const sha=b=>createHash('sha256').update(b).digest('hex'),read=p=>readFile(join(base,p));
const parentPath='evidence/f3-reviewed-signing-source.json',parentBytes=await read(parentPath),parent=JSON.parse(parentBytes);
assert.equal(sha(parentBytes),'ec8a7c7b76ca3d6f3cb16c64c95893268d637896cbca7f40e436195e6ad2bac7');
const changes={};
for(const [p,h]of Object.entries(parent.sourceHashes)){
 const actual=sha(await read(p));
 if(p==='lib/src/internal/native_wallet_binding.dart')changes[p]={before:h,after:actual,reason:'Forward optional trusted review/private stage on existing native channel; ordinary packet shape unchanged.'};
 else assert.equal(actual,h,p);
}
const oracle=JSON.parse(await read('test/fixtures/reviewed-signing.json'));
const scratch=await mkdtemp(join(tmpdir(),'tbc-dart-reviewed-native-'));
const provenance={},cache=new Map();
async function fixture(p){if(!cache.has(p)){const bytes=await read('test/fixtures/'+p);provenance[p]=sha(bytes);cache.set(p,JSON.parse(bytes));}return cache.get(p);}
const cases=[];
for(const sample of oracle.cases){
 const source=(await fixture(sample.source.file)).cases.find(c=>c.name===sample.source.name);assert(source);
 const material=source.material,policy=sample.audit.plan.payload.task.policyMaterial,previous=[];
 const stages=source.stages.map(({stage,signatures,finalized},index)=>{
  const prepare={format:material.format,request:material.request,publicKey:sample.account.publicKey,transactionIndex:index,previousTransactions:material.format==='associated'?[...previous]:[],resolvedOutputs:policy.resolvedOutputs};
  const tasks=stage.signingInputIndexes.map((vin,i)=>({taskId:`review-single-tx-${index}-input-${vin}`,purpose:'transaction',algorithm:'secp256k1-ecdsa-sha256d',digest:stage.digests[i],signatureEncoding:'compact64',sighashType:65,transactionTemplateId:`review-tx-${index}`,inputIndex:vin,accountId:sample.account.accountId,publicKey:sample.account.publicKey}));
  previous.push(finalized.txraw);return {prepare,stage,tasks,signatures,finalized};
 });
 cases.push({...sample,packet:{kind:'reviewed',material,policyMaterial:policy,review:sample.audit.plan.payload.review,stage:stages[0].stage},stages});
}
const normalizationCases=[];
for(const file of ['reviewed-associated-holder.json','reviewed-associated-contract.json']){
 for(const c of (await fixture(file)).cases)normalizationCases.push({name:c.name,request:c.request,material:c.material});
}
const preparedPath=join(scratch,'public-binding-fixture.json');
await writeFile(preparedPath,JSON.stringify({cases,normalizationCases}),{flag:'wx'});
// Native custody uses its real clock. Refresh only review/binding deadlines and
// their enclosing hashes; frozen transaction material, stages and signatures stay exact.
const canonical=v=>v===null?'null':Array.isArray(v)?'['+v.map(canonical).join(',')+']':typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
const hash=v=>sha(canonical(v)),fresh=structuredClone(cases),now=new Date(),expiry=new Date(+now+120000).toISOString();
for(const c of fresh){c.now=now.toISOString();const p=c.audit.plan.payload;p.expiresAt=expiry;p.review.payload.expiresAt=expiry;p.review.reviewHash=hash(p.review.payload);p.task.reviewHash=p.review.reviewHash;c.audit.plan.planHash=hash(p);c.packet.review=p.review;const b=c.audit.binding.payload;b.expiresAt=expiry;b.operationHash=c.audit.plan.planHash;c.audit.binding.bindingHash=hash(b);}
const custodyPath=join(scratch,'public-custody-fixture.json');await writeFile(custodyPath,JSON.stringify({cases:fresh}),{flag:'wx'});
const java=process.env.JAVA_HOME??(await run('/usr/libexec/java_home',[])).stdout.trim();
const android=process.env.ANDROID_HOME??join(homedir(),'Library/Android/sdk');
const gradle=process.env.TBC_GRADLE_CACHE??join(homedir(),'.gradle/caches/modules-2/files-2.1');
async function jar(group,name,version){const root=join(gradle,group,name,version),hits=[];for(const d of await readdir(root,{withFileTypes:true}))if(d.isDirectory())for(const f of await readdir(join(root,d.name)))if(f===`${name}-${version}.jar`)hits.push(join(root,d.name,f));assert.equal(hits.length,1);return hits[0];}
const compiler=await Promise.all([
 ['org.jetbrains.kotlin','kotlin-compiler-embeddable','2.1.20'],['org.jetbrains.kotlin','kotlin-stdlib','2.1.20'],
 ['org.jetbrains.kotlin','kotlin-script-runtime','2.1.20'],['org.jetbrains.kotlin','kotlin-daemon-embeddable','2.1.20'],
 ['org.jetbrains.kotlin','kotlin-reflect','1.6.10'],['org.jetbrains.intellij.deps','trove4j','1.0.20200330'],
 ['org.jetbrains','annotations','13.0'],['org.jetbrains.kotlinx','kotlinx-coroutines-core-jvm','1.8.1']].map(v=>jar(...v)));
const json=await jar('org.json','json','20240303'),androidJar=join(android,'platforms/android-36/android.jar');
const sdk=(await run('/usr/bin/xcrun',['--sdk','macosx','--show-sdk-path'])).stdout.trim();
const names=['NativePermissions','NativePrepared','NativeCustody','NativeWorkflow','NativeReviewed','NativeWalletHost','NativeCrypto'];
const swift=names.map(n=>`platform/ios/Classes/${n}.swift`),kotlin=names.map(n=>`platform/android/src/main/kotlin/io/tbc/kit/dart/${n}.kt`);
const opts={cwd:base,maxBuffer:2**20,timeout:120000};
try{
 const compiled=await Promise.all([
  run('/usr/bin/xcrun',['swiftc','-sdk',sdk,'-swift-version','6','-parse-as-library',...swift,'test/native/ReviewedBindingCheck.swift','-o',join(scratch,'reviewed-check')],opts),
  run('/usr/bin/xcrun',['swiftc','-sdk',sdk,'-swift-version','6','-parse-as-library',...swift,'test/native/ReviewedCustodyCheck.swift','-o',join(scratch,'reviewed-custody')],opts),
  run('/usr/bin/xcrun',['swiftc','-sdk',sdk,'-swift-version','6','-parse-as-library',...swift,'test/native/CustodyCheck.swift','-o',join(scratch,'existing-custody')],opts),
  run(join(java,'bin/java'),['-cp',compiler.join(':'),'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler','-no-stdlib','-no-reflect','-jvm-target','17','-classpath',[compiler[1],compiler[6],json,androidJar].join(':'),'-d',join(scratch,'classes'),...kotlin,'test/native/ReviewedBindingCheck.kt','test/native/ReviewedCustodyCheck.kt','test/native/CustodyCheck.kt'],opts)
 ]);
 const executed=await Promise.all([
  run(join(scratch,'reviewed-check'),[preparedPath],opts),
  run(join(java,'bin/java'),['-cp',[join(scratch,'classes'),compiler[1],json,androidJar].join(':'),'io.tbc.kit.dart.ReviewedBindingCheckKt',preparedPath],opts)
 ]);
 const custody=await Promise.all([
  run(join(scratch,'reviewed-custody'),[custodyPath],opts),
  run(join(java,'bin/java'),['-cp',[join(scratch,'classes'),compiler[1],json,androidJar].join(':'),'io.tbc.kit.dart.ReviewedCustodyCheckKt',custodyPath],opts)
 ]);
 const custodyResults=custody.map(r=>JSON.parse(r.stdout));for(const r of custodyResults)assert.equal(r.status,'PASS');assert.equal(custodyResults[0].checks,custodyResults[1].checks);
 const regression=[];
 for(const [file,mode]of [['prepared-signing.json','prepared'],['typed-signing.json','typed'],['signing/replay.json',null]]){
  const args=[join(base,'test/fixtures',file),...(mode?[mode]:[])];
  const pair=await Promise.all([
   run(join(scratch,'existing-custody'),args,opts),
   run(join(java,'bin/java'),['-cp',[join(scratch,'classes'),compiler[1],json,androidJar].join(':'),'io.tbc.kit.dart.CustodyCheckKt',...args],opts)
  ]);
  const r=pair.map(v=>JSON.parse(v.stdout));for(const x of r)assert.equal(x.status,'PASS');assert.equal(r[0].checks,r[1].checks);regression.push({file,results:r});
 }
 const results=executed.map(r=>JSON.parse(r.stdout));for(const r of results){assert.equal(r.status,'PASS');assert.equal(r.cases,7);}assert.equal(results[0].checks,results[1].checks);
 const sourceHashes={};for(const p of [...swift,...kotlin,'lib/src/internal/native_wallet_binding.dart','test/native/ReviewedBindingCheck.swift','test/native/ReviewedBindingCheck.kt','test/native/ReviewedCustodyCheck.swift','test/native/ReviewedCustodyCheck.kt','tool/check_reviewed_native_binding.mjs'])sourceHashes[p]=sha(await read(p));
 const report={status:'F3_REVIEWED_NATIVE_CUSTODY_REPLAY_PASS',recordedAt:new Date().toISOString(),parent:{path:parentPath,sha256:sha(parentBytes)},sourceHashes,changes,provenance,results,custodyResults,regression,normalizationCases:normalizationCases.length,warnings:compiled.map(r=>r.stderr).filter(Boolean),scratch,
  limits:['Existing native operation state, one consent/receipt, async compute/cancellation and signed-parent staging are replayed. Public Provider and installed Apps remain disabled.','Native compute adapter is an injected port; keyless stages and signatures are pinned frozen replay, not newly invoked Swift/JNI Rust or production Vault.','No device, performance, size or chain acceptance.'],acceptedDeliveryChanged:false,chainHttp:0,broadcasts:0,goalComplete:false};
 const bytes=JSON.stringify(report,null,2)+'\n';if(output)await writeFile(resolve(base,output),bytes,{flag:'wx'});
 console.log(JSON.stringify({status:report.status,results,custodyResults,regression,normalizationCases:report.normalizationCases,warnings:report.warnings,sha256:sha(bytes),scratch}));
}catch(e){console.error(JSON.stringify({status:'FAIL',message:e.message,stderr:e.stderr?.slice(-9000),stdout:e.stdout?.slice(-1000),scratch}));process.exitCode=1;}
