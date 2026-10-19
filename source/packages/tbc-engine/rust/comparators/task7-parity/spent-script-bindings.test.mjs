import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { normalizeSignatures } from "./signature-normalizer.mjs";
import { fixturePush } from "./signature-fixtures.mjs";
import { assetContext, fixtureTxid, fixtureHash, signFromParent, parentSuffix, fixtureSerialize, exactCode, fixtureParent, p2pkhScript } from "./spent-script-fixtures.mjs";
import { classifySpentScript, independentlyFinalizedTxid } from "./spent-script-bindings.mjs";
import { compareEvidence, parseRawTransaction } from "./raw-comparator.mjs";
import { fixturePair, transaction, editRaw } from "./locator-fixtures.mjs";

function sample(family = "p2pkh", overrides = {}) {
  const assets = assetContext(overrides), parent = assets.parents[family];
  const recipe = family === "p2pkh" ? { kind: "p2pkh" } : family === "pool" ? { kind: "pool-signed" }
    : { kind: family === "pool-held-ft" ? "ft-swap" : family === "ft" ? "ft-transfer" : family === "ftlp" ? "ftlp-transfer" : "ftlp-locked-transfer", version: assets.version, coin: family.startsWith("ftlp") ? false : assets.coin };
  const raw = fixtureParent([{ script: p2pkhScript, satoshis: "100" }]);
  raw.inputs = [{ txid: fixtureTxid(parent), vout: 0, script: "", sequence: 0xfffffffe }]; raw.lockTime = 800000;
  const final = structuredClone(raw);
  const suffix = family === "p2pkh" ? Buffer.alloc(0) : family === "pool" ? fixturePush(Buffer.from([0xaa]))
    : parentSuffix(parent, family === "pool-held-ft", recipe.coin, recipe.version);
  const request = signFromParent(final, 0, parent, recipe, 1, suffix);
  return { raw, final, requests: [request], assets, context: {
    parentRaws: assets.parentRaws, scenario: family.startsWith("ftlp") ? "ftlp-merge-locked" : family === "pool" || family === "pool-held-ft" ? "swap-tbc-for-token-locked" : "create-standard-plan-1",
    role: family.startsWith("ftlp") ? "maintenance" : family === "p2pkh" ? "prerequisite" : "primary",
  } };
}
const check = (s) => normalizeSignatures(s.raw, s.final, s.requests, s.context);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest();
const hash160 = (bytes) => createHash("ripemd160").update(bytes).digest("hex");

function validSwapWithPoolHeldBinding(binding, codeId = "ft-v4") {
  const assets = assetContext({ version: 4, coin: false, locked: false });
  const source = {
    version: 10,
    lockTime: 0,
    inputs: [{ txid: "32".repeat(32), vout: 0, script: "5132", sequence: 0xffffffff }],
    outputs: [{ satoshis: "9800", script: `${p2pkhScript}6a10666f7220706f6f6c6e6674206d696e74` }],
  };
  const sourcePoint = `${Buffer.from(fixtureTxid(source), "hex").reverse().toString("hex")}00000000`;
  const poolCode = Buffer.from(exactCode("pool", {
    utxoHex: sourcePoint,
    ftCodeSize: "1c08",
    pumpPublicKeyHash: "1eacc275e83741a10d19f139e191d1fe360055e8",
    tagLengthHex: "06",
    tagHex: Buffer.from("task-7").toString("hex"),
  }), "hex");
  const poolParent = fixtureParent([
    { satoshis: "1000", script: poolCode.toString("hex") },
    { satoshis: "0", script: assets.poolTape },
  ], 0xc1);
  const heldTemplate = assets.parents["pool-held-ft"];
  const fields = classifySpentScript(heldTemplate.outputs[0].script).fields;
  const receiverHash = binding(poolCode);
  const version = codeId === "ft-v4" ? 4 : 3;
  assert.equal(codeId, "ft-v4", "Pool-held FT mutation fixture must inherit authenticated FT V4");
  assert.equal(version, 4, "Pool-held FT signing recipe must remain V4");
  const heldParent = fixtureParent([
    { satoshis: "500", script: exactCode(codeId, { ...fields, hash: `${receiverHash}01` }) },
    { satoshis: "0", script: assets.ftTape },
  ], 0xc2);
  const funding = assets.parents.p2pkh;
  const raw = fixtureParent([{ satoshis: "100", script: p2pkhScript }], 0xc3);
  raw.inputs = [poolParent, funding, heldParent].map((parent) => ({
    txid: fixtureTxid(parent), vout: 0, script: "", sequence: 0xffffffff,
  }));
  const final = structuredClone(raw);
  final.inputs[0].script = fixturePush(Buffer.from([0xaa])).toString("hex");
  const p2pkhRequest = signFromParent(final, 1, funding, { kind: "p2pkh" }, 1);
  const ftRequest = signFromParent(final, 2, heldParent, { kind: "ft-swap", version, coin: false }, 1,
    parentSuffix(heldParent, true, false, version));
  const parentRaws = [poolParent, funding, heldParent, assets.contract].map(fixtureSerialize);
  const context = { parentRaws, scenario: "swap-tbc-for-token-standard", role: "primary" };
  assert.equal(context.role, "primary", "Pool-held FT binding fixture must retain the registered primary role");
  for (const input of raw.inputs) {
    assert.equal(parentRaws.filter((candidate) => independentlyFinalizedTxid(candidate) === input.txid).length, 1,
      "every swap input must resolve exactly one authenticated raw parent");
  }
  return {
    raw,
    final,
    requests: [p2pkhRequest, ftRequest],
    poolCode,
    context,
  };
}

