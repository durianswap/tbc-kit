// JS-only candidate: rebuild runtime from source, retain authenticated Native/WASM.
// No network, signing, broadcasting, current-release mutation or Rust rebuild.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, cp, mkdtemp, readdir, rm, rename } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildKitRuntime } from '../source/packages/kit/scripts/runtime-build.mjs';
import { omitEmbeddedSources } from '../source/packages/kit/scripts/source-map-policy.mjs';
import { fileInventory, sha256, platformCatalog } from '../source/packages/kit/scripts/platform-resources.mjs';
import { assertDistributionManifest } from '../source/packages/kit/scripts/distribution-policy.mjs';

const repo = resolve(import.meta.dirname, '..'), root = join(repo, 'source');
const [baselineArg, outArg, protectedArg] = process.argv.slice(2);
assert(protectedArg, 'BASELINE_REPOSITORY NEW_CANDIDATE_DIR PROTECTED_MANIFEST');
const baseline = resolve(baselineArg), out = resolve(outArg);
const json = async p => JSON.parse(await readFile(p, 'utf8'));
const put = async (p, v) => writeFile(p, JSON.stringify(v, null, 2) + '\n');
const current = await json(join(baseline, 'release/current.json'));
const pkg = await json(join(root, 'packages/kit/package.json'));
assertDistributionManifest(pkg); assert.notEqual(pkg.version, current.pairing.kitVersion);
const frozen = {};
for (const item of current.artifacts) {
  assert.equal(sha256(await readFile(join(baseline, item.path))), item.sha256, item.path);
  frozen[item.id] = { file: item.path, sha256: item.sha256, bytes: item.bytes, version: item.version, url: item.url };
}
const protectedFiles = await json(resolve(protectedArg));
for (const [p, h] of Object.entries(protectedFiles)) assert.equal(sha256(await readFile(p)), h, `Protected file: ${p}`);
// Native reuse is permitted only with identical source, protocol and templates.
const unchangedPaths = ['source/packages/tbc-engine', 'source/native', 'source/schemas', 'source/registry'];
for (const path of unchangedPaths) {
  assert.equal(execFileSync('git', ['diff', '--', path], { cwd: repo, encoding: 'utf8' }), '', `Native/protocol source changed: ${path}`);
  assert.equal(execFileSync('git', ['rev-parse', `HEAD:${path}`], { cwd: repo, encoding: 'utf8' }),
    execFileSync('git', ['rev-parse', `HEAD:${path}`], { cwd: baseline, encoding: 'utf8' }), `Baseline source differs: ${path}`);
}
await mkdir(out); await mkdir(join(out, 'evidence')); // Never overwrite another candidate.
await mkdir(join(repo, '.verify'), { recursive: true });
const scratch = await mkdtemp(join(repo, '.verify/zero-balance-candidate-'));
execFileSync('tar', ['-xzf', join(baseline, frozen.kit.file), '-C', scratch]);
const stage = join(scratch, 'package');
const before = await fileInventory(stage);
// Only generated top-level JS bundles in this fresh scratch copy are replaced.
// Private parser/vendor bytes and frozen types remain identical.
for (const format of ['esm', 'cjs']) for (const entry of await readdir(join(stage, 'dist', format), { withFileTypes: true })) {
  if (entry.isFile()) await rm(join(stage, 'dist', format, entry.name));
}
await buildKitRuntime({ root, packageRoot: stage });
await omitEmbeddedSources(join(stage, 'dist'));
await cp(join(root, 'packages/kit/examples'), join(stage, 'examples'), { recursive: true });
await cp(join(root, 'packages/kit/docs/zero-balance-inputs.md'), join(stage, 'docs/zero-balance-inputs.md'));
await cp(join(root, 'packages/kit/SUPPORT.md'), join(stage, 'SUPPORT.md'));
await put(join(stage, 'package.json'), pkg);
const provenance = await json(join(stage, 'artifacts/provenance.json'));
provenance.package = `${pkg.name}@${pkg.version}`;
provenance.distribution = { kind: 'source-built-js-with-verified-frozen-native', baselineVersion: current.pairing.kitVersion,
  baselineArchiveSha256: frozen.kit.sha256, nativeSdkVersion: current.pairing.sdkVersion,
  changes: ['zero holder filtering before proof reads', 'explicit zero input typed rejection', 'positive input and Pool reserve validation preserved'] };
