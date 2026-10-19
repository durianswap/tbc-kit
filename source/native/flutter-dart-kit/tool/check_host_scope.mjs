import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve, relative } from 'node:path';
const base = resolve(import.meta.dirname, '..'), dart = process.argv[2];
assert(dart, 'Dart SDK executable required');
const sha = b => createHash('sha256').update(b).digest('hex');
const extraction = JSON.parse(await readFile(join(base, 'evidence/f1-host-extraction.json')));
assert.equal(sha(await readFile(extraction.archive)), extraction.archiveSha256);
for (const file of extraction.provenance) {
  assert.equal(sha(await readFile(join(base, file.destination))), file.sha256, file.destination);
}
// The earlier material replay remains applicable only if every material/Engine
// implementation used for that proof is byte-identical. Do not claim a rerun.
const materialProof = JSON.parse(await readFile(join(base, 'evidence/f1-source-check.json')));
const retainedMaterial = Object.entries(materialProof.sourceHashes).filter(([p]) =>
  p.startsWith('lib/src/internal/') || p === 'lib/src/configuration.dart');
for (const [p, hash] of retainedMaterial) assert.equal(sha(await readFile(join(base, p))), hash, p);
const analysis = execFileSync(dart, ['analyze', 'lib', 'test', 'tool'], { cwd: base, encoding: 'utf8' });
const log = execFileSync(dart, ['test', '--reporter=json'], { cwd: base, encoding: 'utf8' });
const events = log.trim().split('\n').map(line => JSON.parse(line));
assert.equal(events.findLast(e => e.type === 'done')?.success, true);
const passed = events.filter(e => e.type === 'testDone' && !e.hidden && !e.skipped && e.result === 'success').length;
assert.equal(passed, 33);
const protection = JSON.parse(execFileSync(process.execPath, ['tool/check_protected.mjs'], { cwd: base, encoding: 'utf8' }));
const hashes = {};
async function walk(path) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const full = join(path, entry.name);
    if (entry.isDirectory()) await walk(full);
    else if (entry.isFile()) hashes[relative(base, full)] = sha(await readFile(full));
  }
}
await walk(join(base, 'lib')); await walk(join(base, 'test'));
const report = {
  status: 'F1_SHARED_HOST_SCOPE_SOURCE_PASS', recordedAt: new Date().toISOString(),
  tests: passed, analysis: analysis.trim(), sourceHashes: hashes, protection,
  extractionSha256: sha(await readFile(join(base, 'evidence/f1-host-extraction.json'))),
  inheritedMaterialProofSha256: sha(await readFile(join(base, 'evidence/f1-material-parity.json'))),
  unchangedMaterialSources: retainedMaterial.length,
  guaranteesTested: [
    'Startup account inventory consumed once without a duplicate first read',
    'No permission write or chain query on account/clock/session read paths',
    'Native navigation and wallet revision invalidation',
    'Configured chain switch cancels old I/O; stale account result is not delivered',
    'Grant writes revoke permits before awaiting storage, without serializing unrelated callbacks',
    'Revocation during consent prevents stale issuance; late issued permit is explicitly revoked',
    'Verified early consent skips duplicate UI but never skips formal correspondence checks',
    'Binding, origin, account, chain, expiry and display preimage guards retained',
    'Uninstalled signer, crypto, HTTP and storage execution paths fail explicitly, no fallback',
  ],
  limitations: [
    'Private host adapters only; not a complete Provider or Core checkpoint verifier',
    'Tests use offline fixtures and a mock native issuer; not native Vault atomicity proof',
    'No new device, mainnet, live chain, speed or complete-feature App size claim',
  ],
  networkHttp: 0, signatures: 0, broadcasts: 0, newDeviceAcceptance: false,
  acceptedDeliveryChanged: false, published: false,
};
await writeFile(join(base, 'evidence/f1-host-scope-check.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ status: report.status, tests: passed, protectedFiles: protection.protectedFiles, newDeviceAcceptance: false }));