test("released Pool-held FT golden binds HASH160(SHA256(pool Code))", () => {
  const s = validSwapWithPoolHeldBinding((poolCode) => hash160(sha256(poolCode)), "ft-v4");
  assert.equal(sha256(s.poolCode).toString("hex"), "634cf33d0aca1ff3fd8010b847e5eca6c9e373375d96b44bf20a6c707245cb36");
  assert.equal(hash160(sha256(s.poolCode)), "ac3cb1ecec5735331fbdae6116161a890cb5fcd2");
  const normalized = check(s);
  const resolved = s.raw.inputs.map((input, index) => {
    const matches = s.context.parentRaws.filter((raw) => independentlyFinalizedTxid(raw) === input.txid);
    assert.equal(matches.length, 1, `input ${index} parent cardinality`);
    const parent = parseRawTransaction(matches[0]);
    return { index, classification: classifySpentScript(parent.outputs[input.vout].script) };
  });
  assert.equal(normalized.length, 3);
  assert.deepEqual(resolved.map(({ classification }) => classification.family), ["pool", "p2pkh", "pool-held-ft"]);
  const held = resolved.filter(({ classification }) => classification.family === "pool-held-ft");
  assert.equal(held.length, 1);
  assert.ok(normalized[held[0].index], "unique Pool-held FT normalized result must exist");
  assert.equal(held[0].classification.owner, "ac3cb1ecec5735331fbdae6116161a890cb5fcd2");
});

test("rejects HASH160(pool Code) single-hash substitution", () => {
  const s = validSwapWithPoolHeldBinding((poolCode) => hash160(poolCode));
  assert.equal(hash160(s.poolCode), "e22602a8e9d6223bfdb5c54bf8af2d359253c7f7");
  assert.throws(() => check(s), { code: "SIGNATURE_CONTRACT_BINDING" });
});

test("rejects SHA256(pool Code) without HASH160", () => {
  const s = validSwapWithPoolHeldBinding((poolCode) => sha256(poolCode).toString("hex"));
  assert.throws(() => check(s), { code: "SPENT_SCRIPT_UNREGISTERED" });
});

test("rejects double-hash binding to the wrong Pool Code", () => {
  const otherPool = Buffer.from(assetContext({ locked: true }).pool, "hex");
  const s = validSwapWithPoolHeldBinding(() => hash160(sha256(otherPool)));
  assert.throws(() => check(s), { code: "SIGNATURE_CONTRACT_BINDING" });
});

test("producer declarations cannot disguise a single-hash Pool-held FT decoy", () => {
  const s = validSwapWithPoolHeldBinding((poolCode) => hash160(poolCode));
  s.requests[1].poolCodeSha256 = sha256(s.poolCode).toString("hex");
  s.requests[1].poolHeldOwnerHash = hash160(sha256(s.poolCode));
  assert.throws(() => check(s), { code: "SIGNATURE_CONTRACT_BINDING" });
});

