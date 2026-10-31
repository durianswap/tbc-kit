// Promote immutable rc.21 downloads; never rebuild packages or touch Flutter.
import assert from 'node:assert/strict';
import { readFile, writeFile, readdir, mkdir, mkdtemp, copyFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve, join, dirname } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const candidate = resolve(process.argv[2]);
const sha = b => createHash('sha256').update(b).digest('hex');
const json = async p => JSON.parse(await readFile(p, 'utf8'));
const save = (p, x) => writeFile(join(root, p), JSON.stringify(x, null, 2) + '\n');
const walk = async (dir, prefix = '') => {
  const out = [];
  for (const e of await readdir(join(dir, prefix), { withFileTypes: true })) {
    const p = prefix ? prefix + '/' + e.name : e.name;
    assert(!e.isSymbolicLink(), p);
    if (e.isDirectory()) out.push(...await walk(dir, p)); else if (e.isFile()) out.push(p);
  }
  return out.sort();
};
const lock = await json(join(candidate, 'delivery-lock.json'));
const sourceArchive = await json(join(candidate, 'source-archive.json'));
const source = await json(join(candidate, 'source-manifest.json'));
const build = await json(join(candidate, 'evidence/build.json'));
assert.equal(lock.kitVersion, '0.1.0-rc.21');
const kitBytes = await readFile(join(candidate, 'tbc-kit.tgz'));
assert.equal(sha(kitBytes), lock.kit.sha256);
assert.equal(kitBytes.length, lock.kit.bytes);
for (const [p, expected] of Object.entries(build.sourceFiles)) {
  assert.equal(sha(await readFile(join(root, p))), expected, `Frozen build input changed: ${p}`);
}
assert.equal(execFileSync('git', ['status', '--porcelain', '--', 'packages/kit'], { cwd: root, encoding: 'utf8' }), '', 'Package mirror has local edits');
await mkdir(join(root, '.verify'), { recursive: true });
const scratch = await mkdtemp(join(root, '.verify/rc21-promote-'));
execFileSync('tar', ['-xzf', join(candidate, 'tbc-kit.tgz'), '-C', scratch]);
const packed = join(scratch, 'package');
const members = await walk(packed);
assert.equal((await json(join(packed, 'package.json'))).version, lock.kitVersion);
for (const p of await walk(join(root, 'packages/kit'))) assert(members.includes(p), `Unrelated package file: ${p}`);
const files = [];
for (const p of members) {
  const from = join(packed, p), to = join(root, 'packages/kit', p), data = await readFile(from);
  await mkdir(dirname(to), { recursive: true });
  await copyFile(from, to);
  files.push({ path: 'packages/kit/' + p, bytes: data.length, sha256: sha(data) });
}
await mkdir(join(root, 'artifacts'), { recursive: true });
await copyFile(join(candidate, 'tbc-kit.tgz'), join(root, 'artifacts/tbc-kit.tgz'), 1);

const current = await json(join(root, 'release/current.json'));
const downloads = await json(join(root, 'release/downloads.json'));
const tag = 'v0.1.0-rc.21';
const url = name => `https://github.com/durianswap/tbc-kit/releases/download/${tag}/${name}`;
const candidatePath = 'release/candidates/host-port-signers-rc21';
const sourceCommit = 'cc5c3554bf6036eea1fe942930a493fb6294f7b6';
const priorFlutter = JSON.stringify(current.artifacts.find(a => a.id === 'flutter'));
const priorNative = JSON.stringify(current.artifacts.filter(a => a.id.startsWith('sdk-')));
Object.assign(current.githubRelease, { tag, sourceCommit });
current.pairing.kitVersion = lock.kitVersion;
Object.assign(current.artifacts.find(a => a.id === 'kit'), {
  url: url('tbc-kit.tgz'), sha256: lock.kit.sha256, bytes: lock.kit.bytes, version: lock.kitVersion,
});
Object.assign(current.source, {
  snapshot: candidatePath + '/tbc-kit-source.tgz',
  snapshotManifest: candidatePath + '/source-manifest.json',
  snapshotArchiveManifest: candidatePath + '/source-archive.json',
  buildManifest: candidatePath + '/evidence/build.json',
  sourceDigest: sha(JSON.stringify(source.files)),
  snapshotFormat: 'repository-relative-source-manifest',
});
Object.assign(downloads, { tag, sourceCommit });
Object.assign(downloads.assets.find(a => a.id === 'kit'), {
  url: url('tbc-kit.tgz'), sha256: lock.kit.sha256, bytes: lock.kit.bytes, files,
});
Object.assign(downloads.assets.find(a => a.id === 'accepted-source'), {
  url: url('tbc-kit-source.tgz'), path: current.source.snapshot,
  sha256: sourceArchive.sha256, bytes: sourceArchive.bytes,
});
downloads.assets.find(a => a.id === 'native-sdk-lock').url = url('native-sdk-lock.json');
assert.equal(JSON.stringify(current.artifacts.find(a => a.id === 'flutter')), priorFlutter);
assert.equal(JSON.stringify(current.artifacts.filter(a => a.id.startsWith('sdk-'))), priorNative);
await save('release/current.json', current);
await save('release/downloads.json', downloads);
await writeFile(join(root, 'SHA256SUMS'), current.artifacts.map(a => `${a.sha256}  ${a.path}`).join('\n') + '\n');
await writeFile(join(root, 'release/DOWNLOADS.SHA256'), downloads.assets.map(a => `${a.sha256}  ${a.name}`).join('\n') + '\n');
const inventory = [];
for (const [p, expected] of Object.entries(source.files)) if (p.startsWith('source/')) {
  assert.equal(sha(await readFile(join(root, p))), expected, p);
  inventory.push({ path: p, sha256: expected, bytes: (await stat(join(root, p))).size });
}
await save('release/source-files.json', { schemaVersion: 1, files: inventory });
const npmLock = await json(join(root, 'package-lock.json'));
npmLock.packages['packages/kit'].version = lock.kitVersion;
await save('package-lock.json', npmLock);
console.log(JSON.stringify({ status: 'PASS', version: lock.kitVersion, mirrorFiles: files.length,
  runtimeSourceFiles: inventory.length, flutterChanged: false, nativeArchivesChanged: false, rebuilt: false }));
