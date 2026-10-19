import assert from "node:assert/strict";
import test from "node:test";

import tbc from "tbc-lib-js";

import {
  ControlledSignatureVerificationError,
  verifyControlledReviewedResult,
} from "../conformance/controlled-standard-signature-verifier.mjs";

const SIGHASH_ALL_FORKID = 0x41;
const KEY = new tbc.PrivateKey({
  bn: "07".repeat(32),
  network: "testnet",
  compressed: true,
});
const PUBLIC_KEY = KEY.publicKey.toString();
const ADDRESS = KEY.toAddress();
const P2PKH = tbc.Script.buildPublicKeyHashOut(KEY.publicKey).toHex();

function signedTransaction(previousTxid, inputSatoshis, outputSatoshis) {
  const transaction = new tbc.Transaction()
    .from({
      txId: previousTxid,
      outputIndex: 0,
      script: P2PKH,
      satoshis: inputSatoshis,
    })
    .to(ADDRESS, outputSatoshis);
  const unsignedRaw = transaction.uncheckedSerialize();
  transaction.sign(KEY, SIGHASH_ALL_FORKID);
  return Object.freeze({ unsignedRaw, signedRaw: transaction.uncheckedSerialize(), transaction });
}

function transactionRow(transaction, rawTransaction, index, role, dependsOn) {
  return Object.freeze({
    id: `tx-${String(index)}`,
    txid: transaction.id,
    rawTransaction,
    role,
    dependsOn: Object.freeze(dependsOn),
  });
}

function rawFixture() {
  const signed = signedTransaction("11".repeat(32), 1_000, 900);
  const unsigned = new tbc.Transaction(signed.unsignedRaw);
  const signature = tbc.Transaction.sighash
    .sign(
      unsigned,
      KEY,
      SIGHASH_ALL_FORKID,
      0,
      tbc.Script.fromBuffer(Buffer.from(P2PKH, "hex")),
      new tbc.crypto.BN(1_000),
    )
    .toTxFormat()
    .toString("hex");
  return Object.freeze({
    request: Object.freeze({
      payload: Object.freeze({
        format: "raw",
        transactions: Object.freeze([Object.freeze({
          rawTransaction: signed.unsignedRaw,
          inputs: Object.freeze([Object.freeze({ satoshis: "1000", scriptPubKey: P2PKH })]),
        })]),
      }),
    }),
    result: Object.freeze({
      version: "1.0",
      chainId: "tbc:testnet",
      from: ADDRESS.toString(),
      requestHash: "11".repeat(32),
      approvalId: "approval-raw",
      transactions: Object.freeze([
        transactionRow(unsigned, signed.unsignedRaw, 1, "primary", []),
      ]),
      totalFee: "100",
      detachedSignatures: Object.freeze([Object.freeze([signature])]),
    }),
  });
}

function associatedFixture() {
  const source = signedTransaction("22".repeat(32), 1_000, 900);
  const childTransaction = new tbc.Transaction()
    .from({
      txId: source.transaction.id,
      outputIndex: 0,
      script: P2PKH,
      satoshis: 900,
    })
    .to(ADDRESS, 800);
  childTransaction.sign(KEY, SIGHASH_ALL_FORKID);
  const childRaw = childTransaction.uncheckedSerialize();
  return Object.freeze({
    request: Object.freeze({
      payload: Object.freeze({
        format: "associated",
        sourceTransaction: source.unsignedRaw,
        sourceInputs: Object.freeze([Object.freeze({
          txid: "22".repeat(32),
          outputIndex: 0,
          satoshis: "1000",
          scriptPubKey: P2PKH,
          signingProfile: "p2pkh",
        })]),
        children: Object.freeze([Object.freeze({
          inputs: Object.freeze([Object.freeze({ outputIndex: 0, signingProfile: "p2pkh" })]),
          outputs: Object.freeze([Object.freeze({ satoshis: "800", scriptPubKey: P2PKH })]),
        })]),
      }),
    }),
    result: Object.freeze({
      version: "1.0",
      chainId: "tbc:testnet",
      from: ADDRESS.toString(),
      requestHash: "22".repeat(32),
      approvalId: "approval-associated",
      transactions: Object.freeze([
        transactionRow(source.transaction, source.signedRaw, 1, "prerequisite", []),
        transactionRow(childTransaction, childRaw, 2, "primary", ["tx-1"]),
      ]),
      totalFee: "200",
    }),
  });
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test("independently verifies the bounded raw ForkID detached signature", () => {
  const fixture = rawFixture();
  assert.deepEqual(
    verifyControlledReviewedResult({ ...fixture, publicKey: PUBLIC_KEY }),
    {
      valid: true,
      kind: "raw",
      transactionCount: 1,
      verifiedInputCount: 1,
      dependencyCount: 0,
      outputsMatch: true,
    },
  );
});

test("independently verifies both associated P2PKH signatures and signed-parent dependency", () => {
  const fixture = associatedFixture();
  assert.deepEqual(
    verifyControlledReviewedResult({ ...fixture, publicKey: PUBLIC_KEY }),
    {
      valid: true,
      kind: "associated",
      transactionCount: 2,
      verifiedInputCount: 2,
      dependencyCount: 1,
      outputsMatch: true,
    },
  );
});

test("fails closed for a changed detached signature", () => {
  const fixture = rawFixture();
  const result = plain(fixture.result);
  const signature = result.detachedSignatures[0][0];
  result.detachedSignatures[0][0] = `${signature.slice(0, 12)}${signature.slice(12, 14) === "00" ? "01" : "00"}${signature.slice(14)}`;
  assert.throws(
    () => verifyControlledReviewedResult({ request: fixture.request, result, publicKey: PUBLIC_KEY }),
    ControlledSignatureVerificationError,
  );
});

test("fails closed when the associated result changes an approved output", () => {
  const fixture = associatedFixture();
  const request = plain(fixture.request);
  request.payload.children[0].outputs[0].satoshis = "801";
  assert.throws(
    () => verifyControlledReviewedResult({ request, result: fixture.result, publicKey: PUBLIC_KEY }),
    /Associated approved output mismatch/u,
  );
});

test("fails closed when the Standard bundle omits the signed-parent dependency", () => {
  const fixture = associatedFixture();
  const result = plain(fixture.result);
  result.transactions[1].dependsOn = [];
  assert.throws(
    () => verifyControlledReviewedResult({ request: fixture.request, result, publicKey: PUBLIC_KEY }),
    /Invalid reviewed transaction result/u,
  );
});

test("fails closed outside the one-raw or one-parent-one-child acceptance boundary", () => {
  const raw = rawFixture();
  const rawRequest = plain(raw.request);
  rawRequest.payload.transactions.push(rawRequest.payload.transactions[0]);
  assert.throws(
    () => verifyControlledReviewedResult({ request: rawRequest, result: raw.result, publicKey: PUBLIC_KEY }),
    /Unsupported controlled raw request boundary/u,
  );

  const associated = associatedFixture();
  const associatedRequest = plain(associated.request);
  associatedRequest.payload.children.push(associatedRequest.payload.children[0]);
  assert.throws(
    () => verifyControlledReviewedResult({ request: associatedRequest, result: associated.result, publicKey: PUBLIC_KEY }),
    /Unsupported controlled associated request boundary/u,
  );
});
