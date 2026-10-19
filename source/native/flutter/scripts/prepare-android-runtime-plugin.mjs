// New local arm64/API23 runtime candidate; frozen Engine and VM inputs stay intact.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,cp,readdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {verifiedSignerAddon} from './signer-addon.mjs';
import {verifiedRuntimePayload,hermesDebuggerFlags,runtimePayloadDefines} from './runtime-payload.mjs';
import {verifiedWebViewPage} from './webview-page-payload.mjs';
import {verifiedKernelCandidate} from './candidate-inputs.mjs';
const args=process.argv.slice(2);assert.ok([6,7].includes(args.length),'ENGINE_PLUGIN RUNTIME_RESOURCE HERMES KERNELS ANDROID_SDK NEW_PLUGIN [SIGNER_ADDON]');
const [base,resource,hermes,kernels,sdk,out]=args.map(p=>resolve(p));
const source=resolve(import.meta.dirname,'..'),root=resolve(source,'../..');
const signer=await verifiedSignerAddon(args[6],source);
const sha=b=>createHash('sha256').update(b).digest('hex');
const engine=JSON.parse(await readFile(join(base,'native-artifacts.json')));
for(const [p,h]of Object.entries(engine.artifacts))assert.equal(sha(await readFile(join(base,p))),h,p);
const vm=JSON.parse(await readFile(join(resource,'runtime-provenance.json')));
assert.equal(sha(await readFile(join(resource,'private-kit.js'))),vm.sourceSha256);
const executionPayload=await verifiedRuntimePayload(resource,vm);
const page=await verifiedWebViewPage(process.env.TBC_FLUTTER_WEBVIEW_PAGE_DIR,vm,
  process.env.TBC_FLUTTER_KIT_CANDIDATE_DIR);
const debuggerFlags=await hermesDebuggerFlags(join(hermes,'build'));
const accepted=JSON.parse(await readFile(join(root,'native/flutter-compat/hermes-evidence-2026-10-06.json'))).provenance;
const kernelCandidate=await verifiedKernelCandidate(kernels),kernelsAccepted=kernelCandidate.evidence;
assert.equal(engine.rustSourceSha256,kernelCandidate.rustSourceSha256,'Engine/kernel source mismatch');
assert.equal(vm.kitIdentity?.rustSourceSha256,kernelCandidate.rustSourceSha256,'Kit/kernel source mismatch');
const ndk=join(sdk,'ndk/27.1.12297006/toolchains/llvm/prebuilt/darwin-x86_64');
const libraries={
  'libhermes.so':join(hermes,'build/API/hermes/libhermes.so'),
  'libjsi.so':join(hermes,'build/jsi/libjsi.so'),
  'libfbjni.so':join(hermes,'fbjni/jni/arm64-v8a/libfbjni.so'),
  'libc++_shared.so':join(ndk,'sysroot/usr/lib/aarch64-linux-android/libc++_shared.so'),
  'libtbc_keyless_native.so':join(kernels,'target/aarch64-linux-android/release/libtbc_keyless_native.so')};
const libraryHashes={};
if(page)libraryHashes.webViewPage=page.identity;
for(const [name,path]of Object.entries(libraries)){
  const h=sha(await readFile(path));libraryHashes[name]=h;
  assert.equal(h,name==='libtbc_keyless_native.so'?kernelsAccepted.find(r=>r.name==='keyless'&&r.target==='aarch64-linux-android')?.sha256:accepted.hashes[name],name);
}
const cache=join(process.env.HOME,'.gradle/caches/modules-2/files-2.1');
if(signer){
 const rel='android/jniLibs/arm64-v8a/libtbc_signer_kernel.so';
 libraries['libtbc_signer_kernel.so']=join(signer.path,rel);
 libraryHashes['libtbc_signer_kernel.so']=signer.manifest.artifacts[rel];
 libraryHashes.signerAddon=signer.manifestSha256;
}
const jars=[join(hermes,'fbjni/classes.jar'),
  join(cache,'com.facebook.soloader/nativeloader/0.10.5/492cc5082540e19b29328f2f56c53255cb6e7cc6/nativeloader-0.10.5.jar'),
  join(cache,'com.facebook.yoga/proguard-annotations/1.19.0/fcbbb39052e6490eaaf6a6959c49c3a4fbe87c63/proguard-annotations-1.19.0.jar')];
