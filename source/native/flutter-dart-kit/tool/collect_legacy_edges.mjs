// Installed public-fixture integration proof, not chain or partner Vault proof.
import assert from 'node:assert/strict';
import {readFile,writeFile,readdir} from 'node:fs/promises';
import {join,resolve,basename} from 'node:path';
import {createHash} from 'node:crypto';
import {legacyConsumerSource} from './legacy_consumer.mjs';
import {verifiedDartNativeCandidate,pairedNativeSource} from '../../contract173-upgrade/dart-native-candidate.mjs';
const base=resolve(import.meta.dirname,'..'),[iosFile,androidFile,output]=process.argv.slice(2);
assert(iosFile&&androidFile&&output);
const sha=b=>createHash('sha256').update(b).digest('hex'),sources={};
const expected=['raw-shared-reviewed-exact-detached-signatures','associated-shared-reviewed-two-children-one-approval',
 'bie1-native-roundtrip-separate-single-approvals','bie1-native-frozen-kit-ciphertext',
 'mixed-reviewed-crypto-message-one-shared-workflow-approval','crypto-reject-no-private-call',
 'associated-navigation-cancel-fresh-reviewed-reopen','send-shared-custody-journal-one-loopback-submit'];
const artifacts=[];
for(const [platform,file]of [['ios',iosFile],['android',androidFile]]){
 const snapshot=JSON.parse(await readFile(resolve(base,file))),r=snapshot.deviceReport,out=snapshot.consumer;
 assert.equal(snapshot.platform,platform);assert.equal(snapshot.status,'LEGACY_EDGES_DEVICE_PASS');
 assert.equal(snapshot.artifact.installedVerified,true);assert.deepEqual(r.cases,expected);
 assert.deepEqual(r.wireFailures,[]);assert.equal(r.publicHttp,0);assert.equal(r.broadcasts,0);
 assert.equal(r.native.publicFixtureOnly,true);assert.equal(r.native.broadcasts,0);
 assert.equal(r.native.approvals,11);assert.equal(r.native.signatures,9);assert.equal(r.native.cryptoCalls,4);
 assert.equal(r.loopbackTrace.length,1);assert.equal(r.loopbackTrace[0].method,'POST');
 assert.equal(r.loopbackTrace[0].path,'/api/tbc/broadcasttx');
 assert.equal(r.statusQueries.length,5);assert(r.statusQueries.every(v=>v.length===1));
 // Construction reads run concurrently: assert the exact multiset, not order.
 assert.deepEqual([...r.paths].sort(),['/api/tbc/nodeinfo','/api/tbc/utxo/address/1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH']);
 assert.equal(r.timings.length,3);assert(r.timings.every(v=>v.pageMs>0&&v.approvalToLastSignatureUs>0));
 assert.equal(r.timings.at(-1).reads,2);
 const provenance=JSON.parse(await readFile(join(out,'consumer-provenance.json')));
 const native=await verifiedDartNativeCandidate(provenance.frozen);
 const pageManifest=JSON.parse(await readFile(join(out,'legacy-page-provenance.json')));
 assert.equal(snapshot.pageSha256,pageManifest.sha256);assert.deepEqual(snapshot.kitIdentity,native.kitIdentity);
 const root=platform==='ios'?'platform/ios/Classes':'platform/android/src/main/kotlin/io/tbc/kit/dart';
 async function same(source,destination,transform=false){
  const original=await readFile(join(base,source));sources[source]=sha(original);
  const bytes=transform?legacyConsumerSource(basename(source),pairedNativeSource(basename(source),original,native),native,pageManifest,true):original;
  assert.equal(sha(await readFile(join(out,destination))),sha(bytes),`${platform}:${destination}`);
  if(transform)assert.equal(provenance.candidate[basename(source)],sha(bytes));
 }
 await same('acceptance/legacy/main.dart','lib/main.dart');await same('acceptance/legacy/legacy_edges.dart','lib/legacy_edges.dart');
 await same('acceptance/legacy/dapp.html','assets/dapp.html');
 for(const name of await readdir(join(base,root)))if(name.endsWith(platform==='ios'?'.swift':'.kt'))
  await same(`${root}/${name}`,platform==='ios'?`ios/Runner/${name}`:`android/app/src/main/kotlin/io/tbc/kit/dart/${name}`,true);
 for(const name of platform==='ios'?['AppDelegate.swift','FixtureWallet.swift']:['MainActivity.kt','FixtureWallet.kt'])
  await same(`acceptance/${platform}/${name}`,platform==='ios'?`ios/Runner/${name}`:`android/app/src/main/kotlin/io/tbc/dartkitf1/${name}`,true);
 for(const file of ['native-signing.json','native-transfers.json','reviewed-signing.json','reviewed-material-b.json','crypto-device.json','legacy-message-signing.json'])
  await same(`test/fixtures/${file}`,`assets/${file}`);
 artifacts.push({platform,snapshot:file,device:snapshot.device,consumer:out,artifact:snapshot.artifact,kitIdentity:native.kitIdentity,
  pageSha256:snapshot.pageSha256,checks:expected.length,timings:r.timings,syntheticPosts:1,reviewedStatusQueries:5,
  nativeSignatures:9,nativeCryptoCalls:4,approvals:11});
}
async function tree(dir){for(const e of await readdir(join(base,dir),{withFileTypes:true})){
 const p=`${dir}/${e.name}`;if(e.isDirectory())await tree(p);else sources[p]=sha(await readFile(join(base,p)));
}}
await tree('lib');await tree('runtime');
for(const p of ['tool/collect_legacy_edges.mjs','tool/prepare_consumer.mjs','tool/legacy_consumer.mjs','tool/send_consumer_wire.mjs','tool/snapshot_legacy_device.mjs'])
 sources[p]=sha(await readFile(join(base,p)));
