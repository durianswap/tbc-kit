// Compile both binding strategies with the real single-call native normalizer.
// Regress existing single custody; no workflow custody/key/device/chain claim.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,readdir,mkdtemp,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {homedir,tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
const run=promisify(execFile),base=resolve(import.meta.dirname,'..'),output=process.argv[2];
const sha=b=>createHash('sha256').update(b).digest('hex'),read=p=>readFile(join(base,p));
const canonical=v=>v===null?'null':Array.isArray(v)?'['+v.map(canonical).join(',')+']':typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
const hash=v=>sha(canonical(v));
const oracleBytes=await read('test/fixtures/workflow-planning.json'),oracle=JSON.parse(oracleBytes);
const signingBytes=await read('test/fixtures/workflow-signing.json'),signing=JSON.parse(signingBytes);
assert.equal(signing.planningSha256,sha(oracleBytes));
const parentPath='evidence/f3-workflow-worker-source-a.json',parentBytes=await read(parentPath);
assert.equal(sha(parentBytes),'7102c46f20bb89c9eea71482d31bbab560fb50b9bdb17e4d0d3e7cf749fa69ed');
const changes={},normalizerFiles=new Set(['platform/ios/Classes/NativeCustody.swift','platform/android/src/main/kotlin/io/tbc/kit/dart/NativeCustody.kt','platform/ios/Classes/NativePermissions.swift','platform/android/src/main/kotlin/io/tbc/kit/dart/NativePermissions.kt','platform/ios/Classes/NativePrepared.swift','platform/android/src/main/kotlin/io/tbc/kit/dart/NativePrepared.kt','platform/ios/Classes/NativeReviewed.swift','platform/android/src/main/kotlin/io/tbc/kit/dart/NativeReviewed.kt','platform/ios/Classes/NativeWalletHost.swift','platform/android/src/main/kotlin/io/tbc/kit/dart/NativeWalletHost.kt','lib/src/internal/workflow_executor.dart','test/workflow_execution_test.dart']);
normalizerFiles.add('lib/src/internal/native_wallet_binding.dart');
// The shared Reviewed child now commits the same full single-call request as
// native custody. Public workflow plan/task/result commitments stay unchanged.
normalizerFiles.add('lib/src/internal/workflow_plan.dart');
normalizerFiles.add('test/workflow_plan_test.dart');
for(const p of ['lib/src/internal/provider_control.dart','lib/src/internal/provider_session.dart','test/native_wallet_binding_test.dart'])normalizerFiles.add(p);
// Provider supplies the same wallet policy per normalized transaction child.
// Keep the pinned executor/crypto references checked; allow only these reviewed
// worker changes and the test reader's shared native/Prepared fixture lookup.
normalizerFiles.add('lib/src/internal/signing_worker.dart');
normalizerFiles.add('test/workflow_worker_test.dart');
for(const [p,h]of Object.entries(JSON.parse(parentBytes).sourceHashes)){
 const actual=sha(await read(p));
 if(normalizerFiles.has(p))changes[p]={before:h,after:actual,reason:'Integrate native batch grants, bounded consent and one parent receipt using existing family verification. Reviewed tasks use pinned native computation. Step execution/delivery remain gated.'};
 else assert.equal(actual,h,p);
}
const valid=[],invalid=[];
for(const source of oracle.cases){
 const c=structuredClone(source),p=c.plan.payload;
 c.permissions=[...new Set(['tbc_signWorkflow',...c.request.steps.map(s=>['transaction','preparedTransaction','reviewedTransaction'].includes(s.kind)?'tbc_signTransaction':s.kind==='message'?'tbc_signMessage':s.kind==='typedData'?'tbc_signTypedData':'tbc_crypto')])];
 if(c.request.steps.some(s=>['encrypt','decrypt'].includes(s.kind))){invalid.push({label:'crypto is not native-enabled yet',sample:c});continue;}
 valid.push(c);
 function bad(label,change,recommit=false){const s=structuredClone(c);change(s);if(recommit){s.plan.workflowPlanHash=hash(s.plan.payload);s.binding.payload.operationHash=s.plan.workflowPlanHash;s.binding.bindingHash=hash(s.binding.payload);}invalid.push({label:`${c.name}: ${label}`,sample:s});}
 bad('binding method changed',s=>{s.binding.payload.method='tbc_signMessage';s.binding.bindingHash=hash(s.binding.payload);});
 bad('binding context changed',s=>{s.context.sessionId='other-session';});
 bad('missing context origin',s=>{delete s.context.origin;delete s.context.topOrigin;});
 bad('frame changed',s=>{s.context.frame='child';});
 bad('request network changed',s=>{s.request.chainId='tbc:mainnet';});
 bad('preview drift',s=>{s.preview.totalFee='999';});
 bad('rehashed total fee drift',s=>{s.plan.payload.totalFee='999';},true);
 bad('rehashed execution order drift',s=>{s.plan.payload.stepOrder.reverse();},true);
 bad('rehashed task removal or injection',s=>{s.plan.payload.immediateSigningTasks=s.plan.payload.immediateSigningTasks.length?[]:[{stepId:'unknown',task:{}}];},true);
 bad('expired at deadline',s=>{s.now=s.plan.payload.expiresAt;});
 bad('extra sensitive step field',s=>{s.request.steps[0].privateKey='invalid-test-field';});
 bad('duplicate step identity',s=>{s.request.steps[1].id=s.request.steps[0].id;});
 bad('forward or unknown dependency',s=>{s.request.steps[0].dependsOn=['not-earlier'];});
 if(p.transactionPlans.length){
  bad('rehashed child request hash drift',s=>{const child=s.plan.payload.transactionPlans[0].plan;child.payload.requestHash='0'.repeat(64);child.planHash=hash(child.payload);},true);
  bad('rehashed unselected task account',s=>{
   const child=s.plan.payload.transactionPlans[0].plan;child.payload.signingTasks[0].accountId='unselected';child.planHash=hash(child.payload);
   s.plan.payload.immediateSigningTasks[0].task.accountId='unselected';
  },true);
 }
 if(p.deferredSigningTasks.length)bad('rehashed deferred source changed',s=>{s.plan.payload.deferredSigningTasks[0].source.output='artifacts.contractId';},true);
 if(p.reviewedTransactionTasks.length)bad('review consent not available',s=>{s.reviews={};});
 if(c.accounts.length>1)bad('controller not selected',s=>{s.accounts=s.accounts.slice(0,1);});
}
assert.equal(valid.length,9);
const scratch=await mkdtemp(join(tmpdir(),'tbc-dart-workflow-binding-')),fixture=join(scratch,'public-binding.json');
await writeFile(fixture,JSON.stringify({valid,invalid}),{flag:'wx'});
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
const names=['NativePermissions','NativePrepared','NativeReviewed','NativeCustody','NativeWalletHost','NativeWorkflow','NativeCrypto'];
const swift=names.map(n=>`platform/ios/Classes/${n}.swift`),kotlin=names.map(n=>`platform/android/src/main/kotlin/io/tbc/kit/dart/${n}.kt`);
const opts={cwd:base,maxBuffer:2**20,timeout:120000};
try{
 const compiled=await Promise.all([
  run('/usr/bin/xcrun',['swiftc','-sdk',sdk,'-swift-version','6','-parse-as-library',...swift,'test/native/WorkflowBindingCheck.swift','-o',join(scratch,'workflow-check')],opts),
  run('/usr/bin/xcrun',['swiftc','-sdk',sdk,'-swift-version','6','-parse-as-library',...swift,'test/native/CustodyCheck.swift','-o',join(scratch,'custody-check')],opts),
  run('/usr/bin/xcrun',['swiftc','-sdk',sdk,'-swift-version','6','-parse-as-library',...swift,'test/native/WorkflowConsentCheck.swift','-o',join(scratch,'consent-check')],opts),
  // Match Flutter 3.29's default Kotlin language level, not only the newer
  // standalone compiler. Device builds remain a separate required proof.
  run(join(java,'bin/java'),['-cp',compiler.join(':'),'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler','-language-version','1.8','-api-version','1.8','-no-stdlib','-no-reflect','-jvm-target','17','-classpath',[compiler[1],compiler[6],json,androidJar].join(':'),'-d',join(scratch,'classes'),...kotlin,'test/native/WorkflowBindingCheck.kt','test/native/CustodyCheck.kt','test/native/WorkflowConsentCheck.kt'],opts)
 ]);
 const executed=await Promise.all([
  run(join(scratch,'workflow-check'),[fixture],opts),
  run(join(java,'bin/java'),['-cp',[join(scratch,'classes'),compiler[1],json,androidJar].join(':'),'io.tbc.kit.dart.WorkflowBindingCheckKt',fixture],opts)
 ]);
 const results=executed.map(r=>JSON.parse(r.stdout));for(const r of results){assert.equal(r.status,'PASS');assert.equal(r.cases,9);assert.equal(r.negativeCases,invalid.length);}assert.equal(results[0].checks,results[1].checks);
 // The custody owner uses its real clock. Refresh only offline deadlines and
 // their enclosing commitments, never transaction bytes/digests/fee semantics.
 const consentCases=structuredClone(valid),now=new Date().toISOString(),expiry=new Date(Date.now()+240000).toISOString();
 for(const c of consentCases){
  if(c.request.expiresAt)c.request.expiresAt=expiry;
  for(const s of c.request.steps)if(s.proposal){const p=s.proposal.payload;p.createdAt=now;p.expiresAt=expiry;p.evidence.observedAt=now;s.proposal.proposalHash=hash(p);}
  for(const review of Object.values(c.reviews)){review.payload.expiresAt=expiry;review.reviewHash=hash(review.payload);}
  for(const entry of c.plan.payload.transactionPlans){entry.plan.payload.expiresAt=expiry;entry.plan.planHash=hash(entry.plan.payload);}
  for(const task of c.plan.payload.reviewedTransactionTasks){const id=task.taskId.slice('review-'.length);task.reviewHash=c.reviews[id].reviewHash;}
  c.plan.payload.requestHash=hash(c.request);c.plan.payload.expiresAt=expiry;c.plan.workflowPlanHash=hash(c.plan.payload);
  c.binding.payload.requestHash=hash(c.request);c.binding.payload.expiresAt=expiry;c.binding.payload.operationHash=c.plan.workflowPlanHash;c.binding.bindingHash=hash(c.binding.payload);
  if(Object.keys(c.reviews).length)c.consentReview={kind:'workflow',steps:Object.entries(c.reviews).map(([stepId,review])=>({stepId,review})),prepared:{workflowPlanHash:c.plan.workflowPlanHash,totalFee:c.plan.payload.totalFee}};
 }
 const htlcBytes=await read('test/fixtures/htlc-token-signing.json'),htlc=JSON.parse(htlcBytes).cases.find(c=>c.request.intent.type==='tbc-htlc-claim');assert(htlc);
 const receiptVariants=[];
 function recommit(c){
  for(const entry of c.plan.payload.transactionPlans)entry.plan.planHash=hash(entry.plan.payload);
  c.plan.payload.requestHash=hash(c.request);c.plan.workflowPlanHash=hash(c.plan.payload);
  c.binding.payload.requestHash=hash(c.request);c.binding.payload.operationHash=c.plan.workflowPlanHash;c.binding.bindingHash=hash(c.binding.payload);
 }
 for(const understate of [false,true]){
  const c=structuredClone(consentCases.find(c=>c.name==='native-message'));
  delete c.request.maxTotalFee;c.plan.payload.maxTotalFee=c.plan.payload.totalFee;recommit(c);
  c.consentReview={kind:'workflow',steps:[],prepared:{workflowPlanHash:c.plan.workflowPlanHash,totalFee:understate?'0':c.plan.payload.totalFee}};
  receiptVariants.push({label:understate?'unbounded fee consent underestimated':'unbounded fee exact prepared commitment',accept:!understate,sample:c});
 }
 {
  const c=structuredClone(consentCases.find(c=>c.name==='prepared-typed')),tx=c.plan.payload.transactionPlans[0].plan.payload.transactions[0];
  tx.unsignedTransaction=tx.unsignedTransaction.slice(0,-1)+(tx.unsignedTransaction.endsWith('0')?'1':'0');recommit(c);
  receiptVariants.push({label:'rehashed Prepared transaction differs from approved proposal',accept:false,sample:c});
 }
 {
  const c=structuredClone(consentCases.find(c=>c.name==='native-message')),task=c.plan.payload.transactionPlans[0].plan.payload.signingTasks[0];
  task.signatureEncoding='DER';c.plan.payload.immediateSigningTasks[0].task.signatureEncoding='DER';recommit(c);
  receiptVariants.push({label:'rehashed child task fails shared family encoding validation',accept:false,sample:c});
 }
 consentCases.push({name:'token-htlc-secret-free-consent',method:'tbc_signWorkflow',account:htlc.account,accounts:[htlc.account],context:htlc.context,request:{version:'1.0',chainId:htlc.account.chainId,from:htlc.account.address,maxTotalFee:'100000000',steps:[{id:'claim',kind:'transaction',dependsOn:[],intent:htlc.request.intent,constraints:htlc.request.constraints}]},mustNotRender:htlc.request.intent.preimage});
 // Exercise immediate and dependent-message child paths. Staged/Reviewed
 // workflow execution retain separate explicit coverage, not inferred here.
 const stepCases=[];
 for(const signed of signing.cases){
  if(['staged-ft-primary','reviewed-then-message'].includes(signed.name))continue;
  const sample=consentCases.find(c=>c.name===signed.name);assert(sample);
  const steps=[];
  for(const s of sample.request.steps){
   steps.push(signed.result.steps.find(r=>r.id===s.id));
  }
  assert(steps.length);stepCases.push({sample,signed:signed.signed,steps,deferred:signed.deferred,result:signed.result});
 }
 assert.equal(stepCases.length,7);
 const jsonBytes=await read('test/fixtures/workflow-json.json'),jsonCases=JSON.parse(jsonBytes).cases;
 const consentFixture=join(scratch,'public-consent.json');await writeFile(consentFixture,JSON.stringify({cases:consentCases,receiptVariants,stepCases,jsonCases}),{flag:'wx'});
 const consentPair=await Promise.all([
  run(join(scratch,'consent-check'),[consentFixture],opts),
  run(join(java,'bin/java'),['-cp',[join(scratch,'classes'),compiler[1],json,androidJar].join(':'),'io.tbc.kit.dart.WorkflowConsentCheckKt',consentFixture],opts)
 ]);
 const consentResults=consentPair.map(r=>JSON.parse(r.stdout));for(const r of consentResults){assert.equal(r.status,'PASS');assert.equal(r.signatures,0);assert.equal(r.cases,10);assert.equal(r.receiptCases,8);assert.equal(r.receiptVariants,4);assert.equal(r.stepCases,7);assert.equal(r.completedSteps,17);assert.equal(r.jsonCases,23);assert.equal(r.failureCases,6);}assert.equal(consentResults[0].checks,consentResults[1].checks);
 const regression=[];
 for(const [file,mode]of [['prepared-signing.json','prepared'],['typed-signing.json','typed'],['signing/replay.json',null]]){
  const args=[join(base,'test/fixtures',file),...(mode?[mode]:[])];
  const pair=await Promise.all([
   run(join(scratch,'custody-check'),args,opts),
   run(join(java,'bin/java'),['-cp',[join(scratch,'classes'),compiler[1],json,androidJar].join(':'),'io.tbc.kit.dart.CustodyCheckKt',...args],opts)
  ]);
  const results=pair.map(r=>JSON.parse(r.stdout));for(const r of results)assert.equal(r.status,'PASS');assert.equal(results[0].checks,results[1].checks);regression.push({file,results});
 }
 const sourceHashes={};for(const p of [...swift,...kotlin,'test/native/WorkflowBindingCheck.swift','test/native/WorkflowBindingCheck.kt','test/native/WorkflowConsentCheck.swift','test/native/WorkflowConsentCheck.kt','test/native/CustodyCheck.swift','test/native/CustodyCheck.kt','lib/src/internal/workflow_executor.dart','lib/src/internal/native_wallet_binding.dart','lib/src/internal/provider_control.dart','lib/src/internal/provider_session.dart','test/native_wallet_binding_test.dart','test/workflow_execution_test.dart','tool/check_workflow_native_binding.mjs'])sourceHashes[p]=sha(await read(p));
 const report={status:'F3_WORKFLOW_NATIVE_FAILURE_PROVENANCE_PASS',recordedAt:new Date().toISOString(),
  parent:{path:parentPath,sha256:sha(parentBytes)},changes,sourceHashes,oracleSha256:sha(oracleBytes),fixtureSha256:sha(await readFile(fixture)),
  results,consentResults,regression,signingOracleSha256:sha(signingBytes),jsonOracleSha256:sha(jsonBytes),consentFixtureSha256:sha(await readFile(consentFixture)),htlcOracleSha256:sha(htlcBytes),warnings:compiled.map(r=>r.stderr).filter(Boolean),scratch,
  limits:['Whole-batch binding uses the actual shared native normalizer and native message digest. Existing per-family execution verification is still required.',
   'Native one-consent/receipt and seventeen steps of seven workflows pass with public signature replay, including completed-source binding and exact result permits. Six failure cases cover continue-independent, atomic, lock, cancel, opaque and forged errors; only a typed signer callback can fail a child and skip dependencies. Staged/Reviewed traces are checked separately. Actual WebView emission/Provider routes/device/chain/performance/size are not proved by this check.',
   'Crypto steps remain explicitly gated; the full final goal remains active.'],
  chainHttp:0,broadcasts:0,acceptedDeliveryChanged:false,goalComplete:false,published:false};
 const bytes=JSON.stringify(report,null,2)+'\n';if(output)await writeFile(resolve(base,output),bytes,{flag:'wx'});
 console.log(JSON.stringify({status:report.status,results,consentResults,regression,warnings:report.warnings,sha256:sha(bytes),scratch}));
}catch(e){console.error(JSON.stringify({status:'FAIL',message:e.message,stderr:e.stderr?.slice(-8000),stdout:e.stdout?.slice(-800),scratch}));process.exitCode=1;}
