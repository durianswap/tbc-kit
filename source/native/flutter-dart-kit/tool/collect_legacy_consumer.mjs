// Verify two installed-process snapshots against the exact paired sources.
import assert from 'node:assert/strict';
import {readFile,readdir,writeFile} from 'node:fs/promises';
import {resolve,join,relative} from 'node:path';
import {createHash} from 'node:crypto';
import {verifiedDartNativeCandidate,pairedNativeSource} from '../../contract173-upgrade/dart-native-candidate.mjs';
import {legacyPage,legacyConsumerSource} from './legacy_consumer.mjs';
const [firstFile,secondFile,pageDirectory,output]=process.argv.slice(2),base=resolve(import.meta.dirname,'..');
const sha=b=>createHash('sha256').update(b).digest('hex'),snapshots=[];
for(const p of [firstFile,secondFile])snapshots.push(JSON.parse(await readFile(resolve(base,p))));
const [a,b]=snapshots;assert.equal(a.status,'LEGACY_DEVICE_FIRST_PASS');assert.equal(b.status,'LEGACY_DEVICE_RESTART_PASS');
assert.equal(a.consumer,b.consumer);assert.equal(a.device,b.device);assert.deepEqual(a.artifact,b.artifact);assert.notEqual(a.deviceReport.pid,b.deviceReport.pid);
const out=a.consumer,platform=a.platform,p=JSON.parse(await readFile(join(out,'consumer-provenance.json')));
assert.equal(p.bundleId,'io.tbc.dartkit.legacy');assert.equal(p.publicFixtureOnly,true);
const native=await verifiedDartNativeCandidate(p.frozen),page=await legacyPage(pageDirectory,base,native);
assert.deepEqual(p.kitIdentity,native.kitIdentity);assert.equal(p.page,page.manifest.sha256);
const sources={};
async function same(source,target,transform=false){
 const bytes=await readFile(join(base,source)),file=source.split('/').at(-1);sources[source]=sha(bytes);
 const emitted=transform?legacyConsumerSource(file,pairedNativeSource(file,bytes,native),native,page.manifest):bytes;
 assert.equal(sha(await readFile(join(out,target))),sha(emitted),source);
 if(transform)assert.equal(p.candidate[file],sha(emitted),file+' provenance');
}
await same('acceptance/legacy/main.dart','lib/main.dart');await same('acceptance/legacy/dapp.html','assets/dapp.html');
for(const file of ['legacy-message-signing.json','native-signing.json','native-transfers.json'])await same('test/fixtures/'+file,'assets/'+file);
const root=platform==='ios'?'platform/ios/Classes':'platform/android/src/main/kotlin/io/tbc/kit/dart';
for(const name of await readdir(join(base,root)))if(name.endsWith(platform==='ios'?'.swift':'.kt'))
 await same(root+'/'+name,platform==='ios'?'ios/Runner/'+name:'android/app/src/main/kotlin/io/tbc/kit/dart/'+name,true);
for(const name of platform==='ios'?['AppDelegate.swift','FixtureWallet.swift']:['MainActivity.kt','FixtureWallet.kt'])
 await same(`acceptance/${platform}/${name}`,platform==='ios'?'ios/Runner/'+name:'android/app/src/main/kotlin/io/tbc/dartkitf1/'+name,true);
async function tree(dir){for(const e of await readdir(dir,{withFileTypes:true})){const path=join(dir,e.name);if(e.isDirectory())await tree(path);else if(e.isFile())sources[relative(base,path)]=sha(await readFile(path));}}
await tree(join(base,'lib'));await tree(join(base,'runtime'));
for(const file of ['tool/prepare_consumer.mjs','tool/legacy_consumer.mjs','tool/snapshot_legacy_device.mjs','tool/collect_legacy_consumer.mjs'])sources[file]=sha(await readFile(join(base,file)));
const names=[['baseline-shapes-native-grant-one-wallet','four-bitcoin-message-encodings-native-custody','message-batch-one-approval-shared-workflow',
 'legacy-transfer-shared-engine-exact-bytes-no-broadcast','business-reject-resolves-no-key-use','navigation-cancels-pending-and-reopens',
 'legacy-disconnect-preserves-standard','legacy-off-standard-unaffected'],['restart-fresh-session-independent-durable-grants','restart-legacy-only-revoke']];
for(let i=0;i<2;i++){
 const r=snapshots[i].deviceReport;assert.equal(r.phase,i+1);assert.deepEqual(r.cases,names[i]);
 assert.equal(r.publicHttp,0);assert.equal(r.broadcasts,0);assert.equal(r.native.broadcasts,0);assert.equal(r.native.publicFixtureOnly,true);
 assert.equal(snapshots[i].pageSha256,page.manifest.sha256);assert.deepEqual(snapshots[i].kitIdentity,native.kitIdentity);
 assert(r.timings.every(t=>Number.isFinite(t.pageMs)&&t.pageMs>0&&t.approvalToLastSignatureUs>0));
}
assert.equal(b.deviceReport.native.signatures,1);assert.equal(b.deviceReport.paths.length,0);
const reference=JSON.parse(await readFile(join(base,'test/fixtures/native-transfers.json'))).cases.find(s=>s.name==='transfer-single');
assert.deepEqual([...a.deviceReport.paths].sort(),[...reference.trace].sort());
const report={status:'LEGACY_INSTALLED_DUAL_COMPOSITION_PASS',recordedAt:new Date().toISOString(),platform,device:a.device,consumer:out,
 artifact:a.artifact,kitIdentity:native.kitIdentity,nativeArtifact:native.artifactId,pageSha256:page.manifest.sha256,snapshots:[firstFile,secondFile],sources,
 proof:'Actual paired Flutter/WebView, same Dart Provider/worker and native custody/SQLite/public-fixture signer. Four exact Bitcoin messages, two-message batch one approval, exact TBC signed bytes and same two read paths; cancellation, namespace isolation, Legacy off and process restart. No public-chain transaction or partner Vault proof.',
 performance:'Recorded public-fixture observations include250ms automated approval delay, simulator/harness/load; not matched regression measurements.',
 acceptedDeliveryChanged:false,published:false,broadcasts:0,fullGoalComplete:false};
await writeFile(resolve(base,output),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({status:report.status,platform,checks:names.map(n=>n.length),page:report.pageSha256,broadcasts:0}));
