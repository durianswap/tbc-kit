// Installed public-fixture proof, not Testnet or partner Vault acceptance.
import assert from 'node:assert/strict';
import {readFile,writeFile,readdir} from 'node:fs/promises';
import {join,resolve,basename} from 'node:path';
import {createHash} from 'node:crypto';
import {legacyConsumerSource} from './legacy_consumer.mjs';
import {verifiedDartNativeCandidate,pairedNativeSource} from '../../contract173-upgrade/dart-native-candidate.mjs';
const base=resolve(import.meta.dirname,'..'),[iosFile,androidFile,output]=process.argv.slice(2);
assert(iosFile&&androidFile&&output);
const sha=b=>createHash('sha256').update(b).digest('hex'),sources={};
const expected=['balance-shared-read-native-delivery-one-get','standard-tbc-shared-native-exact-bytes',
 'legacy-tbc-noop-without-approval-or-post','standard-ft-shared-native-exact-bytes','legacy-ft-noop-without-approval-or-post',
 'standard-stablecoin-shared-native-exact-bytes','legacy-stablecoin-noop-without-approval-or-post',
 'standard-pool-ft-shared-native-exact-bytes','standard-ftlp-shared-native-exact-bytes',
 'maintenance-reject-no-sign-no-post','maintenance-unknown-one-post-native-recovery'];
