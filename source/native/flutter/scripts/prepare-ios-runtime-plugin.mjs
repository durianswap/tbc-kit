// Stage a new local iOS runtime candidate. Existing Engine/VM candidates stay immutable.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,cp,readdir} from 'node:fs/promises';
import {execFileSync,spawnSync} from 'node:child_process';
import {resolve,join,relative} from 'node:path';
import {createHash} from 'node:crypto';
import {verifiedSignerAddon} from './signer-addon.mjs';
import {verifiedRuntimePayload,hermesDebuggerFlags,runtimePayloadDefines} from './runtime-payload.mjs';
import {verifiedWebViewPage} from './webview-page-payload.mjs';
import {verifiedKernelCandidate} from './candidate-inputs.mjs';
import {stripAppleDebugSymbols,applePublicLinkFlags,verifyApplePublicAbi} from './portable-apple-binary.mjs';
const args=process.argv.slice(2);assert.ok([5,6].includes(args.length),'ENGINE_PLUGIN RUNTIME_RESOURCE APPLE_HERMES KERNELS NEW_PLUGIN [SIGNER_ADDON]');
const [base,resource,hermes,kernels,out]=args.map(p=>resolve(p));
const source=resolve(import.meta.dirname,'..'),root=resolve(source,'../..'),sha=b=>createHash('sha256').update(b).digest('hex');
const signer=await verifiedSignerAddon(args[5],source);
const engine=JSON.parse(await readFile(join(base,'native-artifacts.json')));
for(const [p,h]of Object.entries(engine.artifacts))assert.equal(sha(await readFile(join(base,p))),h,p);
const vm=JSON.parse(await readFile(join(resource,'runtime-provenance.json')));
assert.equal(sha(await readFile(join(resource,'private-kit.js'))),vm.sourceSha256);
const executionPayload=await verifiedRuntimePayload(resource,vm);
const page=await verifiedWebViewPage(process.env.TBC_FLUTTER_WEBVIEW_PAGE_DIR,vm,
  process.env.TBC_FLUTTER_KIT_CANDIDATE_DIR);
