import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire, registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import test from 'node:test';
import { build } from 'esbuild';
import { secp256k1, schnorr } from '@noble/curves/secp256k1.js';
import { signControlledTask } from '../examples/shared/controlled-signer.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const aliases = Object.fromEntries([
  ['core', 'core/src/index.ts'], ['host', 'host/src/index.ts'],
  ['provider/in-memory', 'provider/src/in-memory.ts'], ['provider', 'provider/src/index.ts'],
  ['wallet-standard', 'wallet-standard/src/index.ts'], ['tbc-engine/native', 'tbc-engine/src/native.ts'],
  ['tbc-engine/wasm', 'tbc-engine/src/wasm.ts'], ['tbc-engine', 'tbc-engine/src/index.ts'],
].map(([name, path]) => [`@tbc-wallet/${name}`, join(root, 'packages', path)]));
const built = await build({ stdin: { contents: `
  export {createDefaultTbcTestnetNetwork} from './packages/kit/src/default-network.ts';
  export {createWasmTbcKeylessEngine} from './packages/kit/src/keyless.ts';
  export {createTbcEngine,createWasmTbcEngineBackend} from './packages/kit/src/engine.ts';
  export {createMemoryTwsHostStore} from './packages/host/src/index.ts';
  export {createTbcWallet} from './packages/kit/src/wallet-runtime.ts';
  export {createTbcClient} from './packages/kit/src/client.ts';
`, resolveDir: root, loader: 'ts' }, bundle: true, write: false, platform: 'node', format: 'esm', alias: aliases, logLevel: 'silent' });
const virtual = new URL('./.host-port-business-errors-source.mjs', import.meta.url).href;
const hooks = registerHooks({
  resolve(s, c, n) { return s === virtual ? { url: virtual, shortCircuit: true } : n(s, c); },
  load(u, c, n) { return u === virtual ? { source: built.outputFiles[0].text, format: 'module', shortCircuit: true } : n(u, c); },
});
let kit = await import(virtual); hooks.deregister();
// The same business assertions also run against the actual clean-installed tarball.
if (process.env.TBC_TEST_INSTALLED_KIT) {
  const installed = process.env.TBC_TEST_INSTALLED_KIT;
  kit = { ...await import(pathToFileURL(join(installed, 'dist/esm/index.node.js'))),
    ...await import(pathToFileURL(join(installed, 'dist/esm/wallet.node.js'))),
    ...await import(pathToFileURL(join(installed, 'dist/esm/engine.node.js'))) };
}
// Point at an accepted runtime to test a JS-only fix without rebuilding Native.
const wasm = process.env.TBC_TEST_WASM_DIR ?? join(root, 'packages/kit/artifacts/wasm');
const native = await kit.createWasmTbcKeylessEngine(await readFile(join(wasm, 'tbc_keyless_wasm.wasm')));
const backend = await kit.createWasmTbcEngineBackend(await readFile(join(wasm, 'tbc_engine_wasm.wasm')));
const tbc = createRequire(import.meta.url)('tbc-lib-js');
const fixture = JSON.parse(await readFile(join(root, 'packages/tbc-engine/rust/fixtures/amm-explicit173-lifecycle.json'), 'utf8'));
const row = fixture.cases.find(c => !c.controlled && !c.locked);
const tokenFixture = JSON.parse(await readFile(join(root, 'packages/tbc-engine/rust/fixtures/tbc20-standard-transfer.json'), 'utf8'));
const zeroPoint = { txid: '00'.repeat(32), vout: 2 };
const fixtureScalar = '01'.padStart(64, '0'); // Public synthetic fixture, never a real account.
const address = '1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH';
const account = { address, chainId: 'tbc:testnet', accountId: `tbc:testnet:${address}`,
  publicKey: Buffer.from(secp256k1.getPublicKey(fixtureScalar, true)).toString('hex') };
const nowMs = Date.parse('2026-11-01T00:00:00Z');
const now = () => new Date(nowMs).toISOString();
const origin = 'https://controlled-port-errors.example';
const funding = new tbc.Transaction().from({ txId: 'aa'.repeat(32), outputIndex: 0,
  script: tbc.Script.buildPublicKeyHashOut(address).toHex(), satoshis: 1001000 }).to(address, 1000000);
funding.version = 10;
const fundingRaw = funding.uncheckedSerialize();
const fundingId = funding.id;
function permission(capability) {
  return { id: `controlled-${capability}`, parentCapability: capability, invoker: origin, date: nowMs,
    caveats: [{ type: 'restrictChains', value: [account.chainId] }, { type: 'restrictAccounts', value: [account.accountId] },
      { type: 'restrictMethods', value: [capability] }] };
}

