import assert from "node:assert/strict";
import test from "node:test";

import { secp256k1 } from "@noble/curves/secp256k1";
import {
  bytesToHex,
  verifyTwsRecoverableSignature,
} from "../dist/esm/index.js";

const SCALAR = Uint8Array.from({ length: 32 }, (_, index) =>
  index === 31 ? 1 : 0
);
const OTHER_SCALAR = Uint8Array.from({ length: 32 }, (_, index) =>
  index === 31 ? 2 : 0
);
const DIGEST = "42".repeat(32);
const PUBLIC_KEY = bytesToHex(secp256k1.getPublicKey(SCALAR, true));
const OTHER_PUBLIC_KEY = bytesToHex(
  secp256k1.getPublicKey(OTHER_SCALAR, true),
);

function recoverable(signature) {
  return `${(31 + signature.recovery).toString(16)}${signature.toCompactHex()}`;
}

test("one exact verified tuple is consumed once and mutable output is not trusted", () => {
  const signature = secp256k1.sign(DIGEST, SCALAR, {
    prehash: false,
    lowS: true,
  });
  const encoded = recoverable(signature);
  const first = verifyTwsRecoverableSignature(
    encoded,
    DIGEST,
    PUBLIC_KEY,
  );
  first.fill(0);

  const consumed = verifyTwsRecoverableSignature(
    encoded,
    DIGEST,
    PUBLIC_KEY,
  );
  assert.equal(bytesToHex(consumed), encoded);

  // A third exact call must still succeed through the full verifier. The Kit
  // bundle identity test counts recovery calls across the Signer/Core boundary
  // to prove the one-use optimization itself without relying on Core's bundled
  // private Noble instance here.
  assert.equal(
    bytesToHex(verifyTwsRecoverableSignature(encoded, DIGEST, PUBLIC_KEY)),
    encoded,
  );
});

test("mismatches and malformed signatures fail closed without leaving a marker", () => {
  const signature = secp256k1.sign(DIGEST, SCALAR, {
    prehash: false,
    lowS: true,
  });
  const encoded = recoverable(signature);
  const wrongDigestSignature = recoverable(
    secp256k1.sign("43".repeat(32), SCALAR, {
      prehash: false,
      lowS: true,
    }),
  );
  const wrongKeySignature = recoverable(
    secp256k1.sign(DIGEST, OTHER_SCALAR, {
      prehash: false,
      lowS: true,
    }),
  );
  const highS = new secp256k1.Signature(
    signature.r,
    secp256k1.CURVE.n - signature.s,
    signature.recovery ^ 1,
  );
  const invalid = [
    [wrongDigestSignature, DIGEST, PUBLIC_KEY],
    [wrongKeySignature, DIGEST, PUBLIC_KEY],
    [encoded, DIGEST, OTHER_PUBLIC_KEY],
    [
      `${(31 + (signature.recovery ^ 1)).toString(16)}${signature.toCompactHex()}`,
      DIGEST,
      PUBLIC_KEY,
    ],
    [recoverable(highS), DIGEST, PUBLIC_KEY],
    [`1e${signature.toCompactHex()}`, DIGEST, PUBLIC_KEY],
    [encoded.slice(2), DIGEST, PUBLIC_KEY],
  ];
  for (const tuple of invalid) {
    assert.throws(() => verifyTwsRecoverableSignature(...tuple));
    assert.throws(() => verifyTwsRecoverableSignature(...tuple));
  }
});

test("DER-shaped compact input preserves the existing noble rejection branch", () => {
  const digest = "f1".repeat(32);
  const signature = secp256k1.Signature.fromCompact(
    `303e021d${"01".repeat(29)}021d${"22".repeat(29)}`,
  ).addRecoveryBit(0);
  const publicKey = bytesToHex(
    signature.recoverPublicKey(digest).toBytes(true),
  );
  assert.equal(signature.hasHighS(), false);
  assert.equal(
    secp256k1.verify(
      signature.toCompactRawBytes(),
      Buffer.from(digest, "hex"),
      Buffer.from(publicKey, "hex"),
      { prehash: false, lowS: true, format: "compact" },
    ),
    true,
  );
  assert.throws(() =>
    verifyTwsRecoverableSignature(
      recoverable(signature),
      digest,
      publicKey,
    )
  );
});
