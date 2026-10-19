import assert from "node:assert/strict";
import test from "node:test";

import { createLegacyDependentBatchCoordinator } from "../dist/esm/wallet.js";

function input(txidByte, vout = 0) {
  const littleEndian = vout.toString(16).padStart(8, "0").match(/../gu)?.reverse().join("");
  if (littleEndian === undefined) throw new Error("invalid fixture vout");
  return `${txidByte.repeat(32)}${littleEndian}00ffffffff`;
}

function raw(txidByte, vout = 0) {
  return `0a00000001${input(txidByte, vout)}0100000000000000000000000000`;
}

const template = Object.freeze({
  message: JSON.stringify({ purpose: "deposit" }),
  encoding: "utf8",
});

test("dependent batch validates the message before starting", async () => {
  let firstCalls = 0;
  const outcome = await createLegacyDependentBatchCoordinator().run({
    messageTemplate: { message: "[]", encoding: "utf8" },
    executeFirst: async () => {
      firstCalls += 1;
      return { value: "first", result: {}, rawTransactions: [raw("11")] };
    },
    executeSecond: async () => ({ value: "second", result: {} }),
  });
  assert.deepEqual(outcome, { status: "invalid-template" });
  assert.equal(firstCalls, 0);
});

test("dependent batch preserves txid order, ACK order and progress", async () => {
  const calls = [];
  const progress = [];
  const coordinator = createLegacyDependentBatchCoordinator({
    onProgress(value) {
      progress.push(value);
      throw new Error("non-authoritative presentation failure");
    },
  });
  const outcome = await coordinator.run({
    messageTemplate: template,
    executeFirst: async () => {
      calls.push("first");
      return {
        value: { id: "first-value" },
        result: { txraw: "opaque" },
        rawTransactions: [raw("11"), raw("22", 1)],
        acknowledge: async () => calls.push("ack"),
      };
    },
    executeSecond: async (message) => {
      calls.push("second");
      const decoded = JSON.parse(message.message);
      assert.equal(message.encoding, "utf8");
      assert.equal(decoded.purpose, "deposit");
      assert.equal(decoded.txids.length, 2);
      assert.match(decoded.txids[0], /^[0-9a-f]{64}$/u);
      assert.match(decoded.txids[1], /^[0-9a-f]{64}$/u);
      assert.notEqual(decoded.txids[0], decoded.txids[1]);
      return { value: { id: "second-value" }, result: { signature: "ok" } };
    },
  });
  assert.equal(outcome.status, "complete");
  assert.deepEqual(calls, ["first", "ack", "second"]);
  assert.deepEqual(progress, [
    { completed: 0, total: 2, stage: "signing" },
    { completed: 1, total: 2, stage: "signing" },
    { completed: 2, total: 2, stage: "finalizing" },
  ]);
});

test("dependent batch stops on the first business error", async () => {
  let acknowledged = false;
  let secondCalls = 0;
  const first = {
    value: { id: "first" },
    result: { error: "cancelled" },
    rawTransactions: [raw("11")],
    acknowledge: async () => {
      acknowledged = true;
    },
  };
  const outcome = await createLegacyDependentBatchCoordinator().run({
    messageTemplate: template,
    executeFirst: async () => first,
    executeSecond: async () => {
      secondCalls += 1;
      return { value: "second", result: {} };
    },
  });
  assert.deepEqual(outcome, { status: "first-error", first });
  assert.equal(acknowledged, false);
  assert.equal(secondCalls, 0);
});

test("dependent batch returns second error only after first ACK", async () => {
  const calls = [];
  const progress = [];
  const first = {
    value: "first",
    result: { txraw: "opaque" },
    rawTransactions: [raw("11")],
    acknowledge: async () => calls.push("ack"),
  };
  const second = { value: "second", result: { error: "cancelled" } };
  const outcome = await createLegacyDependentBatchCoordinator({
    onProgress: (value) => progress.push(value),
  }).run({
    messageTemplate: template,
    executeFirst: async () => first,
    executeSecond: async () => {
      calls.push("second");
      return second;
    },
  });
  assert.deepEqual(outcome, { status: "second-error", first, second });
  assert.deepEqual(calls, ["ack", "second"]);
  assert.deepEqual(progress, [
    { completed: 0, total: 2, stage: "signing" },
    { completed: 1, total: 2, stage: "signing" },
  ]);
});

test("dependent batch rejects missing raws before ACK", async () => {
  let acknowledged = false;
  await assert.rejects(
    createLegacyDependentBatchCoordinator().run({
      messageTemplate: template,
      executeFirst: async () => ({
        value: "first",
        result: {},
        rawTransactions: [],
        acknowledge: async () => {
          acknowledged = true;
        },
      }),
      executeSecond: async () => ({ value: "second", result: {} }),
    }),
    /Invalid Legacy dependent batch result/u,
  );
  assert.equal(acknowledged, false);
});
