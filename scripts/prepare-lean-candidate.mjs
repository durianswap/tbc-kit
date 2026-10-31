// Distribution-only derivative: verifies and reuses frozen execution bytes.
// No build, live API request, key access, broadcast, publication or current-release mutation.
import assert from 'node:assert/strict';
import {readFile, writeFile, mkdir, cp, rename, mkdtemp} from 'node:fs/promises';
import {join, resolve, dirname} from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileInventory, platformOf, sha256, platformCatalog} from '../source/packages/kit/scripts/platform-resources.mjs';
import {assertDistributionManifest, writePlatformCatalog} from '../source/packages/kit/scripts/distribution-policy.mjs';

const repo = resolve(import.meta.dirname, '..');
const [assetsArg, outArg, protectedArg] = process.argv.slice(2);
assert(assetsArg && outArg && protectedArg, 'ASSET_DIRECTORY NEW_CANDIDATE_DIRECTORY PROTECTED_MANIFEST');
const assets = resolve(assetsArg), out = resolve(outArg);
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
const putJson = (path, data) => writeFile(path, JSON.stringify(data, null, 2) + '\n');
const current = await readJson(join(repo, 'release/current.json'));
const manifest = await readJson(join(repo, 'source/packages/kit/package.json'));
assertDistributionManifest(manifest);
assert.notEqual(manifest.version, current.pairing.kitVersion);
// Verify protected delivery and all paired inputs before creating a derivative.
const protectedFiles = await readJson(resolve(protectedArg));
for (const [path, expected] of Object.entries(protectedFiles))
  assert.equal(sha256(await readFile(path)), expected, `Protected delivery changed: ${path}`);
const frozen = {};
for (const item of current.artifacts) {
  const name = item.path.split('/').at(-1), bytes = await readFile(join(assets, name));
  assert.equal(bytes.length, item.bytes, name);
  assert.equal(sha256(bytes), item.sha256, name);
  frozen[name] = {sha256: item.sha256, bytes: item.bytes};
}
await mkdir(out); // Existing candidates must never be overwritten.
await mkdir(join(out, 'evidence'));
await mkdir(join(repo, '.verify'), {recursive: true});
const scratch = await mkdtemp(join(repo, '.verify/lean-candidate-'));
execFileSync('tar', ['-xzf', join(assets, 'tbc-kit.tgz'), '-C', scratch]);
const baseline = join(scratch, 'package'), stage = join(scratch, 'candidate');
const before = await fileInventory(baseline);
await cp(baseline, stage, {recursive: true});
await putJson(join(stage, 'package.json'), manifest);
for (const name of ['README.md', 'SUPPORT.md', 'docs/compatibility.md', 'docs/platform-resources.md'])
  await cp(join(repo, 'source/packages/kit', name), join(stage, name));

const provenance = await readJson(join(stage, 'artifacts/provenance.json'));
assert.equal(provenance.protocolFingerprint, current.pairing.protocolFingerprint);
const groups = {};
for (const [path, item] of Object.entries(before)) {
  const platform = platformOf(path);
  if (platform) (groups[platform] ??= {})[path] = item;
}
const archiveMetadata = {};
for (const [platform, files] of Object.entries(groups)) {
  const root = join(scratch, platform), resources = join(root, 'resources');
  for (const path of Object.keys(files)) {
    await mkdir(dirname(join(resources, path)), {recursive: true});
    await cp(join(baseline, path), join(resources, path));
  }
  await cp(join(baseline, 'LICENSE'), join(root, 'LICENSE'));
  const archive = `tbc-kit-native-resources-${platform}.tgz`;
  execFileSync('tar', ['-czf', join(out, archive), '-C', root, 'resources', 'LICENSE']);
  const bytes = await readFile(join(out, archive));
  archiveMetadata[platform] = {archive, archiveSha256: sha256(bytes), archiveBytes: bytes.length};
}
provenance.package = `@tbc/kit@${manifest.version}`;
provenance.distribution = {kind: 'unchanged-runtime-repack',
  baseline: {package: `@tbc/kit@${current.pairing.kitVersion}`, ...frozen['tbc-kit.tgz']},
  sdkVersion: current.pairing.sdkVersion};
await writePlatformCatalog(stage, provenance, archiveMetadata);
await putJson(join(stage, 'artifacts/provenance.json'), provenance);
await platformCatalog(stage);
const baseSourceBuild = await readJson(join(baseline, 'artifacts/source-build.json'));
await putJson(join(stage, 'artifacts/source-build.json'), {schemaVersion: 1, version: manifest.version,
  status: 'distribution-only-repack-not-a-new-runtime-build', baseline: baseSourceBuild,
  baselineArchiveSha256: frozen['tbc-kit.tgz'].sha256});
const after = await fileInventory(stage);
const unchanged = Object.keys(before).filter(path => /^(dist\/|examples\/|artifacts\/(?:wasm|native|keyless-native)\/)/.test(path));
for (const path of unchanged) assert.deepEqual(after[path], before[path], `Execution/bridge bytes changed: ${path}`);
// --ignore-scripts is deliberate for a verified repack, not the source build path.
// Ordinary source builds still use the source/output-bound prepack gate.
const [pack] = JSON.parse(execFileSync('npm', ['pack', stage, '--ignore-scripts', '--json', '--pack-destination', out],
  {cwd: scratch, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024}));
assert.equal(pack.version, manifest.version);
assert(pack.files.some(f => f.path === 'artifacts/platform-resources.json'));
assert(!pack.files.some(f => platformOf(f.path)), 'Native bytes leaked into npm archive');
await rename(join(out, pack.filename), join(out, 'tbc-kit.tgz'));
for (const name of ['ios-sdk.tgz', 'android-sdk.tgz']) await cp(join(assets, name), join(out, name));
await cp(join(repo, 'release/native-sdk-lock.json'), join(out, 'native-sdk-lock.json'));
await cp(join(repo, 'docs/candidates/rc20-distribution.md'), join(out, 'README.md'));
const tarBytes = await readFile(join(out, 'tbc-kit.tgz'));
const lock = {schema: 1, kitVersion: manifest.version, sdkVersion: current.pairing.sdkVersion,
  protocolFingerprint: current.pairing.protocolFingerprint,
  sdkArtifactSetId: current.pairing.sdkArtifactSetId, baseline: frozen,
  kit: {file: 'tbc-kit.tgz', sha256: sha256(tarBytes), bytes: tarBytes.length, unpackedBytes: pack.unpackedSize},
  sdk: Object.fromEntries(['ios-sdk.tgz', 'android-sdk.tgz'].map(name => [name, frozen[name]])),
  resources: archiveMetadata, partnerDeliveryChanged: false, published: false};
await putJson(join(out, 'delivery-lock.json'), lock);
await putJson(join(out, 'evidence/runtime-identity.json'), {baselineVersion: current.pairing.kitVersion,
  candidateVersion: manifest.version, files: Object.fromEntries(unchanged.map(path => [path, before[path]])),
  preservedFiles: unchanged.length, byteIdentical: true, noRuntimeBuild: true});
await putJson(join(out, 'evidence/protected-before.json'), {files: Object.keys(protectedFiles).length,
  allMatch: true, manifestSha256: sha256(await readFile(resolve(protectedArg))), frozen});
console.log(JSON.stringify({out, scratch, ...lock.kit, preservedFiles: unchanged.length}));