async function setup({ empty = false, reject = false, ecdsaOnly = false, materialNative = native,
  tokenMode = false, zeros = false, corrupt = false, lpMode = false } = {}) {
  const stateId = empty ? row.genesisId : row.actions.find(a => a.operation === 'buy').txid;
  const stateRaw = fixture.raws[stateId];
  const stateTx = new tbc.Transaction(stateRaw);
  const state = JSON.parse(await native.execute('inspectAmmMaterial', JSON.stringify({
    phase: 'inspectPool', pool: { txid: stateId, rawTransaction: stateRaw },
  })));
  const ftTx = new tbc.Transaction(fixture.raws[row.ftGenesisId]);
  const tokenId = tokenMode ? tokenFixture.stages[1].txid : row.ftGenesisId;
  const tokenGenesis = tokenMode ? new tbc.Transaction(tokenFixture.stages[1].signedRaw) : ftTx;
  const holderId = tokenMode ? tokenFixture.stages[2].txid : row.actions.find(a => a.operation === 'add').txid;
  const holderRows = tokenMode ? tokenFixture.stages[2].tokenOutputs.map(t => ({ txid: holderId, index: t.codeVout, tbc_value: '500', ft_value: t.amount, height: 999 }))
    : [{ txid: holderId, index: lpMode ? 4 : 6, tbc_value: '500', ft_value: lpMode ? '100000' : '800000', height: 999 }];
  if (corrupt) holderRows[0].ft_value = '-1';
  const indexRows = zeros ? [{ txid: zeroPoint.txid, index: zeroPoint.vout, tbc_value: '500', ft_value: '0' }, ...holderRows,
    { txid: 'ff'.repeat(32), index: 2, tbc_value: '500', ft_value: '0' }] : holderRows;
  const trace = [], ports = [], accepted = [];
  let approvals = 0, signatures = 0;
  const network = kit.createDefaultTbcTestnetNetwork({ accounts: { current: async () => [account] },
    poolNative: materialNative, now: () => nowMs, snapshotId: () => 'controlled-business-errors',
    async fetch(input, init) {
      const url = new URL(String(input));
      assert.equal(url.origin, 'https://api.tbcdev.org');
      assert.equal(init?.method ?? 'GET', 'GET', 'No actual broadcast transport');
      const path = url.pathname; trace.push(path);
      let data;
      if (path === '/api/tbc/nodeinfo') data = { blocks: 1000, bestblockhash: 'bb'.repeat(32) };
      else if (path === `/api/tbc/utxo/address/${address}`) data = { utxos: [{ txid: fundingId, index: 0, value: 1000000, height: 999 }] };
      else if (path.startsWith('/api/tbc/txraw/txid/')) {
        const id = path.split('/').at(-1);
        const raw = id === fundingId ? fundingRaw : tokenFixture.stages.find(s => s.txid === id)?.signedRaw ?? fixture.raws[id]; assert.ok(raw, `Unexpected proof ${id}`);
        data = { txraw: raw };
      } else if (path === `/api/tbc/ft/info/contract/${tokenId}`) data = {
        code_script: tokenGenesis.outputs[0].script.toHex(), tape_script: tokenGenesis.outputs[1].script.toHex(), amount: tokenMode ? tokenFixture.request.mintAmount : '10000000',
        name: 'Controlled Token', symbol: 'CT', decimal: 0,
      };
      else if (path.startsWith('/api/tbc/ft/utxo/combinescript/')) data = { utxos: path.includes('751e76e8199196d454941c45d1b3a323f1433bd600/contract/')
        ? indexRows : [{ txid: stateId, index: 5, tbc_value: '500', ft_value: state.state.ftAmount, height: 999 }] };
      else if (path.startsWith('/api/tbc/pool/lputxo/scriptpubkeyhash/')) data = { utxos: indexRows };
      else if (path === `/api/tbc/pool/poolinfo/poolid/${row.genesisId}`) data = {
        txid: stateId, vout: '0', value: String(stateTx.outputs[0].satoshis), pool_code_script: stateTx.outputs[0].script.toHex(),
        ft_contract_id: row.ftGenesisId, token_balance: state.state.ftAmount, lp_balance: state.state.lpAmount,
        tbc_balance: state.state.tbcAmount, service_fee_rate: '140',
      };
      else throw Error(`Unexpected controlled GET ${path}`);
      return new Response(JSON.stringify({ code: '200', data }), { status: 200 });
    },
    broadcast: { submit() { throw Error('Direct network broadcast forbidden'); }, reconcile() { throw Error('Not required'); } },
  });
  const runtime = kit.createTbcWallet({ accounts: { current: async () => [account] },
    engine: kit.createTbcEngine({ backend }),
    storage: { hostStore: kit.createMemoryTwsHostStore({ now: () => nowMs }),
      loadPermissions: async () => ({ revision: '0', permissions: ['tbc_accounts', 'tbc_sendTransaction'].map(permission) }),
      commitPermissions: async params => ({ revisions: params.changes.map(({ scope }) => ({ scope, revision: '1' })) }),
    },
    network: {
      resolveChainData(params, _call, active) { ports.push('chainData.resolve'); return network.resolveChainData(params, active); },
      resolvePolicy(params) { ports.push('policy.resolve'); return network.resolvePolicy(params); },
      async broadcastSubmit(params) { accepted.push(params.transaction); return { txid: params.transaction.txid, status: 'accepted' }; },
      broadcastReconcile() { throw Error('Unexpected reconciliation'); },
    },
    approval: { async request(params) {
      if (params.binding.payload.operationKind !== 'permission') {
        approvals++;
        if (reject) return { status: 'rejected', bindingHash: params.binding.bindingHash, rejectedAt: now() };
      }
      return { status: 'approved', approvalId: 'controlled-approval', approvalToken: 'controlled-token',
        bindingHash: params.binding.bindingHash, approvedAt: now(), expiresAt: params.binding.payload.expiresAt };
    } },
    signer: { async sign(params) {
      signatures++;
      if (ecdsaOnly && params.task.algorithm === 'secp256k1-schnorr-bip340') {
        return { portError: { name: 'SIGNATURE_FAILED', retryable: false, message: 'private-vault-diagnostic' } };
      }
      return signControlledTask(params.task, fixtureScalar);
    } }, clock: now, randomBytes: n => Uint8Array.from({ length: n }, (_, i) => i),
  });
  const session = await runtime.openSession({ origin, sessionId: 'controlled-port-errors' });
  let id = 0;
  const provider = { async request({ method, params }) {
    const { response } = await session.handleRequest({ id: `controlled-${++id}`, method, params });
    if (response.error) throw Object.assign(new Error(response.error.message), { code: response.error.code, data: response.error.data });
    return response.result;
  }, on() {}, removeListener() {}, destroy() {} };
  const wallet = await kit.createTbcClient({ network: 'testnet', provider }).connect();
  return { wallet, trace, ports, accepted, session, tokenId, holderRows,
    poolPoints: [{ txid: stateId, vout: 0 }, { txid: stateId, vout: 5 }],
    feePoint: { txid: fundingId, vout: 0 }, counts: () => ({ approvals, signatures }) };
}

