import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const [sdkArg, hostReportArg, gradleArg, androidSdkArg, iosId, androidSerial] = process.argv.slice(2);
assert.ok(sdkArg && hostReportArg && gradleArg && androidSdkArg && /^[A-F0-9-]{36}$/i.test(iosId ?? '') && /^emulator-\d+$/.test(androidSerial ?? ''),
  'Usage: node check-native-engine-devices.mjs SDK HOST_REPORT_DIRECTORY GRADLE ANDROID_SDK IOS_SIMULATOR_UDID ANDROID_EMULATOR_SERIAL');
const sdk = resolve(sdkArg), hostReport = resolve(hostReportArg), androidSdk = resolve(androidSdkArg);
const source = resolve(import.meta.dirname, '..');
const scratch = await mkdtemp(join(sdk, 'device-check-'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const identity = JSON.parse(await readFile(join(sdk, 'identity.json'), 'utf8'));
const host = JSON.parse(await readFile(join(hostReport, 'report.json'), 'utf8'));
assert.equal(host.status, 'PASS'); assert.equal(host.artifactSetId, identity.artifactSetId);
const aar = join(sdk, 'android/engine/build/outputs/aar/engine-release.aar');
assert.equal(sha(await readFile(aar)), host.aarSha256, 'AAR changed since host validation');
for (const [path, hash] of Object.entries(identity.bindingSourceHashes)) assert.equal(sha(await readFile(join(sdk, path))), hash, path);
const run = (command, args, extra = {}) => execFileSync(command, args, {
  cwd: scratch, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, timeout: 180000, ...extra,
});
let step = 0;
async function logged(label, command, args, extra) {
  const log = join(scratch, `${++step}-${label}.log`);
  try { const output = run(command, args, extra); await writeFile(log, output); return output; }
  catch (error) {
    await writeFile(log, String(error.stdout ?? '') + '\n' + String(error.stderr ?? ''));
    throw new Error(`${label} failed; see ${log}: ${String(error.stderr ?? error.message).slice(-1500)}`);
  }
}
const devices = JSON.parse(run('xcrun', ['simctl', 'list', 'devices', 'booted', '-j']));
const device = Object.values(devices.devices).flat().find(d => d.udid === iosId);
assert.ok(device?.state === 'Booted', 'Selected iOS Simulator is not already booted');
assert.ok(!/(113|143)/.test(device.name), 'Fixed reference simulators must not be used');
const adb = join(androidSdk, 'platform-tools/adb');
assert.equal(run(adb, ['-s', androidSerial, 'get-state']).trim(), 'device');
const abi = run(adb, ['-s', androidSerial, 'shell', 'getprop', 'ro.product.cpu.abi']).trim();
assert.ok(identity.platforms.android.includes(abi), 'Unsupported Android ABI');
const vectors = await readFile(join(hostReport, 'vectors.json'));
assert.equal(JSON.parse(vectors).length, host.vectors);
await writeFile(join(scratch, 'vectors.json'), vectors);

// Use the actual frozen iOS archive, never the macOS dynamic library.
const slice = join(sdk, 'apple/Artifacts/TbcEngineNative.xcframework/ios-arm64-simulator');
assert.equal(sha(await readFile(join(slice, 'libtbc_engine_native.a'))),
  identity.nativeHashes['ios/TbcEngineNative.xcframework/ios-arm64-simulator/libtbc_engine_native.a']);
const simulatorSdk = run('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-path']).trim();
const swiftArgs = ['-swift-version', '6', '-target', 'arm64-apple-ios15.1-simulator', '-sdk', simulatorSdk];
await logged('ios-library-build', 'xcrun', ['swiftc', ...swiftArgs, '-emit-library', '-emit-module', '-module-name', 'TbcEngine',
  join(sdk, 'apple/Sources/TbcEngine/TbcEngine.swift'), join(sdk, 'apple/Sources/TbcEngine/TbcEngineIdentity.swift'),
  '-I', join(slice, 'Headers'), '-L', slice, '-ltbc_engine_native',
  '-Xlinker', '-install_name', '-Xlinker', '@rpath/libTbcEngine.dylib', '-o', join(scratch, 'libTbcEngine.dylib')]);
await logged('ios-probe-build', 'xcrun', ['swiftc', ...swiftArgs, '-parse-as-library', join(source, 'consumers/SwiftProbe.swift'),
  '-I', scratch, '-I', join(slice, 'Headers'), '-L', scratch, '-lTbcEngine',
  '-Xlinker', '-rpath', '-Xlinker', scratch, '-o', join(scratch, 'swift-probe')]);
run('codesign', ['--force', '--sign', '-', join(scratch, 'libTbcEngine.dylib')]);
run('codesign', ['--force', '--sign', '-', join(scratch, 'swift-probe')]);
const iosOutput = await logged('ios-runtime', 'xcrun', ['simctl', 'spawn', iosId, join(scratch, 'swift-probe'), join(scratch, 'vectors.json'), identity.artifactSetId]);
assert.ok(iosOutput.includes(`SWIFT_NATIVE_PROBE_PASS runtime=ios-simulator cases=${host.vectors} concurrent=16`));

// Resolve the AAR's declared runtime dependency graph. The app_process probe
// uses ART plus the real packaged Android .so files, not a desktop substitute.
const classpathOutput = join(scratch, 'runtime-classpath.json');
const initScript = join(scratch, 'probe-classpath.gradle');
await writeFile(initScript, `allprojects { afterEvaluate { p ->
  if (p == rootProject) tasks.register('writeProbeClasspath') { doLast {
    file(providers.gradleProperty('probeClasspathOut').get()).text = groovy.json.JsonOutput.toJson(configurations.releaseRuntimeClasspath.resolve().collect { it.absolutePath })
  } }
} }\n`);
await logged('android-dependency-resolution', resolve(gradleArg), ['writeProbeClasspath', '--no-daemon', '--console=plain', '-I', initScript,
  `-PprobeClasspathOut=${classpathOutput}`, `-PengineRepository=${join(sdk, 'maven-repository')}`, `-PengineVersion=${identity.sdkVersion}`,
  `-PnativeProbeDirectory=${hostReport}`, `-PnativeProbeVectors=${join(hostReport, 'vectors.json')}`],
  { cwd: join(hostReport, 'android'), env: { ...process.env, ANDROID_HOME: androidSdk } });
const runtimeFiles = JSON.parse(await readFile(classpathOutput, 'utf8'));
const jars = runtimeFiles.filter(p => p.endsWith('.jar'));
assert.ok(jars.some(p => /kotlinx-coroutines-core-jvm/.test(p)));
assert.ok(jars.some(p => /kotlin-stdlib/.test(p)));
const packagedAar = runtimeFiles.find(p => p.endsWith('.aar'));
assert.ok(packagedAar); assert.equal(sha(await readFile(packagedAar)), host.aarSha256);
const bytes = (path) => execFileSync('unzip', ['-p', aar, path], { maxBuffer: 20 * 1024 * 1024 });
await writeFile(join(scratch, 'sdk-classes.jar'), bytes('classes.jar'));
const rust = bytes(`jni/${abi}/libtbc_engine_native.so`);
assert.equal(sha(rust), identity.nativeHashes[`android/jniLibs/${abi}/libtbc_engine_native.so`]);
await writeFile(join(scratch, 'libtbc_engine_native.so'), rust);
await writeFile(join(scratch, 'libtbc_engine_jni.so'), bytes(`jni/${abi}/libtbc_engine_jni.so`));
const probeFiles = ['probe.zip', 'libtbc_engine_native.so', 'libtbc_engine_jni.so', 'vectors.json'];
if (identity.keylessArtifactSetId) {
  const keyless = bytes(`jni/${abi}/libtbc_keyless_native.so`);
  assert.equal(sha(keyless), identity.keylessHashes[`android/${abi}/libtbc_keyless_native.so`]);
  await writeFile(join(scratch, 'libtbc_keyless_native.so'), keyless);
  probeFiles.push('libtbc_keyless_native.so');
}
const androidJar = join(androidSdk, 'platforms/android-36/android.jar');
await mkdir(join(scratch, 'classes'));
await logged('android-probe-javac', 'javac', ['-source', '17', '-target', '17', '-cp',
  [androidJar, join(scratch, 'sdk-classes.jar'), ...jars].join(':'), '-d', join(scratch, 'classes'),
  join(source, 'consumers/android-device/EngineProbe.java')]);
run('jar', ['cf', join(scratch, 'probe.jar'), '-C', join(scratch, 'classes'), '.']);
await logged('android-probe-dex', join(androidSdk, 'build-tools/36.0.0/d8'), ['--lib', androidJar, '--min-api', '26',
  '--output', join(scratch, 'probe.zip'), join(scratch, 'probe.jar'), join(scratch, 'sdk-classes.jar'), ...jars]);
const remote = `/data/local/tmp/tbc-engine-probe-${scratch.split('/').at(-1)}`;
assert.match(remote, /^\/data\/local\/tmp\/tbc-engine-probe-device-check-[A-Za-z0-9]+$/);
run(adb, ['-s', androidSerial, 'shell', 'mkdir', remote]);
for (const file of probeFiles) {
  run(adb, ['-s', androidSerial, 'push', join(scratch, file), `${remote}/${file}`]);
}
// Android 14+ requires loaded DEX files not to be writable. This affects only
// these new test-owned files, not an app, its signing settings or wallet storage.
run(adb, ['-s', androidSerial, 'shell', 'chmod', '444', `${remote}/probe.zip`]);
const androidOutput = await logged('android-runtime', adb, ['-s', androidSerial, 'shell',
  `CLASSPATH=${remote}/probe.zip app_process -Djava.library.path=${remote} /system/bin io.tbc.validation.EngineProbe ${remote}/vectors.json ${identity.artifactSetId}`]);
assert.match(androidOutput, /ANDROID_NATIVE_PROBE_PASS runtime=ART api=\d+ abi=\S+/);
assert.ok(androidOutput.includes(`cases=${host.vectors} concurrent=16`));
// Remove only the files created by this run. Preserve host evidence and do
// not recursively delete anything if an unexpected file appears in the directory.
run(adb, ['-s', androidSerial, 'shell', 'rm', ...probeFiles.map(f => `${remote}/${f}`)]);
run(adb, ['-s', androidSerial, 'shell', 'rmdir', remote]);
const report = { status: 'PASS', sdkVersion: identity.sdkVersion, kitTarSha256: identity.kitTarSha256,
  artifactSetId: identity.artifactSetId, aarSha256: host.aarSha256, vectorsSha256: sha(vectors),
  ios: { udid: iosId, name: device.name, runtime: 'iOS Simulator arm64 process', output: iosOutput.trim() },
  android: { serial: androidSerial, abi, runtime: 'Android ART shell process', output: androidOutput.trim(), remote, probeFilesCleaned: true },
  methodVectors: host.vectors, timelockVectors: host.timelockVectors ?? 0, concurrentPerPlatform: 16, existingWalletChanged: false, appInstalled: false,
  physicalDevice: false, expoTemplateSwitched: false, fullNativeKit: false, broadcasts: 0, scratch };
await writeFile(join(scratch, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
