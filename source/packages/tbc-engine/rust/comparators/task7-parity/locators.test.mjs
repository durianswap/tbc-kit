import assert from "node:assert/strict";
import test from "node:test";
import { compareEvidence, parseRawTransaction } from "./raw-comparator.mjs";
import { fixturePair, transaction, editRaw, flipOutput, lpTape, code, ftPreTx } from "./locator-fixtures.mjs";

const compare = (pair) => compareEvidence(...pair);
const expectCode = (pair, code) => assert.throws(() => compare(pair), { code });
const both = (pair, name, edit, role) => pair.forEach((e) => edit(transaction(e, name, role)));
const create = "create-locked-plan-1";

test("local fixtures parse; signature-only differences compare across all 25 scenarios", () => {
  const pair = fixturePair();
  for (const evidence of pair) for (const scenario of evidence.scenarios) for (const tx of scenario.transactions) {
    assert.ok(parseRawTransaction(tx.unsignedRaw).outputs.length >= 3);
    assert.ok(parseRawTransaction(tx.finalizedRaw).inputs.length);
  }
  assert.deepEqual(compare(pair), { ok: true, scenarios: 25 });
});

for (const side of [0, 1]) {
  for (const [label, name, role, outputIndex] of [
    ["create init Pool Tape", create, "primary", 1],
    ["initial FTLP Tape", create, "primary", 5],
    ["standalone FTLP Tape", "ftlp-merge-locked", "maintenance", 1],
  ]) {
    test(`FIELD_LOCATOR_MISSING: ${label}, side ${side}`, () => {
      const pair = fixturePair();
      editRaw(transaction(pair[side], name, role), (tx) => { tx.outputs[outputIndex].script = ""; });
      expectCode(pair, "FIELD_LOCATOR_MISSING");
    });
    test(`FIELD_LOCATOR_WRONG_SCRIPT: ${label}, side ${side}`, () => {
      const pair = fixturePair();
      editRaw(transaction(pair[side], name, role), (tx) => { tx.outputs[outputIndex].script = code("ft"); });
      expectCode(pair, "FIELD_LOCATOR_WRONG_SCRIPT");
    });
    test(`FIELD_LOCATOR_AMBIGUOUS: duplicate ${label}, side ${side}`, () => {
      const pair = fixturePair();
      editRaw(transaction(pair[side], name, role), (tx) => {
        if (outputIndex === 1 && label.includes("Pool")) tx.outputs.push({ ...tx.outputs[1] });
        else tx.outputs.push({ ...tx.outputs[outputIndex - 1] }, { ...tx.outputs[outputIndex] });
      });
      expectCode(pair, "FIELD_LOCATOR_AMBIGUOUS");
    });
  }
}

test("FIELD_LOCATOR_MISSING: neither side may omit the required Pool Tape output", () => {
  const pair = fixturePair();
  both(pair, create, (t) => {
    editRaw(t, (tx) => { tx.outputs.length = 1; });
    t.fieldLocators.poolTape.outputIndex = 0;
  });
  expectCode(pair, "FIELD_LOCATOR_MISSING");
});
test("FIELD_LOCATOR_WRONG_SCRIPT: no search fallback to relocated Pool Tape", () => {
  const pair = fixturePair();
  both(pair, create, (t) => editRaw(t, (tx) => { [tx.outputs[0], tx.outputs[1]] = [tx.outputs[1], tx.outputs[0]]; }));
  expectCode(pair, "FIELD_LOCATOR_WRONG_SCRIPT");
});
test("FIELD_LOCATOR_WRONG_SCRIPT: FT Tape cannot impersonate initial FTLP Tape", () => {
  const pair = fixturePair();
  both(pair, create, (t) => editRaw(t, (tx) => { tx.outputs[4].script = code("ft"); tx.outputs[5].script = tx.outputs[3].script; }));
  expectCode(pair, "FIELD_LOCATOR_WRONG_SCRIPT");
});
test("FIELD_LOCATOR_WRONG_SCRIPT: NTape marker alone cannot impersonate Pool fields", () => {
  const pair = fixturePair();
  both(pair, create, (t) => editRaw(t, (tx) => { tx.outputs[1].script = "006a054e54617065"; }));
  expectCode(pair, "FIELD_LOCATOR_WRONG_SCRIPT");
});
test("FIELD_LOCATOR_UNREGISTERED: an add prerequisite has no registered field set", () => {
  const pair = fixturePair();
  for (const evidence of pair) {
    const s = evidence.scenarios.find((s) => s.name === "add-standard");
    s.transactions.unshift({ ...structuredClone(s.transactions[0]), role: "prerequisite", publicIntent: null });
  }
  expectCode(pair, "FIELD_LOCATOR_UNREGISTERED");
});
test("FIELD_LOCATOR_UNREGISTERED: producer locator differences cannot be normalized", () => {
  const pair = fixturePair();
  transaction(pair[1], create).fieldLocators.poolTape.outputIndex = 0;
  expectCode(pair, "FIELD_LOCATOR_UNREGISTERED");
});

