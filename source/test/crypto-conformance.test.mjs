import assert from "node:assert/strict";
import test from "node:test";
import { canonicalize } from "../scripts/lib/canonical-json.mjs";
import * as cryptoConformance from "../scripts/lib/crypto-conformance.mjs";
import { readJson, repositoryRoot } from "../scripts/lib/repository.mjs";

const root = repositoryRoot(import.meta.url);

test("derives Draft.3 business identifiers from literal known answers", () => {
  const vectors = readJson(root, "test-vectors/identifiers.json");
  assert.equal(typeof cryptoConformance.derivePermissionId, "function");
  assert.equal(typeof cryptoConformance.deriveBroadcastIdempotencyKey, "function");
  assert.equal(
    cryptoConformance.derivePermissionId(vectors.permission.input),
    vectors.permission.expected,
  );
  assert.equal(
    cryptoConformance.derivePermissionId(vectors.permissionSecondary.input),
    vectors.permissionSecondary.expected,
  );
  assert.equal(
    cryptoConformance.deriveBroadcastIdempotencyKey(vectors.broadcast.input),
    vectors.broadcast.expected,
  );
});

test("separates official TBC networks by Chain ID rather than address prefix", () => {
  const vectors = readJson(root, "test-vectors/identifiers.json");
  const mainnet = vectors.vectors.find(({ network }) => network === "mainnet");
  const testnet = vectors.vectors.find(({ network }) => network === "testnet");

  assert.equal(mainnet.addressVersion, "00");
  assert.equal(testnet.addressVersion, "00");
  assert.match(testnet.address, /^1/);
  assert.equal(testnet.address, mainnet.address);
  assert.notEqual(testnet.chainId, mainnet.chainId);
  assert.notEqual(testnet.accountId, mainnet.accountId);
});

test("rejects ambiguous Draft.3 business identifier inputs", () => {
  const vectors = readJson(root, "test-vectors/identifiers.json");
  assert.throws(
    () => cryptoConformance.derivePermissionId({
      ...vectors.permission.input,
      operationId: "not-a-deterministic-operation-id",
    }),
    /operationId must encode exactly 32 bytes as base64url/,
  );
  assert.throws(
    () => cryptoConformance.derivePermissionId({
      ...vectors.permission.input,
      chainId: "tbc:MAINNET",
    }),
    /chainId must be a TBC Chain ID/,
  );
  assert.throws(
    () => cryptoConformance.derivePermissionId({
      ...vectors.permission.input,
      parentCapability: "",
    }),
    /parentCapability must be a non-empty capability name/,
  );
  assert.throws(
    () => cryptoConformance.derivePermissionId({
      ...vectors.permission.input,
      ordinal: -1,
    }),
    /ordinal must be a non-negative safe integer/,
  );
  assert.throws(
    () => cryptoConformance.derivePermissionId({
      ...vectors.permission.input,
      ordinal: 0.5,
    }),
    /ordinal must be a non-negative safe integer/,
  );
  assert.throws(
    () => cryptoConformance.deriveBroadcastIdempotencyKey({
      ...vectors.broadcast.input,
      txid: vectors.broadcast.input.txid.toUpperCase(),
    }),
    /txid must be lowercase 32-byte hex/,
  );
});

test("canonicalizes nested RFC 8785 input with UTF-16 key ordering", () => {
  assert.equal(
    canonicalize({
      z: 0,
      nested: { b: true, a: "TBC" },
      array: [3, null],
    }),
    '{"array":[3,null],"nested":{"a":"TBC","b":true},"z":0}',
  );
});

test("rejects values outside the RFC 8785 I-JSON domain", () => {
  assert.throws(() => canonicalize({ value: Number.POSITIVE_INFINITY }), {
    name: "TypeError",
    message: "JCS rejects non-finite numbers",
  });
  assert.throws(() => canonicalize({ value: "\ud800" }), {
    name: "TypeError",
    message: "JCS rejects strings with lone surrogates",
  });
});

test("keeps the Draft.1 canonical transfer bytes and transaction ids", () => {
  const vector = readJson(root, "test-vectors/integration.json");
  const transaction = vector.canonicalTransfer.bundle.transactions[0];
  assert.equal(
    transaction.txid,
    "e715bbe7ea8e6e95ff339b24e1e2aaff8771e8e17af4682b775919fad953c907",
  );
  assert.equal(
    vector.fixture.parentTxid,
    "f32f5392aa7ab9414bf93d497fde479dce609f6a74b708be7988cf9bb698e4d1",
  );
  assert.equal(
    vector.canonicalTransfer.plan.payload.transactions[0].unsignedTransaction,
    "0a00000001d1e498b69bcf8879be08b7746a9f60ce9d47de7f493df94b41b97aaa92532ff30000000000ffffffff02e8030000000000001976a91406afd46bcdfd22ef94ac122aa11f241244a37ecc88acd8220000000000001976a914751e76e8199196d454941c45d1b3a323f1433bd688ac00000000",
  );
  assert.equal(
    vector.fixture.signatureCompact64,
    "5f8792e014eb953efc9c563e18c8024a750e7513ec575775b371102fde8ceb2256a6df64fe1e2d9e31c2e34f3581464cc682d70e72ec4b78cd44ce891500c60d",
  );
  assert.equal(
    transaction.rawTransaction,
    "0a00000001d1e498b69bcf8879be08b7746a9f60ce9d47de7f493df94b41b97aaa92532ff3000000006a47304402205f8792e014eb953efc9c563e18c8024a750e7513ec575775b371102fde8ceb22022056a6df64fe1e2d9e31c2e34f3581464cc682d70e72ec4b78cd44ce891500c60d41210279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798ffffffff02e8030000000000001976a91406afd46bcdfd22ef94ac122aa11f241244a37ecc88acd8220000000000001976a914751e76e8199196d454941c45d1b3a323f1433bd688ac00000000",
  );
});

test("recomputes every signing and integration cryptographic artifact", () => {
  assert.deepEqual(cryptoConformance.runCryptoConformance(root), {
    signing: 2,
    integrationHashes: 5,
    templates: 1,
    signatures: 1,
    txids: 2,
    workflowDerivations: 1,
    hashKnownAnswers: 18,
    deterministicIds: 5,
    checkpointHashes: 15,
  });
});
