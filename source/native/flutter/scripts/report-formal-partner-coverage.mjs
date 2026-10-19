// Conservative inventory for one exact paired Flutter preview. Never inherit
// device or chain evidence from an older package with the same Kit identity.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {verifyPortablePlugin} from './portable-plugin.mjs';

const [packageArg, kitArg, outputArg] = process.argv.slice(2);
assert.ok(packageArg && kitArg && outputArg && process.argv.length === 5,
  'EXACT_PAIRED_PACKAGE EXACT_KIT_PACKAGE NEW_REPORT_JSON');
const root = resolve(import.meta.dirname, '../../..');
const pairedRoot = resolve(packageArg);
const kitRoot = resolve(kitArg);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const paired = await verifyPortablePlugin(pairedRoot, {requirePathClean: true});
const manifestBytes = await readFile(join(pairedRoot, 'portable-artifacts.json'));
const manifestSha256 = sha(manifestBytes);
assert.equal(manifestSha256,
  'dc9b5334acec325afcd18b50152bd0c7366287512c470f421cf3b612eed6d7fe',
  'This report is only for the formal paired candidate');
assert.equal(Object.keys(paired.files).length, 138);
const kitCandidateBytes = await readFile(join(kitRoot, 'artifacts/flutter-kit-candidate.json'));
const kitCandidate = JSON.parse(kitCandidateBytes);
assert.equal(sha(kitCandidateBytes), paired.kitIdentity.manifestSha256);
for (const field of ['artifactId', 'version', 'protocolFingerprint', 'rustSourceSha256']) {
  assert.equal(kitCandidate[field], paired.kitIdentity[field]);
}
const kitBusinessBytes = await readFile(join(kitRoot, 'dist/esm/business-capabilities.js'));
assert.equal(sha(kitBusinessBytes), kitCandidate.files['dist/esm/business-capabilities.js']);

const evidenceNames = {
  ios: 'pathfree-formal-webview-ios-2026-10-08-a',
  android: 'pathfree-formal-webview-android-2026-10-08-a',
  methodsIos: 'pathfree-formal-method-surface-ios-2026-10-08-a',
  methodsAndroid: 'pathfree-formal-method-surface-android-2026-10-08-a',
  cryptoIos: 'pathfree-formal-crypto-ios-2026-10-08-a',
  cryptoAndroid: 'pathfree-formal-crypto-android-2026-10-08-a',
  preparedIos: 'pathfree-formal-prepared-ios-2026-10-08-a',
  preparedAndroid: 'pathfree-formal-prepared-android-2026-10-08-a',
  reviewedIos: 'pathfree-formal-reviewed-ios-2026-10-08-a',
  reviewedAndroid: 'pathfree-formal-reviewed-android-2026-10-08-a',
  switchIos: 'pathfree-formal-switch-ios-2026-10-08-a',
  switchAndroid: 'pathfree-formal-switch-android-2026-10-08-a',
  sendIos: 'pathfree-formal-send-ios-2026-10-08-a',
  sendAndroid: 'pathfree-formal-send-android-2026-10-08-a',
  preparedSendIos: 'pathfree-formal-prepared-send-ios-2026-10-08-a',
  preparedSendAndroid: 'pathfree-formal-prepared-send-android-2026-10-08-a',
  workflowSend: 'pathfree-formal-workflow-send-parity-2026-10-08-a',
  preparedWorkflowSend: 'pathfree-formal-prepared-workflow-send-parity-2026-10-08-a',
  recoveryIos: 'pathfree-formal-recovery-ios-2026-10-08-a',
  recoveryAndroid: 'pathfree-formal-recovery-android-2026-10-08-a',
  realTestnetIos: 'formal-pair-real-testnet-ios-2026-10-08-a',
  realTestnetAndroid: 'formal-pair-real-testnet-android-2026-10-08-a',
  ios13Build: 'formal-pair-ios13-build-2026-10-08-a',
  tbc20Material: 'formal-pair-tbc20-material-2026-10-08-a',
  tbc20Ios: 'formal-pair-tbc20-ios-2026-10-08-a',
  tbc20Android: 'formal-pair-tbc20-android-2026-10-08-a',
  tbc20AndroidRelease: 'formal-pair-tbc20-android-release-2026-10-08-b',
  api23: 'pathfree-api23-webview44-failclosed-2026-10-08-a',
};
const evidence = {};
for (const [platform, name] of Object.entries(evidenceNames)) {
  const path = `native/flutter-compat/${name}/evidence.json`;
  const bytes = await readFile(join(root, path));
  evidence[platform] = {path, sha256: sha(bytes), record: JSON.parse(bytes)};
}
const realAndroid = evidence.realTestnetAndroid.record;
assert.equal(realAndroid.status, 'FORMAL_PAIR_ANDROID_TESTNET_SEND_CONFIRMED');
assert.equal(realAndroid.pairedPackageManifestSha256, manifestSha256);
assert.equal(realAndroid.kitArtifactId, paired.kitIdentity.artifactId);
assert.equal(realAndroid.runtimeArtifact, paired.platforms.android.runtimeArtifact);
assert.equal(realAndroid.engineArtifact, paired.platforms.android.engineArtifact);
assert.equal(realAndroid.chainId, 'tbc:testnet');
assert.equal(realAndroid.approvedAtomicAmount, '500');
assert.equal(realAndroid.transaction.recipientAtomic, 500);
assert.ok(realAndroid.transaction.feeAtomic <=
  Number(realAndroid.approvedMaximumFeeAtomic));
