import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const [sdkArg, gradleArg, androidArg] = process.argv.slice(2);
assert.ok(sdkArg && gradleArg && androidArg, 'Usage: check-consumers.mjs SIGNER_SDK GRADLE ANDROID_SDK');
const sdk = resolve(sdkArg), root = resolve(import.meta.dirname, '..');
const scratch = await mkdtemp(join(sdk, 'consumer-check-'));
const identity = JSON.parse(await readFile(join(sdk, 'identity.json')));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
for (const [file, sha] of Object.entries(identity.artifacts)) assert.equal(hash(await readFile(join(sdk, file))), sha, file);
for (const [file, sha] of Object.entries(identity.sourceHashes)) {
  const path = /^(apple|android)\//.test(file) ? file : `kernel/${file}`;
  assert.equal(hash(await readFile(join(sdk, path))), sha, path);
}
const env = { ...process.env, ANDROID_HOME: resolve(androidArg), TBC_SIGNER_SDK_PATH: join(sdk, 'apple') };
const run = (command, args, cwd = scratch, extra = {}) => execFileSync(command, args, { cwd, env, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, timeout: 300_000, ...extra });
async function logged(name, command, args, cwd) {
  try { const output = run(command, args, cwd); await writeFile(join(scratch, `${name}.log`), output); return output; }
  catch (e) { await writeFile(join(scratch, `${name}.log`), String(e.stdout ?? '') + String(e.stderr ?? '')); throw new Error(`${name} failed; see ${scratch}/${name}.log`); }
}
const headers = join(sdk, 'kernel/include'), desktop = join(sdk, 'kernel/artifacts/native/aarch64-apple-darwin');
const native = join(desktop, 'libtbc_signer_kernel.dylib');
const installName = run('otool', ['-D', native]).trim().split('\n').at(-1);
const swift = join(sdk, 'apple/Sources/TbcSigner/TbcDigestSigner.swift');
const musig = identity.musigEnabled === true;
const musigSources = musig ? ['-D', 'TBC_SIGNER_MUSIG', join(sdk, 'apple/Sources/TbcSigner/TbcMuSigSession.swift')] : [];
await logged('swift-host-build', 'xcrun', ['swiftc', '-target', 'arm64-apple-macos15.0', '-swift-version', '6', '-emit-library', '-emit-module', '-module-name', 'TbcSigner', swift, ...musigSources,
  '-I', headers, '-L', desktop, '-ltbc_signer_kernel', '-Xlinker', '-rpath', '-Xlinker', desktop, '-o', join(scratch, 'libTbcSigner.dylib')]);
run('install_name_tool', ['-change', installName, '@rpath/libtbc_signer_kernel.dylib', join(scratch, 'libTbcSigner.dylib')]);
await logged('swift-probe-build', 'xcrun', ['swiftc', '-swift-version', '6', '-parse-as-library', join(root, 'consumers/SwiftProbe.swift'), '-I', scratch, '-I', headers,
  '-L', scratch, '-lTbcSigner', '-Xlinker', '-rpath', '-Xlinker', scratch, '-o', join(scratch, 'swift-probe')]);
const vectors = join(sdk, 'kernel/fixtures/common-vectors.json');
const swiftOutput = await logged('swift-probe', join(scratch, 'swift-probe'), [vectors]);
assert.match(swiftOutput, /SIGNER_SWIFT_PASS checks=52/);
assert.match(swiftOutput, /SCHNORR_SWIFT_PASS checks=1/);
let musigSwift;
if (musig) {
  await logged('swift-musig-build', 'xcrun', ['swiftc', '-target', 'arm64-apple-macos15.0', '-swift-version', '6', '-parse-as-library',
    '-D', 'TBC_SIGNER_EXTERNAL_MODULE', ...(identity.extension.publicGroupDerivation ? ['-D','TBC_SIGNER_GROUP_DERIVATION'] : []), join(root, 'consumers/SwiftMuSigProbe.swift'), '-I', scratch, '-I', headers,
    '-L', scratch, '-lTbcSigner', '-Xlinker', '-rpath', '-Xlinker', scratch, '-o', join(scratch, 'swift-musig-probe')]);
  musigSwift = JSON.parse(await logged('swift-musig-probe', join(scratch, 'swift-musig-probe'), []));
  assert.equal(musigSwift.checks, 18);
}
const javaHome = run('/usr/libexec/java_home', ['-v', '17']).trim(); env.JAVA_HOME = javaHome;
await logged('jni-host-build', 'xcrun', ['clang++', '-mmacosx-version-min=15.0', '-std=c++17', '-dynamiclib', join(sdk, 'android/signer/src/main/cpp/bridge.cpp'),
  ...(musig ? [join(sdk, 'android/signer/src/main/cpp/musig.cpp')] : []),
  '-I', join(javaHome, 'include'), '-I', join(javaHome, 'include/darwin'), '-I', headers, '-L', desktop, '-ltbc_signer_kernel', '-Wl,-rpath,' + desktop,
  '-o', join(scratch, 'libtbc_signer_jni.dylib')]);
