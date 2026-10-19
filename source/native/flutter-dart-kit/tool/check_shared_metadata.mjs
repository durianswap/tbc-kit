// Reproducible source/offline closure, not installed Legacy or chain proof.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { createHash } from 'node:crypto';

const base = resolve(import.meta.dirname, '..');
const [dart, output, mode] = process.argv.slice(2);
assert(dart && output, 'usage: node tool/check_shared_metadata.mjs DART NEW_REPORT');
assert(mode === undefined || mode === '--ingress');
const ingress = mode === '--ingress';
const run = promisify(execFile);
const opts = { cwd: base, maxBuffer: 12e6, timeout: 120000 };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const names = ['asset_metadata', 'fungible_signing', 'stablecoin_signing',
  'unified_pool_material', 'legacy_shared_worker', 'legacy_business'];
if (ingress) names.push('legacy_worker_ingress', 'legacy_mapping',
  'signing_worker', 'workflow_worker', 'send_worker', 'crypto_worker', 'crypto_workflow_worker');
const tests = names.map(name => `test/${name}_test.dart`);
const analysis = await run(dart, ['analyze', 'lib', ...tests], opts);
const result = await run(dart, ['test', ...tests, '--reporter=json'], opts);
const events = result.stdout.trim().split('\n').map(line => JSON.parse(line));
assert.equal(events.findLast(event => event.type === 'done')?.success, true);
const completed = events.filter(event => event.type === 'testDone' && !event.hidden && !event.skipped);
assert(completed.every(event => event.result === 'success'));
const suites = new Map(events.filter(event => event.type === 'suite')
  .map(event => [event.suite.id, event.suite.path]));
const started = new Map(events.filter(event => event.type === 'testStart')
  .map(event => [event.test.id, event.test]));
const bySuite = {};
for (const event of completed) {
  const path = relative(base, suites.get(started.get(event.testID).suiteID));
  bySuite[path] = (bySuite[path] ?? 0) + 1;
}
assert.equal(bySuite['test/asset_metadata_test.dart'], 13);
if (ingress) assert.equal(bySuite['test/legacy_worker_ingress_test.dart'], 21);
assert.equal([...started.values()].filter(test => test.name.endsWith(
  'mapped into shared worker; one consent, same reads/bytes/fee')).length, 20);

const sources = {};
async function tree(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await tree(path);
    else if (entry.isFile()) sources[relative(base, path)] = sha(await readFile(path));
  }
}
await tree(join(base, 'lib'));
for (const path of [...tests, 'test/native_signing_test.dart', 'tool/check_shared_metadata.mjs',
  'test/fixtures/signing/replay.json', ...['creation-signing', 'fungible-signing',
    'stablecoin-signing', 'unified-pool-signing', 'nft-signing', 'legacy-business-mapping',
    'legacy-pool-mapping'].map(name => `test/fixtures/${name}.json`)]) {
  sources[path] = sha(await readFile(join(base, path)));
}
if (ingress) {
  for (const file of ['native-signing', 'native-transfers', 'legacy-message-signing', 'legacy-mapping',
    'workflow-planning', 'workflow-signing', 'crypto-signing', 'crypto-workflow']) {
    const path = `test/fixtures/${file}.json`;
    sources[path] = sha(await readFile(join(base, path)));
  }
  for (const file of ['legacy_mapping_oracle', 'legacy_business_mapping_oracle']) {
    const path = `tool/${file}.mjs`;
    sources[path] = sha(await readFile(join(base, path)));
    await run(process.execPath, [path, '--check'], opts);
  }
}
const priorNative = {};
for (const name of ['f3-legacy-native-profile-20261014-b', 'f3-legacy-profile-mobile-compile-20261014-b']) {
  const path = `evidence/${name}.json`, bytes = await readFile(join(base, path)), report = JSON.parse(bytes);
  for (const [file, hash] of Object.entries(report.sources)) {
    assert.equal(sha(await readFile(join(base, file))), hash, `${file} changed after native proof`);
  }
  priorNative[path] = { sha256: sha(bytes), status: report.status };
}
const buildPath = process.env.TBC173_BUILD_REPORT ?? '/private/tmp/tbc-contract173-compute-20261014-a/build-report.json';
const buildBytes = await readFile(buildPath), build = JSON.parse(buildBytes);
const current = build.builds.find(row => row.target === 'aarch64-apple-darwin');
assert.equal(current.sha256, '413559859a0fa0fed61220485ea482ca8c28f305b4145f600ff706ca3a8bd0db');
assert.equal(sha(await readFile(current.path)), current.sha256);
const baseline = JSON.parse(await readFile(join(base, 'test/fixtures/signing/replay.json'))).library;
assert.equal(sha(await readFile(baseline.path)), baseline.sha256);
const protectedCheck = await run(process.execPath, ['tool/check_protected.mjs'], opts);
const protectedResult = JSON.parse(protectedCheck.stdout.trim());

