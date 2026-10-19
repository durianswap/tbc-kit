// Reuse the accepted cross-build inputs; no Rust compilation or source mutation.
import assert from 'node:assert/strict';
import {cp, mkdir, readFile, writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {join, resolve} from 'node:path';
import {verifiedKernelCandidate, verifiedKitCandidate} from '../../flutter/scripts/candidate-inputs.mjs';
import {fileInventory, sha256, verifiedResourceRoot} from '../../../packages/kit/scripts/platform-resources.mjs';
import {prepareKeylessAppleHeaders} from './keyless-apple-headers.mjs';

const [kitArg, kernelsArg, resourcesArg, outArg] = process.argv.slice(2);
assert.ok(outArg, 'VERIFIED_KIT FROZEN_KERNELS EXTRACTED_RESOURCES NEW_OUTPUT');
const [kit, kernels, out] = [kitArg, kernelsArg, outArg].map(p => resolve(p));
const candidate = await verifiedKitCandidate(kit), build = await verifiedKernelCandidate(kernels);
assert.equal(candidate.rustSourceSha256, build.rustSourceSha256, 'Keyless source must match this Kit');
const resources = await verifiedResourceRoot(kit, resourcesArg, ['macos-arm64']);
await mkdir(out);
const artifacts = join(out, 'artifacts');
await mkdir(artifacts);
const include = join(kernels, 'source/packages/tbc-engine/rust/crates/tbc-keyless-native/include');
await cp(include, join(artifacts, 'include'), {recursive: true});
await mkdir(join(artifacts, 'desktop'));
await cp(join(resources, 'artifacts/keyless-native/aarch64-apple-darwin/libtbc_keyless_native.dylib'),
  join(artifacts, 'desktop/libtbc_keyless_native.dylib'));
const appleHeaders = join(out, 'apple-headers');
await prepareKeylessAppleHeaders(include, appleHeaders);
execFileSync('xcodebuild', ['-create-xcframework',
  ...['aarch64-apple-ios', 'aarch64-apple-ios-sim'].flatMap(target => [
    '-library', join(kernels, 'target', target, 'release/libtbc_keyless_native.a'), '-headers', appleHeaders]),
  '-output', join(artifacts, 'TbcKeylessNative.xcframework')], {stdio: 'pipe'});
for (const [target, abi] of [['aarch64-linux-android','arm64-v8a'],
  ['armv7-linux-androideabi','armeabi-v7a'], ['x86_64-linux-android','x86_64']]) {
  await mkdir(join(artifacts, 'android', abi), {recursive: true});
  await cp(join(kernels, 'target', target, 'release/libtbc_keyless_native.so'),
    join(artifacts, 'android', abi, 'libtbc_keyless_native.so'));
}
const hashes = Object.fromEntries(Object.entries(await fileInventory(artifacts)).map(([p,v]) => [p,v.sha256]));
const identity = {status: 'STAGED_FROM_VERIFIED_KERNELS_NOT_CONSUMER_ACCEPTED',
  sourceSha256: build.sourceSha256, rustSourceSha256: build.rustSourceSha256,
  sourceArchive: join(kernels, 'source.tgz'), artifactSetId: sha256(JSON.stringify(hashes)), hashes,
  kernelEvidence: build.evidence.filter(e => e.name === 'keyless'),
  kit: candidate, generatorSha256: sha256(await readFile(import.meta.filename)),
  sourceLogicChanged: false, signing: false, network: false};
await writeFile(join(out, 'identity.json'), JSON.stringify(identity, null, 2)+'\n', {flag: 'wx'});
console.log(JSON.stringify({out, status: identity.status, artifactSetId: identity.artifactSetId}));
