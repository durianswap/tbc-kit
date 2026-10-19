import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
const walletModule = process.env.TBC_KIT_WALLET_TEST_MODULE
  ? pathToFileURL(process.env.TBC_KIT_WALLET_TEST_MODULE).href
  : new URL('../dist/esm/wallet.js', import.meta.url).href;
const { createTbcWallet } = await import(walletModule);

const chain = 'tbc:testnet';
const address = '1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH';
const account = { accountId: `${chain}:${address}`, address, chainId: chain,
  publicKey: '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798' };
const now = '2026-09-26T00:00:00Z';
const originA = 'https://alpha.example';

function authority(origin, sessionId) {
  const state = {
    currentContext: { sessionId, origin, topOrigin: origin, transport: 'remote', frame: 'top', createdAt: now },
    currentSession: { version: '1.0', scope: { walletProfile: 'tbc-kit-wallet', sessionId },
      state: { version: '1.0', sessionId, revision: '0', connected: true, activeChainId: chain, activeAccountIds: [account.accountId] } },
  };
  return { state, source: { read: async () => structuredClone(state), compareAndSwapSession: async () => { throw new Error('No mutation expected'); } } };
}

function fixture() {
  const observed = { accounts: 0, privileged: 0, origins: [] };
  const forbidden = async () => { observed.privileged++; throw new Error('No privileged work expected'); };
  const runtime = createTbcWallet({
    accounts: { current: async () => { observed.accounts++; return [account]; } },
    approval: { request: forbidden }, signer: { sign: forbidden },
    storage: {
      loadPermissions: async params => {
        observed.origins.push(JSON.stringify(params));
        return { revision: '0', permissions: [{ id: 'alpha-accounts', parentCapability: 'tbc_accounts',
          invoker: originA, date: Date.parse(now), caveats: [
            { type: 'restrictChains', value: [chain] },
            { type: 'restrictAccounts', value: [account.accountId] },
            { type: 'restrictMethods', value: ['tbc_accounts'] },
          ] }] };
      }, commitPermissions: forbidden,
    },
    network: { resolveChainData: forbidden, resolvePolicy: forbidden, broadcastSubmit: forbidden, broadcastReconcile: forbidden },
    legacy: false, clock: () => now,
  });
  return { runtime, observed };
}

test('discovery requires an owned session with explicit platform authority', async () => {
  const { runtime, observed } = fixture();
  await assert.rejects(runtime.standardWallet(), /platform-authorized session/);
  await assert.rejects(runtime.register(), /platform-authorized session/);
  await assert.rejects(runtime.standardWallet({ provider: {} }), /platform-authorized session/);
  assert.equal(observed.accounts, 0);
  const local = await runtime.openSession({ origin: originA, sessionId: 'static-fixture' });
  await assert.rejects(runtime.standardWallet(local), /platform-authorized session/);
  const other = fixture();
  const foreign = await other.runtime.openSession({ authority: authority(originA, 'foreign').source });
  await assert.rejects(runtime.standardWallet(foreign), /platform-authorized session/);
  local.close(); foreign.close();
  assert.equal(observed.privileged, 0);
});

test('two origins keep separate providers and grants without duplicate account reads', async () => {
  const { runtime, observed } = fixture();
  const a = await runtime.openSession({ authority: authority(originA, 'alpha').source });
  const b = await runtime.openSession({ authority: authority('https://beta.example', 'beta').source });
  const before = observed.accounts;
  const [wa, wb] = await Promise.all([runtime.standardWallet(a), runtime.standardWallet(b)]);
  assert.equal(observed.accounts, before);
  assert.equal(wa.accounts[0].chainId, chain);
  assert.equal(wa.accounts, wa.accounts, 'unchanged discovery revision reuses its account projection');
  assert.equal(wa.provider, a.provider); assert.equal(wb.provider, b.provider);
  assert.notEqual(wa.provider, wb.provider);
  assert.deepEqual(await wa.provider.request({ method: 'tbc_accounts' }), [address]);
  assert.deepEqual(await wb.provider.request({ method: 'tbc_accounts' }), []);
  assert.equal(observed.privileged, 0);
  a.close(); b.close();
  assert.deepEqual(wa.accounts, [], 'a closed session no longer advertises stale accounts');
});

test('closed or navigated sessions cannot produce a discovery descriptor', async () => {
  const { runtime } = fixture();
  const bound = authority(originA, 'navigation');
  const session = await runtime.openSession({ authority: bound.source });
  const standard = await runtime.standardWallet(session);
  bound.state.currentContext.origin = 'https://beta.example';
  bound.state.currentContext.topOrigin = 'https://beta.example';
  await assert.rejects(runtime.standardWallet(session), /context changed/);
  await assert.rejects(standard.provider.request({ method: 'tbc_accounts' }));
  session.close();
  await assert.rejects(runtime.register(session), /session is closed/);
});

test('repeated and concurrent registration uses one descriptor and one event', async () => {
  const oldWindow = globalThis.window, oldDocument = globalThis.document;
  globalThis.window = new EventTarget(); globalThis.document = {};
  let events = 0;
  globalThis.window.addEventListener('wallet-standard:register-wallet', () => { events++; });
  try {
    const { runtime, observed } = fixture();
    const session = await runtime.openSession({ authority: authority(originA, 'registration').source });
    const [a, b] = await Promise.all([runtime.standardWallet(session), runtime.standardWallet(session)]);
    assert.equal(a, b);
    await Promise.all([runtime.register(session), runtime.register(session), runtime.register(session)]);
    assert.equal(events, 1); assert.equal(observed.accounts, 1); assert.equal(observed.privileged, 0);
    session.close();
  } finally {
    if (oldWindow === undefined) delete globalThis.window; else globalThis.window = oldWindow;
    if (oldDocument === undefined) delete globalThis.document; else globalThis.document = oldDocument;
  }
});
