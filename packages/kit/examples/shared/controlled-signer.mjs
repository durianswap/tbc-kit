import { secp256k1, schnorr } from '@noble/curves/secp256k1.js';

// Offline fixture only. Real wallets select the approved account inside their
// Vault, verify authority/approval/task bindings, and never expose a key here.
export function signControlledTask(task, fixtureKey) {
  if (task.algorithm === 'secp256k1-schnorr-bip340' && task.signatureEncoding === 'schnorr64') {
    const signature = schnorr.sign(task.digest, fixtureKey, new Uint8Array(32));
    return { taskId: task.taskId, signatureEncoding: 'schnorr64', signature: Buffer.from(signature).toString('hex') };
  }
  const recoverable = task.algorithm === 'secp256k1-recoverable-ecdsa-sha256d' &&
    task.signatureEncoding === 'compact65-recoverable';
  if ((task.algorithm === 'secp256k1-ecdsa-sha256d' && task.signatureEncoding === 'compact64') || recoverable) {
    const signature = secp256k1.sign(task.digest, fixtureKey, { prehash: false, lowS: true });
    return { taskId: task.taskId, signatureEncoding: task.signatureEncoding,
      signature: recoverable
        ? `${(31 + signature.recovery).toString(16)}${signature.toCompactHex()}` : signature.toCompactHex() };
  }
  return { portError: { name: 'SIGNATURE_FAILED', retryable: false, message: 'Unsupported signing algorithm or encoding' } };
}