const priorReports=['evidence/f3-maintenance-worker-20261014-e.json','evidence/f3-maintenance-native-20261014-g.json'];
const priorRuntime={};
for(const p of priorReports){
 const b=await readFile(join(base,p)),r=JSON.parse(b);
 for(const [file,hash]of Object.entries(r.sources))if(file.startsWith('lib/')||file.startsWith('runtime/')||file.startsWith('platform/'))
  assert.equal(sha(await readFile(join(base,file))),hash,file+' changed since source gate');
 priorRuntime[p]={sha256:sha(b),status:r.status};
}
const report={status:'LEGACY_REVIEWED_CRYPTO_SEND_PAIRED_DEVICE_PASS',recordedAt:new Date().toISOString(),artifacts,sources,priorRuntime,
 proof:'Both installed Flutter/WebView consumers use the new Legacy channel and shared Dart worker, frozen Rust and Swift/Kotlin native authority. Raw detached signatures and the three-transaction associated bundle match frozen Kit; BIE1 roundtrip and frozen ciphertext decrypt; Reviewed/crypto/message mixed batch has one consent; rejected crypto and cancelled associated review do not use keys. Fresh-document raw signing works. Legacy send produces exact frozen bytes, uses the native journal and one localhost POST, returns historical txid, and retains two construction GETs.',
 fixtureIsolation:'Generated final native HTTP destination is localhost:41878 only. UTXO status replies are the frozen Standard Reviewed fixture and remain necessary checks, one query per reviewed request. All keys are public synthetic scalars. No node traffic or chain acceptance.',
 correction:'First paired attempt omitted the fixture txoStatusRead adapter; required status validation stopped before consent/signing. Added the existing frozen status oracle without changing runtime logic or validation. Failed installed snapshots retained. BIE1 canonical plaintext is base64 and is explicitly decoded to the Legacy UTF-8 projection.',
 performance:'Observations only: iOS simulator Debug versus Android emulator Release,250ms automated consent and harness load. Not a matched regression benchmark or production device latency.',
 pending:['Installed two-child maintenance and cancellation/reopen admission','Scoped private Testnet and confirmation/recovery','Matched performance and Release App increment','Safe partner template,clean install,paired artifacts and full-scope seal'],
 acceptedDeliveryChanged:false,runtimeChanged:false,publicHttp:0,realBroadcasts:0,published:false,goalComplete:false};
await writeFile(resolve(base,output),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({status:report.status,checks:artifacts.map(v=>({platform:v.platform,checks:v.checks,timings:v.timings})),sourceHashes:Object.keys(sources).length,realBroadcasts:0}));
