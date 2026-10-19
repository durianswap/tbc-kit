#!/usr/bin/env node
// Pinned upstream codec oracle only: no private keys, network or transactions.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { runInThisContext } from 'node:vm';
import { resolve, join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const [upstreamArg, depsArg, mode] = process.argv.slice(2);
assert.ok(upstreamArg && depsArg && [undefined, '--emit-fixture'].includes(mode) && process.argv.length <= 5,
  'Usage: FIXED_UPSTREAM DEPENDENCIES [--emit-fixture]');
const upstream = resolve(upstreamArg), deps = createRequire(join(resolve(depsArg), 'package.json'));
const commit = 'af77616121db340e15bb8b73c197bc2f8d1ee986';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
assert.equal(execFileSync('git', ['-C', upstream, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), commit);
const source = 'lib/util/coin/coinTbc20Code.ts', artifactName = 'lib/util/coin/artifacts/coin_tbc20.json';
assert.equal(sha(readFileSync(join(upstream, source))), '8b41de57b5a26b0041819c52ed9b2b4195cdd4452894cc6176c91fdd17d19064');
const artifactBytes = readFileSync(join(upstream, artifactName));
assert.equal(sha(artifactBytes), 'f9d130410609b7972d64687899054ba2968e11b8e81507c010ce11addfcbd57c');
const artifact = JSON.parse(artifactBytes);
assert.equal(sha(JSON.stringify(artifact)), 'c686fc271f0ee8116325bf541d87c4d2e6ad839896a9d9dd21dcf2ac847660e3');
assert.equal(artifact.unlock.main.match(/<[^>]+>/g).length, 123);
assert.equal(readFileSync(new URL('../rust/crates/tbc-engine-core/src/protocols/coin-lock-template.hex', import.meta.url), 'utf8').trim(), artifact.lock.hex);
const libRoot = dirname(deps.resolve('tbc-lib-js/package.json'));
function tree(prefix = '') {
  return readdirSync(join(libRoot, prefix), { withFileTypes: true }).flatMap(entry => {
    if (['node_modules', '.git'].includes(entry.name)) return [];
    const path = join(prefix, entry.name);
    if (entry.isDirectory()) return tree(path);
    assert.ok(entry.isFile()); return [path];
  }).sort();
}
assert.equal(sha(tree().map(path => path + '\0' + sha(readFileSync(join(libRoot, path))) + '\n').join('')),
  'b73c8b5996276584981fe5b14f04db3e4cce02c94e7a19cb2b0f64e37206c7e9');
const bundled = await build({ entryPoints: [join(upstream, source)], bundle: true, write: false, metafile: true,
  platform: 'node', format: 'cjs', target: 'node22', external: ['tbc-lib-js'], logLevel: 'silent' });
for (const name of Object.keys(bundled.metafile.inputs)) {
  const path = resolve(name), rel = relative(upstream, path);
  assert.ok(!rel.startsWith('..'));
  assert.deepEqual(readFileSync(path), execFileSync('git', ['-C', upstream, 'show', `${commit}:${rel}`], { maxBuffer: 4 * 1024 * 1024 }));
}
const module = { exports: {} };
runInThisContext(`(function(module,exports,require){${bundled.outputFiles[0].text}\n})`)(module, module.exports, name => {
  if (name === 'node:crypto' || name === 'tbc-lib-js' || name === 'tbc-lib-js/lib/util/partial-sha256') return deps(name);
  throw Error('Unexpected dependency ' + name);
});
const { CoinTBC20: coin } = module.exports;
const vectors = [
  { tapeSize: 66, controllerHex: '11'.repeat(20) + '00', lockTime: 0, amounts: ['1','0','0','0','0','0'], metadataHex: '' },
  { tapeSize: 80, controllerHex: '22'.repeat(20) + '01', lockTime: 499999999, amounts: ['1','2','3','4','5','6'], metadataHex: '02abcd514f' },
  { tapeSize: 127, controllerHex: '33'.repeat(20) + '00', lockTime: 4294967295, amounts: Array(6).fill('9223372036854775807'), metadataHex: '4c020102' },
].map((input, i) => {
  const descriptor = { coinNftCodeHash: Buffer.alloc(32, i + 1), adminPubKeyHash: Buffer.alloc(20, i + 4),
    tapeSize: input.tapeSize, controller: Buffer.from(input.controllerHex, 'hex') };
  const code = coin.instantiateCode(descriptor), parsed = coin.parseCode(code);
  const tape = coin.buildTape({ tapeSize: input.tapeSize, amounts: input.amounts.map(BigInt), lockTime: input.lockTime, metadata: Buffer.from(input.metadataHex, 'hex') });
  const data = coin.parseTape(tape, descriptor);
  const changed = coin.replaceController(code, Buffer.from('44'.repeat(20) + '00', 'hex'));
  assert.deepEqual(coin.getCodeIdentity(changed), parsed.identity);
  return { ...input, coinNftCodeHashHex: descriptor.coinNftCodeHash.toString('hex'), adminPubKeyHashHex: descriptor.adminPubKeyHash.toString('hex'),
    codeHex: code.toHex(), tapeHex: tape.toHex(), identityHex: parsed.identity.toString('hex'), balance: data.balance.toString(),
    paddedMetadataHex: data.metadata.toString('hex') };
});
for (const metadataHex of ['50', '0201', '4c02ff', '4dffff', '4effffffff', 'ac']) {
  assert.throws(() => coin.buildTape({ amounts: [1n,0n,0n,0n,0n,0n], tapeSize: 127, lockTime: 0, metadata: Buffer.from(metadataHex, 'hex') }));
}
assert.equal(coin.getRequiredLockTime([0, 500000000, 4294967295]), 4294967295);
assert.throws(() => coin.getRequiredLockTime([1, 500000000]));
const fixture = { upstream: { commit, sourceSha256: sha(readFileSync(join(upstream, source))), artifactSha256: sha(artifactBytes) }, vectors };
if (mode === '--emit-fixture') process.stdout.write(JSON.stringify(fixture, null, 2) + '\n');
else {
  assert.deepEqual(JSON.parse(readFileSync(new URL('../rust/fixtures/coin-codec.json', import.meta.url), 'utf8')), fixture);
  console.log('COIN_CODEC_UPSTREAM_PASS 3 code/tape/identity vectors; full-range locks; strict metadata; network=0; signing=0');
}
