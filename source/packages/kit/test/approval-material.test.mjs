import assert from "node:assert/strict";
import test from "node:test";

import {
  collectPoolRemoveInputEvidence,
  collectTransactionInputOutpoints,
  containsCanonicalEvidence,
  createPoolApprovalMaterialReader,
  createPoolRemoveApprovalMaterialReader,
  matchesCurrentPoolUtxoEvidence,
} from "../dist/esm/wallet.js";

function input(txidByte, vout) {
  const voutLittleEndian = vout
    .toString(16)
    .padStart(8, "0")
    .match(/../gu)
    ?.reverse()
    .join("");
  if (voutLittleEndian === undefined) throw new Error("invalid fixture vout");
  return `${txidByte.repeat(32)}${voutLittleEndian}00ffffffff`;
}

test("canonical evidence requires exact material while ignoring order", () => {
  const parents = [
    { txid: "aa", rawTransaction: "11", metadata: { n: 1 } },
    { txid: "bb", rawTransaction: "22", metadata: { n: 2 } },
  ];
  assert.equal(containsCanonicalEvidence(parents, parents.toReversed()), true);
  assert.equal(
    containsCanonicalEvidence(parents, [{ ...parents[0], rawTransaction: "ff" }]),
    false,
  );
  assert.equal(containsCanonicalEvidence([], parents), false);
  assert.equal(containsCanonicalEvidence(parents, []), true);
  assert.equal(containsCanonicalEvidence(parents, [parents[0], { ...parents[0] }]), true);
});

test("Pool removal evidence binds one maintenance prefix and dependent outputs", () => {
  const output = (value, script) => `${value}01${script}`;
  const prefix = {
    id: "ftlp-merge-0",
    role: "maintenance",
    dependsOn: [],
    fee: "500",
    unsignedTransaction: `0a00000003${input("11", 0)}${input("22", 0)}${input("33", 0)}03${output("f401000000000000", "51")}${output("0000000000000000", "6a")}${output("1027000000000000", "52")}00000000`,
  };
  const primary = {
    id: "pool-liquidity-remove",
    role: "primary",
    dependsOn: [prefix.id],
    fee: "100",
    unsignedTransaction: `0a00000003${input("44", 0)}${input("00", 0)}${input("00", 2)}0100000000000000000000000000`,
  };
  const pool = "aa".repeat(32);
  const utxos = [
    { txid: "11".repeat(32), vout: 0, classification: "ftlp", contractId: pool, satoshis: "500", scriptPubKey: "51" },
    { txid: "22".repeat(32), vout: 0, classification: "ftlp", contractId: pool, satoshis: "500", scriptPubKey: "51" },
    { txid: "33".repeat(32), vout: 0, classification: "native", satoshis: "10000", scriptPubKey: "52" },
    { txid: "44".repeat(32), vout: 0, classification: "pool", contractId: pool, satoshis: "1000", scriptPubKey: "53" },
  ];
  const result = collectPoolRemoveInputEvidence([prefix, primary], utxos, pool);
  assert.equal(result.externalOutpoints.length, 4);
  assert.deepEqual(result.inputOutpoints.slice(-2), [
    `${"0".repeat(64)}:0`,
    `${"0".repeat(64)}:2`,
  ]);
  for (const changed of [
    [{ ...prefix, id: "arbitrary-merge" }, primary],
    [prefix, { ...primary, dependsOn: [] }],
    [{ ...prefix, fee: "499" }, primary],
    [prefix, { ...primary, unsignedTransaction: primary.unsignedTransaction.replace(input("00", 2), input("00", 1)) }],
  ]) {
    assert.throws(() => collectPoolRemoveInputEvidence(changed, utxos, pool));
  }
  assert.throws(() =>
    collectPoolRemoveInputEvidence(
      [prefix, primary],
      utxos.map((utxo) =>
        utxo.classification === "ftlp"
          ? { ...utxo, contractId: "bb".repeat(32) }
          : utxo,
      ),
      pool,
    ),
  );
  assert.throws(() =>
    collectPoolRemoveInputEvidence(
      [prefix, primary],
      utxos.filter((utxo) => utxo.classification !== "native"),
      pool,
    ),
  );
});

