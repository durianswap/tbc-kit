// Unmodified npm 1.7.3 is the quote oracle. No keys, network or signing.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
const upstream = resolve(process.argv[2] ?? '/private/tmp/tbc-contract-audit-20261014');
const root = resolve(import.meta.dirname, '../..');
const sha = b => createHash('sha256').update(b).digest('hex');
const pinned = JSON.parse(await readFile(join(root, 'packages/tbc-engine/rust/fixtures/amm-explicit173.json'), 'utf8'));
assert.equal(sha(await readFile(join(upstream, 'npm-1.7.3.tgz'))), '32c3d291e9f566a9ccfcca73d42fe54a25c592361004b2acf3946f04547f028e');
for (const [path, hash] of Object.entries(pinned.upstream.sourceHashes))
  assert.equal(sha(await readFile(join(upstream, 'package', path))), hash);
const req = createRequire(join(upstream, 'package/index.js'));
const math = req('./lib/util/tbc-amm/math.js'), fees = req('./lib/util/tbc-amm/fees.js');
const state = { ftLpAmount: 1000000n, ftAAmount: 2000000n, tbcAmount: 3000000n, poolValue: 3010000n };
const swaps = [], lifecycle = [];
const outcome = fn => { try { return { ok: true, quote: fn() }; } catch (error) { return { ok: false, error: error.message }; } };
for (const row of pinned.fees) {
  const policy = fees.resolveSwapFeePolicy(row.input, row.input.feeAddress);
  for (const direction of ['buy', 'sell']) for (const input of [0n,1n,10n,17n,100n,166n,167n,286n,999n,1000n,10000n,10001n,1000000n,2000000n,3000000n])
    for (const minimum of [0n, 2000000n]) swaps.push({ rates: row.input, direction, state, input, minimum,
      ...outcome(() => direction === 'buy' ? math.quoteSwapFT(state, input, policy, minimum) : math.quoteSwapTBC(state, input, policy, minimum)) });
  const initial = { ftLpAmount: 0n, ftAAmount: 0n, tbcAmount: 0n, poolValue: 1500n };
  const add = math.quoteAddLP(initial, 1000000n, 1000000n);
  const buy = outcome(() => math.quoteSwapFT(add.nextState, 10000n, policy, 1n));
  const sell = buy.ok ? outcome(() => math.quoteSwapTBC(buy.quote.nextState, buy.quote.ftOutRaw, policy, 1n)) : null;
  const remove = sell?.ok ? math.quoteRemoveLP(sell.quote.nextState, sell.quote.nextState.ftLpAmount) : null;
  lifecycle.push({ rates: row.input, initial, add, buy, sell, remove });
}
const output = join(root, 'packages/tbc-engine/rust/fixtures/amm-explicit173-quotes.json');
const data = JSON.stringify({ upstream: pinned.upstream, swaps, lifecycle }, (_k, v) => typeof v === 'bigint' ? v.toString() : v, 2) + '\n';
await writeFile(output, data, { flag: 'wx' });
console.log(JSON.stringify({ path: output, sha256: sha(data), swaps: swaps.length, accepted: swaps.filter(x => x.ok).length, lifecycle: lifecycle.length }));
