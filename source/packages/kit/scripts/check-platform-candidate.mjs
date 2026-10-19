// Exact installed-file and split-resource checks; offline public fixtures only.
import assert from 'node:assert/strict';
import {readFile, writeFile, mkdir, copyFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {resolve, join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {fileInventory, platformOf, platformCatalog, verifiedResourceRoot, sha256} from './platform-resources.mjs';
import {verifiedKitCandidate} from '../../../native/flutter/scripts/candidate-inputs.mjs';

const [baseArg, candidateArg, installedArg, fixturesArg, outArg] = process.argv.slice(2);
assert.ok(outArg, 'BASE_KIT CANDIDATE_DIRECTORY CLEAN_INSTALLED_KIT FROZEN_FIXTURES NEW_EVIDENCE_DIRECTORY');
const [base, candidate, installed, fixtures, out] = [baseArg, candidateArg, installedArg, fixturesArg, outArg].map(resolveArg => resolve(resolveArg));
const repo = resolve(import.meta.dirname, '../../..');
const identities = await Promise.all([base, installed].map(verifiedKitCandidate));
assert.equal(identities[0].protocolFingerprint, identities[1].protocolFingerprint);
assert.equal(identities[0].rustSourceSha256, identities[1].rustSourceSha256);
const sourceFiles = await fileInventory(base), installedFiles = await fileInventory(installed);
const runtimePaths = Object.keys(sourceFiles).filter(p => p.startsWith('dist/esm/') || p.startsWith('dist/cjs/') || p.startsWith('artifacts/wasm/'));
for (const path of runtimePaths) assert.equal(installedFiles[path]?.sha256, sourceFiles[path].sha256, `Executable changed: ${path}`);
assert.ok(!Object.keys(installedFiles).some(platformOf), 'Native binaries leaked into npm');
const build = JSON.parse(await readFile(join(candidate, 'candidate.json')));
assert.equal(sha256(await readFile(join(candidate, build.tarball))), build.tarballSha256);
const beforePackage = JSON.parse(await readFile(join(base, 'package.json')));
const afterPackage = JSON.parse(await readFile(join(installed, 'package.json')));
assert.deepEqual(afterPackage.exports, beforePackage.exports);
assert.deepEqual(afterPackage.dependencies, beforePackage.dependencies);
const catalog = await platformCatalog(installed);
await mkdir(out);
await mkdir(join(out, 'extracted'));
const archives = [];
for (const [platform, group] of Object.entries(catalog.platforms)) {
  const archive = join(candidate, group.archive);
  assert.equal(sha256(await readFile(archive)), group.archiveSha256);
  execFileSync('tar', ['-xzf', archive, '-C', join(out, 'extracted')]);
  archives.push({platform, archive: group.archive, sha256: group.archiveSha256,
    bytes: group.archiveBytes, nativeBytes: group.unpackedNativeBytes, files: Object.keys(group.files).length});
}
const resources = await verifiedResourceRoot(installed, join(out, 'extracted/resources'), Object.keys(catalog.platforms));
const resourceFiles = await fileInventory(resources);
const nativePaths = Object.keys(sourceFiles).filter(platformOf);
assert.deepEqual(Object.keys(resourceFiles).filter(platformOf).sort(), nativePaths.sort());
for (const path of nativePaths) assert.equal(resourceFiles[path].sha256, sourceFiles[path].sha256);
await assert.rejects(verifiedResourceRoot(installed, undefined, ['ios']), /Matching platform resources/);

// Build the actual C runners against only the extracted resources. Rewrite
// the runners' dependency load paths, not the immutable dylib bytes.
const native = {};
for (const kind of ['engine', 'keyless']) {
  const directory = join(resources, `artifacts/${kind === 'engine' ? 'native' : 'keyless-native'}/aarch64-apple-darwin`);
  const library = join(directory, `libtbc_${kind}_native.dylib`);
  const headers = kind === 'engine' ? join(resources, 'artifacts/native/ios/TbcEngineNative.xcframework/ios-arm64/Headers') : directory;
  const runner = join(out, kind+'-runner');
  execFileSync('cc', [join(repo, 'packages/tbc-engine/scripts', kind === 'engine' ? 'native-artifact-runner.c' : 'keyless-native-runner.c'),
    '-I'+headers, library, '-Wl,-rpath,'+directory, '-o', runner]);
  const installName = execFileSync('otool', ['-D', library], {encoding: 'utf8'}).trim().split('\n').at(-1);
  execFileSync('install_name_tool', ['-change', installName, library, runner]);
  native[kind] = (method, input) => execFileSync(runner, [method, input], {encoding: 'utf8', maxBuffer: 8*1024*1024});
}
const {createWasmTbcEngineBackend} = await import(pathToFileURL(join(installed, 'dist/esm/engine.js')));
const {createWasmTbcKeylessEngine} = await import(pathToFileURL(join(installed, 'dist/esm/wallet.js')));
const wasm = await createWasmTbcEngineBackend(await readFile(join(installed, 'artifacts/wasm/tbc_engine_wasm.wasm')));
const keyless = await createWasmTbcKeylessEngine(await readFile(join(installed, 'artifacts/wasm/tbc_keyless_wasm.wasm')));
const fixtureBytes = await readFile(join(fixtures, 'tbc-transfer.json'));
const fixture = JSON.parse(fixtureBytes), parity = [];
for (const [method, input] of [['normalizeRequest', fixture.normalizeInput], ['plan', fixture.planInput],
  ['validate', fixture.validateInput], ['finalize', fixture.finalizeInput]]) {
  const encoded = JSON.stringify(input), a = await wasm.call(method, encoded), b = native.engine(method, encoded);
  assert.deepEqual(JSON.parse(a), JSON.parse(b), method);
  assert.equal(JSON.parse(b).ok, true, method);
  parity.push({kind: 'engine', method, outputSha256: sha256(b)});
}
for (const method of ['normalizeRequest', 'plan', 'validate', 'finalize']) {
  const a = await wasm.call(method, '{'), b = native.engine(method, '{');
  assert.deepEqual(JSON.parse(a), JSON.parse(b));
  assert.equal(JSON.parse(b).ok, false);
  parity.push({kind: 'engine', method, negative: true, outputSha256: sha256(b)});
}
const preview = JSON.stringify({operation: 'increaseLp', ftContractId: '22'.repeat(32), ftDecimal: 6,
  amount: '0.001', lockTime: 0, pool: {ftLpRaw: '10000', ftARaw: '5000', tbcSat: '10000', poolValueSat: '11000', publicKeyLocked: false}});
const a = await keyless.execute('legacyPoolPreview', preview), b = native.keyless('legacyPoolPreview', preview);
assert.deepEqual(JSON.parse(a), JSON.parse(b));
assert.equal(JSON.parse(b).ftlpMintedRaw, '1000');
parity.push({kind: 'keyless', method: 'legacyPoolPreview', outputSha256: sha256(b)});
const sdkOut = join(out, 'engine-sdk');
execFileSync(process.execPath, [join(repo, 'native/engine/scripts/prepare-native-engine.mjs'),
  join(candidate, build.tarball), build.tarballSha256, sdkOut, '--resources-root', resources], {stdio: 'pipe', maxBuffer: 5*1024*1024});
const sdk = JSON.parse(await readFile(join(sdkOut, 'identity.json')));
for (const [name, hash] of Object.entries(sdk.nativeHashes)) assert.equal(hash, sourceFiles['artifacts/native/'+name].sha256);
const unchangedNativeCount = nativePaths.length;
const lock = JSON.parse(await readFile(join(installed, 'examples/react-native-engine/module/native-sdk-lock.json')));
const staleLock = Object.entries(lock.nativeHashes).some(([p,h]) => sourceFiles['artifacts/native/'+p]?.sha256 !== h);
const report = {status: 'PASS_SPLIT_INSTALL_RESOURCES_AND_HOST_NATIVE_PARITY', identities,
  archive: {path: build.tarball, sha256: build.tarballSha256, bytes: build.compressedBytes},
  sizes: {baselineUnpacked: Object.values(sourceFiles).reduce((n,v)=>n+v.bytes,0), npmUnpacked: build.unpackedBytes},
  unchangedExecutableFiles: runtimePaths.length, unchangedNativeFiles: unchangedNativeCount, archives, parity,
  fixtureSha256: sha256(fixtureBytes), builtEngineSdk: {artifactSetId: sdk.artifactSetId, sdkVersion: sdk.sdkVersion,
    sourceStaging: true, appLinked: false, keylessCompanionIncluded: false},
  rnTemplate: {sdkLockStale: staleLock, readyForHandoff: !staleLock, wrongSdkRejected: 'focused template test'},
  applicationRuntimeBytesChanged: false, transactionPathChanged: false,
  realChain: false, deviceAcceptance: false, published: false,
  scriptSha256: sha256(await readFile(import.meta.filename))};
await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2)+'\n', {flag: 'wx'});
console.log(JSON.stringify({status: report.status, report: join(out, 'report.json'), unchangedExecutableFiles: runtimePaths.length,
  unchangedNativeFiles: unchangedNativeCount, nativeWasmChecks: parity.length, rnSdkLockStale: staleLock}));