for (const [label, name, role, outputIndex, offset, codeName] of [
  ["Pool amount", create, "primary", 1, 68, "POOL_TAPE_FIELD"],
  ["Pool lock enable byte", create, "primary", 1, 133, "POOL_TAPE_FIELD"],
  ["mint Pool amount", create, "prerequisite", 1, 68, "POOL_TAPE_FIELD"],
  ...[0, 1, 2, 3].map((i) => [`initial FTLP lock byte ${i}`, create, "primary", 5, 52 + i, "FTLP_LOCK_FIELD"]),
  ["add FTLP lock", "add-locked", "primary", 5, 52, "FTLP_LOCK_FIELD"],
  ["remove FTLP lock", "remove-locked", "primary", 6, 52, "FTLP_LOCK_FIELD"],
  ["standalone FTLP lock", "ftlp-merge-locked", "maintenance", 1, 52, "FTLP_LOCK_FIELD"],
]) {
  test(`${codeName}: ${label} at actual output ${outputIndex}`, () => {
    const pair = fixturePair();
    flipOutput(transaction(pair[1], name, role), outputIndex, offset);
    expectCode(pair, codeName);
  });
}

test("standalone standard and locked FTLP maintenance requires no Pool Tape", () => {
  const pair = fixturePair();
  for (const name of ["ftlp-merge-standard", "ftlp-merge-locked", "ftlp-multi-round"]) {
    const raw = parseRawTransaction(transaction(pair[0], name, "maintenance").unsignedRaw);
    assert.equal(raw.outputs.some((o) => o.script.endsWith(Buffer.from("NTape").toString("hex"))), false);
  }
  assert.equal(compare(pair).ok, true);
});

for (const coin of [false, true]) {
  test(`FT_SWAP_INDEX_TAG: finalized FT input 2, coin=${coin}`, () => {
    const pair = fixturePair({ coin });
    editRaw(transaction(pair[1], "swap-tbc-for-token-standard"), (tx) => {
      const b = Buffer.from(tx.inputs[2].script, "hex");
      b[b.length - ftPreTx(coin).length - 1 - Number(coin)] = 0x51;
      tx.inputs[2].script = b.toString("hex");
    }, "finalizedRaw");
    expectCode(pair, "FT_SWAP_INDEX_TAG");
  });
}
for (const [name, inputIndex] of [["swap-tbc-for-token-standard", 2], ["swap-token-for-tbc-standard", 1]]) {
  test(`FT_COIN_FLAG: ${name}, finalized FT input ${inputIndex}`, () => {
    const pair = fixturePair({ coin: true });
    editRaw(transaction(pair[1], name), (tx) => {
      const b = Buffer.from(tx.inputs[inputIndex].script, "hex");
      b[b.length - ftPreTx(true).length - 1] ^= 1;
      tx.inputs[inputIndex].script = b.toString("hex");
    }, "finalizedRaw");
    expectCode(pair, "FT_COIN_FLAG");
  });
  test(`FIELD_LOCATOR_WRONG_SCRIPT: ${name} uses an FT Tape, never Pool Tape`, () => {
    const pair = fixturePair();
    both(pair, name, (t) => editRaw(t, (tx) => {
      const index = name.startsWith("swap-tbc") ? 3 : 4;
      tx.outputs[index - 1].script = code("ftlp");
      tx.outputs[index].script = lpTape();
    }));
    // FT and FTLP share FTape; the adjacent code must identify the correct family.
    expectCode(pair, "FIELD_LOCATOR_WRONG_SCRIPT");
  });
}

