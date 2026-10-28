import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createDefaultTbcTestnetNetwork, createDefaultTbcChainDataResolver,
  createLazyBundledWasmTbcKeylessEngine } from '../dist/esm/wallet.node.js';
import { createTbcEngine, createWasmTbcEngineBackend } from '../dist/esm/engine.js';
import { assertTestnetAddress, inspectTbcTransaction, turingTransactionId } from '../dist/esm/api.js';

// Public synthetic NEVER FUND data. These parents exercise material admission
// and Engine planning, not previous transaction signatures or chain consensus.
const fixture = JSON.parse(await readFile(new URL('./fixtures/controlled-pool-key1.json', import.meta.url), 'utf8'));
const chainId = 'tbc:testnet', address = fixture.address, contractId = fixture.ftContractId;
const account = { chainId, accountId: `${chainId}:${address}`, address,
  publicKey: '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798' };
const now = () => Date.parse('2026-10-27T00:00:00Z');
const engine = createTbcEngine({ backend: await createWasmTbcEngineBackend(await readFile(
  new URL('../artifacts/wasm/tbc_engine_wasm.wasm', import.meta.url))) });
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

async function prepare(amount, { count = 6, nativeCount = 1, maxInputs, mutateCandidate, mutateRaw } = {}) {
  const { raws, candidates } = fragmentedMaterial(count);
  mutateCandidate?.(candidates); mutateRaw?.(raws, candidates);
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
  const snapshot = await resolver({ version: '1.0', chainId, accountId: account.accountId, requirement: {
    intentType: 'tbc20.transfer', contractIds: [contractId], includeAncestry: true,
    assets: [{ kind: 'native' }, { kind: 'ft', contractId, minimumAmount: String(amount) }],
  } }, account);
  return { network, snapshot, trace, candidates, amount };
}

async function plan(prepared) {
  assert.equal(prepared.snapshot.portError, undefined, JSON.stringify(prepared.snapshot.portError));
  const normalized = await engine.normalizeRequest({ version: '1.0', request: {
    version: '1.0', chainId, from: address,
    intent: { version: '1.0', type: 'tbc20.transfer', contractId, to: address, amount: String(prepared.amount) },
    constraints: { maxFee: '50000', expiresAt: '2026-10-27T00:02:00Z' },
  } });
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
