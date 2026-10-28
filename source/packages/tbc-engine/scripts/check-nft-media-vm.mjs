// Public synthetic signing fixtures only. Independent VM acceptance, no I/O to
// nodes, wallets, protected archives or funds. Generated data is short-lived.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const require = createRequire(join(root, 'packages/kit/package.json'));
const tbc = require('tbc-lib-js');
assert.equal(require('tbc-lib-js/package.json').version, '1.0.31');
const temporary = mkdtempSync(join(tmpdir(), 'tbc-nft-media-vm-'));
try {
  const reportPath = join(temporary, 'synthetic.json');
  execFileSync('cargo', ['test', '--offline', '--locked', '-p', 'tbc-engine-core',
    '--test', 'tbc721_transaction', 'large_nft_media'], { cwd: join(root, 'packages/tbc-engine/rust'),
    env: { ...process.env, TBC721_MEDIA_REPORT: reportPath }, stdio: 'pipe', timeout: 60_000 });
  const reports = JSON.parse(readFileSync(reportPath, 'utf8'));
  assert.deepEqual(reports.map(r => [r.mediaBytes,r.supply]), [[70_000,3],[500_000,3],[4,2000]]);
  let transactions = 0, inputs = 0, rejected = 0;
  for (const report of reports) {
    const funding = new tbc.Transaction(report.fundingRaw), parents = new Map([[funding.id, funding]]);
    assert.equal(report.transactions.length, 4);
    for (const raw of report.transactions) {
      const tx = new tbc.Transaction(raw);
      let value = 0;
      tx.inputs.forEach((input, vin) => {
        const parent = parents.get(input.prevTxId.toString('hex')); assert.ok(parent);
        input.output = parent.outputs[input.outputIndex]; assert.ok(input.output);
        value += input.output.satoshis;
        const result = tx.verifyScript(vin); assert.equal(result.success, true, result.error);
        inputs++;
      });
      const fee = value - tx.outputs.reduce((sum, o) => sum + o.satoshis, 0);
      assert.ok(fee >= Math.max(80, Math.ceil(raw.length / 2 * 80 / 1000)));
      const altered = new tbc.Transaction(raw);
      altered.inputs[0].output = tx.inputs[0].output;
      // Changing an approved output must invalidate its actual input script.
      altered.outputs.at(-1).satoshis += 1;
      assert.equal(altered.verifyScript(0).success, false); rejected++;
      parents.set(tx.id, tx); transactions++;
    }
  }
  console.log(JSON.stringify({ result: 'NFT_MEDIA_VM_PASS', mediaBytes: reports.map(r => r.mediaBytes),
    collectionSupplies: reports.map(r => r.supply), transactions, inputs, tamperRejections: rejected, networkRequests: 0, broadcasts: 0 }));
} catch (error) {
  console.error('NFT_MEDIA_VM_FAIL ' + String(error.message).split('\n')[0]); process.exitCode = 1;
} finally { rmSync(temporary, { recursive: true, force: true }); }