const catalog = await json(join(stage, 'artifacts/platform-resources.json'));
catalog.package = provenance.package;
await put(join(stage, 'artifacts/platform-resources.json'), catalog);
provenance.platformResources.sha256 = sha256(await readFile(join(stage, 'artifacts/platform-resources.json')));
await put(join(stage, 'artifacts/provenance.json'), provenance);
await platformCatalog(stage);
const after = await fileInventory(stage);
const preserved = Object.keys(before).filter(p => /^artifacts\/wasm\//.test(p) || /^dist\/(esm|cjs)\/vendor\//.test(p));
for (const p of preserved) assert.deepEqual(after[p], before[p], `Frozen compute/parser changed: ${p}`);
const sourceNames = execFileSync('git', ['ls-files', '-c', '-o', '--exclude-standard', '-z', 'source', 'scripts/build-zero-balance-candidate.mjs'],
  { cwd: repo, encoding: 'utf8', maxBuffer: 8e6 }).split('\0').filter(Boolean).sort();
const sourceFiles = {};
for (const p of [...new Set(sourceNames)]) sourceFiles[p] = sha256(await readFile(join(repo, p)));
await put(join(stage, 'artifacts/source-build.json'), { schemaVersion: 1, version: pkg.version,
  status: 'source-built-js-frozen-native-not-device-or-chain-accepted', sourceDigest: sha256(JSON.stringify(sourceFiles)),
  baselineArchiveSha256: frozen.kit.sha256, unchangedNativeAndProtocolPaths: unchangedPaths,
  outputDigest: sha256(JSON.stringify(Object.fromEntries(Object.entries(after).filter(([p]) => p !== 'artifacts/source-build.json')))) });
// Reuse authenticated Native artifacts, not --build:kit's implicit Rust rebuild.
// The separate source/output identity above is explicit; standard prepack applies
// only to full builds in source/, not this independently verified staging tree.
const [pack] = JSON.parse(execFileSync('npm', ['pack', stage, '--ignore-scripts', '--json', '--pack-destination', out],
  { cwd: scratch, encoding: 'utf8', maxBuffer: 16e6 }));
assert.equal(pack.version, pkg.version);
assert(!pack.files.some(f => /^artifacts\/(native|keyless-native)\//.test(f.path)));
await rename(join(out, pack.filename), join(out, 'tbc-kit.tgz'));
await cp(join(baseline, 'release/native-sdk-lock.json'), join(out, 'native-sdk-lock.json'));
const lock = { schema: 1, kitVersion: pkg.version, sdkVersion: current.pairing.sdkVersion,
  protocolFingerprint: current.pairing.protocolFingerprint, sdkArtifactSetId: current.pairing.sdkArtifactSetId,
  kit: { file: 'tbc-kit.tgz', sha256: sha256(await readFile(join(out, 'tbc-kit.tgz'))), bytes: pack.size, unpackedBytes: pack.unpackedSize },
  pairedNative: { ios: frozen['sdk-ios'], android: frozen['sdk-android'] },
  resources: catalog.platforms, baseline: frozen, partnerDeliveryChanged: false, currentReleaseChanged: false };
await put(join(out, 'delivery-lock.json'), lock);
await put(join(out, 'evidence/build.json'), { status: 'PASS', stage, scratch, sourceDigest: sha256(JSON.stringify(sourceFiles)),
  sourceFiles, preservedComputeAndParserFiles: preserved.length, reusedNative: true, realNetworkBusinessRun: false, broadcast: false });
await put(join(out, 'evidence/protected-before.json'), { files: Object.keys(protectedFiles).length, allMatch: true, frozen });
console.log(JSON.stringify({ out, stage, ...lock.kit, preservedComputeAndParserFiles: preserved.length, protectedFiles: Object.keys(protectedFiles).length }));