assert.equal(realAndroid.transaction.kitParsedTxidMatchesNode, true);
assert.equal(realAndroid.transaction.independentTbcV10HeaderTxidMatchesNode, true);
assert.ok(realAndroid.transaction.nodeConfirmationsAtRead >= 1);
assert.equal(realAndroid.device.newIntentState, 'completed');
assert.equal(realAndroid.device.newResultStatus, 'accepted');
assert.equal(realAndroid.device.restartStatus, 'NO_RESEND_AFTER_RESTART');
assert.equal(realAndroid.device.partnerVault, false);
const realIos = evidence.realTestnetIos.record;
assert.equal(realIos.status, 'FORMAL_PAIR_IOS_TESTNET_SEND_CONFIRMED');
assert.equal(realIos.pairedPackageManifestSha256, manifestSha256);
assert.equal(realIos.kitArtifactId, paired.kitIdentity.artifactId);
assert.equal(realIos.runtimeArtifact, paired.platforms.ios.runtimeArtifact);
assert.equal(realIos.engineArtifact, paired.platforms.ios.engineArtifact);
assert.equal(realIos.chainId, 'tbc:testnet');
assert.equal(realIos.approvedAtomicAmount, '1000');
assert.equal(realIos.transaction.recipientAtomic, 1000);
assert.ok(realIos.transaction.feeAtomic <=
  Number(realIos.approvedMaximumFeeAtomic));
assert.equal(realIos.transaction.kitParsedTxidMatchesNode, true);
assert.equal(realIos.transaction.independentTbcV10HeaderTxidMatchesNode, true);
assert.ok(realIos.transaction.nodeConfirmationsAtRead >= 1);
assert.ok(realIos.transaction.recipientUtxoObservedAtHeight > 0);
assert.equal(realIos.device.firstRunSignatures, 1);
assert.equal(realIos.device.newIntentState, 'completed');
assert.equal(realIos.device.newResultStatus, 'accepted');
assert.equal(realIos.device.restartStatus, 'NO_RESEND_AFTER_RESTART');
assert.equal(realIos.device.oneShotMarkerPresentAfterRestart, true);
assert.equal(realIos.device.partnerVault, false);
for (const [file, expected] of [
  ['first-report.json', realIos.firstReportSha256],
  ['restart-report.json', realIos.restartReportSha256],
]) {
  const reportPath = join(root, 'native/flutter-compat',
    evidenceNames.realTestnetIos, file);
  const bytes = await readFile(reportPath);
  assert.equal(sha(bytes), expected, `iOS ${file} changed`);
  const report = JSON.parse(bytes);
  assert.equal(report.address, realIos.sourceAddress);
  assert.equal(report.network, realIos.chainId);
  assert.equal(report.partnerVault ?? false, false);
  if (file === 'first-report.json') {
    assert.equal(report.txid, realIos.transaction.txid);
    assert.equal(report.signatures, 1);
  } else {
    assert.equal(report.status, 'NO_RESEND_AFTER_RESTART');
    assert.equal(report.journalIntents, realIos.device.intentsAfterRestart);
    assert.equal(report.journalResults, realIos.device.resultsAfterRestart);
  }
}
const ios13 = evidence.ios13Build.record;
assert.equal(ios13.status,
  'IOS_13_1_WHOLE_APP_NOT_VERIFIED_TOOLCHAIN_REJECTED_TARGET');
assert.equal(ios13.pairedPackageManifestSha256, manifestSha256);
assert.equal(ios13.podspecMinimumIos, '13.1');
assert.equal(ios13.buildAttempt.exitCode, 65);
assert.equal(ios13.buildAttempt.deploymentTarget, '13.1');
assert.equal(ios13.buildAttempt.failureStage,
  'Xcode deployment-target validation before source compilation');
assert.equal(sha(await readFile(join(pairedRoot,
  'ios/tbc_kit_flutter.podspec'))), ios13.podspecSha256);
for (const framework of ['TbcFlutterEngine', 'TbcFlutterRuntime',
  'TbcFlutterSigner', 'hermes']) {
  assert.equal(ios13.pairedDeviceFrameworks[framework].minos, '13.1');
  assert.equal(sha(await readFile(join(pairedRoot, 'ios/Frameworks',
    `${framework}.xcframework`, 'ios-arm64', `${framework}.framework`,
    framework))), ios13.pairedDeviceFrameworks[framework].sha256);
}
const tbc20Material = evidence.tbc20Material.record;
assert.equal(tbc20Material.status,
  'PASS_FORMAL_PAIR_TBC20_MATERIAL_SOURCE_ONLY');
assert.equal(tbc20Material.pairedPackageManifestSha256, manifestSha256);
assert.equal(tbc20Material.kitArtifactId, paired.kitIdentity.artifactId);
assert.equal(tbc20Material.kitWalletNodeSha256,
  kitCandidate.files['dist/esm/wallet.node.js']);
assert.equal(tbc20Material.kitApiSha256,
  kitCandidate.files['dist/esm/api.js']);
assert.equal(tbc20Material.rustFixtureSha256,
  sha(await readFile(join(root,
    'packages/tbc-engine/rust/fixtures/tbc20-standard-transfer.json'))));
