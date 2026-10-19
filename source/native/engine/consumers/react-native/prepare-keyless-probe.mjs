// Prepare only a new, test-owned Expo app, retaining installed Kit bytes.
import assert from 'node:assert/strict';
import { readFile, writeFile, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [appArg, sdkArg, installedArchive] = process.argv.slice(2);
assert.ok(appArg && sdkArg, 'Usage: prepare-keyless-probe.mjs NEW_PROBE_APP SDK');
const app = resolve(appArg), sdk = resolve(sdkArg), repo = resolve(import.meta.dirname, '../../../..');
const json = async p => JSON.parse(await readFile(p));
const hash = b => createHash('sha256').update(b).digest('hex');
const installedMode = Boolean(installedArchive);
assert.equal((await json(join(app, 'package.json'))).name, installedMode ? 'tbc225-rn-keyless-probe' : 'tbc224-rn-keyless-probe');
const kit = join(app, 'node_modules/@tbc/kit');
assert.equal((await json(join(kit, 'package.json'))).version, installedMode ? '0.1.0-candidate.225' : '0.1.0-candidate.224');
const archive = installedMode ? resolve(installedArchive) : join(repo, 'native/engine/delivery/candidate224/tbc-kit-0.1.0-candidate.224.tgz');
assert.equal(hash(await readFile(archive)), installedMode
  ? '0505dc865db6604403994121a8da14f014381a25e0bfb63cd1025b6a937c46c4'
  : 'aabd2d0506e567ca8773c754d0b1f70614d8c7541f010dd0689bda937cd85079');
const lock = await json(join(app, 'modules/tbc-kit-engine/native-sdk-lock.json'));
assert.equal(lock.artifactSetId, (await json(join(sdk, 'identity.json'))).artifactSetId);
const moduleFiles = ['src/index.ts', 'src/backend.ts', 'ios/TbcKitEngineModule.swift',
  'android/src/main/java/expo/modules/tbckitengine/TbcKitEngineModule.kt', 'TbcKitEngine.podspec'];
const templateHashes = {};
for (const file of moduleFiles) {
  const source = installedMode ? join(kit, 'examples/react-native-engine/module', file)
    : join(repo, 'packages/kit/examples/react-native-engine/module', file);
  if (installedMode) assert.equal(hash(await readFile(join(app, 'modules/tbc-kit-engine', file))), hash(await readFile(source)));
  else await copyFile(source, join(app, 'modules/tbc-kit-engine', file));
  templateHashes[file] = hash(await readFile(source));
}
const coreFile = join(sdk, 'consumer-check-2lccro/vectors.json');
const companionFile = join(sdk, 'keyless-check-uNg0Ga/vectors.json');
const companionBytes = await readFile(companionFile);
assert.equal(hash(companionBytes), '4119ac2b1e6daaea7e628658c79329366b9ac5b92025bc9e160005033ebbb13f');
const coreBytes = await readFile(coreFile);
assert.equal((await json(join(sdk, 'consumer-check-2lccro/report.json'))).status, 'PASS');
const keyless = JSON.parse(companionBytes).slice(0, 16);
assert.ok(keyless.every(v => !/preimage/i.test(v.input)), 'No claim-secret fixture in this probe');
const { createWasmTbcKeylessEngine } = await import(pathToFileURL(join(kit, 'dist/esm/index.js')).href);
const oracle = await createWasmTbcKeylessEngine(await readFile(join(kit, 'artifacts/wasm/tbc_keyless_wasm.wasm')));
for (const method of ['inspectLopMaterial', 'inspectTokenMaterial']) {
  let expected;
  try { await oracle.execute(method, '{}'); } catch (e) { expected = JSON.stringify({ error: e.message }); }
  assert.ok(expected);
  keyless.push({ method, input: '{}', expected });
}
await copyFile(join(import.meta.dirname, 'KeylessProbe.tsx'), join(app, 'App.tsx'));
await writeFile(join(app, 'vectors.json'), coreBytes, { flag: 'wx' });
const keylessBytes = JSON.stringify(keyless);
await writeFile(join(app, 'keyless-vectors.json'), keylessBytes, { flag: 'wx' });
await writeFile(join(app, 'probe-provenance.json'), JSON.stringify({
  kitSha256: hash(await readFile(archive)), sdkArtifactSetId: lock.artifactSetId,
  templateHashes, appSourceSha256: hash(await readFile(join(app, 'App.tsx'))),
  coreVectorsSha256: hash(coreBytes), keylessVectorsSha256: hash(keylessBytes),
  sourceKeylessVectorsSha256: hash(companionBytes), templatePatch: installedMode ? 'none-installed225' : '4KP-not-frozen224',
}, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ app, coreVectors: JSON.parse(coreBytes).length, keylessVectors: keyless.length, actualHttp: 0 }));
