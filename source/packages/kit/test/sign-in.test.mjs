import assert from "node:assert/strict";
import test from "node:test";
import { secp256k1 } from "@noble/curves/secp256k1";
import * as core from "../../core/dist/esm/index.js";
import { createSignInMessage, signIn, verifySignIn } from "../dist/esm/index.js";

const CHAIN_ID = "tbc:mainnet";
const ADDRESS = "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH";
const UNRELATED_ADDRESS = "1BoatSLRHtKNngkdXEeobR76b53LETtpyT";
const PRIVATE_KEY = Uint8Array.from({ length: 32 }, (_, index) => index === 31 ? 1 : 0);
const PUBLIC_KEY = Buffer.from(secp256k1.getPublicKey(PRIVATE_KEY, true)).toString("hex");

function providerFixture() {
  const calls = [];
  return {
    calls,
    provider: {
      async request(request) {
        calls.push(structuredClone(request));
        assert.equal(request.method, "tbc_signMessage");
        const envelope = {
          type: "tbc.message",
          version: "1.0",
          message: request.params.message,
        };
        const payload = core.signingPayload(envelope);
        const digest = core.signingEnvelopeDigest(envelope);
        const signed = secp256k1.sign(digest, PRIVATE_KEY, { prehash: false, lowS: true });
        const framed = Buffer.concat([
          Buffer.from([31 + signed.recovery]),
          Buffer.from(signed.toCompactRawBytes()),
        ]);
        return {
          version: "1.0",
          scheme: "tbc-message",
          algorithm: "secp256k1-recoverable-ecdsa-sha256d",
          address: request.params.from,
          accountId: `${request.params.chainId}:${request.params.from}`,
          publicKey: PUBLIC_KEY,
          envelope,
          canonical: core.canonicalSigningEnvelope(envelope),
          signingPayload: Buffer.from(payload).toString("base64"),
          digest,
          signature: framed.toString("base64"),
        };
      },
      on() {},
      removeListener() {},
      destroy() {},
    },
  };
}

const base = {
  chainId: CHAIN_ID,
  address: ADDRESS,
  domain: "example.test",
  uri: "https://example.test/login",
  nonce: "backend_challenge_1234",
  issuedAt: "2026-09-17T01:00:00Z",
  expirationTime: "2026-09-17T01:05:00Z",
  statement: "Sign in to the example application",
};

test("signIn issues exactly one tbc_signMessage and verifySignIn consumes once", async () => {
  const fixture = providerFixture();
  const result = await signIn({ ...base, provider: fixture.provider });
  assert.equal(fixture.calls.length, 1);
  assert.equal(fixture.calls[0].method, "tbc_signMessage");
  assert.equal(fixture.calls[0].params.message.encoding, "utf8");

  const consumed = new Set();
  const consumeChallenge = (challenge) => {
    if (consumed.has(challenge.nonce)) return false;
    consumed.add(challenge.nonce);
    return true;
  };
  const expected = {
    domain: base.domain,
    uri: base.uri,
    chainId: CHAIN_ID,
    address: ADDRESS,
    now: "2026-09-17T01:02:00Z",
  };
  const verified = await verifySignIn({ result, expected, consumeChallenge });
  assert.equal(verified.nonce, base.nonce);
  await assert.rejects(
    verifySignIn({ result, expected, consumeChallenge }),
    /already consumed/,
  );
});

test("sign-in creation requires a canonical relying-party binding", () => {
  assert.throws(
    () => createSignInMessage({ ...base, domain: "other.test" }),
    /domain differs/,
  );
});

test("verifySignIn rejects wrong origin and expired challenges before consumption", async () => {
  const fixture = providerFixture();
  const result = await signIn({ ...base, provider: fixture.provider });
  let consumed = false;
  await assert.rejects(
    verifySignIn({
      result,
      expected: {
        domain: "evil.test",
        uri: "https://evil.test/login",
        chainId: CHAIN_ID,
        address: ADDRESS,
        now: "2026-09-17T01:02:00Z",
      },
      consumeChallenge: () => { consumed = true; return true; },
    }),
    /context mismatch/,
  );
  assert.equal(consumed, false);
  await assert.rejects(
    verifySignIn({
      result,
      expected: {
        domain: base.domain,
        uri: base.uri,
        chainId: CHAIN_ID,
        address: ADDRESS,
        now: "2026-09-17T01:05:00Z",
      },
      consumeChallenge: () => { consumed = true; return true; },
    }),
    /not currently valid/,
  );
  assert.equal(consumed, false);
});

test("verifySignIn rejects a signing key that does not own the claimed address before consumption", async () => {
  const fixture = providerFixture();
  const forged = { ...base, address: UNRELATED_ADDRESS };
  const result = await signIn({ ...forged, provider: fixture.provider });
  let consumeCalls = 0;
  await assert.rejects(
    verifySignIn({
      result,
      expected: {
        domain: forged.domain,
        uri: forged.uri,
        chainId: CHAIN_ID,
        address: UNRELATED_ADDRESS,
        now: "2026-09-17T01:02:00Z",
      },
      consumeChallenge: () => {
        consumeCalls += 1;
        return true;
      },
    }),
    /public key does not own the claimed address/,
  );
  assert.equal(consumeCalls, 0);
});