assert.equal(tbc20Material.intent, 'tbc20-standard-transfer');
assert.equal(tbc20Material.material.parents, 2);
assert.deepEqual(tbc20Material.material.repeatReads,
  ['ft-index', 'native-index']);
assert.equal(tbc20Material.material.tamperedAncestorRejectedByExactPackageTxidParser,
  true);
assert.equal(tbc20Material.device, false);
assert.equal(tbc20Material.realChain, false);
const tbc20Fixture = JSON.parse(await readFile(join(root,
  'packages/tbc-engine/rust/fixtures/tbc20-standard-transfer.json')));
for (const platform of ['ios', 'android']) {
  const item = evidence[platform === 'ios' ? 'tbc20Ios' : 'tbc20Android'];
  const record = item.record;
  assert.equal(record.status,
    `PASS_FORMAL_PAIR_TBC20_SIGN_${platform.toUpperCase()}_CONTROLLED`);
  assert.equal(record.platform, platform);
  assert.equal(record.pairedPackageManifestSha256, manifestSha256);
  assert.equal(record.kitArtifactId, paired.kitIdentity.artifactId);
  assert.equal(record.rustFixtureSha256, tbc20Material.rustFixtureSha256);
  assert.equal(record.runtimeArtifact, paired.platforms[platform].runtimeArtifact);
  assert.equal(record.engineArtifact, paired.platforms[platform].engineArtifact);
  assert.equal(record.intent, 'tbc20-standard-transfer');
  assert.equal(record.signedTxid, tbc20Fixture.stages[2].txid);
  assert.equal(record.exactRustSignedRawMatch, true);
  assert.equal(record.kitParsedTxidMatch, true);
  assert.equal(record.postAttempts, 0);
  assert.equal(record.journalIntents, 0);
  assert.equal(record.realChain, false);
  assert.equal(record.partnerVault, false);
  const reportBytes = await readFile(join(root,
    item.path.replace('evidence.json', 'report.json')));
  assert.equal(sha(reportBytes), record.reportSha256);
  const device = JSON.parse(reportBytes);
  assert.equal(device.status,
    'PASS_PUBLIC_WALLET_TBC20_SIGN_DEVICE_CONTROLLED');
  assert.equal(device.signedTransaction.transactions[0].rawTransaction,
    tbc20Fixture.stages[2].signedRaw);
  assert.equal(device.postAttempts, 0);
  assert.equal(device.journalIntents, 0);
}
const tbc20Release = evidence.tbc20AndroidRelease.record;
assert.equal(tbc20Release.status,
  'PASS_FORMAL_PAIR_TBC20_SIGN_ANDROID_RELEASE_AOT_CONTROLLED');
assert.equal(tbc20Release.pairedPackageManifestSha256, manifestSha256);
assert.equal(tbc20Release.kitArtifactId, paired.kitIdentity.artifactId);
assert.equal(tbc20Release.runtimeArtifact,
  paired.platforms.android.runtimeArtifact);
assert.equal(tbc20Release.engineArtifact,
  paired.platforms.android.engineArtifact);
assert.equal(tbc20Release.signedTxid, tbc20Fixture.stages[2].txid);
assert.equal(tbc20Release.exactRustSignedRawMatch, true);
assert.equal(tbc20Release.postAttempts, 0);
assert.equal(tbc20Release.journalIntents, 0);
assert.equal(tbc20Release.realChain, false);
assert.equal(tbc20Release.partnerVault, false);
assert.equal(tbc20Release.releaseFixture.testSignedWithDebugCertificate, true);
assert.equal(tbc20Release.releaseFixture.appSideR8AnnotationWorkaround, true);
assert.equal(tbc20Release.releaseFixture.mainManifestInternetPermission, true);
assert.equal(tbc20Release.releaseFixture.frozenPackageConsumerRuleUpdated, false);
assert.equal(tbc20Release.releaseFixture.minSdk, 23);
assert.equal(tbc20Release.releaseFixture.abi, 'arm64-v8a');
assert.match(tbc20Release.releaseFixture.certificateSha256, /^[0-9a-f]{64}$/u);
const tbc20ReleaseReport = await readFile(join(root,
  evidence.tbc20AndroidRelease.path.replace('evidence.json', 'report.json')));
assert.equal(sha(tbc20ReleaseReport), tbc20Release.reportSha256);
assert.equal(JSON.parse(tbc20ReleaseReport).signedTransaction.transactions[0].rawTransaction,
  tbc20Fixture.stages[2].signedRaw);
for (const platform of ['ios', 'android']) {
  const record = evidence[platform].record;
  assert.equal(record.status,
    `PASS_FORMAL_FLUTTER_WEBVIEW_${platform.toUpperCase()}_CONTROLLED`);
  assert.equal(record.runtime.artifactId, paired.platforms[platform].runtimeArtifact);
  assert.deepEqual(record.runtime.kitIdentity, paired.kitIdentity);
  assert.equal(record.report.runtimeArtifact, record.runtime.artifactId);
  assert.equal(record.report.engineArtifact, paired.platforms[platform].engineArtifact);
  assert.equal(record.report.status, 'PASS_FORMAL_FLUTTER_WEBVIEW_TRANSACTION');
  assert.deepEqual(record.report.cases.map(row => row.mode),
    ['transaction', 'reject', 'locked', 'revoked', 'key-failure']);
  assert.equal(record.report.cases[0].signatures, 1);
  assert.ok(record.report.cases.slice(1).every(row => row.signatures === 0));
  assert.ok(record.report.cases.every(row => row.callbacks['http.request'] === 2));
  assert.equal(record.report.partnerVault, false);
  assert.equal(record.report.broadcast, 0);
  assert.equal(record.report.http, 0);
}
assert.deepEqual(evidence.ios.record.report.cases,
  evidence.android.record.report.cases, 'Controlled case results differ');
