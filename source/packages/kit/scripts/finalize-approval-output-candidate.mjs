// Freeze only a separately tested candidate/evidence directory, never current.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,cp} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const repo=resolve(import.meta.dirname,'../../../..'),root=resolve(process.argv[2]),candidate=join(root,'rc6'),destination=join(repo,'release/candidates/approval-output-rc6');
const hash=b=>createHash('sha256').update(b).digest('hex'),json=async p=>JSON.parse(await readFile(p));
const build=await json(join(candidate,'candidate.json')),checks=await json(join(candidate,'checks.json'));
assert.equal(build.version,'0.1.0-rc.6');assert.equal(checks.status,'PASS_PACKAGED_DIRECTED');
for(const[p,h]of Object.entries(await json(join(candidate,'protected-before.json'))))assert.equal(hash(await readFile(p)),h,p);
for(const[name,h]of [['tbc-kit.tgz','8a4711298ef31fc08cf9d5e0cc24f2896bc04dc48bf34f32d86462ccb71fcfc9'],['tbc-kit-flutter.tgz','f2d2e3681437033965286d217ff3a24a1d91bd7857b3e79685179f97e06818b6']])
 assert.equal(hash(await readFile(join(repo,'release/candidates/approval-display-rc4',name))),h,'Previous candidate changed');
const native=await json(join(candidate,'unpacked/tbc_kit_flutter_dart/distribution.json'));
for(const[p,h]of Object.entries(native.nativeArtifacts))assert.equal(hash(await readFile(join(candidate,'unpacked/tbc_kit_flutter_dart',p))),h,p);
const catalog=await json(join(candidate,'unpacked/package/artifacts/platform-resources.json'));
for(const entry of Object.values(catalog.platforms))for(const[p,h]of Object.entries(entry.files))assert.equal(hash(await readFile(join(candidate,'unpacked',p))),h,p);
const device=await json(join(root,'directed/device-summary-rc5.json'));
for(const r of Object.values(device.results))for(const lang of ['swift','kt'])for(const[name,h]of Object.entries(r.sourceHashes).filter(([p])=>p.endsWith('.'+lang))){
 const relative=lang==='swift'?'ios/Classes':'android/src/main/kotlin/io/tbc/kit/dart';assert.equal(hash(await readFile(join(candidate,'unpacked/tbc_kit_flutter_dart',relative,name))),h,name);
}
const mobile=await json(join(root,'mobile-engine-final/report.json'));assert.equal(mobile.status,'PASS_MOBILE_ENGINE_PARITY');
assert.equal(mobile.libs.candidate.sha256.android,native.androidEngineSha256);
assert.equal(mobile.libs.candidate.sha256.iosBeforeAdhoc,native.nativeArtifacts['ios/Frameworks/TbcFlutterEngine.xcframework/ios-arm64-simulator/TbcFlutterEngine.framework/TbcFlutterEngine']);
await mkdir(destination);
for(const a of build.artifacts){assert.equal(hash(await readFile(join(candidate,a.name))),a.sha256);await mkdir(dirname(join(destination,a.name)),{recursive:true});await cp(join(candidate,a.name),join(destination,a.name));}
for(const[from,to]of [['rc6/candidate.json','candidate.json'],['rc6/checks.json','checks.json'],['compute/build-report.json','engine-build.json'],['compute/native-resources-build.json','native-resources-build.json'],['directed/report.json','source-checks.json'],['directed/device-summary-rc5.json','device-checks.json'],['engine-check/engine-report.json','engine-parity.json'],['mobile-engine-final/report.json','mobile-engine-parity.json'],['rc6/protected-before.json','protected-before.json']])await cp(join(root,from),join(destination,to));
const rust=join(repo,'source/packages/tbc-engine/rust');
for(const[name,args]of [['output-review',['output_review','--lib','--','--nocapture']],['staged-ft-review',['--test','ft','staged_ft_output_review']],['ft-reference-parity',['--test','ft','ft_transfer_inserts_merge_only_when_selected_inputs_require_it']]]){
 const log=execFileSync('cargo',['test','--offline','--locked','-p','tbc-engine-core',...args],{cwd:rust,encoding:'utf8',stdio:['ignore','pipe','pipe'],maxBuffer:4e6});await writeFile(join(destination,name+'.log'),log);
}
const result={status:'PASS_DIRECTED_NOT_PROMOTED',version:build.version,packageChecks:checks.results.length,
 nativePackageFilesVerified:Object.keys(native.nativeArtifacts).length,deviceSourcesEqualPackage:true,engineDeviceOutputsMatchWasm:true,
 protectedCurrentAndPreviousCandidateUnchanged:true,extraNetworkReads:0,approvalCount:1,newBroadcasts:0,
 scope:'Output disclosure, candidate pairing, public-fixture UI replay and actual native Engine planning. Not whole-App real cryptographic signing/real-chain re-acceptance.',
 artifacts:build.artifacts};
await writeFile(join(destination,'verification.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({destination,...result}));
