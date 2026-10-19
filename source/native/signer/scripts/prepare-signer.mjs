import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';

const [outputArg, ndkArg, extensionName = 'local3'] = process.argv.slice(2);
assert.ok(outputArg && ndkArg && ['local3', 'local4', 'local5'].includes(extensionName), 'Usage: prepare-signer.mjs NEW_OUTPUT_DIRECTORY ANDROID_NDK [local3|local4|local5]');
const root = resolve(import.meta.dirname, '..'), output = resolve(outputArg), ndk = resolve(ndkArg);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function hashes(directory, prefix = '') {
  const result = {};
  for (const entry of (await readdir(join(directory, prefix), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory() && entry.name === 'target') continue; // Local Cargo outputs are not source provenance.
    assert.ok(!entry.isSymbolicLink(), 'No symlinks in Signer delivery');
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(result, await hashes(directory, path));
    else result[path] = hash(await readFile(join(directory, path)));
  }
  return result;
}
const imported = JSON.parse(await readFile(join(root, 'import-provenance.json')));
const extension = JSON.parse(await readFile(join(root, 'extensions', `${extensionName}.json`)));
const musigEnabled = extension.musigEnabled === true;
assert.equal(musigEnabled, ['local4','local5'].includes(extensionName));
assert.equal(extension.publicGroupDerivation===true,extensionName==='local5');
for (const item of imported.files) assert.equal(hash(await readFile(join(root, 'kernel', item.path))), extension.files[item.path] ?? item.sha256, item.path);
for (const [file,expected] of Object.entries(extension.files)) assert.equal(hash(await readFile(join(root,'kernel',file))),expected,file);
for (const [file, expected] of Object.entries(extension.platformFiles ?? {})) {
  assert.match(file, /^(apple|android)\//); assert.ok(!file.split('/').includes('..'));
  assert.equal(hash(await readFile(join(root, file))), expected, file);
}
if (musigEnabled) execFileSync('node', [join(root, 'kernel/scripts/check-musig-vendor.mjs')], {stdio: 'inherit'});
// Exclusive output, no writing to source trees or another wallet's native artifacts.
await mkdir(output);
const sourceHashes = { ...(await hashes(join(root, 'kernel'))),
  ...Object.fromEntries(Object.entries(await hashes(join(root, 'apple'))).map(([p, h]) => [`apple/${p}`, h])),
  ...Object.fromEntries(Object.entries(await hashes(join(root, 'android'))).map(([p, h]) => [`android/${p}`, h])) };
await cp(join(root, 'kernel'), join(output, 'kernel'), { recursive: true, filter: source => source !== join(root, 'kernel/target') });
await cp(join(root, 'apple'), join(output, 'apple'), { recursive: true });
await cp(join(root, 'android'), join(output, 'android'), { recursive: true });
await cp(join(root, 'import-provenance.json'), join(output, 'import-provenance.json'));
await cp(join(root, 'extensions'), join(output, 'extensions'), {recursive:true});
// Prove the copied snapshot, not merely the earlier mutable checkout reads.
for (const [file, expected] of Object.entries(sourceHashes)) {
  const path = /^(apple|android)\//.test(file) ? file : `kernel/${file}`;
  assert.equal(hash(await readFile(join(output, path))), expected, path);
}
const kernel = join(output, 'kernel'), targetDir = join(output, 'target');
const manifest = join(kernel, 'Cargo.toml');
const tools = join(ndk, 'toolchains/llvm/prebuilt/darwin-x86_64/bin');
const env = { ...process.env, CARGO_TARGET_DIR: targetDir };
const run = (command, args, extra = {}) => execFileSync(command, args, { cwd: output, env, stdio: 'inherit', ...extra });
const text = (command, args) => run(command, args, { stdio: 'pipe', encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
const rustc = text('rustc', ['-vV']), host = rustc.match(/^host: (.+)$/m)?.[1];
assert.equal(host, 'aarch64-apple-darwin', 'This local builder currently supports Apple Silicon macOS');
const features = musigEnabled ? ['--features', 'musig'] : [];
const build = (target, extra = {}) => run('cargo', ['build', '--locked', '--offline', '--release', '--manifest-path', manifest, '--target', target, ...features], { env: { ...env, ...extra } });
const copy = async (from, to) => { await mkdir(dirname(to), { recursive: true }); await cp(from, to, { recursive: true }); };
run('cargo', ['test', '--locked', '--offline', '--manifest-path', manifest, ...features]);
if (musigEnabled) run('cargo', ['test', '--locked', '--offline', '--manifest-path', manifest, '--no-default-features']);
build(host, {MACOSX_DEPLOYMENT_TARGET: '15.0'});
await copy(join(targetDir, host, 'release/libtbc_signer_kernel.dylib'), join(kernel, 'artifacts/native', host, 'libtbc_signer_kernel.dylib'));
build('wasm32-unknown-unknown', { CC_wasm32_unknown_unknown: join(tools, 'clang'), AR_wasm32_unknown_unknown: join(tools, 'llvm-ar'), CFLAGS_wasm32_unknown_unknown: `-include ${join(kernel, 'wasm/compat.h')}` });
await copy(join(targetDir, 'wasm32-unknown-unknown/release/tbc_signer_kernel.wasm'), join(kernel, 'artifacts/wasm/tbc_signer_kernel.wasm'));
for (const [target, abi, cc] of [
  ['aarch64-linux-android', 'arm64-v8a', 'aarch64-linux-android'],
  ['armv7-linux-androideabi', 'armeabi-v7a', 'armv7a-linux-androideabi'],
  ['x86_64-linux-android', 'x86_64', 'x86_64-linux-android'],
]) {
  const key = target.replaceAll('-', '_');
  build(target, { [`CARGO_TARGET_${key.toUpperCase()}_LINKER`]: join(tools, `${cc}24-clang`),
    [`CC_${key}`]: join(tools, `${cc}24-clang`), [`AR_${key}`]: join(tools, 'llvm-ar'),
    [`CARGO_TARGET_${key.toUpperCase()}_RUSTFLAGS`]: '-C link-arg=-Wl,-z,max-page-size=16384' });
  const so = join(targetDir, target, 'release/libtbc_signer_kernel.so');
  await copy(so, join(kernel, 'artifacts/android', abi, 'libtbc_signer_kernel.so'));
  await copy(so, join(output, 'android/signer/src/main/jniLibs', abi, 'libtbc_signer_kernel.so'));
}
await copy(join(kernel, 'include'), join(output, 'android/signer/src/main/cpp/include'));
for (const target of ['aarch64-apple-ios', 'aarch64-apple-ios-sim']) build(target, { IPHONEOS_DEPLOYMENT_TARGET: '15.1' });
await mkdir(join(output, 'apple/Artifacts'));
run('xcodebuild', ['-create-xcframework', '-library', join(targetDir, 'aarch64-apple-ios/release/libtbc_signer_kernel.a'), '-headers', join(kernel, 'include'),
  '-library', join(targetDir, 'aarch64-apple-ios-sim/release/libtbc_signer_kernel.a'), '-headers', join(kernel, 'include'), '-output', join(output, 'apple/Artifacts/TbcSignerKernel.xcframework')]);
run('node', [join(kernel, 'scripts/check.mjs'), join(output, 'common-vector-report.json')]);
if (musigEnabled) {
  const actualWasm = join(kernel, 'artifacts/wasm/tbc_signer_kernel.wasm');
  const wasmOutput = text('node', [join(root, 'kernel/scripts/check-musig-wasm.mjs'), actualWasm]);
  const parityOutput = text('node', [join(root, 'kernel/scripts/check-musig-abi-parity.mjs'), join(kernel, 'artifacts/native', host), actualWasm]);
  await writeFile(join(output, 'musig-wasm-report.json'), wasmOutput);
  await writeFile(join(output, 'musig-parity-location.json'), parityOutput);
}

// Preserve dependency notices; manifest license declarations alone are not legal clearance.
const metadata = JSON.parse(text('cargo', ['metadata', '--locked', '--offline', '--format-version', '1', '--filter-platform', host, '--manifest-path', manifest]));
const dependencies = [];
for (const pkg of metadata.packages.filter(p => p.name !== 'tbc-signer-kernel')) {
  const directory = dirname(pkg.manifest_path), notices = [];
  for (const file of await readdir(directory)) if (/^(LICENSE|COPYING|NOTICE)/i.test(file)) {
    await copy(join(directory, file), join(output, 'notices', `${pkg.name}-${pkg.version}`, file)); notices.push(file);
  }
  dependencies.push({ name: pkg.name, version: pkg.version, license: pkg.license, source: pkg.source, notices });
}
const artifacts = { ...Object.fromEntries(Object.entries(await hashes(join(kernel, 'artifacts'))).map(([p, h]) => [`kernel/artifacts/${p}`, h])),
  ...Object.fromEntries(Object.entries(await hashes(join(output, 'apple/Artifacts'))).map(([p, h]) => [`apple/Artifacts/${p}`, h])) };
const identity = { sdkVersion: extension.sdkVersion, extension, abiVersion: 1, musigEnabled, hostDeploymentTarget: '15.0', status: 'LOCAL_UNPUBLISHED',
  artifactSetId: hash(JSON.stringify({ sourceHashes, artifacts })), sourceHashes, artifacts,
  rustc, ndkVersion: '27.1.12297006', androidAbis: ['arm64-v8a', 'armeabi-v7a', 'x86_64'],
  sourceCommit: imported.sourceCommit, engineDependency: false, walletRepositoryBuildDependency: false,
  dependencies, releaseBlockers: ['Origin and dependency license/notice review', 'Production custody/approval integration and physical-device validation'] };
for (const p of ['identity.json', 'android/identity.json']) await writeFile(join(output, p), JSON.stringify(identity, null, 2) + '\n');
const vectorReport = JSON.parse(await readFile(join(output, 'common-vector-report.json')));
console.log(JSON.stringify({ output, artifactSetId: identity.artifactSetId, commonVectors: vectorReport.totalChecks, unpublished: true }));
