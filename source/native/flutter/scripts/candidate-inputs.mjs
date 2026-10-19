// Build-time identity checks only. No wallet/runtime work or network access.
import assert from 'node:assert/strict';
import {readFile,readdir,lstat} from 'node:fs/promises';
import {join,resolve,relative} from 'node:path';
import {createHash} from 'node:crypto';
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export async function rustSourceIdentity(root) {
  const files={};
  async function visit(path) {
    const stat=await lstat(join(root,path));
    assert.ok(!stat.isSymbolicLink(),'Build source must not be a symlink');
    if(stat.isDirectory()) {
      for(const name of (await readdir(join(root,path))).sort())await visit(join(path,name));
    } else if(stat.isFile()) files[path]=sha256(await readFile(join(root,path)));
  }
  for(const path of [
    ...['Cargo.toml','Cargo.lock','crates','vendor'].map(p=>'packages/tbc-engine/rust/'+p),
    ...['Cargo.toml','Cargo.lock','src','include','vendor'].map(p=>'native/signer/kernel/'+p),
  ]) await visit(path);
  return {sha256:sha256(JSON.stringify(files)),files};
}

export async function verifiedKitCandidate(kit) {
  const bytes=await readFile(join(kit,'artifacts/flutter-kit-candidate.json'));
  const manifest=JSON.parse(bytes);
  assert.equal(manifest.schema,1);
  const {artifactId,...identity}=manifest;
  assert.equal(artifactId,sha256(JSON.stringify(identity)),'Kit candidate identity');
  assert.match(manifest.protocolFingerprint,/^[0-9a-f]{64}$/);
  assert.match(manifest.rustSourceSha256,/^[0-9a-f]{64}$/);
  for(const required of ['package.json','artifacts/provenance.json'])assert.ok(Object.hasOwn(manifest.files,required),'Candidate manifest incomplete');
  for(const [file,hash]of Object.entries(manifest.files)) {
    assert.ok(file&&!relative(resolve(kit),resolve(kit,file)).startsWith('..')&&!file.startsWith('/'),'Candidate file path');
    assert.equal(sha256(await readFile(join(kit,file))),hash,`Kit candidate changed: ${file}`);
  }
  const pkg=JSON.parse(await readFile(join(kit,'package.json')));
  assert.equal(pkg.version,manifest.version);
  const provenance=JSON.parse(await readFile(join(kit,'artifacts/provenance.json')));
  assert.equal(provenance.protocolFingerprint,manifest.protocolFingerprint);
  for(const artifact of provenance.artifacts)assert.equal(sha256(await readFile(join(kit,artifact.path))),artifact.sha256);
  return {version:manifest.version,artifactId,protocolFingerprint:manifest.protocolFingerprint,
    rustSourceSha256:manifest.rustSourceSha256,manifestSha256:sha256(bytes)};
}

export async function verifiedKernelCandidate(directory) {
  const report=JSON.parse(await readFile(join(directory,'report.json')));
  assert.equal(report.status,'PASS_CROSS_BUILD_AND_LINK_ONLY');
  assert.equal(report.sourceSha256,sha256(await readFile(join(directory,'source.tgz'))));
  const identity=await rustSourceIdentity(join(directory,'source'));
  assert.equal(identity.sha256,report.rustSourceSha256,'Kernel source tree changed');
  const expected=new Set(['aarch64-apple-ios','aarch64-apple-ios-sim','aarch64-linux-android','armv7-linux-androideabi','x86_64-linux-android']
    .flatMap(target=>['engine','keyless','signer'].map(name=>`${target}/${name}`)));
  assert.equal(report.evidence.length,expected.size,'Complete kernel build matrix required');
  for(const entry of report.evidence) {
    assert.ok(expected.delete(`${entry.target}/${entry.name}`),'Unexpected or duplicate kernel evidence');
    assert.equal(entry.link,'PASS');
    const library={engine:'tbc_engine_native',keyless:'tbc_keyless_native',signer:'tbc_signer_kernel'}[entry.name];
    assert.ok(library);
    const file=join(directory,'target',entry.target,'release',`lib${library}.${entry.target.includes('android')?'so':'a'}`);
    assert.equal(sha256(await readFile(file)),entry.sha256,'Kernel bytes changed');
  }
  return report;
}