assert.equal(evidence.api23.record.status,
  'PASS_FAIL_CLOSED_ONLY');
const methodCases = ['discovery', 'public-reads', 'switch-rejected', 'grant',
  'granted-reads', 'single-review-sign', 'reject', 'typed-data',
  'typed-reject', 'disconnect', 'close-pending'];
for (const platform of ['ios', 'android']) {
  const record = evidence[platform === 'ios' ? 'methodsIos' : 'methodsAndroid'].record;
  assert.equal(record.status,
    `PASS_PUBLIC_FACADE_METHOD_SURFACE_${platform.toUpperCase()}_CONTROLLED`);
  assert.equal(record.portablePackage.manifestSha256, manifestSha256);
  assert.equal(record.portablePackage.exactVendoredBytes, true);
  assert.equal(record.runtime.artifactId, paired.platforms[platform].runtimeArtifact);
  assert.deepEqual(record.runtime.kitIdentity, paired.kitIdentity);
  assert.equal(record.report.status,
    'PASS_PUBLIC_WALLET_METHOD_SURFACE_DEVICE_CONTROLLED');
  assert.deepEqual(record.report.cases, methodCases);
  assert.equal(record.report.signatures, 2);
  assert.equal(record.report.journalIntents, 0);
  assert.equal(record.report.transactionConstruction, false);
  assert.equal(record.report.realChain, false);
  assert.equal(record.report.partnerVault, false);
  assert.equal(record.independentCheck.status,
    'PASS_PUBLIC_METHOD_SURFACE_INDEPENDENT');
  assert.equal(record.independentCheck.independentlyCheckedSignatures, 2);
}
assert.deepEqual(evidence.methodsIos.record.report.methodResults,
  evidence.methodsAndroid.record.report.methodResults,
  'Controlled Provider method results differ');
assert.deepEqual(evidence.methodsIos.record.independentCheck.positiveMethods,
  evidence.methodsAndroid.record.independentCheck.positiveMethods);
const controlledMethods = new Set(
  evidence.methodsIos.record.independentCheck.positiveMethods);
const cryptoCases = ['discovery', 'grant', 'single-review-sign', 'reject',
  'crypto-encrypt', 'crypto-decrypt', 'crypto-corrupt', 'crypto-reject',
  'crypto-workflow', 'disconnect', 'close-pending'];
for (const platform of ['ios', 'android']) {
  const record = evidence[platform === 'ios' ? 'cryptoIos' : 'cryptoAndroid'].record;
  assert.equal(record.status,
    `PASS_PUBLIC_FACADE_CRYPTO_${platform.toUpperCase()}_CONTROLLED`);
  assert.equal(record.portablePackage.manifestSha256, manifestSha256);
  assert.equal(record.portablePackage.exactVendoredBytes, true);
  assert.equal(record.runtime.artifactId, paired.platforms[platform].runtimeArtifact);
  assert.deepEqual(record.runtime.kitIdentity, paired.kitIdentity);
  assert.equal(record.report.status, 'PASS_PUBLIC_WALLET_CRYPTO_DEVICE_CONTROLLED');
  assert.deepEqual(record.report.cases, cryptoCases);
  assert.equal(record.report.cryptoCalls, 5);
  assert.equal(record.report.journalIntents, 0);
  assert.equal(record.report.transactionConstruction, false);
  assert.equal(record.report.realChain, false);
  assert.equal(record.report.partnerVault, false);
  assert.equal(record.independentCheck.status, 'PASS_PUBLIC_CRYPTO_INDEPENDENT');
  assert.equal(record.independentCheck.independentBie1AuthenticationAndDecryption, true);
}
const cryptoIosResults = structuredClone(evidence.cryptoIos.record.report.cryptoResults);
const cryptoAndroidResults = structuredClone(evidence.cryptoAndroid.record.report.cryptoResults);
for (const result of [cryptoIosResults, cryptoAndroidResults]) {
  delete result.workflow.approvalId;
  delete result.workflow.workflowPlanHash;
}
assert.deepEqual(cryptoIosResults, cryptoAndroidResults,
  'Controlled crypto results differ beyond per-approval workflow identity');
const cryptoMethods = new Set(['tbc_encrypt', 'tbc_decrypt', 'tbc_signWorkflow']);
for (const name of cryptoMethods) controlledMethods.add(name);
const preparedCases = ['discovery', 'grant', 'single-review-sign', 'reject',
  'transaction', 'transaction-reject', 'workflow', 'workflow-reject',
  'prepared-valid', 'prepared-tampered', 'prepared-expired',
  'prepared-workflow', 'disconnect', 'close-pending'];
