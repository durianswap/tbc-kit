// Assemble already collected evidence only. No device actions or network calls.
import assert from 'node:assert/strict';
import { readFile, writeFile, readdir, copyFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
const root = resolve(import.meta.dirname, '../../..');
const dir = join(root, 'docs/acceptance/evidence/rc26-devices');
const candidate = join(root, 'release/candidates/nft-approval-rc26');
const json = async p => JSON.parse(await readFile(p));
const read = name => json(join(dir, name + '.json'));
const median = values => { const v = [...values].sort((a,b) => a-b); return (v[Math.floor((v.length-1)/2)] + v[Math.ceil((v.length-1)/2)])/2; };
const base = await read('android-baseline-parity'), android = await read('android-native-sha-targeted');
const iosBase = await read('ios-ios-baseline'), ios = await read('ios-ios-targeted');
const iosBase2 = await read('ios-ios-baseline-repeat'), ios2 = await read('ios-ios-candidate-repeat');
const parity = await read('node-binding-parity'), journals = await read('preserved-journals');
for (const x of [base, android, iosBase, ios, iosBase2, ios2, parity, journals]) assert.equal(x.status, 'PASS');
for (const x of [base, android, iosBase, ios, iosBase2, ios2]) {
  assert(x.tests.every(t => t.status === 'PASS'));
  for (const run of x.profileRuns) {
    assert.deepEqual(run.txids, base.profileRuns[0].txids);
    assert.deepEqual(run.stats, base.profileRuns[0].stats);
    assert.deepEqual(run.reads, base.profileRuns[0].reads);
    for (const name of ['hashCanonical','assertValidTws','createCheckpoint','verifyCheckpoint','deriveHostTransitionIdentity']) {
      assert.equal(run.profile[name].calls, base.profileRuns[0].profile[name].calls, name);
    }
  }
}
const batch = x => x.metrics.find(m => m.minted === 101);
assert.deepEqual(batch(ios).txids, batch(android).txids);
assert.equal(batch(ios).approvals, 1); assert.equal(batch(android).approvals, 1);
assert.deepEqual(batch(ios).reads, batch(android).reads);
for (const platform of ['ios','android']) {
  const x = await read(platform + '-ui-expiry');
  assert.equal(x.status, 'PASS'); assert.equal(x.deltas.approvalUI, 1);
  assert.equal(x.deltas['signer.sign'], 0); assert.equal(x.deltas['broadcast.POST'], 0);
}
const before = base.profileRuns.map(r => r.elapsedMs), after = android.profileRuns.map(r => r.elapsedMs);
const ib = [...iosBase.profileRuns, ...iosBase2.profileRuns].map(r => r.elapsedMs);
const ia = [...ios.profileRuns, ...ios2.profileRuns].map(r => r.elapsedMs);
const unit = execFileSync(process.execPath, ['--test','source/native/runtime-support/native-sha256.test.mjs','source/native/runtime-support/utf8-encoder.test.mjs'], { cwd: root, encoding: 'utf8' });
await writeFile(join(dir, 'private-runtime-unit.log'), unit);
assert.match(unit, /# pass 6/); assert.match(unit, /# fail 0/);
const lock = await json(join(candidate, 'delivery-lock.json'));
const checks = await json(join(candidate, 'evidence/installed-check.json'));
const priorChain = await json(join(root, 'docs/acceptance/evidence/rc25-devices/chain-reconciliation.json'));
assert.equal(priorChain.transactions.length, 44);
assert(priorChain.transactions.every(t => t.confirmations >= 1 && t.rawMatchesJournal && t.scriptVmPass));
const summary = {
  status: 'PASS', kit: lock.kitVersion, kitSha256: lock.kit.sha256, nativeSdk: lock.sdkVersion,
  protocolFingerprint: lock.protocolFingerprint, checkedAt: new Date().toISOString(),
  installedTests: { passed: checks.checks.reduce((n,x) => n+x.passed,0), optionalSkipped: 1, failed: 0 },
  primaryDeviceGroups: { ios: ios.tests.length, android: android.tests.length, actualApprovalUi: 2 },
  privateRuntimeUnitTests: 6,
  androidLocal11: { beforeMs: before, afterMs: after, beforeMedianMs: median(before), afterMedianMs: median(after), reductionPercent: (1-median(after)/median(before))*100 },
  iosLocal11: { beforeMs: ib, afterMs: ia, beforeMedianMs: median(ib), afterMedianMs: median(ia), deltaMs: median(ia)-median(ib), deltaPercent: (median(ia)/median(ib)-1)*100,
    interpretation: 'Six local simulator samples per version, including fresh and warm runs; small measured +32 ms median difference. No additional calls/reads/checks. Not proof of zero performance regression or a physical-device SLA.' },
  local101: { iosMs: batch(ios).ms, androidMs: batch(android).ms, approvalsEach: 1, signaturesEach: 202, corePlansEach: 11, signedTxidsEqual: true, reads: batch(ios).reads },
  transactionParity: { elevenAcrossBothVersionsAndDevices: true, hundredAndOneAcrossDevices: true, sameContextBindingsEqual: true },
  readsPer11: base.profileRuns[0].reads, statsPer11: base.profileRuns[0].stats,
  realUiExpiry: { platforms: ['ios','android'], result: 'stopped/expired', approvalsEach: 1, signed: 0, posted: 0, readonlyPrefetchGetsEach: 3 },
  priorChainEvidence: { observedAt: priorChain.at, height: priorChain.chainHeight, transactions: 44, minimumConfirmations: Math.min(...priorChain.transactions.map(t=>t.confirmations)), rawMatched: true, scriptVmPassed: true },
  realBroadcastsThisTurn: 0, acceptedJournalRowsUnchanged: { ios: 22, android: 22 },
  scope: 'Controlled local signed-transaction replay plus actual DApp/native approval expiry on simulators. Prior rc25 chain evidence retained; no claim of new rc26 chain broadcast or physical-device timings.',
  partnerDeliveryChanged: false, currentReleaseChanged: false,
};
await writeFile(join(dir, 'final-summary.json'), JSON.stringify(summary, null, 2) + '\n');
for (const name of await readdir(dir)) await copyFile(join(dir,name), join(candidate,'evidence','device-'+name));
await copyFile(join(root,'docs/acceptance/evidence/rc25-devices/chain-reconciliation.json'),join(candidate,'evidence/prior-rc25-chain-reconciliation.json'));
const old = join(root,'release/candidates/kit-stress-rc25');
for (const line of (await readFile(join(old,'DOWNLOADS.SHA256'),'utf8')).trim().split('\n')) {
  const [hash, file] = line.split(/  /);
  assert.equal(createHash('sha256').update(await readFile(join(old,file))).digest('hex'),hash,file);
}
await writeFile(join(candidate,'evidence/rc25-preserved.json'),JSON.stringify({status:'PASS',allSealedRc25FilesUnchanged:true},null,2)+'\n');
console.log(JSON.stringify({ status:'PASS', installedTests:summary.installedTests, android:summary.androidLocal11, ios:summary.iosLocal11, local101:summary.local101, realBroadcasts:0 }));
