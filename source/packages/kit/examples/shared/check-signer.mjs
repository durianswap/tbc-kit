// Offline conformance check. Public BIP340/scalar-1 fixtures, never live accounts.
import assert from 'node:assert/strict';
import { secp256k1, schnorr } from '@noble/curves/secp256k1.js';
import { signControlledTask } from './controlled-signer.mjs';

const scalar = Uint8Array.from({ length: 32 }, (_, i) => i === 31 ? 1 : 0);
const digest = 'ab'.repeat(32), publicKey = secp256k1.getPublicKey(scalar, true);
const profiles = [
  ['secp256k1-ecdsa-sha256d', 'compact64'],
  ['secp256k1-recoverable-ecdsa-sha256d', 'compact65-recoverable'],
  ['secp256k1-schnorr-bip340', 'schnorr64'],
];
let verified = 0, rejected = 0;
for (const [algorithm, signatureEncoding] of profiles) {
  const result = signControlledTask({ taskId: 'public-fixture', algorithm, signatureEncoding, digest }, scalar);
  assert.equal(result.taskId, 'public-fixture'); assert.equal(result.signatureEncoding, signatureEncoding);
  const recovered = signatureEncoding === 'compact65-recoverable';
  const signature = recovered ? result.signature.slice(2) : result.signature;
  if (signatureEncoding === 'schnorr64') {
    assert(schnorr.verify(signature, digest, publicKey.slice(1)));
    assert(!schnorr.verify(signature, 'cd'.repeat(32), publicKey.slice(1)));
  } else {
    assert(secp256k1.verify(signature, digest, publicKey, { prehash: false, lowS: true }));
    assert(!secp256k1.verify(signature, 'cd'.repeat(32), publicKey, { prehash: false, lowS: true }));
    if (recovered) {
      const id = Number.parseInt(result.signature.slice(0, 2), 16) - 31;
      const actual = secp256k1.Signature.fromCompact(signature).addRecoveryBit(id).recoverPublicKey(digest).toRawBytes(true);
      assert.deepEqual(actual, publicKey);
    }
  }
  verified++;
  for (const [, wrong] of profiles.filter(([, encoding]) => encoding !== signatureEncoding)) {
    const failure = signControlledTask({ taskId: 'public-fixture', algorithm, signatureEncoding: wrong, digest }, scalar);
    assert.equal(failure.portError?.name, 'SIGNATURE_FAILED'); rejected++;
  }
}
// BIP340 official vector 0, the same independent vector used by the Rust kernel.
const vector = signControlledTask({ taskId: 'bip340-vector-0', algorithm: profiles[2][0],
  signatureEncoding: 'schnorr64', digest: '00'.repeat(32) }, '03'.padStart(64, '0'));
assert.equal(vector.signature,
  'e907831f80848d1069a5371b402410364bdf1c5f8307b0084c55f1ce2dca821525f66a4a85ea8b71e482a74f382d2ce5ebeee8fdb2172f477df4900d310536c0');
assert.equal(signControlledTask({ algorithm: 'unknown', signatureEncoding: 'compact64', digest }, scalar).portError.name, 'SIGNATURE_FAILED');
console.log(JSON.stringify({ status: 'SIGNER_PROFILES_PASS', verified, mismatchedProfilesRejected: rejected,
  bip340OfficialVector: true, alteredDigestRejected: true, networkRequests: 0, broadcasts: 0 }));
