// Read-only verification of the isolated, synthetic RN probe; saves new evidence only.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const [appArg, sdkArg, iosId, adbArg, serial, archiveArg] = process.argv.slice(2);
assert.ok(appArg && sdkArg && iosId === 'C2C010B8-4071-4888-9E25-D91BF88EB461' && adbArg && serial === 'emulator-5554',
  'Use independent probe on Kit Latest and emulator-5554 only');
const app = resolve(appArg), sdk = resolve(sdkArg), adb = resolve(adbArg);
const sha = b => createHash('sha256').update(b).digest('hex');
const json = async p => JSON.parse(await readFile(p));
const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
const installedMode = Boolean(archiveArg);
const lp227 = installedMode && (await json(join(app, 'package.json'))).name === 'tbc227-rn-keyless-probe';
const candidate = lp227 ? '227' : installedMode ? '225' : '224';
const out = await mkdtemp(join(tmpdir(), `tbc-rn-keyless${candidate}-evidence-`));
const bundleId = `org.tbc.kit.keyless${candidate}probe`;
assert.equal((await json(join(app, 'package.json'))).name, `tbc${candidate}-rn-keyless-probe`);
const proof = await json(join(app, 'probe-provenance.json'));
const identity = await json(join(app, 'modules/tbc-kit-engine/generated/identity.json'));
assert.equal(identity.artifactSetId, (await json(join(sdk, 'identity.json'))).artifactSetId);
run(process.execPath, [join(app, 'modules/tbc-kit-engine/scripts/sync-native.mjs'), '--check']);
for (const [file, hash] of Object.entries(proof.templateHashes)) {
  assert.equal(sha(await readFile(join(app, 'modules/tbc-kit-engine', file))), hash);
}
assert.equal(sha(await readFile(join(app, 'App.tsx'))), proof.appSourceSha256);
assert.equal(sha(await readFile(join(app, 'vectors.json'))), proof.coreVectorsSha256);
assert.equal(sha(await readFile(join(app, 'keyless-vectors.json'))), proof.keylessVectorsSha256);
const repo = resolve(import.meta.dirname, '../../../..');
assert.equal(identity.kitVersion, lp227 ? '0.1.0-candidate.227' : installedMode ? '0.1.0-candidate.225' : '0.1.0-candidate.224');
assert.equal(proof.templatePatch, installedMode ? `none-installed${candidate}` : '4KP-not-frozen224');
const archive = installedMode ? resolve(archiveArg) : join(repo, 'native/engine/delivery/candidate224/tbc-kit-0.1.0-candidate.224.tgz');
assert.equal(sha(await readFile(archive)), proof.kitSha256);
assert.equal(proof.kitSha256, lp227 ? '28adf7f9f36590812e0fe864a14b3a326f2c340b5a7f12bb2b6169f10ff64424' : installedMode ? '0505dc865db6604403994121a8da14f014381a25e0bfb63cd1025b6a937c46c4' : 'aabd2d0506e567ca8773c754d0b1f70614d8c7541f010dd0689bda937cd85079');
run('tar', ['-xzf', archive, '-C', out]);
let installedFiles = 0;
async function compare(prefix = '') {
  for (const entry of await readdir(join(out, 'package', prefix), { withFileTypes: true })) {
    const file = join(prefix, entry.name);
    if (entry.isDirectory()) await compare(file);
    else if (entry.isFile()) {
      assert.equal(sha(await readFile(join(out, 'package', file))),
        sha(await readFile(join(app, 'node_modules/@tbc/kit', file))), file);
      installedFiles++;
    }
  }
}
await compare();
if (installedMode) for (const [file, hash] of Object.entries(proof.templateHashes)) {
  assert.equal(sha(await readFile(join(out, 'package/examples/react-native-engine/module', file))), hash);
}
const data = run('xcrun', ['simctl', 'get_app_container', iosId, bundleId, 'data']).trim();
const ios = await json(join(data, 'Documents/keyless-rn-report.json'));
const pid = run(adb, ['-s', serial, 'shell', 'pidof', bundleId]).trim();
assert.match(pid, /^\d+$/);
const logs = run(adb, ['-s', serial, 'logcat', '--pid=' + pid, '-d', '-s', 'ReactNativeJS:I']);
const rows = logs.split('\n').filter(l => l.includes('TBC_KEYLESS_RN_PROBE_PASS'));
assert.ok(rows.length, 'No PASS from the currently running isolated Android process');
const android = JSON.parse(rows.at(-1).slice(rows.at(-1).indexOf('{')));
await writeFile(join(out, 'android-runtime.log'), logs);
for (const [platform, report] of Object.entries({ ios, android })) {
  assert.equal(report.marker, 'TBC_KEYLESS_RN_PROBE_PASS');
  assert.equal(report.platform, platform);
  assert.equal(report.hermes, true);
  assert.deepEqual(report.identity, identity);
  assert.deepEqual(report.proof, proof);
  assert.equal(report.engineVectors, 8); assert.equal(report.keylessVectors, lp227 ? 39 : 18);
  assert.equal(report.keylessPositive, lp227 ? 22 : 8); assert.equal(report.keylessErrorRejections, lp227 ? 17 : 10);
  assert.equal(report.operations, 10); assert.equal(report.concurrent, 16);
  assert.equal(report.nativeUnsupportedRejected, true);
  assert.equal(report.fetches, 0); assert.equal(report.broadcasts, 0);
  await writeFile(join(out, platform + '-runtime.json'), JSON.stringify(report, null, 2) + '\n');
}
const builtIos = join(app, 'DerivedData/Build/Products/Release-iphonesimulator/TBCKeylessRNProbe.app');
const installedIos = run('xcrun', ['simctl', 'get_app_container', iosId, bundleId, 'app']).trim();
const iosHashes = {};
for (const file of ['TBCKeylessRNProbe', 'main.jsbundle']) {
  iosHashes[file] = sha(await readFile(join(builtIos, file)));
  assert.equal(sha(await readFile(join(installedIos, file))), iosHashes[file]);
}
const apk = join(app, 'android/app/build/outputs/apk/release/app-release.apk');
const apkSha256 = sha(await readFile(apk));
const installedApk = run(adb, ['-s', serial, 'shell', 'pm', 'path', bundleId]).trim();
assert.match(installedApk, /^package:\/data\/app\/[^\n]+\/base\.apk$/);
run(adb, ['-s', serial, 'pull', installedApk.slice(8), join(out, 'installed-base.apk')]);
assert.equal(sha(await readFile(join(out, 'installed-base.apk'))), apkSha256);
const report = { status: installedMode ? 'PASS_INSTALLED_RN_HERMES_BOTH' : 'PASS_PATCHED_TEMPLATE_RN_HERMES_BOTH', candidate: identity.kitVersion,
  templatePatch: installedMode ? `none-installed${candidate}` : '4KP-not-yet-packed', proof, identity, installedFiles,
  ios: { udid: iosId, hashes: iosHashes, report: 'ios-runtime.json', elapsedMs: ios.elapsedMs },
  android: { serial, pid, apkSha256, report: 'android-runtime.json', elapsedMs: android.elapsedMs },
  sdkUnchanged: true, mobileChanged: false, protected113And143Changed: false,
  actualWalletCustody: false, actualChain: false, candidateDeliveryComplete: false,
  limitations: [...(installedMode ? [] : ['Patched repository Expo template, not unchanged224 template']), 'Synthetic compute bridge, no wallet workflow/UI or real custody', 'Not physical-device or all-ABI coverage', 'Probe timing is not transaction latency'], out };
await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ out, status: report.status, installedFiles, apkSha256, iosHashes }));
