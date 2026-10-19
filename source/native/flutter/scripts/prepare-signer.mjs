// Optional signer artifacts only. Never add custody to Engine or overwrite a candidate.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,cp} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {verifiedKernelCandidate} from './candidate-inputs.mjs';
import {stripAppleDebugSymbols,applePublicLinkFlags,verifyApplePublicAbi} from './portable-apple-binary.mjs';
const [kernelsArg,outArg]=process.argv.slice(2);
assert.ok(outArg,'VERIFIED_KERNEL_CANDIDATE NEW_OUTPUT');
const kernels=resolve(kernelsArg),out=resolve(outArg),root=resolve(import.meta.dirname,'../../..');
const sha=b=>createHash('sha256').update(b).digest('hex');
const accepted=await verifiedKernelCandidate(kernels);
const targets=[['aarch64-linux-android','arm64-v8a'],['armv7-linux-androideabi','armeabi-v7a'],['x86_64-linux-android','x86_64'],['aarch64-apple-ios'],['aarch64-apple-ios-sim']];
const inputs={};
for(const [target]of targets){
 const p=join(kernels,'target',target,'release',target.includes('android')?'libtbc_signer_kernel.so':'libtbc_signer_kernel.a');
 const hash=sha(await readFile(p));assert.equal(hash,accepted.evidence.find(e=>e.name==='signer'&&e.target===target)?.sha256);
 inputs[target]={path:p,sha256:hash};
}
await mkdir(out);const artifacts={},frames=[];
for(const [target,abi]of targets.filter(([t])=>t.includes('android'))){
 const relative=`android/jniLibs/${abi}/libtbc_signer_kernel.so`;
 await mkdir(join(out,'android/jniLibs',abi),{recursive:true});await cp(inputs[target].path,join(out,relative));artifacts[relative]=inputs[target].sha256;
}
const header=join(kernels,'source/native/signer/kernel/include/tbc_signer_kernel.h');
for(const [sdk,target,triple]of [['iphoneos','aarch64-apple-ios','arm64-apple-ios15.0'],['iphonesimulator','aarch64-apple-ios-sim','arm64-apple-ios15.0-simulator']]){
 const frame=join(out,'build',sdk,'TbcFlutterSigner.framework');
 await mkdir(join(frame,'Headers'),{recursive:true});await mkdir(join(frame,'Modules'));
 await cp(header,join(frame,'Headers/tbc_signer_kernel.h'));
 await writeFile(join(frame,'Modules/module.modulemap'),'framework module TbcFlutterSigner { umbrella header "tbc_signer_kernel.h" export * module * { export * } }\n');
 await writeFile(join(frame,'Info.plist'),'<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>io.tbc.flutter.signer</string><key>CFBundleName</key><string>TbcFlutterSigner</string><key>CFBundleExecutable</key><string>TbcFlutterSigner</string><key>CFBundlePackageType</key><string>FMWK</string><key>CFBundleVersion</key><string>1</string></dict></plist>');
 const sdkPath=execFileSync('xcrun',['--sdk',sdk,'--show-sdk-path'],{encoding:'utf8'}).trim();
 const binary=join(frame,'TbcFlutterSigner');
 const exportFile=join(out,'build',sdk,'signer.exports');
 const linkFlags=applePublicLinkFlags(exportFile,[header,join(kernels,'source/native/signer/kernel/include/tbc_signer_musig.h')]);
 execFileSync('xcrun',['--sdk',sdk,'clang','-dynamiclib','-target',triple,'-isysroot',sdkPath,
  ...linkFlags,
  `-Wl,-force_load,${inputs[target].path}`,'-framework','Security','-framework','CoreFoundation','-liconv','-lresolv',
  '-Wl,-install_name,@rpath/TbcFlutterSigner.framework/TbcFlutterSigner','-o',binary],{stdio:'pipe'});
 const symbols=execFileSync('xcrun',['nm','-gU',binary],{encoding:'utf8',maxBuffer:8*1024*1024});
 for(const symbol of ['tbc_signer_kernel_version','tbc_signer_sign_digest','tbc_signer_bie1','tbc_signer_buffer_new','tbc_signer_buffer_free',
  'tbc_signer_musig_version','tbc_signer_musig_aggregate_key','tbc_signer_musig_buffer_new','tbc_signer_musig_buffer_free',
  'tbc_signer_musig_begin','tbc_signer_musig_sign','tbc_signer_musig_cancel','tbc_signer_musig_combine'])assert.ok(symbols.includes('_'+symbol));
 verifyApplePublicAbi(binary,exportFile);
 frames.push('-framework',frame);
}
await mkdir(join(out,'ios'));
execFileSync('xcodebuild',['-create-xcframework',...frames,'-output',join(out,'ios/TbcFlutterSigner.xcframework')],{stdio:'pipe'});
for(const slice of ['ios-arm64','ios-arm64-simulator']){
 const p=`ios/TbcFlutterSigner.xcframework/${slice}/TbcFlutterSigner.framework/TbcFlutterSigner`;
 stripAppleDebugSymbols(join(out,p));artifacts[p]=sha(await readFile(join(out,p)));
}
const dartSources={};
for(const p of ['lib/signer.dart','lib/src/native_digest_signer.dart','lib/src/native_bie1_crypto.dart','lib/src/native_musig_signer.dart',
 'lib/src/approved_musig_participant.dart','lib/src/digest_custody.dart','lib/src/cooperative_custody.dart',
 'lib/src/reviewed_custody.dart','lib/src/crypto_custody.dart','lib/src/formal_approval.dart','lib/src/host_environment.dart',
 'lib/src/ecdsa_signature.dart','lib/src/private_runtime.dart','lib/src/webview_scope.dart','lib/src/private_host_channel.dart','pubspec.yaml','pubspec.lock'])dartSources[p]=sha(await readFile(join(root,'native/flutter',p)));
const artifactId=sha(JSON.stringify({inputs,artifacts,dartSources}));
await writeFile(join(out,'signer-artifacts.json'),JSON.stringify({status:'BUILT_NOT_DEVICE_ACCEPTED',artifactId,inputs,artifacts,dartSources,
 generatorSha256:sha(await readFile(import.meta.filename)),appleStripSha256:sha(await readFile(new URL('./portable-apple-binary.mjs',import.meta.url))),abi:1,androidMinApi:23,androidAbis:['arm64-v8a','armeabi-v7a','x86_64'],
 iosDeviceDeployment:'15.0',iosArmSimulatorDeployment:'15.0',flutterRuntimeOtherAbis:false,
 limitations:['Optional binary addon; consumer must explicitly link/embed and verify matching artifacts before loading.',
 'Build/link is not Flutter device, old-OS whole-App or partner-Vault acceptance.','No keys, accounts, grants or approval defaults are included.']},null,2)+'\n');
console.log(JSON.stringify({out,artifactId,status:'BUILT_NOT_DEVICE_ACCEPTED'}));