const zeroBusiness = {
  transfer: s => ({ run: constraints => s.wallet.tbc20.transfer({ contractId: s.tokenId, receivers: [{ to: address, amount: '1000' }], constraints }) }),
  merge: s => ({ run: constraints => s.wallet.tbc20.merge({ contractId: s.tokenId, constraints }) }),
  htlc: s => ({ run: constraints => s.wallet.htlc.lock({ assetStandard: 'tbc20-standard', contractId: s.tokenId,
    to: address, amount: '1000', hashlock: 'ab'.repeat(32), lockTime: '2000', constraints }) }),
  order: s => ({ run: constraints => s.wallet.lop.create({ order: { market: 'native-token', side: 'buy',
    assetA: { standard: 'tbc20-standard', contractId: s.tokenId }, saleVolume: '1000', unitPrice: '1000000', feeRate: '0', feeRecipient: address }, constraints }) }),
  addLiquidity: s => ({ run: constraints => s.wallet.amm.addLiquidity({ poolContractId: row.genesisId, amount: '1000', budgetAsset: 'tbc', minimumLpAmount: '1', constraints }) }),
  swap: s => ({ run: constraints => s.wallet.amm.swap({ poolContractId: row.genesisId, direction: 'ft-to-tbc', amount: '1000', minimumOutput: '1', receiver: address, constraints }) }),
  lpTransfer: s => ({ run: constraints => s.wallet.tbc20Lp.transfer({ poolContractId: row.genesisId, to: address, amount: '1000', constraints }) }),
};
const tokenModeFor = kind => ['transfer', 'merge', 'htlc', 'order'].includes(kind);

