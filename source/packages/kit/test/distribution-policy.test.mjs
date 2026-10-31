import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {assertDistributionManifest, writePlatformCatalog, BUILD_ONLY_SDKS} from '../scripts/distribution-policy.mjs';
import {sha256, platformCatalog} from '../scripts/platform-resources.mjs';

const pkg = {name: '@tbc/kit', version: 'test', files: ['dist', 'artifacts/wasm', 'artifacts/platform-resources.json']};
test('build-only SDKs cannot return through any production dependency category', () => {
  assertDistributionManifest({...pkg, devDependencies: {'tbc-contract': '1.6.6'}});
  for (const name of BUILD_ONLY_SDKS) for (const category of ['dependencies', 'optionalDependencies', 'peerDependencies'])
    assert.throws(() => assertDistributionManifest({...pkg, [category]: {[name]: 'test'}}), /build-only/);
});
test('native bulk inclusion and implicit download hooks are rejected', () => {
  for (const path of ['artifacts', 'artifacts/native', 'artifacts/keyless-native/', 'artifacts/native/ios'])
    assert.throws(() => assertDistributionManifest({...pkg, files: [...pkg.files, path]}), /native/);
  for (const hook of ['preinstall', 'install', 'postinstall'])
    assert.throws(() => assertDistributionManifest({...pkg, scripts: {[hook]: 'download'}}), /hook/);
  assert.throws(() => assertDistributionManifest({...pkg, files: ['dist']}), /catalog/);
});
test('catalog preserves native identity across repeated builds; hashes and unknown platforms fail closed', async t => {
  const root = await mkdtemp(join(tmpdir(), 'kit-distribution-policy-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const put = async (path, value) => {await mkdir(dirname(join(root, path)), {recursive: true}); await writeFile(join(root, path), value);};
  await put('package.json', JSON.stringify(pkg));
  const paths = ['artifacts/native/ios/library.a', 'artifacts/native/android/library.so',
    'artifacts/native/aarch64-apple-darwin/library.dylib', 'artifacts/keyless-native/aarch64-apple-darwin/keyless.dylib'];
  for (const path of paths) await put(path, path);
  const provenance = {package: '@tbc/kit@test', protocolFingerprint: 'a'.repeat(64),
    artifacts: [...paths.map(path => ({path, sha256: sha256(path)})), {path: 'artifacts/wasm/engine.wasm', sha256: 'b'.repeat(64)}]};
  const first = await writePlatformCatalog(root, provenance);
  assert.equal(provenance.artifacts.length, 1);
  assert.equal(provenance.externalArtifacts.length, 4);
  assert.deepEqual(await writePlatformCatalog(root, provenance), first);
  await put('artifacts/provenance.json', JSON.stringify(provenance));
  assert.deepEqual(await platformCatalog(root), first);
  await put(paths[0], 'changed');
  await assert.rejects(writePlatformCatalog(root, provenance), /provenance differs/);
  await put(paths[0], paths[0]);
  await put('artifacts/native/unknown/library.so', 'unknown');
  await assert.rejects(writePlatformCatalog(root, provenance), /Unmapped native/);
  await rm(join(root, 'artifacts/native/unknown'), {recursive: true});
  await put('artifacts/platform-resources.json', '{}');
  await assert.rejects(platformCatalog(root), /catalog changed/);
});