test("FIELD_LOCATOR_AMBIGUOUS: simultaneous maintenance cannot be Pool and FTLP at once", () => {
  const pair = fixturePair();
  both(pair, "simultaneous-pool-ft-and-ftlp-maintenance", (t) => editRaw(t, (tx) => {
    tx.outputs.push({ script: code("ftlp"), satoshis: "500" }, { script: lpTape(), satoshis: "0" });
  }), "maintenance");
  expectCode(pair, "FIELD_LOCATOR_AMBIGUOUS");
});

test("POOL_TAPE_FIELD: producer decoys cannot redirect a registered business field", () => {
  const pair = fixturePair();
  both(pair, create, (t) => { t.fieldLocators.poolTape = { outputIndex: 0, offset: 0 }; });
  flipOutput(transaction(pair[1], create), 1, 68);
  expectCode(pair, "POOL_TAPE_FIELD");
});

test("no producer fieldLocators are needed on either side", () => {
  const pair = fixturePair();
  for (const e of pair) for (const s of e.scenarios) for (const t of s.transactions) delete t.fieldLocators;
  assert.equal(compare(pair).ok, true);
});
test("FIELD_LOCATOR_UNREGISTERED: producer cannot register a new field class", () => {
  const pair = fixturePair();
  both(pair, create, (t) => { t.fieldLocators.unregistered = { outputIndex: 1, offset: 0 }; });
  expectCode(pair, "FIELD_LOCATOR_UNREGISTERED");
});
test("FIELD_LOCATOR_UNREGISTERED: mint prerequisite cannot acquire an FTLP locator", () => {
  const pair = fixturePair();
  both(pair, create, (t) => editRaw(t, (tx) => {
    tx.outputs.push({ script: code("ftlp"), satoshis: "500" }, { script: lpTape(), satoshis: "0" });
  }), "prerequisite");
  expectCode(pair, "FIELD_LOCATOR_UNREGISTERED");
});
for (const [field, inputIndex, distance] of [["FT_SWAP_INDEX_TAG", 1, 2], ["FT_SWAP_INDEX_TAG", 2, 2], ["FT_COIN_FLAG", 2, 1]]) {
  test(`${field}: Pool-FT maintenance input ${inputIndex} uses its own FT region`, () => {
    const pair = fixturePair({ coin: true });
    editRaw(transaction(pair[1], "pool-ft-merge", "maintenance"), (tx) => {
      const bytes = Buffer.from(tx.inputs[inputIndex].script, "hex");
      bytes[bytes.length - ftPreTx(true).length - distance] ^= 1;
      tx.inputs[inputIndex].script = bytes.toString("hex");
    }, "finalizedRaw");
    expectCode(pair, field);
  });
}
for (const side of [0, 1]) {
  test(`FIELD_LOCATOR_MISSING: finalized FT input absent, side ${side}`, () => {
    const pair = fixturePair();
    editRaw(transaction(pair[side], "swap-tbc-for-token-standard"), (tx) => { tx.inputs[2].script = ""; }, "finalizedRaw");
    expectCode(pair, "FIELD_LOCATOR_MISSING");
  });
}