test('positive-only hot-path metrics', async t => {
  const metrics = [];
  for (const [kind, action] of Object.entries(zeroBusiness)) {
    const s = await setup({ tokenMode: tokenModeFor(kind), lpMode: kind === 'lpTransfer' });
    try {
      const started = performance.now();
      await action(s).run({ maxFee: '100000', expiresAt: new Date(nowMs + 60000).toISOString() });
      metrics.push({ kind, milliseconds: performance.now() - started, trace: [...s.trace].sort(),
        txids: s.accepted.map(x => x.txid), ...s.counts() });
      assert.equal(s.counts().approvals, 1);
    } finally { s.session.close(); }
  }
  t.diagnostic(`ZERO_HOT_PATH ${JSON.stringify(metrics)}`);
});

for (const [kind, action] of Object.entries(zeroBusiness)) {
  test(`zero holder rows: public ${kind} completes with identical transaction bytes, GETs and one approval`, async () => {
    const snapshots = [];
    for (const zeros of [false, true]) {
      const s = await setup({ tokenMode: tokenModeFor(kind), lpMode: kind === 'lpTransfer', zeros });
      try {
        const result = await action(s).run({ maxFee: '100000', expiresAt: new Date(nowMs + 60000).toISOString() });
        assert.ok(result); assert.equal(s.counts().approvals, 1); assert.ok(s.counts().signatures > 0);
        assert.ok(s.accepted.length > 0);
        assert.equal(s.trace.some(p => p.endsWith(zeroPoint.txid) || p.endsWith('ff'.repeat(32))), false);
        assert.equal(new Set(s.trace).size, s.trace.length, 'No repeated network request');
        snapshots.push({ accepted: s.accepted, trace: [...s.trace].sort(), counts: s.counts() });
      } finally { s.session.close(); }
    }
    assert.deepEqual(snapshots[1], snapshots[0]);
  });
  test(`explicit zero input: public ${kind} fails typed, before approval/signing, without replacement`, async () => {
    const s = await setup({ tokenMode: tokenModeFor(kind), lpMode: kind === 'lpTransfer', zeros: true });
    try {
      await assert.rejects(action(s).run({ inputOutpoints: [zeroPoint, ...s.holderRows.map(r => ({ txid: r.txid, vout: r.index })), s.feePoint, ...(['addLiquidity', 'swap'].includes(kind) ? s.poolPoints : [])] }),
        e => e.code === -32602 && e.data.reason === 'SELECTED_ZERO_BALANCE_INPUT');
      assert.deepEqual(s.counts(), { approvals: 0, signatures: 0 }); assert.equal(s.accepted.length, 0);
      assert.equal(s.trace.some(p => p.endsWith(zeroPoint.txid)), false);
    } finally { s.session.close(); }
  });
  test(`zero filtering does not bypass malformed index amount rejection: ${kind}`, async () => {
    const s = await setup({ tokenMode: tokenModeFor(kind), lpMode: kind === 'lpTransfer', zeros: true, corrupt: true });
    try {
      await assert.rejects(action(s).run({ maxFee: '100000' }));
      assert.deepEqual(s.counts(), { approvals: 0, signatures: 0 }); assert.equal(s.accepted.length, 0);
    } finally { s.session.close(); }
  });
}

test('Coin create 0/6 decimals completes the public client/Host/Engine staged path with one synthetic approval', async () => {
  for (const [decimals, initialSupply] of [[0, '20'], [6, '1000000']]) {
    const s = await setup();
    try {
      const result = await s.wallet.tbc20Stablecoin.create({ name: 'Controlled Coin', symbol: 'CC', decimals, initialSupply,
        constraints: { maxFee: '100000' } });
      assert.equal(s.counts().approvals, 1);
      assert.ok(s.counts().signatures > 1, 'Real staged signer tasks, not an Engine stub');
      assert.equal(s.accepted.length, 2);
      assert.equal(result.transactions.length, 2);
      assert.equal(s.trace.length, 3, 'SDK material only: tip, funding index and funding parent');
      assert.equal(new Set(s.trace).size, s.trace.length, 'No duplicate GET');
    } finally { s.session.close(); }
  }
});

test('current AMM historical-only maintenance returns INVALID_PARAMS before approval or signer', async () => {
  for (const empty of [false, true]) for (const method of ['mergeToken', 'burn']) {
    const s = await setup({ empty });
    try {
      await assert.rejects(method === 'mergeToken' ? s.wallet.amm.mergeToken({ poolContractId: row.genesisId })
        : s.wallet.tbc20Lp.burn({ poolContractId: row.genesisId }), e => e.code === -32602 && e.data.reason === 'UNSUPPORTED_POOL_OPERATION');
      assert.deepEqual(s.counts(), { approvals: 0, signatures: 0 }); assert.equal(s.accepted.length, 0);
      assert.equal(s.trace.length, 3); assert.equal(new Set(s.trace).size, 3);
    } finally { s.session.close(); }
  }
});

