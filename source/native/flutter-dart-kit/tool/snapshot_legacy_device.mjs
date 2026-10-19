// Capture a bounded public-fixture report with installed-binary identity.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
const [platform,consumer,device,output]=process.argv.slice(2),base=resolve(import.meta.dirname,'..');
assert(['ios','android'].includes(platform));assert.match(consumer,/^\/private\/tmp\/tbc-dart-kit-f3-legacy-(?:ios|android)-\d{8}-[a-z]+$/);
const id='io.tbc.dartkit.legacy',sha=b=>createHash('sha256').update(b).digest('hex');
const run=(c,a)=>execFileSync(c,a,{encoding:'utf8'}).trim();
const provenance=JSON.parse(await readFile(join(consumer,'consumer-provenance.json')));
assert.equal(provenance.bundleId,id);assert.equal(provenance.publicFixtureOnly,true);
let deviceReport,artifact;
if(platform==='android'){
 const adb='/Users/alex/Library/Android/sdk/platform-tools/adb';
 deviceReport=JSON.parse(run(adb,['-s',device,'shell','cat',`/sdcard/Android/data/${id}/files/f1-report.json`]));
 const installed=run(adb,['-s',device,'shell','pm','path',id]);assert.match(installed,/^package:\/data\/app\/[^\s]+\/base.apk$/);
 const binary=await readFile(join(consumer,'build/app/outputs/apk/release/app-release.apk'));
 assert.equal(run(adb,['-s',device,'shell','sha256sum',installed.slice(8)]).split(/\s+/)[0],sha(binary));
 artifact={sha256:sha(binary),bytes:binary.length,mode:'Android arm64 Release',installedVerified:true};
}else{
 const data=run('xcrun',['simctl','get_app_container',device,id,'data']),app=run('xcrun',['simctl','get_app_container',device,id,'app']);
 deviceReport=JSON.parse(await readFile(join(data,'Documents/f1-report.json')));
 const binary=await readFile(join(consumer,'build/ios/iphonesimulator/Runner.app/Runner.debug.dylib'));
 assert.equal(sha(await readFile(join(app,'Runner.debug.dylib'))),sha(binary));
 const seal=JSON.parse(await readFile(join(consumer,'ios-signed-consumer.json')));
 assert.equal(sha(await readFile(join(app,'Frameworks/TbcFlutterEngine.framework/TbcFlutterEngine'))),seal.installedSha256);
 assert.equal(sha(await readFile(join(app,'tbc-webview-page.js'))),provenance.page);
 artifact={sha256:sha(binary),bytes:binary.length,mode:'iOS simulator Debug',installedVerified:true,signedConsumer:seal};
}
assert.equal(deviceReport.broadcasts,0);assert.equal(deviceReport.publicHttp,0);assert.equal(deviceReport.native.publicFixtureOnly,true);
assert(['FAIL','LEGACY_DEVICE_FIRST_PASS','LEGACY_DEVICE_RESTART_PASS','MAINTENANCE_DEVICE_PASS','LEGACY_EDGES_DEVICE_PASS','MAINTENANCE_ROUNDS_DEVICE_PASS'].includes(deviceReport.status));
const report={status:deviceReport.status,recordedAt:new Date().toISOString(),platform,consumer,device,artifact,deviceReport,
 pageSha256:provenance.page,kitIdentity:provenance.kitIdentity,acceptedDeliveryChanged:false,published:false,broadcasts:0};
await writeFile(resolve(base,output),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({status:report.status,output,artifact:artifact.sha256,cases:deviceReport.cases,publicHttp:0,broadcasts:0}));
