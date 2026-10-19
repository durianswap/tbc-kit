// Exact send consent/task/result custody with frozen public signature replays.
// Optional actual loopback HTTP; never private keys or real-chain acceptance.
import assert from 'node:assert/strict';
import {readFile,readdir,mkdtemp,writeFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {resolve,join} from 'node:path';
import {homedir} from 'node:os';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
const run=promisify(execFile),base=resolve(import.meta.dirname,'..'),output=process.argv[2];assert(output);
const read=p=>readFile(join(base,p)),sha=b=>createHash('sha256').update(b).digest('hex');
const canonical=v=>v===null?'null':Array.isArray(v)?'['+v.map(canonical).join(',')+']':typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
const hash=v=>sha(canonical(v));
const oracleBytes=await read('test/fixtures/send-lifecycle.json'),oracle=JSON.parse(oracleBytes);
assert.equal(oracle.archiveSha256,'c51e3b63dd1ed2f542d40068450685e314328686d4a3ebab2717491333a478a0');
for(const [p,h]of Object.entries(oracle.provenance))assert.equal(sha(await read(`test/fixtures/${p}.json`)),h);
const workflowBytes=await read('test/fixtures/workflow-signing.json'),workflow=JSON.parse(workflowBytes);
const now=new Date().toISOString(),expiry=new Date(Date.now()+240000).toISOString(),cases=[];
const selected=oracle.cases.filter(c=>c.scenario==='accepted'&&c.source.name!=='reviewed-then-message');assert.equal(selected.length,6);
for(const source of selected){
 const c=structuredClone(source),a=c.audit,replacements=new Map();
 function proposal(r){if(r.proposal){const p=r.proposal.payload;p.createdAt=now;p.expiresAt=expiry;p.evidence.observedAt=now;r.proposal.proposalHash=hash(p);}}
 if(c.request.expiresAt)c.request.expiresAt=expiry;proposal(c.request);for(const s of c.request.steps??[])proposal(s);
 function plan(p){const old=p.planHash;p.payload.expiresAt=expiry;p.planHash=hash(p.payload);replacements.set(old,p.planHash);}
 if(c.workflow){for(const entry of a.plan.payload.transactionPlans)plan(entry.plan);
  a.plan.payload.requestHash=hash(c.request);a.plan.payload.expiresAt=expiry;a.plan.workflowPlanHash=hash(a.plan.payload);
  a.binding.payload.operationHash=a.plan.workflowPlanHash;a.binding.payload.requestHash=hash(c.request);
  a.workflow.requestHash=hash(c.request);a.workflow.workflowPlanHash=a.plan.workflowPlanHash;a.bundle.requestHash=hash(c.request);
 }else{plan(a.plan);a.binding.payload.operationHash=a.plan.planHash;}
 a.binding.payload.expiresAt=expiry;a.binding.bindingHash=hash(a.binding.payload);
 function replacePlan(v){if(typeof v==='string')return replacements.get(v)??v;if(Array.isArray(v))return v.map(replacePlan);if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,replacePlan(x)]));return v;}
 const stages=a.stages.map(replacePlan);
 function txStages(requestHash){return stages.filter(s=>s.requestHash===requestHash).map((s,i,all)=>{
  const tasks=s.args.signatures.map(signature=>{const signed=a.signed.find(row=>canonical(row.result)===canonical(signature));assert(signed);return signed.task;});
  return {tasks,...i>0?{pending:all[i-1].result}:{}};
 });}
 const steps=[];
 if(!c.workflow)steps.push({stages:txStages(a.plan.payload.requestHash)});
 else{
  const reference=workflow.cases.find(x=>x.name===c.source.name);assert(reference);
  for(const row of a.workflow.steps){
   const deferred=reference.deferred.find(d=>d.stepId===row.id)?.resolved;
   const tasks=deferred?[deferred.concreteTask]:a.plan.payload.immediateSigningTasks.filter(t=>t.stepId===row.id).map(t=>t.task);
   const entry={kind:'workflow-step',stepId:row.id,workflowPlanHash:a.plan.workflowPlanHash,tasks,...deferred?{resolvedDeferredSigningTask:deferred}:{}};
   const childPlan=a.plan.payload.transactionPlans.find(p=>p.stepId===row.id)?.plan;
   steps.push({entry,stages:childPlan?txStages(childPlan.payload.requestHash):[{tasks}],outcome:{kind:'workflow-step-outcome',stepId:row.id,workflowPlanHash:a.plan.workflowPlanHash,status:'completed',result:row.result}});
  }
 }
 assert(steps.every(s=>s.stages.length&&s.stages.every(s=>s.tasks.length)));
 cases.push({name:c.name,method:c.method,workflow:c.workflow,accounts:c.accounts,request:c.request,context:c.context,
  plan:a.plan,binding:a.binding,preview:a.preview,bundle:a.bundle,...c.workflow?{result:a.workflow}:{},signed:a.signed,steps,
  permissions:[...new Set(['tbc_sendTransaction',...c.workflow?['tbc_signWorkflow',...c.request.steps.map(s=>s.kind==='message'?'tbc_signMessage':s.kind==='typedData'?'tbc_signTypedData':'tbc_signTransaction')]:[]])]
 });
}
const scratch=await mkdtemp('/private/tmp/tbc-dart-send-custody-'),fixture=join(scratch,'public.json');
// The frozen pre-1.7.3 Prepared set contains a now-rejected AMM lpPlan create.
// Keep that original evidence intact; all other Prepared cases are unchanged.
// Current explicit-fee AMM custody has its own high-level173 paired report.
const preparedBytes=await read('test/fixtures/prepared-signing.json'),prepared=JSON.parse(preparedBytes);
const retiredPrepared=prepared.cases.filter(c=>c.request?.intent?.type==='tbc-amm-create'&&c.request.intent.lpPlan!==undefined);
assert.equal(retiredPrepared.length,1);assert.equal(retiredPrepared[0].name,'amm-create-public');
const currentPrepared=join(scratch,'current-prepared.json');
await writeFile(currentPrepared,JSON.stringify({...prepared,cases:prepared.cases.filter(c=>!retiredPrepared.includes(c))}),{flag:'wx'});
const signOnly=cases.filter(c=>['transfer-single-accepted','prepared-typed-accepted'].includes(c.name)).map(source=>{
 const c=structuredClone(source);c.method=c.method.replace('tbc_send','tbc_sign');c.binding.payload.method=c.method;c.binding.bindingHash=hash(c.binding.payload);
 c.permissions=c.permissions.filter(p=>p!=='tbc_sendTransaction');if(!c.workflow)c.permissions.push('tbc_signTransaction');return c;
});
const sourceBytes=await read('test/fixtures/broadcast-port.json'),sourceOracle=JSON.parse(sourceBytes);
assert.equal(sourceOracle.archiveSha256,oracle.archiveSha256);
const sources=[...new Map(sourceOracle.cases.map(c=>[c.sourceIdentity,{options:c.options,sourceIdentity:c.sourceIdentity}])).values()];
assert.equal(sources.length,3);
await writeFile(fixture,JSON.stringify({cases,signOnly,sources}),{flag:'wx'});
const java=process.env.JAVA_HOME;assert(java);const android=process.env.ANDROID_HOME??join(homedir(),'Library/Android/sdk');
const cache=join(homedir(),'.gradle/caches/modules-2/files-2.1');
async function jar(group,name,version){const root=join(cache,group,name,version),hits=[];for(const d of await readdir(root,{withFileTypes:true}))if(d.isDirectory())for(const f of await readdir(join(root,d.name)))if(f===`${name}-${version}.jar`)hits.push(join(root,d.name,f));assert.equal(hits.length,1);return hits[0];}
const compiler=await Promise.all([
 ['org.jetbrains.kotlin','kotlin-compiler-embeddable','2.1.20'],['org.jetbrains.kotlin','kotlin-stdlib','2.1.20'],
 ['org.jetbrains.kotlin','kotlin-script-runtime','2.1.20'],['org.jetbrains.kotlin','kotlin-daemon-embeddable','2.1.20'],
 ['org.jetbrains.kotlin','kotlin-reflect','1.6.10'],['org.jetbrains.intellij.deps','trove4j','1.0.20200330'],
 ['org.jetbrains','annotations','13.0'],['org.jetbrains.kotlinx','kotlinx-coroutines-core-jvm','1.8.1']].map(v=>jar(...v)));
