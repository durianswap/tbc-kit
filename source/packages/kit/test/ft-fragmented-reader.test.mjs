import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import test, { after } from 'node:test';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { createLazyBundledWasmTbcKeylessEngine } from '../dist/esm/wallet.node.js';
import { createTbcEngine, createWasmTbcEngineBackend } from '../dist/esm/engine.js';
import { assertTestnetAddress, inspectTbcTransaction, turingTransactionId } from '../dist/esm/api.js';

// Test edited source without rebuilding/overwriting the frozen distribution.
const compiled = await build({ stdin: { contents: `
  export { createDefaultTbcTestnetNetwork } from './src/default-network.ts';
  export { createDefaultTbcChainDataResolver } from './src/default-chain-data.ts';
  export { preparedChainDataRequirement } from './src/prepared-chain-data.ts';
  export { createTbcBackendService } from './src/backend-service.ts';
  export { chainDataRequirement } from '@tbc-wallet/core';`, resolveDir: new URL('../', import.meta.url).pathname },
  alias: { '@tbc-wallet/core': new URL('../../core/src/index.ts', import.meta.url).pathname,
    '@tbc-wallet/host': new URL('../../host/src/index.ts', import.meta.url).pathname },
  bundle: true, platform: 'node', format: 'cjs', write: false, external: ['@noble/hashes/*'], logLevel: 'silent' });
const current = { exports: {} };
new Function('module', 'exports', 'require', compiled.outputFiles[0].text)(current, current.exports, createRequire(import.meta.url));
const packedWallet = process.env.TBC_FT_PACKED_ROOT ? await import(pathToFileURL(`${process.env.TBC_FT_PACKED_ROOT}/dist/esm/wallet.node.js`)) : current.exports;
const { createDefaultTbcTestnetNetwork, createDefaultTbcChainDataResolver, createTbcBackendService } = packedWallet;
const { preparedChainDataRequirement, chainDataRequirement } = current.exports;

// Public synthetic NEVER FUND data. These parents exercise material admission
// and Engine planning, not previous transaction signatures or chain consensus.
const fixture = JSON.parse(await readFile(new URL('./fixtures/controlled-pool-key1.json', import.meta.url), 'utf8'));
const chainId = 'tbc:testnet', address = fixture.address, contractId = fixture.ftContractId;
const account = { chainId, accountId: `${chainId}:${address}`, address,
  publicKey: '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798' };
const now = () => Date.parse('2026-10-27T00:00:00Z');
const backend = await createWasmTbcEngineBackend(await readFile(
  process.env.TBC_FT_TEST_WASM ?? new URL('../artifacts/wasm/tbc_engine_wasm.wasm', import.meta.url)));
const wireVectors = new Map();
const engine = createTbcEngine({ backend: { ...backend, call: async (method, input) => {
  const expected = await backend.call(method, input);
  if (process.env.TBC_FT_VECTORS) wireVectors.set(`${method}:${input}`, { method, input, expected });
  return expected;
} } });
after(async () => {
  if (process.env.TBC_FT_VECTORS) await writeFile(process.env.TBC_FT_VECTORS, JSON.stringify([...wireVectors.values()]));
});
const materialNative = createLazyBundledWasmTbcKeylessEngine();
const hex = bytes => Buffer.from(bytes).toString('hex');
const uint = (value, size) => { const b = Buffer.alloc(size); b.writeUIntLE(value, 0, size); return hex(b); };
const varint = n => n < 253 ? uint(n, 1) : `fd${uint(n, 2)}`;
const script = bytes => `${varint(bytes.length)}${hex(bytes)}`;
const creation = inspectTbcTransaction(fixture.rawTransactions[contractId]).transaction;
const source = fixture.ownerCandidate;
const holder = inspectTbcTransaction(fixture.rawTransactions[source.txid]).transaction;
const holderCode = holder.outputs[source.index].scriptPubKey;
const holderTape = holder.outputs[source.index + 1].scriptPubKey;
const nativeRaw = `0a00000001${'33'.repeat(32)}0000000000ffffffff01404b4c000000000019${assertTestnetAddress(address).scriptPubKey}00000000`;
const nativeTxid = turingTransactionId(nativeRaw);

function fragmentedMaterial(count = 6) {
  const raws = new Map(Object.entries(fixture.rawTransactions));
  const candidates = Array.from({ length: count }, (_, index) => {
    const tape = Buffer.from(holderTape);
    tape.fill(0, 3, 51); tape.writeBigUInt64LE(100n, 3);
    const raw = `0a00000001${hex(Buffer.from(source.txid, 'hex').reverse())}${uint(source.index, 4)}00ffffffff02f401000000000000${script(holderCode)}0000000000000000${script(tape)}${uint(index, 4)}`;
    const txid = turingTransactionId(raw); raws.set(txid, raw);
    return { txid, index: 0, tbc_value: '500', ft_value: '100', height: 990 };
  });
  return { raws, candidates };
}