for (const platform of ['ios', 'android']) {
  const record = evidence[platform === 'ios' ? 'preparedIos' : 'preparedAndroid'].record;
  assert.equal(record.status,
    `PASS_PUBLIC_FACADE_PREPARED_${platform.toUpperCase()}_CONTROLLED`);
  assert.equal(record.portablePackage.manifestSha256, manifestSha256);
  assert.equal(record.portablePackage.exactVendoredBytes, true);
  assert.equal(record.runtime.artifactId, paired.platforms[platform].runtimeArtifact);
  assert.deepEqual(record.runtime.kitIdentity, paired.kitIdentity);
  assert.equal(record.report.status, 'PASS_PUBLIC_WALLET_PREPARED_DEVICE_CONTROLLED');
  assert.deepEqual(record.report.cases, preparedCases);
  assert.equal(record.report.signatures, 7);
  assert.equal(record.report.journalIntents, 0);
  assert.equal(record.report.realChain, false);
  assert.equal(record.report.partnerVault, false);
  assert.deepEqual(record.preparedCheck.successes, ['valid', 'workflow']);
  assert.equal(record.preparedCheck.proposalHashChecked, true);
  assert.equal(record.preparedCheck.expiredAndTamperedRejected, true);
  assert.equal(record.preparedCheck.businessBytesMatchWalletBuild, true);
  assert.equal(record.preparedCheck.realChain, false);
}
assert.deepEqual(evidence.preparedIos.record.preparedCheck,
  evidence.preparedAndroid.record.preparedCheck,
  'Controlled Prepared checks differ');
const preparedMethods = new Set(['tbc_signPreparedTransaction',
  'tbc_signPreparedWorkflow']);
for (const name of preparedMethods) controlledMethods.add(name);
const reviewedCases = ['discovery', 'grant', 'single-review-sign', 'reject',
  'transaction', 'transaction-reject', 'workflow', 'workflow-reject',
  'raw-single', 'raw-single-reject', 'raw-workflow', 'raw-workflow-reject',
  'associated-single', 'associated-single-reject', 'associated-workflow',
  'associated-workflow-reject', 'disconnect', 'close-pending'];
for (const platform of ['ios', 'android']) {
  const record = evidence[platform === 'ios' ? 'reviewedIos' : 'reviewedAndroid'].record;
  assert.equal(record.status,
    `PASS_PUBLIC_FACADE_REVIEWED_${platform.toUpperCase()}_CONTROLLED`);
  assert.equal(record.portablePackage.manifestSha256, manifestSha256);
  assert.equal(record.portablePackage.exactVendoredBytes, true);
  assert.equal(record.runtime.artifactId, paired.platforms[platform].runtimeArtifact);
  assert.deepEqual(record.runtime.kitIdentity, paired.kitIdentity);
  assert.equal(record.report.status, 'PASS_PUBLIC_WALLET_REVIEWED_DEVICE_CONTROLLED');
  assert.deepEqual(record.report.cases, reviewedCases);
  assert.equal(record.report.signatures, 12);
  assert.equal(record.report.journalIntents, 0);
  assert.equal(record.report.realChain, false);
  assert.equal(record.report.partnerVault, false);
  assert.deepEqual(record.independentCheck.cases.map(row => row.id),
    ['raw-single', 'raw-workflow', 'associated-single', 'associated-workflow']);
  assert.ok(record.independentCheck.cases.every(row =>
    row.referenceBytesIdentical && row.independentDigestAndSignature));
  assert.equal(record.independentCheck.broadcastPosts, 0);
  assert.equal(record.independentCheck.realChain, false);
}
assert.deepEqual(evidence.reviewedIos.record.independentCheck,
  evidence.reviewedAndroid.record.independentCheck,
  'Controlled Reviewed checks differ');
controlledMethods.add('tbc_signReviewedTransaction');
for (const platform of ['ios', 'android']) {
  const key = platform === 'ios' ? 'switchIos' : 'switchAndroid';
  const record = evidence[key].record;
  const reportBytes = await readFile(join(root, 'native/flutter-compat',
    evidenceNames[key], 'report.json'));
  evidence[key].report = JSON.parse(reportBytes);
  assert.equal(record.reportSha256, sha(reportBytes));
  assert.equal(record.status,
    `PASS_PORTABLE_NETWORK_SWITCH_${platform.toUpperCase()}_DEVICE_EVIDENCE`);
  assert.equal(record.packageManifestSha256, manifestSha256);
  assert.equal(record.runtimeArtifact, paired.platforms[platform].runtimeArtifact);
  assert.equal(record.engineArtifact, paired.platforms[platform].engineArtifact);
  assert.equal(record.realChain, false);
  assert.equal(record.partnerVault, false);
  const report = evidence[key].report;
  assert.equal(report.status, 'PASS_PUBLIC_WALLET_NETWORK_SWITCH_DEVICE_CONTROLLED');
  assert.deepEqual(report.cases, ['discovery', 'grant-testnet',
    'grant-mainnet-switch', 'switch-mainnet', 'mainnet-isolation',
    'grant-testnet-switch', 'switch-testnet', 'restored-testnet-view',
    'disconnect', 'close-pending']);
  assert.equal(report.signatures, 0);
  assert.equal(report.journalIntents, 0);
  assert.equal(report.realChain, false);
  assert.equal(report.partnerVault, false);
}
assert.deepEqual(evidence.switchIos.report.networkEvents,
  evidence.switchAndroid.report.networkEvents,
  'Controlled network events differ');
controlledMethods.add('tbc_switchChain');
const localSendTxid = 'af082f5ab28043a7a89ab9031b9f9710d34f4950fb15331eb576f82a322938e9';
const localSendJournal = [`intent|completed|${localSendTxid}`,
  `result|accepted|${localSendTxid}`];
