// Build-only helper shared by the compile gate and isolated Flutter generator.
// Does not build Rust, copy Hermes, install Apps or accept page-controlled paths.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,access} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {resolve,join,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {verifiedDartNativeCandidate} from '../../contract173-upgrade/dart-native-candidate.mjs';
const run=promisify(execFile),base=resolve(import.meta.dirname,'..'),repo=resolve(base,'../..');
const sha=b=>createHash('sha256').update(b).digest('hex');
export const reviewedArtifact='92d18b12fb2823d0dce98245b6ac1b689a44dcf581c25e3e2ab9a37bb94e40fb';
export const reviewedFlags=['-std=c++17','-O2','-fno-exceptions','-fno-rtti','-Wall','-Wextra','-Werror',`-DTBC_DART_REVIEWED_ARTIFACT="${reviewedArtifact}"`];
const frozen=join(repo,'release/flutter-native-bridge-20261012-b/tbc_kit_flutter');
export async function reviewedInputs(candidate){
 if(candidate){
  const manifest=await verifiedDartNativeCandidate(candidate);
  return {manifest,header:join(candidate,'include/tbc_keyless.h'),binary:async path=>{
   assert(Object.hasOwn(manifest.artifacts,path),'Unlisted native artifact');const p=join(candidate,path);
   assert.equal(sha(await readFile(p)),manifest.artifacts[path]);return p;
  }};
 }
 const bytes=await readFile(join(frozen,'native-artifacts.json'));
 assert.equal(sha(bytes),'1b247beb248447f838e57653da97060cba0ddcdaa55aae1b3ac56ff907ebc6a9');
 const manifest=JSON.parse(bytes);assert.equal(manifest.artifactId,reviewedArtifact);
 const header=join(repo,'packages/tbc-engine/rust/crates/tbc-keyless-native/include/tbc_keyless.h');
 assert.equal(sha(await readFile(header)),'fe6e4e9d09016deb7d23aff96b24a10e65772f7cdc930ee9266e754788a01b4c');
 async function binary(path){const p=join(frozen,path);assert.equal(sha(await readFile(p)),manifest.artifacts[path],path);return p;}
 return {manifest,header,binary};
}
async function absent(path){try{await access(path);throw Error('Refusing to replace bridge output');}catch(e){if(e.code!=='ENOENT')throw e;}}
export async function buildReviewedAndroid(output,androidHome,candidate){
 await absent(output);await mkdir(dirname(output),{recursive:true});
 const input=await reviewedInputs(candidate),library=await input.binary('android/src/main/jniLibs/arm64-v8a/libtbc_compute_native.so');
 const artifact=input.manifest.artifactId,flags=reviewedFlags.map(f=>f.startsWith('-DTBC_DART_REVIEWED_ARTIFACT=')?`-DTBC_DART_REVIEWED_ARTIFACT="${artifact}"`:f);
 const ndk=join(androidHome,'ndk/27.1.12297006/toolchains/llvm/prebuilt/darwin-x86_64/bin');
 await run(join(ndk,'aarch64-linux-android26-clang++'),[...flags,'-nostdlib++','-shared','-fPIC','-Wl,--no-undefined','-Wl,-z,max-page-size=16384',
  '-I'+join(base,'platform/native'),'-I'+dirname(input.header),join(base,'platform/native/reviewed_compute.cpp'),join(base,'platform/android/src/main/cpp/reviewed-jni.cpp'),'-L'+dirname(library),'-ltbc_compute_native','-o',output],{timeout:120000,maxBuffer:2**20});
 await run(join(ndk,'llvm-strip'),['--strip-unneeded',output]);
 const dynamic=(await run(join(ndk,'llvm-readelf'),['-d',output])).stdout;
 const needed=dynamic.split('\n').filter(l=>l.includes('(NEEDED)')).map(l=>l.match(/\[([^\]]+)\]/)[1]);
 assert(needed.includes('libtbc_compute_native.so'));assert(needed.every(n=>['libtbc_compute_native.so','libm.so','libdl.so','libc.so'].includes(n)));
 const sourceHashes={};for(const p of ['platform/native/reviewed_compute.cpp','platform/native/reviewed_compute.h','platform/android/src/main/cpp/reviewed-jni.cpp','platform/android/consumer-rules.pro'])sourceHashes[p]=sha(await readFile(join(base,p)));
 const bytes=await readFile(output);return {artifact,sha256:sha(bytes),bytes:bytes.length,needed,sourceHashes,extraCxxRuntime:false};
}
export async function stageReviewedIos(output,candidate){
 await absent(output);await mkdir(output,{recursive:true});const input=await reviewedInputs(candidate),hashes={},artifact=input.manifest.artifactId;
 for(const name of ['reviewed_compute.cpp','reviewed_compute.h','module.modulemap']){
  const bytes=await readFile(join(base,'platform/native',name));await writeFile(join(output,name),bytes,{flag:'wx'});hashes[name]=sha(bytes);
 }
 const header=await readFile(input.header);await writeFile(join(output,'tbc_keyless.h'),header,{flag:'wx'});hashes['tbc_keyless.h']=sha(header);
 // A build tag paired with independently verified frozen framework hashes.
 await writeFile(join(output,'reviewed_build.h'),`#define TBC_DART_REVIEWED_ARTIFACT "${artifact}"\n`,{flag:'wx'});
 return {artifact,hashes};
}
