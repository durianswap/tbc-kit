/**
 * Verify one compact65 recoverable secp256k1 signature against its exact
 * digest and compressed public key. A second exact call may consume the one
 * successful result; every other call performs the cryptographic check.
 */
export declare function verifyTwsRecoverableSignature(signatureHex: string, digest: string, publicKey: string): Uint8Array;
