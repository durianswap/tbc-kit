// Strict inventory for the exact paired Flutter package, not a Kit support claim.
// Run after Kit has been built; source and dist intent lists must agree.
import assert from 'node:assert/strict';
import {readFile, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve, join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {verifyPortablePlugin} from './portable-plugin.mjs';

const [packageArg, outputArg, ...evidenceArgs] = process.argv.slice(2);
assert.ok(packageArg && outputArg && [0, 3, 4, 5, 6, 7, 8, 9].includes(evidenceArgs.length),
  'PAIRED_PACKAGE NEW_REPORT_JSON [POSITIVE SAFETY API23 [TRANSFER [PREPARED [ROLES [REVIEWED_ROLES [CRYPTO [METHOD_SURFACE]]]]]]]');
const [positiveDir, safetyDir, api23Dir, transferDir, preparedDir, rolesDir, reviewedRolesDir, cryptoDir, methodSurfaceDir] = evidenceArgs.length ? evidenceArgs : [
  'portable-wallet-pair-parity-2026-10-08-a',
  'portable-wallet-safety-parity-2026-10-08-c',
  'portable-wallet-api23-failure-2026-10-08-a',
];
for (const name of [positiveDir, safetyDir, api23Dir, transferDir, preparedDir, rolesDir, reviewedRolesDir, cryptoDir, methodSurfaceDir].filter(Boolean))
  assert.match(name, /^[a-z0-9-]+$/, 'Evidence directory must be a local basename');
const root = resolve(import.meta.dirname, '../../..');
const packageRoot = resolve(packageArg), output = resolve(outputArg);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const paired = await verifyPortablePlugin(packageRoot);
const iosProvenance = JSON.parse(await readFile(join(packageRoot, 'provenance/ios-runtime.json')));
const androidProvenance = JSON.parse(await readFile(join(packageRoot, 'provenance/android-runtime.json')));
assert.deepEqual(iosProvenance.kitIdentity, androidProvenance.kitIdentity,
  'Paired platforms must use one Kit identity');
const currentKitVersion = JSON.parse(await readFile(join(root, 'packages/kit/package.json'))).version;
const methodsRegistry = JSON.parse(await readFile(join(root, 'registry/methods.json')));
const methods = methodsRegistry.methods.map(row => row.name);
assert.equal(new Set(methods).size, methods.length);
const source = await readFile(join(root, 'packages/kit/src/business-capabilities.ts'), 'utf8');
const section = /TBC_KIT_WALLET_INTENTS = Object\.freeze\(\[([\s\S]*?)\] as const/.exec(source);
assert.ok(section, 'Kit source intent inventory not found');
const sourceIntents = [...section[1].matchAll(/"([^"]+)"/g)].map(match => match[1]);
const compiled = await import(pathToFileURL(join(root, 'packages/kit/dist/esm/business-capabilities.js')));
assert.deepEqual([...compiled.TBC_KIT_WALLET_INTENTS], sourceIntents,
  'Compiled Kit capability inventory differs from source');
assert.equal(new Set(sourceIntents).size, sourceIntents.length);

const evidenceDir = join(root, 'native/flutter-compat');
const readEvidence = async path => JSON.parse(await readFile(join(evidenceDir, path, 'evidence.json')));
const positive = await readEvidence(positiveDir);
const negative = await readEvidence(safetyDir);
const api23 = await readEvidence(api23Dir);
const transfer = transferDir ? await readEvidence(transferDir) : null;
const prepared = preparedDir ? await readEvidence(preparedDir) : null;
const roles = rolesDir ? await readEvidence(rolesDir) : null;
const reviewedRoles = reviewedRolesDir ? await readEvidence(reviewedRolesDir) : null;
const crypto = cryptoDir ? await readEvidence(cryptoDir) : null;
const methodSurface = methodSurfaceDir ? await readEvidence(methodSurfaceDir) : null;
assert.equal(positive.status, 'PASS_PUBLIC_MUSIG_PAIR_DEVICE_SEMANTIC_PARITY');
assert.equal(negative.status, 'PASS_PUBLIC_MUSIG_PAIR_SAFETY_DEVICE_PARITY');
assert.equal(api23.status, 'FAIL_PORTABLE_API23_WEBVIEW_SETUP');
if (transfer) {
  assert.equal(transfer.status, 'PASS_PUBLIC_FACADE_TRANSACTION_DEVICE_PARITY');
  assert.ok(transfer.cases.includes('transaction'));
  assert.ok(transfer.cases.includes('transaction-reject'));
  assert.equal(transfer.independentCheck.ecdsa, true);
  assert.equal(transfer.independentCheck.tbcHeaderHash, true);
  assert.equal(transfer.independentCheck.realChain, false);
}
if (prepared) {
  assert.equal(prepared.status, 'PASS_PUBLIC_FACADE_PREPARED_DEVICE_PARITY');
  assert.deepEqual(prepared.preparedCheck.successes, ['valid', 'workflow']);
  assert.equal(prepared.preparedCheck.expiredAndTamperedRejected, true);
  assert.equal(prepared.preparedCheck.independentEcdsa, true);
  assert.equal(prepared.preparedCheck.proposalHashChecked, true);
  assert.equal(prepared.preparedCheck.realChain, false);
}
if (roles) {
  assert.equal(roles.status, 'PASS_PUBLIC_FACADE_ROLES_DEVICE_PARITY');
  assert.deepEqual(roles.roleChecks.map(c => [c.role, c.signatures, c.transactions]),
    [['coin-admin', 4, 2], ['pool-controller', 3, 1]]);
  assert.equal(roles.realChain, false);
}
if (reviewedRoles) {
  assert.equal(reviewedRoles.status, 'PASS_PUBLIC_REVIEWED_ROLE_DEVICE_PARITY');
  assert.equal(reviewedRoles.independentCheck.cases.length, 6);
  assert.deepEqual(reviewedRoles.independentCheck.cases.map(c => [c.profile, c.id]), [
    ['schnorr', 'raw-single'], ['schnorr', 'raw-workflow'],
    ['schnorr', 'associated-single'], ['schnorr', 'associated-workflow'],
    ['ecdsa', 'raw-single'], ['ecdsa', 'raw-workflow'],
  ]);
  assert.ok(reviewedRoles.independentCheck.cases
    .filter(c => c.id.startsWith('associated')).every(c => c.associatedScriptVmInputs > 0));
  assert.equal(reviewedRoles.realChain, false);
}
if (crypto) {
  assert.equal(crypto.status, 'PASS_PUBLIC_FACADE_CRYPTO_DEVICE_PARITY');
  assert.equal(crypto.cryptoChecks.status, 'PASS_PUBLIC_CRYPTO_INDEPENDENT');
  assert.equal(crypto.cryptoChecks.independentBie1AuthenticationAndDecryption, true);
  assert.equal(crypto.cryptoChecks.nativeCryptoCalls, 5);
  assert.equal(crypto.realChain, false);
}
if (methodSurface) {
  assert.equal(methodSurface.status, 'PASS_PUBLIC_FACADE_METHOD_SURFACE_DEVICE_PARITY');
  assert.equal(methodSurface.independentCheck.status, 'PASS_PUBLIC_METHOD_SURFACE_INDEPENDENT');
  assert.equal(methodSurface.independentCheck.independentlyCheckedSignatures, 2);
  assert.deepEqual(methodSurface.positiveMethods, ['tbc_chainId', 'tbc_accounts',
    'tbc_requestAccounts', 'tbc_getAccount', 'tbc_getCapabilities',
    'wallet_getPermissions', 'wallet_requestPermissions', 'tbc_signMessage',
    'tbc_signTypedData', 'tbc_disconnect']);
  assert.equal(methodSurface.realChain, false);
}
const manifestSha256 = sha(await readFile(join(packageRoot, 'portable-artifacts.json')));
for (const e of [positive, negative, api23, transfer, prepared, roles, reviewedRoles, crypto, methodSurface].filter(Boolean)) {
  assert.equal(e.portablePackage.manifestSha256, manifestSha256);
  assert.equal(e.portablePackage.fileCount, Object.keys(paired.files).length);
  assert.equal(e.portablePackage.exactVendoredBytes, true);
}
assert.equal(positive.realChain, false);
assert.equal(negative.realChain, false);
assert.equal(api23.realChain, false);
if (transfer) assert.equal(transfer.realChain, false);
if (prepared) assert.equal(prepared.realChain, false);
if (roles) assert.equal(roles.realChain, false);
if (reviewedRoles) assert.equal(reviewedRoles.realChain, false);
if (crypto) assert.equal(crypto.realChain, false);
if (methodSurface) assert.equal(methodSurface.realChain, false);
assert.equal(api23.osApi, 23);

// Positive pair fixture requests one permission grant and one associated
// tbc_signWorkflow. Its discovery and signer internals are not separate proof
// for every other public method or every business intent.
const provenMethods = new Map([
  ['wallet_requestPermissions', positiveDir],
  ['tbc_signWorkflow', positiveDir],
  ...(transfer ? [['tbc_signTransaction', transferDir]] : []),
  ...(prepared ? [['tbc_signPreparedTransaction', preparedDir],
    ['tbc_signPreparedWorkflow', preparedDir]] : []),
  ...(reviewedRoles ? [['tbc_signReviewedTransaction', reviewedRolesDir]] : []),
  ...(crypto ? [['tbc_encrypt', cryptoDir], ['tbc_decrypt', cryptoDir]] : []),
  ...(methodSurface ? methodSurface.positiveMethods
    .filter(name => name !== 'wallet_requestPermissions')
    .map(name => [name, methodSurfaceDir]) : []),
]);
for (const name of provenMethods.keys()) assert.ok(methods.includes(name), name);
const result = {
  schema: 1,
  scope: 'Current Registry/Kit source inventory versus exact paired Flutter package device evidence; not a declaration that every current source intent ships in the package',
  inventorySource: {registry: 'current-checkout', kitSource: 'current-checkout',
    kitSourcePackageVersion: currentKitVersion},
  pairedKitIdentity: iosProvenance.kitIdentity,
  packageManifestSha256: manifestSha256,
  packageFileCount: Object.keys(paired.files).length,
  registrySha256: sha(await readFile(join(root, 'registry/methods.json'))),
  kitIntentSourceSha256: sha(source),
  methodCount: methods.length,
  methods: methods.map(name => ({name,
    pairedDevice: provenMethods.has(name) ? 'controlled-positive' : 'not-proven-for-this-package',
    evidence: provenMethods.get(name) ?? null,
    realChain: false, partnerVault: false})),
  intentCount: sourceIntents.length,
  intents: sourceIntents.map(name => ({name,
    pairedDeviceBusinessLifecycle: transfer && name === 'tbc.transfer' ?
      'controlled-sign-only' : roles && ['tbc20-stablecoin-create', 'tbc-amm-swap'].includes(name) ?
      'controlled-role-sign-only' : 'not-proven-for-this-package',
    evidence: transfer && name === 'tbc.transfer' ? transferDir :
      roles && ['tbc20-stablecoin-create', 'tbc-amm-swap'].includes(name) ? rolesDir : null,
    realChain: false, partnerVault: false})),
  platform: {
    ios26_5: 'controlled-positive-and-safety',
    android36: 'controlled-positive-and-safety',
    android23SystemWebView44: 'fails-closed-at-setup',
    ios13_1: 'not-run',
  },
  evidence: {
    positive: `native/flutter-compat/${positiveDir}/evidence.json`,
    safety: `native/flutter-compat/${safetyDir}/evidence.json`,
    api23: `native/flutter-compat/${api23Dir}/evidence.json`,
    ...(transfer ? {transfer: `native/flutter-compat/${transferDir}/evidence.json`} : {}),
    ...(prepared ? {prepared: `native/flutter-compat/${preparedDir}/evidence.json`} : {}),
    ...(roles ? {roles: `native/flutter-compat/${rolesDir}/evidence.json`} : {}),
    ...(reviewedRoles ? {reviewedRoles: `native/flutter-compat/${reviewedRolesDir}/evidence.json`} : {}),
    ...(crypto ? {crypto: `native/flutter-compat/${cryptoDir}/evidence.json`} : {}),
    ...(methodSurface ? {methodSurface: `native/flutter-compat/${methodSurfaceDir}/evidence.json`} : {}),
  },
  note: 'Other source/device candidates and Kit capabilities have separate evidence; this report deliberately does not inherit it as exact-package acceptance.',
  deliveryReady: false,
  generatorSha256: sha(await readFile(import.meta.filename)),
};
await writeFile(output, JSON.stringify(result, null, 2) + '\n', {flag: 'wx'});
console.log(JSON.stringify({status: 'PARTNER_COVERAGE_REPORTED', methods: methods.length,
  intents: sourceIntents.length, controlledPositiveMethods: provenMethods.size, output}));
