// Immutable derivation from an independently verified candidate; no compilation.
import assert from 'node:assert/strict';
import {readFile, writeFile, mkdir, copyFile, cp} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {resolve, join, dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {verifiedKitCandidate} from '../../../native/flutter/scripts/candidate-inputs.mjs';
import {fileInventory, platformOf, platformCatalog, sha256} from './platform-resources.mjs';

export async function preparePlatformCandidate({base, out, version, nativeLock}) {
  assert.match(version, /^0\.1\.0-platform-slim\.\d{8}\.\d+$/);
  base = resolve(base); out = resolve(out);
  const baseline = await verifiedKitCandidate(base);
  const inventory = await fileInventory(base);
  const groups = {};
  for (const [path, entry] of Object.entries(inventory)) {
    const platform = platformOf(path);
    if (platform) (groups[platform] ??= {})[path] = entry.sha256;
  }
  assert.deepEqual(Object.keys(groups).sort(), ['android', 'ios', 'macos-arm64']);
  await mkdir(out); // EEXIST deliberately refuses frozen outputs.
  const kit = join(out, 'package');
  await mkdir(kit);
  for (const path of Object.keys(inventory).filter(path => !platformOf(path))) {
    await mkdir(dirname(join(kit, path)), {recursive: true});
    await copyFile(join(base, path), join(kit, path));
  }
  const catalog = {schema: 1, package: `@tbc/kit@${version}`,
    protocolFingerprint: baseline.protocolFingerprint, baseline, platforms: {}};
  for (const [platform, files] of Object.entries(groups)) {
    const staging = join(out, 'platforms', platform);
    for (const path of Object.keys(files)) {
      await mkdir(dirname(join(staging, 'resources', path)), {recursive: true});
      await copyFile(join(base, path), join(staging, 'resources', path));
    }
    await cp(join(base, 'LICENSE'), join(staging, 'resources/LICENSE'));
    const manifest = {schema: 1, package: catalog.package, platform,
      protocolFingerprint: baseline.protocolFingerprint, files};
    await mkdir(join(staging, 'resources/metadata'), {recursive: true});
    await writeFile(join(staging, `resources/metadata/${platform}.json`), JSON.stringify(manifest, null, 2)+'\n');
    const archive = `tbc-kit-resources-${platform}-${version}.tgz`;
    execFileSync('tar', ['-czf', join(out, archive), '-C', staging, 'resources'],
      {env: {...process.env, COPYFILE_DISABLE: '1'}});
    const bytes = await readFile(join(out, archive));
    catalog.platforms[platform] = {archive, archiveSha256: sha256(bytes), archiveBytes: bytes.length,
      unpackedNativeBytes: Object.keys(files).reduce((n,p) => n + inventory[p].bytes, 0), files};
  }
  const pkg = JSON.parse(await readFile(join(kit, 'package.json')));
  pkg.version = version; pkg.private = true;
  // The frozen build was already verified; workspace-only prepack cannot run
  // from a standalone derived package. No install or download hook is added.
  delete pkg.scripts;
  pkg.files = [...new Set(pkg.files.filter(p => !['artifacts/native','artifacts/keyless-native'].includes(p))
    .concat('artifacts/platform-resources.json', 'artifacts/flutter-kit-candidate.json'))];
  await writeFile(join(kit, 'package.json'), JSON.stringify(pkg, null, 2)+'\n');
  const catalogBytes = JSON.stringify(catalog, null, 2)+'\n';
  await writeFile(join(kit, 'artifacts/platform-resources.json'), catalogBytes);
  const provenance = JSON.parse(await readFile(join(kit, 'artifacts/provenance.json')));
  provenance.package = catalog.package;
  provenance.externalArtifacts = provenance.artifacts.filter(a => platformOf(a.path));
  provenance.artifacts = provenance.artifacts.filter(a => !platformOf(a.path));
  provenance.platformResources = {path: 'artifacts/platform-resources.json', sha256: sha256(catalogBytes)};
  provenance.platformDistribution = {baseline, generatorSha256: sha256(await readFile(import.meta.filename)),
    executableBytesChanged: false, published: false, acceptance: 'pending separate receipt'};
  await writeFile(join(kit, 'artifacts/provenance.json'), JSON.stringify(provenance, null, 2)+'\n');
  // Install-time validation is the only executable template change. Business
  // dist, WASM and all extracted native bytes remain identical to the baseline.
  const syncPath = 'examples/react-native-engine/module/scripts/sync-native.mjs';
  await copyFile(resolve(import.meta.dirname, '..', syncPath), join(kit, syncPath));
  const docPath = 'docs/reference/platform-resource-delivery.md';
  await copyFile(resolve(import.meta.dirname, '..', docPath), join(kit, docPath));
  const distributionDoc = 'docs/reference/distribution-and-platform-integration.md';
  await copyFile(resolve(import.meta.dirname, '..', distributionDoc), join(kit, distributionDoc));
  if (nativeLock) {
    const bytes = await readFile(resolve(nativeLock)), lock = JSON.parse(bytes);
    assert.equal(lock.protocolFingerprint, baseline.protocolFingerprint, 'SDK lock protocol differs');
    for (const [path, hash] of Object.entries(lock.nativeHashes))
      assert.equal(inventory['artifacts/native/'+path]?.sha256, hash, `SDK native mismatch: ${path}`);
    assert.ok(Object.keys(lock.files).some(p => p.includes('TbcKeylessNative')), 'Full Keyless SDK lock required');
    await writeFile(join(kit, 'examples/react-native-engine/module/native-sdk-lock.json'), bytes);
  }
  // A pre-existing frozen declaration leaked a workspace-only package import.
  // Repair its type-only closure; no runtime JS or signature logic is rebuilt.
  const declarationPath = 'dist/types/legacy-bitcoin-message.d.ts';
  const declaration = await readFile(join(kit, declarationPath), 'utf8');
  assert.ok(declaration.includes('"@tbc-wallet/core"'), 'Expected frozen declaration boundary');
  await writeFile(join(kit, declarationPath), declaration.replaceAll('"@tbc-wallet/core"', '"./internal/core/index.js"'));
  const files = Object.fromEntries(Object.entries(await fileInventory(kit))
    .filter(([p]) => p !== 'artifacts/flutter-kit-candidate.json').map(([p,v]) => [p,v.sha256]));
  const identity = {schema: 1, version, sourceVersion: baseline.version,
    protocolFingerprint: baseline.protocolFingerprint, rustSourceSha256: baseline.rustSourceSha256, files};
  await writeFile(join(kit, 'artifacts/flutter-kit-candidate.json'),
    JSON.stringify({artifactId: sha256(JSON.stringify(identity)), ...identity}, null, 2)+'\n');
  const verified = await verifiedKitCandidate(kit);
  await platformCatalog(kit);
  // npm pack, not a hand-written tar, verifies the real publish allowlist.
  const [pack] = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', out],
    {cwd: kit, encoding: 'utf8', timeout: 60000}));
  assert.ok(!pack.files.some(f => platformOf(f.path)), 'Native leaked into default npm package');
  const report = {status: 'BUILT_PLATFORM_CANDIDATE_NOT_ACCEPTED', ...verified, baseline,
    tarball: pack.filename, tarballSha256: sha256(await readFile(join(out, pack.filename))),
    compressedBytes: pack.size, unpackedBytes: pack.unpackedSize, platforms: catalog.platforms,
    published: false, realChain: false, appBytesChanged: false};
  await writeFile(join(out, 'candidate.json'), JSON.stringify(report, null, 2)+'\n');
  return {out, ...report};
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [base, out, version, nativeLock] = process.argv.slice(2);
  assert.ok(base && out && version, 'FROZEN_KIT NEW_OUTPUT LOCAL_VERSION');
  const result = await preparePlatformCandidate({base, out, version, nativeLock});
  console.log(JSON.stringify({out: result.out, status: result.status, tarball: result.tarball,
    compressedBytes: result.compressedBytes, unpackedBytes: result.unpackedBytes}));
}
