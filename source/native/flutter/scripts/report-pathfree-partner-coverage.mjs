// Candidate-specific, conservative coverage. Never inherit an older paired
// package's device evidence, even if its Kit protocol fingerprint matches.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {verifyPortablePlugin} from './portable-plugin.mjs';

const [packageArg, outputArg] = process.argv.slice(2);
assert.ok(packageArg && outputArg,
  'PAIRED_PACKAGE NEW_REPORT_JSON');
const packageRoot = resolve(packageArg);
const output = resolve(outputArg);
const root = resolve(import.meta.dirname, '../../..');
const evidenceRoot = join(root, 'native/flutter-compat');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const paired = await verifyPortablePlugin(packageRoot);
const manifestBytes = await readFile(join(packageRoot, 'portable-artifacts.json'));
const manifestSha256 = sha(manifestBytes);
assert.equal(manifestSha256,
  '0cdda415500081ea5c8ecf25a5b770b9ce6490302b7dccebc77ed9de892969f9',
  'This report applies to the exact path-free paired package only');
const manifest = JSON.parse(manifestBytes);
const sources = {
  transaction: 'pathfree-paired-transaction-parity-2026-10-08-b',
  prepared: 'pathfree-paired-prepared-parity-2026-10-08-b',
  send: 'pathfree-paired-send-parity-2026-10-08-c',
  workflowSend: 'pathfree-paired-workflow-send-parity-2026-10-08-e',
  preparedSend: 'pathfree-paired-prepared-send-parity-2026-10-08-f',
  preparedWorkflowSend: 'pathfree-paired-prepared-workflow-send-parity-2026-10-08-g',
  signOnly: 'real-testnet-signonly-2026-10-08-a',
  iosSend: 'real-testnet-ios-send-2026-10-08-a',
  androidSend: 'real-testnet-android-send-2026-10-08-a',
};
const requiredStatus = {
  transaction: 'PASS_PUBLIC_FACADE_TRANSACTION_DEVICE_PARITY',
  prepared: 'PASS_PUBLIC_FACADE_PREPARED_DEVICE_PARITY',
  send: 'PASS_PORTABLE_SEND_IOS_ANDROID_CONTROLLED_PARITY',
  workflowSend: 'PASS_PORTABLE_WORKFLOW_SEND_IOS_ANDROID_CONTROLLED_PARITY',
  preparedSend: 'PASS_PORTABLE_PREPARED_SEND_IOS_ANDROID_CONTROLLED_PARITY',
  preparedWorkflowSend: 'PASS_PORTABLE_PREPARED_WORKFLOW_SEND_IOS_ANDROID_CONTROLLED_PARITY',
  signOnly: 'PASS_DUAL_PLATFORM_TESTNET_ACCOUNT_SIGN_ONLY_NO_POST',
  iosSend: 'FLUTTER_IOS_REAL_TESTNET_SEND_CONFIRMED',
  androidSend: 'FLUTTER_ANDROID_REAL_TESTNET_SEND_CONFIRMED',
};
const evidence = {};
for (const [key, dir] of Object.entries(sources)) {
  const record = JSON.parse(await readFile(join(evidenceRoot, dir, 'evidence.json')));
  assert.equal(record.status, requiredStatus[key], `${dir}: status changed`);
  const identities = [
    record.portablePackage?.manifestSha256,
    record.pairedManifestSha256,
    record.pairedPackageManifestSha256,
    record.ios?.pairedManifestSha256,
    record.android?.pairedManifestSha256,
  ].filter(Boolean);
  assert.ok(identities.length > 0 &&
    identities.every(identity => identity === manifestSha256),
    `${dir}: evidence belongs to a different package`);
  evidence[key] = {
    path: `native/flutter-compat/${dir}/evidence.json`,
    sha256: sha(await readFile(join(evidenceRoot, dir, 'evidence.json'))),
    status: record.status,
  };
}
assert.equal(paired.files && Object.keys(paired.files).length, 138);
assert.equal(manifest.kitIdentity.protocolFingerprint,
  '06e72b2cfa9fa249b2e1b386d68afb0600af9562555e988722129ff3fcb22a28');
const registryBytes = await readFile(join(root, 'registry/methods.json'));
const methods = JSON.parse(registryBytes).methods.map(row => row.name);
const intentSource = await readFile(join(root, 'packages/kit/src/business-capabilities.ts'), 'utf8');
const section = /TBC_KIT_WALLET_INTENTS = Object\.freeze\(\[([\s\S]*?)\] as const/.exec(intentSource);
assert.ok(section, 'Current Kit intent inventory missing');
const intents = [...section[1].matchAll(/"([^"]+)"/g)].map(match => match[1]);
assert.equal(new Set(methods).size, methods.length);
assert.equal(new Set(intents).size, intents.length);

// Each entry proves only the named method and vector. It does not imply all
// business variants or a partner-supplied Vault are accepted.
const controlled = new Map([
  ['wallet_requestPermissions', 'transaction'],
  ['tbc_disconnect', 'transaction'],
  ['tbc_signMessage', 'signOnly'],
  ['tbc_signTransaction', 'transaction'],
  ['tbc_signWorkflow', 'prepared'],
  ['tbc_signPreparedTransaction', 'prepared'],
  ['tbc_signPreparedWorkflow', 'prepared'],
  ['tbc_sendTransaction', 'send'],
  ['tbc_sendWorkflow', 'workflowSend'],
  ['tbc_sendPreparedTransaction', 'preparedSend'],
  ['tbc_sendPreparedWorkflow', 'preparedWorkflowSend'],
]);
for (const method of controlled.keys()) assert.ok(methods.includes(method));
assert.ok(intents.includes('tbc.transfer'));
const report = {
  schema: 1,
  scope: 'Exact paired Flutter package and independent iOS26.5/Android36 Debug Apps; proof is method/vector-specific',
  packageManifestSha256: manifestSha256,
  kitIdentity: manifest.kitIdentity,
  packageFileCount: Object.keys(paired.files).length,
  inventory: {
    registrySha256: sha(registryBytes),
    kitSourceSha256: sha(intentSource),
    methodCount: methods.length,
    intentCount: intents.length,
  },
  methods: methods.map(name => ({
    name,
    device: controlled.has(name) ? 'controlled-specific-vector' : 'not-proven-for-exact-package',
    evidence: controlled.has(name) ? evidence[controlled.get(name)].path : null,
    ...(name === 'tbc_sendTransaction' ? {
      realTestnet: {
        profile: 'tbc.transfer',
        ios: 'confirmed', android: 'confirmed',
        evidence: [evidence.iosSend.path, evidence.androidSend.path],
      },
    } : {}),
    partnerVault: false,
  })),
  intents: intents.map(name => ({
    name,
    exactPackageRealTestnet: name === 'tbc.transfer' ?
      'ios-and-android-confirmed' : 'not-proven',
    partnerVault: false,
  })),
  platformLimits: {
    android23SystemWebView44: 'secure-bridge-setup-rejected',
    ios13_1WholeApp: 'not-proven-on-installed-Xcode-27',
    releaseAot: 'not-built-on-this-Apple-Silicon-host-without-Rosetta',
    physicalDevices: 'not-run',
  },
  evidence,
  deliveryReady: false,
};
await writeFile(output, JSON.stringify(report, null, 2) + '\n', {flag: 'wx'});
console.log(JSON.stringify({status: 'EXACT_PACKAGE_COVERAGE_REPORTED',
  methods: methods.length, controlledMethods: controlled.size,
  intents: intents.length, output}));
