// Test-only construction from frozen pinned literal assets. No comparator classification,
// prevout resolver, production core, or source-producer helpers are used here.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fixturePush, fixtureDigest, fixtureSign, fixtureCurrentData, fixtureAncestry, testPublicKey } from "./signature-fixtures.mjs";

const assets = JSON.parse(readFileSync(new URL("./pinned-spent-script-bindings.json", import.meta.url)));
export const fixtureHash = (b) => createHash("sha256").update(b).digest();
const doubleHash = (b) => fixtureHash(fixtureHash(b));
const hash160 = (b) => createHash("ripemd160").update(fixtureHash(b)).digest("hex");
export const ownerHash = hash160(Buffer.from(testPublicKey, "hex"));
export const p2pkhScript = `76a914${ownerHash}88ac`;
const le = (v, n) => { const b = Buffer.alloc(n); b.writeUIntLE(v, 0, n); return b; };
const value = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };
const compact = (n) => n < 253 ? le(n, 1) : Buffer.concat([Buffer.from([253]), le(n, 2)]);
const point = (v) => Buffer.concat([Buffer.from(v.txid, "hex").reverse(), le(v.vout, 4)]);
export const fixtureSerialize = (tx) => Buffer.concat([
  le(tx.version, 4), compact(tx.inputs.length), ...tx.inputs.flatMap((i) => {
    const b = Buffer.from(i.script, "hex"); return [point(i), compact(b.length), b, le(i.sequence, 4)];
  }), compact(tx.outputs.length), ...tx.outputs.flatMap((o) => {
    const b = Buffer.from(o.script, "hex"); return [value(o.satoshis), compact(b.length), b];
  }), le(tx.lockTime, 4),
]).toString("hex");
export function fixtureTxid(tx) {
  return doubleHash(Buffer.concat([
    le(tx.version, 4), le(tx.lockTime, 4), le(tx.inputs.length, 4), le(tx.outputs.length, 4),
    fixtureHash(Buffer.concat(tx.inputs.flatMap((i) => [point(i), le(i.sequence, 4)]))),
    fixtureHash(Buffer.concat(tx.inputs.map((i) => fixtureHash(Buffer.from(i.script, "hex"))))),
    fixtureHash(Buffer.concat(tx.outputs.flatMap((o) => [value(o.satoshis), fixtureHash(Buffer.from(o.script, "hex"))]))),
  ])).reverse().toString("hex");
}
const tape = (parts) => Buffer.concat([Buffer.from([0, 106]), ...parts.map(fixturePush)]).toString("hex");
export const exactFtTape = (coin = false, locked = null) => tape([
  Buffer.concat([value(10), Buffer.alloc(40)]),
  ...(locked === null ? [Buffer.from([6]), Buffer.from("Token"), Buffer.from("TOK"), ...(coin ? [Buffer.alloc(4)] : [])]
    : [le(locked, 4), ...Array.from({ length: (coin ? 74 : 69) - 62 }, () => Buffer.alloc(0))]),
  Buffer.from("FTape"),
]);
export function exactCode(id, fields = {}) {
  const profile = assets.entries.find((v) => v.id === id);
  if (!profile) throw new Error(`fixture profile missing: ${id}`);
  const defaults = { utxoHex: "11".repeat(32) + "00000000", hash: ownerHash + "00", tapeSizeHex: "45",
    ftCodeSize: "5c07", pumpPublicKeyHash: "1eacc275e83741a10d19f139e191d1fe360055e8", tagLengthHex: "01", tagHex: "74",
    lpCostAddressHex: ownerHash, lpCostAmountHex: "6400000000000000", codeHash: "22".repeat(32), adminPubHash: ownerHash,
    ...Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`key${i}`, testPublicKey])), ...fields };
  return profile.program.map((p) => typeof p === "string" ? p : defaults[p.field]).join("");
}
const output = (script, satoshis = "500") => ({ script, satoshis });
export const fixtureParent = (outputs, seed = 1) => ({ version: 10, lockTime: 0,
  inputs: [{ txid: seed.toString(16).padStart(2, "0").repeat(32), vout: 0, sequence: 0xffffffff, script: "51" }], outputs });