test("Pool-held FT binding change leaves other spent-script families unchanged", () => {
  const assets = assetContext({ locked: true });
  for (const [family, expected] of [
    ["p2pkh", "p2pkh"],
    ["pool", "pool"],
    ["ft", "ft"],
    ["ftlp", "ftlp"],
    ["ftlp-locked", "ftlp-locked"],
  ]) {
    const parentRaw = fixtureSerialize(assets.parents[family]);
    const parent = parseRawTransaction(parentRaw);
    const outpoint = { txid: independentlyFinalizedTxid(parentRaw), vout: 0 };
    assert.equal(outpoint.txid, fixtureTxid(assets.parents[family]), `${family}: authenticated parent txid`);
    assert.ok(parent.outputs[outpoint.vout]?.script, `${family}: authenticated spent output exists`);
    assert.equal(classifySpentScript(parent.outputs[outpoint.vout].script).family, expected, family);
  }
});
for (const [family, replacement] of [
  ["p2pkh", "pool-signed"], ["pool", "p2pkh"], ["pool", "ft-transfer"], ["ft", "pool-signed"],
  ["ft", "ft-swap"], ["pool-held-ft", "ft-transfer"], ["ftlp", "ftlp-locked-transfer"], ["ftlp-locked", "ftlp-transfer"],
]) test(`rejects spent-script substitution ${family} -> ${replacement}`, () => {
  const s = sample(family, { locked: true });
  s.requests[0].recipe = replacement.startsWith("ft") ? { kind: replacement, version: 3, coin: false } : { kind: replacement };
  assert.throws(() => check(s), { code: "SIGNATURE_LAYOUT_TYPE" });
});
for (const field of ["script", "satoshis"]) test(`parent bytes override false producer ${field}`, () => {
  const s = sample(); s.requests[0].prevout[field] = field === "script" ? "51" : "101";
  assert.throws(() => check(s), { code: "SIGNATURE_PREVOUT" });
});
test("missing raw parent cannot fall back to producer prevout metadata", () => {
  const s = sample(); s.context.parentRaws = [];
  assert.throws(() => check(s), { code: "SPENT_PARENT_MISSING" });
});
test("one-byte raw parent mutation invalidates the input outpoint binding", () => {
  const s = sample(); s.context.parentRaws = s.context.parentRaws.map((raw) => raw.slice(0, -2) + "01");
  assert.throws(() => check(s), { code: "SPENT_PARENT_MISSING" });
});
test("wrong raw parent vout cannot use producer script/value", () => {
  const s = sample(); s.raw.inputs[0].vout = s.final.inputs[0].vout = s.requests[0].prevout.vout = 9;
  assert.throws(() => check(s), { code: "SPENT_PREVOUT_MISSING" });
});
test("wrong FT version declaration is rejected before signature verification", () => {
  const s = sample("ft"); s.requests[0].recipe.version = 4;
  assert.throws(() => check(s), { code: "SIGNATURE_VERSION_BINDING" });
});
test("producer role cannot permit a Pool input as a create prerequisite", () => {
  const s = sample("pool", { locked: true }); s.context = { ...s.context, scenario: "create-standard-plan-1", role: "prerequisite" };
  assert.throws(() => check(s), { code: "SIGNATURE_LAYOUT_ROLE" });
});
test("plausible Pool marker and length cannot replace the exact template", () => {
  const s = sample("pool", { locked: true }), p = structuredClone(s.assets.parents.pool);
  p.outputs[0].script = "51" + p.outputs[0].script.slice(2);
  const txid = fixtureTxid(p); s.raw.inputs[0].txid = s.final.inputs[0].txid = s.requests[0].prevout.txid = txid;
  s.context.parentRaws.push(fixtureSerialize(p)); s.requests[0].prevout.script = p.outputs[0].script;
  assert.throws(() => check(s), { code: "SPENT_SCRIPT_UNREGISTERED" });
});
test("FTLP codeHash must bind to an authenticated Pool script", () => {
  const s = sample("ftlp"), p = structuredClone(s.assets.parents.ftlp);
  p.outputs[0].script = exactCode("ftlp-v3", { codeHash: "99".repeat(32) });
  const txid = fixtureTxid(p); s.raw.inputs[0].txid = s.final.inputs[0].txid = s.requests[0].prevout.txid = txid;
  s.context.parentRaws.push(fixtureSerialize(p)); s.requests[0].prevout.script = p.outputs[0].script;
  assert.throws(() => check(s), { code: "SIGNATURE_CONTRACT_BINDING" });
});
test("locked FTLP script cannot authenticate an unlocked Tape", () => {
  const s = sample("ftlp-locked"), p = structuredClone(s.assets.parents["ftlp-locked"]);
  p.outputs[1] = s.assets.parents.ftlp.outputs[1];
  const txid = fixtureTxid(p); s.raw.inputs[0].txid = s.final.inputs[0].txid = s.requests[0].prevout.txid = txid;
  s.context.parentRaws.push(fixtureSerialize(p));
  assert.throws(() => check(s), { code: "SIGNATURE_LOCK_BINDING" });
});
test("ordinary P2PKH resolves from raw parent bytes", () => {
  assert.equal(check(sample()).length, 1);
});
test("producer recipe and prevout summaries are unnecessary for authenticated P2PKH", () => {
  const s = sample(); delete s.requests[0].recipe; delete s.requests[0].prevout;
  assert.equal(check(s).length, 1);
});
for (const version of [3, 4]) for (const coin of [false, true]) for (const family of ["p2pkh", "pool", "ft", "pool-held-ft", "ftlp", "ftlp-locked"]) {
  test(`exact pinned classification ${family}, v${version}, coin=${coin}`, () => {
    const assets = assetContext({ version, coin, locked: true });
    const c = classifySpentScript(assets.parents[family].outputs[0].script);
    assert.equal(c.family, family);
    if (!["pool", "p2pkh"].includes(family)) assert.equal(c.version, version);
  });
}
test("FT template encoding matches the fixed pinned source golden hash", () => {
  const script = exactCode("ft-v4", {
    utxoHex: "ffeeddccbbaa99887766554433221100ffeeddccbbaa9988776655443322110001020000",
    hash: "9d7569c02867fa342031cb7c37ae9cf54a0f41ba00", tapeSizeHex: "40",
  });
  assert.equal(fixtureHash(Buffer.from(script, "hex")).toString("hex"), "19ff328e04a7a9e1b1974e03045766e9f4ab88f54387a274c37b4d53bb8b2a60");
});
function replaceParent(s, p) {
  const txid = fixtureTxid(p); s.raw.inputs[0].txid = s.final.inputs[0].txid = s.requests[0].prevout.txid = txid;
  s.requests[0].prevout.script = p.outputs[0].script;
  s.context.parentRaws.push(fixtureSerialize(p));
}
test("unlocked FTLP script cannot authenticate a locked Tape", () => {
  const s = sample("ftlp"), p = structuredClone(s.assets.parents.ftlp);
  p.outputs[1] = s.assets.parents["ftlp-locked"].outputs[1]; replaceParent(s, p);
  assert.throws(() => check(s), { code: "SIGNATURE_LOCK_BINDING" });
});
test("Pool-held FT receiver must bind the authenticated Pool", () => {
  const s = sample("pool-held-ft", { locked: true }), p = structuredClone(s.assets.parents["pool-held-ft"]);
  p.outputs[0].script = p.outputs[0].script.slice(0, -54) + "99".repeat(20) + "01" + p.outputs[0].script.slice(-12);
  replaceParent(s, p);
  assert.throws(() => check(s), { code: "SIGNATURE_CONTRACT_BINDING" });
});
test("a different FT contract outpoint cannot reuse the Pool authority", () => {
  const s = sample("ft"), p = structuredClone(s.assets.parents.ft);
  p.outputs[0].script = exactCode("ft-v3", { utxoHex: "77".repeat(36) }); replaceParent(s, p);
  assert.throws(() => check(s), { code: "SIGNATURE_CONTRACT_BINDING" });
});
test("actual V4 FT script cannot use a V3 Pool contract binding", () => {
  const s = sample("ft"), p = structuredClone(s.assets.parents.ft);
  p.outputs[0].script = exactCode("ft-v4"); replaceParent(s, p); s.requests[0].recipe.version = 4;
  assert.throws(() => check(s), { code: "SIGNATURE_VERSION_BINDING" });
});
test("Pool key-lock template must agree with authenticated Pool Tape", () => {
  const s = sample("pool", { locked: true }), p = structuredClone(s.assets.parents.pool);
  p.outputs[1] = assetContext({ locked: false }).parents.pool.outputs[1]; replaceParent(s, p);
  assert.throws(() => check(s), { code: "SIGNATURE_LOCK_BINDING" });
});
test("planned child outpoint resolves the independently finalized parent txid", () => {
  const pair = fixturePair();
  const first = pair[0].scenarios[0].transactions;
  assert.equal(parseRawTransaction(first[1].unsignedRaw).inputs[0].txid, independentlyFinalizedTxid(first[0].finalizedRaw));
  assert.notEqual(independentlyFinalizedTxid(first[0].unsignedRaw), independentlyFinalizedTxid(first[0].finalizedRaw));
  assert.equal(compareEvidence(...pair).ok, true);
});
test("planned child cannot resolve the unsigned parent txid", () => {
  const pair = fixturePair();
  for (const e of pair) {
    const [parent, child] = e.scenarios[0].transactions;
    for (const phase of ["unsignedRaw", "finalizedRaw"]) editRaw(child, (tx) => { tx.inputs[0].txid = independentlyFinalizedTxid(parent.unsignedRaw); }, phase);
  }
  assert.throws(() => compareEvidence(...pair), { code: "SPENT_PARENT_MISSING" });
});
test("future planned raw parent cannot be injected as external evidence", () => {
  const pair = fixturePair();
  for (const e of pair) e.scenarios[0].transactions[0].parentRaws.push(e.scenarios[0].transactions[1].finalizedRaw);
  assert.throws(() => compareEvidence(...pair), { code: "SPENT_PARENT_UNFINALIZED" });
});
