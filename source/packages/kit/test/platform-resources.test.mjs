import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, mkdir, writeFile, readFile, rm, symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {platformCatalog, verifiedResourceRoot, fileInventory, platformOf, safePath, sha256} from '../scripts/platform-resources.mjs';

test('platform catalog binds exact kit, protocol, native files and optional resource roots', async t => {
  const root = await mkdtemp(join(tmpdir(), 'kit-platform-resources-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const kit = join(root, 'kit'), resources = join(root, 'resources');
  await mkdir(join(kit, 'artifacts'), {recursive: true});
  const path = 'artifacts/native/ios/TbcEngineNative.xcframework/library.a';
  await mkdir(dirname(join(resources, path)), {recursive: true});
  await writeFile(join(resources, path), 'controlled native');
  const hash = sha256('controlled native');
  await writeFile(join(kit, 'package.json'), JSON.stringify({version: 'test'}));
  const catalog = {schema: 1, package: '@tbc/kit@test', protocolFingerprint: 'p',
    platforms: {ios: {files: {[path]: hash}}}};
  const bytes = JSON.stringify(catalog);
  const provenance = {package: '@tbc/kit@test', protocolFingerprint: 'p', artifacts: [],
    externalArtifacts: [{path, sha256: hash}],
    platformResources: {path: 'artifacts/platform-resources.json', sha256: sha256(bytes)}};
  await writeFile(join(kit, 'artifacts/platform-resources.json'), bytes);
  await writeFile(join(kit, 'artifacts/provenance.json'), JSON.stringify(provenance));
  assert.deepEqual(await platformCatalog(kit), catalog);
  await assert.rejects(verifiedResourceRoot(kit, undefined, ['ios']), /Matching platform resources/);
  assert.equal(await verifiedResourceRoot(kit, resources, ['ios']), resources);
  await assert.rejects(verifiedResourceRoot(kit, resources, ['android']), /Missing platform/);
  await writeFile(join(resources, path), 'wrong candidate');
  await assert.rejects(verifiedResourceRoot(kit, resources, ['ios']), /resource mismatch/);
  await rm(join(resources, path));
  await writeFile(join(root, 'external.a'), 'controlled native');
  await symlink(join(root, 'external.a'), join(resources, path));
  await assert.rejects(verifiedResourceRoot(kit, resources, ['ios']), /Symlink/);
  await assert.rejects(fileInventory(resources), /Symlink/);
  await writeFile(join(kit, 'artifacts/platform-resources.json'), bytes+' ');
  await assert.rejects(platformCatalog(kit), /catalog changed/);
});

test('unmapped targets and unsafe resource paths cannot silently disappear from delivery', () => {
  for (const path of ['/abs', '../file', 'a/../b', 'a//b', 'C:\\file', '.']) assert.throws(() => safePath(path));
  assert.equal(platformOf('artifacts/native/ios/a'), 'ios');
  assert.equal(platformOf('artifacts/native/android/a'), 'android');
  assert.equal(platformOf('artifacts/keyless-native/aarch64-apple-darwin/a'), 'macos-arm64');
  assert.equal(platformOf('dist/esm/index.js'), undefined);
  assert.throws(() => platformOf('artifacts/native/new-target/a'), /Unmapped/);
});

test('monolithic frozen source retains its explicit local resource path', async t => {
  const root = await mkdtemp(join(tmpdir(), 'kit-platform-monolith-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  await mkdir(join(root, 'artifacts'));
  await writeFile(join(root, 'artifacts/provenance.json'), '{}');
  assert.equal(await verifiedResourceRoot(root, undefined, ['ios']), root);
});
