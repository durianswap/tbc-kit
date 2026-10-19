// Preserve exact measured evidence outside immutable candidate directories.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
const repo = resolve(import.meta.dirname, '../../..');
const sha = b => createHash('sha256').update(b).digest('hex');
const [fungiblePath, poolPath, preparationPath] = process.argv.slice(2);
assert.ok(fungiblePath && poolPath && preparationPath && process.argv.length === 5);
const load = path => { const bytes = readFileSync(path); return { path, sha256: sha(bytes), data: JSON.parse(bytes) }; };
const fungible = load(fungiblePath), pool = load(poolPath), preparation = load(preparationPath);
const kitSha = '1fb39857b8326fdcbf2af2fa43d46a5d3a87d7daad81d8e012d2d69a6d5e53a4';
for (const evidence of [fungible, pool]) {
  assert.equal(evidence.data.candidate, '0.1.0-candidate.226');
  assert.equal(evidence.data.archiveProof.sha256, kitSha);
  assert.equal(evidence.data.archiveProof.files, 922);
  assert.equal(evidence.data.benchmarkHarnessSha256,
    sha(readFileSync(join(repo, 'packages/tbc-engine/scripts/lib/measure-unified-route.mjs'))));
  assert.ok(evidence.data.timings.every(t => t.samples === 20 && t.warmup === 2 &&
    t.rawSamples.length === 2 && t.rawSamples.every(samples => samples.length === 20)));
}
assert.equal(fungible.data.timings.length, 13);
assert.equal(pool.data.timings.length, 7);
assert.equal(preparation.data.archiveSha256, kitSha);
assert.equal(preparation.data.verifierSha256, sha(readFileSync(join(repo, 'packages/kit/scripts/check-installed226-preparation.mjs'))));
const logs = preparation.data.results.map(result => {
  assert.equal(result.exit, 0);
  const tap = readFileSync(result.log, 'utf8');
  assert.equal(sha(tap), result.logSha256);
  assert.match(tap, /^# pass 11$/m);
  assert.match(tap, /^# fail 0$/m);
  assert.match(tap, /^# cancelled 0$/m);
  assert.match(tap, /^# skipped 0$/m);
  assert.equal(sha(readFileSync(join(repo, 'packages/kit/test', result.file))), result.testSha256);
  return { file: result.file, sha256: result.logSha256, tap };
});
assert.equal(logs.length, 2);
const rows = [...fungible.data.timings, ...pool.data.timings].map(t => ({
  fixture: t.fixture ?? t.operation, concreteIntent: t.concreteIntent,
  unifiedIntent: t.unifiedIntent, readBudget: t.readBudget,
  concrete: t.concrete, unified: t.unified,
  medianDeltaMs: Object.fromEntries(['coldPrepareMs', 'warmPrepareMs', 'planMs'].map(key =>
    [key, Number((t.unified[key].median - t.concrete[key].median).toFixed(3))])),
}));
const report = {
  status: 'PASS_SCOPED_INSTALLED226_PERFORMANCE_AND_PREPARATION',
  candidate: '0.1.0-candidate.226', kitSha256: kitSha,
  scope: '20 concrete/unified synthetic material preparation and warmed WASM planning pairs; 22 focused Host/preparation tests. Not new AMM benchmark, real API, device E2E or chain evidence.',
  timingMethod: 'Two warmups plus20 alternating samples per lane, benchmarks run sequentially. Cold/warm describes material cache; Engine is already initialized.',
  rows, evidence: { fungible, pool, preparation }, logs,
  productionChanged: false, frozenArtifactsChanged: false, mobileChanged: false,
  realHttp: 0, realBroadcast: 0, fullGoalComplete: false,
};
const out = join(repo, 'docs/distribution/candidate226-performance-preparation.json');
const bytes = JSON.stringify(report, null, 2) + '\n';
writeFileSync(out, bytes, { flag: 'wx' });
console.log(JSON.stringify({ out, sha256: sha(bytes), timingPairs: rows.length, focusedTests: 22 }));