test("single transaction removal evidence collects every external input", () => {
  const transaction = {
    id: "pool-liquidity-remove",
    role: "primary",
    dependsOn: [],
    fee: "1",
    unsignedTransaction: `0a00000002${input("11", 0)}${input("22", 1)}0100000000000000000000000000`,
  };
  const evidence = collectPoolRemoveInputEvidence([transaction], [], "aa".repeat(32));
  assert.deepEqual(evidence.inputOutpoints, [
    `${"11".repeat(32)}:0`,
    `${"22".repeat(32)}:1`,
  ]);
  assert.deepEqual(evidence.externalOutpoints, evidence.inputOutpoints);
});

test("approval material reads single-flight only for exact unexpired binding and input", async () => {
  let now = 1_000;
  let reads = 0;
  const read = createPoolApprovalMaterialReader(
    async (request) => {
      reads += 1;
      return request;
    },
    () => now,
  );
  const binding = {
    bindingHash: "a".repeat(64),
    payload: { expiresAt: new Date(10_000).toISOString() },
  };
  const request = { direction: "token-for-tbc", amount: "100000000" };
  await Promise.all([read(binding, request), read(binding, request)]);
  await read(binding, request);
  assert.equal(reads, 1);
  await read(binding, { ...request, amount: "100000001" });
  await read({ ...binding, bindingHash: "b".repeat(64) }, request);
  assert.equal(reads, 3);
  now = 10_000;
  await assert.rejects(read(binding, request), /expired/u);
  assert.equal(reads, 3);

  let failures = 0;
  const failed = createPoolRemoveApprovalMaterialReader(async () => {
    failures += 1;
    throw new Error("unverified");
  }, () => 1_000);
  const removeRequest = {
    address: "source",
    receiver: "source",
    poolContractId: "c".repeat(64),
    lpAmount: "1000000",
  };
  await assert.rejects(failed(binding, removeRequest), /unverified/u);
  await assert.rejects(failed(binding, removeRequest), /unverified/u);
  assert.equal(failures, 2);
});

test("current UTXO evidence permits only monotonic confirmations", () => {
  const planned = {
    txid: "11".repeat(32),
    vout: 0,
    satoshis: "500",
    scriptPubKey: "51",
    classification: "ftlp",
    contractId: "22".repeat(32),
    confirmations: "0",
  };
  assert.equal(matchesCurrentPoolUtxoEvidence(planned, { ...planned, confirmations: "1" }), true);
  assert.equal(matchesCurrentPoolUtxoEvidence({ ...planned, confirmations: "1" }, planned), false);
  for (const changed of [
    { satoshis: "501" },
    { txid: "33".repeat(32) },
    { vout: 1 },
    { scriptPubKey: "52" },
    { classification: "native" },
    { contractId: "44".repeat(32) },
    { confirmations: "-1" },
  ]) {
    assert.equal(matchesCurrentPoolUtxoEvidence(planned, { ...planned, ...changed }), false);
  }
});

test("unknown confirmation evidence requires explicit wallet zero policy and cannot replace an observation", () => {
  const unknown = { txid: "11".repeat(32), vout: 0, satoshis: "500", scriptPubKey: "51" };
  const observed = { ...unknown, confirmations: "0" };
  const zero = { minConfirmations: "0" };
  assert.equal(matchesCurrentPoolUtxoEvidence(unknown, unknown), false);
  assert.equal(matchesCurrentPoolUtxoEvidence(unknown, unknown, zero), true);
  assert.equal(matchesCurrentPoolUtxoEvidence(unknown, observed, zero), true);
  assert.equal(matchesCurrentPoolUtxoEvidence(observed, unknown, zero), false);
  assert.equal(matchesCurrentPoolUtxoEvidence(unknown, unknown, { minConfirmations: "1" }), false);
  assert.equal(matchesCurrentPoolUtxoEvidence(observed, observed, { minConfirmations: "1" }), false);
  assert.equal(matchesCurrentPoolUtxoEvidence(unknown, { ...unknown, satoshis: "501" }, zero), false);
  for (const confirmations of [null, undefined, "-1", "00", "4294967296"]) {
    assert.equal(matchesCurrentPoolUtxoEvidence(unknown, { ...unknown, confirmations }, zero), false);
  }
});

test("transaction outpoint collection includes inputs without signer tasks", () => {
  const unsignedTransaction = `0a00000003${input("11", 0)}${input("22", 1)}${input("33", 2)}0100000000000000000000000000`;
  assert.deepEqual(collectTransactionInputOutpoints([{ unsignedTransaction }]), [
    `${"11".repeat(32)}:0`,
    `${"22".repeat(32)}:1`,
    `${"33".repeat(32)}:2`,
  ]);
});
