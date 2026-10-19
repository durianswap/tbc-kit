// Add the keyless companion to one local Engine SDK; no extra consumer package.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {cp,readFile,writeFile,mkdir,readdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
const [tar,expectedHash,companionArg,outArg,...resourceArgs]=process.argv.slice(2);
assert.ok(tar&&expectedHash&&companionArg&&outArg,'Usage: KIT_TAR SHA256 KEYLESS_OUTPUT NEW_SDK_OUTPUT');
const companion=resolve(companionArg),output=resolve(outArg),root=resolve(import.meta.dirname,'..');
const sha=b=>createHash('sha256').update(b).digest('hex');
const keyless=JSON.parse(await readFile(join(companion,'identity.json')));
for(const [p,h] of Object.entries(keyless.hashes))assert.equal(sha(await readFile(join(companion,'artifacts',p))),h,p);
execFileSync(process.execPath,[join(import.meta.dirname,'prepare-native-engine.mjs'),tar,expectedHash,output,...resourceArgs],{stdio:'pipe',maxBuffer:8*1024*1024});
const old=JSON.parse(await readFile(join(output,'identity.json')));
await cp(join(companion,'artifacts/TbcKeylessNative.xcframework'),join(output,'apple/Artifacts/TbcKeylessNative.xcframework'),{recursive:true});
await cp(join(root,'keyless/TbcKeylessEngine.swift'),join(output,'apple/Sources/TbcEngine/TbcKeylessEngine.swift'));
await cp(join(root,'keyless/TbcKeylessEngine.kt'),join(output,'android/engine/src/main/java/io/tbc/engine/TbcKeylessEngine.kt'));
await cp(join(root,'keyless/bridge.cpp'),join(output,'android/engine/src/main/cpp/keyless-bridge.cpp'));
await cp(join(companion,'artifacts/include/tbc_keyless.h'),join(output,'android/engine/src/main/cpp/include/tbc_keyless.h'));
for(const abi of old.platforms.android)await cp(join(companion,'artifacts/android',abi,'libtbc_keyless_native.so'),join(output,'android/engine/src/main/jniLibs',abi,'libtbc_keyless_native.so'));
const change=async(p,from,to)=>{const file=join(output,p),s=await readFile(file,'utf8');assert.ok(s.includes(from),p);await writeFile(file,s.replace(from,to));};
await change('apple/Package.swift','.target(name: "TbcEngine", dependencies: ["TbcEngineNative"])','.binaryTarget(name: "TbcKeylessNative", path: "Artifacts/TbcKeylessNative.xcframework"),\n        .target(name: "TbcEngine", dependencies: ["TbcEngineNative", "TbcKeylessNative"])');
await change('android/engine/src/main/cpp/CMakeLists.txt','add_library(tbc_engine_jni SHARED bridge.cpp)','add_library(tbc_keyless_native SHARED IMPORTED)\nset_target_properties(tbc_keyless_native PROPERTIES IMPORTED_LOCATION "${CMAKE_CURRENT_LIST_DIR}/../jniLibs/${ANDROID_ABI}/libtbc_keyless_native.so" IMPORTED_NO_SONAME TRUE)\nadd_library(tbc_engine_jni SHARED bridge.cpp keyless-bridge.cpp)');
await change('android/engine/src/main/cpp/CMakeLists.txt','PRIVATE tbc_engine_native)','PRIVATE tbc_engine_native tbc_keyless_native)');
await change('android/engine/build.gradle',"['**/libtbc_engine_native.so']","['**/libtbc_engine_native.so', '**/libtbc_keyless_native.so']");
const identity={...old,sdkVersion:old.kitVersion+'.native.2',coreArtifactSetId:old.artifactSetId,keylessArtifactSetId:keyless.artifactSetId,
 artifactSetId:sha(JSON.stringify({core:old.artifactSetId,keyless:keyless.artifactSetId})),keylessSourceSha256:keyless.sourceSha256,keylessHashes:keyless.hashes,
 scope:'Core Engine and keyless companion; native binding candidate, full wallet acceptance pending'};
await change('apple/Sources/TbcEngine/TbcEngineIdentity.swift',old.artifactSetId,identity.artifactSetId);
await change('android/engine/src/main/java/io/tbc/engine/TbcEngineIdentity.kt',old.artifactSetId,identity.artifactSetId);
identity.bindingSourceHashes={};
// Hash source only, never include generated identity or binary files recursively.
for(const prefix of ['apple/Sources','android/engine/src/main/java','android/engine/src/main/cpp']){
 async function scan(p){for(const e of await readdir(join(output,p),{withFileTypes:true})){const f=join(p,e.name);if(e.isDirectory())await scan(f);else identity.bindingSourceHashes[f]=sha(await readFile(join(output,f)));}}await scan(prefix);
}
for(const p of ['apple/Package.swift','android/engine/build.gradle','android/build.gradle','android/settings.gradle'])identity.bindingSourceHashes[p]=sha(await readFile(join(output,p)));
for(const p of ['identity.json','android/identity.json'])await writeFile(join(output,p),JSON.stringify(identity,null,2)+'\n');
console.log(JSON.stringify({output,sdkVersion:identity.sdkVersion,artifactSetId:identity.artifactSetId,status:'COMPOSED_NOT_ACCEPTED'}));
