// Assemble one local, non-deliverable Flutter integration preview from an
// immutable paired package and the wallet-owned host template. No rebuilds.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {copyFile, mkdir, readFile, readdir, stat, writeFile} from 'node:fs/promises';
import {basename, dirname, join, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {verifyPortablePlugin} from './portable-plugin.mjs';

const [firstArg, outputArg] = process.argv.slice(2);
const verifyMode = firstArg === '--verify';
assert.ok(firstArg && outputArg && process.argv.length === 4,
  'PAIRED_PORTABLE_PACKAGE NEW_OUTPUT | --verify EXISTING_OUTPUT');
const packageRoot = verifyMode ? null : resolve(firstArg);
const output = resolve(outputArg);
assert.notEqual(output, packageRoot);
const exampleRoot = fileURLToPath(new URL('../example/', import.meta.url));
if (!verifyMode) {
  assert.ok(!output.startsWith(packageRoot + sep));
  assert.ok(!output.startsWith(exampleRoot + sep));
}
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const excluded = new Set(['build', 'DerivedData', '.dart_tool', '.gradle', '.cxx', 'Pods', 'Podfile.lock', '.symlinks',
  '.idea', '.git', 'node_modules', 'local.properties', 'Generated.xcconfig',
  'flutter_export_environment.sh', 'Flutter.podspec',
  'GeneratedPluginRegistrant.java', 'GeneratedPluginRegistrant.h',
  'GeneratedPluginRegistrant.m', '.flutter-plugins', '.flutter-plugins-dependencies']);
const skip = name => excluded.has(name) || name.endsWith('.iml');

async function copySource(source, target) {
  const info = await stat(source);
  if (info.isDirectory()) {
    await mkdir(target);
    for (const entry of await readdir(source, {withFileTypes: true})) {
      if (skip(entry.name)) continue;
      assert.ok(!entry.isSymbolicLink(), `Non-portable symlink: ${entry.name}`);
      await copySource(join(source, entry.name), join(target, entry.name));
    }
  } else {
    assert.ok(info.isFile());
    await mkdir(dirname(target), {recursive: true});
    await copyFile(source, target);
    if (basename(source) === 'gradlew') {
      const {chmod} = await import('node:fs/promises');
      await chmod(target, 0o755);
    }
  }
}
async function fileHashes(root, relative = '') {
  const result = {};
  for (const entry of (await readdir(join(root, relative), {withFileTypes: true}))
    .sort((a, b) => a.name.localeCompare(b.name))) {
    if (skip(entry.name)) continue;
    assert.ok(!entry.isSymbolicLink());
    const path = join(relative, entry.name);
    if (entry.isDirectory()) Object.assign(result, await fileHashes(root, path));
    else if (entry.isFile()) result[path] = sha(await readFile(join(root, path)));
  }
  return result;
}
function replaceExactlyOnce(source, search, replacement, label) {
  assert.equal(source.split(search).length, 2, `Unexpected ${label} path format`);
  return source.replace(search, replacement);
}

if (verifyMode) {
  const bundle = JSON.parse(await readFile(join(output, 'handoff-preview.json')));
  assert.equal(bundle.schema, 1);
  assert.equal(bundle.status, 'PREVIEW_NOT_DELIVERABLE');
  assert.equal(bundle.deliveryReady, false);
  const actual = await fileHashes(output);
  delete actual['handoff-preview.json'];
  assert.deepEqual(actual, bundle.files, 'Preview source bytes changed');
  const packageBytes = await readFile(join(output, 'tbc_kit_flutter/portable-artifacts.json'));
  assert.equal(sha(packageBytes), bundle.pairedManifestSha256);
  const paired = await verifyPortablePlugin(join(output, 'tbc_kit_flutter'), {requirePathClean: true});
  assert.deepEqual(paired.kitIdentity, bundle.kitIdentity);
  console.log(JSON.stringify({status: 'PASS_PARTNER_PREVIEW_BYTES', output,
    files: Object.keys(actual).length, pairedManifestSha256: bundle.pairedManifestSha256}));
  process.exit(0);
}

const paired = await verifyPortablePlugin(packageRoot, {requirePathClean: true});
assert.equal(paired.deliveryReady, false, 'Only a local preview may be assembled');
// mkdir without recursive deliberately refuses an existing output.
await mkdir(output);
await copySource(packageRoot, join(output, 'tbc_kit_flutter'));
await copySource(exampleRoot, join(output, 'example'));
const example = join(output, 'example');
const spec = await readFile(join(example, 'pubspec.yaml'), 'utf8');
await writeFile(join(example, 'pubspec.yaml'), replaceExactlyOnce(spec,
  '    path: ..\n', '    path: ../tbc_kit_flutter\n', 'example pubspec'));
const lock = await readFile(join(example, 'pubspec.lock'), 'utf8');
await writeFile(join(example, 'pubspec.lock'), replaceExactlyOnce(lock,
  '      path: ".."\n', '      path: "../tbc_kit_flutter"\n', 'example lock'));
await writeFile(join(example, 'README.md'),
  '# TBC Flutter partner preview\n\n' +
  'This is a compile-only wallet host template, not a funded or release-ready wallet.\n' +
  'The `tbc_kit_flutter` path dependency points to the adjacent, manifest-verified paired package.\n' +
  'Use Flutter 3.29.3 / Dart 3.7.2; run `flutter pub get --offline` and `flutter analyze` here.\n' +
  'For Android builds use JDK 17 with the included Gradle 8.10.2 wrapper.\n' +
  'Check `flutter doctor -v`: Flutter may prefer Android Studio JDK over `JAVA_HOME`.\n' +
  'If needed, run `flutter config --jdk-dir <JDK_17_HOME>` in your local SDK,\n' +
  'or invoke `example/android/gradlew -Dorg.gradle.java.home=<JDK_17_HOME> assembleDebug`.\n' +
  'Never commit a developer-specific JDK path into this package or example.\n' +
  'The bundled TBC native libraries currently support arm64-v8a only; other ABIs are not accepted.\n' +
  'The bundled iOS Simulator XCFramework slice is arm64 only. On Apple Silicon,\n' +
  'build the generated ios/Runner.xcworkspace with ARCHS=arm64,\n' +
  'ONLY_ACTIVE_ARCH=YES and CODE_SIGNING_ALLOWED=NO for a simulator smoke build.\n' +
  'A generic Flutter simulator build may select x86_64 and cannot link this slice.\n' +
  'Implement `PartnerWalletHost` with your own Vault, account, review UI, protected stores,\n' +
  'native invalidation and HTTPS WebView policy before using the view.\n' +
  'Android API 23 needs a feature-compatible WebView; WebView 44 is unsupported.\n' +
  'The wallet app targets iOS 15.0+; exact-version device runtime remains unverified.\n');
await verifyPortablePlugin(join(output, 'tbc_kit_flutter'), {requirePathClean: true});
const sourceManifest = await readFile(join(packageRoot, 'portable-artifacts.json'));
const bundle = {
  schema: 1,
  status: 'PREVIEW_NOT_DELIVERABLE',
  deliveryReady: false,
  pairedManifestSha256: sha(sourceManifest),
  kitIdentity: paired.kitIdentity,
  constraints: ['No production Vault', 'Android API 23 with compatible WebView not accepted',
    'Android API 23 WebView 44 unsupported', 'iOS 15.0 device runtime not accepted',
    'Full business matrix and Release not accepted'],
  files: await fileHashes(output),
};
await writeFile(join(output, 'handoff-preview.json'), JSON.stringify(bundle, null, 2) + '\n');
console.log(JSON.stringify({status: bundle.status, output, files: Object.keys(bundle.files).length,
  pairedManifestSha256: bundle.pairedManifestSha256}));
