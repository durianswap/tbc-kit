import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { verifiedResourceRoot } from '../../../packages/kit/scripts/platform-resources.mjs';
import { withOutputReview } from '../../../scripts/lib/reviewed-transfer-fixture.mjs';

const args = process.argv.slice(2);
const vectorsIndex = args.indexOf('--vectors');
let extraVectorsArg;
if (vectorsIndex >= 0) {
  assert.ok(args[vectorsIndex + 1], '--vectors requires a public fixture file');
  extraVectorsArg = args[vectorsIndex + 1];
  args.splice(vectorsIndex, 2);
}
const resourceIndex = args.indexOf('--resources-root');
let resourceArg;
if (resourceIndex >= 0) {
  assert.ok(args[resourceIndex + 1], '--resources-root requires a directory');
  resourceArg = args[resourceIndex + 1];
  args.splice(resourceIndex, 2);
}
const [sdkArg, gradleArg, androidSdkArg, profile] = args;
assert.ok(sdkArg && gradleArg && androidSdkArg && args.length <= 4 &&
  (profile === undefined || ['--timelock', '--special', '--lop-fee'].includes(profile)),
  'Usage: node check-native-engine-consumers.mjs SDK_OUTPUT GRADLE_EXECUTABLE ANDROID_SDK [--timelock|--special|--lop-fee]');