for (const platform of ['ios', 'android']) {
  const key = platform === 'ios' ? 'sendIos' : 'sendAndroid';
  const record = evidence[key].record;
  const reportBytes = await readFile(join(root, 'native/flutter-compat',
    evidenceNames[key], 'report.json'));
  assert.equal(record.reportSha256, sha(reportBytes));
  assert.deepEqual(record.report, JSON.parse(reportBytes));
  assert.equal(record.status, `PASS_PORTABLE_SEND_${platform.toUpperCase()}_CONTROLLED`);
  assert.equal(record.pairedManifestSha256, manifestSha256);
  assert.equal(record.runtimeArtifact, paired.platforms[platform].runtimeArtifact);
  assert.equal(record.engineArtifact, paired.platforms[platform].engineArtifact);
  assert.equal(record.realChain, false);
  assert.equal(record.partnerVault, false);
  assert.deepEqual(record.journal, localSendJournal);
  const report = record.report;
  assert.equal(report.status, 'PASS_PUBLIC_WALLET_SEND_DEVICE_CONTROLLED');
  assert.deepEqual(report.cases, ['discovery', 'grant', 'single-review-sign',
    'reject', 'transaction', 'transaction-reject', 'disconnect', 'close-pending']);
  assert.equal(report.postAttempts, 1);
  assert.equal(report.journalIntents, 1);
  assert.equal(report.submittedTxid, localSendTxid);
  assert.equal(report.signedTransaction.transactions[0].txid, localSendTxid);
  assert.equal(report.signedTransaction.transactions[0].status, 'submitted');
  assert.equal(report.signatures, 2);
  assert.equal(report.controlledHttps, true);
  assert.equal(report.realChain, false);
  assert.equal(report.partnerVault, false);
}
controlledMethods.add('tbc_sendTransaction');
for (const platform of ['ios', 'android']) {
  const key = platform === 'ios' ? 'preparedSendIos' : 'preparedSendAndroid';
  const record = evidence[key].record;
  const reportBytes = await readFile(join(root, 'native/flutter-compat',
    evidenceNames[key], 'report.json'));
  assert.equal(record.reportSha256, sha(reportBytes));
  assert.deepEqual(record.report, JSON.parse(reportBytes));
  assert.equal(record.status,
    `PASS_PORTABLE_PREPARED_SEND_${platform.toUpperCase()}_CONTROLLED`);
  assert.equal(record.pairedManifestSha256, manifestSha256);
  assert.equal(record.runtimeArtifact, paired.platforms[platform].runtimeArtifact);
  assert.equal(record.engineArtifact, paired.platforms[platform].engineArtifact);
  assert.equal(record.realChain, false);
  assert.equal(record.partnerVault, false);
  assert.deepEqual(record.journal, localSendJournal);
  const report = record.report;
  assert.equal(report.status, 'PASS_PUBLIC_WALLET_PREPARED_SEND_DEVICE_CONTROLLED');
  assert.equal(report.postAttempts, 1);
  assert.equal(report.journalIntents, 1);
  assert.equal(report.submittedTxid, localSendTxid);
  assert.equal(report.chainRequests.filter(value =>
    value === 'POST /api/tbc/broadcasttx').length, 1);
  assert.deepEqual(report.preparedCases.map(value => value.mode),
    ['valid', 'tampered', 'expired', 'workflow']);
  assert.equal(report.preparedCases[0].reply.ok, true);
  assert.ok(report.preparedCases.slice(1, 3).every(value =>
    !value.reply.ok && value.signatures === 0 && value.reads.length === 0));
  assert.equal(report.preparedCases[3].reply.ok, true);
  assert.equal(report.preparedCases[3].reads.filter(value =>
    value.startsWith('POST ')).length, 0);
  assert.equal(report.realChain, false);
  assert.equal(report.partnerVault, false);
}
controlledMethods.add('tbc_sendPreparedTransaction');
for (const [key, status, reportStatus] of [
  ['workflowSend', 'PASS_PORTABLE_WORKFLOW_SEND_IOS_ANDROID_CONTROLLED_PARITY',
    'PASS_PUBLIC_WALLET_WORKFLOW_SEND_DEVICE_CONTROLLED'],
  ['preparedWorkflowSend',
    'PASS_PORTABLE_PREPARED_WORKFLOW_SEND_IOS_ANDROID_CONTROLLED_PARITY',
    'PASS_PUBLIC_WALLET_PREPARED_WORKFLOW_SEND_DEVICE_CONTROLLED'],
]) {
  const record = evidence[key].record;
  assert.equal(record.status, status);
  assert.equal(record.realChain, false);
  assert.equal(record.partnerVault, false);
  for (const platform of ['ios', 'android']) {
    const side = record[platform];
    assert.equal(side.pairedManifestSha256, manifestSha256);
    assert.equal(side.runtimeArtifact, paired.platforms[platform].runtimeArtifact);
    assert.equal(side.engineArtifact, paired.platforms[platform].engineArtifact);
    assert.equal(side.report.status, reportStatus);
    assert.equal(side.report.postAttempts, 1);
    assert.equal(side.report.submittedTxid, localSendTxid);
    assert.equal(side.report.chainRequests.filter(value =>
      value === 'POST /api/tbc/broadcasttxs').length, 1);
    assert.deepEqual(side.journal, localSendJournal);
    assert.equal(side.report.realChain, false);
    assert.equal(side.report.partnerVault, false);
    assert.equal(side.installedIdentity.builtSha256,
      side.installedIdentity.installedSha256);
  }
  assert.deepEqual(record.ios.journal, record.android.journal);
}
controlledMethods.add('tbc_sendWorkflow');
controlledMethods.add('tbc_sendPreparedWorkflow');
for (const platform of ['ios', 'android']) {
  const key = platform === 'ios' ? 'recoveryIos' : 'recoveryAndroid';
  const record = evidence[key].record;
  assert.equal(record.status,
    `PASS_FORMAL_RECOVERY_${platform.toUpperCase()}_CONTROLLED`);
  for (const phase of ['first', 'recovered']) {
    const side = phase === 'first' ? record.first : record.recovered;
    const reportBytes = await readFile(join(root, 'native/flutter-compat',
      evidenceNames[key], phase === 'first' ? 'first-report.json' : 'recovered-report.json'));
    assert.equal(side.reportSha256, sha(reportBytes));
    assert.deepEqual(side.report, JSON.parse(reportBytes));
    assert.equal(side.pairedManifestSha256, manifestSha256);
    assert.equal(side.runtimeArtifact, paired.platforms[platform].runtimeArtifact);
    assert.equal(side.engineArtifact, paired.platforms[platform].engineArtifact);
    assert.equal(side.realChain, false);
    assert.equal(side.partnerVault, false);
  }
  assert.equal(record.first.report.status,
    'PASS_PUBLIC_WALLET_UNCERTAIN_FIRST_PHASE_DEVICE_CONTROLLED');
  assert.equal(record.first.report.postAttempts, 1);
  assert.equal(record.first.report.signatures, 1);
  assert.deepEqual(record.first.journal, [`intent|uncertain|${localSendTxid}`]);
  assert.equal(record.recovered.report.status,
    'PASS_PUBLIC_WALLET_RESTART_RECOVERY_DEVICE_CONTROLLED');
  assert.equal(record.recovered.report.statusQueryOnly, true);
  assert.equal(record.recovered.report.postsAfterRestart, 0);
  assert.equal(record.recovered.report.signaturesAfterRestart, 0);
  assert.deepEqual(record.recovered.report.chainRequests,
    [`GET /api/tbc/decode/txid/${localSendTxid}`]);
  assert.deepEqual(record.recovered.journal,
    [`intent|completed|${localSendTxid}`, `result|known|${localSendTxid}`]);
  assert.notEqual(record.first.report.pid, record.recovered.report.pid);
}
assert.deepEqual(evidence.recoveryIos.record.first.journal,
  evidence.recoveryAndroid.record.first.journal);