const report = {
  status: ingress ? 'LEGACY_SHARED_WORKER_INGRESS_PARITY_PASS' : 'SHARED_IMMUTABLE_METADATA_PARITY_PASS', recordedAt: new Date().toISOString(),
  tests, passed: completed.length, bySuite, analysis: analysis.stdout.trim(), sources, priorNative,
  compute: {
    current: { path: current.path, sha256: current.sha256, buildReportSha256: sha(buildBytes),
      usedBy: ['asset_metadata_test.dart', 'legacy_shared_worker_test.dart', ...(ingress ? ['legacy_worker_ingress_test.dart'] : [])] },
    frozenRegression: { ...baseline,
      usedBy: ['fungible_signing_test.dart', 'stablecoin_signing_test.dart', 'unified_pool_material_test.dart'] },
  },
  proof: 'Common private metadata reader extracts decimals/name/symbol and Pool-to-FT identity from txid-checked origin transactions after pinned Rust template recognition. The same required parent and origin-classification cache is reused by material preparation. Twenty production worker/current Engine mapping cases and affected frozen-profile regressions retain signed bytes, fee, GET paths, one consent and parallel preparation.',
  ...(ingress ? { workerIngress: {
    implemented: 'Captured private Legacy call selects a standard method/child grants before native begin, translates inside the same source-bound worker, uses common metadata/readers and the unchanged executor/custody. Standalone is not wrapped in a workflow; only actual batches use workflow. Public Provider/Flutter registration remains disabled.',
    currentComputeCases: 'Nine actual ingress TBC/FT/Coin/Pool buy/sell/add/remove cases preserve bytes/fees/GETs and overlapping approval/material reads. Four Bitcoin-message encodings and a transaction-to-dependent-message batch retain exact recorded signatures, one consent and no extra reads.',
    guards: 'Standard-profile worker refuses Legacy, unsupported create/admin flags fail before native work, missing child grant opens no native operation, page mutations cannot replace captured input, and document/native revocation during metadata stops before consent/bind/sign.',
    boundedFee: 'Frozen wallet-owned single-call caps are retained; unified tbc20.transfer plus dependent message retains the same10000 cap as its historical alias, avoiding unintended prepared-before-consent fallback.',
    localTranslationCost: 'Pure translation adds no native authority round trips. Metadata reads get a pre-read fence; the shared executor supplies the post-mapping native fence, without an immediate duplicate call.',
    timingBoundary: 'As in frozen JS Legacy resolution, immutable precision conversion precedes canonical intent consent; fresh transaction preparation then overlaps consent. No live timing claim or promise that every arbitrary Reviewed/unbounded batch approves before material exists.',
    correction: 'Initial new test omitted the separate native read fixture and supplied2 decimals for an actual0-decimal Coin origin. Fixed test inputs only; amount validation, production reads and custody unchanged.',
  }} : {}),
  checks: [
    'Current TBC20 structured metadata, historical FT and current/historical Coin certificate metadata use their actual layouts; unknown layout or missing precision fails without a guessed default.',
    'Concurrent identical metadata requests single-flight; source/chain instances do not share cache; failed reads are not cached or automatically retried.',
    'Historical holder and Pool material snapshots and cold/warm GET multisets are unchanged after metadata reads; no additional ft/info or poolinfo request is introduced.',
    'Only immutable identity is cached. UTXO, confirmations, balance, reserves and authority remain fresh or independently checked.',
    'Stablecoin worker composition now reuses the common origin hint; native custody and Rust algorithms are unchanged.',
  ],
  limits: [
    'Template recognition is a routing hint, not proof of complete ancestry, canonical-chain inclusion or spendability; existing Engine validation is still required.',
    ingress ? 'Legacy shared-worker preparation is integrated and tested; actual native Legacy registration, document delivery, balance/multi-round maintenance and paired installed proof remain.' : 'LegacySharedMetadata is implemented and exercised with real parsing, but not yet registered into the production Legacy document/worker entry.',
    'A no-additional-GET offline trace is not a measured live latency result; no new device, performance, fresh-signature or real-chain claim.',
  ],
  next: ingress ? 'Wire typed native Legacy namespace and actual document/result delivery onto this shared worker, complete read-only balance/multi-round maintenance, then paired install and clean safe handoff. No duplicate business executor.' : 'Integrate translation into the existing trusted request/worker lifecycle without delaying early consent or serializing preparation; complete read-only balance/multi-round maintenance semantics and actual Legacy document delivery before paired install and final handoff.',
  protectedFiles: protectedResult.protectedFiles,
  liveHttp: 0, broadcasts: 0, freshSignatures: 0, deviceAcceptance: false,
  acceptedDeliveryChanged: false, published: false, goalComplete: false,
};
await writeFile(resolve(base, output), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ status: report.status, passed: report.passed, bySuite,
  sources: Object.keys(sources).length, protectedFiles: report.protectedFiles, liveHttp: 0, broadcasts: 0 }));
