import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [rootArg, vectorsArg, reportArg] = process.argv.slice(2);
if (!rootArg || !vectorsArg || !reportArg) throw new Error('usage: candidate-root compatibility-vectors report');
const root = resolve(rootArg);
const engine = join(root, 'packages/tbc-engine');
const { hashCanonical } = await import(pathToFileURL(join(root, 'packages/core/dist/esm/index.js')));
const { createWasmTbcEngineBackend } = await import(pathToFileURL(join(engine, 'dist/esm/wasm.js')));
const vectors = JSON.parse(readFileSync(vectorsArg, 'utf8'));
const cases = [];
const clone = (value) => structuredClone(value);
async function bind(input) {
  input.snapshot.snapshotHash = await hashCanonical(input.snapshot.payload);
  return input;
}
function removeNativeParents(input) {
  const payload = input.snapshot.payload;
  const ids = new Set(payload.utxos.filter((u) => u.classification === 'native').map((u) => u.txid));
  payload.parents = payload.parents.filter((p) => !ids.has(p.txid));
  return input;
}
for (const name of ['lowercaseFt', 'unicodeFt', 'longMetadataFt']) {
  cases.push({ name: `${name}-with-native-parent`, input: clone(vectors[name].planInput) });
  cases.push({ name: `${name}-descriptor-only`, input: await bind(removeNativeParents(clone(vectors[name].planInput))), sameAs: `${name}-with-native-parent` });
}
const base = removeNativeParents(clone(vectors.lowercaseFt.planInput));
const candidates = clone(base);
const native = candidates.snapshot.payload.utxos.find((u) => u.classification === 'native');
assert(native);
candidates.snapshot.payload.utxos.unshift({ ...native, txid: 'fe'.repeat(32), satoshis: (BigInt(native.satoshis) * 2n).toString() });
candidates.snapshot.payload.utxos.push({ ...native, txid: 'fd'.repeat(32), satoshis: '1' });
cases.push({ name: 'skip-insufficient-and-larger-native-descriptors', input: await bind(candidates), sameAs: 'lowercaseFt-with-native-parent' });
for (const [index, txid] of ['', 'invalid-txid', '0'.repeat(63), '0'.repeat(65), 'g'.repeat(64), 'A'.repeat(64)].entries()) {
  const input = clone(base);
  input.snapshot.payload.utxos.find((u) => u.classification === 'native').txid = txid;
  cases.push({ name: `bad-native-txid-${index}`, input: await bind(input), error: 'INVALID_INPUT' });
}
for (const name of ['foreign-native-script', 'duplicate-native-outpoint', 'missing-asset-ancestry', 'malformed-supplied-native-parent']) {
  const input = clone(base);
  const payload = input.snapshot.payload;
  const funding = payload.utxos.find((u) => u.classification === 'native');
  if (name === 'foreign-native-script') funding.scriptPubKey = '51';
  if (name === 'duplicate-native-outpoint') payload.utxos.push(clone(funding));
  if (name === 'missing-asset-ancestry') payload.parents = [];
  if (name === 'malformed-supplied-native-parent') payload.parents.push({ txid: funding.txid, rawTransaction: '00' });
  cases.push({ name, input: await bind(input), error: 'INVALID_ANCESTRY' });
}

// Compare transaction wire templates, signing digests and fees, not material hashes.
function businessProjection(value, path = '', found = []) {
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      const next = `${path}/${key}`;
      if (['unsignedTransaction', 'digest', 'totalFee'].includes(key)) found.push([next, child]);
      else businessProjection(child, next, found);
    }
  }
  return found;
}
function checkResponses(backend, responses) {
  const accepted = new Map();
  return cases.map((test, index) => {
    const response = responses[index];
    if (test.error) {
      assert.equal(response.ok, false, `${backend}: ${test.name}`);
      assert.equal(response.error.code, test.error, `${backend}: ${test.name}`);
    } else {
      assert.equal(response.ok, true, `${backend}: ${test.name}: ${JSON.stringify(response)}`);
      const projection = businessProjection(response);
      assert(projection.some(([key]) => key.endsWith('/unsignedTransaction')), 'plan wire evidence missing');
      if (test.sameAs) assert.deepEqual(projection, accepted.get(test.sameAs), `${backend}: business plan changed`);
      accepted.set(test.name, projection);
    }
    return { backend, name: test.name, passed: true, expectedError: test.error ?? null };
  });
}
const wasmPath = join(engine, 'artifacts/wasm/tbc_engine_wasm.wasm');
const wasm = await createWasmTbcEngineBackend(readFileSync(wasmPath));
const wasmResponses = [];
for (const test of cases) wasmResponses.push(JSON.parse(await wasm.call('plan', JSON.stringify(test.input))));
const checks = checkResponses('wasm', wasmResponses);
const nativePath = join(engine, `artifacts/native/${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-apple-darwin/libtbc_engine_native.dylib`);
const python = String.raw`
import ctypes, json, sys
class Buffer(ctypes.Structure):
    _fields_ = [('ptr', ctypes.POINTER(ctypes.c_ubyte)), ('len', ctypes.c_size_t), ('cap', ctypes.c_size_t)]
lib = ctypes.CDLL(sys.argv[1])
lib.tbc_engine_call.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.c_void_p, ctypes.c_size_t]
lib.tbc_engine_call.restype = Buffer
lib.tbc_engine_free.argtypes = [Buffer]
responses = []
for item in json.load(sys.stdin):
    method = b'plan'
    payload = json.dumps(item, separators=(',', ':'), ensure_ascii=False).encode('utf-8')
    buffer = lib.tbc_engine_call(method, len(method), payload, len(payload))
    try:
        responses.append(json.loads(ctypes.string_at(buffer.ptr, buffer.len)))
    finally:
        lib.tbc_engine_free(buffer)
print(json.dumps(responses, separators=(',', ':')))
`;
const nativeResponses = JSON.parse(execFileSync('python3', ['-c', python, nativePath], {
  input: JSON.stringify(cases.map((test) => test.input)), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
}));
checks.push(...checkResponses('native', nativeResponses));
assert.deepEqual(nativeResponses, wasmResponses, 'native/WASM response parity');
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const report = { scope: 'Public fixed-key fixtures; offline plan only; no signer, POST or broadcast', checks, count: checks.length,
  parity: true, artifacts: { wasm: { path: wasmPath, sha256: sha256(wasmPath) }, native: { path: nativePath, sha256: sha256(nativePath) } } };
writeFileSync(reportArg, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ count: checks.length, parity: true, report: reportArg }));
