import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const [sdkArg, hostArg, gradleArg, androidArg, udid, serial] = process.argv.slice(2);
assert.ok(sdkArg && hostArg && gradleArg && androidArg && /^[A-F0-9-]{36}$/i.test(udid ?? '') && /^emulator-\d+$/.test(serial ?? ''),
  'Usage: check-devices.mjs SDK CONSUMER_REPORT_DIRECTORY GRADLE ANDROID_SDK NON_FIXED_IOS_UDID EMULATOR_SERIAL');
const sdk = resolve(sdkArg), hostDir = resolve(hostArg), android = resolve(androidArg), root = resolve(import.meta.dirname, '..');
const scratch = await mkdtemp(join(sdk, 'device-check-'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const identity = JSON.parse(await readFile(join(sdk, 'identity.json'))), host = JSON.parse(await readFile(join(hostDir, 'report.json')));
const musig = identity.musigEnabled === true;
assert.equal(host.status, 'PASS'); assert.equal(host.artifactSetId, identity.artifactSetId);
for (const [file, hash] of Object.entries(identity.artifacts)) assert.equal(sha(await readFile(join(sdk, file))), hash);
for (const [file, hash] of Object.entries(identity.sourceHashes)) assert.equal(sha(await readFile(join(sdk, /^(apple|android)\//.test(file) ? file : `kernel/${file}`))), hash);
const run = (command, args, extra = {}) => execFileSync(command, args, { cwd: scratch, encoding: 'utf8', timeout: 180_000, maxBuffer: 15 * 1024 * 1024, ...extra });
async function logged(name, command, args, extra) {
  try { const result = run(command, args, extra); await writeFile(join(scratch, `${name}.log`), result); return result; }
  catch (e) { await writeFile(join(scratch, `${name}.log`), String(e.stdout ?? '') + String(e.stderr ?? '')); throw new Error(`${name} failed: ${scratch}/${name}.log`); }
}
const devices = JSON.parse(run('xcrun', ['simctl', 'list', 'devices', 'booted', '-j']));
const device = Object.values(devices.devices).flat().find(d => d.udid === udid);
assert.ok(device?.state === 'Booted' && !/113|143/.test(device.name), 'Use only the rolling simulator');
const adb = join(android, 'platform-tools/adb');
assert.equal(run(adb, ['-s', serial, 'get-state']).trim(), 'device');
const abi = run(adb, ['-s', serial, 'shell', 'getprop', 'ro.product.cpu.abi']).trim();
assert.ok(identity.androidAbis.includes(abi));
const vectors = join(sdk, 'kernel/fixtures/common-vectors.json');
const slice = join(sdk, 'apple/Artifacts/TbcSignerKernel.xcframework/ios-arm64-simulator');
const common = ['-swift-version', '6', '-target', 'arm64-apple-ios15.1-simulator', '-sdk', run('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-path']).trim()];
await logged('ios-binding', 'xcrun', ['swiftc', ...common, '-emit-library', '-emit-module', '-module-name', 'TbcSigner',
  join(sdk, 'apple/Sources/TbcSigner/TbcDigestSigner.swift'),
  ...(musig ? ['-D', 'TBC_SIGNER_MUSIG', join(sdk, 'apple/Sources/TbcSigner/TbcMuSigSession.swift')] : []),
  '-I', join(slice, 'Headers'), '-L', slice, '-ltbc_signer_kernel',
  '-Xlinker', '-install_name', '-Xlinker', '@rpath/libTbcSigner.dylib', '-o', join(scratch, 'libTbcSigner.dylib')]);
await logged('ios-probe-build', 'xcrun', ['swiftc', ...common, '-parse-as-library', join(root, 'consumers/SwiftProbe.swift'),
  '-I', scratch, '-I', join(slice, 'Headers'), '-L', scratch, '-lTbcSigner', '-Xlinker', '-rpath', '-Xlinker', scratch, '-o', join(scratch, 'swift-probe')]);
for (const file of ['libTbcSigner.dylib', 'swift-probe']) run('codesign', ['--force', '--sign', '-', join(scratch, file)]);
const iosResult = await logged('ios-run', 'xcrun', ['simctl', 'spawn', udid, join(scratch, 'swift-probe'), vectors]);
assert.match(iosResult, /SIGNER_SWIFT_PASS checks=52/);
assert.match(iosResult, /SCHNORR_SWIFT_PASS checks=1/);
let musigIos;
if (musig) {
  assert.equal(host.musigSwiftChecks, 18); assert.equal(host.musigKotlinJniChecks, 22);
  await logged('ios-musig-build', 'xcrun', ['swiftc', ...common, '-parse-as-library', '-D', 'TBC_SIGNER_EXTERNAL_MODULE',
    ...(identity.extension.publicGroupDerivation ? ['-D','TBC_SIGNER_GROUP_DERIVATION'] : []),
    join(root, 'consumers/SwiftMuSigProbe.swift'), '-I', scratch, '-I', join(slice, 'Headers'),
    '-L', scratch, '-lTbcSigner', '-Xlinker', '-rpath', '-Xlinker', scratch, '-o', join(scratch, 'swift-musig-probe')]);
  run('codesign', ['--force', '--sign', '-', join(scratch, 'swift-musig-probe')]);
  musigIos = JSON.parse(await logged('ios-musig-run', 'xcrun', ['simctl', 'spawn', udid, join(scratch, 'swift-musig-probe')]));
  assert.equal(musigIos.checks, 18);
}
const init = join(scratch, 'classpath.gradle'), cpOut = join(scratch, 'classpath.json');
await writeFile(init, `allprojects { afterEvaluate { p -> if (p == rootProject) tasks.register('writeProbeClasspath') { doLast {
  file(providers.gradleProperty('probeClasspathOut').get()).text = groovy.json.JsonOutput.toJson(configurations.releaseRuntimeClasspath.resolve().collect { it.absolutePath })
} } } }\n`);
await logged('android-classpath', resolve(gradleArg), ['writeProbeClasspath', '--offline', '--no-daemon', '--console=plain', '-I', init,
  `-PprobeClasspathOut=${cpOut}`, `-PsignerRepository=${join(sdk, 'maven-repository')}`, `-PsignerVersion=${identity.sdkVersion}`,
  `-PnativeProbeDirectory=${hostDir}`, `-PnativeProbeVectors=${vectors}`],
  { cwd: join(hostDir, 'android-consumer'), env: { ...process.env, ANDROID_HOME: android } });
const classpath = JSON.parse(await readFile(cpOut)), jars = classpath.filter(f => f.endsWith('.jar'));
assert.ok(jars.some(f => /kotlin-stdlib/.test(f)));
const aar = classpath.find(f => f.endsWith('.aar')); assert.ok(aar);
assert.equal(sha(await readFile(aar)), host.aarSha256);
const unpack = (file) => execFileSync('unzip', ['-p', aar, file], { maxBuffer: 8 * 1024 * 1024 });
await writeFile(join(scratch, 'sdk.jar'), unpack('classes.jar'));
for (const name of ['libtbc_signer_kernel.so', 'libtbc_signer_jni.so']) await writeFile(join(scratch, name), unpack(`jni/${abi}/${name}`));
assert.equal(sha(await readFile(join(scratch, 'libtbc_signer_kernel.so'))), identity.artifacts[`kernel/artifacts/android/${abi}/libtbc_signer_kernel.so`]);
const androidJar = join(android, 'platforms/android-36/android.jar');
await mkdir(join(scratch, 'classes'));
await logged('javac', 'javac', ['-source', '17', '-target', '17', '-cp', [androidJar, join(scratch, 'sdk.jar'), ...jars].join(':'),
  '-d', join(scratch, 'classes'), join(root, 'consumers/SignerProbe.java')]);
run('jar', ['cf', join(scratch, 'probe.jar'), '-C', join(scratch, 'classes'), '.']);
const extraJars = [];
if (musig) {
  // Reuse only this public probe's already-compiled bytecode from the successful
  // AAR consumer. Do not dex JUnit or unrelated unit tests into the device probe.
  const classes = join(hostDir, 'android-consumer/build/tmp/kotlin-classes/releaseUnitTest');
  const names = (await readdir(classes)).filter(n => /^KotlinMuSigProbeKt(?:\$.*)?\.class$/.test(n));
  assert.ok(names.includes('KotlinMuSigProbeKt.class'));
  run('jar', ['cf', join(scratch, 'musig-probe.jar'), ...names.flatMap(n => ['-C', classes, n])]);
  extraJars.push(join(scratch, 'musig-probe.jar'));
}
await logged('dex', join(android, 'build-tools/36.0.0/d8'), ['--lib', androidJar, '--min-api', '26', '--output', join(scratch, 'probe.zip'),
  join(scratch, 'probe.jar'), ...extraJars, join(scratch, 'sdk.jar'), ...jars]);
await writeFile(join(scratch, 'vectors.json'), await readFile(vectors));
const remote = `/data/local/tmp/tbc-signer-${scratch.split('/').at(-1)}`;
assert.match(remote, /^\/data\/local\/tmp\/tbc-signer-device-check-[A-Za-z0-9]+$/);
run(adb, ['-s', serial, 'shell', 'mkdir', remote]);
const remoteFiles = ['probe.zip', 'vectors.json', 'libtbc_signer_kernel.so', 'libtbc_signer_jni.so'];
for (const file of remoteFiles) run(adb, ['-s', serial, 'push', join(scratch, file), `${remote}/${file}`]);
run(adb, ['-s', serial, 'shell', 'chmod', '444', `${remote}/probe.zip`]);
const androidResult = await logged('android-run', adb, ['-s', serial, 'shell',
  `CLASSPATH=${remote}/probe.zip app_process -Djava.library.path=${remote} /system/bin io.tbc.validation.SignerProbe ${remote}/vectors.json`]);
assert.match(androidResult, /SIGNER_ANDROID_ART_PASS checks=52/);
assert.match(androidResult, /SCHNORR_ANDROID_ART_PASS checks=3/);
let musigAndroid;
if (musig) {
  musigAndroid = JSON.parse(await logged('android-musig-run', adb, ['-s', serial, 'shell',
    `CLASSPATH=${remote}/probe.zip app_process -Djava.library.path=${remote} /system/bin KotlinMuSigProbeKt`]));
  assert.equal(musigAndroid.checks, 22);
  const require = createRequire(import.meta.url), tbc = require('tbc-lib-js'), bytes = h => Buffer.from(h, 'hex');
  assert.equal(require('tbc-lib-js/package.json').version, '1.0.31');
  for (const transcript of [musigIos, musigAndroid]) {
    if(identity.extension.publicGroupDerivation)assert.equal(transcript.publicGroupDerivation,true);
    assert.equal(transcript.status, 'PASS');
    const group = tbc.crypto.MuSig2.keyAgg(transcript.publicKeys.map(bytes));
    assert.equal(tbc.crypto.MuSig2.getAggPubkey(group).toString('hex'), transcript.aggregateKey);
    const session = tbc.crypto.MuSig2.buildSession(group, tbc.crypto.MuSig2.nonceAgg(transcript.publicNonces.map(bytes)), bytes(transcript.digest));
    for (let i = 0; i < 2; i++) assert.equal(tbc.crypto.MuSig2.partialVerify(bytes(transcript.partialSignatures[i]), bytes(transcript.publicNonces[i]), bytes(transcript.publicKeys[i]), session), true);
    assert.equal(tbc.crypto.Schnorr.verify(bytes(transcript.digest), bytes(transcript.signature), bytes(transcript.aggregateKey)), true);
  }
}
run(adb, ['-s', serial, 'shell', 'rm', ...remoteFiles.map(f => `${remote}/${f}`)]);
run(adb, ['-s', serial, 'shell', 'rmdir', remote]);
const report = { status: 'PASS', artifactSetId: identity.artifactSetId, aarSha256: host.aarSha256,
  musigEnabled: musig, musigIosChecks: musigIos?.checks ?? 0, musigAndroidChecks: musigAndroid?.checks ?? 0,
  musigIndependentSdkVerified: musig,
  publicGroupDerivationVerified: identity.extension.publicGroupDerivation===true && musigIos?.publicGroupDerivation===true && musigAndroid?.publicGroupDerivation===true,
  ios: { udid, name: device.name, runtime: 'iOS Simulator arm64 process', checks: 52, schnorrChecks: 1, output: iosResult.trim() },
  android: { serial, abi, runtime: 'Android ART shell process', checks: 52, schnorrChecks: 3, output: androidResult.trim(), testFilesCleaned: true },
  publicFixedScalarsOnly: true, appInstalled: false, physicalDevice: false, walletModified: false, broadcasts: 0, scratch };
await writeFile(join(scratch, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
