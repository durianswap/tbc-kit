// Collect only the isolated no-broadcast, two-process network acceptance App.
import assert from 'node:assert/strict';
import {readFile,readdir,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {resolve,join,relative} from 'node:path';
import {createHash} from 'node:crypto';
import {verifiedDartNativeCandidate,pairedNativeSource} from '../../contract173-upgrade/dart-native-candidate.mjs';
const [platform,path,device,output]=process.argv.slice(2),base=resolve(import.meta.dirname,'..'),out=resolve(path);
assert(['ios','android'].includes(platform));assert.match(out,/^\/private\/tmp\/tbc-dart-kit-f3-contract173-(?:ios|android)-network-[a-z]+$/);assert(output);
const sha=b=>createHash('sha256').update(b).digest('hex'),run=(c,a)=>execFileSync(c,a,{encoding:'utf8'}).trim();
const bundleId='io.tbc.dartkit.network',p=JSON.parse(await readFile(join(out,'consumer-provenance.json')));
assert.equal(p.bundleId,bundleId);assert.equal(p.platform,platform);assert.equal(p.publicFixtureOnly,true);
assert.equal(JSON.parse(await readFile(join(out,'assets/acceptance-profile.json'))).name,'network');
const native=await verifiedDartNativeCandidate(p.frozen);assert.deepEqual(p.kitIdentity,native.kitIdentity);assert.equal(p.reviewed.artifact,native.artifactId);
const sources={};
async function same(source,target,transform=false){const b=await readFile(join(base,source));sources[source]=sha(b);assert.equal(sha(await readFile(join(out,target))),sha(transform?pairedNativeSource(source.split('/').at(-1),b,native):b),source);}
await same('acceptance/network/main.dart','lib/main.dart');await same('acceptance/network/dapp.html','assets/dapp.html');
const root=platform==='ios'?'platform/ios/Classes':'platform/android/src/main/kotlin/io/tbc/kit/dart';
for(const name of await readdir(join(base,root))){if(!name.endsWith(platform==='ios'?'.swift':'.kt'))continue;await same(root+'/'+name,platform==='ios'?'ios/Runner/'+name:'android/app/src/main/kotlin/io/tbc/kit/dart/'+name,true);}
for(const name of platform==='ios'?['AppDelegate.swift','FixtureWallet.swift']:['MainActivity.kt','FixtureWallet.kt']){
 const source=(name.startsWith('Fixture')?`acceptance/${platform}/`:`acceptance/network/${platform}/`)+name;
 await same(source,platform==='ios'?'ios/Runner/'+name:'android/app/src/main/kotlin/io/tbc/dartkitf1/'+name,true);
}
async function tree(path){for(const e of await readdir(path,{withFileTypes:true})){const f=join(path,e.name);if(e.isDirectory())await tree(f);else if(e.isFile())sources[relative(base,f)]=sha(await readFile(f));}}
await tree(join(base,'lib'));
let phases,artifact;
if(platform==='ios'){
 const data=run('xcrun',['simctl','get_app_container',device,bundleId,'data']),app=run('xcrun',['simctl','get_app_container',device,bundleId,'app']);
 phases=await Promise.all([1,2].map(async n=>JSON.parse(await readFile(join(data,`Documents/network-phase-${n}.json`)))));
 const seal=JSON.parse(await readFile(join(out,'ios-signed-consumer.json')));assert.equal(seal.artifactId,native.artifactId);
 assert.equal(sha(await readFile(join(app,'Frameworks/TbcFlutterEngine.framework/TbcFlutterEngine'))),seal.installedSha256);
 const binary=await readFile(join(out,'build/ios/iphonesimulator/Runner.app/Runner.debug.dylib'));
 assert.equal(sha(await readFile(join(app,'Runner.debug.dylib'))),sha(binary));
 artifact={sha256:sha(binary),bytes:binary.length,mode:'iOS simulator Debug',installedVerified:true,signedConsumer:seal};
}else{
 const adb=join(process.env.ANDROID_HOME??'/Users/alex/Library/Android/sdk','platform-tools/adb');
 phases=[1,2].map(n=>JSON.parse(run(adb,['-s',device,'shell','cat',`/sdcard/Android/data/${bundleId}/files/network-phase-${n}.json`])));
 const installed=run(adb,['-s',device,'shell','pm','path',bundleId]);assert.match(installed,/^package:\/data\/app\/[^\s]+\/base.apk$/);
 const apk=await readFile(join(out,'build/app/outputs/apk/release/app-release.apk'));
 assert.equal(run(adb,['-s',device,'shell','sha256sum',installed.slice(8)]).split(/\s+/)[0],sha(apk));
 artifact={sha256:sha(apk),bytes:apk.length,mode:'Android arm64 Release, test-only debug certificate',installedVerified:true};
}
assert.equal(phases[0].status,'NETWORK_DEVICE_FIRST_PASS');assert.equal(phases[1].status,'NETWORK_DEVICE_RESTART_PASS');assert.notEqual(phases[0].pid,phases[1].pid);
const required=[['native-sqlite-second-lane-rollback','discovery-inactive-capability-and-endpoint-isolation','one-approval-atomic-two-network-grant','per-document-switch-noop-reject-and-signer','transaction-read-source-routing-fails-before-key-use','switch-cancels-late-signer-before-key-use','navigation-cancels-group-approval','lock-unlock-peer-refresh','fresh-group-grant-ready-for-process-restart'],['native-sqlite-second-lane-rollback','process-restart-durable-grants-fresh-session','both-network-revoke-propagates']];
for(let i=0;i<2;i++){
 const r=phases[i];assert.equal(r.phase,i+1);assert.deepEqual(r.cases,required[i]);assert.equal(r.publicHttp,0);assert.equal(r.broadcasts,0);assert.equal(r.native.broadcasts,0);assert.equal(r.native.publicFixtureOnly,true);assert.equal(r.native.nativeSQLiteRollback,true);assert.equal(r.native.heldSigners,0);
}
assert(phases[0].readAdapters.some(r=>r.chainId==='tbc:mainnet'));assert(phases[0].readAdapters.some(r=>r.chainId==='tbc:testnet'));assert.equal(phases[1].readAdapters.length,0);
const report={status:'NETWORK_INSTALLED_CONSUMER_PASS',recordedAt:new Date().toISOString(),platform,device,consumer:out,bundleId,kitIdentity:native.kitIdentity,nativeArtifact:native.artifactId,artifact,phases,sources,
 proof:'Installed Flutter/WebView -> production Dart Provider/binding -> native router/custody -> system SQLite/native public-fixture signer. Two actual processes; grouped grants durable, active document sessions fresh. Failed read adapters prove selected source routing, not chain-data correctness. No real node/transaction broadcast or performance-regression claim.',acceptedDeliveryChanged:false,published:false,broadcasts:0};
await writeFile(resolve(base,output),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({status:report.status,platform,checks:phases.map(r=>r.cases.length),nativeArtifact:native.artifactId,artifact:artifact.sha256,broadcasts:0}));
