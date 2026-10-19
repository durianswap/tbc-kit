// macOS Kotlin/JNI execution with public fixtures and independent SDK validation.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp, readdir, readFile, writeFile} from 'node:fs/promises';
import {homedir, tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
const root = resolve(import.meta.dirname, '..'), kernel = join(root, 'kernel');
const output = await mkdtemp(join(tmpdir(), 'tbc-musig-kotlin-'));
const javaHome = execFileSync('/usr/libexec/java_home', ['-v', '17'], {encoding: 'utf8'}).trim();
const cache = process.env.TBC_GRADLE_MODULE_CACHE ?? join(homedir(), '.gradle/caches/modules-2/files-2.1');
async function jar(group, artifact, version) {
  const base = join(cache, group, artifact, version), matches = [];
  for (const hash of await readdir(base)) for (const name of await readdir(join(base, hash))) {
    if (name === `${artifact}-${version}.jar`) matches.push(join(base, hash, name));
  }
  assert.equal(matches.length, 1, `Exact cached dependency ${artifact}/${version}`); return matches[0];
}
const stdlib = await jar('org.jetbrains.kotlin', 'kotlin-stdlib', '2.1.20');
const annotations = await jar('org.jetbrains', 'annotations', '13.0');
const compiler = [stdlib, annotations, ...await Promise.all([
  ['org.jetbrains.kotlin', 'kotlin-compiler-embeddable', '2.1.20'],
  ['org.jetbrains.kotlin', 'kotlin-script-runtime', '2.1.20'],
  ['org.jetbrains.kotlin', 'kotlin-daemon-embeddable', '2.1.20'],
  ['org.jetbrains.kotlin', 'kotlin-reflect', '1.6.10'],
  ['org.jetbrains.intellij.deps', 'trove4j', '1.0.20200330'],
  ['org.jetbrains.kotlinx', 'kotlinx-coroutines-core-jvm', '1.8.0'],
].map(args => jar(...args)))];
const run = (cmd, args, extra = {}) => execFileSync(cmd, args, {encoding: 'utf8', timeout: 120000, ...extra});
run('cargo', ['build', '--locked', '--offline', '--release', '--features', 'musig'],
  {cwd: kernel, env: {...process.env, MACOSX_DEPLOYMENT_TARGET: '15.0'}});
const cpp = join(root, 'android/signer/src/main/cpp'), kotlin = join(root, 'android/signer/src/main/java/io/tbc/signer/TbcMuSigSession.kt');
const includes = ['-I', join(javaHome, 'include'), '-I', join(javaHome, 'include/darwin'), '-I', join(kernel, 'include')];
run('xcrun', ['clang++', '-mmacosx-version-min=15.0', '-std=c++17', '-Wall', '-Wextra', '-dynamiclib', join(cpp, 'bridge.cpp'), join(cpp, 'musig.cpp'),
  ...includes, join(kernel, 'target/release/libtbc_signer_kernel.a'), '-o', join(output, 'libtbc_signer_jni.dylib')]);
run(join(javaHome, 'bin/java'), ['-cp', compiler.join(':'), 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler',
  '-no-stdlib', '-no-reflect', '-jvm-target', '17', '-classpath', [stdlib, annotations].join(':'),
  '-d', join(output, 'classes'), kotlin, join(root, 'consumers/KotlinMuSigProbe.kt')]);
const report = JSON.parse(run(join(javaHome, 'bin/java'), ['-Djava.library.path=' + output,
  '-cp', [join(output, 'classes'), stdlib].join(':'), 'KotlinMuSigProbeKt']));
assert.equal(report.status, 'PASS'); assert.equal(report.checks, 22);
assert.equal(report.publicGroupDerivation, true);
const require = createRequire(import.meta.url), tbc = require('tbc-lib-js');
assert.equal(require('tbc-lib-js/package.json').version, '1.0.31');
const bytes = h => Buffer.from(h, 'hex'), group = tbc.crypto.MuSig2.keyAgg(report.publicKeys.map(bytes));
assert.equal(tbc.crypto.MuSig2.getAggPubkey(group).toString('hex'), report.aggregateKey);
const session = tbc.crypto.MuSig2.buildSession(group, tbc.crypto.MuSig2.nonceAgg(report.publicNonces.map(bytes)), bytes(report.digest));
for (let i = 0; i < 2; i++) assert.equal(tbc.crypto.MuSig2.partialVerify(bytes(report.partialSignatures[i]), bytes(report.publicNonces[i]), bytes(report.publicKeys[i]), session), true);
assert.equal(tbc.crypto.Schnorr.verify(bytes(report.digest), bytes(report.signature), bytes(report.aggregateKey)), true);
run('xcrun', ['clang++', '-std=c++17', '-c', join(cpp, 'bridge.cpp'), ...includes, '-o', join(output, 'default.o')]);
assert.doesNotMatch(run('nm', ['-u', join(output, 'default.o')]), /musig/);
// Compile the same JNI source with actual Android NDK headers for all supported
// ABIs; this is compile-only, not AAR linking or Android runtime acceptance.
const ndk = process.env.TBC_ANDROID_NDK ?? join(homedir(), 'Library/Android/sdk/ndk/27.1.12297006');
const androidCompileAbis = ['aarch64-linux-android', 'armv7a-linux-androideabi', 'x86_64-linux-android'];
for (const abi of androidCompileAbis) run(join(ndk, 'toolchains/llvm/prebuilt/darwin-x86_64/bin', `${abi}24-clang++`),
  ['-std=c++17', '-Wall', '-Wextra', '-Werror', '-c', join(cpp, 'musig.cpp'), '-I', join(kernel, 'include'), '-o', join(output, `${abi}.o`)]);
const sha = async file => createHash('sha256').update(await readFile(file)).digest('hex');
Object.assign(report, {sdkPartialAndFinalVerification: true, defaultJniHasNoMuSigReferences: true, networkRequests: 0,
  hostDeploymentTarget: '15.0',
  androidCompileAbis,
  scope: 'macOS JVM/JNI, not Android device or wallet approval/custody', kotlinSha256: await sha(kotlin),
  jniSourceSha256: await sha(join(cpp, 'musig.cpp')), kernelSha256: await sha(join(kernel, 'target/release/libtbc_signer_kernel.a'))});
await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', {flag: 'wx'});
console.log(JSON.stringify({status: 'PASS', checks: report.checks, sdkPartialAndFinalVerification: true, output}));