assert.deepEqual(evidence.recoveryIos.record.recovered.journal,
  evidence.recoveryAndroid.record.recovered.journal);

const registryBytes = await readFile(join(root, 'registry/methods.json'));
const methodNames = JSON.parse(registryBytes).methods.map(row => row.name);
const intentBytes = await readFile(join(root, 'packages/kit/src/business-capabilities.ts'));
const section = /TBC_KIT_WALLET_INTENTS = Object\.freeze\(\[([\s\S]*?)\] as const/.exec(intentBytes.toString());
assert.ok(section, 'Kit intent inventory missing');
const intentNames = [...section[1].matchAll(/"([^"]+)"/g)].map(match => match[1]);
const packagedSection = /TBC_KIT_WALLET_INTENTS = Object\.freeze\(\[([\s\S]*?)\]\);/.exec(
  kitBusinessBytes.toString());
assert.ok(packagedSection, 'Exact packaged Kit intent inventory missing');
const packagedIntentNames = [...packagedSection[1].matchAll(/"([^"]+)"/g)]
  .map(match => match[1]);
assert.deepEqual(packagedIntentNames, intentNames,
  'Current source intent catalogue differs from the exact packaged Kit');
assert.equal(methodNames.length, 22);
assert.equal(intentNames.length, 58);
assert.equal(new Set(methodNames).size, methodNames.length);
assert.equal(new Set(intentNames).size, intentNames.length);
assert.equal(controlledMethods.size, 21);
assert.ok([...controlledMethods].every(name => methodNames.includes(name)));
assert.ok(methodNames.includes('tbc_signTransaction'));
assert.ok(intentNames.includes('tbc.transfer'));

const report = {
  schema: 1,
  scope: 'Exact paired Flutter candidate; method/vector-specific controlled evidence, iOS/Android TBC20 sign-only synthetic device, iOS/Android tbc.transfer public Testnet',
  packageManifestSha256: manifestSha256,
  kitIdentity: paired.kitIdentity,
  packageFileCount: Object.keys(paired.files).length,
  inventory: {
    registrySha256: sha(registryBytes),
    kitSourceSha256: sha(intentBytes),
    packagedKitCandidateSha256: sha(kitCandidateBytes),
    packagedKitBusinessCapabilitiesSha256: sha(kitBusinessBytes),
    methodCount: methodNames.length,
    intentCount: intentNames.length,
  },
  methods: methodNames.map(name => ({
    name,
    controlledDevice: name === 'tbc_signTransaction'
      ? 'ios26.5-and-android36-tbc-p2pkh-sign-only'
      : name === 'tbc_sendTransaction'
        ? 'ios26.5-and-android36-tbc-p2pkh-local-controlled-post'
      : name === 'tbc_sendPreparedTransaction'
        ? 'ios26.5-and-android36-prepared-local-controlled-post'
      : name === 'tbc_sendWorkflow'
        ? 'ios26.5-and-android36-workflow-local-controlled-batch-post'
      : name === 'tbc_sendPreparedWorkflow'
        ? 'ios26.5-and-android36-prepared-workflow-local-controlled-batch-post'
      : name === 'tbc_switchChain'
        ? 'ios26.5-and-android36-controlled-testnet-mainnet-testnet'
      : name === 'tbc_signReviewedTransaction'
        ? 'ios26.5-and-android36-controlled-reviewed-sign-only'
      : preparedMethods.has(name) ? 'ios26.5-and-android36-controlled-prepared-sign-only'
      : cryptoMethods.has(name) ? 'ios26.5-and-android36-controlled-crypto-vector'
      : controlledMethods.has(name) ? 'ios26.5-and-android36-controlled-method-vector'
        : 'not-proven-for-exact-package',
    evidence: name === 'tbc_signTransaction'
      ? [evidence.ios.path, evidence.android.path]
      : name === 'tbc_sendTransaction'
        ? [evidence.sendIos.path, evidence.sendAndroid.path]
      : name === 'tbc_sendPreparedTransaction'
        ? [evidence.preparedSendIos.path, evidence.preparedSendAndroid.path]
      : name === 'tbc_sendWorkflow'
        ? [evidence.workflowSend.path]
      : name === 'tbc_sendPreparedWorkflow'
        ? [evidence.preparedWorkflowSend.path]
      : name === 'tbc_switchChain'
        ? [evidence.switchIos.path, evidence.switchAndroid.path]
      : name === 'tbc_signReviewedTransaction'
        ? [evidence.reviewedIos.path, evidence.reviewedAndroid.path]
      : preparedMethods.has(name)
        ? [evidence.preparedIos.path, evidence.preparedAndroid.path]
      : cryptoMethods.has(name)
        ? [evidence.cryptoIos.path, evidence.cryptoAndroid.path]
      : controlledMethods.has(name)
        ? [evidence.methodsIos.path, evidence.methodsAndroid.path] : [],
    realTestnet: name === 'tbc_sendTransaction'
      ? 'android36-and-ios26.5-tbc-transfer-confirmed'
      : 'not-proven-for-exact-package',
    partnerVault: false,
  })),
  intents: intentNames.map(name => ({
    name,
    sourceOnlyMaterial: name === 'tbc20-standard-transfer'
      ? 'exact-pair-index-and-ancestry-preflight; no-device-or-signature'
      : 'not-proven-for-exact-package',
    controlledDevice: name === 'tbc.transfer'
      ? 'p2pkh-sign-only-and-local-controlled-transaction-and-workflow-post'
      : name === 'tbc20-standard-transfer'
        ? 'ios26.5-and-android36-exact-rust-fixture-sign-only-no-post'
        : 'not-proven-for-exact-package',
    exactPackageRealTestnet: name === 'tbc.transfer'
      ? 'android36-and-ios26.5-confirmed'
      : 'not-proven',
    evidence: name === 'tbc20-standard-transfer'
      ? [evidence.tbc20Material.path, evidence.tbc20Ios.path,
        evidence.tbc20Android.path, evidence.tbc20AndroidRelease.path] : [],
    releaseAotControlled: name === 'tbc20-standard-transfer'
      ? 'android36-app-side-r8-workaround-test-signed-no-post'
      : 'not-proven-for-exact-package',
    partnerVault: false,
  })),
  platformLimits: {
    android23WebView44: 'fail-closed',
    android23UpdatedWebView: 'not-tested',
    androidAbisOtherThanArm64: 'not-packaged',
    ios13_1WholeApp: 'xcode27-rejects-13.1-before-compilation; older-toolchain-and-device-required',
    release: 'android-arm64-tbc20-sign-only-aot-device-with-app-side-r8-workaround; final package consumer rule not yet rebuilt',
    physicalDevices: 'not-run',
  },
  broadcastRecoveryControlled: {
    status: 'ios26.5-and-android36-one-ambiguous-local-post-then-status-only-restart',
    evidence: [evidence.recoveryIos.path, evidence.recoveryAndroid.path],
    realTestnet: 'not-proven-for-exact-package',
  },
  realTestnetCurrentPair: {
    androidTbcTransfer: 'confirmed',
    iosTbcTransfer: 'confirmed',
    evidence: [evidence.realTestnetAndroid.path, evidence.realTestnetIos.path],
    txids: [realAndroid.transaction.txid, realIos.transaction.txid],
    partnerVault: false,
  },
  evidence: Object.fromEntries(Object.entries(evidence).map(([key, value]) =>
    [key, {path: value.path, sha256: value.sha256}])),
  deliveryReady: false,
};
await writeFile(resolve(outputArg), JSON.stringify(report, null, 2) + '\n', {flag: 'wx'});
console.log(JSON.stringify({status: 'FORMAL_EXACT_PACKAGE_COVERAGE_REPORTED',
  methods: methodNames.length, controlledMethods: controlledMethods.size + 1,
  intents: intentNames.length,
  controlledIntents: 2, output: resolve(outputArg)}));
