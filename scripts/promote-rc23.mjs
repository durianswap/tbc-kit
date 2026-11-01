// Promote the sealed rc.23 downloads without rebuilding or modifying Flutter.
import assert from 'node:assert/strict';
import {readFile,writeFile,readdir,mkdir,mkdtemp,copyFile,stat,unlink} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {resolve,join,dirname} from 'node:path';
const root=resolve(import.meta.dirname,'..');
const candidatePath='release/candidates/unexpected-rejections-rc23', candidate=join(root,candidatePath);
const sourceCommit='ba2bf386ddd8b34d4409cdb5d25e7b90164b8abc', tag='v0.1.0-rc.23';
const sha=b=>createHash('sha256').update(b).digest('hex');
const json=async p=>JSON.parse(await readFile(p,'utf8'));
const save=(p,v)=>writeFile(join(root,p),JSON.stringify(v,null,2)+'\n');
async function walk(dir,prefix='') {
  const paths=[];
  for(const e of await readdir(join(dir,prefix),{withFileTypes:true})) {
    const p=prefix?prefix+'/'+e.name:e.name; assert(!e.isSymbolicLink(),p);
    if(e.isDirectory())paths.push(...await walk(dir,p)); else if(e.isFile())paths.push(p);
  }
  return paths.sort();
}
const lock=await json(join(candidate,'delivery-lock.json'));
const source=await json(join(candidate,'source-manifest.json'));
const archive=await json(join(candidate,'source-archive.json'));
const build=await json(join(candidate,'evidence/build.json'));
assert.equal(lock.kitVersion,'0.1.0-rc.23');
for(const line of (await readFile(join(candidate,'DOWNLOADS.SHA256'),'utf8')).trim().split('\n')) {
  const [h,p]=line.split('  '); assert.equal(sha(await readFile(join(candidate,p))),h,p);
}
for(const [p,h]of Object.entries(build.sourceFiles)) assert.equal(sha(await readFile(join(root,p))),h,p);
const current=await json(join(root,'release/current.json')), downloads=await json(join(root,'release/downloads.json'));
assert.equal(current.pairing.kitVersion,'0.1.0-rc.22','Promotion is one-shot');
const preserved=JSON.stringify({artifact:current.artifacts.find(a=>a.id==='flutter'),assets:downloads.assets.filter(a=>a.id.startsWith('flutter'))});
assert.equal(execFileSync('git',['status','--porcelain','--','packages/kit'],{cwd:root,encoding:'utf8'}),'');
await mkdir(join(root,'.verify'),{recursive:true});
const scratch=await mkdtemp(join(root,'.verify/rc23-promotion-'));
// Preserve the selected old archives before changing the default download paths.
for(const a of current.artifacts) {
  assert.equal(sha(await readFile(join(root,a.path))),a.sha256,a.path);
  await copyFile(join(root,a.path),join(scratch,a.id+'.tgz'),1);
}
const old=downloads.assets.find(a=>a.id==='kit');
const oldFiles=new Map(old.files.map(f=>[f.path.slice('packages/kit/'.length),f]));
const actual=await walk(join(root,'packages/kit'));
assert.deepEqual(actual,[...oldFiles.keys()].sort(),'Unexpected files in package mirror');
for(const p of actual)assert.equal(sha(await readFile(join(root,'packages/kit',p))),oldFiles.get(p).sha256,p);
execFileSync('tar',['-xzf',join(candidate,'tbc-kit.tgz'),'-C',scratch]);
const packed=join(scratch,'package'), members=await walk(packed), files=[];
assert.equal((await json(join(packed,'package.json'))).version,lock.kitVersion);
// Remove only obsolete generated files verified against the old immutable archive.
for(const p of actual)if(!members.includes(p))await unlink(join(root,'packages/kit',p));
for(const p of members) {
  const data=await readFile(join(packed,p)), to=join(root,'packages/kit',p);
  await mkdir(dirname(to),{recursive:true}); await copyFile(join(packed,p),to);
  files.push({path:'packages/kit/'+p,bytes:data.length,sha256:sha(data)});
}
const identity=JSON.parse(execFileSync('tar',['-xOf',join(candidate,'ios-sdk.tgz'),'identity.json'],{encoding:'utf8'}));
assert.deepEqual(identity,JSON.parse(execFileSync('tar',['-xOf',join(candidate,'android-sdk.tgz'),'identity.json'],{encoding:'utf8'})));
const url=name=>`https://github.com/durianswap/tbc-kit/releases/download/${tag}/${name}`;
const replacements=new Map([['kit',lock.kit],['sdk-ios',lock.pairedNative.ios],['sdk-android',lock.pairedNative.android]]);
for(const [id,a]of replacements) {
  const target=current.artifacts.find(x=>x.id===id);
  await copyFile(join(candidate,a.file),join(root,target.path));
  Object.assign(target,{url:url(a.file),sha256:a.sha256,bytes:a.bytes,version:id==='kit'?lock.kitVersion:lock.sdkVersion});
  Object.assign(downloads.assets.find(x=>x.id===id),{url:target.url,sha256:a.sha256,bytes:a.bytes});
}
downloads.assets.find(a=>a.id==='kit').files=files;
for(const [platform,a]of Object.entries(lock.resources)) {
  const target=downloads.assets.find(x=>x.id==='resources-'+platform);
  await mkdir(dirname(join(root,target.path)),{recursive:true});
  await copyFile(join(candidate,a.archive),join(root,target.path));
  Object.assign(target,{url:url(a.archive),sha256:a.archiveSha256,bytes:a.archiveBytes});
}
await copyFile(join(candidate,'native-sdk-lock.json'),join(root,'release/native-sdk-lock.json'));
await save('release/native-sdk-identity.json',identity);
const nativeLockBytes=await readFile(join(root,'release/native-sdk-lock.json'));
Object.assign(downloads.assets.find(a=>a.id==='native-sdk-lock'),{url:url('native-sdk-lock.json'),sha256:sha(nativeLockBytes),bytes:nativeLockBytes.length});
Object.assign(current.githubRelease,{tag,sourceCommit});
Object.assign(current.pairing,{kitVersion:lock.kitVersion,sdkVersion:lock.sdkVersion,sdkArtifactSetId:identity.artifactSetId,
  keylessArtifactSetId:identity.keylessArtifactSetId,protocolFingerprint:lock.protocolFingerprint,
  nativeBuildInputKitSha256:identity.kitTarSha256,nativeBuildInputKitVersion:identity.kitVersion});
