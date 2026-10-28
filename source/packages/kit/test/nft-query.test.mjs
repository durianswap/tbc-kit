import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';
import { createTbc721Reader, assertTestnetAddress } from '../dist/esm/api.js';
import { createTbcClient, createWasmTbcKeylessEngine } from '../dist/esm/index.native.js';

const tbc = createRequire(import.meta.url)('tbc-lib-js');
const owner = '1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH', other = '1cMh228HTCiwS8ZsaakH8A8wze1JR5ZsP';
const slotScript = `${assertTestnetAddress(owner).scriptPubKey}6a0d5630204d696e74204e486f6c64`;
const native = await createWasmTbcKeylessEngine(await readFile(new URL('../artifacts/wasm/tbc_keyless_wasm.wasm', import.meta.url)));
function fixture(mediaBytes = 0, supply = 3) {
  const data = { collectionName: 'Query fixture', description: 'public synthetic only', supply, file: 'a'.repeat(mediaBytes) };
  const tx = new tbc.Transaction().from({ txId: '22'.repeat(32), outputIndex: 0, script: assertTestnetAddress(owner).scriptPubKey, satoshis: 1000000 });
  tx.version = 10;
  tx.addOutput(new tbc.Transaction.Output({ satoshis: 0,
    script: tbc.Script.buildSafeDataOut([Buffer.from(JSON.stringify(data)), Buffer.from('NTape')]) }));
  for (let i = 0; i < supply; i++) tx.addOutput(new tbc.Transaction.Output({ satoshis: 100, script: tbc.Script.fromHex(slotScript) }));
  return { collectionId: tx.id, raw: tx.uncheckedSerialize() };
}
function harness(mediaBytes = 0, supply = 3) {
  const f = fixture(mediaBytes, supply), calls = { raw: 0, index: 0, status: 0, codec: 0 }, requested = [];
  const row = (slot, spent = false) => ({ txid: f.collectionId, index: String(slot), value: '100', scriptPubKey: slotScript, spent });
  const state = { rows: Array.from({ length: supply }, (_, i) => row(i + 1)), statuses: Array.from({ length: supply }, (_, i) => row(i + 1)), failRaw: false, failIndex: false, failStatus: false, raw: f.raw };
  const api = {
    async rawTransaction({ txid }) { calls.raw++; assert.equal(txid, f.collectionId); if (state.failRaw) throw Error('offline'); return { txraw: state.raw }; },
    async utxosByScriptHash() { calls.index++; if (state.failIndex) throw Error('offline'); return { utxos: state.rows }; },
    async txoStatus({ txos }) { calls.status++; requested.push(txos); if (state.failStatus) throw Error('offline'); return { txos: state.statuses.filter(row => txos.some(p => p.index === Number(row.index))) }; },
  };
  const engine = { async execute(op, request) { calls.codec++; return native.execute(op, request); } };
  return { ...f, calls, requested, row, state, api, engine, reader: createTbc721Reader({ api, engine }), input: { collectionId: f.collectionId, address: owner } };
}

test('mint status deduplicates concurrent reads, caches only validated immutable material, and refreshes spent state', async () => {
  const h = harness();
  assert.deepEqual(h.calls, { raw: 0, index: 0, status: 0, codec: 0 });
  const one = h.reader.getMintStatus(h.input), two = h.reader.getMintStatus({ ...h.input });
  assert.equal(one, two);
  const result = await one;
  assert.equal(result.status, 'available'); assert.equal(result.availableCount, 3); assert.deepEqual(result.availableSlots, [1, 2, 3]);
  assert.deepEqual(h.calls, { raw: 1, index: 1, status: 0, codec: 1 });
  h.state.rows = []; h.state.statuses = [1, 2, 3].map(n => h.row(n, true));
  const depleted = await h.reader.getMintStatus(h.input);
  assert.equal(depleted.status, 'exhausted'); assert.equal(depleted.availableCount, 0); assert.equal(depleted.spentCount, 3);
  assert.deepEqual(h.calls, { raw: 1, index: 2, status: 1, codec: 1 });
});

test('index lag reads only missing slots, never turns missing or failed responses into exhaustion', async () => {
  const h = harness(); h.state.rows = [h.row(1)]; h.state.statuses = [h.row(2), h.row(3, true)];
  const result = await h.reader.getMintStatus(h.input);
  assert.equal(result.status, 'available'); assert.deepEqual(result.availableSlots, [1, 2]);
  assert.deepEqual(h.requested[0].map(p => p.index), [2, 3]);
  h.state.statuses = [h.row(2, true)];
  const incomplete = await h.reader.getMintStatus(h.input);
  assert.equal(incomplete.status, 'unknown'); assert.equal(incomplete.reason, 'incomplete-status');
  assert.deepEqual(incomplete.unknownSlots, [3]); assert.equal(incomplete.availableCount, undefined);
  h.state.failStatus = true;
  const failed = await h.reader.getMintStatus(h.input);
  assert.equal(failed.status, 'unknown'); assert.equal(failed.reason, 'status-unavailable');
  assert.deepEqual(failed.availableSlots, [1]); assert.equal(failed.availableCount, undefined);
});

