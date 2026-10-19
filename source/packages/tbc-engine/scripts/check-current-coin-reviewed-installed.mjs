// Scope probe, not an expected-rejection test: a legitimate latest Coin holder
// transaction should be reviewable. A rejection produces a delivery GAP, not PASS.
// Public synthetic fixture only; raw/signatures are never printed or persisted.
import assert from 'node:assert/strict';
import {readFile, mkdtemp, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {loadFrozenCoinHarness} from './lib/frozen-coin-harness.mjs';

const env = process.env;
const {kit, keyless, evidence} = await loadFrozenCoinHarness({consumer: env.TBC_COIN_INSTALLED_CONSUMER,
  archive: env.TBC_COIN_INSTALLED_ARCHIVE, source: env.TBC_COIN_FIXTURE_SOURCE,
  signerWasm: env.TBC_COIN_SOURCE_SIGNER_WASM});
globalThis.fetch = () => { throw Error('External HTTP forbidden'); };
const require = createRequire(new URL('../../kit/package.json', import.meta.url));
const tbc = require('tbc-lib-js'); assert.equal(require('tbc-lib-js/package.json').version, '1.0.31');
const fixture = JSON.parse(await readFile(join(env.TBC_COIN_FIXTURE_SOURCE, 'packages/tbc-engine/rust/fixtures/coin-proof.json')));
const account = {address: '1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH', publicKey: fixture.vectors[0].publicKeyHex};
const native = await kit.createWasmTbcKeylessEngine(await readFile(keyless));
const network = kit.createTbcNetworkContext({network: 'testnet', endpoint: {
  kind: 'trusted-custom', apiOrigin: 'https://devapi.tbcdev.org', trustId: 'synthetic-reviewed-probe'}});
const rows = [];
for (const [index, vector] of fixture.vectors.entries()) {
  const parents = new Map([vector.parentRaw, ...vector.ancestorsRaw].map(raw => { const t = new tbc.Transaction(raw); return [t.id, t]; }));
  const signed = new tbc.Transaction(vector.signedRaw);
  const inputData = signed.inputs.map((input, i) => {
    const p = parents.get(input.prevTxId.toString('hex')); assert.ok(p);
    const output = p.outputs[input.outputIndex]; assert.ok(output); input.output = output;
    assert.equal(signed.verifyScript(i).success, true, 'Independent fixture VM failed');
    return {satoshis: output.satoshis, script: output.script.toHex()};
  });
  const unsigned = new tbc.Transaction(vector.signedRaw);
  unsigned.inputs.forEach(input => input.setScript(tbc.Script.empty()));
  const trace = [];
  const reviewer = kit.createTbcDefaultRawTransactionReviewer({network, materialNative: native,
    fetch: async (url, init) => {
      const u = new URL(String(url)); assert.equal(u.origin, 'https://devapi.tbcdev.org');
      assert.equal(u.pathname, '/api/tbc/txo/status'); assert.equal(init.method, 'POST'); trace.push(u.pathname);
      const requested = JSON.parse(init.body).txos;
      const txos = requested.map(p => {
        const tx = parents.get(p.txid); assert.ok(tx, 'Unrelated parent read');
        const out = tx.outputs[Number(p.index)]; assert.ok(out);
        return {txid: p.txid, index: String(p.index), value: String(out.satoshis), scriptPubKey: out.script.toHex(), spent: false, height: '1'};
      });
      return new Response(JSON.stringify({code: '200', data: {txos}}), {status: 200});
    }});
  let accepted = false, failure;
  try {
    await reviewer.review({request: {txraws: [unsigned.uncheckedSerialize()],
      utxos_satoshis: [inputData.map(x => x.satoshis)], script_pubkeys: [inputData.map(x => x.script)]},
      context: {origin: 'https://reviewer.test', chainId: 'tbc:testnet', accountId: 'tbc:testnet:' + account.address,
        sessionId: 'frozen-coin-review', navigationId: 'frozen-coin-review'}, transactionIds: [unsigned.id]});
    accepted = true;
  } catch (error) {
    failure = error.message === 'Unrecognized current raw transaction impact'
      ? 'UNRECOGNIZED_CURRENT_RAW_TRANSACTION_IMPACT' : 'UNCLASSIFIED_REVIEW_FAILURE';
  }
  rows.push({index, fixtureName: vector.name ?? null, accepted, failure, independentVmInputs: signed.inputs.length,
    syntheticReadPaths: trace, actualHttp: 0, signing: 0, broadcast: 0});
}
const report = {status: rows.every(r => r.accepted) ? 'REVIEW_ACCEPTED_EXECUTION_NOT_TESTED' : 'GAP_CURRENT_COIN_RAW_REVIEW',
  at: new Date().toISOString(), ...evidence, rows, goalComplete: false,
  scope: 'Frozen default raw reviewer with genuine current Coin public fixture transactions; independent VM verifies reference signed inputs. No execution, custody or real chain action.'};
const dir = await mkdtemp(join(tmpdir(), 'tbc-coin213-reviewed-'));
const body = JSON.stringify(report, null, 2) + '\n'; await writeFile(join(dir, 'report.json'), body, {flag: 'wx'});
console.log(JSON.stringify({status: report.status, rows, path: join(dir, 'report.json'), sha256: createHash('sha256').update(body).digest('hex')}));
if (rows.some(r => !r.accepted)) process.exitCode = 1;
