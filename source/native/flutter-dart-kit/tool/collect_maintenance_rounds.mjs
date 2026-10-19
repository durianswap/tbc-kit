// Actual installed multi-child custody, using only synthetic index and HTTP.
import assert from 'node:assert/strict';
import {readFile,writeFile,readdir} from 'node:fs/promises';
import {join,resolve,basename} from 'node:path';
import {createHash} from 'node:crypto';
import {legacyConsumerSource} from './legacy_consumer.mjs';
import {verifiedDartNativeCandidate,pairedNativeSource} from '../../contract173-upgrade/dart-native-candidate.mjs';
const base=resolve(import.meta.dirname,'..'),[iosFile,androidFile,output]=process.argv.slice(2);
assert(iosFile&&androidFile&&output);
const sha=b=>createHash('sha256').update(b).digest('hex'),sources={};
const expected=['maintenance-overlap-denied-no-extra-read-or-consent','maintenance-navigation-cancels-held-parent',
 'maintenance-two-native-children-accepted-parent-one-consent','maintenance-legacy-sees-completed-index-without-signing',
 'maintenance-wallet-reopen-fresh-session-no-resubmission'];
const artifacts=[];
let firstTransactions;
for(const [platform,file]of [['ios',iosFile],['android',androidFile]]){
 const snapshot=JSON.parse(await readFile(resolve(base,file))),r=snapshot.deviceReport,out=snapshot.consumer;
 assert.equal(snapshot.platform,platform);assert.equal(snapshot.status,'MAINTENANCE_ROUNDS_DEVICE_PASS');
 assert.equal(snapshot.artifact.installedVerified,true);assert.deepEqual(r.cases,expected);
 assert.deepEqual(r.wireFailures,[]);assert.equal(r.publicHttp,0);assert.equal(r.broadcasts,0);
 assert.equal(r.native.publicFixtureOnly,true);assert.equal(r.native.broadcasts,0);
 assert.equal(r.native.approvals,4);assert.equal(r.native.signatures,102);assert.equal(r.native.cryptoCalls,0);
 assert.equal(r.loopbackTrace.length,2);assert(r.loopbackTrace.every(r=>r.method==='POST'&&r.path==='/api/tbc/broadcasttx'));
 assert.deepEqual(r.loopbackTrace.map(v=>v.inputCount),[100,2]);
 assert.deepEqual(r.loopbackTrace.map(v=>v.remainingUtxos),[2,1]);
 assert.deepEqual(r.loopbackTrace[1].dependsOn,[r.loopbackTrace[0].txid]);
 assert(r.loopbackTrace.every(v=>BigInt(v.fee)>0n&&/^[a-f0-9]{64}$/.test(v.rawSha256)));
 if(firstTransactions)assert.deepEqual(r.loopbackTrace,firstTransactions,'Same native signed transactions on both platforms');
 else firstTransactions=r.loopbackTrace;
 assert.equal(r.paths.length,8);
 assert.equal(r.paths.filter(v=>v.endsWith('/nodeinfo')).length,3);
 assert.equal(r.paths.filter(v=>v.includes('/utxo/address/')).length,5);
 assert.equal(r.timings.length,1);assert.equal(r.timings[0].reads,5);
 assert(r.timings[0].pageMs>0&&r.timings[0].approvalToLastSignatureUs>0);
 const provenance=JSON.parse(await readFile(join(out,'consumer-provenance.json')));
 const native=await verifiedDartNativeCandidate(provenance.frozen);
 const pageManifest=JSON.parse(await readFile(join(out,'legacy-page-provenance.json')));
 assert.equal(snapshot.pageSha256,pageManifest.sha256);assert.deepEqual(snapshot.kitIdentity,native.kitIdentity);
 async function same(source,destination,transform=false){
  const original=await readFile(join(base,source));sources[source]=sha(original);
  const bytes=transform?legacyConsumerSource(basename(source),pairedNativeSource(basename(source),original,native),native,pageManifest,true):original;
  assert.equal(sha(await readFile(join(out,destination))),sha(bytes),`${platform}:${destination}`);
  if(transform)assert.equal(provenance.candidate[basename(source)],sha(bytes));
 }
 for(const f of ['main.dart','legacy_edges.dart','maintenance_rounds.dart'])await same(`acceptance/legacy/${f}`,`lib/${f}`);
 await same('acceptance/legacy/dapp.html','assets/dapp.html');
 const root=platform==='ios'?'platform/ios/Classes':'platform/android/src/main/kotlin/io/tbc/kit/dart';
 for(const name of await readdir(join(base,root)))if(name.endsWith(platform==='ios'?'.swift':'.kt'))
  await same(`${root}/${name}`,platform==='ios'?`ios/Runner/${name}`:`android/app/src/main/kotlin/io/tbc/kit/dart/${name}`,true);
 for(const name of platform==='ios'?['AppDelegate.swift','FixtureWallet.swift']:['MainActivity.kt','FixtureWallet.kt'])
  await same(`acceptance/${platform}/${name}`,platform==='ios'?`ios/Runner/${name}`:`android/app/src/main/kotlin/io/tbc/dartkitf1/${name}`,true);
 for(const f of ['native-signing.json','native-transfers.json'])await same(`test/fixtures/${f}`,`assets/${f}`);
 artifacts.push({platform,snapshot:file,device:snapshot.device,consumer:out,artifact:snapshot.artifact,kitIdentity:native.kitIdentity,
  pageSha256:snapshot.pageSha256,checks:expected.length,timings:r.timings,transactions:r.loopbackTrace,syntheticPosts:2,signatures:102});
}
async function tree(dir){for(const e of await readdir(join(base,dir),{withFileTypes:true})){
 const p=`${dir}/${e.name}`;if(e.isDirectory())await tree(p);else sources[p]=sha(await readFile(join(base,p)));
}}
await tree('lib');await tree('runtime');
for(const p of ['tool/collect_maintenance_rounds.mjs','tool/prepare_consumer.mjs','tool/legacy_consumer.mjs','tool/send_consumer_wire.mjs','tool/snapshot_legacy_device.mjs'])
 sources[p]=sha(await readFile(join(base,p)));