test('owner mismatch and API unavailability do not grant mint permission', async () => {
  const h = harness();
  const result = await h.reader.getMintStatus({ ...h.input, address: other });
  assert.equal(result.status, 'not-owner'); assert.equal(result.collection.ownerAddress, owner); assert.equal(h.calls.status, 0);
  const missing = harness(); missing.state.failRaw = true;
  assert.equal((await missing.reader.getMintStatus(missing.input)).reason, 'collection-unavailable');
  assert.equal(missing.calls.status, 0);
  missing.state.failRaw = false; missing.state.failIndex = true;
  assert.equal((await missing.reader.getMintStatus(missing.input)).status, 'available', 'exact statuses can recover an unavailable script index');
});

test('wrong hash, duplicate or mismatched slot observations fail instead of returning usable slots', async () => {
  for (const alter of [h => { h.state.raw = h.raw.slice(0, -8) + '01000000'; },
    h => { h.state.rows.push(h.row(1)); }, h => { h.state.rows[0] = { ...h.row(1), value: '101' }; },
    h => { h.state.rows = []; h.state.statuses = [h.row(1), h.row(1)]; },
    h => { h.state.rows = []; h.state.statuses = [{ ...h.row(1), scriptPubKey: '51' }]; }]) {
    const h = harness(); alter(h);
    await assert.rejects(h.reader.getMintStatus(h.input));
  }
});

test('large collection Tape uses the shared bounded decoder, not the old 10KB transaction parser limit', async () => {
  const h = harness(70_000);
  assert.equal((await h.reader.getMintStatus(h.input)).availableCount, 3);
  assert.equal(h.calls.raw, 1); assert.equal(h.calls.codec, 1);
});

test('public client exposes lazy wallet-independent mint status using the configured API domain', async () => {
  for (const network of ['mainnet', 'testnet']) {
    const h = harness(), paths = [];
    const client = createTbcClient({ network, materialEngine: h.engine, api: { baseUrl: 'https://nft-query.test', fetch: async input => {
      const url = new URL(String(input)); assert.equal(url.origin, 'https://nft-query.test'); paths.push(url.pathname);
      const data = url.pathname.includes('/txraw/') ? { txraw: h.raw } : { utxos: h.state.rows };
      return new Response(JSON.stringify({ code: '200', data }), { status: 200, headers: { 'content-type': 'application/json' } });
    } } });
    assert.equal(paths.length, 0);
    assert.equal((await client.tbc721.getMintStatus(h.input)).status, 'available');
    assert.equal(paths.length, 2); assert.equal(new Set(paths).size, 2);
  }
});

test('25/26/100/101/4095 missing outputs are queried exactly once in API-sized batches', async () => {
  for (const supply of [25, 26, 100, 101, 4095]) {
    const h = harness(0, supply); h.state.rows = [];
    h.state.statuses = Array.from({ length: supply }, (_, i) => h.row(i + 1, true));
    const query = h.api.txoStatus;
    h.api.txoStatus = async input => { assert.ok(input.txos.length <= 25, 'API limit'); return query(input); };
    const first = h.reader.getMintStatus(h.input), concurrent = h.reader.getMintStatus({ ...h.input });
    assert.equal(first, concurrent, 'one in-flight observation for every chunk');
    const result = await first;
    assert.equal(result.status, 'exhausted'); assert.equal(result.spentCount, supply);
    assert.equal(h.calls.status, Math.ceil(supply / 25));
    assert.deepEqual(h.requested.flat().map(p => p.index), Array.from({ length: supply }, (_, i) => i + 1));
    assert.deepEqual(h.calls, { raw: 1, index: 1, status: Math.ceil(supply / 25), codec: 1 });
  }
});

test('reuse indexed slots and immutable bytes, but refresh mutable statuses after each observation', async () => {
  const h = harness(0, 101);
  assert.equal((await h.reader.getMintStatus(h.input)).availableCount, 101);
  assert.equal(h.calls.status, 0, 'no fallback when index already supplies all slots');
  h.state.rows = Array.from({ length: 75 }, (_, i) => h.row(i + 1));
  h.state.statuses = Array.from({ length: 26 }, (_, i) => h.row(i + 76, true));
  const result = await h.reader.getMintStatus(h.input);
  assert.equal(result.availableCount, 75); assert.equal(result.spentCount, 26);
  assert.deepEqual(h.requested.map(p => p.length), [25, 1]);
  assert.deepEqual(h.requested.flat().map(p => p.index), Array.from({ length: 26 }, (_, i) => i + 76));
  h.state.rows = []; h.state.statuses = Array.from({ length: 101 }, (_, i) => h.row(i + 1, true));
  assert.equal((await h.reader.getMintStatus(h.input)).status, 'exhausted');
  assert.deepEqual(h.calls, { raw: 1, index: 3, status: 7, codec: 1 });
});

