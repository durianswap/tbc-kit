import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import * as core from "../dist/esm/index.js";

const native = bytes => new Uint8Array(createHash("sha256").update(bytes).digest());

test("optional native SHA-256 preserves exact bytes and public hash identities", () => {
  assert.equal(typeof core.configureSha256Backend, "function");
  let calls = 0;
  core.configureSha256Backend(bytes => { calls++; return native(bytes); });
  try {
    for (const length of [0, 3, 55, 56, 64, 65, 108000]) {
      const backing = Uint8Array.from({ length: length + 17 }, (_, i) => i % 251);
      const bytes = backing.subarray(9, 9 + length);
      const before = bytes.slice();
      const count = calls;
      assert.deepEqual(core.sha256Bytes(bytes), native(bytes));
      assert.equal(calls, count + 1, "one backend call, no second local digest");
      assert.deepEqual(bytes, before);
    }
    const value = { backendVector: "原生摘要😀", amount: 0.25, inputs: [1, 2] };
    const beforeCanonicalHashes = calls;
    assert.equal(core.hashCanonical(value), createHash("sha256").update(core.canonicalize(value)).digest("hex"));
    assert.equal(core.hashCanonical({ ...value }), createHash("sha256").update(core.canonicalize(value)).digest("hex"));
    assert.equal(
      calls,
      beforeCanonicalHashes + 2,
      "canonical hashes are recomputed and never retained in a process-wide memoization cache",
    );
  } finally { core.configureSha256Backend(undefined); }
});

test("invalid setup cannot replace the backend; live failures never silently fall back", () => {
  let fail = false;
  core.configureSha256Backend(bytes => {
    if (fail) throw new Error("native-unavailable");
    return native(bytes);
  });
  try {
    assert.throws(() => core.configureSha256Backend(() => new Uint8Array(32)), /SHA-256/);
    assert.throws(() => core.configureSha256Backend("invalid"), /function/);
    fail = true;
    assert.throws(() => core.sha256Bytes(new Uint8Array([42])), /native-unavailable/);
  } finally { core.configureSha256Backend(undefined); }
  assert.deepEqual(core.sha256Bytes(new Uint8Array([42])), native(new Uint8Array([42])));
});

test("backend result buffers are copied and malformed digests fail closed", () => {
  const reused = new Uint8Array(32);
  let wrongSize = false;
  core.configureSha256Backend(bytes => {
    if (wrongSize) return new Uint8Array(31);
    reused.set(native(bytes));
    return reused;
  });
  try {
    const first = core.sha256Bytes(new Uint8Array([1]));
    core.sha256Bytes(new Uint8Array([2]));
    assert.deepEqual(first, native(new Uint8Array([1])));
    wrongSize = true;
    assert.throws(() => core.sha256Bytes(new Uint8Array([3])), /32 bytes/);
  } finally { core.configureSha256Backend(undefined); }
});
