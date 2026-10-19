// Regenerate public deterministic vectors after the explicit Chain ID rename.
// The baseline must be the backup made BEFORE migration; never use live wallet data.
import assert from 'node:assert/strict';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { secp256k1 } from '@noble/curves/secp256k1';
import { canonicalize } from './lib/canonical-json.mjs';
import { deriveOperationId, deriveCallId } from './lib/replay-conformance.mjs';
import { derivePermissionId, deriveBroadcastIdempotencyKey } from './lib/crypto-conformance.mjs';
import { deriveCommitId } from './lib/provider-session-conformance.mjs';
import { materializeCheckpoints, materializePreClockTerminals } from './lib/lifecycle-conformance.mjs';

const root = resolve(import.meta.dirname, '..');
assert.ok(process.argv[2], 'Pass the pre-migration backup directory');
const baseline = resolve(process.argv[2]);
const originals = {};
for (const file of await readdir(join(root, 'test-vectors'))) {
  if (!file.endsWith('.json')) continue;
  const old = await readFile(join(baseline, 'test-vectors', file), 'utf8').catch(e => {
    if (e.code !== 'ENOENT') throw e;
    return readFile(join(root, 'test-vectors', file), 'utf8');
  });
  originals[file] = JSON.parse(old);
}
const mappings = new Map([
  ['tbc:000000006ec607045ad2c990de903d04', 'tbc:mainnet'],
  ['tbc:0000000000cee779eb6a6c2ce087218a', 'tbc:testnet'],
  ['tbc:11111111111111111111111111111111', 'tbc:other'],
  ['tbc:22222222222222222222222222222222', 'tbc:other-two'],
]);
const sha = bytes => createHash('sha256').update(bytes).digest();
const hash = value => sha(canonicalize(value)).toString('hex');
const allText = JSON.stringify(originals);
const hashSources = new Map();
function walk(value) {
  if (!value || typeof value !== 'object') return;
  const digest = hash(value);
  if (allText.includes(digest)) hashSources.set(digest, value);
  Object.values(value).forEach(walk);
}
Object.values(originals).forEach(walk);
const compact = n => {
  if (n < 253) return Buffer.from([n]);
  assert.ok(n <= 65535); const b = Buffer.alloc(3); b[0] = 253; b.writeUInt16LE(n, 1); return b;
};
function signedPayload(magic, body) {
  const prefix = Buffer.from(magic);
  return Buffer.concat([compact(prefix.length), prefix, compact(body.length), body]);
}
let replace;
function transform(value) {
  if (typeof value === 'string') return replace(value);
  if (Array.isArray(value)) return value.map(transform);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => {
    const result = transform(v);
    return [k, (k === 'chainIds' || k === 'accountIds') && Array.isArray(result) ? result.sort() : result];
  }));
  return value;
}
let rounds = 0;
for (; rounds < 80; rounds++) {
  const regex = new RegExp([...mappings.keys()].sort((a,b) => b.length-a.length).map(s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|'), 'g');
  replace = s => s.replace(regex, value => mappings.get(value));
  const before = JSON.stringify([...mappings]);
  const set = (old, value) => { if (old !== value) mappings.set(old, value); };
  for (const [digest, payload] of hashSources) set(digest, hash(transform(payload)));
  const replay = originals['port-replay.json'];
  set(replay.ids.operation.expected, deriveOperationId(transform(replay.ids.operation.input)));
  set(replay.ids.call.expected, deriveCallId(transform(replay.ids.call.input)));
  const ids = originals['identifiers.json'];
  for (const key of ['permission','permissionSecondary']) set(ids[key].expected, derivePermissionId(transform(ids[key].input)));
  set(ids.broadcast.expected, deriveBroadcastIdempotencyKey(transform(ids.broadcast.input)));
  const provider = originals['provider.json'].providerSessions;
  set(provider.switchA.commitId, deriveCommitId(transform(provider.commitId.input)));
  for (const result of [...materializeCheckpoints(transform(originals['checkpoints.json'])), ...materializePreClockTerminals(transform(originals['checkpoints.json']))]) {
    const source = [...originals['checkpoints.json'].checkpoints, ...(originals['checkpoints.json'].preClockTerminals ?? [])].find(v => v.id === result.id);
    assert.ok(source); set(source.checkpointHash, hash(result.checkpoint.payload));
  }
  for (const vector of originals['signing.json'].vectors) {
    const envelope = transform(vector.result.envelope);
    const canonical = canonicalize(envelope);
    const body = envelope.type === 'tbc.message' ? Buffer.from(envelope.message.data, envelope.message.encoding) : Buffer.from(canonical);
    const payload = signedPayload(vector.magic, body), digest = sha(sha(payload));
    const sig = secp256k1.sign(digest, Uint8Array.from({ length: 32 }, (_, i) => i === 31 ? 1 : 0), { prehash: false, lowS: true });
    set(vector.result.canonical, canonical); set(vector.payloadHex, payload.toString('hex'));
    set(vector.result.signingPayload, payload.toString('base64')); set(vector.result.digest, digest.toString('hex'));
    set(vector.result.signature, Buffer.concat([Buffer.from([31 + sig.recovery]), sig.toCompactRawBytes()]).toString('base64'));
  }
  for (const vector of originals['workflow.json'].vectors) {
    const canonical = canonicalize(transform(vector.derivation.resolvedEnvelope));
    set(vector.derivation.canonical, canonical);
    set(vector.derivation.digest, sha(sha(signedPayload('TBC Signed Typed Data:\n', Buffer.from(canonical)))).toString('hex'));
  }
  if (before === JSON.stringify([...mappings])) break;
}
assert.ok(rounds < 80, 'Vector dependencies did not converge');
for (const [file, source] of Object.entries(originals)) {
  const value = transform(source);
  if (file === 'approval.json') {
    // Preserve the intentionally invalid ordering case after the lexical rename.
    value.semanticFailures[0].payload.chainIds.sort().reverse();
  }
  if (file === 'identifiers.json') {
    delete value.anchorPolicy; value.identityPolicy = 'stable-network-name';
    for (const vector of value.vectors) { delete vector.anchorHeight; delete vector.anchorHash; vector.reference = vector.network; }
  }
  await writeFile(join(root, 'test-vectors', file), JSON.stringify(value, null, 2) + '\n');
}
await writeFile(join(baseline, 'vector-rebase-map.json'), JSON.stringify(Object.fromEntries(mappings), null, 2));
for (const file of [
  'packages/tbc-engine/rust/fixtures/tbc-transfer.json',
  'packages/tbc-engine/rust/comparators/task6-source-harness/core-base.json',
]) {
  const source = JSON.parse(await readFile(join(baseline, file), 'utf8'));
  await writeFile(join(root, file), JSON.stringify(transform(source), null, 2) + '\n');
}
console.log(JSON.stringify({ rounds, derivedBindings: mappings.size - 2 }));