const kernelCandidate=await verifiedKernelCandidate(kernels),accepted=kernelCandidate.evidence;
assert.equal(engine.rustSourceSha256,kernelCandidate.rustSourceSha256,'Engine/kernel source mismatch');
assert.equal(vm.kitIdentity?.rustSourceSha256,kernelCandidate.rustSourceSha256,'Kit/kernel source mismatch');
const targets=[['iphoneos','aarch64-apple-ios','arm64-apple-ios15.0'],['iphonesimulator','aarch64-apple-ios-sim','arm64-apple-ios15.0-simulator']];
const libraries={};
if(page)libraries.webViewPage=page.identity;
if(signer)libraries.signerAddon=signer.manifestSha256;
for(const [sdk,target]of targets){
  const path=join(kernels,'target',target,'release/libtbc_keyless_native.a');
  const hash=sha(await readFile(path));assert.equal(hash,accepted.find(r=>r.name==='keyless'&&r.target===target)?.sha256);
  libraries[sdk]={keyless:hash,hermes:sha(await readFile(join(hermes,`build-${sdk}/API/hermes/hermes.framework/hermes`)))};
}
// Pin the platform bridge and Dart adapter as well as the VM resource. A
// wrapper-only fix must not retain the identity of an earlier candidate.
const sourceHashes={};
async function hashSources(directory){
  for(const entry of (await readdir(join(source,directory),{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
    const p=join(directory,entry.name);
    if(entry.isDirectory())await hashSources(p);
    else if(entry.isFile())sourceHashes[p]=sha(await readFile(join(source,p)));
  }
}
for(const directory of ['lib','ios/Classes','ios/runtime','runtime/native'])await hashSources(directory);
for(const p of ['pubspec.yaml','ios/tbc_kit_flutter.podspec','scripts/prepare-ios-runtime-plugin.mjs','scripts/portable-apple-binary.mjs','scripts/signer-addon.mjs','scripts/runtime-payload.mjs','scripts/webview-page-payload.mjs','scripts/webview-source-identity.mjs'])sourceHashes[p]=sha(await readFile(join(source,p)));
const artifactId=sha(JSON.stringify({runtime:vm.sourceSha256,executionPayload,engine:engine.artifactId,libraries,sourceHashes}));
await mkdir(out);
const filter=p=>!p.split('/').some(s=>['node_modules','.dart_tool','build','.git','native-build','.symlinks','Pods','.gradle','DerivedData'].includes(s));
await cp(base,out,{recursive:true,filter});await cp(source,out,{recursive:true,filter});
async function run(name,command,argv){
  const result=spawnSync(command,argv,{encoding:'utf8',maxBuffer:32*1024*1024});
  await writeFile(join(out,`${name}.log`),String(result.stdout??'')+String(result.stderr??''));
  assert.equal(result.status,0,`${name} failed; inspect retained log`);
}
const runtimeFrames=[],hermesFrames=[];
for(const [sdk,target,triple]of targets){
  const frame=join(out,'native-build',sdk,'TbcFlutterRuntime.framework');
  await mkdir(join(frame,'Headers'),{recursive:true});await mkdir(join(frame,'Modules'));
  await cp(join(source,'ios/runtime/TbcFlutterRuntime.h'),join(frame,'Headers/TbcFlutterRuntime.h'));
  await writeFile(join(frame,'Modules/module.modulemap'),'framework module TbcFlutterRuntime { umbrella header "TbcFlutterRuntime.h" export * module * { export * } }\n');
  await writeFile(join(frame,'Info.plist'),'<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>io.tbc.flutter.runtime</string><key>CFBundleName</key><string>TbcFlutterRuntime</string><key>CFBundleExecutable</key><string>TbcFlutterRuntime</string><key>CFBundlePackageType</key><string>FMWK</string><key>CFBundleVersion</key><string>1</string></dict></plist>');
  await cp(join(resource,executionPayload.file),join(frame,executionPayload.file));
  if(page){
    await writeFile(join(frame,page.identity.file),page.bytes);
    await writeFile(join(frame,'page-provenance.json'),page.manifestBytes);
  }
  const sdkPath=execFileSync('xcrun',['--sdk',sdk,'--show-sdk-path'],{encoding:'utf8'}).trim();
  const hermesRoot=join(hermes,`build-${sdk}/API/hermes`);
  const debuggerFlags=await hermesDebuggerFlags(join(hermes,`build-${sdk}`));
  const filePrefixFlags=[[hermes,'hermes'],[source,'flutter'],[kernels,'kernels']]
    .map(([path,label])=>`-ffile-prefix-map=${path}=${label}`);
  const exportFile=join(out,'native-build',sdk,'runtime.exports');
  const linkFlags=applePublicLinkFlags(exportFile,[join(kernels,'source/packages/tbc-engine/rust/crates/tbc-keyless-native/include/tbc_keyless.h')],['TbcFlutterRuntime']);
  await run(`runtime-${sdk}`,'xcrun',['--sdk',sdk,'clang++','-std=c++17','-fobjc-arc','-dynamiclib','-target',triple,'-isysroot',sdkPath,...filePrefixFlags,...debuggerFlags,...runtimePayloadDefines(executionPayload),
    ...linkFlags,
    `-DTBC_FLUTTER_RUNTIME_ID="${artifactId}"`,`-DTBC_FLUTTER_RUNTIME_SOURCE_SHA256="${vm.sourceSha256}"`,
    '-I',join(hermes,'source/API'),'-I',join(hermes,'source/public'),'-I',join(hermes,'jsi'),
    '-I',join(kernels,'source/packages/tbc-engine/rust/crates/tbc-keyless-native/include'),
    '-F',hermesRoot,'-framework','hermes','-framework','Foundation','-framework','Security',
    join(source,'ios/runtime/TbcFlutterRuntime.mm'),join(kernels,`target/${target}/release/libtbc_keyless_native.a`),
    '-Wl,-install_name,@rpath/TbcFlutterRuntime.framework/TbcFlutterRuntime','-Wl,-rpath,@loader_path/..','-o',join(frame,'TbcFlutterRuntime')]);
  verifyApplePublicAbi(join(frame,'TbcFlutterRuntime'),exportFile);
  runtimeFrames.push('-framework',frame);hermesFrames.push('-framework',join(hermesRoot,'hermes.framework'));
}
await run('runtime-xcframework','xcodebuild',['-create-xcframework',...runtimeFrames,'-output',join(out,'ios/Frameworks/TbcFlutterRuntime.xcframework')]);
for(const slice of ['ios-arm64','ios-arm64-simulator'])
 stripAppleDebugSymbols(join(out,'ios/Frameworks/TbcFlutterRuntime.xcframework',slice,
   'TbcFlutterRuntime.framework/TbcFlutterRuntime'));
await run('hermes-xcframework','xcodebuild',['-create-xcframework',...hermesFrames,'-output',join(out,'ios/Frameworks/hermes.xcframework')]);
for(const slice of ['ios-arm64','ios-arm64-simulator'])
 stripAppleDebugSymbols(join(out,'ios/Frameworks/hermes.xcframework',slice,'hermes.framework/hermes'));
const podspec=join(out,'ios/tbc_kit_flutter.podspec');
await writeFile(podspec,(await readFile(podspec,'utf8')).replace("s.vendored_frameworks = 'Frameworks/TbcFlutterEngine.xcframework'","s.vendored_frameworks = 'Frameworks/TbcFlutterEngine.xcframework', 'Frameworks/TbcFlutterRuntime.xcframework', 'Frameworks/hermes.xcframework'"+(signer?", 'Frameworks/TbcFlutterSigner.xcframework'":"")));
if(signer){await cp(join(signer.path,'ios/TbcFlutterSigner.xcframework'),join(out,'ios/Frameworks/TbcFlutterSigner.xcframework'),{recursive:true});await cp(join(signer.path,'signer-artifacts.json'),join(out,'signer-artifacts.json'));}
const artifacts={};
for(const slice of ['ios-arm64','ios-arm64-simulator']){
 const p=`ios/Frameworks/TbcFlutterRuntime.xcframework/${slice}/TbcFlutterRuntime.framework/${executionPayload.file}`;
 artifacts[p]=sha(await readFile(join(out,p)));assert.equal(artifacts[p],executionPayload.sha256);
 if(page)for(const [file,expected] of [[page.identity.file,page.identity.sha256],['page-provenance.json',page.identity.provenanceSha256]]){
   const rel=`ios/Frameworks/TbcFlutterRuntime.xcframework/${slice}/TbcFlutterRuntime.framework/${file}`;
   artifacts[rel]=sha(await readFile(join(out,rel)));assert.equal(artifacts[rel],expected);
 }
}
for(const slice of ['ios-arm64','ios-arm64-simulator'])for(const name of ['TbcFlutterRuntime','hermes',...(signer?['TbcFlutterSigner']:[])]){
  const p=`ios/Frameworks/${name}.xcframework/${slice}/${name}.framework/${name}`;artifacts[p]=sha(await readFile(join(out,p)));
}
// The staged podspec intentionally adds the private frameworks. Record the
// actual consumer-facing bytes separately from the input source identity.
const stagedSourceHashes={};for(const p of Object.keys(sourceHashes))stagedSourceHashes[p]=sha(await readFile(join(out,p)));
await writeFile(join(out,'runtime-artifacts.json'),JSON.stringify({status:'BUILT_NOT_DEVICE_ACCEPTED',artifactId,engineArtifactId:engine.artifactId,sourceSha256:vm.sourceSha256,executionPayload,kitIdentity:vm.kitIdentity,
  sourceHashes,stagedSourceHashes,libraries,artifacts,...(signer?{signerArtifactId:signer.manifest.artifactId}:{}),platform:'ios',iosDeviceDeployment:'15.0',iosArmSimulatorDeployment:'15.0',
  androidRuntimePlugin:false,realChain:false,partnerVault:false},null,2)+'\n');
console.log(JSON.stringify({out,artifactId,engineArtifactId:engine.artifactId,status:'BUILT_NOT_DEVICE_ACCEPTED'}));
