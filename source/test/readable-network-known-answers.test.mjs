import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (name) => JSON.parse(readFileSync(new URL(`../test-vectors/${name}.json`, import.meta.url)));
// Independent encoder for these checked-in JSON fixtures only. Do not import
// the production canonicalizer or derivation helpers under test.
const encode = (value) => value === null || typeof value !== "object"
  ? JSON.stringify(value)
  : Array.isArray(value) ? `[${value.map(encode).join(",")}]`
  : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${encode(value[key])}`).join(",")}}`;
const hash = (bytes, format = "hex") => createHash("sha256").update(bytes).digest(format);
const bytes = (text) => Buffer.from(text, "utf8");
const zero = Buffer.from([0]);

test("readable-network operation, call and commit known answers match independent byte derivation", () => {
  const { operation, call } = read("port-replay").ids;
  const i = operation.input;
  assert.equal(i.operation.params.chainId, "tbc:mainnet");
  assert.equal(hash(Buffer.concat([
    bytes("TWS/1.0/operation"), zero,
    Buffer.from(i.releaseFingerprint, "hex"), Buffer.from(i.contextHash, "hex"),
    bytes(encode(i.requestId)), zero, bytes(encode(i.operation)),
  ]), "base64url"), "cNB8h3rzetsQsQLJAPDlZ7fn2h9a0VIaXnjAZRQJYsY");
  assert.equal(hash(bytes([
    "TWS/1.0/port-call", call.input.operationId, call.input.checkpointRevision,
    call.input.effectOrdinal, call.input.operationName,
  ].join("\0")), "base64url"), "1FYldPLoxmyjMXnuM59MMJevCqv3N88DcNZdSpTWbec");
  const commit = read("provider").providerSessions.commitId.input;
  assert.equal(hash(bytes([
    "TWS/1.0/provider-commit", commit.operationId, commit.checkpointRevision,
    encode(commit.mutationPayload),
  ].join("\0")), "base64url"), "KtfmSX2l0hJ0hW6xqJsNSbAny3RFZZIIh5vJZeIMeqo");
});

test("readable-network workflow hashes retain full request, plan and typed-data binding", () => {
  const vector = read("workflow").vectors[0];
  assert.equal(hash(bytes(encode(vector.request))), "9b0c4ede6733bb8f0822e381a852b50fa5a8800a93466ef80470ec5fbaf50f4d");
  assert.equal(hash(bytes(encode(vector.plan.payload))), "310a55e35c088769556813a770313eab3323364b2dcb62b602d026abd6057540");
  const compact = (length) => {
    assert.ok(length < 65536);
    if (length < 253) return Buffer.from([length]);
    const result = Buffer.alloc(3);
    result[0] = 253;
    result.writeUInt16LE(length, 1);
    return result;
  };
  const magic = bytes("TBC Signed Typed Data:\n");
  const digest = (envelope) => {
    const body = bytes(encode(envelope));
    const first = createHash("sha256")
      .update(Buffer.concat([compact(magic.length), magic, compact(body.length), body])).digest();
    return hash(first);
  };
  assert.equal(digest(vector.derivation.resolvedEnvelope), "ff32b007969a5d543880a9f8e34d48b6707b8c6dd1bb85cd69688addcf63a1d4");
  const wrongChain = structuredClone(vector.derivation.resolvedEnvelope);
  wrongChain.domain.chainId = "tbc:testnet";
  assert.notEqual(digest(wrongChain), vector.derivation.digest);
});
