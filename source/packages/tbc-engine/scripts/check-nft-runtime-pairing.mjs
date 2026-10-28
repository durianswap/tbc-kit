// Exercise exact local C ABI/WASM bytes with public synthetic fixtures only.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWasmTbcEngineBackend } from '../dist/esm/wasm.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const native = join(root, 'artifacts/native/aarch64-apple-darwin/libtbc_engine_native.dylib');
const wasmPath = join(root, '../kit/artifacts/wasm/tbc_engine_wasm.wasm');
const temporary = mkdtempSync(join(tmpdir(), 'tbc-nft-runtime-'));
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
try {
  const prefix = join(temporary, 'fixture');
  for (const [filter, env] of [
    ['shared_nft_batch', { NFT_BATCH_REPORT: prefix }],
    ['public_nft_hundred', { NFT_MINT_BATCH_REPORT: `${prefix}-mint-100.json` }],
  ]) execFileSync('cargo', ['test', '--release', '--offline', '--locked', '-p', 'tbc-engine-core',
    '--test', 'tbc721_public', filter], { cwd: join(root, 'rust'), stdio: 'pipe', timeout: 240_000,
    env: { ...process.env, ...env }, maxBuffer: 8 * 1024 * 1024 });
  const runner = join(temporary, 'runner');
  execFileSync('cc', [join(root, 'scripts/native-artifact-runner.c'),
    `-I${join(root, 'rust/crates/tbc-engine-native/include')}`, native,
    `-Wl,-rpath,${dirname(native)}`, '-o', runner], { stdio: 'pipe' });
  const wasm = await createWasmTbcEngineBackend(readFileSync(wasmPath));
  let calls = 0;
  async function compare(method, input) {
    const json = JSON.stringify(input);
    const host = JSON.parse(execFileSync(runner, [method, '-'], {
      input: json, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 60_000,
    }));
    const web = JSON.parse(await wasm.call(method, json));
    assert.deepEqual(web, host, `${method} actual Native/WASM mismatch`); calls++;
    return host;
  }
  const profiles = ['current', 'mixed', 'collections', 'funding-current', 'funding-mixed', 'mint-100'];
  for (const profile of profiles) {
    const row = JSON.parse(readFileSync(`${prefix}-${profile}.json`, 'utf8'));
    const planned = await compare('plan', row.input);
    assert.equal(planned.ok, true); assert.deepEqual(planned.result, row.planned);
    const checked = await compare('validate', { ...row.input, plan: row.planned.plan, phase: 'plan' });
    assert.equal(checked.ok, true); assert.equal(checked.result.valid, true);
    const finalized = await compare('finalize', row.finalize);
    assert.equal(finalized.ok, true);
    assert.deepEqual(finalized.result.bundle.transactions, row.transactions);
    const changed = structuredClone(row.finalize); changed.approval.bindingHash = '00'.repeat(32);
    assert.equal((await compare('finalize', changed)).ok, false);
  }
  console.log(JSON.stringify({ result: 'NFT_RUNTIME_PAIRING_PASS', vectors: profiles.length, calls,
    nativeSha256: hash(native), wasmSha256: hash(wasmPath), networkRequests: 0, broadcasts: 0,
    deviceAcceptance: false }));
} catch (error) {
  console.error(error instanceof Error ? error.message.split('\n')[0] : 'NFT runtime pairing failed');
  process.exitCode = 1;
} finally { rmSync(temporary, { recursive: true, force: true }); }
