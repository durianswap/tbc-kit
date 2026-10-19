// Shared private registration/wire proof, not installed Legacy page delivery.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { createHash } from 'node:crypto';
const base = resolve(import.meta.dirname, '..');
const [dart, nativeReport, compileReport, output, pageDirectory] = process.argv.slice(2);
assert(dart && nativeReport && compileReport && output);
const run = promisify(execFile), opts = { cwd: base, maxBuffer: 12e6, timeout: 120000 };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const tests = ['native_protocol_binding', 'native_wallet_binding', 'native_network_binding',
  'provider_network', 'provider_session', 'wire_session', 'legacy_provider_session', 'legacy_worker_ingress']
  .map(name => `test/${name}_test.dart`);
const analysis = await run(dart, ['analyze', 'lib', ...tests], opts);
const result = await run(dart, ['test', ...tests, '--reporter=json'], opts);
const events = result.stdout.trim().split('\n').map(line => JSON.parse(line));
assert.equal(events.findLast(event => event.type === 'done')?.success, true);
const completed = events.filter(event => event.type === 'testDone' && !event.hidden && !event.skipped);
assert(completed.every(event => event.result === 'success'));
const reports = {};
for (const file of [nativeReport, compileReport]) {
  const bytes = await readFile(join(base, file)), report = JSON.parse(bytes);
  for (const [path, expected] of Object.entries(report.sources))
    assert.equal(sha(await readFile(join(base, path))), expected, `${path} changed after native proof`);
  reports[file] = { sha256: sha(bytes), status: report.status,
    ...(report.protocolIsolation ? { protocolIsolation: report.protocolIsolation, legacyMessages: report.legacyMessages } : {}),
    ...(report.kotlinSources ? { kotlinSources: report.kotlinSources, swiftSources: report.swiftSources } : {}) };
}
const sources = {};
async function tree(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await tree(path);
    else if (entry.isFile()) sources[relative(base, path)] = sha(await readFile(path));
  }
}
await tree(join(base, 'lib'));
for (const file of [...tests, 'test/support/signing_replay.dart', 'test/native_signing_test.dart',
  'tool/check_protocol_registration.mjs']) sources[file] = sha(await readFile(join(base, file)));
const protectedCheck = JSON.parse((await run(process.execPath, ['tool/check_protected.mjs'], opts)).stdout.trim());
let pageProof;
if (pageDirectory) {
  const manifest = JSON.parse(await readFile(join(pageDirectory, 'page-provenance.json')));
  const checked = await run(process.execPath, ['--test', 'test/legacy-page.test.mjs'], {
    ...opts, env: { ...process.env, TBC_DART_PAGE_DIR: pageDirectory },
  });
  assert.match(checked.stdout, /# tests 10\n/); assert.match(checked.stdout, /# fail 0\n/);
  await tree(join(base, 'runtime'));
  for (const p of ['tool/build_page.mjs', 'test/legacy-page.test.mjs', 'test_flutter/flutter_channel_test.dart'])
    sources[p] = sha(await readFile(join(base,p)));
  pageProof = { checks: 10, manifest, proof: 'Actual built bundle in isolated VM; dual Flutter composition source analyzed, not desktop Flutter-test execution or installed device proof.' };
}
const report = {
  status: 'LEGACY_CANONICAL_WIRE_ATTESTATION_PASS_PAGE_COMPOSITION_PENDING', recordedAt: new Date().toISOString(),
  tests, passed: completed.length, analysis: analysis.stdout.trim(), sources, reports, protectedCheck,
  implemented: 'Fixed private Legacy channel reuses the Standard wire lifecycle and bounded canonical result format. Legacy JSON decimals travel only inside a bounded string parameter, not the Standard numeric codec. Legacy Provider entry maps to shared control/worker methods; canonical results remain intact through native attestation. Native deliverLegacy selects only the registered Legacy lane, then repeats the existing result/grant/document check; historical result projection belongs on the untrusted page. Public Flutter legacy:true remains gated.',
  proof: 'Dart canonical Legacy baseline connect/read/disconnect, four Bitcoin message encodings through the shared worker, replay/cancel, missing child grant, mismatched profile and malformed wrapper tests pass. Actual Kotlin/Swift native emission accepts only its own canonical channel/results, rejects unverified historical aliases and cross-protocol frames, and rechecks revoke before delivery. System SQLite on macOS and affected Standard/network/Legacy regressions pass. All mobile-facing native sources compile against actual SDKs. No installed page claim.',
  performance: 'No new chain-data read, persistence, approval round or private call. Standard omits the new selector and retains its frame hash/parse path without an extra JSON pass. Counts and source behavior only; no new wall-clock measurement.',
  corrections: ['Dart analysis found an Object? map cast and a missing native-selected accountId at the new ingress; corrected without changing validation.',
    'The new cancellation test originally raced a held native begin after the request had already cancelled. It now awaits ordered worker cleanup, as the existing network test does; no production cancellation change.'],
  pending: ['Page facade/historical result projection, production page asset and dual Flutter session/demux composition', 'Read-only balance, separate multi-round maintenance and newly wired Reviewed/BIE1/send coverage', 'Default-on switchable Legacy, paired installed on/off/namespace/restart checks', 'Safe template, clean install, affected timing/size and full-scope sealed delivery'],
  externalHttp: 0, broadcasts: 0, newSignatures: 0, deviceAcceptance: false,
  acceptedDeliveryChanged: false, goalComplete: false, published: false,
};
if(pageProof) {
  report.status='LEGACY_PAGE_AND_FLUTTER_COMPOSITION_SOURCE_PASS_DEVICE_PENDING';
  report.pageProof=pageProof;
  report.implemented+=' Now the optional canonical page facade and dual Flutter session/demux are implemented; legacy:true is available only with the new pinned page marker and a registered native Legacy backend. Standard discovery remains singular. This supersedes the preceding historical gated statement.';
  report.pending=report.pending.filter(p=>!p.startsWith('Page facade'));
  report.corrections.push('Actual Kotlin1.8 consumer compilation rejected Enum.entries; select directly from the registered lane keys instead, without extra allocations or changed authorization. Desktop Flutter mock tests remain unexecuted due x86_64 tester versus arm64 compute; separate installed arm64 consumers are required.');
}
await writeFile(resolve(base, output), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ status: report.status, passed: report.passed, reports, protectedCheck }));
