// Local artifact staging. Never overwrites a frozen package or an existing output.
import assert from 'node:assert/strict';
import {cp,mkdir,readFile,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {join,resolve,relative} from 'node:path';
import {createHash} from 'node:crypto';
import {verifiedKernelCandidate} from './candidate-inputs.mjs';
import {stripAppleDebugSymbols,applePublicLinkFlags,verifyApplePublicAbi} from './portable-apple-binary.mjs';
const [kernelsArg,sdkArg,outArg]=process.argv.slice(2);assert.ok(outArg,'KERNEL_CANDIDATE ANDROID_SDK NEW_OUTPUT');
const kernels=resolve(kernelsArg),sdk=resolve(sdkArg),out=resolve(outArg),source=resolve(import.meta.dirname,'..');
const sha=b=>createHash('sha256').update(b).digest('hex');
const accepted=await verifiedKernelCandidate(kernels);
const targets=['aarch64-linux-android','aarch64-apple-ios','aarch64-apple-ios-sim'],engines={};
for(const target of targets){
  const path=join(kernels,'target',target,'release',target.includes('android')?'libtbc_engine_native.so':'libtbc_engine_native.a');
  const hash=sha(await readFile(path)),record=accepted.evidence.find(e=>e.name==='engine'&&e.target===target);
  assert.equal(hash,record?.sha256,target);engines[target]={path,sha256:hash};
}
const buildInputs={schema:2,engines:Object.fromEntries(targets.map(t=>[t,engines[t].sha256])),
 generatorSha256:sha(await readFile(import.meta.filename)),
 appleStripSha256:sha(await readFile(new URL('./portable-apple-binary.mjs',import.meta.url))),
 bridgeSources:Object.fromEntries(await Promise.all([
  'android/src/main/cpp/engine-jni.cpp','ios/engine/TbcFlutterEngine.mm','ios/engine/TbcFlutterEngine.h',
 ].map(async p=>[p,sha(await readFile(join(source,p)))])))};
const artifactId=sha(JSON.stringify(buildInputs));
await mkdir(out);
await cp(source,out,{recursive:true,filter:p=>!relative(source,p).split('/').some(s=>['.dart_tool','build','.git','node_modules','.symlinks','Pods','.gradle','DerivedData'].includes(s))});
const include=join(kernels,'source/packages/tbc-engine/rust/crates/tbc-engine-native/include');
const libs=join(out,'android/src/main/jniLibs/arm64-v8a');await mkdir(libs,{recursive:true});
await cp(engines['aarch64-linux-android'].path,join(libs,'libtbc_engine_native.so'));
const clang=join(sdk,'ndk/27.1.12297006/toolchains/llvm/prebuilt/darwin-x86_64/bin/aarch64-linux-android23-clang++');
execFileSync(clang,['-std=c++17','-shared','-fPIC','-static-libstdc++',`-DTBC_FLUTTER_ARTIFACT_ID="${artifactId}"`,
  '-I',include,join(source,'android/src/main/cpp/engine-jni.cpp'),'-L',libs,'-ltbc_engine_native',
  '-Wl,--no-undefined','-Wl,-z,max-page-size=16384','-o',join(libs,'libtbc_flutter_engine.so')],{stdio:'inherit'});
const frames=[];
for(const [platform,target,triple]of [['iphoneos','aarch64-apple-ios','arm64-apple-ios15.0'],['iphonesimulator','aarch64-apple-ios-sim','arm64-apple-ios15.0-simulator']]){
  const frame=join(out,'native-build',platform,'TbcFlutterEngine.framework');await mkdir(join(frame,'Headers'),{recursive:true});await mkdir(join(frame,'Modules'));
  await cp(join(source,'ios/engine/TbcFlutterEngine.h'),join(frame,'Headers/TbcFlutterEngine.h'));
  await writeFile(join(frame,'Modules/module.modulemap'),'framework module TbcFlutterEngine { umbrella header "TbcFlutterEngine.h" export * module * { export * } }\n');
  await writeFile(join(frame,'Info.plist'),`<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>io.tbc.flutter.engine</string><key>CFBundleName</key><string>TbcFlutterEngine</string><key>CFBundleExecutable</key><string>TbcFlutterEngine</string><key>CFBundlePackageType</key><string>FMWK</string><key>CFBundleVersion</key><string>1</string></dict></plist>`);
  const sdkPath=execFileSync('xcrun',['--sdk',platform,'--show-sdk-path'],{encoding:'utf8'}).trim();
  const exportFile=join(out,'native-build',platform,'engine.exports');
  const linkFlags=applePublicLinkFlags(exportFile,[join(include,'tbc_engine.h')],['TbcFlutterEngine']);
  execFileSync('xcrun',['--sdk',platform,'clang++','-std=c++17','-fobjc-arc','-dynamiclib','-target',triple,'-isysroot',sdkPath,
    ...linkFlags,
    `-DTBC_FLUTTER_ARTIFACT_ID="${artifactId}"`,'-I',include,'-framework','Foundation','-framework','Security',
    join(source,'ios/engine/TbcFlutterEngine.mm'),engines[target].path,
    '-Wl,-install_name,@rpath/TbcFlutterEngine.framework/TbcFlutterEngine','-o',join(frame,'TbcFlutterEngine')],{stdio:'inherit'});
  verifyApplePublicAbi(join(frame,'TbcFlutterEngine'),exportFile);
  frames.push('-framework',frame);
}
await mkdir(join(out,'ios/Frameworks'),{recursive:true});
execFileSync('xcodebuild',['-create-xcframework',...frames,'-output',join(out,'ios/Frameworks/TbcFlutterEngine.xcframework')],{stdio:'inherit'});
for(const slice of ['ios-arm64','ios-arm64-simulator'])
 stripAppleDebugSymbols(join(out,'ios/Frameworks/TbcFlutterEngine.xcframework',slice,
   'TbcFlutterEngine.framework/TbcFlutterEngine'));
const artifacts={};
for(const path of ['android/src/main/jniLibs/arm64-v8a/libtbc_engine_native.so','android/src/main/jniLibs/arm64-v8a/libtbc_flutter_engine.so',
 'ios/Frameworks/TbcFlutterEngine.xcframework/ios-arm64/TbcFlutterEngine.framework/TbcFlutterEngine',
 'ios/Frameworks/TbcFlutterEngine.xcframework/ios-arm64-simulator/TbcFlutterEngine.framework/TbcFlutterEngine'])artifacts[path]=sha(await readFile(join(out,path)));
await writeFile(join(out,'native-artifacts.json'),JSON.stringify({status:'BUILT_NOT_DEVICE_ACCEPTED',artifactId,buildInputs,engines,artifacts,rustSourceSha256:accepted.rustSourceSha256,
 scope:'keyless Engine plugin only; private Kit VM, WebView, custody and full capability wiring incomplete',
 androidAbi:['arm64-v8a'],androidMinApi:23,iosDeviceDeployment:'15.0',iosSimulatorDeployment:'15.0',realChainAcceptance:false},null,2)+'\n');
console.log(JSON.stringify({out,artifactId,status:'BUILT_NOT_DEVICE_ACCEPTED'}));
