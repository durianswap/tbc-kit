import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { acquireAsset, restoreFiles, safePath } from '../scripts/fetch-assets.mjs';

const sha=b=>createHash('sha256').update(b).digest('hex');
async function fixture(t) {
  const root=await mkdtemp(join(tmpdir(),'tbc-download-test-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const source=join(root,'upload');await mkdir(source);
  const bytes=Buffer.from('unchanged accepted package');
  await writeFile(join(source,'test.tgz'),bytes);
  const asset={id:'test',name:'test.tgz',path:'artifacts/test.tgz',bytes:bytes.length,sha256:sha(bytes),url:'https://github.com/durianswap/tbc-kit/releases/download/v0.1.0-rc.19/test.tgz'};
  return {root,source,bytes,asset};
}

test('asset copy preserves bytes and reuses an already verified file without network',async t=>{
  const f=await fixture(t);
  const path=await acquireAsset(f.root,f.asset,f.source);
  assert.deepEqual(await readFile(path),f.bytes);
  assert.equal(await acquireAsset(f.root,f.asset),path);
});
test('a changed local download is rejected rather than overwritten',async t=>{
  const f=await fixture(t);const path=await acquireAsset(f.root,f.asset,f.source);
  await writeFile(path,'local edit');
  await assert.rejects(acquireAsset(f.root,f.asset,f.source),/mismatch/);
  assert.equal(await readFile(path,'utf8'),'local edit');
});
test('wrong checksum never installs an artifact',async t=>{
  const f=await fixture(t);
  await assert.rejects(acquireAsset(f.root,{...f.asset,sha256:'0'.repeat(64)},f.source),/SHA256 mismatch/);
  await assert.rejects(readFile(join(f.root,f.asset.path)),{code:'ENOENT'});
});
test('downloads are restricted to the declared repository',async t=>{
  const f=await fixture(t);
  await assert.rejects(acquireAsset(f.root,{...f.asset,url:'https://example.com/test.tgz'},f.source));
});
test('paths cannot escape the root',()=>{
  for(const path of ['../outside','/outside','a/../b','a\\b','./a',''])assert.throws(()=>safePath('/tmp/root',path));
});
test('archive restoration verifies every member and preserves local edits',async t=>{
  const f=await fixture(t);const staging=join(f.root,'staging');
  await mkdir(join(staging,'package'),{recursive:true});
  await writeFile(join(staging,'package','hello.txt'),'accepted content');
  const archive=join(f.source,'content.tgz');
  execFileSync('tar',['-czf',archive,'-C',staging,'package']);
  const bytes=Buffer.from('accepted content');
  const asset={id:'content',archiveRoot:'package/',extractTo:'packages/kit/',files:[{path:'packages/kit/hello.txt',bytes:bytes.length,sha256:sha(bytes)}]};
  assert.equal(await restoreFiles(f.root,asset,archive),1);
  assert.equal(await restoreFiles(f.root,asset,archive),0);
  await writeFile(join(f.root,'packages/kit/hello.txt'),'my change');
  await assert.rejects(restoreFiles(f.root,asset,archive),/mismatch/);
  assert.equal(await readFile(join(f.root,'packages/kit/hello.txt'),'utf8'),'my change');
});
test('historical migration record stays immutable; current restoration uses its own inventory',async()=>{
  const root=new URL('../',import.meta.url);
  const downloads=JSON.parse(await readFile(new URL('release/downloads.json',root),'utf8'));
  assert.equal(sha(await readFile(new URL('release/storage-migration.json',root))),'54adfb583d026eb1e881f36e5e4c4d5e4335064f99b93dfb363c3b34ee0df797');
  const current=JSON.parse(await readFile(new URL('release/current.json',root),'utf8'));
  for(const artifact of current.artifacts){const asset=downloads.assets.find(a=>a.id===artifact.id);
    assert.equal(asset.sha256,artifact.sha256);assert.equal(asset.bytes,artifact.bytes);}
  const kit=downloads.assets.find(a=>a.id==='kit');
  assert(kit.files.some(f=>f.path==='packages/kit/artifacts/platform-resources.json'));
  assert(!kit.files.some(f=>/packages\/kit\/artifacts\/(native|keyless-native)\//.test(f.path)));
});
test('download selection exposes the current candidate while retaining historical evidence',async()=>{
  const root=new URL('../',import.meta.url);
  const downloads=JSON.parse(await readFile(new URL('release/downloads.json',root),'utf8'));
  assert(!('history' in downloads.groups));
  assert(!downloads.assets.some(a=>a.id==='candidate-archive'));
  const currentPath='release/candidates/zero-balance-rc22/';
  assert(downloads.aliases.every(a=>a.path.startsWith(currentPath)));
  assert(downloads.assets.filter(a=>a.path.startsWith('release/candidates/')).every(a=>a.path.startsWith(currentPath)));
  assert((await readdir(new URL('release/candidates/',root))).includes('host-port-signers-rc21'));
  assert((await readdir(new URL('release/candidates/',root))).includes('zero-balance-rc22'));
  // Earlier reports remain evidence, not another selected installable version.
  assert(!downloads.assets.some(a=>a.path.includes('lean-distribution-rc20')));
  const sums=await readFile(new URL('release/DOWNLOADS.SHA256',root),'utf8');
  assert.equal(sums,downloads.assets.map(a=>`${a.sha256}  ${a.name}`).join('\n')+'\n');
});
