// Package already-built paired candidates; never rebuild or alter their bytes.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,readdir,cp} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const excluded=new Set(['build','native-build','DerivedData','.dart_tool','.gradle','Pods','.symlinks','node_modules','.git']);
async function files(root,dir=''){
 const result={};
 for(const entry of (await readdir(join(root,dir),{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
  if(excluded.has(entry.name))continue;
  const path=join(dir,entry.name);
  assert.ok(!entry.isSymbolicLink(),`Non-portable symlink: ${path}`);
  if(entry.isDirectory())Object.assign(result,await files(root,path));
  else if(entry.isFile())result[path]=sha(await readFile(join(root,path)));
 }
 return result;
}
async function candidate(root,platform){
 const bytes=await readFile(join(root,'runtime-artifacts.json')),runtime=JSON.parse(bytes);
 const engineBytes=await readFile(join(root,'native-artifacts.json')),engine=JSON.parse(engineBytes);
 assert.equal(runtime.platform,platform);assert.equal(runtime.engineArtifactId,engine.artifactId);
 if(engine.buildInputs)assert.equal(engine.artifactId,sha(JSON.stringify(engine.buildInputs)),
   'Engine bridge build identity');
 const identity={runtime:runtime.sourceSha256,executionPayload:runtime.executionPayload,engine:runtime.engineArtifactId,
  libraries:runtime.libraries,sourceHashes:runtime.sourceHashes,...(platform==='android'?{supportHashes:runtime.supportHashes}:{})};
 assert.equal(runtime.artifactId,sha(JSON.stringify(identity)));
 for(const manifest of [runtime,engine])for(const [p,h]of Object.entries(manifest.artifacts)){
  assert.ok(!p.startsWith('/')&&!p.split('/').includes('..'));
  assert.equal(sha(await readFile(join(root,p))),h,p);
 }
 for(const [p,h]of Object.entries(runtime.stagedSourceHashes))assert.equal(sha(await readFile(join(root,p))),h,p);
 return {root,runtime,engine,bytes,engineBytes,lib:await files(join(root,'lib')),spec:await readFile(join(root,'pubspec.yaml'))};
}
function portableEngineBytes(source) {
 const engine=source.engine;
 const engines=Object.fromEntries(Object.entries(engine.engines ?? {}).map(([target,record])=>{
  assert.match(target,/^[a-z0-9-]+$/u);
  assert.match(record.sha256,/^[0-9a-f]{64}$/u);
  return [target,{sha256:record.sha256}];
 }));
 return Buffer.from(JSON.stringify({...engine,engines,
  sourceManifestSha256:sha(source.engineBytes),sourcePathsOmitted:true},null,2)+'\n');
}
export async function preparePortablePlugin(iosPath,androidPath,output){
 const ios=await candidate(resolve(iosPath),'ios'),android=await candidate(resolve(androidPath),'android');
 assert.deepEqual(ios.lib,android.lib,'Dart adapters differ between platforms');
 assert.deepEqual(ios.spec,android.spec,'Dart dependency specifications differ');
 assert.deepEqual(ios.runtime.kitIdentity,android.runtime.kitIdentity,'Kit identities differ');
 assert.equal(ios.runtime.engineArtifactId,android.runtime.engineArtifactId);
 assert.deepEqual(ios.runtime.executionPayload,android.runtime.executionPayload);
 assert.deepEqual(ios.runtime.libraries.webViewPage,android.runtime.libraries.webViewPage);
 assert.equal(ios.runtime.signerArtifactId,android.runtime.signerArtifactId);
 const out=resolve(output);await mkdir(out);
 const iosEngine=portableEngineBytes(ios),androidEngine=portableEngineBytes(android);
 assert.deepEqual(iosEngine,androidEngine,'Engine source manifests differ between platforms');
 for(const [source,dir]of [[ios,'lib'],[ios,'ios'],[android,'android']]){
  // Traverse first so a symlink cannot silently escape into a wallet checkout.
  await files(join(source.root,dir));
  await cp(join(source.root,dir),join(out,dir),{recursive:true,filter:p=>!p.split('/').some(s=>excluded.has(s))});
 }
 await writeFile(join(out,'pubspec.yaml'),ios.spec);
 await mkdir(join(out,'provenance'));
 const platforms={};
 for(const source of [ios,android]){
  const p=source.runtime.platform;
  await writeFile(join(out,`provenance/${p}-runtime.json`),source.bytes);
  await writeFile(join(out,`provenance/${p}-engine.json`),p==='ios'?iosEngine:androidEngine);
  platforms[p]={runtimeArtifact:source.runtime.artifactId,engineArtifact:source.runtime.engineArtifactId,
   manifest:`provenance/${p}-runtime.json`,manifestSha256:sha(source.bytes)};
 }
 // Engine records contain the same paired platform libraries; preserve the source record.
 await writeFile(join(out,'native-artifacts.json'),iosEngine);
 const manifest={schema:2,status:'PACKAGED_NOT_CONSUMER_ACCEPTED',kitIdentity:ios.runtime.kitIdentity,platforms,
  sourceEngineManifestSha256:sha(ios.engineBytes),
  files:await files(out),publicRelease:false,deliveryReady:false,
  limitations:['Paired local ARM64 candidates only; not a public release or complete wallet facade.',
   'No maintainer build tools, Node dependencies, tests or automatic approvals are included.',
   'Minimum OS, real Vault, real-chain, Release performance and distribution-license closure remain separate.']};
 await writeFile(join(out,'portable-artifacts.json'),JSON.stringify(manifest,null,2)+'\n');
 return manifest;
}
export async function verifyPortablePlugin(rootPath,{requirePathClean=false}={}){
 const root=resolve(rootPath),manifest=JSON.parse(await readFile(join(root,'portable-artifacts.json')));
 const actual=await files(root);delete actual['portable-artifacts.json'];assert.deepEqual(actual,manifest.files);
 if(requirePathClean){
  for(const path of ['portable-artifacts.json',...Object.keys(actual)]){
   const bytes=await readFile(join(root,path));
   for(const prefix of ['/Users/','/private/tmp/','/var/folders/'])
    assert.ok(!bytes.includes(Buffer.from(prefix)),`Build-machine path in ${path}: ${prefix}`);
  }
 }
 for(const p of Object.keys(actual))assert.ok(!/^(build-tools|scripts|test|runtime)\//.test(p),p);
 for(const p of ['ios','android']){
  const descriptor=manifest.platforms[p],bytes=await readFile(join(root,descriptor.manifest));
  assert.equal(sha(bytes),descriptor.manifestSha256);
  const source=JSON.parse(bytes);assert.equal(source.artifactId,descriptor.runtimeArtifact);
  for(const [path,hash]of Object.entries(source.artifacts))if(path.startsWith(p+'/'))assert.equal(actual[path],hash,path);
 }
 if(manifest.schema===2){
  const engineBytes=await readFile(join(root,'native-artifacts.json'));
  const engine=JSON.parse(engineBytes);
  assert.equal(engine.sourcePathsOmitted,true);
  assert.equal(engine.sourceManifestSha256,manifest.sourceEngineManifestSha256);
  assert.ok(Object.values(engine.engines).every(record=>
   Object.keys(record).length===1&&/^[0-9a-f]{64}$/u.test(record.sha256)));
  for(const p of ['ios','android'])assert.deepEqual(
   await readFile(join(root,`provenance/${p}-engine.json`)),engineBytes);
  for(const p of ['android/src/main/assets/tbc-kit/page-provenance.json',
   'ios/Frameworks/TbcFlutterRuntime.xcframework/ios-arm64/TbcFlutterRuntime.framework/page-provenance.json',
   'ios/Frameworks/TbcFlutterRuntime.xcframework/ios-arm64-simulator/TbcFlutterRuntime.framework/page-provenance.json']){
   if(!Object.hasOwn(actual,p))continue;
   const page=JSON.parse(await readFile(join(root,p)));
   assert.equal(page.schema,2,'Portable page provenance required');
   assert.ok(Object.keys(page.sources).every(id=>/^(?:repo|kit):/u.test(id)));
   assert.ok(!/\/Users\/|\/private\/tmp\/|\/var\/folders\//u.test(JSON.stringify(page)));
  }
 }
 return manifest;
}