export function assetContext({ version = 3, coin = false, locked = false } = {}) {
  const funding = fixtureParent([output(p2pkhScript, "100000")], 101);
  const sourcePoint = Buffer.concat([Buffer.from(fixtureTxid(funding), "hex").reverse(), le(0, 4)]).toString("hex");
  const ftTape = exactFtTape(coin), tapeSizeHex = (ftTape.length / 2).toString(16).padStart(2, "0");
  const ftId = `ft-v${version}${coin ? "-coin" : ""}`;
  const fields = { utxoHex: sourcePoint, tapeSizeHex };
  const ft = exactCode(ftId, fields), contract = fixtureParent([output(ft), output(ftTape, "0")], 102);
  const pool = exactCode(locked ? "pool-locked-1" : "pool", { utxoHex: sourcePoint, ftCodeSize: version === 4 ? "1c08" : coin ? "dc07" : "5c07" });
  const lp = (lock) => exactCode(`ftlp-v${version}${coin && version === 3 ? "-coin" : ""}${lock ? "-locked" : ""}`, {
    codeHash: fixtureHash(Buffer.from(pool, "hex")).toString("hex"), tapeSizeHex,
  });
  const poolTape = tape([Buffer.alloc(64, 0x11), Buffer.concat([value(100), value(200), value(300)]),
    Buffer.from(fixtureTxid(contract), "hex"), Buffer.from([35, 0]), Buffer.from([1]), Buffer.from([Number(locked)]), Buffer.from([Number(locked)]), Buffer.from("NTape")]);
  const poolParent = fixtureParent([output(pool, "1000"), output(poolTape, "0")], 103);
  const parents = {
    p2pkh: funding, pool: poolParent,
    ft: fixtureParent([output(ft), output(ftTape, "0")], 104),
    "pool-held-ft": fixtureParent([output(exactCode(ftId, { ...fields, hash: hash160(Buffer.from(pool, "hex")) + "01" })), output(ftTape, "0")], 105),
    ftlp: fixtureParent([output(lp(false)), output(exactFtTape(coin), "0")], 106),
    "ftlp-locked": fixtureParent([output(lp(true)), output(exactFtTape(coin, 800000), "0")], 107),
  };
  return { version, coin, locked, pool, poolTape, ft, ftTape, contract, parents,
    parentRaws: [funding, contract, ...Object.values(parents)].map(fixtureSerialize).filter((s, i, a) => a.indexOf(s) === i) };
}

// The test unlock suffix is structural; its actual spent Code/Tape/amount comes
// from the serialized parent. Covenant execution is outside this comparator slice.
export function parentSuffix(parent, swap = false, coin = false, version = 3) {
  const code = Buffer.from(parent.outputs[0].script, "hex");
  const pre = Buffer.concat([
    fixturePush(Buffer.concat([le(10, 4), le(parent.lockTime, 4), le(parent.inputs.length, 4), le(parent.outputs.length, 4)])),
    fixturePush(Buffer.concat(parent.inputs.flatMap((i) => [point(i), le(i.sequence, 4)]))), fixturePush(Buffer.alloc(32, 0x55)), fixturePush(Buffer.alloc(0)),
    fixturePush(value(parent.outputs[0].satoshis)), fixturePush(code.subarray(-28)), fixturePush(Buffer.alloc(32, 0x66)),
    fixturePush(le(code.length, 2)), fixturePush(value(0)), fixturePush(Buffer.from(parent.outputs[1].script, "hex")), fixturePush(Buffer.alloc(0)),
  ]);
  const contract = swap ? Buffer.concat([fixturePush(Buffer.alloc(40, 0x77)), fixturePush(Buffer.concat([le(10, 4), le(0, 4), le(1, 4), le(2, 4)])),
    fixturePush(Buffer.alloc(32, 0x88)), fixturePush(Buffer.alloc(32, 0x99)), ...Array.from({ length: 15 }, () => [fixturePush(value(0)), fixturePush(Buffer.alloc(32, 0x22))]).flat(),
    ...(version > 2 ? [Buffer.from([0])] : []),
  ]) : Buffer.alloc(0);
  return Buffer.concat([contract, ...(coin ? [Buffer.from([swap ? 81 : 0])] : []), pre]);
}
export function signFromParent(tx, inputIndex, parent, recipe, variant = 1, suffix = Buffer.alloc(0)) {
  const prevout = { ...tx.inputs[inputIndex], ...parent.outputs[tx.inputs[inputIndex].vout] };
  const request = { inputIndex, publicKey: testPublicKey, sighashType: 65, recipe,
    prevout: { txid: prevout.txid, vout: prevout.vout, script: prevout.script, satoshis: prevout.satoshis },
    digest: fixtureDigest(tx, inputIndex, prevout.script, prevout.satoshis) };
  const prefix = recipe.kind.startsWith("ft") ? Buffer.concat([fixtureCurrentData(tx, inputIndex), fixtureAncestry()]) : Buffer.alloc(0);
  tx.inputs[inputIndex].script = Buffer.concat([prefix, fixturePush(fixtureSign(request.digest, variant)), fixturePush(Buffer.from(testPublicKey, "hex")), suffix]).toString("hex");
  return request;
}
