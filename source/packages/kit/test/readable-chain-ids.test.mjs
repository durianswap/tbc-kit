import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createTbcClient } from '../dist/esm/index.js';
import { createTbcNetworkContext, assertTbcNetworkContext, tbcNetworkNameForChainId } from '../dist/esm/wallet.js';
import { TBC_MAINNET_PROFILE, TBC_TESTNET_PROFILE } from '../dist/esm/engine.js';
import { assertValidTws, hashCanonical, derivePermissionId } from '../../core/dist/esm/index.js';

test('readable official IDs agree across registry, Engine profiles, client and network context without I/O', async () => {
  const registry = JSON.parse(await readFile(new URL('../../../registry/networks.json', import.meta.url)));
  assert.equal(registry.identityPolicy, 'stable-network-name');
  for (const [name, profile, origin] of [
    ['mainnet', TBC_MAINNET_PROFILE, 'https://api.turingbitchain.io'],
    ['testnet', TBC_TESTNET_PROFILE, 'https://api.tbcdev.org'],
  ]) {
    const chainId = `tbc:${name}`;
    const context = createTbcNetworkContext({ network: name });
    assert.equal(profile.chainId, chainId);
    assert.equal(context.chainId, chainId);
    assert.equal(tbcNetworkNameForChainId(chainId), name);
    assert.equal(context.endpoint.apiOrigin, origin);
    assert.deepEqual(assertTbcNetworkContext(context), context);
    const wallet = await createTbcClient({ network: name, provider: {
      request: async ({ method }) => { assert.equal(method, 'tbc_requestAccounts'); return ['1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH']; },
      on() {}, removeListener() {}, destroy() {},
    } }).connect();
    assert.equal(wallet.chainId, chainId);
    assert.equal(registry.networks.find(n => n.network === name).chainId, chainId);
    assertValidTws('switchChainParams', { chainId });
  }
});

test('network binding, permission domain and source caches remain separated', () => {
  const main = createTbcNetworkContext({ network: 'mainnet' });
  const testnet = createTbcNetworkContext({ network: 'testnet' });
  assert.notEqual(main.sourceIdentity, testnet.sourceIdentity);
  assert.notEqual(hashCanonical({ chainId: main.chainId }), hashCanonical({ chainId: testnet.chainId }));
  const scope = { operationId: 'A'.repeat(43), parentCapability: 'tbc_signTransaction', ordinal: 0 };
  assert.notEqual(derivePermissionId({ ...scope, chainId: main.chainId }), derivePermissionId({ ...scope, chainId: testnet.chainId }));
  assert.throws(() => assertTbcNetworkContext({ ...main, chainId: testnet.chainId }), /mismatch/);
  for (const [name, wrong] of [['mainnet', testnet], ['testnet', main]]) {
    assert.throws(() => createTbcNetworkContext({ network: name, endpoint: { kind: 'trusted-custom', apiOrigin: wrong.endpoint.apiOrigin, trustId: 'fixture' } }), /does not match/);
    assert.throws(() => createTbcNetworkContext({ network: name, endpoint: { kind: 'trusted-custom', apiOrigin: 'https://fixture.invalid', rpcOrigin: wrong.endpoint.apiOrigin, trustId: 'fixture' } }), /does not match/);
  }
  assert.throws(() => assertValidTws('switchChainParams', { chainId: 'tbc：testnet' }));
});

test('the old draft IDs are not silently translated into an official network', () => {
  for (const reference of ['000000006ec607045ad2c990de903d04', '0000000000cee779eb6a6c2ce087218a']) {
    assert.throws(() => tbcNetworkNameForChainId(`tbc:${reference}`), /Unsupported/);
  }
});
