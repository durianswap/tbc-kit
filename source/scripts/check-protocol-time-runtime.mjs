// Synthetic public fixture only: Native/WASM parity, no key access or network.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile, mkdir, writeFile, copyFile} from 'node:fs/promises';
import {resolve, join, dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {hashCanonical, TWS_RELEASE_FINGERPRINT} from '../packages/core/dist/esm/index.js';
import {createWasmTbcEngineBackend} from '../packages/tbc-engine/dist/esm/wasm.js';

const root = resolve(import.meta.dirname, '..');
assert.ok(process.argv[2], 'New evidence directory required');
const out = resolve(process.argv[2]);
await mkdir(out); // Never overwrite prior evidence or a frozen candidate.
const engine = join(root, 'packages/tbc-engine');
const native = join(engine, 'artifacts/native/aarch64-apple-darwin/libtbc_engine_native.dylib');
const wasmPath = join(engine, 'artifacts/wasm/tbc_engine_wasm.wasm');
const runner = join(out, 'native-runner');
execFileSync('cc', [join(engine, 'scripts/native-artifact-runner.c'), native,
  '-I', join(engine, 'rust/crates/tbc-engine-native/include'),
  `-Wl,-rpath,${dirname(native)}`, '-o', runner]);
const wasm = await createWasmTbcEngineBackend(await readFile(wasmPath));
const fixture = JSON.parse(await readFile(join(engine, 'rust/fixtures/tbc-transfer.json')));
const sha = b => createHash('sha256').update(b).digest('hex');
const checks = [];
async function parity(method, input, label) {
  const json = JSON.stringify(input);
  const a = await wasm.call(method, json);
  const b = execFileSync(runner, [method, json], {encoding:'utf8', maxBuffer:4*1024*1024});
  assert.equal(a, b, label);
  checks.push({label, method, inputHash:sha(json), resultHash:sha(a)});
  return JSON.parse(a);
}
for (const method of ['plan','validate','finalize']) {
  const result = await parity(method, fixture[`${method}Input`], `unchanged seconds ${method}`);
  assert.equal(result.ok, true);
  assert.deepEqual(result.result, fixture[method === 'plan' ? 'plan' : method === 'validate' ? 'validation' : 'finalized']);
}
const input = structuredClone(fixture.planInput);
input.request.constraints.expiresAt = '2026-08-31T12:02:00Z';
input.requestHash = hashCanonical(input.request);
input.snapshot.payload.capturedAt = '2026-08-31T12:00:00.123Z';
input.snapshot.payload.expiresAt = '2026-08-31T12:02:00.001Z';
input.snapshot.snapshotHash = hashCanonical(input.snapshot.payload);
input.policy.payload.expiresAt = '2026-08-31T12:03:00.000Z';
input.policy.policyHash = hashCanonical(input.policy.payload);
const planned = await parity('plan', input, 'mixed precision earliest expiry');
assert.equal(planned.ok, true);
const plan = planned.result.plan;
assert.equal(plan.payload.expiresAt, '2026-08-31T12:02:00Z');
const validated = await parity('validate', {...input, phase:'plan', plan}, 'mixed precision validation');
assert.equal(validated.ok, true);
assert.equal(validated.result.valid, true, JSON.stringify(validated.result.violations));
const finalInput = {...structuredClone(fixture.finalizeInput), ...input, plan};
finalInput.binding.payload.requestHash = input.requestHash;
finalInput.binding.payload.operationHash = plan.planHash;
finalInput.binding.payload.expiresAt = plan.payload.expiresAt;
finalInput.binding.bindingHash = hashCanonical(finalInput.binding.payload);
finalInput.approval.bindingHash = finalInput.binding.bindingHash;
finalInput.approval.approvedAt = '2026-08-31T12:00:10.123Z';
finalInput.approval.expiresAt = plan.payload.expiresAt;
const finalized = await parity('finalize', finalInput, 'millisecond approval with seconds binding');
assert.equal(finalized.ok, true);
assert.deepEqual(finalized.result.bundle.transactions, fixture.finalized.bundle.transactions,
  'off-chain timestamps must not change transaction bytes, IDs or signatures');
const altered = structuredClone(finalInput);
altered.binding.payload.expiresAt = '2026-08-31T12:02:00.000Z';
assert.equal((await parity('finalize', altered, 'equivalent instant cannot rewrite binding')).ok, false);
const extended = structuredClone(finalInput);
extended.approval.expiresAt = '2026-08-31T12:02:00.001Z';
assert.equal((await parity('finalize', extended, 'receipt cannot extend expiry by 1ms')).ok, false);
await copyFile(native, join(out, 'libtbc_engine_native.dylib'));
await copyFile(wasmPath, join(out, 'tbc_engine_wasm.wasm'));
const evidence = {status:'PASS_PROTOCOL_TIME_NATIVE_WASM_CONTROLLED', recordedAt:new Date().toISOString(),
  protocolFingerprint:TWS_RELEASE_FINGERPRINT, checks,
  nativeSha256:sha(await readFile(native)), wasmSha256:sha(await readFile(wasmPath)),
  checkerSha256:sha(await readFile(new URL(import.meta.url))),
  realNetwork:false, realBroadcast:false, deviceAcceptance:false};
evidence.sourceHashes = {};
for (const relative of [
  'schemas/common.schema.json',
  'packages/core/src/protocol-time.ts',
  'packages/tbc-engine/rust/crates/tbc-engine-core/src/plan.rs',
  'packages/tbc-engine/rust/crates/tbc-engine-core/src/validate.rs',
  'packages/tbc-engine/rust/crates/tbc-engine-core/src/families/tbc.rs',
  'packages/tbc-engine/rust/crates/tbc-engine-core/src/families/ft.rs',
]) evidence.sourceHashes[relative] = sha(await readFile(join(root, relative)));
await writeFile(join(out, 'evidence.json'), JSON.stringify(evidence,null,2)+'\n');
console.log(JSON.stringify({status:evidence.status, checks:checks.length}));