const prior='evidence/f3-legacy-edges-paired-device-20261014-a.json',priorBytes=await readFile(join(base,prior)),edges=JSON.parse(priorBytes);
for(const [p,h]of Object.entries(edges.sources))if(p.startsWith('lib/')||p.startsWith('runtime/')||p.startsWith('platform/'))
 assert.equal(sha(await readFile(join(base,p))),h,p+' production source changed since edges proof');
const report={status:'MAINTENANCE_TWO_CHILD_ADMISSION_REOPEN_PAIRED_DEVICE_PASS',recordedAt:new Date().toISOString(),artifacts,sources,
 unchangedRuntimeEvidence:{report:prior,sha256:sha(priorBytes)},
 proof:'Installed Standard maintenance extension rejects an overlapping same-document request without added read/consent. Navigation cancels the held parent without signing/POST. Fresh session then completes two child transactions,100+2inputs,102real native fixture signatures,one bounded approval. First transaction equals frozen Kit bytes; second consumes the accepted first change and remaining fragment,with owner/quantity/fee conservation checks and equal signed-byte hashes across iOS/Android. Native attests aggregate txids,dependency and cumulative fee. Legacy alias sees the same completed index without consent/sign/POST. Wallet object/view recreation restores durable grants with a fresh session and does not automatically resubmit.',
 readProof:'Successful two-round run has3fresh UTXO index GETs+2tip GETs,matching prior worker bound;no parent GETs. Held/cancelled run2GETs,overlap0,Legacy noop1GET. One native journal POST per signed child;synthetic index changes only after matching submitted transactions.',
 limitations:'Public scalar-one signatures and localhost HTTP,not real-chain or partner Vault proof. First child is an exact frozen oracle; second has structural/native binding and paired-byte proof,not an independent general script-VM proof. Reopen is wallet/view recreation within a process,not OS restart. Existing separate Legacy process-restart proof retained. Timing is simulator/emulator observation with250ms test approval,not matched performance/Release increment.',
 pending:['Scoped private Testnet confirmation/recovery','Matched timing and Release App increment','Safe partner template,clean install,paired artifacts and full-scope seal'],
 acceptedDeliveryChanged:false,runtimeChanged:false,publicHttp:0,realBroadcasts:0,published:false,goalComplete:false};
await writeFile(resolve(base,output),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({status:report.status,checks:artifacts.map(v=>({platform:v.platform,checks:v.checks,timings:v.timings})),sourceHashes:Object.keys(sources).length,realBroadcasts:0}));
