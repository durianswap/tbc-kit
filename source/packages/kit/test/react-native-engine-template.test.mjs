import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm, cp, symlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { syncNative } from '../examples/react-native-engine/module/scripts/sync-native.mjs';

const template = resolve(import.meta.dirname, '../examples/react-native-engine/module');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const cases = [
  'ios/TbcEngineNative.xcframework/ios-arm64/libtbc_engine_native.a',
  'ios/TbcEngineNative.xcframework/ios-arm64-simulator/libtbc_engine_native.a',
  ...['arm64-v8a', 'armeabi-v7a', 'x86_64'].map(abi => `android/jniLibs/${abi}/libtbc_engine_native.so`),
];

test('standalone SDK preparation is pinned, reproducible and fails before copying on corruption', async t => {
  const root = await mkdtemp(resolve(tmpdir(), 'tbc-native-template-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const kitRoot = resolve(root, 'kit'), nativeSdkRoot = resolve(root, 'sdk');
  const moduleRoot = resolve(root, 'modules/tbc-kit-engine');
  await mkdir(kitRoot); await mkdir(nativeSdkRoot);
  await writeFile(resolve(kitRoot, 'package.json'), JSON.stringify({ name: '@tbc/kit', version: 'test', exports: { './engine': './engine.cjs' } }));
  await writeFile(resolve(kitRoot, 'engine.cjs'), 'module.exports = {};');
  await writeFile(resolve(root, 'package.json'), '{"private":true}');
  await mkdir(resolve(root, 'node_modules/@tbc'), { recursive: true });
  await symlink(kitRoot, resolve(root, 'node_modules/@tbc/kit'));
  await mkdir(resolve(moduleRoot, 'scripts'), { recursive: true });
  await cp(resolve(template, 'scripts/sync-native.mjs'), resolve(moduleRoot, 'scripts/sync-native.mjs'));
  const alias = resolve(root, 'linked-sync.mjs');
  await symlink(resolve(moduleRoot, 'scripts/sync-native.mjs'), alias);
  for (const name of cases) {
    const target = resolve(kitRoot, 'artifacts/native', name);
    await mkdir(dirname(target), { recursive: true }); await writeFile(target, name);
  }
  await writeFile(resolve(kitRoot, 'artifacts/provenance.json'), JSON.stringify({
    package: '@tbc/kit@test', protocolFingerprint: '1'.repeat(64), nativeBridge: { iosMinimumVersion: '15.1' },
    artifacts: cases.map(name => ({ path: `artifacts/native/${name}`, sha256: sha(name) })),
  }));
  const sdkVersion = 'local-test', artifactSetId = 'a'.repeat(64);
  const contents = { 'identity.json': JSON.stringify({ sdkVersion, artifactSetId }),
    'apple/Sources/Engine.swift': 'controlled SDK source', 'maven-repository/engine.aar': 'controlled AAR' };
  for (const [name, value] of Object.entries(contents)) {
    await mkdir(dirname(resolve(nativeSdkRoot, name)), { recursive: true });
    await writeFile(resolve(nativeSdkRoot, name), value);
  }
  await writeFile(resolve(moduleRoot, 'native-sdk-lock.json'), JSON.stringify({ sdkVersion, artifactSetId,
    protocolFingerprint: '1'.repeat(64), nativeHashes: Object.fromEntries(cases.map(n => [n, sha(n)])),
    files: Object.fromEntries(Object.entries(contents).map(([k,v]) => [k, sha(v)])) }));
  await assert.rejects(syncNative({ moduleRoot, kitRoot }), /nativeSdkRoot/);
  const identity = await syncNative({ moduleRoot, kitRoot, nativeSdkRoot });
  assert.equal(identity.sdkVersion, sdkVersion);
  assert.deepEqual(await syncNative({ moduleRoot, kitRoot, check: true }), identity);
  assert.equal(JSON.parse(execFileSync(process.execPath, [alias, '--check'], { encoding: 'utf8' })).ok, true);
  await writeFile(resolve(moduleRoot, 'platform-sdk/maven-repository/engine.aar'), 'damaged');
  await assert.rejects(syncNative({ moduleRoot, kitRoot, check: true }), /SDK artifact mismatch/);
  assert.throws(() => execFileSync(process.execPath, [alias, '--check'], { stdio: 'pipe' }),
    error => error.status !== 0 && String(error.stderr).includes('SDK artifact mismatch'));
  await syncNative({ moduleRoot, kitRoot, nativeSdkRoot });
  await writeFile(resolve(moduleRoot, 'generated/identity.json'), 'stale');
  await assert.rejects(syncNative({ moduleRoot, kitRoot, check: true }), /Stale generated identity/);
  await syncNative({ moduleRoot, kitRoot, nativeSdkRoot });
  await writeFile(resolve(nativeSdkRoot, 'maven-repository/engine.aar'), 'untrusted');
  await assert.rejects(syncNative({ moduleRoot, kitRoot, nativeSdkRoot }), /SDK artifact mismatch/);
  assert.equal(await readFile(resolve(moduleRoot, 'platform-sdk/maven-repository/engine.aar'), 'utf8'), contents['maven-repository/engine.aar']);
  await writeFile(resolve(kitRoot, 'artifacts/native', cases[0]), 'changed native');
  await assert.rejects(syncNative({ moduleRoot, kitRoot, check: true }), /Native provenance mismatch/);

  // The split npm package has no native binaries. Its catalog still binds
  // the SDK input hashes; the existing SDK file lock validates actual outputs.
  const catalog = {schema: 1, package: '@tbc/kit@test', protocolFingerprint: '1'.repeat(64),
    platforms: Object.fromEntries(['ios', 'android'].map(platform => [platform, {files: Object.fromEntries(
      cases.filter(n => n.startsWith(platform+'/')).map(n => [`artifacts/native/${n}`, sha(n)]))}]))};
  const catalogBytes = JSON.stringify(catalog);
  await writeFile(resolve(kitRoot, 'artifacts/platform-resources.json'), catalogBytes);
  const splitProvenance = JSON.parse(await readFile(resolve(kitRoot, 'artifacts/provenance.json')));
  splitProvenance.externalArtifacts = splitProvenance.artifacts;
  splitProvenance.artifacts = [];
  splitProvenance.platformResources = {path: 'artifacts/platform-resources.json', sha256: sha(catalogBytes)};
  await writeFile(resolve(kitRoot, 'artifacts/provenance.json'), JSON.stringify(splitProvenance));
  await rm(resolve(kitRoot, 'artifacts/native'), {recursive: true});
  await writeFile(resolve(nativeSdkRoot, 'maven-repository/engine.aar'), contents['maven-repository/engine.aar']);
  const split = await syncNative({ moduleRoot, kitRoot, nativeSdkRoot });
  assert.deepEqual(split, identity);
  assert.deepEqual(await syncNative({ moduleRoot, kitRoot, check: true }), identity);
  for (const platform of ['ios', 'android']) await t.test(`only ${platform} resources are required and verified`, async () => {
    const partialSource = resolve(root, `${platform}-sdk`), partialModule = resolve(root, `${platform}-module`);
    const prefix = platform === 'ios' ? 'apple/' : 'maven-repository/';
    await mkdir(partialModule);
    await cp(resolve(moduleRoot, 'native-sdk-lock.json'), resolve(partialModule, 'native-sdk-lock.json'));
    for (const [name, value] of Object.entries(contents)) if (name === 'identity.json' || name.startsWith(prefix)) {
      await mkdir(dirname(resolve(partialSource, name)), { recursive: true });
      await writeFile(resolve(partialSource, name), value);
    }
    const prepared = await syncNative({ moduleRoot: partialModule, kitRoot, nativeSdkRoot: partialSource, platform });
    assert.deepEqual(prepared, { ...identity, platform });
    assert.deepEqual(await syncNative({ moduleRoot: partialModule, kitRoot, check: true }), prepared);
    assert.deepEqual(await syncNative({ moduleRoot: partialModule, kitRoot, check: true, platform }), prepared);
    const other = platform === 'ios' ? 'android' : 'ios';
    await assert.rejects(syncNative({ moduleRoot: partialModule, kitRoot, check: true, platform: other }), /not .*prepare a new matching module/);
    await assert.rejects(syncNative({ moduleRoot, kitRoot, nativeSdkRoot: partialSource, platform }), /fresh module/);
    const changed = Object.keys(contents).find(name => name.startsWith(prefix));
    await writeFile(resolve(partialModule, 'platform-sdk', changed), 'tampered');
    await assert.rejects(syncNative({ moduleRoot: partialModule, kitRoot, check: true, platform }), /SDK artifact mismatch/);
  });
  catalog.platforms.ios.files[`artifacts/native/${cases[0]}`] = 'b'.repeat(64);
  const wrongBytes = JSON.stringify(catalog);
  await writeFile(resolve(kitRoot, 'artifacts/platform-resources.json'), wrongBytes);
  splitProvenance.platformResources.sha256 = sha(wrongBytes);
  await writeFile(resolve(kitRoot, 'artifacts/provenance.json'), JSON.stringify(splitProvenance));
  await assert.rejects(syncNative({ moduleRoot, kitRoot, nativeSdkRoot }), /Native provenance mismatch/);
});

test('startup rejects missing/stale native; concurrent calls preserve receiver, bytes and errors', async t => {
  const root = await mkdtemp(resolve(tmpdir(), 'tbc-native-backend-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const outfile = resolve(root, 'backend.mjs');
  await build({ entryPoints: [resolve(template, 'src/backend.ts')], outfile, bundle: true, platform: 'node', format: 'esm',
    alias: { '@tbc/kit/engine': resolve(import.meta.dirname, '../dist/esm/engine.js'),
      '@tbc/kit': resolve(import.meta.dirname, '../dist/esm/index.native.js') } });
  const { connectNativeEngine } = await import(pathToFileURL(outfile).href);
  const id = 'a'.repeat(64);
  assert.throws(() => connectNativeEngine(null, id), /UNAVAILABLE/);
  assert.throws(() => connectNativeEngine({ call() {}, artifactSetId: 'b'.repeat(64) }, id), /MISMATCH/);
  const seen = [];
  const pending = [];
  const native = { artifactSetId: id, call(method, input) {
    assert.equal(this, native);
    seen.push([method, input]);
    return new Promise((resolve, reject) => pending.push({ resolve, reject }));
  } };
  const backend = connectNativeEngine(native, id);
  assert.equal(seen.length, 0, 'startup makes no bridge/chain read');
  const one = backend.call('normalizeRequest', '{"memo":"中文🍈"}');
  const two = backend.call('plan', '{"second":true}');
  assert.equal(seen.length, 2, 'not serialized by a new global queue');
  pending[1].resolve('second');
  pending[0].resolve('first');
  assert.deepEqual(await Promise.all([one, two]), ['first', 'second']);
  assert.equal(seen[0][1], '{"memo":"中文🍈"}');
  const bad = backend.call('validate', '{}');
  const error = new Error('native failure');
  pending[2].reject(error);
  await assert.rejects(bad, value => value === error);
  assert.equal(seen.length, 3, 'no retries');
});

test('Expo glue reuses SDK and contains no duplicate JNI or buffer implementation', async () => {
  const config = JSON.parse(await readFile(resolve(template, 'expo-module.config.json')));
  assert.deepEqual(config.platforms, ['apple', 'android']);
  assert.equal(config.apple.podspecPath, 'TbcKitEngine.podspec');
  for (const file of ['ios/TbcKitEngineBridge.swift', 'android/src/main/cpp/bridge.cpp', 'android/src/main/cpp/CMakeLists.txt']) {
    await assert.rejects(readFile(resolve(template, file)), { code: 'ENOENT' });
  }
  for (const file of ['ios/TbcKitEngineModule.swift', 'android/src/main/java/expo/modules/tbckitengine/TbcKitEngineModule.kt']) {
    const source = await readFile(resolve(template, file), 'utf8');
    assert.match(source, /callEnvelope/);
    assert.match(source, /callKeyless/);
    assert.match(source, /TbcKeylessOperation/);
    assert.match(source, /TbcKeylessEngine/);
    assert.doesNotMatch(source, /tbc_engine_call|tbc_engine_free|external fun|loadLibrary|JSONSerialization|JSONObject|DispatchQueue|withContext|tbc_wallet_private_call/);
  }
  const podspec = await readFile(resolve(template, 'TbcKitEngine.podspec'), 'utf8');
  assert.match(podspec, /platform-sdk\/apple\/Sources/);
  assert.match(podspec, /platform-sdk\/apple\/Artifacts/);
  assert.match(podspec, /TbcKeylessNative\.xcframework/);
  assert.match(podspec, /SWIFT_INCLUDE_PATHS\[sdk=iphonesimulator\*\]/);
  assert.match(podspec, /SWIFT_INCLUDE_PATHS\[sdk=iphoneos\*\]/);
  assert.match(podspec, /--check/);
  assert.match(podspec, /--platform ios/);
  const gradle = await readFile(resolve(template, 'android/build.gradle'), 'utf8');
  assert.match(gradle, /io.tbc.local:engine/); assert.match(gradle, /--check/);
  assert.match(gradle, /'--platform', 'android'/);
  assert.match(gradle, /rootProject\.allprojects/);
  assert.match(gradle, /exclusiveContent/);
  assert.match(gradle, /includeGroup 'io.tbc.local'/);
  assert.doesNotMatch(gradle, /externalNativeBuild|jniLibs.srcDirs/);
});

test('Keyless bridge requires matching native identity, preserves concurrency and uses shared rejection semantics', async t => {
  const root = await mkdtemp(resolve(tmpdir(), 'tbc-native-keyless-template-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const outfile = resolve(root, 'backend.mjs');
  await build({ entryPoints: [resolve(template, 'src/backend.ts')], outfile, bundle: true, platform: 'node', format: 'esm',
    alias: { '@tbc/kit/engine': resolve(import.meta.dirname, '../dist/esm/engine.js'),
      '@tbc/kit': resolve(import.meta.dirname, '../dist/esm/index.native.js') } });
  const { connectNativeKeylessEngine } = await import(pathToFileURL(outfile).href);
  assert.equal(typeof connectNativeKeylessEngine, 'function');
  const id = 'a'.repeat(64), seen = [], pending = [];
  assert.throws(() => connectNativeKeylessEngine(null, id), /UNAVAILABLE/);
  assert.throws(() => connectNativeKeylessEngine({ artifactSetId: id, call() {} }, id), /UNAVAILABLE/);
  assert.throws(() => connectNativeKeylessEngine({ artifactSetId: 'b'.repeat(64), callKeyless() {} }, id), /MISMATCH/);
  const native = { artifactSetId: id, callKeyless(operation, input) {
    assert.equal(this, native);
    seen.push([operation, input]);
    return new Promise((resolve, reject) => pending.push({ resolve, reject }));
  } };
  const engine = connectNativeKeylessEngine(native, id);
  assert.equal(seen.length, 0);
  const info = JSON.parse(await engine.protocolInfo());
  assert.deepEqual(info.operations, [
    'preparePoolNft', 'prepareAssetAncestry', 'legacyPoolPreview', 'inspectTokenReceipt',
    'inspectNftReceipt', 'prepareReviewedStage', 'finalizeReviewedStage', 'inspectAmmMaterial',
    'inspectLopMaterial', 'inspectTokenMaterial', 'describeMultisig', 'decodeMultisigAddress',
    'prepareMultisig', 'inspectMultisig', 'reviewMultisig', 'verifyMultisigSignatures', 'finalizeMultisig',
  ]);
  assert.equal(seen.length, 0, 'protocolInfo is local, not a version query');
  const one = engine.execute('inspectTokenMaterial', '{"memo":"中文🍈"}');
  const two = engine.execute('prepareReviewedStage', '{"second":true}');
  assert.equal(seen.length, 2, 'no new serial queue');
  pending[1].resolve('{"second":true}'); pending[0].resolve('{"first":true}');
  assert.deepEqual(await Promise.all([one, two]), ['{"first":true}', '{"second":true}']);
  assert.equal(seen[0][1], '{"memo":"中文🍈"}');
  await assert.rejects(engine.execute('sign', '{}'), /KEYLESS_OPERATION_UNAVAILABLE/);
  assert.equal(seen.length, 2, 'unsupported operation never reaches native');
  const bad = engine.execute('inspectNftReceipt', '{}');
  pending[2].resolve('{"error":"SYNTHETIC_ENGINE_REJECTION"}');
  await assert.rejects(bad, /SYNTHETIC_ENGINE_REJECTION/);
  const malformed = engine.execute('inspectAmmMaterial', '{}');
  pending[3].resolve('invalid-json');
  await assert.rejects(malformed, /Invalid TBC keyless response/);
  const failed = engine.execute('inspectLopMaterial', '{}');
  const error = new Error('synthetic bridge failure'); pending[4].reject(error);
  await assert.rejects(failed, value => value === error);
  assert.equal(seen.length, 5, 'no retry');
});
