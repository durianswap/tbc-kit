import assert from "node:assert/strict";
import test from "node:test";

import {
  createLegacyGenericBatchExecutor,
  normalizeLegacyGenericBatchRequests,
} from "../dist/esm/wallet.js";

function input(txidByte, vout = 0) {
  const littleEndian = vout.toString(16).padStart(8, "0").match(/../gu)?.reverse().join("");
  return `${txidByte.repeat(32)}${littleEndian}00ffffffff`;
}

function raw(txidByte, vout = 0) {
  return `0a00000001${input(txidByte, vout)}0100000000000000000000000000`;
}

test("generic Legacy executor supports 1-5 mixed and repeated operations in order", async () => {
  const calls = [];
  const acks = [];
  const progress = [];
  const requests = [
    { method: "encrypt", params: { message: "a" } },
    { method: "encrypt", params: { message: "b" } },
    {
      method: "sendTransaction",
      params: { flag: "P2PKH", address: "x", satoshis: "1", broadcastEnabled: false },
    },
    {
      method: "signMessage",
      dependsOn: "settlementTxids",
      params: { message: JSON.stringify({ order: "7" }), encoding: "utf8" },
    },
    { method: "decrypt", params: { encryptedMessage: "ciphertext" } },
  ];
  const executor = createLegacyGenericBatchExecutor({
    onProgress(value) {
      progress.push(value);
    },
    async execute(request, index) {
      calls.push([request.method, request.params]);
      if (index === 3) {
        const message = JSON.parse(request.params.message);
        assert.equal(message.order, "7");
        assert.equal(message.settlementTxids.length, 1);
      }
      return {
        value: `step-${index}`,
        result: index === 2 ? { txraw: raw("22") } : { ok: index },
        acknowledge: () => acks.push(index),
      };
    },
  });
  const outcome = await executor.run(requests);
  assert.equal(outcome.status, "complete");
  assert.deepEqual(calls.map(([method]) => method), [
    "encrypt", "encrypt", "sendTransaction", "signMessage", "decrypt",
  ]);
  assert.deepEqual(acks, [0, 1, 2, 3, 4]);
  assert.equal(outcome.results.length, 5);
  assert.deepEqual(outcome.executions, ["step-0", "step-1", "step-2", "step-3", "step-4"]);
  assert.deepEqual(progress.at(-1), { completed: 5, total: 5, stage: "complete" });
});

test("generic Legacy executor keeps independent later results after a step error", async () => {
  const outcome = await createLegacyGenericBatchExecutor({
    async execute(request, index) {
      if (index === 0) throw new Error("first failed");
      return { value: request.method, result: { ok: true } };
    },
  }).run([
    { method: "encrypt", params: { message: "a" } },
    { method: "decrypt", params: { encryptedMessage: "b" } },
  ]);
  assert.deepEqual(outcome.results, [{ error: "first failed" }, { ok: true }]);
});

test("generic Legacy dependency fails closed without txids but does not execute it", async () => {
  let calls = 0;
  const outcome = await createLegacyGenericBatchExecutor({
    async execute(_request, index) {
      calls += 1;
      return { value: index, result: index === 0 ? { sigs: [["aa"]] } : { ok: true } };
    },
  }).run([
    { method: "signTransaction", params: { txraws: [], utxos_satoshis: [], script_pubkeys: [] } },
    {
      method: "signMessage",
      dependsOn: "txids",
      params: { message: "{}", encoding: "utf8" },
    },
  ]);
  assert.equal(calls, 1);
  assert.deepEqual(outcome.results[1], { error: "Previous request failed or produced no txids" });
});

test("generic Legacy normalization enforces bounds, sign-only sends and merge exclusion", () => {
  assert.throws(() => normalizeLegacyGenericBatchRequests([]), /1 to 5/);
  assert.throws(() => normalizeLegacyGenericBatchRequests(Array.from({ length: 6 }, () => ({
    method: "encrypt", params: { message: "x" },
  }))), /1 to 5/);
  assert.throws(() => normalizeLegacyGenericBatchRequests([{
    method: "sendTransaction",
    params: { flag: "P2PKH", broadcastEnabled: true },
  }]), /sign-only/);
  assert.throws(() => normalizeLegacyGenericBatchRequests([{
    method: "sendTransaction",
    params: { flag: "FT_MERGE", broadcastEnabled: false },
  }]), /cannot merge/);
});

test("generic Legacy normalization accepts exactly the six historical methods", () => {
  const first = normalizeLegacyGenericBatchRequests([
    {
      id: "page-owned-id-is-not-authority",
      method: "sendTransaction",
      params: { flag: "P2PKH", broadcastEnabled: false },
    },
    { method: "signTransaction", params: {} },
    { method: "signAssociatedTransaction", params: {} },
    { method: "signMessage", params: { message: "{}", encoding: "utf8" } },
    { method: "encrypt", params: { message: "cleartext" } },
  ]);
  const second = normalizeLegacyGenericBatchRequests([
    { method: "decrypt", params: { encryptedMessage: "ciphertext" } },
  ]);
  assert.deepEqual([...first, ...second].map(({ method }) => method), [
    "sendTransaction",
    "signTransaction",
    "signAssociatedTransaction",
    "signMessage",
    "encrypt",
    "decrypt",
  ]);
  assert.equal(Object.hasOwn(first[0], "id"), false);
  assert.throws(() => normalizeLegacyGenericBatchRequests([
    { method: "unknown", params: {} },
  ]), /Invalid Legacy batch request/);
});

test("generic Legacy dependency rejects unsafe injection fields", () => {
  for (const dependsOn of ["__proto__", "constructor", "prototype", "nested.path"]) {
    assert.throws(() => normalizeLegacyGenericBatchRequests([
      { method: "encrypt", params: { message: "first" } },
      {
        method: "signMessage",
        dependsOn,
        params: { message: "{}", encoding: "utf8" },
      },
    ]), /Invalid Legacy batch request/);
  }
});