const artifacts=[];
for(const [platform,file]of [['ios',iosFile],['android',androidFile]]){
 const snapshot=JSON.parse(await readFile(resolve(base,file))),r=snapshot.deviceReport,out=snapshot.consumer;
 assert.equal(snapshot.platform,platform);assert.equal(snapshot.status,'MAINTENANCE_DEVICE_PASS');
 assert.equal(snapshot.artifact.installedVerified,true);assert.deepEqual(r.cases,expected);
 assert.deepEqual(r.wireFailures,[]);assert.equal(r.publicHttp,0);assert.equal(r.broadcasts,0);
 assert.equal(r.native.publicFixtureOnly,true);assert.equal(r.native.broadcasts,0);
 assert.equal(r.native.approvals,9);assert.equal(r.native.signatures,114);
 const posts=r.loopbackTrace.filter(v=>v.method==='POST'),gets=r.loopbackTrace.filter(v=>v.method==='GET');
 assert.equal(posts.length,6);assert.equal(new Set(posts.map(v=>v.txid)).size,6);assert.equal(gets.length,1);
 assert.equal(gets[0].path,`/api/tbc/decode/txid/${posts.at(-1).txid}`);
 assert.deepEqual(r.timings.map(t=>t.reads),[3,7,7,13,8]);
 assert(r.timings.every(t=>t.pageMs>0&&t.approvalToLastSignatureUs>0));
 const provenance=JSON.parse(await readFile(join(out,'consumer-provenance.json')));
 const native=await verifiedDartNativeCandidate(provenance.frozen);
 const pageManifest=JSON.parse(await readFile(join(out,'legacy-page-provenance.json')));
 assert.equal(snapshot.pageSha256,pageManifest.sha256);assert.deepEqual(snapshot.kitIdentity,native.kitIdentity);
 const root=platform==='ios'?'platform/ios/Classes':'platform/android/src/main/kotlin/io/tbc/kit/dart';
 async function same(source,destination,transform=false){
  const original=await readFile(join(base,source));sources[source]=sha(original);
  const bytes=transform?legacyConsumerSource(basename(source),pairedNativeSource(basename(source),original,native),native,pageManifest,true):original;
  assert.equal(sha(await readFile(join(out,destination))),sha(bytes),`${platform}:${destination}`);
 }
 await same('acceptance/legacy/main.dart','lib/main.dart');await same('acceptance/legacy/dapp.html','assets/dapp.html');
 for(const name of await readdir(join(base,root)))if(name.endsWith(platform==='ios'?'.swift':'.kt'))
  await same(`${root}/${name}`,platform==='ios'?`ios/Runner/${name}`:`android/app/src/main/kotlin/io/tbc/kit/dart/${name}`,true);
 for(const name of platform==='ios'?['AppDelegate.swift','FixtureWallet.swift']:['MainActivity.kt','FixtureWallet.kt'])
  await same(`acceptance/${platform}/${name}`,platform==='ios'?`ios/Runner/${name}`:`android/app/src/main/kotlin/io/tbc/dartkitf1/${name}`,true);
 for(const file of ['native-signing.json','native-transfers.json','fungible-signing.json','stablecoin-signing.json','unified-pool-signing.json'])await same(`test/fixtures/${file}`,`assets/${file}`);
 artifacts.push({platform,snapshot:file,device:snapshot.device,consumer:out,artifact:snapshot.artifact,kitIdentity:native.kitIdentity,
  pageSha256:snapshot.pageSha256,checks:expected.length,timings:r.timings,syntheticPosts:posts.length,readOnlyReconciliations:gets.length});
}
async function tree(dir){for(const e of await readdir(join(base,dir),{withFileTypes:true})){
 const p=`${dir}/${e.name}`;if(e.isDirectory())await tree(p);else sources[p]=sha(await readFile(join(base,p)));
}}
await tree('lib');await tree('runtime');
for(const p of ['tool/collect_maintenance_devices.mjs','tool/prepare_consumer.mjs','tool/legacy_consumer.mjs','tool/send_consumer_wire.mjs','tool/snapshot_legacy_device.mjs'])sources[p]=sha(await readFile(join(base,p)));
const workerReport='evidence/f3-maintenance-worker-20261014-e.json';
const worker=JSON.parse(await readFile(join(base,workerReport)));
for(const [p,h]of Object.entries(worker.sources))assert.equal(sha(await readFile(join(base,p))),h,p);
const report={status:'MAINTENANCE_AND_BALANCE_PAIRED_DEVICE_PASS',recordedAt:new Date().toISOString(),artifacts,sources,workerReport,
 proof:'Installed Flutter/WebView Standard extension and Legacy share real Dart worker, frozen Rust, Swift/Kotlin native custody, signer and broadcast journal. Five asset kinds each build/sign one exact frozen transaction with one bounded consent. Legacy three aliases attest zero-work results without approval/signing/POST. Balance takes one GET. Rejection does not sign/submit. The final100input unknown case submits once,queries decode once,retains native recoveryId and never retries.',
 fixtureIsolation:'Generated final HTTP destinations are localhost:41878 only; current network/path/body/authority checks remain. Public scalar-one fixtures never enter public networks. Read indexes and submission outcomes are synthetic,not node or ledger proof.',
 correction:'Attempt-c passed the first10 cases on both devices but the fixture listened on txraw instead of the production decode query. Native returned uncertain without retry. Only the test listener was fixed; failed snapshots retained.',
 buildNotes:'Android Flutter default selected Java25 and failed; direct Gradle with Java17 passed. Initial generic iOS simulator build did not resolve Signer; explicit arm64 build populated the matched slice and subsequent Flutter build passed. Existing toolchain/WebView warnings remain.',
 limitations:'One signed child per successful asset run here; two-round worker proof is separate. No new private Testnet,partner Vault,lowest OS/physical device,matched performance regression or Release App increment proof. iOS Debug simulator and Android Release timings include250ms synthetic approval and harness; do not compare them as platform performance. New-entry Reviewed/BIE1/send,admission/reopen,clean safe template/install and final full-scope seal remain.',
 acceptedDeliveryChanged:false,publicHttp:0,realBroadcasts:0,published:false,goalComplete:false};
await writeFile(resolve(base,output),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({status:report.status,checks:artifacts.map(v=>({platform:v.platform,checks:v.checks,timings:v.timings})),sourceHashes:Object.keys(sources).length,realBroadcasts:0}));
