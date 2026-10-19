// Collect a finished independent public-fixture device run with the exact
// source/artifact identity. No private data, screenshots or raw signatures.
import {execFileSync} from 'node:child_process';
import {readFile,writeFile,readdir,stat} from 'node:fs/promises';
import {resolve,join,relative} from 'node:path';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {sendConsumerSource} from './send_consumer_wire.mjs';
import {verifiedDartNativeCandidate,pairedNativeSource} from '../../contract173-upgrade/dart-native-candidate.mjs';
const base=resolve(import.meta.dirname,'..');
const [platform,outArg,device,reportArg]=process.argv.slice(2),out=resolve(outArg);
assert(['ios','android'].includes(platform));assert(/^\/private\/tmp\/tbc-dart-kit-f[123]-/.test(out));
const run=(command,args)=>execFileSync(command,args,{encoding:'utf8'}).trim();
const sha=b=>createHash('sha256').update(b).digest('hex');
const source={};
const consumer=JSON.parse(await readFile(join(out,'consumer-provenance.json')));
const profile=JSON.parse(await readFile(join(out,'assets/acceptance-profile.json')));
const paired=profile.name==='contract173'?await verifiedDartNativeCandidate(consumer.frozen):undefined;
assert.equal(consumer.reviewed.artifact,paired?.artifactId??'92d18b12fb2823d0dce98245b6ac1b689a44dcf581c25e3e2ab9a37bb94e40fb');
if(paired)assert.deepEqual(consumer.kitIdentity,paired.kitIdentity);
if(platform==='android'){
 assert.equal(sha(await readFile(join(out,'android/app/src/main/jniLibs/arm64-v8a/libtbc_dart_reviewed.so'))),consumer.reviewed.sha256);
 for(const [p,h]of Object.entries(consumer.reviewed.sourceHashes)){assert.equal(sha(await readFile(join(base,p))),h);source[p]=h;}
 assert.equal(sha(await readFile(join(out,'android/app/tbc-consumer-rules.pro'))),source['platform/android/consumer-rules.pro']);
}else{
 for(const [p,h]of Object.entries(consumer.reviewed.hashes)){
  assert.equal(sha(await readFile(join(out,'native/reviewed',p))),h);
  if(p!=='tbc_keyless.h'){assert.equal(sha(await readFile(join(base,'platform/native',p))),h);source['platform/native/'+p]=h;}
 }
}
for(const path of ['acceptance/lib/main.dart','acceptance/dapp.html']){
 const target=path.endsWith('main.dart')?'lib/main.dart':'assets/dapp.html';
 const bytes=await readFile(join(base,path));assert.equal(sha(await readFile(join(out,target))),sha(bytes));source[path]=sha(bytes);
}
const nativeRoot=platform==='ios'?'platform/ios/Classes':'platform/android/src/main/kotlin/io/tbc/kit/dart';
for(const file of await readdir(join(base,nativeRoot))){
 const bytes=await readFile(join(base,nativeRoot,file));
 const target=platform==='ios'?`ios/Runner/${file}`:`android/app/src/main/kotlin/io/tbc/kit/dart/${file}`;
 assert.equal(sha(await readFile(join(out,target))),sha(pairedNativeSource(file,sendConsumerSource(file,bytes,profile.name),paired)));source[`${nativeRoot}/${file}`]=sha(bytes);
}
for(const file of platform==='ios'?['AppDelegate.swift','FixtureWallet.swift']:['MainActivity.kt','FixtureWallet.kt']){
 const path=`acceptance/${platform}/${file}`,bytes=await readFile(join(base,path));
 const target=platform==='ios'?`ios/Runner/${file}`:`android/app/src/main/kotlin/io/tbc/dartkitf1/${file}`;
 assert.equal(sha(await readFile(join(out,target))),sha(pairedNativeSource(file,sendConsumerSource(file,bytes,profile.name),paired)));source[path]=sha(bytes);
}
async function hashTree(path){for(const e of await readdir(path,{withFileTypes:true})){
 const p=join(path,e.name);if(e.isDirectory())await hashTree(p);else if(e.isFile())source[relative(base,p)]=sha(await readFile(p));
}}
await hashTree(join(base,'lib'));
const adb=join(process.env.ANDROID_HOME??'/Users/alex/Library/Android/sdk','platform-tools/adb');
let deviceReport,artifact;
if(platform==='ios'){
 const container=run('xcrun',['simctl','get_app_container',device,'io.tbc.dartkit.f1','data']);
 deviceReport=JSON.parse(await readFile(join(container,'Documents/f1-report.json')));
 const binary=paired?'build/ios/iphonesimulator/Runner.app/Runner.debug.dylib':'derived-simulator/Build/Products/Debug-iphonesimulator/Runner.app/Runner.debug.dylib';
 artifact={buildMode:'simulator Debug',binary,sha256:sha(await readFile(join(out,binary))),bytes:(await stat(join(out,binary))).size};
 if(paired){
  const seal=JSON.parse(await readFile(join(out,'ios-signed-consumer.json')));
  assert.equal(seal.artifactId,paired.artifactId);assert.deepEqual(seal.kitIdentity,paired.kitIdentity);
  const installed=run('xcrun',['simctl','get_app_container',device,'io.tbc.dartkit.f1','app']);
  assert.equal(sha(await readFile(join(installed,'Runner.debug.dylib'))),artifact.sha256);
  assert.equal(sha(await readFile(join(installed,'Frameworks/TbcFlutterEngine.framework/TbcFlutterEngine'))),seal.installedSha256);
  artifact.installedVerified=true;artifact.signedConsumer=seal;
 }
}else{
 deviceReport=JSON.parse(run(adb,['-s',device,'shell','cat','/sdcard/Android/data/io.tbc.dartkit.f1/files/f1-report.json']));
 const apk='build/app/outputs/apk/release/app-release.apk';
 artifact={buildMode:'Release, test-only debug certificate, arm64',apk,sha256:sha(await readFile(join(out,apk))),bytes:(await stat(join(out,apk))).size};
 if(paired){
  const installed=run(adb,['-s',device,'shell','pm','path','io.tbc.dartkit.f1']).split('\n');
  assert.equal(installed.length,1);assert.match(installed[0],/^package:\/data\/app\/[^\s]+\/base.apk$/);
  assert.equal(run(adb,['-s',device,'shell','sha256sum',installed[0].slice(8)]).split(/\s+/)[0],artifact.sha256);
  artifact.installedVerified=true;
 }
}
assert.equal(deviceReport.status,'F1_DEVICE_PUBLIC_FIXTURE_PASS');assert.equal(deviceReport.broadcasts,0);
assert.equal(deviceReport.native.publicFixtureOnly,true);
assert(['all','pool2','pool2-maintenance','unified-pool','native-locks','token-htlc','lop','pool-dependent','pool-controller','typed-data','prepared','reviewed','workflow','crypto','send','contract173'].includes(profile.name));assert.equal(deviceReport.fixtureProfile,profile.name);
const expectedSelection=profile.name==='workflow'?['android-tbc_signMessage','android-tbc_signTransaction','transfer-single',...JSON.parse(await readFile(join(base,'test/fixtures/workflow-device.json'))).cases.map(s=>s.name)]:profile.name==='reviewed'?['android-tbc_signMessage','android-tbc_signTransaction','transfer-single','prepared-transfer-single',...JSON.parse(await readFile(join(base,'test/fixtures/reviewed-signing.json'))).cases.map(s=>'reviewed-'+s.name)]:profile.name==='prepared'?["android-tbc_signMessage","android-tbc_signTransaction","transfer-single","prepared-transfer-single","prepared-current-transfer-multiple-inputs","prepared-current-ft-staged-transfer","prepared-create-tbc20-fragmented","prepared-amm-holder-fragmented-sell","prepared-amm-controller-plain-add"]:profile.name==='typed-data'?[
 'android-tbc_signMessage','android-tbc_signTransaction','transfer-single',
 ...JSON.parse(await readFile(join(base,'test/fixtures/typed-device-signing.json'))).cases.map(s=>s.name),
]:profile.name==='pool-controller'?[
 'android-tbc_signMessage','android-tbc_signTransaction','transfer-single',
 ...(await Promise.all(['amm-controller-signing.json','amm-controller-extended.json'].map(async file=>JSON.parse(await readFile(join(base,'test/fixtures',file))).cases.map(s=>s.name)))).flat(),
]:profile.name==='pool-dependent'?[
 'android-tbc_signMessage','android-tbc_signTransaction','transfer-single',
 ...JSON.parse(await readFile(join(base,'test/fixtures/amm-dependent-signing.json'))).cases.map(s=>s.name),
]:profile.name==='lop'?[
 'android-tbc_signMessage','android-tbc_signTransaction','transfer-single',
 ...JSON.parse(await readFile(join(base,'test/fixtures/lop-signing.json'))).cases.filter(s=>s.minConfirmations==='0').map(s=>s.name),
]:profile.name==='token-htlc'?[
 'android-tbc_signMessage','android-tbc_signTransaction','transfer-single',
 ...JSON.parse(await readFile(join(base,'test/fixtures/htlc-token-signing.json'))).cases.filter(s=>s.minConfirmations==='0').map(s=>s.name),
]:profile.name==='native-locks'?[
 'android-tbc_signMessage','android-tbc_signTransaction','transfer-single',
 ...(await Promise.all(['timelock-signing.json','htlc-native-signing.json'].map(async file=>JSON.parse(await readFile(join(base,'test/fixtures',file))).cases.filter(s=>s.minConfirmations==='0').map(s=>s.name)))).flat(),
]:profile.name==='unified-pool'?[
 'android-tbc_signMessage','android-tbc_signTransaction','transfer-single',
 ...JSON.parse(await readFile(join(base,'test/fixtures/unified-pool-signing.json'))).cases.filter(s=>s.minConfirmations==='0').map(s=>s.name),
]:profile.name.startsWith('pool2')?[
 'android-tbc_signMessage','android-tbc_signTransaction','transfer-single',
 ...JSON.parse(await readFile(join(base,'test/fixtures/pool2-signing.json'))).cases.map(s=>s.name),
 ...(profile.name==='pool2-maintenance'?JSON.parse(await readFile(join(base,'test/fixtures/pool2-maintenance.json'))).cases.map(s=>s.name):[]),
]:null;
const cryptoSelection=profile.name==='crypto'?['android-tbc_signMessage','android-tbc_signTransaction','transfer-single',...JSON.parse(await readFile(join(base,'test/fixtures/crypto-device.json'))).cases.map(s=>s.name)]:null;
const sendSelection=profile.name==='send'?['android-tbc_signMessage','android-tbc_signTransaction','transfer-single',...JSON.parse(await readFile(join(base,'test/fixtures/send-device.json'))).cases.map(s=>s.name)]:null;
let contract173Selection;
if(paired){
 const cases=[];
 for(const file of ['high-level173.json','high-level173-extra.json']){
  const bytes=await readFile(resolve(base,'../contract173-upgrade',file));source['../contract173-upgrade/'+file]=sha(bytes);
  cases.push(...JSON.parse(bytes).cases.map(s=>({...s,additionalAccounts:s.signingAccounts})));
 }
 const fixture=JSON.parse(await readFile(join(out,'assets/contract173.json')));
 assert.deepEqual(fixture.cases,cases);assert.deepEqual(fixture.kitIdentity,paired.kitIdentity);
 for(const s of cases){
  const c=deviceReport.cases.find(c=>c.name===s.name);assert(c,s.name);
  assert.equal(c.signedTransactionsExact,true,s.name);assert.equal(c.matchedExceptFreshApprovalId,true,s.name);
  assert.equal(c.approvalDelta,1,s.name);assert.equal(c.signatureDelta,s.audit.signatures.length,s.name);
  assert.equal(c.controllerSignatureDelta,s.request.signingRoles?1:0,s.name);assert.equal(c.readOnlyStatusPosts,0,s.name);
  assert(c.reads>=s.warmTrace.length&&c.reads<=s.coldTrace.length,s.name);
  assert.equal(c.readPaths.length,new Set(c.readPaths).size,s.name);
  for(const p of c.readPaths)assert(s.coldTrace.includes(p),p);
  for(const p of s.warmTrace)assert(c.readPaths.includes(p),p);
 }
 contract173Selection=['android-tbc_signMessage','transfer-single',...cases.map(s=>s.name)];
}
const effectiveSelection=contract173Selection??sendSelection??cryptoSelection??expectedSelection;
assert.deepEqual(profile.selectedCases,effectiveSelection);
const selected=name=>effectiveSelection===null||effectiveSelection.includes(name);
if(profile.name==='send'){
 const file='test/fixtures/send-device.json',bytes=await readFile(join(base,file)),oracle=JSON.parse(bytes);
 assert.equal(sha(await readFile(join(out,'assets/send-device.json'))),sha(bytes));source[file]=sha(bytes);
 const seam='tool/send_consumer_wire.mjs';source[seam]=sha(await readFile(join(base,seam)));
 assert.equal(consumer.testOnlyWire?.sourceSha256,source[seam]);assert.equal(consumer.testOnlyWire.origin,oracle.origin);
 assert.deepEqual(deviceReport.loopbackFailures,[]);
 assert.equal(deviceReport.loopbackHTTP.length,oracle.cases.reduce((n,s)=>n+s.expectedPosts,0));
 assert.deepEqual(deviceReport.loopbackHTTP.flatMap(r=>r.txids),oracle.cases.flatMap(s=>s.audit.bundle.transactions.map(t=>t.txid)));
 assert(deviceReport.loopbackHTTP.every(r=>r.method==='POST'&&['/api/tbc/broadcasttx','/api/tbc/broadcasttxs'].includes(r.path)));
 for(const s of oracle.cases){
  const c=deviceReport.cases.find(c=>c.name===s.name);assert(c,s.name);
  assert.equal(c.matchedExceptFreshApprovalId,true,s.name);assert.equal(c.signedTransactionsExact,true,s.name);
  if(s.workflow)assert.equal(c.matchedExceptFreshWorkflowBindings,true,s.name);
  assert.equal(c.approvalDelta,1,s.name);assert.equal(c.signatureDelta,s.expectedSignatures,s.name);
  assert.equal(c.controllerSignatureDelta,0,s.name);assert.equal(c.loopbackPosts,s.expectedPosts,s.name);
  assert.equal(c.readOnlyStatusPosts,s.statusQueries.length,s.name);
  assert.equal(c.readPaths.length,new Set(c.readPaths).size,s.name);
  for(const p of c.readPaths)assert(s.coldTrace.includes(p),p);
  for(const p of s.warmTrace)assert(c.readPaths.includes(p),p);
 }
 const permission=deviceReport.cases.find(c=>c.method==='send-permission-isolation');
 assert.equal(permission?.providerMethods,21);assert.equal(permission?.posts,0);assert.equal(permission?.approvalDelta,0);assert.equal(permission?.signatureDelta,0);
 assert.equal(deviceReport.cases.find(c=>c.method==='send-reject')?.posts,0);
 assert.equal(deviceReport.cases.find(c=>c.method==='pending-approval-navigation')?.stalePosts,0);
}
if(profile.name==='crypto'){
 const file='test/fixtures/crypto-device.json',bytes=await readFile(join(base,file)),oracle=JSON.parse(bytes);
 assert.equal(sha(await readFile(join(out,'assets/crypto-device.json'))),sha(bytes));source[file]=sha(bytes);
 if(platform==='android'){
  const p='acceptance/android/fixture_signer.c';source[p]=sha(await readFile(join(base,p)));
  assert.equal(consumer.fixtureCrypto.sourceSha256,source[p]);
  assert.equal(consumer.fixtureCrypto.librarySha256,sha(await readFile(join(out,'android/app/src/main/jniLibs/arm64-v8a/libtbc_f1_signer.so'))));
 }
 for(const s of oracle.cases){
  const c=deviceReport.cases.find(c=>c.name===s.name);assert(c,s.name);
  assert.equal(c.matchedExceptFreshApprovalId,true,s.name);
  if(s.request.steps){assert.equal(c.matchedExceptFreshWorkflowBindings,true,s.name);assert.equal(c.signedTransactionsExact,true,s.name);}else assert.equal(c.exactResult,true,s.name);
  assert.equal(c.approvalDelta,1,s.name);assert.equal(c.signatureDelta,s.expectedSignatures,s.name);assert.equal(c.cryptoDelta,s.expectedCryptoCalls,s.name);
  assert.equal(c.controllerSignatureDelta,0,s.name);assert.equal(c.readOnlyStatusPosts,0,s.name);
  assert.deepEqual([...c.readPaths].sort(),[...s.coldTrace].sort(),s.name);
 }
 const permission=deviceReport.cases.find(c=>c.method==='crypto-permission-isolation');assert.equal(permission?.providerMethods,17);assert.equal(permission?.cryptoDelta,0);assert.equal(permission?.approvalDelta,0);
 const invalid=deviceReport.cases.find(c=>c.method==='crypto-reject-and-bad-mac');assert.equal(invalid?.ok,true);assert.equal(invalid?.cryptoDelta,0);assert.equal(invalid?.signatureDelta,0);assert.equal(invalid?.reads,0);
 assert.equal(deviceReport.cases.find(c=>c.method==='pending-approval-navigation')?.staleCrypto,0);
}
if(profile.name==='workflow'){
 const file='test/fixtures/workflow-device.json',bytes=await readFile(join(base,file)),oracle=JSON.parse(bytes);
 assert.equal(sha(await readFile(join(out,'assets/workflow-device.json'))),sha(bytes));source[file]=sha(bytes);
 for(const s of oracle.cases){
  const c=deviceReport.cases.find(c=>c.name===s.name);assert(c,s.name);
  assert.equal(c.matchedExceptFreshWorkflowBindings,true,s.name);assert.equal(c.signedTransactionsExact,true,s.name);
  assert.equal(c.approvalDelta,1,s.name);assert.equal(c.signatureDelta,s.expectedSignatures,s.name);
  assert.equal(c.controllerSignatureDelta,s.expectedControllerSignatures,s.name);
  assert.equal(c.readOnlyStatusPosts,s.statusQueries.length,s.name);
  assert.equal(c.readPaths.length,new Set(c.readPaths).size,s.name);
  for(const p of c.readPaths)assert(Object.hasOwn(s.replies,p),p);
  for(const p of s.warmTrace)assert(c.readPaths.includes(p),p);
 }
 assert.equal(deviceReport.cases.find(c=>c.method==='workflow-reject')?.signatureDelta,0);
 const failed=deviceReport.cases.find(c=>c.method==='workflow-native-unavailable');
 assert.equal(failed?.skippedSteps,1);assert.equal(failed?.signatureDelta,1);assert.equal(failed?.approvalDelta,1);
}
if(effectiveSelection)assert.deepEqual(deviceReport.cases.filter(c=>c.name).map(c=>c.name).sort(),[...effectiveSelection].sort());
source['acceptance-profile.json']=sha(await readFile(join(out,'assets/acceptance-profile.json')));
assert.equal(deviceReport.cases.find(c=>c.method==='pending-approval-navigation')?.staleSignatures,0);
assert.equal(deviceReport.cases.find(c=>c.method==='tbc_signTransaction')?.signedTransactionsExact,true);
const typedBytes=await readFile(join(base,'test/fixtures/typed-device-signing.json'));
const reviewedBytes=await readFile(join(base,'test/fixtures/reviewed-signing.json'));
assert.equal(sha(await readFile(join(out,'assets/reviewed-signing.json'))),sha(reviewedBytes));
source['test/fixtures/reviewed-signing.json']=sha(reviewedBytes);
for(const s of JSON.parse(reviewedBytes).cases){
 const name='reviewed-'+s.name;if(!selected(name))continue;
 const c=deviceReport.cases.find(c=>c.name===name);assert(c,name);
 const bytes=await readFile(join(base,'test/fixtures',s.source.file));
 assert.equal(sha(await readFile(join(out,'assets',s.source.file))),sha(bytes));
 source['test/fixtures/'+s.source.file]=sha(bytes);
 const original=JSON.parse(bytes).cases.find(v=>v.name===s.source.name);
 const queries=original.statusQueries??original.reads.filter(r=>r.path==='/api/tbc/txo/status');
 assert.equal(c.signedTransactionsExact,true);assert.equal(c.matchedExceptFreshApprovalId,true);
 assert.equal(c.approvalDelta,1);assert.equal(c.signatureDelta,original.stages.reduce((n,r)=>n+r.signatures.length,0));
 assert.equal(c.controllerSignatureDelta,0);assert.deepEqual(c.differentFields,['approvalId']);
 assert.equal(c.readOnlyStatusPosts,queries.length);assert.equal(c.readPaths.length,new Set(c.readPaths).size);
 for(const p of c.readPaths)assert(Object.hasOwn(original.replies??{},p),p);
}
const preparedBytes=await readFile(join(base,'test/fixtures/prepared-signing.json'));
assert.equal(sha(await readFile(join(out,'assets/prepared-signing.json'))),sha(preparedBytes));
source['test/fixtures/prepared-signing.json']=sha(preparedBytes);
for(const s of JSON.parse(preparedBytes).cases){
 const name='prepared-'+s.name;if(!selected(name))continue;
 const c=deviceReport.cases.find(c=>c.name===name);assert(c,name);
 assert.equal(c.signedTransactionsExact,true);assert.equal(c.matchedExceptFreshApprovalId,true);
 assert.equal(c.approvalDelta,1);assert.equal(c.signatureDelta,s.audit.signatures.length);
 assert.equal(c.controllerSignatureDelta,s.request.signingRoles?1:0);
 assert.equal(c.readOnlyStatusPosts,0);assert.deepEqual(c.differentFields,['approvalId']);
 const file=s.source.file==='native-signing.json'?'native-transfers.json':s.source.file;
 const sourceBytes=await readFile(join(base,'test/fixtures',file));
 assert.equal(sha(await readFile(join(out,'assets',file))),sha(sourceBytes));
 source['test/fixtures/'+file]=sha(sourceBytes);
 const original=JSON.parse(sourceBytes).cases.find(v=>v.name===s.source.name);
 const cold=original.coldTrace??original.trace,warm=original.warmTrace??original.trace;
 assert(c.reads>=warm.length&&c.reads<=cold.length,name);
 assert.equal(c.readPaths.length,new Set(c.readPaths).size);
 for(const p of c.readPaths)assert(cold.includes(p),p);
 for(const p of warm)assert(c.readPaths.includes(p),p);
}
assert.equal(sha(await readFile(join(out,'assets/typed-device-signing.json'))),sha(typedBytes));
source['test/fixtures/typed-device-signing.json']=sha(typedBytes);
for(const s of JSON.parse(typedBytes).cases){
 if(!selected(s.name))continue;
 const c=deviceReport.cases.find(c=>c.name===s.name);assert(c,s.name);
 assert.equal(c.matchedExceptFreshApprovalId,true);assert.equal(c.approvalDelta,1);assert.equal(c.signatureDelta,1);
 assert.equal(c.reads,0);assert.equal(c.readOnlyStatusPosts,0);assert.deepEqual(c.differentFields,[]);
}
if(profile.name==='typed-data'||profile.name==='all'){
 for(const method of ['typed-permission-isolation','typed-invalid-origin-and-rejection']){
  const c=deviceReport.cases.find(c=>c.method===method);assert(c,method);assert.equal(c.ok,true);assert.equal(c.signatureDelta,0);
 }
}
for(const name of ['transfer-single','transfer-multiple','merge-two','merge-limit']){
 if(!selected(name))continue;
 const c=deviceReport.cases.find(c=>c.name===name);assert(c,name);
 assert.equal(c.signedTransactionsExact,true);assert.equal(c.matchedExceptFreshApprovalId,true);
 assert.equal(c.approvalDelta,1);assert.equal(c.reads,2);
 assert.equal(c.signatureDelta,name==='merge-limit'?100:name==='transfer-single'?1:2);
}
const protectedState=JSON.parse(run(process.execPath,[join(base,'tool/check_protected.mjs')]));
const fungible=JSON.parse(await readFile(join(base,'test/fixtures/fungible-signing.json')));
assert.equal(sha(await readFile(join(out,'assets/fungible-signing.json'))),sha(await readFile(join(base,'test/fixtures/fungible-signing.json'))));
source['test/fixtures/fungible-signing.json']=sha(await readFile(join(base,'test/fixtures/fungible-signing.json')));
for(const s of fungible.cases){
 if(!selected(s.name))continue;
 const c=deviceReport.cases.find(c=>c.name===s.name);assert(c,s.name);
 assert.equal(c.signedTransactionsExact,true);assert.equal(c.matchedExceptFreshApprovalId,true);
 assert.equal(c.approvalDelta,1);assert.equal(c.signatureDelta,s.audit.signatures.length);
 assert(c.reads>=3&&c.reads<=s.coldTrace.length);
 assert.equal(c.readPaths.length,new Set(c.readPaths).size);
 for(const p of c.readPaths)assert(s.coldTrace.includes(p),p);
 for(const p of s.warmTrace)assert(c.readPaths.includes(p),p);
}
const provenance=JSON.parse(await readFile(join(out,'consumer-provenance.json')));
const nftBytes=await readFile(join(base,'test/fixtures/nft-signing.json'));
assert.equal(sha(await readFile(join(out,'assets/nft-signing.json'))),sha(nftBytes));
source['test/fixtures/nft-signing.json']=sha(nftBytes);
for(const s of JSON.parse(nftBytes).cases){
 if(!selected(s.name))continue;
 const c=deviceReport.cases.find(c=>c.name===s.name);assert(c,s.name);
 assert.equal(c.signedTransactionsExact,true);assert.equal(c.matchedExceptFreshApprovalId,true);
 assert.equal(c.approvalDelta,1);assert.equal(c.signatureDelta,s.audit.signatures.length);assert.equal(c.readOnlyStatusPosts,1);
 const cold=s.coldTrace.filter(p=>p.method==='GET').map(p=>p.path),warm=s.warmTrace.filter(p=>p.method==='GET').map(p=>p.path);
 assert(c.reads>=warm.length&&c.reads<=cold.length);
 assert.equal(c.readPaths.length,new Set(c.readPaths).size);
 for(const p of c.readPaths)assert(cold.includes(p),p);
 for(const p of warm)assert(c.readPaths.includes(p),p);
}
const stablecoinBytes=await readFile(join(base,'test/fixtures/stablecoin-signing.json'));
assert.equal(sha(await readFile(join(out,'assets/stablecoin-signing.json'))),sha(stablecoinBytes));
source['test/fixtures/stablecoin-signing.json']=sha(stablecoinBytes);
for(const s of JSON.parse(stablecoinBytes).cases.filter(s=>s.minConfirmations==='0')){
 if(!selected(s.name))continue;
 const c=deviceReport.cases.find(c=>c.name===s.name);assert(c,s.name);
 assert.equal(c.signedTransactionsExact,true);assert.equal(c.matchedExceptFreshApprovalId,true);
 assert.equal(c.approvalDelta,1);assert.equal(c.signatureDelta,s.audit.signatures.length);assert.equal(c.readOnlyStatusPosts,0);
 assert(c.reads>=s.warmTrace.length&&c.reads<=s.coldTrace.length);
 assert.equal(c.readPaths.length,new Set(c.readPaths).size);
 for(const p of c.readPaths)assert(s.coldTrace.includes(p),p);
 for(const p of s.warmTrace)assert(c.readPaths.includes(p),p);
}
const stagedBytes=await readFile(join(base,'test/fixtures/staged-signing.json'));
assert.equal(sha(await readFile(join(out,'assets/staged-signing.json'))),sha(stagedBytes));
source['test/fixtures/staged-signing.json']=sha(stagedBytes);
for(const s of JSON.parse(stagedBytes).cases){
 if(!selected(s.name))continue;
 const c=deviceReport.cases.find(c=>c.name===s.name);assert(c,s.name);
 assert.equal(c.signedTransactionsExact,true);assert.equal(c.matchedExceptFreshApprovalId,true);
 assert.equal(c.approvalDelta,1);assert.equal(c.signatureDelta,10);assert.equal(c.readOnlyStatusPosts,0);
 assert(c.reads>=s.warmTrace.length&&c.reads<=s.coldTrace.length);
 assert.equal(c.readPaths.length,new Set(c.readPaths).size);
 for(const p of c.readPaths)assert(s.coldTrace.includes(p),p);
 for(const p of s.warmTrace)assert(c.readPaths.includes(p),p);
}
const creationBytes=await readFile(join(base,'test/fixtures/creation-signing.json'));
assert.equal(sha(await readFile(join(out,'assets/creation-signing.json'))),sha(creationBytes));
source['test/fixtures/creation-signing.json']=sha(creationBytes);
for(const s of JSON.parse(creationBytes).cases){
 if(!selected(s.name))continue;
 const c=deviceReport.cases.find(c=>c.name===s.name);assert(c,s.name);
 assert.equal(c.signedTransactionsExact,true);assert.equal(c.matchedExceptFreshApprovalId,true);
 assert.equal(c.approvalDelta,1);assert.equal(c.signatureDelta,s.audit.signatures.length);
 assert.equal(c.readOnlyStatusPosts,0);assert.equal(c.reads,2);
 assert.deepEqual([...c.readPaths].sort(),[...s.coldTrace].sort());
}
const mintBytes=await readFile(join(base,'test/fixtures/nft-mint-signing.json'));
assert.equal(sha(await readFile(join(out,'assets/nft-mint-signing.json'))),sha(mintBytes));
source['test/fixtures/nft-mint-signing.json']=sha(mintBytes);
for(const s of JSON.parse(mintBytes).cases.filter(s=>s.minConfirmations==='0')){
 if(!selected(s.name))continue;
 const c=deviceReport.cases.find(c=>c.name===s.name);assert(c,s.name);
 assert.equal(c.signedTransactionsExact,true);assert.equal(c.matchedExceptFreshApprovalId,true);
 assert.equal(c.approvalDelta,1);assert.equal(c.signatureDelta,s.audit.signatures.length);
 assert.equal(c.readOnlyStatusPosts,s.coldTrace.filter(t=>t.method==='POST').length);
 const cold=s.coldTrace.filter(t=>t.method==='GET').map(t=>t.path),warm=s.warmTrace.filter(t=>t.method==='GET').map(t=>t.path);
 assert(c.reads>=warm.length&&c.reads<=cold.length);assert.equal(c.readPaths.length,new Set(c.readPaths).size);
 for(const p of c.readPaths)assert(cold.includes(p),p);for(const p of warm)assert(c.readPaths.includes(p),p);
}
for(const file of ['amm-creation-signing.json','amm-business-signing.json','lp-signing.json','pool2-signing.json','pool2-maintenance.json','unified-pool-signing.json']){
 const bytes=await readFile(join(base,'test/fixtures',file));
 assert.equal(sha(await readFile(join(out,'assets',file))),sha(bytes));source['test/fixtures/'+file]=sha(bytes);
 for(const s of JSON.parse(bytes).cases.filter(s=>s.minConfirmations==='0')){
  if(!selected(s.name))continue;
  const c=deviceReport.cases.find(c=>c.name===s.name);assert(c,s.name);
  if(s.request.constraints?.expiresAt!==undefined)assert.equal(c.freshExpiryRebound,true);
  assert.equal(c.signedTransactionsExact,true);assert.equal(c.matchedExceptFreshApprovalId,true);
  assert.equal(c.approvalDelta,1);assert.equal(c.signatureDelta,s.audit.signatures.length);assert.equal(c.readOnlyStatusPosts,0);
  const warm=file.startsWith('pool2-')||s.generation==='historical'?s.warmTrace.filter(p=>p!==`/api/tbc/txraw/txid/${s.audit.material.snapshot.payload.utxos[0].txid}`):s.warmTrace;
  assert(c.reads>=warm.length&&c.reads<=s.coldTrace.length);
  assert.equal(c.readPaths.length,new Set(c.readPaths).size);
  for(const p of c.readPaths)assert(s.coldTrace.includes(p),p);
  for(const p of warm)assert(c.readPaths.includes(p),p);
 }
}
for(const file of ['timelock-signing.json','htlc-native-signing.json','htlc-token-signing.json','lop-signing.json','amm-dependent-signing.json','amm-controller-signing.json','amm-controller-extended.json']){
 const bytes=await readFile(join(base,'test/fixtures',file));
 assert.equal(sha(await readFile(join(out,'assets',file))),sha(bytes));source['test/fixtures/'+file]=sha(bytes);
 for(const s of JSON.parse(bytes).cases.filter(s=>s.minConfirmations==='0')){
  if(!selected(s.name))continue;
  const c=deviceReport.cases.find(c=>c.name===s.name);assert(c,s.name);
  assert.equal(c.signedTransactionsExact,true);assert.equal(c.matchedExceptFreshApprovalId,true);
  assert.equal(c.approvalDelta,1);assert.equal(c.signatureDelta,s.audit.signatures.length);
  if(file.startsWith('amm-controller'))assert.equal(c.controllerSignatureDelta,1);
  assert.equal(c.readOnlyStatusPosts,s.coldStatus?.length??0);
  assert(c.reads>=s.warmTrace.length&&c.reads<=s.coldTrace.length);
  assert.equal(c.readPaths.length,new Set(c.readPaths).size);
  for(const p of c.readPaths)assert(s.coldTrace.includes(p),p);
  for(const p of s.warmTrace)assert(c.readPaths.includes(p),p);
  if(s.request.intent.preimage)assert(!JSON.stringify(deviceReport).includes(s.request.intent.preimage),'No proof in device report');
 }
}
const result={status:profile.name==='workflow'?'F3_WORKFLOW_DEVICE_PUBLIC_FIXTURE_PASS':profile.name==='reviewed'?'F3_REVIEWED_DEVICE_PUBLIC_FIXTURE_PASS':profile.name==='prepared'?'F3_PREPARED_DEVICE_PUBLIC_FIXTURE_PASS':profile.name==='typed-data'?'F2_TYPED_DATA_DEVICE_PUBLIC_FIXTURE_PASS':profile.name==='pool-controller'?'F2_CONTROLLER_POOL_DEVICE_PUBLIC_FIXTURE_PASS':profile.name==='pool-dependent'?'F2_DEPENDENT_POOL_DEVICE_PUBLIC_FIXTURE_PASS':profile.name==='lop'?'F2_LOP_DEVICE_PUBLIC_FIXTURE_PASS':profile.name==='token-htlc'?'F2_TOKEN_HTLC_DEVICE_PUBLIC_FIXTURE_PASS':profile.name==='native-locks'?'F2_NATIVE_LOCKS_DEVICE_PUBLIC_FIXTURE_PASS':profile.name==='unified-pool'?'F2_UNIFIED_POOL_DEVICE_PUBLIC_FIXTURE_PASS':profile.name==='pool2-maintenance'?'F2_POOL2_MAINTENANCE_DEVICE_PUBLIC_FIXTURE_PASS':'F2_POOL2_DEVICE_PUBLIC_FIXTURE_PASS',recordedAt:new Date().toISOString(),platform,device,
 bundleId:'io.tbc.dartkit.f1',buildDirectory:out,deviceReport,artifact,provenance,source,protectedState,
 proofLimit:'Real Flutter/WebView/native approval and Rust signing on simulator/emulator with public scalar-one/two and deterministic chain replies. Not real-chain broadcast, full business coverage, physical-device/minimum-OS, matched speed regression or complete-size proof.',
 timingScope:'Single controlled run with 250 ms automated UI consent delay and deterministic read replies. iOS Debug and Android Release are not directly comparable; artifact bytes are not the incremental partner App size.',
 acceptedDeliveryChanged:false,published:false};
if(profile.name==='crypto'){result.status='F3_BIE1_DEVICE_PUBLIC_FIXTURE_PASS';result.proofLimit+=' Includes actual frozen Rust BIE1 through optional native custody, standalone and mixed workflows; no production Vault or secret-account proof.';}
if(profile.name==='send'){result.status='F3_SEND_DEVICE_PUBLIC_FIXTURE_PASS';result.proofLimit+=' Four public sends use real native custody, journal, result attestation and HTTP. Only the generated test host final wire destination is loopback, explicitly identified by testOnlyWire; production HTTPS was not weakened. No public node or chain submission.';}
if(paired){result.status='CONTRACT173_DEVICE_PUBLIC_FIXTURE_PASS';result.kitIdentity=paired.kitIdentity;result.proofLimit+=' Includes current explicit-fee AMM create/add/buy/sell/remove, controller/timelock variants and paged material; no real API or pool creation.';}
await writeFile(resolve(base,reportArg),JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({status:result.status,platform,cases:paired?deviceReport.cases.length:deviceReport.cases,artifact,protectedFiles:protectedState.protectedFiles}));
