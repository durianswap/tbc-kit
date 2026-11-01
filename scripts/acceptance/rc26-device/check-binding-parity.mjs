// Public synthetic fixtures only; no RPC, signer Vault or real broadcast.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = resolve(import.meta.dirname, '../../..');
if (process.argv[2] === '--capture') {
  // openSession's default context includes wall-clock createdAt, independently
  // of the injected signing clock. Fix both only in this synthetic parity run.
  const OriginalDate = Date;
  globalThis.Date = class extends OriginalDate {
    constructor(...args) { super(...(args.length ? args : ['2026-11-01T00:00:00.000Z'])); }
    static now() { return 1793491200000; }
  };
  const url = pathToFileURL(join(root, 'source/packages/kit/test/nft-job-stress-fixture.mjs')).href;
  const hook = registerHooks({ load(u, c, next) {
    const result = next(u, c);
    return u === url ? { ...result, source: String(result.source).replace('formal.push(params.binding.bindingHash)', 'formal.push(params.binding)') } : result;
  } });
  const { harness } = await import(url);
  hook.deregister();
  const h = await harness(11);
  try {
    const result = await h.wallet.tbc721.batchMint(h.input);
    assert.equal(result.status, 'complete');
    console.log(JSON.stringify({ bindings: h.formal, txids: h.accepted, stats: h.stats(), reads: h.calls }));
  } finally { h.close(); }
} else {
  const kits = ['.verify/nft-job-install-f1sefH/node_modules/@tbc/kit', '.verify/nft-job-install-gCQAmT/node_modules/@tbc/kit'];
  const runs = kits.map(kit => {
    const r = spawnSync(process.execPath, [import.meta.filename, '--capture'], { cwd: root, encoding: 'utf8', maxBuffer: 8e6,
      env: { ...process.env, TBC_TEST_INSTALLED_KIT: join(root, kit) } });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout.trim().split('\n').find(line => line.startsWith('{"bindings":')));
  });
  assert.deepEqual(runs[0].txids, runs[1].txids);
  assert.deepEqual(runs[0].stats, runs[1].stats);
  assert.deepEqual(runs[0].reads, runs[1].reads);
  const diffs = [];
  function diff(a, b, path = '') {
    if (JSON.stringify(a) === JSON.stringify(b)) return;
    if (a && b && typeof a === 'object' && typeof b === 'object') {
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) diff(a[key], b[key], `${path}/${key}`);
    } else diffs.push({ path, before: a, after: b });
  }
  diff(runs[0].bindings, runs[1].bindings, 'bindings');
  assert.deepEqual(diffs, [], 'Same context must produce identical approval bindings');
  const report = { status: 'PASS', transactionsEqual: true, callsEqual: true, bindingsEqual: true,
    contextNote: 'Uncontrolled device-run binding hashes differ because openSession binds wall-clock createdAt. With the same session creation time, complete binding payloads and hashes match.', kits, diffs, runs };
  await writeFile(join(root, 'docs/acceptance/evidence/rc26-devices/node-binding-parity.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ transactionsEqual: true, callsEqual: true, diffs }));
}
