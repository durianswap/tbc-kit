// Observe only the independently installed synthetic probe on the named devices.
import assert from 'node:assert/strict';
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {resolve, join} from 'node:path';
import {sha256} from '../../../../packages/kit/scripts/platform-resources.mjs';
import {verifiedKitCandidate} from '../../../flutter/scripts/candidate-inputs.mjs';
const [appArg, sdkArg, candidateArg, iosId, adbArg, serial, outArg] = process.argv.slice(2);
assert.ok(outArg && iosId === 'C2C010B8-4071-4888-9E25-D91BF88EB461' && serial === 'emulator-5554');
const [app, sdk, candidate, adb, out] = [appArg,sdkArg,candidateArg,adbArg,outArg].map(p=>resolve(p));
const json = async p=>JSON.parse(await readFile(p));
const run = (cmd,args)=>execFileSync(cmd,args,{encoding:'utf8',maxBuffer:6*1024*1024});
assert.equal((await json(join(app,'package.json'))).name,'tbc-platform-slim-rn-probe');
const proof=await json(join(app,'probe-provenance.json'));
const bundleId='org.tbc.kit.platformslimprobe';
assert.equal(proof.bundleId,bundleId);
const identity=await json(join(app,'modules/tbc-kit-engine/generated/identity.json'));
assert.equal(identity.artifactSetId,(await json(join(sdk,'identity.json'))).artifactSetId);
const build=await json(join(candidate,'candidate.json'));
assert.equal(sha256(await readFile(join(candidate,build.tarball))),build.tarballSha256);
assert.equal(build.tarballSha256,proof.kitSha256);
const verified=await verifiedKitCandidate(join(app,'node_modules/@tbc/kit'));
assert.equal(verified.artifactId,proof.kitArtifactId);
run(process.execPath,[join(app,'modules/tbc-kit-engine/scripts/sync-native.mjs'),'--check']);
for(const [p,h]of Object.entries(proof.templateHashes))assert.equal(sha256(await readFile(join(app,'modules/tbc-kit-engine',p))),h);
for(const [p,h]of [['App.tsx',proof.appSourceSha256],['vectors.json',proof.coreVectorsSha256],['keyless-vectors.json',proof.keylessVectorsSha256]])
 assert.equal(sha256(await readFile(join(app,p))),h);
const data=run('xcrun',['simctl','get_app_container',iosId,bundleId,'data']).trim();
const ios=await json(join(data,'Documents/keyless-rn-report.json'));
const pid=run(adb,['-s',serial,'shell','pidof',bundleId]).trim();assert.match(pid,/^\d+$/);
const logs=run(adb,['-s',serial,'logcat','--pid='+pid,'-d','-s','ReactNativeJS:I']);
const rows=logs.split('\n').filter(l=>l.includes('TBC_KEYLESS_RN_PROBE_PASS'));
assert.ok(rows.length,'Current Android process has not reported PASS');
const android=JSON.parse(rows.at(-1).slice(rows.at(-1).indexOf('{')));
for(const [platform,r]of Object.entries({ios,android})){
 assert.equal(r.marker,'TBC_KEYLESS_RN_PROBE_PASS');assert.equal(r.platform,platform);
 assert.equal(r.hermes,true);assert.deepEqual(r.proof,proof);assert.deepEqual(r.identity,identity);
 assert.equal(r.engineVectors,8);assert.equal(r.keylessVectors,proof.keylessVectors);
 assert.equal(r.keylessPositive,proof.keylessPositive);
 assert.equal(r.keylessErrorRejections,proof.keylessVectors-proof.keylessPositive);
 assert.equal(r.concurrent,16);assert.equal(r.operations,10);
 assert.equal(r.nativeUnsupportedRejected,true);assert.equal(r.fetches,0);assert.equal(r.broadcasts,0);
}
const appName='TBCPlatformSlimProbe';
const builtIos=join(app,'DerivedData/Build/Products/Release-iphonesimulator',appName+'.app');
const installedIos=run('xcrun',['simctl','get_app_container',iosId,bundleId,'app']).trim();
const iosHashes={};
for(const p of [appName,'main.jsbundle']){
 iosHashes[p]=sha256(await readFile(join(builtIos,p)));
 assert.equal(sha256(await readFile(join(installedIos,p))),iosHashes[p]);
}
const apk=join(app,'android/app/build/outputs/apk/release/app-release.apk');
const apkSha256=sha256(await readFile(apk));
const apkPath=run(adb,['-s',serial,'shell','pm','path',bundleId]).trim();
assert.match(apkPath,/^package:\/data\/app\/[^\n]+\/base\.apk$/);
await mkdir(out);
run(adb,['-s',serial,'pull',apkPath.slice(8),join(out,'installed-base.apk')]);
assert.equal(sha256(await readFile(join(out,'installed-base.apk'))),apkSha256);
await writeFile(join(out,'ios-runtime.json'),JSON.stringify(ios,null,2)+'\n');
await writeFile(join(out,'android-runtime.json'),JSON.stringify(android,null,2)+'\n');
await writeFile(join(out,'android-runtime.log'),logs);
const report={status:'PASS_INSTALLED_SPLIT_KIT_RN_HERMES_BOTH',identity,proof,kit:verified,
 ios:{udid:iosId,hashes:iosHashes,elapsedMs:ios.elapsedMs},android:{serial,pid,apkSha256,elapsedMs:android.elapsedMs},
 engineVectors:8,keylessVectors:proof.keylessVectors,concurrentPerPlatform:16,
 templatePatched:false,networkRequests:0,broadcasts:0,existingWalletChanged:false,
 realCustody:false,realChain:false,physicalDevice:false,scope:'Fresh Expo/RN release synthetic calculation bridge; not wallet transaction latency',
 verifierSha256:sha256(await readFile(import.meta.filename))};
await writeFile(join(out,'report.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({out,status:report.status,ios:report.ios,android:report.android}));
