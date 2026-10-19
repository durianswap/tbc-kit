import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as core from "../dist/esm/index.js";

const readVector = async (name) =>
  JSON.parse(
    await readFile(new URL(`../../../test-vectors/${name}`, import.meta.url), "utf8"),
  );

test("portable crypto implements RFC 8785 primitives without ambient codecs", () => {
  assert.equal(
    core.canonicalize({ z: 0, "\ue000": 1, "\ud834\udd1e": 2, a: -0 }),
    '{"a":0,"z":0,"𝄞":2,"":1}',
  );
  assert.equal(
    core.sha256Hex(core.utf8("abc")),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  assert.equal(
    core.base64urlEncode(core.sha256Bytes(core.utf8("abc"))),
    "ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0",
  );

  assert.throws(() => core.canonicalize(Number.POSITIVE_INFINITY), /non-finite/);
  assert.throws(() => core.canonicalize("\ud800"), /lone surrogate/);
  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(() => core.canonicalize(cyclic), /cyclic/);
  assert.throws(() => core.hexToBytes("AA"), /lowercase/);
});

test("portable crypto derives the frozen Draft.6 release fingerprint", () => {
  assert.equal(
    core.hashCanonical(core.TWS_RELEASE),
    core.TWS_RELEASE_FINGERPRINT,
  );
});

test("portable crypto matches operation, call, permission, broadcast, and commit KATs", async () => {
  const replay = await readVector("port-replay.json");
  const identifiers = await readVector("identifiers.json");
  const provider = await readVector("provider.json");

  assert.equal(
    core.deriveOperationId(replay.ids.operation.input),
    replay.ids.operation.expected,
  );
  assert.equal(
    core.deriveCallId(replay.ids.call.input),
    replay.ids.call.expected,
  );
  assert.equal(
    core.derivePermissionId(identifiers.permission.input),
    identifiers.permission.expected,
  );
  assert.equal(
    core.derivePermissionId(identifiers.permissionSecondary.input),
    identifiers.permissionSecondary.expected,
  );
  assert.equal(
    core.deriveBroadcastIdempotencyKey(identifiers.broadcast.input),
    identifiers.broadcast.expected,
  );
  assert.equal(
    core.deriveProviderCommitId(provider.providerSessions.commitId.input),
    provider.providerSessions.switchA.commitId,
  );

  assert.notEqual(
    core.deriveOperationId({
      ...replay.ids.operation.input,
      requestId: "lifecycle-request-2",
    }),
    replay.ids.operation.expected,
  );
});

test("portable crypto rejects ambiguous deterministic identifier inputs", async () => {
  const replay = await readVector("port-replay.json");
  const identifiers = await readVector("identifiers.json");

  assert.throws(
    () =>
      core.deriveOperationId({
        ...replay.ids.operation.input,
        releaseFingerprint: "AA".repeat(32),
      }),
    /lowercase Hash32/,
  );
  assert.throws(
    () =>
      core.deriveCallId({
        ...replay.ids.call.input,
        checkpointRevision: "01",
      }),
    /canonical decimal/,
  );
  assert.throws(
    () =>
      core.derivePermissionId({
        ...identifiers.permission.input,
        ordinal: -1,
      }),
    /non-negative safe integer/,
  );
  assert.throws(
    () =>
      core.deriveBroadcastIdempotencyKey({
        ...identifiers.broadcast.input,
        txid: identifiers.broadcast.input.txid.toUpperCase(),
      }),
    /lowercase 32-byte hex/,
  );
});