const supportHashes={};
async function hashSupport(dir,prefix){for(const e of (await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
  const p=join(dir,e.name),rel=join(prefix,e.name);if(e.isDirectory())await hashSupport(p,rel);else if(e.isFile())supportHashes[rel]=sha(await readFile(p));
}}
for(const dir of ['Intl','Unicode'])await hashSupport(join(hermes,'source/lib/Platform',dir,'java'),'android/src/main/java');
for(const [i,p]of jars.entries()){const h=sha(await readFile(p));assert.equal(h,accepted.hashes[`dependency-${i}.jar`]);supportHashes[`android/libs/dependency-${i}.jar`]=h;}
const sourceHashes={};
async function hashSources(dir){for(const e of (await readdir(join(source,dir),{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
  const p=join(dir,e.name);if(e.isDirectory())await hashSources(p);else if(e.isFile())sourceHashes[p]=sha(await readFile(join(source,p)));
}}
for(const dir of ['lib','android/src/main','runtime/native'])await hashSources(dir);
for(const p of ['pubspec.yaml','android/build.gradle','android/consumer-rules.pro','scripts/prepare-android-runtime-plugin.mjs','scripts/signer-addon.mjs','scripts/runtime-payload.mjs','scripts/webview-page-payload.mjs','scripts/webview-source-identity.mjs'])sourceHashes[p]=sha(await readFile(join(source,p)));
const artifactId=sha(JSON.stringify({runtime:vm.sourceSha256,executionPayload,engine:engine.artifactId,libraries:libraryHashes,sourceHashes,supportHashes}));
await mkdir(out);const filter=p=>!p.split('/').some(s=>['node_modules','.dart_tool','build','.git','native-build','.symlinks','Pods','.gradle','DerivedData'].includes(s));
await cp(base,out,{recursive:true,filter});await cp(source,out,{recursive:true,filter});
if(signer)await cp(join(signer.path,'signer-artifacts.json'),join(out,'signer-artifacts.json'));
const libDir=join(out,'android/src/main/jniLibs/arm64-v8a');await mkdir(libDir,{recursive:true});
for(const [name,p]of Object.entries(libraries))await cp(p,join(libDir,name));
for(const dir of ['Intl','Unicode'])await cp(join(hermes,'source/lib/Platform',dir,'java'),join(out,'android/src/main/java'),{recursive:true});
await mkdir(join(out,'android/libs'),{recursive:true});const artifacts={...supportHashes};
for(const [i,p]of jars.entries()){const rel=`android/libs/dependency-${i}.jar`;const h=sha(await readFile(p));assert.equal(h,accepted.hashes[`dependency-${i}.jar`]);await cp(p,join(out,rel));artifacts[rel]=h;}
await mkdir(join(out,'android/src/main/assets/tbc-kit'),{recursive:true});
await cp(join(resource,executionPayload.file),join(out,'android/src/main/assets/tbc-kit',executionPayload.file));
artifacts['android/src/main/assets/tbc-kit/'+executionPayload.file]=executionPayload.sha256;
if(page)for(const [file,bytes,expected] of [[page.identity.file,page.bytes,page.identity.sha256],['page-provenance.json',page.manifestBytes,page.identity.provenanceSha256]]){
 const rel='android/src/main/assets/tbc-kit/'+file;
 await writeFile(join(out,rel),bytes);artifacts[rel]=sha(await readFile(join(out,rel)));assert.equal(artifacts[rel],expected);
}
const build=join(out,'android/build.gradle');
// Resolve annotations through Gradle rather than embedding a duplicate copy
// beside Flutter's AndroidX dependency graph.
await writeFile(build,(await readFile(build,'utf8'))+"\ndependencies { implementation fileTree(dir: 'libs', include: ['*.jar']); compileOnly 'androidx.annotation:annotation:1.8.0' }\n");
const filePrefixFlags=[[hermes,'hermes'],[source,'flutter'],[kernels,'kernels']]
  .map(([path,label])=>`-ffile-prefix-map=${path}=${label}`);
const result=spawnSync(join(ndk,'bin/aarch64-linux-android23-clang++'),['-std=c++17','-shared','-fPIC',...filePrefixFlags,...debuggerFlags,...runtimePayloadDefines(executionPayload),
  `-DTBC_FLUTTER_RUNTIME_ID="${artifactId}"`,`-DTBC_FLUTTER_RUNTIME_SOURCE_SHA256="${vm.sourceSha256}"`,
  '-I',join(hermes,'source/API'),'-I',join(hermes,'source/public'),'-I',join(hermes,'jsi'),
  '-I',join(kernels,'source/packages/tbc-engine/rust/crates/tbc-engine-native/include'),
  '-I',join(kernels,'source/packages/tbc-engine/rust/crates/tbc-keyless-native/include'),
  join(source,'android/src/main/cpp/runtime-jni.cpp'),'-L',libDir,'-lhermes','-ljsi','-ltbc_engine_native','-ltbc_keyless_native','-lfbjni','-lc++_shared',
  '-Wl,--no-undefined','-Wl,--no-allow-shlib-undefined','-Wl,-z,max-page-size=16384',
  '-o',join(libDir,'libtbc_flutter_runtime.so')],{encoding:'utf8',maxBuffer:8*1024*1024});
await writeFile(join(out,'runtime-android-link.log'),String(result.stdout??'')+String(result.stderr??''));
assert.equal(result.status,0,'Android runtime link failed; inspect retained log');
// The pinned upstream Hermes/JSI libraries contain local paths only in debug
// sections. Strip those sections from the staged copies, preserving dynamic
// symbols and leaving the frozen inputs untouched.
for(const name of ['libhermes.so','libjsi.so']){
 const staged=join(libDir,name);
 const stripped=spawnSync(join(ndk,'bin/llvm-strip'),['--strip-debug',staged],
   {encoding:'utf8',maxBuffer:8*1024*1024});
 assert.equal(stripped.status,0,`Failed to strip debug sections from ${name}`);
 const bytes=await readFile(staged);
 for(const pathPrefix of ['/Users/','/private/tmp/','/var/folders/'])
   assert.ok(!bytes.includes(Buffer.from(pathPrefix)),
     `Staged ${name} still embeds a build-machine path`);
}
for(const name of [...Object.keys(libraries),'libtbc_flutter_runtime.so']){const rel=`android/src/main/jniLibs/arm64-v8a/${name}`;artifacts[rel]=sha(await readFile(join(out,rel)));}
const stagedSourceHashes={};for(const p of Object.keys(sourceHashes))stagedSourceHashes[p]=sha(await readFile(join(out,p)));
await writeFile(join(out,'runtime-artifacts.json'),JSON.stringify({status:'BUILT_NOT_DEVICE_ACCEPTED',artifactId,engineArtifactId:engine.artifactId,
  sourceSha256:vm.sourceSha256,executionPayload,kitIdentity:vm.kitIdentity,sourceHashes,stagedSourceHashes,supportHashes,libraries:libraryHashes,artifacts,...(signer?{signerArtifactId:signer.manifest.artifactId}:{}),platform:'android',androidMinApi:23,abi:'arm64-v8a',
  realChain:false,partnerVault:false},null,2)+'\n');
console.log(JSON.stringify({out,artifactId,status:'BUILT_NOT_DEVICE_ACCEPTED'}));
