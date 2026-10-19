import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';

const [sdkArg, consumerArg, deviceArg, outArg, upstreamArg] = process.argv.slice(2);
assert.ok(sdkArg && consumerArg && deviceArg && outArg, 'Usage: prepare-delivery.mjs SDK CONSUMER_REPORT_DIRECTORY DEVICE_REPORT_DIRECTORY NEW_OUTPUT');
const sdk = resolve(sdkArg), out = resolve(outArg), root = resolve(import.meta.dirname, '..');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const identity = JSON.parse(await readFile(join(sdk, 'identity.json')));
const consumer = JSON.parse(await readFile(join(resolve(consumerArg), 'report.json')));
const device = JSON.parse(await readFile(join(resolve(deviceArg), 'report.json')));
for (const report of [consumer, device]) { assert.equal(report.status, 'PASS'); assert.equal(report.artifactSetId, identity.artifactSetId); }
if(identity.extension.publicGroupDerivation){
  assert.equal(consumer.publicGroupDerivationVerified,true);
  assert.equal(device.publicGroupDerivationVerified,true);
}
let musigEvidence;
if (identity.musigEnabled === true) {
  assert.equal(consumer.musigSwiftChecks, 18); assert.equal(consumer.musigKotlinJniChecks, 22);
  assert.equal(device.musigIosChecks, 18); assert.equal(device.musigAndroidChecks, 22);
  assert.equal(consumer.musigIndependentSdkVerified, true); assert.equal(device.musigIndependentSdkVerified, true);
  const wasm = JSON.parse(await readFile(join(sdk, 'musig-wasm-report.json')));
  const parityLocation = JSON.parse(await readFile(join(sdk, 'musig-parity-location.json')));
  const parity = JSON.parse(await readFile(join(parityLocation.output, 'report.json')));
  assert.equal(wasm.status, 'PASS'); assert.equal(wasm.actualWasm, true);
  assert.equal(wasm.sdkPartialAndFinalVerification, true);
  assert.equal(parity.status, 'PASS'); assert.equal(parity.nativeWasmIdentical, true);
  musigEvidence = {wasm, parity, actualCooperativeApproval: false, realChainAcceptance: false,
    pending: ['Wallet-specific independent-participant custody/consent integration', 'Representative cooperative administrator Testnet transaction']};
  if(identity.extension.publicGroupDerivation){
    assert.ok(upstreamArg,'local5 delivery requires pinned upstream report directory');
    const upstreamBytes=await readFile(join(resolve(upstreamArg),'report.json'));
    const upstream=JSON.parse(upstreamBytes),base='vendor/secp256k1-sys/depend/secp256k1/src/modules/musig/';
    assert.equal(upstream.status,'PASS');assert.equal(upstream.vectorCases,42);assert.equal(upstream.upstreamSkippedCases,1);
    assert.equal(upstream.vectorSha256,identity.sourceHashes[base+'vectors.h']);
    assert.equal(upstream.upstreamTestsSha256,identity.sourceHashes[base+'tests_impl.h']);
    musigEvidence.upstream={...upstream,reportSha256:sha(upstreamBytes)};
  }
}
for (const [file, hash] of Object.entries(identity.artifacts)) assert.equal(sha(await readFile(join(sdk, file))), hash, file);
for (const [file, hash] of Object.entries(identity.sourceHashes)) assert.equal(sha(await readFile(join(sdk, /^(apple|android)\//.test(file) ? file : `kernel/${file}`))), hash, file);
const aar = join(sdk, 'maven-repository/io/tbc/local/signer', identity.sdkVersion, `signer-${identity.sdkVersion}.aar`);
assert.equal(sha(await readFile(aar)), consumer.aarSha256); assert.equal(device.aarSha256, consumer.aarSha256);
await mkdir(out);
const staging = join(out, 'staging'); await mkdir(staging);
for (const name of ['apple', 'maven-repository', 'notices']) await cp(join(sdk, name), join(staging, name), { recursive: true });
await cp(join(sdk, 'kernel/wasm'), join(staging, 'wasm'), { recursive: true });
await cp(join(sdk, 'kernel/artifacts/wasm/tbc_signer_kernel.wasm'), join(staging, 'wasm/tbc_signer_kernel.wasm'));
await cp(join(root, 'README.md'), join(staging, 'README.md'));
await cp(join(sdk, 'identity.json'), join(staging, 'identity.json'));
await cp(join(sdk, 'import-provenance.json'), join(staging, 'import-provenance.json'));
const sources = join(staging, 'source'); await mkdir(sources);
for (const folder of ['kernel', 'apple', 'android', 'scripts', 'consumers', 'extensions']) await cp(join(root, folder), join(sources, folder), { recursive: true, filter: source => source !== join(root, 'kernel/target') });
await cp(join(root, 'import-provenance.json'), join(sources, 'import-provenance.json'));
await cp(join(root, 'README.md'), join(sources, 'README.md'));
// Fail if source drift occurred after the SDK was built; never label a different
// source snapshot as the code verified by these reports.
for (const [file, hash] of Object.entries(identity.sourceHashes)) assert.equal(sha(await readFile(join(sources, /^(apple|android)\//.test(file) ? file : `kernel/${file}`))), hash, file);
const assets = {};
for (const [file, members] of [
  ['apple-signer.tgz', ['apple']], ['android-signer.tgz', ['maven-repository']],
  ['wasm-signer.tgz', ['wasm']], ['signer-source.tgz', ['source']],
]) {
  execFileSync('tar', ['-czf', join(out, file), '-C', staging, ...members, 'README.md', 'identity.json', 'import-provenance.json', 'notices'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  const bytes = await readFile(join(out, file)); assets[file] = { bytes: bytes.length, sha256: sha(bytes) };
}
const report = { status: 'LOCAL_CANDIDATE_NOT_PUBLISHED', sdkVersion: identity.sdkVersion, artifactSetId: identity.artifactSetId,
  assets, common: JSON.parse(await readFile(join(sdk, 'common-vector-report.json'))), consumer, device, musigEvidence,
  kitCandidateChanged: false, existingWalletChanged: false, realChainAcceptance: false, releaseBlockers: identity.releaseBlockers };
await writeFile(join(out, 'delivery.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ out, assets, artifactSetId: identity.artifactSetId }, null, 2));