Object.assign(current.source,{snapshot:candidatePath+'/tbc-kit-source.tgz',snapshotManifest:candidatePath+'/source-manifest.json',
  snapshotArchiveManifest:candidatePath+'/source-archive.json',buildManifest:candidatePath+'/evidence/build.json',
  sourceDigest:sha(JSON.stringify(source.files)),snapshotFormat:'repository-relative-source-manifest'});
Object.assign(downloads,{tag,sourceCommit});
Object.assign(downloads.assets.find(a=>a.id==='accepted-source'),{url:url('tbc-kit-source.tgz'),path:current.source.snapshot,sha256:archive.sha256,bytes:archive.bytes});
assert.equal(JSON.stringify({artifact:current.artifacts.find(a=>a.id==='flutter'),assets:downloads.assets.filter(a=>a.id.startsWith('flutter'))}),preserved);
await save('release/current.json',current);await save('release/downloads.json',downloads);
await writeFile(join(root,'SHA256SUMS'),current.artifacts.map(a=>`${a.sha256}  ${a.path}`).join('\n')+'\n');
await writeFile(join(root,'release/DOWNLOADS.SHA256'),downloads.assets.map(a=>`${a.sha256}  ${a.name}`).join('\n')+'\n');
const inventory=[];
for(const [p,h]of Object.entries(source.files))if(p.startsWith('source/')) {
  assert.equal(sha(await readFile(join(root,p))),h,p);inventory.push({path:p,sha256:h,bytes:(await stat(join(root,p))).size});
}
await save('release/source-files.json',{schemaVersion:1,files:inventory});
const npmLock=await json(join(root,'package-lock.json'));npmLock.packages['packages/kit'].version=lock.kitVersion;await save('package-lock.json',npmLock);
console.log(JSON.stringify({status:'PASS',kitVersion:lock.kitVersion,sdkVersion:lock.sdkVersion,mirrorFiles:files.length,
  sourceFiles:inventory.length,flutterChanged:false,rebuilt:false,backup:scratch}));