test('large reads cap in-flight requests at four and drain them before returning', async () => {
  const h = harness(0, 126); h.state.rows = [];
  const query = h.api.txoStatus;
  let active = 0, maximum = 0;
  h.api.txoStatus = async input => {
    active++; maximum = Math.max(maximum, active);
    try { await new Promise(resolve => setImmediate(resolve)); return await query(input); }
    finally { active--; }
  };
  const result = await h.reader.getMintStatus(h.input);
  assert.equal(result.availableCount, 126);
  assert.equal(maximum, 4); assert.equal(active, 0); assert.equal(h.calls.status, 6);
});

test('failed or incomplete chunks preserve known slots without retry, false exhaustion, or stale caching', async () => {
  const h = harness(0, 76); h.state.rows = [h.row(1)];
  h.state.statuses = Array.from({ length: 76 }, (_, i) => h.row(i + 1, true));
  const query = h.api.txoStatus; let fail = true;
  h.api.txoStatus = async input => { const result = await query(input); if (fail && input.txos[0].index === 27) throw Error('offline'); return result; };
  const result = await h.reader.getMintStatus(h.input);
  assert.equal(result.status, 'unknown'); assert.equal(result.reason, 'status-unavailable');
  assert.deepEqual(result.availableSlots, [1]);
  assert.deepEqual(result.unknownSlots, Array.from({ length: 25 }, (_, i) => i + 27));
  assert.equal(h.calls.status, 3, 'never automatically retry a failed chunk');
  fail = false; h.state.statuses = h.state.statuses.filter(row => row.index !== '76');
  const incomplete = await h.reader.getMintStatus(h.input);
  assert.equal(incomplete.reason, 'incomplete-status'); assert.deepEqual(incomplete.unknownSlots, [76]);
  h.state.statuses.push(h.row(76, true));
  const recovered = await h.reader.getMintStatus(h.input);
  assert.equal(recovered.status, 'available'); assert.equal(recovered.spentCount, 75);
  assert.deepEqual(h.calls, { raw: 1, index: 3, status: 9, codec: 1 });
});

test('each batch rejects foreign, duplicate, cross-batch, or malformed output identities', async () => {
  for (const alter of [
    (h, rows) => [h.row(26, true), ...rows.slice(1)],
    (_h, rows) => [rows[0], rows[0], ...rows.slice(2)],
    (_h, rows) => [{ ...rows[0], txid: 'aa'.repeat(32) }, ...rows.slice(1)],
    (_h, rows) => [{ ...rows[0], index: '01' }, ...rows.slice(1)],
    (_h, rows) => [{ ...rows[0], value: '101' }, ...rows.slice(1)],
    (_h, rows) => [{ ...rows[0], scriptPubKey: '51' }, ...rows.slice(1)],
    (_h, rows) => [{ ...rows[0], spent: 'true' }, ...rows.slice(1)],
    (_h, rows) => [...rows, rows[0]],
  ]) {
    const h = harness(0, 51); h.state.rows = [];
    const query = h.api.txoStatus; let active = 0;
    h.api.txoStatus = async input => {
      active++;
      try { await new Promise(resolve => setImmediate(resolve)); const result = await query(input);
        return input.txos[0].index === 1 ? { txos: alter(h, result.txos) } : result;
      } finally { active--; }
    };
    await assert.rejects(h.reader.getMintStatus(h.input));
    assert.equal(active, 0, 'invalid data must not leave sibling requests running');
  }
});

test('public mainnet/testnet client batches the real API response shape without changing endpoints', async () => {
  for (const network of ['mainnet', 'testnet']) {
    const h = harness(0, 101), batches = [], paths = [];
    const client = createTbcClient({ network, materialEngine: h.engine, api: { baseUrl: 'https://nft-query.test', fetch: async (input, init) => {
      const url = new URL(String(input)); assert.equal(url.origin, 'https://nft-query.test'); paths.push(url.pathname);
      let data;
      if (url.pathname.includes('/txraw/')) data = { txraw: h.raw };
      else if (url.pathname.endsWith('/txo/status')) {
        const { txos } = JSON.parse(init.body); batches.push(txos);
        assert.ok(txos.length <= 25);
        data = { results: txos.map(p => ({ txid: p.txid, index: p.index, value: 100, scriptpubkey: slotScript, status: { spent: true } })) };
      } else data = { utxos: [] };
      return new Response(JSON.stringify({ code: '200', data }), { status: 200, headers: { 'content-type': 'application/json' } });
    } } });
    const result = await client.tbc721.getMintStatus(h.input);
    assert.equal(result.status, 'exhausted'); assert.equal(result.spentCount, 101);
    assert.deepEqual(batches.map(p => p.length), [25, 25, 25, 25, 1]);
    assert.equal(paths.length, 7, 'only raw, slot index and five exact-status batches');
    assert.equal(h.calls.codec, 1);
  }
});