run('install_name_tool', ['-change', installName, '@rpath/libtbc_signer_kernel.dylib', join(scratch, 'libtbc_signer_jni.dylib')]);
await cp(join(root, 'consumers/apple'), join(scratch, 'swift-consumer'), { recursive: true });
await cp(join(root, 'consumers/android'), join(scratch, 'android-consumer'), { recursive: true });
if (musig) {
  for (const file of ['KotlinMuSigProbe.kt', 'MuSigProbeTest.kt'])
    await cp(join(root, 'consumers', file), join(scratch, 'android-consumer/src/test/java', file));
}
for (const [platform, destination] of [['iphonesimulator', 'iOS Simulator'], ['iphoneos', 'iOS']]) {
  await logged(`spm-${platform}`, 'xcodebuild', ['-scheme', 'SignerConsumer', '-sdk', platform, '-destination', `generic/platform=${destination}`,
    '-derivedDataPath', join(scratch, `derived-${platform}`), 'ARCHS=arm64', 'CODE_SIGNING_ALLOWED=NO', 'build'], join(scratch, 'swift-consumer'));
}
await logged('android-local-publish', resolve(gradleArg), [':signer:publishReleasePublicationToStagingRepository', '--offline', '--no-daemon', '--console=plain'], join(sdk, 'android'));
const kotlinOutput = await logged('android-consumer', resolve(gradleArg), ['assembleRelease', 'testReleaseUnitTest', '--offline', '--no-daemon', '--console=plain',
  `-PsignerRepository=${join(sdk, 'maven-repository')}`, `-PsignerVersion=${identity.sdkVersion}`, `-PnativeProbeDirectory=${scratch}`, `-PnativeProbeVectors=${vectors}`], join(scratch, 'android-consumer'));
assert.match(kotlinOutput, /SIGNER_KOTLIN_JNI_PASS checks=52/);
assert.match(kotlinOutput, /SCHNORR_KOTLIN_JNI_PASS checks=3/);
let musigKotlin;
if (musig) {
  const json = kotlinOutput.match(/MUSIG_KOTLIN_JNI_REPORT (\{[^\n]+\})/);
  assert.ok(json, 'Actual AAR MuSig consumer ran'); musigKotlin = JSON.parse(json[1]);
  assert.equal(musigKotlin.checks, 22);
  const require = createRequire(import.meta.url), tbc = require('tbc-lib-js');
  assert.equal(require('tbc-lib-js/package.json').version, '1.0.31');
  const bytes = h => Buffer.from(h, 'hex');
  for (const transcript of [musigSwift, musigKotlin]) {
    if(identity.extension.publicGroupDerivation)assert.equal(transcript.publicGroupDerivation,true);
    assert.equal(transcript.status, 'PASS');
    const group = tbc.crypto.MuSig2.keyAgg(transcript.publicKeys.map(bytes));
    assert.equal(tbc.crypto.MuSig2.getAggPubkey(group).toString('hex'), transcript.aggregateKey);
    const session = tbc.crypto.MuSig2.buildSession(group, tbc.crypto.MuSig2.nonceAgg(transcript.publicNonces.map(bytes)), bytes(transcript.digest));
    for (let i = 0; i < 2; i++) assert.equal(tbc.crypto.MuSig2.partialVerify(bytes(transcript.partialSignatures[i]), bytes(transcript.publicNonces[i]), bytes(transcript.publicKeys[i]), session), true);
    assert.equal(tbc.crypto.Schnorr.verify(bytes(transcript.digest), bytes(transcript.signature), bytes(transcript.aggregateKey)), true);
  }
}
const aar = join(sdk, 'android/signer/build/outputs/aar/signer-release.aar');
for (const abi of identity.androidAbis) {
  const bytes = execFileSync('unzip', ['-p', aar, `jni/${abi}/libtbc_signer_kernel.so`], { maxBuffer: 8 * 1024 * 1024 });
  assert.equal(hash(bytes), identity.artifacts[`kernel/artifacts/android/${abi}/libtbc_signer_kernel.so`]);
  assert.ok(execFileSync('unzip', ['-p', aar, `jni/${abi}/libtbc_signer_jni.so`]).length > 0);
}
const report = { status: 'PASS', sdkVersion: identity.sdkVersion, artifactSetId: identity.artifactSetId,
  swiftHostChecks: 52, kotlinJniHostChecks: 52, iosSimulatorLinked: true, iosDeviceLinked: true,
  schnorrSwiftHostChecks: 1, schnorrKotlinJniHostChecks: 3,
  musigEnabled: musig, musigSwiftChecks: musigSwift?.checks ?? 0, musigKotlinJniChecks: musigKotlin?.checks ?? 0,
  musigIndependentSdkVerified: musig,
  publicGroupDerivationVerified: identity.extension.publicGroupDerivation===true && musigSwift?.publicGroupDerivation===true && musigKotlin?.publicGroupDerivation===true,
  androidAarBuiltAndConsumed: true, androidAbis: identity.androidAbis, rustBytesPreservedInAar: true,
  aarSha256: hash(await readFile(aar)), aarBytes: (await readFile(aar)).length,
  engineDependency: false, walletRepositoryDependency: false, actualIosExecution: false, actualAndroidExecution: false,
  syntheticPublicKeysOnly: true, broadcasts: 0, scratch };
await writeFile(join(scratch, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
