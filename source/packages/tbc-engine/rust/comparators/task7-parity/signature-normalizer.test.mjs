import assert from "node:assert/strict";
import test from "node:test";
import { secp256k1 } from "@noble/curves/secp256k1";
import { compareEvidence, parseRawTransaction } from "./raw-comparator.mjs";
import { fixturePair, transaction, editRaw, ftPreTx } from "./locator-fixtures.mjs";
import { fixturePush, fixtureSign, fixtureCurrentData, fixtureAncestry } from "./signature-fixtures.mjs";

// Pinned large Pool scripts sign only a locked swap, not create/init.
const target = "swap-tbc-for-token-locked";
const strictPair = () => fixturePair({ coin: true });
const compare = (pair) => compareEvidence(...pair);
const expectCode = (pair, code) => assert.throws(() => compare(pair), { code });
function inputEdit(pair, edit, side = 1, name = target, inputIndex = 0) {
  const t = transaction(pair[side], name);
  editRaw(t, (raw) => { raw.inputs[inputIndex].script = edit(Buffer.from(raw.inputs[inputIndex].script, "hex"), t, raw).toString("hex"); }, "finalizedRaw");
}
const signatureEnd = (bytes) => 1 + bytes[0];

test("valid nondeterministic low-S ECDSA with exact prefixed FT layouts compares all 25 scenarios", () => {
  const pair = strictPair();
  assert.notEqual(transaction(pair[0], target).finalizedRaw, transaction(pair[1], target).finalizedRaw);
  assert.deepEqual(compare(pair), { ok: true, scenarios: 25 });
});
for (const name of ["swap-tbc-for-token-standard", "swap-token-for-tbc-standard"]) {
  const index = name.startsWith("swap-tbc-") ? 2 : 1;
  test(`exact current_tx_data and ancestry preserved: ${name}`, () => {
    const pair = strictPair(), before = structuredClone(pair);
    const raw = parseRawTransaction(transaction(pair[1], name).finalizedRaw);
    assert.ok(raw.inputs[index].script.startsWith(Buffer.concat([fixtureCurrentData(raw, index), fixtureAncestry()]).toString("hex")));
    assert.equal(compare(pair).ok, true);
    assert.deepEqual(pair, before);
  });
  for (const region of ["current", "ancestry", "suffix"]) test(`rejects ${region} byte mutation: ${name}`, () => {
    const pair = strictPair();
    inputEdit(pair, (bytes, t, raw) => {
      const offset = region === "current" ? 2 : region === "ancestry" ? fixtureCurrentData(raw, index).length + 20 : bytes.length - ftPreTx(true).length + 65;
      bytes[offset] ^= 1; return bytes;
    }, 1, name, index);
    expectCode(pair, region === "suffix" ? "POOL_UNLOCK_SUFFIX" : "SIGNATURE_PREFIX");
  });
}

