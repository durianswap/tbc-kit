#!/usr/bin/env node
// Independent fixed-SDK proof oracle. Public scalars 1/2 and invented funding.
// SDK signing is ONLY fixture generation; the Engine never receives these keys.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { runInThisContext } from 'node:vm';
import { resolve, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const [upstreamArg, depsArg, mode] = process.argv.slice(2);
assert.ok(upstreamArg && depsArg && [undefined, '--emit-fixture', '--business', '--emit-business-fixture', '--admin', '--emit-admin-fixture', '--emit-admin-controller-fixture', '--emit-admin-musig-fixture', '--emit-admin-musig-controller-fixture', '--issuance-business', '--admin-business', '--owner-transfer'].includes(mode) && process.argv.length <= 5);
const root = fileURLToPath(new URL('../../../', import.meta.url));
const upstream = resolve(upstreamArg), depsPath = resolve(depsArg), deps = createRequire(join(depsPath, 'package.json'));
const commit = 'af77616121db340e15bb8b73c197bc2f8d1ee986';
execFileSync(process.execPath, [join(root, 'packages/tbc-engine/scripts/check-coin-codec-source.mjs'), upstream, depsPath], { stdio: 'pipe', timeout: 30000 });
const sha = b => createHash('sha256').update(b).digest('hex');
const source = 'lib/util/coin/coinTbc20unlock.ts';
assert.equal(sha(readFileSync(join(upstream, source))), '9927142447441bb6fd9c585047f6ff827d45a3080ae7cfa5e7314c0098bd54e5');
const built = await build({ stdin: { contents: `export const Coin = require('./lib/contract/coinTbc20.js');
  export { buildCoinTBC20UnlockScriptWithSignature } from './lib/util/coin/coinTbc20unlock.js';`, resolveDir: upstream },
  bundle: true, write: false, metafile: true, platform: 'node', format: 'cjs', target: 'node22',
  external: ['tbc-lib-js', 'tbc-lib-js/*'], resolveExtensions: ['.js', '.json'], logLevel: 'silent' });
for (const name of Object.keys(built.metafile.inputs)) {
  if (name === '<stdin>') continue;
  const path = resolve(name), rel = relative(upstream, path); assert.ok(!rel.startsWith('..'));
  assert.deepEqual(readFileSync(path), execFileSync('git', ['-C', upstream, 'show', `${commit}:${rel}`], { maxBuffer: 8 * 1024 * 1024 }));
}
const module = { exports: {} };
runInThisContext(`(function(module,exports,require){${built.outputFiles[0].text}\n})`)(module, module.exports, name => {
  if (name === 'tbc-lib-js' || name.startsWith('tbc-lib-js/') || name === 'node:crypto') return deps(name);
  throw Error('Unexpected executable dependency ' + name);
});
const { Coin, buildCoinTBC20UnlockScriptWithSignature } = module.exports, tbc = deps('tbc-lib-js');
const key = new tbc.PrivateKey(new tbc.crypto.BN(1)), admin = new tbc.PrivateKey(new tbc.crypto.BN(2));
const cooperative = ['--emit-admin-musig-fixture','--emit-admin-musig-controller-fixture'].includes(mode);
const fixtureKeys = [key.publicKey.toBuffer(), admin.publicKey.toBuffer()];
const group = cooperative ? tbc.crypto.MuSig2.keyAgg(fixtureKeys) : undefined;
const adminPublic = cooperative ? tbc.crypto.MuSig2.getAggPubkey(group) : admin.publicKey.toXOnly();
function signAdmin(digest) {
  if (!cooperative) return tbc.crypto.Schnorr.sign(digest, admin.toBuffer(), Buffer.alloc(32));
  // Public fixture scalars only. Secret nonces never leave this local call.
  const scalars = [key.toBuffer(), admin.toBuffer()], nonces = [];
  try {
    for (let i=0;i<2;i++) nonces.push(tbc.crypto.MuSig2.nonceGen({pk:fixtureKeys[i],sk:scalars[i],aggpk:adminPublic,msg:digest}));
    const session = tbc.crypto.MuSig2.buildSession(group,tbc.crypto.MuSig2.nonceAgg(nonces.map(n=>n.pubnonce)),digest);
    const partials = scalars.map((sk,i)=>tbc.crypto.MuSig2.partialSign(nonces[i].secnonce,sk,session));
    partials.forEach((sig,i)=>assert.equal(tbc.crypto.MuSig2.partialVerify(sig,nonces[i].pubnonce,fixtureKeys[i],session),true));
    const signature=tbc.crypto.MuSig2.partialSigAgg(partials,session);
    assert.equal(tbc.crypto.Schnorr.verify(digest,signature,adminPublic),true);return signature;
  } finally { scalars.forEach(k=>k.fill(0));nonces.forEach(n=>n.secnonce.fill(0)); }
}
const address = key.toAddress().toString(), publicKey = key.toPublicKey().toBuffer();
const script = tbc.Script.buildPublicKeyHashOut(key.toAddress());
const funding = new tbc.Transaction().from({ txId: '11'.repeat(32), outputIndex: 0, script: script.toHex(), satoshis: 1000000 })
  .to(address, 999000).fee(1000).sign(key);
const ref = (tx, vout) => ({ txId: tx.id, outputIndex: vout, script: tx.outputs[vout].script.toHex(), satoshis: tx.outputs[vout].satoshis });
const coin = new Coin({ name: 'Offline Coin', symbol: 'OFF', amount: '1000', decimal: 0 });
const prepared = coin.createCoin(adminPublic, key, address, ref(funding, 0), funding);
const issuance = prepared.finalize(prepared.sighashes.map(item => signAdmin(item.sighash)));
const [issuer, mint] = issuance.map(raw => new tbc.Transaction(raw));
const first = new tbc.Transaction(coin.transfer(key, address, '250', [Coin.buildUTXO(mint, 3)], ref(mint, mint.outputs.length-1), [mint], [issuer]));
const merged = new tbc.Transaction(coin.transfer(key, address, '1000', [Coin.buildUTXO(first, 0), Coin.buildUTXO(first, 2)], ref(first, first.outputs.length-1), [first, first], [mint]));
const again = new tbc.Transaction(coin.transfer(key, address, '1000', [Coin.buildUTXO(merged, 0)], ref(merged, merged.outputs.length-1), [merged], [first]));
const all = new Map([funding, issuer, mint, first, merged, again].map(tx => [tx.id, tx]));
let vmInputs = 0;
for (const tx of [issuer, mint, first, merged, again]) {
  for (const [vin, input] of tx.inputs.entries()) {
    const parent = all.get(input.prevTxId.toString('hex')); assert.ok(parent);
    input.output = parent.outputs[input.outputIndex];
    const verdict = tx.verifyScript(vin); assert.equal(verdict.success, true, `${tx.id}:${vin} ${verdict.error}`); vmInputs++;
  }
}
const groupsFor = tx => {
  const groups = [];
  for (let i = 0; i < tx.outputs.length;) {
    if (tx.outputs[i].satoshis === 500) { groups.push({ codeVout: i, tapeVout: i+1 }); i += 2; }
    else { groups.push({ codeVout: i }); i++; }
  }
  return groups;
};
const vectors = [];
for (const [id, signed, parents] of [['first', first, [issuer]], ['merge', merged, [mint]], ['again', again, [first]]]) {
  const groups = groupsFor(signed);
  for (let vin = 0; vin < signed.inputs.length-1; vin++) {
    const input = signed.inputs[vin], parent = all.get(input.prevTxId.toString('hex'));
    const current = new tbc.Transaction(signed.uncheckedSerialize());
    current.inputs.forEach((input, i) => { input.output = signed.inputs[i].output; input.setScript(tbc.Script.empty()); });
    const signature = Buffer.from(current.getSignature(vin, key), 'hex');
    const unlock = buildCoinTBC20UnlockScriptWithSignature({ currentTx: current, inputIndex: vin, preTx: parent,
      preTxVout: input.outputIndex, ancestorTransactions: parents, outputGroups: groups, signature, publicKey });
    assert.equal(unlock.toHex(), signed.inputs[vin].script.toHex());
    const fields = unlock.chunks.map(chunk => chunk.buf ?? (chunk.opcodenum === 0 ? Buffer.alloc(0) :
      chunk.opcodenum === 0x4f ? Buffer.from([0x81]) : Buffer.from([chunk.opcodenum - 0x50])));
    assert.equal(fields.length, 123);
    const digest = tbc.crypto.Hash.sha256sha256(Buffer.from(current.getPreimage(vin, 0x41), 'hex'));
    vectors.push({ id: `${id}-${vin}`, currentRaw: current.uncheckedSerialize(), parentRaw: parent.uncheckedSerialize(),
      parentCodeVout: input.outputIndex, inputIndex: vin, ancestorsRaw: parents.map(tx => tx.uncheckedSerialize()),
      outputGroups: groups, publicKeyHex: publicKey.toString('hex'), digestHex: digest.toString('hex'), signatureHex: signature.toString('hex'),
      fields: fields.map(b => b.toString('hex')), unlockHex: unlock.toHex(), signedRaw: signed.uncheckedSerialize(), txid: signed.id });
  }
}
const fixture = { upstream: { commit, sourceSha256: sha(readFileSync(join(upstream, source))), publicScalars: [1, 2] },
  vmInputs, vectors };
if (mode === '--owner-transfer') {
  const report=JSON.parse(readFileSync(process.env.COIN_OWNER_TRANSFER_REPORT,'utf8'));
  const definition=new Coin({name:'Offline Coin',symbol:'OFF',amount:'2.5',decimal:6});
  const prepared=definition.createCoin(key.publicKey.toXOnly(),key,address,ref(funding,0),funding);
  const created=prepared.finalize(prepared.sighashes.map(s=>tbc.crypto.Schnorr.sign(s.sighash,key.toBuffer(),Buffer.alloc(32))));
  const [source,minted]=created.map(raw=>new tbc.Transaction(raw));
  const moved=new tbc.Transaction(definition.transfer(key,address,'0.000001',[Coin.buildUTXO(minted,3)],ref(minted,minted.outputs.length-1),[minted],[source]));
  moved.inputs.forEach(input=>{input.output=minted.outputs[input.outputIndex]});
  // SDK holder signing uses random BIP340 auxiliary bytes; normalize this
  // public-fixture signature to zero aux without changing its transaction.
  const digest=tbc.crypto.Hash.sha256sha256(Buffer.from(moved.getPreimage(0,0x41),'hex'));
  const signature=Buffer.concat([tbc.crypto.Schnorr.sign(digest,key.toBuffer(),Buffer.alloc(32)),Buffer.from([0x41])]);
  moved.inputs[0].setScript(buildCoinTBC20UnlockScriptWithSignature({currentTx:moved,inputIndex:0,preTx:minted,preTxVout:3,
    ancestorTransactions:[source],outputGroups:groupsFor(moved),signature,publicKey:key.publicKey.toXOnly()}));
  for(const [i,raw] of [...created,moved.uncheckedSerialize()].entries())assert.equal(sha(report.raws[i]),sha(raw),`Engine/SDK owner transaction ${i} raw mismatch`);
  const parents=new Map([[funding.id,funding]]);let checked=0;
  for(const raw of report.raws){const tx=new tbc.Transaction(raw);parents.set(tx.id,tx);
    for(const [vin,input] of tx.inputs.entries()){input.output=parents.get(input.prevTxId.toString('hex')).outputs[input.outputIndex];
      const verdict=tx.verifyScript(vin);assert.equal(verdict.success,true,`owner transfer ${vin}: ${verdict.error}`);checked++;}}
  console.log(`COIN_OWNER_TRANSFER_PASS 3 exact SDK raws; ${checked} independent VM inputs; POST=0`);
} else if (mode === '--admin-business') {
  const report = JSON.parse(readFileSync(process.env.COIN_ADMIN_REPORT, 'utf8'));
  assert.equal(report.network, false); assert.deepEqual(report.publicScalars, [1, 2]); assert.equal(report.cases.length, 2);
  const splitRaw = coin.batchTransfer(key, [{ address, amount: '250' }, { address: '22'.repeat(20), amount: '300' }],
    [Coin.buildUTXO(mint, 3)], ref(mint, 5), [mint], [issuer])[0].txraw;
  assert.equal(report.splitRaw, splitRaw, 'mixed-controller split differs from SDK');
  let parent = new tbc.Transaction(splitRaw), ancestor = mint, checked = 0;
  const verify = (tx, previous) => tx.inputs.forEach((input, vin) => {
    assert.equal(input.prevTxId.toString('hex'), previous.id); input.output = previous.outputs[input.outputIndex];
    const result = tx.verifyScript(vin); assert.equal(result.success, true, `${vin}: ${result.error}`); checked++;
  });
  verify(parent, mint);
  for (const [index, item] of report.cases.entries()) {
    assert.deepEqual(item.vouts, index === 0 ? [2, 0, 4] : [2, 0]); assert.equal(item.lock, index === 0 ? 0xffffffff : 0);
    const prepared = coin.freezeCoinUTXO(admin.publicKey.toXOnly(), key, item.lock, item.vouts.map(vout => Coin.buildUTXO(parent, vout)),
      ref(parent, parent.outputs.length - 1), item.vouts.map(() => parent), [ancestor]);
    const raw = prepared.finalize(prepared.sighashes.map(s => tbc.crypto.Schnorr.sign(s.sighash, admin.toBuffer(), Buffer.alloc(32))));
    assert.equal(item.raw, raw, `admin group ${index} differs from SDK`);
    const tx = new tbc.Transaction(raw); verify(tx, parent);
    assert.equal(item.fee, tx.inputs.reduce((n, i) => n + i.output.satoshis, 0) - tx.outputs.reduce((n, o) => n + o.satoshis, 0));
    assert.ok(tx.toBuffer().length <= item.maximumSignedBytes); ancestor = parent; parent = tx;
  }
  console.log(`COIN_ADMIN_BUSINESS_PASS 3 exact SDK raws; ${checked} VM inputs; mixed address/contract controllers; offline, POST=0`);
} else if (mode === '--issuance-business') {
  const report = JSON.parse(readFileSync(process.env.COIN_ISSUANCE_REPORT, 'utf8'));
  assert.equal(report.network, false); assert.deepEqual(report.publicScalars, [1, 2]);
  assert.equal(report.fundingRaw, funding.uncheckedSerialize()); assert.equal(report.cases.length, 2);
  let checked = 0;
  for (const item of report.cases) {
    const padded = item.amountAtomic.padStart(item.decimals + 1, '0');
    const amount = item.decimals ? `${padded.slice(0, -item.decimals)}.${padded.slice(-item.decimals)}` : padded;
    const definition = new Coin({ name: item.name, symbol: item.symbol, decimal: item.decimals, amount });
    const prepared = definition.createCoin(admin.publicKey.toXOnly(), key, item.contractRecipient ? '22'.repeat(20) : address,
      ref(funding, 0), funding, item.message ?? undefined);
    const expected = prepared.finalize(prepared.sighashes.map(s => tbc.crypto.Schnorr.sign(s.sighash, admin.toBuffer(), Buffer.alloc(32))));
    assert.ok(item.raws.length === expected.length && item.raws.every((raw, i) => raw === expected[i]), `${item.id}: Engine and SDK full raw differ`);
    const [source, firstMint] = expected.map(raw => new tbc.Transaction(raw));
    const mintPadded = item.mintAmountAtomic.padStart(item.decimals + 1, '0');
    const mintAmount = item.decimals ? `${mintPadded.slice(0, -item.decimals)}.${mintPadded.slice(-item.decimals)}` : mintPadded;
    const additional = definition.mintCoin(admin.publicKey.toXOnly(), key, address, mintAmount,
      ref(firstMint, firstMint.outputs.length - 1), firstMint, source, item.mintMessage);
    const additionalRaw = additional.finalize(additional.sighashes.map(s => tbc.crypto.Schnorr.sign(s.sighash, admin.toBuffer(), Buffer.alloc(32))));
    assert.ok(item.mintRaw === additionalRaw, `${item.id}: reissuance Engine and SDK full raw differ`);
    const parents = new Map([[funding.id, funding]]);
    for (const [index, raw] of [...item.raws, item.mintRaw].entries()) {
      const tx = new tbc.Transaction(raw); parents.set(tx.id, tx);
      tx.inputs.forEach((input, vin) => {
        input.output = parents.get(input.prevTxId.toString('hex')).outputs[input.outputIndex];
        const result = tx.verifyScript(vin); assert.equal(result.success, true, `${item.id}:${index}:${vin}: ${result.error}`); checked++;
      });
      const fee = tx.inputs.reduce((n, input) => n + input.output.satoshis, 0) - tx.outputs.reduce((n, output) => n + output.satoshis, 0);
      assert.equal(fee, index < 2 ? item.fees[index] : item.mintFee);
      assert.ok(tx.toBuffer().length <= (index < 2 ? item.maximumSignedBytes[index] : item.mintMaximumSignedBytes));
    }
  }
  console.log(`COIN_ISSUANCE_BUSINESS_PASS ${report.cases.length} cases; 6 exact SDK raws; ${checked} VM inputs; offline, POST=0`);
} else if (mode === '--admin' || mode === '--emit-admin-fixture' || mode === '--emit-admin-controller-fixture' || cooperative) {
  // Public fixture only: exercise the SDK administrator branch over a
  // contract-held Coin, not a holder claiming a controlling-contract witness.
  const contractHeld = ['--emit-admin-controller-fixture','--emit-admin-musig-controller-fixture'].includes(mode);
  const parentForAdmin = contractHeld ? new tbc.Transaction(coin.batchTransfer(key,
    [{address,amount:'250'},{address:'22'.repeat(20),amount:'300'}],
    [Coin.buildUTXO(mint,3)],ref(mint,mint.outputs.length-1),[mint],[issuer])[0].txraw) : first;
  if(contractHeld) parentForAdmin.inputs.forEach((input,vin)=>{
    input.output=mint.outputs[input.outputIndex];assert.equal(parentForAdmin.verifyScript(vin).success,true);
  });
  const xonly = adminPublic, cases = [];
  const freeze = coin.freezeCoinUTXO(xonly, key, 0xffffffff, (contractHeld?[2,0]:[0,2]).map(vout=>Coin.buildUTXO(parentForAdmin,vout)),
    ref(parentForAdmin, parentForAdmin.outputs.length - 1), [parentForAdmin, parentForAdmin], [mint]);
  const frozen = new tbc.Transaction(freeze.finalize(freeze.sighashes.map(item => signAdmin(item.sighash))));
  const unfreeze = coin.unfreezeCoinUTXO(xonly, key, [Coin.buildUTXO(frozen, 0)], ref(frozen, frozen.outputs.length - 1), [frozen], [parentForAdmin]);
  const unfrozen = new tbc.Transaction(unfreeze.finalize(unfreeze.sighashes.map(item => signAdmin(item.sighash))));
  let checked = 0;
  const chunkBytes = chunk => chunk.buf ?? (chunk.opcodenum === 0 ? Buffer.alloc(0) : chunk.opcodenum === 0x4f ? Buffer.from([0x81]) : Buffer.from([chunk.opcodenum - 0x50]));
  for (const [id, signed, parent, ancestors] of [['freeze', frozen, parentForAdmin, [mint]], ['unfreeze', unfrozen, frozen, [parentForAdmin]]]) {
    signed.inputs.forEach((input, vin) => {
      input.output = parent.outputs[input.outputIndex];
      const verdict = signed.verifyScript(vin); assert.equal(verdict.success, true, `${id}:${vin}: ${verdict.error}`); checked++;
      if (vin === signed.inputs.length - 1) return;
      const fields = input.script.chunks.map(chunkBytes);
      cases.push({ id: `${id}-${vin}`, signedRaw: signed.uncheckedSerialize(), parentRaw: parent.uncheckedSerialize(),
        parentCodeVout: input.outputIndex, inputIndex: vin, ancestorsRaw: ancestors.map(tx => tx.uncheckedSerialize()),
        outputGroups: groupsFor(signed), fields: fields.map(b => b.toString('hex')), signatureHex: fields[98].toString('hex'),
        publicKeyHex: xonly.toString('hex'), digestHex: tbc.crypto.Hash.sha256sha256(Buffer.from(signed.getPreimage(vin, 0x41), 'hex')).toString('hex'), unlockHex: input.script.toHex() });
    });
  }
  const fields = mint.inputs[0].script.chunks.map(chunkBytes);
  const adminFixture = { upstream: fixture.upstream, vmInputs: checked + mint.inputs.length,
    issuance: { signedRaw: mint.uncheckedSerialize(), parentRaw: issuer.uncheckedSerialize(), grandparentRaw: funding.uncheckedSerialize(),
      publicKeyHex: xonly.toString('hex'), fields: fields.map(b => b.toString('hex')), signatureHex: fields[0].toString('hex'),
      digestHex: prepared.sighashes[0].sighash.toString('hex'), unlockHex: mint.inputs[0].script.toHex() }, cases };
  if (mode === '--emit-admin-fixture' || contractHeld || cooperative) process.stdout.write(JSON.stringify(adminFixture, null, 2) + '\n');
  else {
    assert.deepEqual(JSON.parse(readFileSync(new URL('../rust/fixtures/coin-admin-proof.json', import.meta.url))), adminFixture);
    console.log(`COIN_ADMIN_UPSTREAM_PASS issuance + ${cases.length} proofs; ${adminFixture.vmInputs} VM inputs; offline, POST=0`);
  }
} else if (mode === '--business' || mode === '--emit-business-fixture') {
  const fee = ref(mint, mint.outputs.length - 1), inputs = [Coin.buildUTXO(mint, 3)], cases = [];
  const recipes = [
    { id: 'payment', amounts: ['250'], paymentAtomic: 24, raw: coin.transfer(key, address, '250', inputs, fee, [mint], [issuer], '0.000024') },
    { id: 'info', amounts: ['250'], dataHex: '01', raw: coin.transferWithAdditionalInfo(key, address, '250', inputs, fee, [mint], [issuer], Buffer.from([1])) },
    { id: 'multi', amounts: ['250', '300'], raw: coin.batchTransfer(key, [{ address, amount: '250' }, { address, amount: '300' }], inputs, fee, [mint], [issuer])[0].txraw },
  ];
  let checked = 0;
  for (const { raw, ...request } of recipes) {
    const signed = new tbc.Transaction(raw);
    signed.inputs.forEach(input => { input.output = mint.outputs[input.outputIndex]; });
    const signatures = signed.inputs.map((input, vin) => {
      const result = signed.verifyScript(vin); assert.equal(result.success, true, `${request.id}:${vin} ${result.error}`); checked++;
      return { digestHex: tbc.crypto.Hash.sha256sha256(Buffer.from(signed.getPreimage(vin, 0x41), 'hex')).toString('hex'),
        signatureHex: (vin === 0 ? input.script.chunks[98].buf : input.script.chunks[0].buf).toString('hex') };
    });
    cases.push({ ...request, signedRaw: raw, txid: signed.id,
      fee: signed.inputs.reduce((s, i) => s + i.output.satoshis, 0) - signed.outputs.reduce((s, o) => s + o.satoshis, 0), signatures });
  }
  const business = { upstream: fixture.upstream, baseFixture: 'coin-proof.json first-0 parent/ancestor', vmInputs: checked, cases };
  if (mode === '--emit-business-fixture') process.stdout.write(JSON.stringify(business, null, 2) + '\n');
  else {
    assert.deepEqual(JSON.parse(readFileSync(new URL('../rust/fixtures/coin-holder-business.json', import.meta.url))), business);
    console.log(`COIN_BUSINESS_UPSTREAM_PASS ${cases.length} transactions; ${checked} VM inputs; offline, broadcast=0`);
  }
} else if (mode === '--emit-fixture') process.stdout.write(JSON.stringify(fixture, null, 2) + '\n');
else {
  assert.deepEqual(JSON.parse(readFileSync(new URL('../rust/fixtures/coin-proof.json', import.meta.url))), fixture);
  console.log(`COIN_PROOF_UPSTREAM_PASS ${vectors.length} proofs; ${vmInputs} VM inputs including issuer/mint; offline, broadcast=0`);
}
