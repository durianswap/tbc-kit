#!/usr/bin/env node
// Current Kit + Rust source against live Testnet reads, never a signer or send.
// Input is the native sample's PUBLIC account/custody proof, not a key file.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { build } from 'esbuild';
import { secp256k1 } from '@noble/curves/secp256k1.js';

const [publicAccountFile, profileFile, reportFile] = process.argv.slice(2);
assert.ok(publicAccountFile && profileFile && reportFile && process.argv.length === 5,
  'Usage: prepare-tbc20-live-readonly.mjs NATIVE_PUBLIC_ACCOUNT TESTNET_PROFILE NEW_REPORT');
const root = resolve(import.meta.dirname, '../../..');
const sha = bytes => createHash('sha256').update(bytes).digest();
const identity = JSON.parse(await readFile(publicAccountFile, 'utf8'));
const account = identity.account, proof = identity.proof;
assert.equal(account?.chainId, 'tbc:testnet');
assert.equal(account.accountId, `tbc:testnet:${account.address}`);
assert.equal(proof?.digest, sha('TBC Native Kit isolated Testnet identity proof').toString('hex'));
assert.match(proof.signature, /^[0-9a-f]{130}$/u);
const sig = Buffer.from(proof.signature, 'hex');
assert.ok(sig[0] >= 31 && sig[0] <= 34);
const publicKey = secp256k1.Signature.fromCompact(sig.subarray(1)).addRecoveryBit(sig[0] - 31)
  .recoverPublicKey(proof.digest).toRawBytes(true);
assert.equal(Buffer.from(publicKey).toString('hex'), account.publicKey);
assert.ok(secp256k1.verify(sig.subarray(1), proof.digest, publicKey, { prehash: false, lowS: true }));
const payload = Buffer.concat([Buffer.from([0]), createHash('ripemd160').update(sha(publicKey)).digest()]);
const addressBytes = Buffer.concat([payload, sha(sha(payload)).subarray(0, 4)]);
let address = '', n = BigInt('0x' + addressBytes.toString('hex'));
while (n > 0n) { address = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'[Number(n % 58n)] + address; n /= 58n; }
for (const byte of addressBytes) { if (byte !== 0) break; address = '1' + address; }
assert.equal(account.address, address);
assert.notEqual(address, '1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH', 'Never fund/use the public scalar-1 fixture');
const { readAcceptanceProfile } = await import('../../../native/kit-runtime/closed-loop/ft-testnet-profile.mjs');
const profile = await readAcceptanceProfile(profileFile, true);
assert.ok(['tbc20-standard-create', 'tbc20-standard-transfer', 'tbc20-standard-merge', 'tbc20-stablecoin-create', 'tbc20-stablecoin-transfer', 'tbc20-stablecoin-merge', 'tbc20-stablecoin-mint', 'tbc20-stablecoin-freeze', 'tbc20-stablecoin-unfreeze'].includes(profile.intent?.type));
const compile = execFileSync('cargo', ['build', '--locked', '--offline', '-p', 'tbc-engine-core',
  '--example', 'call_public_engine', '--message-format=json'], { cwd: join(root, 'packages/tbc-engine/rust'),
  encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
const executable = compile.split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line))
  .findLast(row => row.reason === 'compiler-artifact' && row.target?.name === 'call_public_engine')?.executable;
assert.equal(typeof executable, 'string');
const compiled = await build({ stdin: { contents: `
  export { createDefaultTbcNetwork } from './packages/kit/src/default-network.ts';
  export { createTbcNetworkContext } from './packages/kit/src/network-context.ts';
  export { prepareTbcTransaction } from './packages/kit/src/prepared.ts';
  export { assertValidTws } from './packages/core/src/index.ts';
`, resolveDir: root, loader: 'ts' }, alias: { '@tbc-wallet/core': join(root, 'packages/core/src/index.ts') },
  bundle: true, write: false, format: 'esm', platform: 'node', target: 'node22', logLevel: 'silent' });
const kit = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
const trace = [], engineCalls = [];
const startedAt = new Date().toISOString();
const network = kit.createDefaultTbcNetwork({
  network: kit.createTbcNetworkContext({ network: 'testnet' }), accounts: { current: async () => [account] },
  poolMaterial: { async resolveLiquidityAdd() { throw new Error('Unrelated Pool material must remain lazy'); } },
  async fetch(urlInput, options) {
    const url = new URL(String(urlInput));
    assert.equal(url.origin, 'https://api.tbcdev.org');
    const method=options?.method ?? 'GET';
    assert.ok(method==='GET'||(method==='POST'&&url.pathname==='/api/tbc/txo/status'&&!url.search),
      'Only GET and exact read-only TXO status POST; no broadcast in this diagnostic');
    assert.ok(!url.username && !url.password && !url.hash);
    const start = performance.now();
    const response = await fetch(url, { ...options, redirect: 'error', signal: options?.signal ?? AbortSignal.timeout(20_000) });
    trace.push({ method, path: url.pathname, status: response.status, elapsedMs: Math.round(performance.now() - start) });
    return response;
  },
});
const definitions = { normalizeRequest: ['normalizeRequestParams','normalizeRequestResult'],
  plan: ['planParams','planResult'], validate: ['validateParams','validationResult'] };
let plan;
const engine = Object.fromEntries(Object.entries(definitions).map(([method, [inputType, outputType]]) => [method, params => {
  kit.assertValidTws(inputType, params);
  const start = performance.now();
  const response = JSON.parse(execFileSync(executable, [method], { input: JSON.stringify(params), encoding: 'utf8',
    timeout: 20_000, maxBuffer: 16 * 1024 * 1024 }));
  assert.equal(response.ok, true, `Rust ${method}: ${response.error?.code} at ${response.error?.path}`);
  kit.assertValidTws(outputType, response.result);
  engineCalls.push({ method, elapsedMs: Math.round(performance.now() - start) });
  if (method === 'plan') plan = response.result.plan;
  return response.result;
}]));
engine.finalize = () => { throw new Error('No finalization/signatures in read-only diagnostic'); };
const report = { status: 'FAILED', startedAt, chainId: account.chainId, address, publicKey: account.publicKey,
  operation: profile.intent.type, profileSha256: sha(await readFile(profileFile)).toString('hex'),
  kitSourceBundleSha256: sha(compiled.outputFiles[0].text).toString('hex'),
  rustExecutableSha256: sha(await readFile(executable)).toString('hex'), trace, engineCalls,
  privateKeyRead: false, approvals: 0, signatures: 0, broadcastPosts: 0, realChainAcceptance: false };
try {
  const prepared = await kit.prepareTbcTransaction({ engine, network,
    request: { version: '1.0', chainId: account.chainId, from: address, intent: profile.intent,
      constraints: { maxFee: profile.maxFee } } });
  kit.assertValidTws('preparedTransactionRequest', prepared);
  report.status = 'LIVE_READS_PREPARED_NOT_SIGNED';
  report.planHash = plan.planHash;
  report.transactions = plan.payload.transactions.map(({id, fee}) => ({id, fee}));
  report.signingTasks = plan.payload.signingTasks.length;
  report.totalSigningTasks = plan.payload.preview?.signingTaskCount
    ?? (plan.payload.transactions.length === 1 ? report.signingTasks : null);
} catch (error) {
  report.error = { name: error.name, message: error.message, code: error.code };
  process.exitCode = 1;
}
report.finishedAt = new Date().toISOString();
await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(report, null, 2));
