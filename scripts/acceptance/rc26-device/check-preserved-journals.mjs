// Read-only reconciliation of local accepted records. Never queries an API,
// reads a key, signs, rebroadcasts or modifies the source database.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync as exec } from 'node:child_process';
import { resolve, join } from 'node:path';
const root = resolve(import.meta.dirname, '../../..');
const config = JSON.parse(await readFile(join(root, '.verify/rc26-ui/build.json')));
const adb = '/Users/alex/Library/Android/sdk/platform-tools/adb';
const output = join(root, 'docs/acceptance/evidence/rc26-devices');
const scratch = join(root, '.verify/rc26-ui/private/android-journal');
await mkdir(scratch, { recursive: true, mode: 0o700 });
const container = exec('xcrun', ['simctl', 'get_app_container', config.iosUDID, config.iosBundle, 'data'], { encoding: 'utf8' }).trim();
for (const suffix of ['', '-wal', '-shm']) {
  const name = 'testnet-broadcast.sqlite' + suffix;
  try { await writeFile(join(scratch, name), exec(adb, ['-s', config.androidSerial, 'exec-out', 'run-as', config.androidBundle, 'cat', 'files/' + name], { maxBuffer: 16e6 }), { mode: 0o600 }); }
  catch (error) { if (!suffix) throw error; }
}
const sql = 'SELECT i.txid,i.raw_hash,i.state,r.status FROM tbc_kit_broadcast_intents i LEFT JOIN tbc_kit_broadcast_results r USING(idempotency_key) ORDER BY i.txid';
const result = {};
for (const platform of ['ios', 'android']) {
  const db = platform === 'ios' ? join(container, 'Library/Application Support/testnet-broadcast.sqlite') : join(scratch, 'testnet-broadcast.sqlite');
  const actual = JSON.parse(exec('sqlite3', ['-readonly', '-json', db, sql], { encoding: 'utf8' }));
  const prior = JSON.parse(await readFile(join(root, 'docs/acceptance/evidence/rc25-devices', platform + '-journal-summary.json'))).sort((a,b) => a.txid.localeCompare(b.txid));
  assert.deepEqual(actual, prior, platform + ' prior submitted transactions must remain unchanged');
  assert(actual.every(row => row.state === 'completed' && row.status === 'accepted'));
  result[platform] = { status: 'PASS', rows: actual.length, newTransactions: 0, pending: 0, records: actual };
}
await writeFile(join(output, 'preserved-journals.json'), JSON.stringify({ status: 'PASS', checkedAt: new Date().toISOString(), scope: 'Local read-only equality against prior accepted records; no new chain query or submission', result }, null, 2) + '\n');
await writeFile(join(output, 'android-ui-expiry.png'), exec(adb, ['-s', config.androidSerial, 'exec-out', 'screencap', '-p'], { maxBuffer: 8e6 }));
console.log(JSON.stringify({ status: 'PASS', ios: result.ios.rows, android: result.android.rows, newTransactions: 0 }));
