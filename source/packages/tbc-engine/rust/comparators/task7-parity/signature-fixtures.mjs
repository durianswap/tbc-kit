// Comparator-local test signing only. Never imported by either producer or core.
// Encoding follows the pinned SDK; no normalizer or producer helpers are imported.
import { createHash } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";

export const testPublicKey = Buffer.from(secp256k1.getPublicKey("01".padStart(64, "0"))).toString("hex");
const le = (n, width) => { const b = Buffer.alloc(width); b.writeUIntLE(n, 0, width); return b; };
const amount = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const hash = (b) => createHash("sha256").update(b).digest();
const hash2 = (b) => hash(hash(b));
const size = (n) => n < 253 ? le(n, 1) : Buffer.concat([Buffer.from([253]), le(n, 2)]);
export const fixturePush = (b) => Buffer.concat([
  b.length <= 75 ? le(b.length, 1) : b.length <= 255 ? Buffer.from([76, b.length]) : Buffer.concat([Buffer.from([77]), le(b.length, 2)]), b,
]);
const outpoint = (i) => Buffer.concat([Buffer.from(i.txid, "hex").reverse(), le(i.vout, 4)]);

export function fixtureDigest(tx, index, script, satoshis) {
  const i = tx.inputs[index], code = Buffer.from(script, "hex");
  return hash2(Buffer.concat([
    le(tx.version, 4), hash2(Buffer.concat(tx.inputs.map(outpoint))),
    hash2(Buffer.concat(tx.inputs.map((v) => le(v.sequence, 4)))), outpoint(i), size(code.length), code,
    amount(satoshis), le(i.sequence, 4), hash2(Buffer.concat(tx.outputs.map((o) => {
      const s = Buffer.from(o.script, "hex"); return Buffer.concat([amount(o.satoshis), size(s.length), s]);
    }))), le(tx.lockTime, 4), le(65, 4),
  ])).toString("hex");
}

export function fixtureCurrentData(tx, index) {
  const parts = [Buffer.from([0x51])];
  for (let o = 0; o < tx.outputs.length; o++) {
    const output = tx.outputs[o], script = Buffer.from(output.script, "hex");
    const fixed = new Map([[1564, 1536], [1884, 1856], [2012, 1984], [2076, 2048]]).get(script.length);
    const offset = fixed ?? Math.floor(script.length / 64) * 64;
    const h = sha256.create().update(script.subarray(0, offset));
    const midstate = Buffer.concat(h.get().map((n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; })); h.destroy();
    parts.push(fixturePush(amount(output.satoshis)), fixturePush(script.subarray(offset)),
      fixturePush(offset ? midstate : Buffer.alloc(0)), fixturePush(le(script.length, script.length <= 255 ? 1 : 2)));
    if (fixed !== undefined) {
      const tape = tx.outputs[++o];
      parts.push(fixturePush(amount(tape.satoshis)), fixturePush(Buffer.from(tape.script, "hex")));
    }
    parts.push(Buffer.from([0x52]));
  }
  parts.push(Buffer.from([index ? 0x50 + index : 0]));
  return Buffer.concat(parts);
}

// pre_pre_tx_data_from_parents: OP_7 then one complete ten-instruction ancestor.
export const fixtureAncestry = () => Buffer.concat([
  Buffer.from([0x57]), fixturePush(Buffer.concat([le(10, 4), le(0, 4), le(1, 4), le(1, 4)])),
  fixturePush(Buffer.alloc(32, 0x55)), fixturePush(Buffer.alloc(32, 0x66)), fixturePush(Buffer.alloc(0)),
  fixturePush(amount(500)), fixturePush(Buffer.from([0x51])), fixturePush(Buffer.alloc(0)),
  fixturePush(Buffer.from([1])), fixturePush(Buffer.alloc(0)), Buffer.from([0x52]),
]);

export function fixtureSign(digest, variant = 1, key = "01".padStart(64, "0")) {
  const signature = secp256k1.sign(digest, key, { lowS: true, prehash: false, extraEntropy: Buffer.alloc(32, variant) });
  return Buffer.concat([signature.toDERRawBytes(), Buffer.from([65])]);
}

