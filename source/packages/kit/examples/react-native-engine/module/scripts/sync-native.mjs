import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const digest = value => createHash('sha256').update(value).digest('hex');
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
async function locateKit(appRoot) {
  const require = createRequire(resolve(appRoot, 'package.json'));
  let current = dirname(require.resolve('@tbc/kit/engine'));
  while (dirname(current) !== current) {
    try { if ((await readJson(resolve(current, 'package.json'))).name === '@tbc/kit') return current; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    current = dirname(current);
  }
  throw new Error('Install @tbc/kit in the app before preparing its native module');
}
async function files(root, prefix = '') {
  const result = [];
  for (const entry of await readdir(resolve(root, prefix), { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    assert.ok(!entry.isSymbolicLink(), `Native artifact symlinks are not supported: ${name}`);
    if (entry.isDirectory()) result.push(...await files(root, name));
    else if (entry.isFile()) result.push(name);
  }
  return result.sort();
}

export async function syncNative({ moduleRoot, appRoot = resolve(moduleRoot, '../..'), kitRoot, nativeSdkRoot, check = false, platform }) {
  assert.ok(platform === undefined || ['ios', 'android', 'all'].includes(platform), 'Invalid SDK platform');
  kitRoot ??= await locateKit(appRoot);
  const [manifest, provenance, lock] = await Promise.all([
    readJson(resolve(kitRoot, 'package.json')), readJson(resolve(kitRoot, 'artifacts/provenance.json')),
    readJson(resolve(moduleRoot, 'native-sdk-lock.json')),
  ]);
  assert.equal(manifest.name, '@tbc/kit');
  assert.equal(provenance.package, `@tbc/kit@${manifest.version}`);
  assert.equal(provenance.protocolFingerprint, lock.protocolFingerprint, 'SDK protocol differs from installed Kit');
  assert.equal(provenance.nativeBridge?.iosMinimumVersion, '15.1');
  let externalHashes;
  if (provenance.platformResources) {
    assert.equal(provenance.platformResources.path, 'artifacts/platform-resources.json');
    const bytes = await readFile(resolve(kitRoot, provenance.platformResources.path));
    assert.equal(digest(bytes), provenance.platformResources.sha256, 'Platform catalog changed');
    const catalog = JSON.parse(bytes);
    assert.equal(catalog.schema, 1);
    assert.equal(catalog.package, provenance.package);
    assert.equal(catalog.protocolFingerprint, lock.protocolFingerprint);
    externalHashes = { ...catalog.platforms.ios.files, ...catalog.platforms.android.files };
  }
  for (const [name, expected] of Object.entries(lock.nativeHashes)) {
    assert.ok(!name.startsWith('/') && !name.includes('\\') && !name.split('/').includes('..'), 'Invalid native lock path');
    const path = `artifacts/native/${name}`;
    // Split delivery validates SDK inputs against the pinned catalog, then
    // validates every SDK output below. It never loads a different old library.
    if (externalHashes) assert.equal(externalHashes[path], expected, `Native provenance mismatch: ${name}`);
    else assert.equal(digest(await readFile(resolve(kitRoot, path))), expected, `Native provenance mismatch: ${name}`);
    if (/\.(a|so)$/.test(name)) assert.equal(
      (externalHashes ? provenance.externalArtifacts : provenance.artifacts).find(a => a.path === path)?.sha256, expected);
  }
  const target = resolve(moduleRoot, 'platform-sdk');
  const source = check ? target : nativeSdkRoot;
  assert.ok(source, 'Pass a verified nativeSdkRoot; no implicit downloads or legacy bridge fallback');
  let preparedIdentity;
  if (check) {
    try { preparedIdentity = await readJson(resolve(moduleRoot, 'generated/identity.json')); }
    catch (error) { if (error instanceof SyntaxError) throw new Error('Stale generated identity', { cause: error }); throw error; }
  }
  const selectedPlatform = check ? preparedIdentity?.platform ?? 'all' : platform ?? 'all';
  assert.ok(['ios', 'android', 'all'].includes(selectedPlatform), 'Invalid prepared SDK platform');
  if (check && platform) assert.ok(selectedPlatform === 'all' || selectedPlatform === platform,
    `SDK was prepared for ${selectedPlatform}, not ${platform}; prepare a new matching module`);
  const selectedFiles = Object.fromEntries(Object.entries(lock.files).filter(([name]) => {
    assert.ok(name === 'identity.json' || name.startsWith('apple/') || name.startsWith('maven-repository/'), 'Unknown SDK resource group');
    return selectedPlatform === 'all' || name === 'identity.json' || name.startsWith(selectedPlatform === 'ios' ? 'apple/' : 'maven-repository/');
  }));
  // Keep the complete SDK identity/lock. Validate every selected byte before
  // copying; an unrelated platform archive is no longer required on disk.
  for (const [name, expected] of Object.entries(selectedFiles)) {
    assert.ok(!name.startsWith('/') && !name.split('/').includes('..'), 'Invalid SDK lock path');
    assert.equal(digest(await readFile(resolve(source, name))), expected, `SDK artifact mismatch: ${name}`);
  }
  const sdkIdentity = await readJson(resolve(source, 'identity.json'));
  assert.equal(sdkIdentity.artifactSetId, lock.artifactSetId);
  assert.equal(sdkIdentity.sdkVersion, lock.sdkVersion);
  const identity = { kitVersion: manifest.version, sdkVersion: lock.sdkVersion,
    protocolFingerprint: lock.protocolFingerprint, artifactSetId: lock.artifactSetId,
    sdkLockSha256: digest(await readFile(resolve(moduleRoot, 'native-sdk-lock.json'))),
    ...(selectedPlatform === 'all' ? {} : { platform: selectedPlatform }) };
  const generated = `${JSON.stringify(identity, null, 2)}\n`;
  if (check) {
    assert.deepEqual(await files(target), Object.keys(selectedFiles).sort(), 'Unexpected SDK files');
    assert.equal(await readFile(resolve(moduleRoot, 'generated/identity.json'), 'utf8'), generated, 'Stale generated identity');
  } else {
    let existing = [];
    try { existing = await files(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    assert.ok(existing.every(name => Object.hasOwn(selectedFiles, name)), 'Prepare a fresh module to change SDK platform; existing files are not deleted');
    for (const name of Object.keys(selectedFiles)) {
      await mkdir(dirname(resolve(target, name)), { recursive: true });
      await copyFile(resolve(source, name), resolve(target, name));
    }
    await mkdir(resolve(moduleRoot, 'generated'), { recursive: true });
    await writeFile(resolve(moduleRoot, 'generated/identity.json'), generated);
  }
  return identity;
}

if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(process.argv[1])).href) {
  const moduleRoot = resolve(import.meta.dirname, '..');
  const args = process.argv.slice(2), check = args.includes('--check');
  const sdkIndex = args.indexOf('--sdk-root');
  const platformIndex = args.indexOf('--platform');
  const platform = platformIndex >= 0 ? args[platformIndex + 1] : undefined;
  if (platformIndex >= 0) assert.ok(platform && !platform.startsWith('--'), 'Pass --platform ios|android|all');
  const nativeSdkRoot = sdkIndex >= 0 && args[sdkIndex + 1] ? resolve(args[sdkIndex + 1]) : undefined;
  const identity = await syncNative({ moduleRoot, check, nativeSdkRoot, platform });
  console.log(JSON.stringify({ ok: true, check, ...identity }));
}
