// Minimal paired Dart compute/Signer bridge. No Hermes runtime, fixture key or App.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,cp} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {execFileSync} from 'node:child_process';
import {verifiedKitCandidate,sha256} from '../flutter/scripts/candidate-inputs.mjs';
import {fileInventory} from '../../packages/kit/scripts/platform-resources.mjs';
import {applePublicLinkFlags,stripAppleDebugSymbols,verifyApplePublicAbi} from '../flutter/scripts/portable-apple-binary.mjs';
import {verifiedDartNativeCandidate} from './dart-native-candidate.mjs';
const [kitArg,computeArg,pageArg,outArg]=process.argv.slice(2);assert(outArg,'KIT COMPUTE PAGE NEW_OUTPUT');
const root=resolve(import.meta.dirname,'../..'),kit=resolve(kitArg),compute=resolve(computeArg),page=resolve(pageArg),out=resolve(outArg);
const frozen=join(root,'release/flutter-native-bridge-20261012-b/tbc_kit_flutter'),source=join(root,'native/flutter');
const kitIdentity=await verifiedKitCandidate(kit),build=JSON.parse(await readFile(join(compute,'build-report.json'))),pageInfo=JSON.parse(await readFile(join(page,'page-provenance.json')));
assert.equal(build.status,'BUILT_NOT_DEVICE_ACCEPTED');assert.equal(build.source,kitIdentity.rustSourceSha256);assert.deepEqual(pageInfo.kitIdentity,kitIdentity);
assert.equal(sha256(await readFile(join(page,'tbc-webview-page.js'))),pageInfo.sha256);
for(const b of build.builds)assert.equal(sha256(await readFile(b.path)),b.sha256);
const frozenBytes=await readFile(join(frozen,'native-artifacts.json'));assert.equal(sha256(frozenBytes),'1b247beb248447f838e57653da97060cba0ddcdaa55aae1b3ac56ff907ebc6a9');
const old=JSON.parse(frozenBytes),wrapper='ios/engine/TbcFlutterEngine.mm';
assert.equal(sha256(await readFile(join(source,wrapper))),old.buildInputs.bridgeSources[wrapper]);
const buildInputs={kitIdentity,rustSourceSha256:build.source,computeLibraries:Object.fromEntries(build.builds.map(b=>[b.target,b.sha256])),
 wrapperSha256:sha256(await readFile(join(source,wrapper))),frozenSignerManifestSha256:sha256(frozenBytes),generatorSha256:sha256(await readFile(new URL(import.meta.url)))};
const artifactId=sha256(JSON.stringify(buildInputs));await mkdir(out);
async function copy(input,path){await mkdir(dirname(join(out,path)),{recursive:true});await cp(input,join(out,path),{recursive:true});}
// Verify every copied frozen Signer file against its immutable distribution.
const oldInventory=JSON.parse(await readFile(join(frozen,'portable-artifacts.json'))).files;
for(const [p,h]of Object.entries(oldInventory))if(p.includes('TbcFlutterSigner.xcframework/')||p.endsWith('/libtbc_signer_kernel.so')){
 assert.equal(sha256(await readFile(join(frozen,p))),h,p);await copy(join(frozen,p),p);
}
await copy(join(frozen,'ios/Frameworks/TbcFlutterEngine.xcframework'),'ios/Frameworks/TbcFlutterEngine.xcframework');
const include=join(compute,'source/packages/tbc-engine/rust/crates');
const headers=[join(include,'tbc-engine-native/include/tbc_engine.h'),join(include,'tbc-keyless-native/include/tbc_keyless.h')];
for(const h of headers)await copy(h,'include/'+h.split('/').at(-1));
await mkdir(join(out,'build-evidence'));
for(const [sdk,target,slice,triple]of [['iphoneos','aarch64-apple-ios','ios-arm64','arm64-apple-ios15.0'],['iphonesimulator','aarch64-apple-ios-sim','ios-arm64-simulator','arm64-apple-ios15.0-simulator']]){
 const sdkPath=execFileSync('xcrun',['--sdk',sdk,'--show-sdk-path'],{encoding:'utf8'}).trim();
 const binary=join(out,`ios/Frameworks/TbcFlutterEngine.xcframework/${slice}/TbcFlutterEngine.framework/TbcFlutterEngine`),exports=join(out,'build-evidence',sdk+'.exports');
 execFileSync('xcrun',['clang++','-std=c++17','-fobjc-arc','-dynamiclib','-target',triple,'-isysroot',sdkPath,
  `-ffile-prefix-map=${source}=/flutter`,`-ffile-prefix-map=${compute}=/compute`,...applePublicLinkFlags(exports,headers,['TbcFlutterEngine']),
  `-DTBC_FLUTTER_ARTIFACT_ID="${artifactId}"`,'-I',dirname(headers[0]),'-framework','Foundation','-framework','Security',join(source,wrapper),
  join(compute,`target/${target}/release/libtbc_compute_native.a`),'-Wl,-install_name,@rpath/TbcFlutterEngine.framework/TbcFlutterEngine','-o',binary],{stdio:'pipe',maxBuffer:4e6});
 verifyApplePublicAbi(binary,exports);stripAppleDebugSymbols(binary);
}
await copy(join(compute,'target/aarch64-linux-android/release/libtbc_compute_native.so'),'android/src/main/jniLibs/arm64-v8a/libtbc_compute_native.so');
await copy(join(page,'tbc-webview-page.js'),'android/src/main/assets/tbc-kit/tbc-webview-page.js');
await copy(join(page,'page-provenance.json'),'page-provenance.json');
const inventory=await fileInventory(out),manifest={schema:1,kind:'paired-dart-native',status:'BUILT_NOT_DEVICE_ACCEPTED',kitIdentity,artifactId,buildInputs,
 artifacts:Object.fromEntries(Object.entries(inventory).map(([p,v])=>[p,v.sha256])),signerChanged:false,hermesIncluded:false,broadcasts:0};
await writeFile(join(out,'native-artifacts.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
await verifiedDartNativeCandidate(out);console.log(JSON.stringify({status:manifest.status,out,artifactId,kitIdentity,signerChanged:false,hermesIncluded:false}));