for (const side of [0, 1]) {
  test(`rejects missing signature, side ${side}`, () => {
    const pair = strictPair(); inputEdit(pair, (b) => b.subarray(signatureEnd(b)), side);
    expectCode(pair, "SIGNATURE_MISSING");
  });
  test(`rejects ambiguous signature/pubkey pairs, side ${side}`, () => {
    const pair = strictPair(); inputEdit(pair, (b) => Buffer.concat([b.subarray(0, signatureEnd(b) + 34), b]), side);
    expectCode(pair, "SIGNATURE_AMBIGUOUS");
  });
  test(`rejects extra standalone signature push, side ${side}`, () => {
    const pair = strictPair(); inputEdit(pair, (b) => Buffer.concat([b, b.subarray(0, signatureEnd(b))]), side);
    expectCode(pair, "SIGNATURE_EXTRA");
  });
  test(`rejects unregistered layout even on matching evidence, side ${side}`, () => {
    const pair = strictPair();
    for (const e of pair) transaction(e, target).signingRequests[0].recipe.kind = "producer-selected-offset";
    expectCode(pair, "SIGNATURE_LAYOUT_UNREGISTERED");
  });
  test(`rejects invalid DER, side ${side}`, () => {
    const pair = strictPair(); inputEdit(pair, (b) => { b[2] ^= 1; return b; }, side);
    expectCode(pair, "SIGNATURE_DER");
  });
  test(`rejects high-S, side ${side}`, () => {
    const pair = strictPair(); inputEdit(pair, (b) => {
      const end = signatureEnd(b), sig = secp256k1.Signature.fromDER(b.subarray(1, end - 1));
      const high = new secp256k1.Signature(sig.r, secp256k1.CURVE.n - sig.s).toDERRawBytes();
      return Buffer.concat([fixturePush(Buffer.concat([high, Buffer.from([65])])), b.subarray(end)]);
    }, side); expectCode(pair, "SIGNATURE_LOW_S");
  });
  test(`rejects signature for a different digest, side ${side}`, () => {
    const pair = strictPair(); inputEdit(pair, (b) => Buffer.concat([fixturePush(fixtureSign("22".repeat(32))), b.subarray(signatureEnd(b))]), side);
    expectCode(pair, "SIGNATURE_INVALID");
  });
  test(`rejects signature for a different key, side ${side}`, () => {
    const pair = strictPair(); inputEdit(pair, (b, t) => Buffer.concat([
      fixturePush(fixtureSign(t.signingRequests[0].digest, 1, "02".padStart(64, "0"))), b.subarray(signatureEnd(b)),
    ]), side); expectCode(pair, "SIGNATURE_INVALID");
  });
  test(`rejects appended sighash mismatch, side ${side}`, () => {
    const pair = strictPair(); inputEdit(pair, (b) => { b[signatureEnd(b) - 1] = 0x42; return b; }, side);
    expectCode(pair, "SIGNATURE_SIGHASH");
  });
  test(`rejects truncated push after the signature, side ${side}`, () => {
    const pair = strictPair(); inputEdit(pair, (b) => Buffer.concat([b, Buffer.from([0x4d, 0xff])]), side);
    expectCode(pair, "SIGNATURE_SCRIPT");
  });
}

for (const [field, value, code] of [
  ["digest", "00".repeat(32), "SIGNATURE_DIGEST"],
  ["publicKey", `02${"00".repeat(32)}`, "SIGNATURE_PUBLIC_KEY"],
  ["sighashType", 66, "SIGNATURE_SIGHASH"],
  ["inputIndex", 1, "SIGNATURE_REQUEST_MISSING"],
]) test(`independently rejects matching but false ${field} declarations`, () => {
  const pair = strictPair();
  for (const e of pair) transaction(e, target).signingRequests[0][field] = value;
  expectCode(pair, code);
});
test("independently binds the spent outpoint", () => {
  const pair = strictPair();
  for (const e of pair) transaction(e, target).signingRequests[0].prevout.txid = "00".repeat(32);
  expectCode(pair, "SIGNATURE_PREVOUT");
});
test("rejects ambiguous signing requests", () => {
  const pair = strictPair();
  for (const e of pair) transaction(e, target).signingRequests.push(structuredClone(transaction(e, target).signingRequests[0]));
  expectCode(pair, "SIGNATURE_REQUEST_AMBIGUOUS");
});
test("no first-DER-looking fallback when the registered FT signature is missing", () => {
  const pair = strictPair(), name = "swap-token-for-tbc-standard", index = 1;
  inputEdit(pair, (bytes, t, raw) => {
    const prefix = fixtureCurrentData(raw, index).length + fixtureAncestry().length;
    const sigEnd = prefix + 1 + bytes[prefix];
    return Buffer.concat([bytes.subarray(0, prefix), bytes.subarray(sigEnd), bytes.subarray(prefix, sigEnd)]);
  }, 1, name, index);
  expectCode(pair, "SIGNATURE_MISSING");
});
test("only signature bytes may change in a finalized transaction body", () => {
  const pair = strictPair();
  editRaw(transaction(pair[1], target), (raw) => { raw.lockTime ^= 1; }, "finalizedRaw");
  expectCode(pair, "SIGNATURE_TRANSACTION_BODY");
});