const sdk = resolve(sdkArg), root = resolve(import.meta.dirname, '..'), repo = resolve(root, '../..');
const scratch = await mkdtemp(join(sdk, 'consumer-check-')); // Preserve earlier evidence.
const identity = JSON.parse(await readFile(join(sdk, 'identity.json'), 'utf8'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
for (const [file, hash] of Object.entries(identity.bindingSourceHashes)) assert.equal(sha(await readFile(join(sdk, file))), hash, file);
const kit = join(sdk, 'source-kit/package');
const provenance = JSON.parse(await readFile(join(kit, 'artifacts/provenance.json'), 'utf8'));
for (const item of provenance.artifacts) assert.equal(sha(await readFile(join(kit, item.path))), item.sha256, item.path);
const resourceRoot = await verifiedResourceRoot(kit, resourceArg, ['macos-arm64']);
const run = (command, args, cwd = scratch, extra = {}) => execFileSync(command, args, {
  cwd, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, timeout: 300000, ...extra,
});
function logged(name, command, args, cwd, extra) {
  try { const output = run(command, args, cwd, extra); return writeFile(join(scratch, `${name}.log`), output); }
  catch (error) { throw new Error(`${name} failed: ${String(error.stdout ?? '').slice(-3500)}\n${String(error.stderr ?? '').slice(-1500)}`); }
}

// Load WASM from this exact archive; the fixture contains only a public scalar-1
// transaction/signature vector already checked into the repository.
// The WASM oracle alone needs JS dependencies. Native consumers do not use npm.
const oracle = join(scratch, 'wasm-oracle');
await mkdir(oracle);
await writeFile(join(oracle, 'package.json'), JSON.stringify({ private: true, type: 'module',
  dependencies: { '@tbc/kit': `file:${kit}` } }));
await logged('wasm-oracle-install', 'npm', ['install', '--install-links', '--ignore-scripts', '--no-audit', '--no-fund'], oracle);
const { createWasmTbcEngineBackend } = await import(pathToFileURL(join(oracle, 'node_modules/@tbc/kit/dist/esm/engine.js')));
const wasm = await createWasmTbcEngineBackend(await readFile(join(kit, 'artifacts/wasm/tbc_engine_wasm.wasm')));
const fixtureBytes = await readFile(join(repo, 'packages/tbc-engine/rust/fixtures/tbc-transfer.json'));
const fixture = JSON.parse(fixtureBytes);
const pairs = [['normalizeRequest', fixture.normalizeInput], ['plan', fixture.planInput],
  ['validate', fixture.validateInput], ['finalize', withOutputReview(fixture.finalizeInput)]];
const vectors = [];
for (const [method, params] of pairs) {
  const input = JSON.stringify(params), expected = await wasm.call(method, input);
  assert.equal(JSON.parse(expected).ok, true, method);
  vectors.push({ method, input, expected });
}
for (const method of ['normalizeRequest', 'plan', 'validate', 'finalize']) {
  const input = method === 'normalizeRequest' ? '中文🍈' : '{}';
  const expected = await wasm.call(method, input);
  assert.equal(JSON.parse(expected).ok, false);
  vectors.push({ method, input, expected });
}
// Replay public scalar-1 timelock vectors through the actual packaged native
// libraries, not only source Rust tests. SDK_OUTPUT must match this source tree.
let timelockVectors = 0;
const specialContractVectors = [];
const suites = profile === '--special' ? [
  ['timelock_public', 'public_timelock_uses_shared_plan_approval_and_finalize', 'TIMELOCK_PUBLIC'],
  ['htlc_public', 'public_htlc_uses_shared_plan_approval_and_finalize', 'HTLC_PUBLIC'],
  ['htlc_public', 'public_htlc_token_lifecycle_uses_shared_bound_signatures', 'HTLC_PUBLIC'],
  ['lop_public', 'public_lop_create_uses_shared_bound_signer_and_finalize', 'LOP_PUBLIC'],
  ['lop_public', 'public_lop_cancel_uses_shared_bound_signer_and_finalize', 'LOP_PUBLIC'],
  ['lop_public', 'public_lop_match_uses_shared_bound_signer_and_finalize', 'LOP_PUBLIC'],
] : profile === '--timelock' ? [
  ['timelock_public', 'public_timelock_uses_shared_plan_approval_and_finalize', 'TIMELOCK_PUBLIC'],
] : [];
for (const [target, selected, marker] of suites) {
  let output;
  try {
    output = run('cargo', ['test', '--locked', '--offline', '-p', 'tbc-engine-core',
      '--test', target, selected,
      '--', '--exact', '--nocapture'], join(repo, 'packages/tbc-engine/rust'),
    { env: { ...process.env, [marker + '_DUMP_WIRE']: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch { throw new Error(target + ' source vector generation failed; material withheld'); }
  assert.match(output, /test result: ok\. 1 passed; 0 failed;/);
  const methods = { normalizeRequestParams: ['normalizeRequest', 'normalizeRequestResult'],
    planParams: ['plan', 'planResult'], validateParams: ['validate', 'validationResult'],
    finalizeParams: ['finalize', 'finalizeResult'] };
  let pending, count = 0;
  const counts = {};
  for (const line of output.split(/\r?\n/)) {
    if (!line.startsWith(marker + '_WIRE:')) continue;
    const wire = JSON.parse(line.slice((marker + '_WIRE:').length));
    const pair = methods[wire.definition];
    if (pair) {
      assert.equal(pending, undefined, 'Missing special-contract result');
      const input = JSON.stringify(wire.value), expected = await wasm.call(pair[0], input);
      assert.equal(JSON.parse(expected).ok, true, 'Packaged special-contract call rejected');
      counts[pair[0]] = (counts[pair[0]] ?? 0) + 1;
      pending = { method: pair[0], input, expected, definition: pair[1] };
    } else {
      assert.ok(pending?.definition === wire.definition &&
        isDeepStrictEqual(JSON.parse(pending.expected).result, wire.value),
      'Packaged special-contract result differs from source; material withheld');
      vectors.push({ method: pending.method, input: pending.input, expected: pending.expected });
      count++; pending = undefined;
    }
  }
  assert.equal(pending, undefined);
  assert.ok(count > 0);
  assert.equal(Object.keys(counts).length, 4);
  if (target === 'timelock_public') {
    timelockVectors += count;
    assert.equal(count, 10, 'Expected lock/unlock full lifecycle vectors');
  }
  specialContractVectors.push({ target, selected, count, counts });
}
if (profile === '--lop-fee') {
  let output;
  try {
    output = run('cargo', ['test','--offline','--locked','-p','tbc-engine-core','--test','lop_public',
      'public_lop_match_rejects_distinct_fee_recipients_without_signing_tasks','--','--exact','--nocapture'],
      join(repo,'packages/tbc-engine/rust'), {env:{...process.env,LOP_FEE_BOUNDARY_WIRE:'1'},stdio:['ignore','pipe','pipe']});
  } catch { throw new Error('LOP fee boundary source vectors failed; material withheld'); }
  const marker='LOP_FEE_BOUNDARY:';
  const rows=output.split('\n').filter(l=>l.includes(marker)).map(l=>JSON.parse(l.slice(l.indexOf(marker)+marker.length)));
  assert.equal(rows.length,4);
  for(const row of rows) {
    const input=JSON.stringify(row.input),expected=await wasm.call('plan',input);
    assert.deepEqual(JSON.parse(expected),row.result);
    assert.equal(row.result.ok,false);
    vectors.push({method:'plan',input,expected});
  }
  specialContractVectors.push({target:'lop_public',selected:'different-committed-fee-recipients',count:4,counts:{plan:4}});
}
let extraVectors = 0;
if (extraVectorsArg) {
  const rows = JSON.parse(await readFile(resolve(extraVectorsArg), 'utf8'));
  assert.ok(Array.isArray(rows) && rows.length > 0 && rows.length <= 512);
  for (const row of rows) {
    assert.ok(['normalizeRequest', 'plan', 'validate', 'finalize'].includes(row.method));
    assert.equal(typeof row.input, 'string'); assert.equal(typeof row.expected, 'string');
    assert.equal(await wasm.call(row.method, row.input), row.expected, 'Additional vector does not match frozen WASM');
    vectors.push(row); extraVectors++;
  }
}
await writeFile(join(scratch, 'vectors.json'), JSON.stringify(vectors));

const headers = join(sdk, 'apple/Artifacts/TbcEngineNative.xcframework/ios-arm64/Headers');
const desktop = join(resourceRoot, 'artifacts/native/aarch64-apple-darwin');
const native = join(desktop, 'libtbc_engine_native.dylib');
const installName = run('otool', ['-D', native]).trim().split('\n').at(-1);
const swiftSources = ['TbcEngine.swift', 'TbcEngineIdentity.swift'].map(f => join(sdk, 'apple/Sources/TbcEngine', f));
await logged('swift-host-build', 'xcrun', ['swiftc', '-swift-version', '6', '-emit-library', '-emit-module', '-module-name', 'TbcEngine',
  ...swiftSources, '-I', headers, '-L', desktop, '-ltbc_engine_native', '-Xlinker', '-rpath', '-Xlinker', desktop,
  '-o', join(scratch, 'libTbcEngine.dylib')]);
run('install_name_tool', ['-change', installName, '@rpath/libtbc_engine_native.dylib', join(scratch, 'libTbcEngine.dylib')]);
await logged('swift-probe-build', 'xcrun', ['swiftc', '-swift-version', '6', '-parse-as-library',
  join(root, 'consumers/SwiftProbe.swift'), '-I', scratch, '-I', headers, '-L', scratch, '-lTbcEngine',
  '-Xlinker', '-rpath', '-Xlinker', scratch, '-o', join(scratch, 'swift-probe')]);
await logged('swift-probe', join(scratch, 'swift-probe'), [join(scratch, 'vectors.json')]);

// Build a host JNI transport with identical source, linking the immutable macOS
// Rust library. Android binaries are checked separately, not executed by this probe.
const javaHome = run('/usr/libexec/java_home', ['-v', '17']).trim();
await logged('jni-host-build', 'xcrun', ['clang++', '-std=c++17', '-dynamiclib',
  join(sdk, 'android/engine/src/main/cpp/bridge.cpp'), '-I', join(javaHome, 'include'),
  '-I', join(javaHome, 'include/darwin'), '-I', headers, '-L', desktop, '-ltbc_engine_native',
  '-Wl,-rpath,' + desktop, '-o', join(scratch, 'libtbc_engine_jni.dylib')]);
run('install_name_tool', ['-change', installName, '@rpath/libtbc_engine_native.dylib', join(scratch, 'libtbc_engine_jni.dylib')]);

// SwiftPM's local package identity is the directory basename, not Package.name.
// Keep consumer and dependency basenames distinct to avoid a false self-cycle.
await cp(join(root, 'consumers/apple'), join(scratch, 'swift-consumer'), { recursive: true });
await cp(join(root, 'consumers/android'), join(scratch, 'android'), { recursive: true });
const gradle = resolve(gradleArg);
const env = { ...process.env, ANDROID_HOME: resolve(androidSdkArg), TBC_ENGINE_SDK_PATH: join(sdk, 'apple') };
await Promise.all([
  logged('apple-consumer-simulator', 'xcodebuild', ['-scheme', 'NativeEngineConsumer', '-sdk', 'iphonesimulator',
    '-destination', 'generic/platform=iOS Simulator', '-derivedDataPath', join(scratch, 'apple-derived'),
    'ARCHS=arm64', 'CODE_SIGNING_ALLOWED=NO', 'build'], join(scratch, 'swift-consumer'), { env }),
  logged('android-publish-local', gradle, [':engine:publishReleasePublicationToStagingRepository', '--no-daemon', '--console=plain'], join(sdk, 'android'), { env }),
]);
await Promise.all([
  logged('apple-consumer-device-build-only', 'xcodebuild', ['-scheme', 'NativeEngineConsumer', '-sdk', 'iphoneos',
    '-destination', 'generic/platform=iOS', '-derivedDataPath', join(scratch, 'apple-device-derived'),
    'ARCHS=arm64', 'CODE_SIGNING_ALLOWED=NO', 'build'], join(scratch, 'swift-consumer'), { env }),
  logged('android-consumer', gradle, ['assembleRelease', 'testReleaseUnitTest', '--no-daemon', '--console=plain',
    `-PengineRepository=${join(sdk, 'maven-repository')}`, `-PengineVersion=${identity.sdkVersion}`,
    `-PnativeProbeDirectory=${scratch}`, `-PnativeProbeVectors=${join(scratch, 'vectors.json')}`], join(scratch, 'android'), { env }),
]);
const aar = join(sdk, 'android/engine/build/outputs/aar/engine-release.aar');
for (const abi of identity.platforms.android) {
  const nativeBytes = execFileSync('unzip', ['-p', aar, `jni/${abi}/libtbc_engine_native.so`], { maxBuffer: 20 * 1024 * 1024 });
  assert.equal(sha(nativeBytes), identity.nativeHashes[`android/jniLibs/${abi}/libtbc_engine_native.so`], `AAR changed Rust bytes: ${abi}`);
  const jniBytes = execFileSync('unzip', ['-p', aar, `jni/${abi}/libtbc_engine_jni.so`], { maxBuffer: 5 * 1024 * 1024 });
  assert.ok(jniBytes.length > 0, `Missing JNI: ${abi}`);
}
const report = { status: 'PASS', sdkVersion: identity.sdkVersion, kitTarSha256: identity.kitTarSha256,
  artifactSetId: identity.artifactSetId, fixtureSha256: sha(fixtureBytes), vectors: vectors.length, concurrentPerLanguage: 16,
  timelockVectors, specialContractVectors, extraVectors,
  swiftHostExecution: true, kotlinJniHostExecution: true, iosDeviceLinked: true, iosSimulatorLinked: true,
  androidAarConsumerBuilt: true, androidAbis: identity.platforms.android, androidRustBytesPreserved: true,
  aarSha256: sha(await readFile(aar)), aarBytes: (await readFile(aar)).length,
  actualIosRuntime: false, actualAndroidRuntime: false, expoTemplateSwitched: false,
  networkRequestsByEngine: 0, broadcasts: 0, fullNativeKit: false, scratch };
await writeFile(join(scratch, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