test('small AMM sell preserves the actual fee rule but returns a precise typed reason', async () => {
  const s = await setup();
  try {
    await assert.rejects(s.wallet.amm.swap({ poolContractId: row.genesisId, direction: 'ft-to-tbc', amount: '20',
      minimumOutput: '1', receiver: address, constraints: { expiresAt: new Date(nowMs + 60000).toISOString() } }),
    e => e.code === -32602 && e.data.reason === 'AMM_RETAINED_FEE_ZERO');
    assert.deepEqual(s.counts(), { approvals: 0, signatures: 0 }); assert.equal(s.accepted.length, 0);
    // Let the already-started proof GET drain; no retries, holder index or tip.
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(new Set(s.trace).size, s.trace.length);
    assert.ok(s.trace.length <= 6, JSON.stringify(s.trace));
    assert.ok(!s.trace.some(path => path.includes('nodeinfo') || path.includes('/utxo/combinescript/')));
  } finally { s.session.close(); }
});

test('inactive pool remains a distinct conflict, not an internal failure', async () => {
  const s = await setup({ empty: true });
  try {
    await assert.rejects(s.wallet.amm.swap({ poolContractId: row.genesisId, direction: 'ft-to-tbc', amount: '1',
      minimumOutput: '1', receiver: address, constraints: { expiresAt: new Date(nowMs + 60000).toISOString() } }),
    e => e.code === -32000 && e.data.name === 'CONFLICT' && e.data.details.reason === 'AMM_POOL_INACTIVE');
    assert.deepEqual(s.counts(), { approvals: 0, signatures: 0 }); assert.equal(s.accepted.length, 0);
  } finally { s.session.close(); }
});

test('ECDSA-only wallet reports a signing capability failure, does not publish the signed source', async () => {
  const s = await setup({ ecdsaOnly: true });
  try {
    await assert.rejects(s.wallet.tbc20Stablecoin.create({ name: 'Controlled Coin', symbol: 'CC', decimals: 0, initialSupply: '20',
      constraints: { maxFee: '100000' } }), e => e.code === -32000 && e.data.name === 'SIGNING_FAILED' &&
      e.data.stage === 'signing' && !JSON.stringify(e).includes('private-vault'));
    assert.equal(s.counts().approvals, 1);
    assert.equal(s.accepted.length, 0, 'No partial source publication before complete bundle finalization');
    assert.equal(s.trace.length, 3);
  } finally { s.session.close(); }
});

test('controlled signer dispatches exact ECDSA/recoverable/BIP340 profiles without fallback', () => {
  const digest = 'ab'.repeat(32), base = { taskId: 'controlled-task', digest };
  for (const signatureEncoding of ['compact64', 'compact65-recoverable']) {
    const algorithm = signatureEncoding === 'compact64' ? 'secp256k1-ecdsa-sha256d' : 'secp256k1-recoverable-ecdsa-sha256d';
    const result = signControlledTask({ ...base, algorithm, signatureEncoding }, fixtureScalar);
    const signature = signatureEncoding === 'compact64' ? result.signature : result.signature.slice(2);
    assert.equal(secp256k1.verify(signature, digest, account.publicKey, { prehash: false, lowS: true }), true);
    if (signatureEncoding === 'compact65-recoverable') {
      const header = Number.parseInt(result.signature.slice(0, 2), 16); assert.ok(header >= 31 && header <= 34);
    }
  }
  const result = signControlledTask({ ...base, algorithm: 'secp256k1-schnorr-bip340', signatureEncoding: 'schnorr64' }, fixtureScalar);
  assert.equal(schnorr.verify(result.signature, digest, account.publicKey.slice(2)), true);
  for (const [algorithm, signatureEncoding] of [
    ['secp256k1-schnorr-bip340', 'compact64'], ['secp256k1-ecdsa-sha256d', 'schnorr64'], ['unknown', 'compact64'],
    ['secp256k1-ecdsa-sha256d', 'compact65-recoverable'], ['secp256k1-recoverable-ecdsa-sha256d', 'compact64'],
    ['secp256k1-recoverable-ecdsa-sha256d', 'schnorr64'],
  ]) assert.equal(signControlledTask({ ...base, algorithm, signatureEncoding }, fixtureScalar).portError.name, 'SIGNATURE_FAILED');
});