const json=await jar('org.json','json','20240303'),androidJar=join(android,'platforms/android-36/android.jar');
const names=['NativePermissions','NativePrepared','NativeReviewed','NativeCustody','NativeWalletHost','NativeWorkflow','NativeCrypto','NativeBroadcastStore','NativeBroadcastHTTP','NativeBroadcastDispatch','NativeBroadcastRouter','NativeNetworkSessions','NativeNetworkWalletRouter','NativeProtocolWalletRouter'];
const swift=names.map(n=>`platform/ios/Classes/${n}.swift`),kotlin=names.map(n=>`platform/android/src/main/kotlin/io/tbc/kit/dart/${n}.kt`);
const opts={cwd:base,maxBuffer:4*1024*1024,timeout:120000};
let loopback;
async function dispatchLoopback(){
 const device=process.env.TBC_ANDROID_DEVICE??'emulator-5554';assert(/^emulator-[0-9]+$/.test(device));
 const adb=join(android,'platform-tools/adb'),remote='/data/local/tmp/'+scratch.split('/').at(-1);
 assert.equal((await run(adb,['-s',device,'get-state'],opts)).stdout.trim(),'device');
 await run(join(java,'bin/jar'),['cf',join(scratch,'dispatch.jar'),'-C',join(scratch,'classes'),'.'],opts);
 await run(join(android,'build-tools/36.0.0/d8'),['--lib',androidJar,'--min-api','26','--output',join(scratch,'dispatch-dex.jar'),join(scratch,'dispatch.jar'),compiler[1]],opts);
 await run(adb,['-s',device,'shell','mkdir','-p',remote],opts);
 await run(adb,['-s',device,'push',join(scratch,'dispatch-dex.jar'),remote+'/dispatch.jar'],opts);
 await run(adb,['-s',device,'push',fixture,remote+'/public.json'],opts);
 const trace=[];let platform='setup',port;
 const server=createServer((req,res)=>{
  const chunks=[];req.on('data',b=>chunks.push(b));req.on('error',()=>{});res.on('error',()=>{});
  req.on('end',()=>{
   if(req.method==='GET'){
    trace.push({platform,method:'GET',path:req.url,txids:[req.url.split('/').at(-1)],bytes:0});
    res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({code:200,data:{txid:req.url.split('/').at(-1),confirmations:2}}));return;
   }
   const bytes=Buffer.concat(chunks),body=JSON.parse(bytes.toString()),raws=(Array.isArray(body)?body:[body]).map(x=>x.txraw);
   const ids=raws.map(raw=>{const tx=cases.flatMap(c=>c.bundle.transactions).find(t=>t.rawTransaction===raw);assert(tx,'Only frozen native-authorized public transactions may reach loopback');return tx.txid;});
   trace.push({platform,method:req.method,path:req.url,txids:ids,bodyHash:sha(bytes),bytes:bytes.length});
   if(req.url==='/drop'||req.url==='/result/unknown'){req.socket.destroy();return;}
   if(req.url==='/result/rejected'||req.url==='/result/partial'){
    const results=ids.map((txid,i)=>({txid,status:req.url==='/result/partial'&&i>0?'known':'rejected'}));
    res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({code:200,data:{results}}));return;
   }
   if(req.url==='/slow'){setTimeout(()=>{if(!res.destroyed){res.writeHead(200);res.end('{}');}},200);return;}
   res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({code:200,data:Array.isArray(body)?{success:ids.length,failed:0,results:ids}:{txid:ids[0]}}));
  });
 });
 const results=[];
 try{
  await new Promise(r=>server.listen(0,'127.0.0.1',r));port=server.address().port;
  await run(adb,['-s',device,'reverse',`tcp:${port}`,`tcp:${port}`],opts);
  const origin=`http://127.0.0.1:${port}`;
  for(const p of ['swift-macos','kotlin-android-api36']){
   platform=p;const r=p==='swift-macos'?await run(join(scratch,'send-check'),[fixture,origin,join(scratch,'dispatch-swift-db')],opts):
    await run(adb,['-s',device,'shell',`CLASSPATH=${remote}/dispatch.jar`,'/system/bin/app_process','/system/bin','io.tbc.kit.dart.SendCustodyCheckKt',remote+'/public.json',origin,remote+'/db'],opts);
   const line=r.stdout.trim().split('\n').findLast(l=>l.startsWith('{')&&l.includes('"status"'));assert(line,r.stdout);const value=JSON.parse(line);assert.equal(value.status,'PASS');assert(value.dispatchChecks>0);
   const requests=trace.filter(x=>x.platform===p),tails=cases.filter(c=>!c.workflow).reduce((sum,c)=>sum+c.bundle.transactions.length-1,0);
   assert(requests.length>=18+tails&&requests.length<=19+tails);assert.equal(requests.filter(x=>x.path==='/drop').length,2);
   assert.equal(requests.filter(x=>x.path.startsWith('/result/')).length,3);
   assert.equal(requests.filter(x=>x.method==='GET').length,1);assert(requests.filter(x=>x.path==='/slow').length<=1);
   for(const [i,c]of cases.entries())assert.deepEqual(requests[i].txids,(c.workflow?c.bundle.transactions:c.bundle.transactions.slice(0,1)).map(t=>t.txid));
   const routed=requests.slice(-(cases.length+tails));
   assert(routed.every(x=>x.path==='/api/tbc/broadcasttx'||x.path==='/api/tbc/broadcasttxs'));
   assert.deepEqual(routed.map(x=>x.txids),cases.flatMap(c=>c.workflow?[c.bundle.transactions.map(t=>t.txid)]:c.bundle.transactions.map(t=>[t.txid])));
   results.push({platform:p,...value,requests:requests.length,diagnostics:r.stderr});
  }
  assert.equal(results[0].dispatchChecks,results[1].dispatchChecks);
  assert.equal(results[0].routerChecks,results[1].routerChecks);assert(results[0].routerChecks>0);
  return {results,trace,device,publicNodeRequests:0,blockchainBroadcasts:0,proof:'Actual custody-selected finalized public fixtures -> operation-bound native adapter -> native system SQLite -> one-use admission -> actual Foundation/Android HTTP loopback. No private keys, installed-wallet UI, public node or chain acceptance.'};
 }finally{
  if(port)await run(adb,['-s',device,'reverse','--remove',`tcp:${port}`],opts).catch(()=>{});
  server.closeAllConnections();await new Promise(r=>server.close(r));
 }
}
try{
 const compiled=await Promise.all([
  run('/usr/bin/xcrun',['swiftc','-swift-version','6','-parse-as-library',...swift,'test/native/SendCustodyCheck.swift','-o',join(scratch,'send-check')],opts),
  run('/usr/bin/xcrun',['swiftc','-swift-version','6','-parse-as-library',...swift,'test/native/CustodyCheck.swift','-o',join(scratch,'sign-check')],opts),
  run(join(java,'bin/java'),['-cp',compiler.join(':'),'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler','-language-version','1.8','-api-version','1.8','-no-stdlib','-no-reflect','-jvm-target','17','-classpath',[compiler[1],compiler[6],json,androidJar].join(':'),'-d',join(scratch,'classes'),...kotlin,'test/native/SendCustodyCheck.kt','test/native/CustodyCheck.kt'],opts)
 ]);
 const native=await Promise.all([
  run(join(scratch,'send-check'),[fixture],opts),
  run(join(java,'bin/java'),['-cp',[join(scratch,'classes'),compiler[1],json,androidJar].join(':'),'io.tbc.kit.dart.SendCustodyCheckKt',fixture],opts)
 ]);
 const results=native.map((r,i)=>({platform:i?'kotlin-jvm':'swift-macos',...JSON.parse(r.stdout)}));
 for(const r of results){assert.equal(r.status,'PASS');assert.equal(r.cases,6);assert.equal(r.broadcasts,0);}assert.equal(results[0].checks,results[1].checks);
 if(process.env.TBC_SEND_DISPATCH_LOOPBACK==='1')loopback=await dispatchLoopback();
 const regressions=[];
 for(const [path,mode]of [['native-signing','native'],['prepared-signing','prepared']]){
  const executed=await Promise.all([
   run(join(scratch,'sign-check'),[mode==='prepared'?currentPrepared:join(base,`test/fixtures/${path}.json`),mode],opts),
   run(join(java,'bin/java'),['-cp',[join(scratch,'classes'),compiler[1],json,androidJar].join(':'),'io.tbc.kit.dart.CustodyCheckKt',mode==='prepared'?currentPrepared:join(base,`test/fixtures/${path}.json`),mode],opts)
  ]);for(const [i,r]of executed.entries()){const value=JSON.parse(r.stdout);assert.equal(value.status,'PASS');regressions.push({profile:mode,platform:i?'kotlin-jvm':'swift-macos',...value});}
 }
 const protection=JSON.parse((await run(process.execPath,['tool/check_protected.mjs'],opts)).stdout);
 const sourceHashes={};for(const p of [...swift,...kotlin,'test/native/SendCustodyCheck.swift','test/native/SendCustodyCheck.kt','test/native/CustodyCheck.swift','test/native/CustodyCheck.kt','tool/check_send_native_custody.mjs'])sourceHashes[p]=sha(await read(p));
 const report={status:loopback?'F3_NATIVE_SEND_RESULT_LOOPBACK_PASS':'F3_NATIVE_SEND_CUSTODY_BINDING_PASS',recordedAt:new Date().toISOString(),sourceHashes,
  reference:{sendSha256:sha(oracleBytes),workflowSha256:sha(workflowBytes),sourceOracleSha256:sha(sourceBytes),sourceIdentities:sources,cases:cases.map(c=>c.name),freshnessOnly:'Offline native clock refreshes proposal/plan/receipt deadlines and enclosing hashes. Original transaction bytes, signatures, fees, task digests and dependent outputs are unchanged.'},
  results,regressions,protection,scratch,preparedScope:{originalSha256:sha(preparedBytes),currentCases:prepared.cases.length-retiredPrepared.length,excludedRetiredCreation:retiredPrepared.map(c=>c.name),reason:'Retired lpPlan create correctly rejects AMM_FEE_FIELDS; current explicit-fee AMM is checked by the independent high-level173 suite. No frozen fixture was changed.'},...loopback?{loopback}:{},warnings:compiled.map(r=>r.stderr).filter(Boolean),
  proof:['Four native send methods reuse one approval and existing single/Prepared/workflow task custody with a separate send grant. Native source configuration is required; default hosts remain send-disabled.',
   'Exact-shape private native Host authorization and Router open/guard/journal/wire are exercised for success/rejection, fixed error redaction, foreign receipt, expired wire deadline and forbidden endpoint fields. Native-only selection retains owned bytes even when a returned selection is mutated. A configured native Router installed before navigation advertises four optional sends; source-only/default hosts do not.',
   'Native official mainnet/testnet and custom API/RPC source identities match the three frozen Kit broadcast-port vectors already exercised by Dart.',
   'Native-owned completion reconstructs exact workflow/bundle metadata, transaction order and raw-derived IDs. One immutable authorization; later read-only selection cannot supply new transaction bytes.',
   'Incomplete tasks, changed account/fee/txid/receipt/workflow, missing send grant, disabled source, repeated authorization, selection shape, lock/revision/revoke/navigation/cancel/close are rejected.',
   'Signing-only regressions retain no HTTP or broadcast state. Send close issues only an exact method/result-hash permit after native finish, never a signing/workflow permit. Emission rechecks native account/session/grants.',
   'Native result finish reads owned journal outcomes without network or extra durable writes. Prepared, admitted, in-flight, missing tail, changed txid/status/metadata, oversized reason, repeated finish and post-finish mutation reject. Actual Host delivery accepts only the exact committed result, rejects alternate methods and is suppressed after lock/revoke.',
   'Batch rejected, unknown and partial results preserve native journal state and dependency normalization. Unknown is never automatic resend. Tests classify fixed loopback responses; the shared Dart REST codec is covered separately.',
   ...loopback?['Actual native custody, bound adapter, SQLite and real HTTP socket integration passes six frozen selections plus prepared/admitted cancel, stale account before dispatch, dropped POST, explicit bounded GET reconciliation and cancellation during HTTP. No unsubmitted identity is left uncertain; actual unknown submission is not retried.',
    'Native lifetime hooks close attached adapters on cancellation, close, navigation/account/grant fences. Only native-held unstarted tickets can be released. Source, body, selected rows and journal identities cannot be replaced. Hot fences reuse the immutable native authorization ID rather than rehashing/copying raw transactions.']:[]],
  limits:['Public signature replay on macOS and Kotlin JVM, not actual key generation, installed iOS/Android or blockchain acceptance.',
   'The private shared worker remains responsible for frozen Engine final/pre-broadcast validation; native metadata authorization is not an independent VM or arbitrary raw-transaction semantic verifier.',
   'Reviewed workflow sending retains existing native completed-child verification but is not newly exercised here. Dart/public Provider routing has separate tests; installed end-to-end sending remains pending. Multi-stage single sends exercise missing-tail rejection followed by all-stage submission and exact native result delivery, without a second approval or permission write.',
   ...loopback?['Swift socket integration runs on macOS and Android on API36 app_process, not installed iOS/Android wallet App or private Testnet. The loopback node result classification in this native test is fixed; the shared Dart REST codec has separate tests and is not yet wired end-to-end.']:['Native HTTP/store dispatch is compiled but not exercised in this run.']],
  publicDeviceMethods:17,requiredMethods:22,loopbackHttp:loopback?.trace.length??0,http:0,broadcasts:0,published:false,acceptedDeliveryChanged:false,frozenRustModified:false,goalComplete:false};
 const bytes=JSON.stringify(report,null,2)+'\n';await writeFile(resolve(base,output),bytes,{flag:'wx'});
 console.log(JSON.stringify({status:report.status,results,regressions,...loopback?{loopback:loopback.results}:{},protectedFiles:protection.protectedFiles,output,sha256:sha(bytes),scratch}));
}catch(e){console.error(JSON.stringify({status:'FAIL',message:e.message,stdout:e.stdout?.slice(-3000),stderr:e.stderr?.slice(-9000),scratch}));process.exitCode=1;}
