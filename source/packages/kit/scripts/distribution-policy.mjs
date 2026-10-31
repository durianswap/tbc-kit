// Build/package-time only. Never imported by a wallet or transaction runtime.
import assert from 'node:assert/strict';
import {readFile, writeFile, access} from 'node:fs/promises';
import {join} from 'node:path';
import {fileInventory, platformOf, sha256} from './platform-resources.mjs';

export const BUILD_ONLY_SDKS = Object.freeze(['tbc-contract', 'tbc-tx-parser', 'tbc-lib-js']);

export function assertDistributionManifest(pkg) {
  assert.equal(pkg.name, '@tbc/kit');
  for (const name of BUILD_ONLY_SDKS) {
    assert(!pkg.dependencies?.[name] && !pkg.optionalDependencies?.[name] && !pkg.peerDependencies?.[name],
      `Full SDK must remain build-only: ${name}`);
  }
  assert(pkg.files.includes('artifacts/platform-resources.json'), 'Platform catalog must be packed');
  assert(!pkg.files.some(p => /^(?:artifacts\/?$|artifacts\/(?:native|keyless-native)(?:\/|$))/.test(p)),
    'Default npm package must not include native platform libraries');
  for (const hook of ['preinstall', 'install', 'postinstall']) assert(!pkg.scripts?.[hook], 'No implicit install/download hook');
}

export async function writePlatformCatalog(packageRoot, provenance, archiveMetadata = {}) {
  const pkg = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  assertDistributionManifest(pkg);
  const groups = {};
  // Keep native files in the build tree for explicit SDK assembly. The npm
  // allowlist excludes them; no runtime fallback or file deletion is required.
  for (const prefix of ['artifacts/native', 'artifacts/keyless-native']) {
    try { await access(join(packageRoot, prefix)); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    for (const [name, item] of Object.entries(await fileInventory(join(packageRoot, prefix)))) {
      const path = `${prefix}/${name}`;
      const platform = platformOf(path);
      (groups[platform] ??= {})[path] = item.sha256;
    }
  }
  assert.deepEqual(Object.keys(groups).sort(), ['android', 'ios', 'macos-arm64'], 'Complete pinned platform inventory required');
  const catalog = {schema: 1, package: `@tbc/kit@${pkg.version}`, protocolFingerprint: provenance.protocolFingerprint,
    platforms: Object.fromEntries(Object.entries(groups).map(([platform, files]) =>
      [platform, {...archiveMetadata[platform], files}]))};
  const nativeArtifacts = [...(provenance.artifacts ?? []), ...(provenance.externalArtifacts ?? [])]
    .filter(a => platformOf(a.path));
  const byPath = new Map(nativeArtifacts.map(a => [a.path, a]));
  for (const a of byPath.values()) {
    assert.equal(groups[platformOf(a.path)][a.path], a.sha256, `Native provenance differs: ${a.path}`);
  }
  const bytes = JSON.stringify(catalog, null, 2) + '\n';
  await writeFile(join(packageRoot, 'artifacts/platform-resources.json'), bytes);
  provenance.artifacts = (provenance.artifacts ?? []).filter(a => !platformOf(a.path));
  provenance.externalArtifacts = [...byPath.values()];
  provenance.platformResources = {path: 'artifacts/platform-resources.json', sha256: sha256(bytes)};
  return catalog;
}
