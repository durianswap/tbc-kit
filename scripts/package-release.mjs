import assert from 'node:assert/strict';
import { readFile, writeFile, readdir, mkdtemp, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const read = path => readFile(join(root, path));
const json = async path => JSON.parse(await read(path));
const sha = value => createHash('sha256').update(value).digest('hex');
const save = (path, value) => writeFile(join(root, path), typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n');
const excluded = new Set(['node_modules', 'dist', 'target', 'build', '.dart_tool', '.gradle', '.build', 'Pods']);
async function files(path, sourceOnly = false) {
  return (await Promise.all((await readdir(join(root, path), { withFileTypes: true })).map(e => {
    if (sourceOnly && excluded.has(e.name)) return [];
    assert(!e.isSymbolicLink(), `Unexpected symlink: ${path}/${e.name}`);
    return e.isDirectory() ? files(`${path}/${e.name}`, sourceOnly) : `${path}/${e.name}`;
  }))).flat().sort();
}

const kitVersion = (await json('packages/kit/package.json')).version;
const provenance = await json('packages/kit/artifacts/provenance.json');
provenance.package = `@tbc/kit@${kitVersion}`;
await save('packages/kit/artifacts/provenance.json', provenance);

// Current-version inventories; native library identities are preserved.
const identity = await json('packages/kit/artifacts/distribution.json');
delete identity.artifactId;
identity.version = kitVersion;
identity.files = {};
for (const p of await files('packages/kit')) {
  if (p === 'packages/kit/artifacts/distribution.json') continue;
  identity.files[p.slice('packages/kit/'.length)] = sha(await read(p));
}
await save('packages/kit/artifacts/distribution.json', { artifactId: sha(JSON.stringify(identity)), ...identity });

const flutterInventory = { schema: 1, files: {}, bytes: 0 };
for (const p of await files('packages/flutter')) {
  if (p.endsWith('/package-files.json')) continue;
  const bytes = await read(p);
  flutterInventory.files[p.slice('packages/flutter/'.length)] = sha(bytes);
  flutterInventory.bytes += bytes.length;
}
await save('packages/flutter/package-files.json', flutterInventory);

const staging = await mkdtemp(join(tmpdir(), 'tbc-kit-package-'));
try {
  for (const [directory, name] of [['kit', 'package'], ['flutter', 'tbc_kit_flutter_dart']]) {
    await cp(join(root, 'packages', directory), join(staging, name), { recursive: true });
    const archive = directory === 'kit' ? 'tbc-kit.tgz' : 'tbc-kit-flutter.tgz';
    execFileSync('tar', ['--no-xattrs', '-czf', join(root, 'artifacts', archive), '-C', staging, name], {
      env: { ...process.env, COPYFILE_DISABLE: '1' },
    });
  }
} finally {
  await rm(staging, { recursive: true, force: true });
}

const release = await json('release/current.json');
release.pairing.kitVersion = kitVersion;
for (const artifact of release.artifacts) {
  const bytes = await read(artifact.path);
  artifact.sha256 = sha(bytes);
  artifact.bytes = bytes.length;
  if (['kit', 'flutter'].includes(artifact.id)) artifact.version = kitVersion;
}
await save('release/current.json', release);
await save('SHA256SUMS', release.artifacts.map(a => `${a.sha256}  ${a.path}`).join('\n') + '\n');

const sourceFiles = [];
for (const path of await files('source', true)) {
  const bytes = await read(path);
  sourceFiles.push({ path, sha256: sha(bytes), bytes: bytes.length });
}
await save('release/source-files.json', { schemaVersion: 1, files: sourceFiles });
console.log(JSON.stringify({ version: kitVersion, archives: release.artifacts.filter(a => ['kit', 'flutter'].includes(a.id)), sourceFiles: sourceFiles.length }, null, 2));
