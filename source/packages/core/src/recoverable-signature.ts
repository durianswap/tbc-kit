import { secp256k1 } from "@noble/curves/secp256k1";

import { bytesToHex, hexToBytes } from "./encoding.js";

interface VerifiedRecoverableSignature {
  readonly signatureHex: string;
  readonly digest: string;
  readonly publicKey: string;
}

// One successful cryptographic verification may be consumed by the immediate
// caller on the other side of a wallet-owned Signer/Core boundary. This is not
// an authorization receipt: a miss, concurrent overwrite, or process restart
// always falls back to full verification.
let verified: VerifiedRecoverableSignature | undefined;

/**
 * Verify one compact65 recoverable secp256k1 signature against its exact
 * digest and compressed public key. A second exact call may consume the one
 * successful result; every other call performs the cryptographic check.
 */
export function verifyTwsRecoverableSignature(
  signatureHex: string,
  digest: string,
  publicKey: string,
): Uint8Array {
  const previous = verified;
  verified = undefined;
  if (
    previous?.signatureHex === signatureHex &&
    previous.digest === digest &&
    previous.publicKey === publicKey
  ) {
    return hexToBytes(signatureHex);
  }

  const bytes = hexToBytes(signatureHex);
  const header = bytes[0];
  if (
    bytes.length !== 65 ||
    header === undefined ||
    header < 31 ||
    header > 34
  ) {
    throw new TypeError("Invalid recoverable signature framing");
  }
  const digestBytes = hexToBytes(digest);
  const signature = secp256k1.Signature
    .fromCompact(bytes.subarray(1))
    .addRecoveryBit(header - 31);

  // Noble 1.9.7 auto-detects DER when an unspecified-format signature starts
  // with 0x30. Preserve that existing rejection branch. For ordinary compact
  // input, low-S plus recovery to the exact bound key proves validity without
  // repeating a separate ECDSA verification.
  const canonicalSignature = bytes[1] === 0x30
    ? secp256k1.verify(
        bytes.subarray(1),
        digestBytes,
        hexToBytes(publicKey),
        { prehash: false, lowS: true },
      )
    : !signature.hasHighS();
  if (
    !canonicalSignature ||
    bytesToHex(signature.recoverPublicKey(digestBytes).toBytes(true)) !==
      publicKey
  ) {
    throw new TypeError("Recoverable signature verification failed");
  }
  verified = Object.freeze({ signatureHex, digest, publicKey });
  return bytes;
}
