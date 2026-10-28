// Offline public fixtures. No node queries, signatures, broadcasts or delivery writes.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWasmTbcKeylessEngine } from '../../kit/dist/esm/index.native.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const target = execFileSync('rustc', ['-vV'], { encoding: 'utf8' }).match(/^host: (.+)$/m)?.[1];
assert.ok(target?.endsWith('apple-darwin'), 'This local artifact check uses the macOS Native runtime');
const native = join(root, 'artifacts/keyless-native', target, 'libtbc_keyless_native.dylib');
const temporary = mkdtempSync(join(tmpdir(), 'tbc-nft-collection-parity-'));
try {
  const runner = join(temporary, 'runner');
  execFileSync('cc', [join(root, 'scripts/keyless-native-runner.c'), `-I${dirname(native)}`, native,
    `-Wl,-rpath,${dirname(native)}`, '-o', runner], { stdio: 'pipe' });
  const out = execFileSync('cargo', ['test', '--locked', '--offline', '-p', 'tbc-keyless-core',
    '--test', 'nft_collection', '--', '--nocapture', '--test-threads=1'], {
    cwd: join(root, 'rust'), env: { ...process.env, NFT_COLLECTION_DUMP_WIRE: '1' },
    encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const marker = 'NFT_COLLECTION_WIRE:';
  const records = out.split('\n').filter(line => line.includes(marker)).map(line => JSON.parse(line.slice(line.indexOf(marker) + marker.length)));
  assert.equal(records.length, 3);
  const wasm = await createWasmTbcKeylessEngine(readFileSync(join(root, '../kit/artifacts/wasm/tbc_keyless_wasm.wasm')));
  for (const { input, result } of records) {
    const json = JSON.stringify(input);
    assert.deepEqual(JSON.parse(execFileSync(runner, ['inspectTokenMaterial', json], { encoding: 'utf8' })), result);
    assert.deepEqual(JSON.parse(await wasm.execute('inspectTokenMaterial', json)), result);
  }
  console.log(JSON.stringify({ result: 'NFT_COLLECTION_NATIVE_WASM_PASS', vectors: records.length,
    includesPushData4: true, networkRequests: 0, broadcasts: 0, deliveryArtifactsChanged: false }));
} catch (error) {
  console.error(error instanceof Error ? error.message.split('\n')[0] : 'NFT collection parity failed');
  process.exitCode = 1;
} finally { rmSync(temporary, { recursive: true, force: true }); }
