import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { verifiedResourceRoot } from '../../../packages/kit/scripts/platform-resources.mjs';
import { assertIosDeployment } from '../../../packages/tbc-engine/scripts/ios-deployment.mjs';

const source = resolve(import.meta.dirname, '..');
const [tarArg, shaArg, outputArg, resourceOption, resourceArg] = process.argv.slice(2);
assert.ok(resourceOption === undefined || (resourceOption === '--resources-root' && resourceArg),
  'Optional: --resources-root VERIFIED_EXTRACTED_RESOURCES');
assert.ok(tarArg && /^[a-f0-9]{64}$/.test(shaArg ?? '') && outputArg,
  'Usage: node prepare-native-engine.mjs EXACT_KIT_TAR SHA256 NEW_OUTPUT_DIRECTORY');
const tar = resolve(tarArg), output = resolve(outputArg);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
assert.equal(digest(await readFile(tar)), shaArg, 'Kit archive checksum mismatch');
// Exclusive creation: never overwrite a delivered candidate or user project.
await mkdir(output, { recursive: false });
const extracted = join(output, 'source-kit');
await mkdir(extracted);
execFileSync('tar', ['-xzf', tar, '-C', extracted]);
const kit = join(extracted, 'package');
const manifest = JSON.parse(await readFile(join(kit, 'package.json'), 'utf8'));
const provenance = JSON.parse(await readFile(join(kit, 'artifacts/provenance.json'), 'utf8'));
assert.equal(manifest.name, '@tbc/kit');
assert.equal(provenance.package, `@tbc/kit@${manifest.version}`);
if(provenance.nativeBridge)assert.equal(provenance.nativeBridge.iosMinimumVersion, '15.1');
for (const artifact of provenance.artifacts) {
  assert.equal(digest(await readFile(join(kit, artifact.path))), artifact.sha256, artifact.path);
}
const resources = await verifiedResourceRoot(kit, resourceArg, ['ios', 'android']);
// New platform catalogs may omit the old bridge declaration. Verify the
// actual immutable Mach-O members instead of guessing a deployment target.
for(const slice of ['ios-arm64','ios-arm64-simulator'])assertIosDeployment(execFileSync('xcrun',[
  'otool','-l',join(resources,'artifacts/native/ios/TbcEngineNative.xcframework',slice,'libtbc_engine_native.a'),
],{encoding:'utf8',maxBuffer:64*1024*1024}));
async function hashes(root, prefix = '') {
  const result = {};
  for (const entry of (await readdir(join(root, prefix), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    assert.ok(!entry.isSymbolicLink(), 'Native sources must not contain symlinks');
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(result, await hashes(root, name));
    else if (entry.isFile()) result[name] = digest(await readFile(join(root, name)));
  }
  return result;
}
const nativeHashes = {};
for (const platform of ['ios', 'android']) {
  for (const [path, sha] of Object.entries(await hashes(join(resources, 'artifacts/native', platform)))) nativeHashes[`${platform}/${path}`] = sha;
}
const artifactSetId = digest(JSON.stringify({ protocol: provenance.protocolFingerprint, hashes: nativeHashes }));
const identity = { schemaVersion: 1, sdkVersion: `${manifest.version}.native.1`, kitVersion: manifest.version,
  kitTarSha256: shaArg, protocolFingerprint: provenance.protocolFingerprint, artifactSetId,
  nativeHashes, bindingSourceHashes: { ...Object.fromEntries(
    Object.entries(await hashes(join(source, 'apple'))).map(([path, sha]) => [`apple/${path}`, sha])), ...Object.fromEntries(
    Object.entries(await hashes(join(source, 'android'))).map(([path, sha]) => [`android/${path}`, sha])) },
  platforms: { ios: ['arm64-device', 'arm64-simulator'], android: ['arm64-v8a', 'armeabi-v7a', 'x86_64'] },
  scope: 'Engine-only; no shared Kit orchestration; local unpublished candidate' };
await cp(join(source, 'apple'), join(output, 'apple'), { recursive: true });
await cp(join(source, 'android'), join(output, 'android'), { recursive: true });
await cp(join(resources, 'artifacts/native/ios/TbcEngineNative.xcframework'), join(output, 'apple/Artifacts/TbcEngineNative.xcframework'), { recursive: true });
await cp(join(resources, 'artifacts/native/android/jniLibs'), join(output, 'android/engine/src/main/jniLibs'), { recursive: true });
await cp(join(resources, 'artifacts/native/ios/TbcEngineNative.xcframework/ios-arm64/Headers'), join(output, 'android/engine/src/main/cpp/include'), { recursive: true });
const generated = {
  'apple/Sources/TbcEngine/TbcEngineIdentity.swift': `enum TbcEngineIdentity {\n  static let artifactSetId = "${artifactSetId}"\n  static let protocolFingerprint = "${identity.protocolFingerprint}"\n}\n`,
  'android/engine/src/main/java/io/tbc/engine/TbcEngineIdentity.kt': `package io.tbc.engine\ninternal object TbcEngineIdentity {\n  const val artifactSetId = "${artifactSetId}"\n  const val protocolFingerprint = "${identity.protocolFingerprint}"\n}\n`,
  'identity.json': JSON.stringify(identity, null, 2) + '\n',
  'android/identity.json': JSON.stringify(identity, null, 2) + '\n',
};
for (const [name, content] of Object.entries(generated)) {
  await mkdir(dirname(join(output, name)), { recursive: true });
  await writeFile(join(output, name), content);
}
await cp(join(kit, 'LICENSE'), join(output, 'apple/LICENSE'));
await cp(join(kit, 'LICENSE'), join(output, 'android/LICENSE'));
console.log(JSON.stringify({ output, ...identity }, null, 2));