async function prepare(amount, { count = 6, nativeCount = 1, maxInputs, mutateCandidate, mutateRaw, exactCount, kind = 'tbc20.transfer', mutatePoints } = {}) {
  const { raws, candidates } = fragmentedMaterial(count);
  mutateCandidate?.(candidates); mutateRaw?.(raws, candidates);
  const inputOutpoints = exactCount === undefined ? undefined : [
    ...Array.from({ length: nativeCount }, (_, vout) => ({ txid: nativeTxid, vout })),
    ...candidates.slice(0, exactCount).map(c => ({ txid: c.txid, vout: c.index })),
  ];
  if (inputOutpoints !== undefined) mutatePoints?.(inputOutpoints);
  const request = { version: '1.0', chainId, from: address,
    intent: { version: '1.0', type: kind, contractId, ...(kind.endsWith('merge') ? {} : { to: address, amount: String(amount) }) },
    constraints: { maxFee: '50000', expiresAt: '2026-10-27T00:02:00Z', ...(inputOutpoints === undefined ? {} : { inputOutpoints }) } };
  assert.deepEqual(preparedChainDataRequirement(request), chainDataRequirement(request));
  const trace = [];
  const network = createDefaultTbcTestnetNetwork({
    accounts: { current: async () => { throw Error('verified account must be reused'); } },
    poolNative: materialNative, now,
    fetch: async input => {
      const path = new URL(String(input)).pathname; trace.push(path);
      let data;
      if (path === `/api/tbc/utxo/address/${address}`) data = { utxos: Array.from({ length: nativeCount }, (_, index) => ({
        txid: nativeTxid, index, value: '5000000', height: 990,
      })) };
      else if (path === `/api/tbc/ft/info/contract/${contractId}`) data = {
        code_script: hex(creation.outputs[0].scriptPubKey), tape_script: hex(creation.outputs[1].scriptPubKey),
        amount: '1000000', decimal: 0, name: 'Merge Fixture', symbol: 'MRG',
      };
      else if (path.includes('/api/tbc/ft/utxo/combinescript/')) data = { utxos: candidates };
      else {
        const txid = path.match(/^\/api\/tbc\/txraw\/txid\/([0-9a-f]{64})$/)?.[1];
        assert.ok(txid && raws.has(txid), `unexpected extra read: ${path}`);
        data = { txraw: raws.get(txid) };
      }
      return new Response(JSON.stringify({ code: '200', data }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  const resolver = maxInputs === undefined ? network.resolveChainData : createDefaultTbcChainDataResolver({
    accounts: { current: async () => { throw Error('verified account must be reused'); } },
    client: network.client, materialNative, maxInputs, now,
    confirmationPolicy: { minConfirmations: '0' },
  }).resolve;
  const snapshot = await resolver({ version: '1.0', chainId, accountId: account.accountId, requirement: preparedChainDataRequirement(request) }, account);
  return { network, snapshot, trace, candidates, amount, request };
}

async function plan(prepared) {
  assert.equal(prepared.snapshot.portError, undefined, JSON.stringify(prepared.snapshot.portError));
  const normalized = await engine.normalizeRequest({ version: '1.0', request: prepared.request });
  const policy = await prepared.network.resolvePolicy({ version: '1.0', ...normalized, snapshotHash: prepared.snapshot.snapshotHash });
  assert.equal(policy.portError, undefined, JSON.stringify(policy.portError));
  const params = { version: '1.0', ...normalized, snapshot: prepared.snapshot, policy };
  const result = await engine.plan(params);
  assert.deepEqual(await engine.validate({ ...params, phase: 'plan', plan: result.plan }), { valid: true, violations: [] });
  return { ...params, plan: result.plan };
}

test('public FT reader passes six required fragments to Engine maintenance then transfer', async () => {
  const prepared = await prepare(550);
  const result = await plan(prepared);
  assert.equal(prepared.snapshot.payload.utxos.filter(u => u.classification === 'ft').length, 6);
  assert.deepEqual(result.plan.payload.transactions.map(t => t.role), ['maintenance', 'primary']);
  assert.equal(prepared.trace.length, 10, 'three indexes/identity + six needed parents + one shared ancestor');
  assert.equal(new Set(prepared.trace).size, prepared.trace.length, 'no duplicate network request');
  assert.equal(prepared.trace.filter(p => p.endsWith(`/txraw/txid/${source.txid}`)).length, 1);
});

test('twenty required FT fragments produce four merges and one transfer without duplicate reads', async () => {
 for (const nativeCount of [1, 4]) {
  const prepared = await prepare(1950, { count: 20, nativeCount });
  const result = await plan(prepared);
  assert.equal(prepared.snapshot.payload.utxos.filter(u => u.classification === 'ft').length, 20);
  assert.deepEqual(result.plan.payload.transactions.map(t => t.role), [...Array(4).fill('maintenance'), 'primary']);
  assert.equal(prepared.trace.length, 24, 'only needed parents and one shared ancestor, no native parent or tip');
  assert.equal(new Set(prepared.trace).size, prepared.trace.length);
 }
});

test('FT one/five-input paths keep their read budgets and choose no unused fragments', async () => {
  for (const [amount, count] of [[100, 1], [150, 2], [450, 5]]) {
    const prepared = await prepare(amount);
    const result = await plan(prepared);
    assert.equal(prepared.snapshot.payload.utxos.filter(u => u.classification === 'ft').length, count);
    assert.deepEqual(result.plan.payload.transactions.map(t => t.role), ['primary']);
    assert.equal(prepared.trace.length, 4 + count, JSON.stringify(prepared.trace));
    assert.equal(new Set(prepared.trace).size, prepared.trace.length);
  }
});

test('FT six-input plan ignores surplus candidates and enforces parent identity', async () => {
  const bounded = await prepare(550, { count: 8 });
  await plan(bounded);
  assert.equal(bounded.snapshot.payload.utxos.filter(u => u.classification === 'ft').length, 6);
  assert.equal(bounded.trace.length, 10);
  const exactBudget = await prepare(550, { count: 8, maxInputs: 7 });
  assert.equal(exactBudget.snapshot.portError, undefined);
  assert.equal(exactBudget.trace.length, 10);
  const corrupted = await prepare(550, { mutateRaw(raws, candidates) {
    const selected = [...candidates].sort((a, b) => a.txid.localeCompare(b.txid))[0];
    raws.set(selected.txid, raws.get(selected.txid).slice(0, -8) + 'ffffffff');
  } });
  assert.equal(corrupted.snapshot.portError?.name, 'CONFLICT');
});

test('FT insufficient balance and bounded input policy fail before parent downloads', async () => {
  for (const options of [{ amount: 601 }, { amount: 550, maxInputs: 6 }]) {
    const result = await prepare(options.amount, options);
    assert.equal(result.snapshot.portError?.name, 'CONFLICT');
    assert.equal(result.trace.some(p => p.includes('/txraw/')), false);
  }
});

test('historical and unified FT exact paths keep all selected inputs with no duplicate or unrelated reads', async () => {
  for (const kind of ['tbc.ft.transfer', 'tbc20.transfer', 'tbc.ft.merge', 'tbc20.merge']) {
    for (const nativeCount of [1, 2]) {
      const exactCount = kind.endsWith('merge') ? 2 : 6;
      const prepared = await prepare(50, { count: 8, exactCount, nativeCount, kind });
      const result = await plan(prepared);
      const selected = prepared.snapshot.payload.utxos.map(u => `${u.txid}:${u.vout}`).sort();
      assert.deepEqual(selected, prepared.request.constraints.inputOutpoints.map(u => `${u.txid}:${u.vout}`).sort());
      assert.equal(prepared.trace.length, 4 + exactCount, 'three existing indexes + chosen parents + shared ancestor only');
      assert.equal(new Set(prepared.trace).size, prepared.trace.length);
      assert(result.plan.payload.preview.assetFlows.filter(f => f.kind === 'ft').every(f => f.contractId === contractId));
      assert.equal(result.plan.payload.transactions.length, (nativeCount > 1 ? 1 : 0) + (exactCount > 5 ? 2 : 1));
      assert(prepared.trace.every(path => !path.includes('nodeinfo')), 'minConfirmations=0 needs no tip read');
    }
  }
});

test('historical FT exact reader rejects unknown points instead of substituting available balance', async () => {
  const missing = await prepare(50, { exactCount: 2, mutatePoints(points) { points.push({ txid: 'ff'.repeat(32), vout: 0 }); } });
  assert.equal(missing.snapshot.portError?.name, 'CONFLICT');
  assert.equal(new Set(missing.trace).size, missing.trace.length);
  assert(missing.trace.every(path => !path.includes('ff'.repeat(32))), 'never fetch an invented point outside the bound account index');
});

test('exact FT Prepared through Host signs all stages under one complete approval, and rejection signs nothing', async () => {
  for (const approve of [true, false]) {
    const p = await prepare(50, { exactCount: 6, nativeCount: 2 });
    const apiReads = p.trace.length;
    let approvals = 0, signs = 0, materialReads = 0;
    const service = createTbcBackendService({ serviceId: 'org.example.legacy-ft-exact', account, engine,
      network: { resolveChainData: async params => {
        materialReads++;
        assert.deepEqual(params.requirement.inputOutpoints, p.request.constraints.inputOutpoints);
        return p.snapshot;
      }, resolvePolicy: p.network.resolvePolicy },
      clock: () => '2026-10-27T00:00:00Z',
      authorize: async ({ approvalRequest }) => {
        approvals++;
        const flows = approvalRequest.preview.assetFlows.filter(f => f.kind === 'ft');
        assert.equal(flows.length, 1);
        assert.equal(flows[0].contractId, contractId);
        assert.equal(flows[0].amount, '50'); assert.equal(flows[0].to, address);
        return approve ? { status: 'approved', decisionId: 'offline-public-fixture', approvedAt: '2026-10-27T00:00:00Z' }
          : { status: 'rejected', rejectedAt: '2026-10-27T00:00:00Z' };
      }, signer: { sign: async ({ task }) => {
        signs++;
        // Existing synthetic fixture's public key=1. Never funded or broadcast.
        const signature = secp256k1.sign(task.digest, '01'.padStart(64, '0'), { lowS: true, prehash: false });
        return { taskId: task.taskId, signatureEncoding: 'compact64', signature: signature.toCompactHex() };
      } },
    });
    try {
      const prepared = await service.prepareTransaction(p.request);
      const execution = service.executePrepared({ kind: 'transaction', action: 'sign', prepared });
      if (approve) {
        const result = await execution;
        assert.equal(result.transactions.length, 3);
        assert(signs > 2, 'signs the actual dependency stages');
      } else { await assert.rejects(execution); assert.equal(signs, 0); }
      assert.equal(approvals, 1); assert.equal(materialReads, 2, 'preparation and existing wallet-side revalidation');
      assert.equal(p.trace.length, apiReads, 'all execution material is reused; no transport or broadcast configured');
    } finally { service.close(); }
  }
});

test('automatic FT transaction bytes and digests match frozen baseline; optional paired timing', async () => {
  const previous = createTbcEngine({ backend: await createWasmTbcEngineBackend(await readFile(
    process.env.TBC_FT_BASELINE_WASM ?? new URL('../../../../packages/kit/artifacts/wasm/tbc_engine_wasm.wasm', import.meta.url))) });
  const measurements = [];
  for (const amount of [100, 550]) {
    const p = await prepare(amount); const params = await plan(p);
    const { plan: currentPlan, ...planParams } = params;
    const before = await previous.plan(planParams);
    assert.deepEqual(params.plan.payload.transactions, before.plan.payload.transactions);
    assert.deepEqual(params.plan.payload.signingTasks, before.plan.payload.signingTasks);
    const preview = structuredClone(params.plan.payload.preview);
    const priorPreview = structuredClone(before.plan.payload.preview);
    for (const flow of preview.assetFlows) {
      if (flow.kind === 'ft') assert.equal(flow.contractId, contractId, 'current review must identify the asset');
      delete flow.contractId;
    }
    for (const flow of priorPreview.assetFlows) {
      if (flow.contractId !== undefined) assert.equal(flow.contractId, contractId, 'newer frozen baseline must identify the same asset');
      delete flow.contractId;
    }
    assert.deepEqual(preview, priorPreview);
    if (process.env.TBC_FT_BENCH_OUTPUT) {
      for (const method of ['plan', 'validate']) {
        const oldParams = method === 'validate' ? { ...params, phase: 'plan', plan: before.plan } : planParams;
        const newParams = method === 'validate' ? { ...params, phase: 'plan' } : planParams;
        const samples = { before: [], after: [] }, cpuSamples = { before: [], after: [] };
        for (let i = 0; i < 50; i++) {
          for (const label of i % 2 ? ['after', 'before'] : ['before', 'after']) {
            const cpuStart = process.cpuUsage(), start = performance.now();
            await (label === 'before' ? previous : engine)[method](label === 'before' ? oldParams : newParams);
            const elapsed = performance.now() - start, cpu = process.cpuUsage(cpuStart);
            if (i >= 10) { samples[label].push(elapsed); cpuSamples[label].push((cpu.user + cpu.system) / 1000); }
          }
        }
        const stats = values => { values.sort((a,b) => a-b); return { medianMs: values[20], p90Ms: values[35], samples: values.length }; };
        measurements.push({ amount, method, before: stats(samples.before), after: stats(samples.after),
          cpuBefore: stats(cpuSamples.before), cpuAfter: stats(cpuSamples.after), apiReads: p.trace.length });
      }
    }
  }
  if (process.env.TBC_FT_BENCH_OUTPUT) await writeFile(process.env.TBC_FT_BENCH_OUTPUT, JSON.stringify({ runtime: process.version, measurements }, null, 2));
});
