// Re-pin a tested local SDK after a protocol identity change. Does not publish.
import assert from 'node:assert/strict';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';

const [sdkArg, reportArg, kitArg, outputArg] = process.argv.slice(2);
assert.ok(sdkArg && reportArg, 'Usage: write-native-sdk-lock.mjs SDK CONSUMER_REPORT [EXACT_KIT NEW_LOCK_FILE]');
assert.equal(Boolean(kitArg), Boolean(outputArg), 'Pass both exact Kit and new output');
const sdk = resolve(sdkArg), root = resolve(import.meta.dirname, '../../..');
const kit = kitArg ? resolve(kitArg) : join(root, 'packages/kit');
const sourceLock = join(kit, 'examples/react-native-engine/module/native-sdk-lock.json');
const file = outputArg ? resolve(outputArg) : sourceLock;
const previous = JSON.parse(await readFile(sourceLock));
const identity = JSON.parse(await readFile(join(sdk, 'identity.json')));
const report = JSON.parse(await readFile(resolve(reportArg)));
const provenance = JSON.parse(await readFile(join(kit, 'artifacts/provenance.json')));
const hash = value => createHash('sha256').update(value).digest('hex');
assert.equal(report.status, 'PASS');
assert.equal(report.artifactSetId, identity.artifactSetId);
assert.equal(provenance.protocolFingerprint, identity.protocolFingerprint);
assert.equal(report.aarSha256, hash(await readFile(join(sdk, 'android/engine/build/outputs/aar/engine-release.aar'))));
const files = {};
for (const path of Object.keys(previous.files)) {
  const name = path.replaceAll(previous.sdkVersion, identity.sdkVersion);
  files[name] = hash(await readFile(join(sdk, name)));
}
assert.equal(Object.keys(files).length, Object.keys(previous.files).length);
// A full SDK adds the keyless companion. Do not carry forward a Core-only file
// list: RN's sync step copies exactly these files, including SwiftPM targets.
async function addTree(relative) {
  for (const entry of await readdir(join(sdk, relative), {withFileTypes: true})) {
    const path = join(relative, entry.name);
    if (entry.isDirectory()) await addTree(path);
    else files[path] = hash(await readFile(join(sdk, path)));
  }
}
await addTree('apple/Artifacts');
await addTree('apple/Sources');
await writeFile(file, JSON.stringify({ schemaVersion: 1, sdkVersion: identity.sdkVersion,
  artifactSetId: identity.artifactSetId, protocolFingerprint: identity.protocolFingerprint,
  nativeHashes: identity.nativeHashes, files }, null, 2) + '\n', outputArg ? {flag: 'wx'} : {});
console.log(JSON.stringify({ sdkVersion: identity.sdkVersion, artifactSetId: identity.artifactSetId, files: Object.keys(files).length }));
