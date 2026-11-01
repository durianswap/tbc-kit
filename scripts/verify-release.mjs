import assert from 'node:assert/strict';
import {readFileSync,readdirSync,lstatSync,existsSync,mkdtempSync,rmSync} from 'node:fs';
import {dirname,resolve,relative,join,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {platformCatalog} from '../source/packages/kit/scripts/platform-resources.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const sha=b=>createHash('sha256').update(b).digest('hex');
const hash=p=>sha(readFileSync(p));
const json=p=>JSON.parse(readFileSync(join(root,p),'utf8'));
function safe(p){assert(!p.startsWith('/')&&!p.split(/[\\/]/).includes('..'));return join(root,p);}
function files(dir,prefix=''){
 return readdirSync(join(dir,prefix),{withFileTypes:true}).flatMap(e=>{
  const p=join(prefix,e.name);
  if(dir===root&&/(?:^|\/)(?:\.git|\.verify|node_modules|\.dart_tool|target|build|Pods)(?:\/|$)/.test(p))return [];
  assert(!e.isSymbolicLink(),'Unexpected symlink: '+p);
  return e.isDirectory()?files(dir,p):e.isFile()?[p]:[];
 }).sort();
}
function inventory(dir){return files(dir).map(p=>[p,hash(join(dir,p))]);}
const manifest=json('release/current.json');
assert.equal(manifest.publicRelease,true);
assert.equal(manifest.registryPublished,false);
const downloads=json('release/downloads.json');
assert.equal(downloads.tag,manifest.githubRelease.tag);
assert.equal(downloads.sourceCommit,manifest.githubRelease.sourceCommit);
for(const artifact of manifest.artifacts){
 const asset=downloads.assets.find(a=>a.id===artifact.id);
 for(const key of ['path','sha256','bytes','url'])assert.equal(asset[key],artifact[key],'Download differs: '+artifact.id+' '+key);
 if(!existsSync(safe(artifact.path)))throw new Error('Run npm run assets:fetch -- verification before verifying this checkout');
}
const checks=[];
assert.equal(readFileSync(safe('SHA256SUMS'),'utf8'),manifest.artifacts.map(a=>`${a.sha256}  ${a.path}`).join('\n')+'\n','Checksum index differs from current release');
for(const a of manifest.artifacts){
 assert.equal(hash(safe(a.path)),a.sha256,'Artifact changed: '+a.path);
 assert.equal(lstatSync(safe(a.path)).size,a.bytes);
 checks.push(a.id);
}
assert.equal(json('packages/kit/package.json').version,manifest.pairing.kitVersion);
assert.equal(json('packages/kit/package.json').private,true);
const nativeLock=json(manifest.pairing.nativeSdkLock);
assert.equal(nativeLock.sdkVersion,manifest.pairing.sdkVersion);
assert.equal(nativeLock.artifactSetId,manifest.pairing.sdkArtifactSetId);
assert.equal(nativeLock.protocolFingerprint,manifest.pairing.protocolFingerprint);
assert.deepEqual(json('packages/kit/examples/react-native-engine/module/native-sdk-lock.json'),nativeLock,'RN template and published SDK lock differ');
const catalog=await platformCatalog(safe('packages/kit'));
assert(catalog,'Split distribution requires a verified platform catalog');
for(const [path,h] of Object.entries(nativeLock.nativeHashes)){
 const platform=path.startsWith('ios/')?'ios':'android';
 assert.equal(catalog.platforms[platform].files['artifacts/native/'+path],h,'Paired SDK native input differs');
}
for(const [platform,group] of Object.entries(catalog.platforms)){
 const asset=downloads.assets.find(a=>a.id==='resources-'+platform);assert(asset);
 assert.equal(asset.name,group.archive);assert.equal(asset.sha256,group.archiveSha256);assert.equal(asset.bytes,group.archiveBytes);
}
assert.match(readFileSync(safe('packages/flutter/pubspec.yaml'),'utf8'),/^publish_to: none$/m);
const temp=mkdtempSync(join(tmpdir(),'tbc-kit-integrity-'));
let expandedFiles=0;
try{
 for(const[id,directory,top]of [['kit','packages/kit','package'],['flutter','packages/flutter','tbc_kit_flutter_dart']]){
  const a=manifest.artifacts.find(x=>x.id===id);
  const list=execFileSync('tar',['-tzf',safe(a.path)],{encoding:'utf8'}).trim().split('\n');
  assert(list.every(p=>p.startsWith(top+'/')&&!p.split('/').includes('..')),'Unsafe archive path');
  execFileSync('tar',['-xzf',safe(a.path),'-C',temp]);
  const expected=inventory(join(temp,top)),actual=inventory(safe(directory));
  assert.deepEqual(actual,expected,'Expanded package differs: '+id);
  expandedFiles+=actual.length;
 }
 for(const id of manifest.selection.nativeSdk){
  const a=manifest.artifacts.find(x=>x.id===id);
  const list=execFileSync('tar',['-tzf',safe(a.path)],{encoding:'utf8'}).trim().split('\n');
  assert(list.every(p=>!p.startsWith('/')&&!p.split('/').includes('..')),'Unsafe SDK archive path');
  execFileSync('tar',['-xzf',safe(a.path),'-C',temp]);
  const identity=JSON.parse(readFileSync(join(temp,'identity.json'),'utf8'));
  assert.deepEqual(identity,json('release/native-sdk-identity.json'),'Published SDK identity differs: '+id);
  assert.equal(identity.kitVersion,manifest.pairing.nativeBuildInputKitVersion,'Native build identity must remain frozen');
  assert.equal(identity.sdkVersion,manifest.pairing.sdkVersion);
  assert.equal(identity.protocolFingerprint,nativeLock.protocolFingerprint);
  assert.equal(identity.artifactSetId,nativeLock.artifactSetId);
  assert.equal(identity.keylessArtifactSetId,manifest.pairing.keylessArtifactSetId);
  assert.equal(identity.kitTarSha256,manifest.pairing.nativeBuildInputKitSha256);
 }
 for(const [p,h]of Object.entries(nativeLock.files))assert.equal(hash(join(temp,p)),h,'SDK lock mismatch: '+p);
}finally{
 // Only the unique scratch directory created by this invocation is removed.
 assert(temp.startsWith(join(tmpdir(),'tbc-kit-integrity-')));
 rmSync(temp,{recursive:true,force:false});
}
const source=json('release/source-files.json');
for(const f of source.files)assert.equal(hash(safe(f.path)),f.sha256,'Source differs from release inventory: '+f.path);
const checkpoint=json(manifest.source.snapshotManifest);
assert.equal(manifest.source.snapshotFormat,'repository-relative-source-manifest');
assert.equal(checkpoint.kitVersion,manifest.pairing.kitVersion);
assert.equal(sha(JSON.stringify(checkpoint.files)),manifest.source.sourceDigest,'Frozen source manifest digest differs');
const archive=json(manifest.source.snapshotArchiveManifest);
assert.equal(hash(safe(manifest.source.snapshot)),archive.sha256);
assert.equal(lstatSync(safe(manifest.source.snapshot)).size,archive.bytes);
assert.equal(archive.files,Object.keys(checkpoint.files).length);
const sourceAsset=downloads.assets.find(a=>a.id==='accepted-source');
assert.equal(sourceAsset.path,manifest.source.snapshot);
assert.equal(sourceAsset.sha256,archive.sha256);
assert.equal(sourceAsset.bytes,archive.bytes);
const build=json(manifest.source.buildManifest);
assert.equal(build.sourceDigest,checkpoint.sourceBuildDigest ?? checkpoint.sourceDigest);
for(const [p,h]of Object.entries(build.sourceFiles))assert.equal(hash(safe(p)),h,'Build input differs from accepted candidate: '+p);
// Frozen snapshots include release-time docs; promotion updates only public
// release metadata. Runtime/build source must still match every frozen hash.
for(const [p,h]of Object.entries(checkpoint.files))if(p.startsWith('source/'))assert.equal(hash(safe(p)),h,'Source differs from accepted snapshot: '+p);

const docs=['README.md','CONTRIBUTING.md','SUPPORT.md','SECURITY.md',...files(safe('docs')).filter(p=>p.endsWith('.md')).map(p=>'docs/'+p),...files(safe('packages/kit')).filter(p=>p.endsWith('.md')).map(p=>'packages/kit/'+p)];
let links=0;
for(const p of docs){
 const text=readFileSync(safe(p),'utf8');
 assert(!/\/Users\/alex\/|\/private\/tmp\//.test(text),'Local path in public guide: '+p);
 for(const m of text.matchAll(/\]\(([^)]+)\)/g)){
  const url=m[1].split('#')[0].replace(/^<|>$/g,'');
  if(!url||/^[a-z]+:/i.test(url))continue;
  const target=resolve(dirname(safe(p)),decodeURIComponent(url));
  assert(target.startsWith(root+sep)&&existsSync(target),'Broken local link: '+p+' -> '+url);links++;
 }
}
const forbidden=files(root).filter(p=>!p.startsWith('.git/')&&!p.startsWith('.verify/')&&!p.includes('/node_modules/')&&/(?:^|\/)(?:TEST_ACCOUNT\.md|\.env|id_rsa|id_ed25519|wallet\.sqlite|wallet\.db)$/.test(p));
assert.deepEqual(forbidden,[],'Forbidden account or credential files');
const flutter=json('packages/flutter/package-files.json');
for(const[p,h]of Object.entries(flutter.files))assert.equal(hash(safe('packages/flutter/'+p)),h,'Flutter inventory changed: '+p);
console.log(JSON.stringify({status:'PASS',archives:checks.length,expandedFiles,auditedSourceFiles:source.files.length,publicDocumentationFiles:docs.length,localLinks:links,flutterInventoryFiles:Object.keys(flutter.files).length,network:false,signing:false,broadcast:false},null,2));
