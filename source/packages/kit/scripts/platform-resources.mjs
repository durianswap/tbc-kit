// Build-time resource resolution only; never used on a transaction hot path.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile, readdir, lstat} from 'node:fs/promises';
import {join, resolve} from 'node:path';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export function safePath(path) {
  assert.ok(typeof path === 'string' && path.length > 0 && !path.startsWith('/') &&
    !path.includes('\\') && path.split('/').every(p => p && p !== '.' && p !== '..'), 'Invalid resource path');
  return path;
}
export function platformOf(path) {
  if (path.startsWith('artifacts/native/ios/')) return 'ios';
  if (path.startsWith('artifacts/native/android/')) return 'android';
  if (/^artifacts\/(?:native|keyless-native)\/aarch64-apple-darwin\//.test(path)) return 'macos-arm64';
  assert.ok(!/^artifacts\/(?:native|keyless-native)\//.test(path), `Unmapped native resource: ${path}`);
  return undefined;
}
export async function fileInventory(root, prefix = '') {
  const found = {};
  for (const entry of (await readdir(join(root, prefix), {withFileTypes: true})).sort((a,b) => a.name.localeCompare(b.name, 'en'))) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    safePath(path);
    assert.ok(!entry.isSymbolicLink(), `Symlink in distribution: ${path}`);
    if (entry.isDirectory()) Object.assign(found, await fileInventory(root, path));
    else {
      assert.ok(entry.isFile(), `Non-regular distribution file: ${path}`);
      const bytes = await readFile(join(root, path));
      found[path] = {sha256: sha256(bytes), bytes: bytes.length};
    }
  }
  return found;
}
export async function platformCatalog(kitRoot) {
  const provenance = JSON.parse(await readFile(join(kitRoot, 'artifacts/provenance.json')));
  if (!provenance.platformResources) return undefined;
  const {path, sha256: expected} = provenance.platformResources;
  assert.equal(path, 'artifacts/platform-resources.json');
  const bytes = await readFile(join(kitRoot, path));
  assert.equal(sha256(bytes), expected, 'Platform catalog changed');
  const catalog = JSON.parse(bytes);
  assert.equal(catalog.schema, 1);
  const pkg = JSON.parse(await readFile(join(kitRoot, 'package.json')));
  assert.equal(catalog.package, `@tbc/kit@${pkg.version}`);
  assert.equal(catalog.protocolFingerprint, provenance.protocolFingerprint);
  const hashes = {};
  for (const [platform, group] of Object.entries(catalog.platforms)) {
    assert.ok(Object.keys(group.files).length, 'Empty platform resource set');
    for (const [path, hash] of Object.entries(group.files)) {
      safePath(path);
      assert.equal(platformOf(path), platform);
      assert.match(hash, /^[0-9a-f]{64}$/);
      assert.ok(!Object.hasOwn(hashes, path), 'Duplicate platform resource');
      hashes[path] = hash;
    }
  }
  for (const artifact of provenance.externalArtifacts ?? []) {
    assert.equal(hashes[artifact.path], artifact.sha256, 'External provenance mismatch');
  }
  return catalog;
}

export async function verifiedResourceRoot(kitRoot, resourceRoot, platforms) {
  const catalog = await platformCatalog(kitRoot);
  if (!catalog) return resolve(kitRoot); // frozen monolithic candidates
  assert.ok(resourceRoot, 'Matching platform resources required: pass --resources-root; no implicit download/fallback');
  const root = resolve(resourceRoot);
  for (const platform of platforms) {
    const group = catalog.platforms[platform];
    assert.ok(group, `Missing platform catalog: ${platform}`);
    for (const [path, expected] of Object.entries(group.files)) {
      let current = root;
      for (const part of safePath(path).split('/')) {
        current = join(current, part);
        assert.ok(!(await lstat(current)).isSymbolicLink(), `Symlink in platform resource: ${path}`);
      }
      assert.equal(sha256(await readFile(current)), expected, `Platform resource mismatch: ${path}`);
    }
  }
  return root;
}
