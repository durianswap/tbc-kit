import { createHash } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";
import { ComparisonError } from "./comparison-error.mjs";
import { authenticateSpentInputs, verifyClassifiedPublicKey } from "./spent-script-bindings.mjs";

// Comparator-owned grammar, pinned to 923497e8b2473c0e179fa0b86dbb32a2f188d25a.
// src/transaction.rs::sign_input_with_chunks: signature, public key (no extra chunks for P2PKH).
// src/contracts/pool_nft_v2/unlock.rs::signature_prefix, pool_unlock: signature, key, covenant.
// src/contracts/ft/builder.rs::sign_ft_input, sign_ft_swap_input:
// current_tx_data, pre_pre_tx_data_from_parents, signature, key, registered suffix.
// pool_nft_v2/builder.rs::sign_ftlp_input delegates to sign_ft_input with coin=false.
// Prefix grammar and serialization: ft/unlock.rs::current_tx_data, pre_pre_tx_data.
// No producer byte offsets, layout registration, or DER-search fallback are accepted.
const layouts = Object.freeze({
  p2pkh: "plain", "pool-signed": "pool", "ft-transfer": "ft", "ft-swap": "swap", "ftlp-transfer": "ftlp", "ftlp-locked-transfer": "ftlp",
});
const fail = (code, message) => { throw new ComparisonError(code, message); };
const hex = (value, empty = false) => typeof value === "string" && (empty ? /^(?:[0-9a-f]{2})*$/ : /^(?:[0-9a-f]{2})+$/).test(value);
const hash = (value) => createHash("sha256").update(value).digest();
const hash2 = (value) => hash(hash(value));
const u32 = (value) => { const b = Buffer.alloc(4); b.writeUInt32LE(value); return b; };
const u64 = (value) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(value)); return b; };
function compact(n) {
  if (n < 253) return Buffer.from([n]);
  if (n <= 65535) { const b = Buffer.alloc(3); b[0] = 253; b.writeUInt16LE(n, 1); return b; }
  return Buffer.concat([Buffer.from([254]), u32(n)]);
}
const push = (b) => Buffer.concat([b.length <= 75 ? Buffer.from([b.length])
  : b.length <= 255 ? Buffer.from([76, b.length]) : Buffer.from([77, b.length & 255, b.length >> 8]), b]);
const outpoint = (i) => Buffer.concat([Buffer.from(i.txid, "hex").reverse(), u32(i.vout)]);
const fixedOffsets = new Map([[1564, 1536], [1884, 1856], [2012, 1984], [2076, 2048]]);

function registered(recipe) {
  if (!recipe || !Object.hasOwn(layouts, recipe.kind)) fail("SIGNATURE_LAYOUT_UNREGISTERED", "input has no registered signing recipe");
  const ft = ["ft", "swap", "ftlp"].includes(layouts[recipe.kind]);
  const keys = ft ? ["kind", "version", "coin"] : ["kind"];
  if (Object.keys(recipe).some((key) => !keys.includes(key))
    || (ft && (![1, 2, 3, 4].includes(recipe.version) || typeof recipe.coin !== "boolean"))
    || (recipe.kind === "ftlp-transfer" && recipe.coin)
    || (recipe.version === 1 && recipe.coin)) {
    fail("SIGNATURE_LAYOUT_UNREGISTERED", "recipe variant or producer-selected layout field is not registered");
  }
  return layouts[recipe.kind];
}

// Retain every opcode, length prefix and data byte. Parsing never stops at DER.
function instruction(bytes, start) {
  if (start >= bytes.length) fail("SIGNATURE_SCRIPT", "missing instruction");
  let end = start + 1, length = null;
  const opcode = bytes[start];
  if (opcode <= 75) length = opcode;
  else if (opcode <= 78) {
    const width = 2 ** (opcode - 76);
    if (end + width > bytes.length) fail("SIGNATURE_SCRIPT", "truncated push length");
    length = bytes.readUIntLE(end, width); end += width;
    if (length <= (opcode === 76 ? 75 : opcode === 77 ? 255 : 65535)) fail("SIGNATURE_SCRIPT", "noncanonical push length");
  } else if (opcode !== 79 && (opcode < 81 || opcode > 96)) {
    fail("SIGNATURE_SCRIPT", "unlock contains an unregistered non-push opcode");
  }
  const dataStart = end;
  if (length !== null) end += length;
  if (end > bytes.length) fail("SIGNATURE_SCRIPT", "truncated push data");
  return { opcode, start, end, data: length === null ? null : bytes.subarray(dataStart, end) };
}
export function parseUnlockPushes(script) {
  if (!hex(script, true)) fail("SIGNATURE_SCRIPT", "invalid unlock hex");
  const bytes = Buffer.from(script, "hex"), tokens = [];
  for (let offset = 0; offset < bytes.length;) { const token = instruction(bytes, offset); tokens.push(token); offset = token.end; }
  return tokens;
}

// The pin hashes only complete 64-byte blocks for these partial-output prefixes.
// The already pinned @noble/hashes 1.8.0 SHA256 state supplies that compression state.
function partialHash(bytes) {
  const state = sha256.create().update(bytes);
  const result = Buffer.alloc(32);
  state.get().forEach((word, i) => result.writeUInt32BE(word >>> 0, i * 4));
  state.destroy();
  return result;
}
function currentData(raw, inputIndex) {
  if (inputIndex > 5) fail("SIGNATURE_LAYOUT_UNREGISTERED", "pinned FT input index is outside 0..5");
  const result = [Buffer.from([81])];
  for (let i = 0; i < raw.outputs.length; i++) {
    const output = raw.outputs[i], script = Buffer.from(output.script, "hex");
    if (script.length > 65535) fail("SIGNATURE_LAYOUT_UNREGISTERED", "output exceeds pinned FT script size");
    const fixed = fixedOffsets.get(script.length), offset = fixed ?? Math.floor(script.length / 64) * 64;
    const size = script.length <= 255 ? Buffer.from([script.length]) : Buffer.from([script.length & 255, script.length >> 8]);
    result.push(push(u64(output.satoshis)), push(script.subarray(offset)), push(offset ? partialHash(script.subarray(0, offset)) : Buffer.alloc(0)), push(size));
    if (fixed !== undefined) {
      const tape = raw.outputs[++i];
      if (!tape) fail("SIGNATURE_LAYOUT_UNREGISTERED", "fixed-length FT output has no adjacent Tape");
      result.push(push(u64(tape.satoshis)), push(Buffer.from(tape.script, "hex")));
    }
    result.push(Buffer.from([82]));
  }
  result.push(Buffer.from([inputIndex ? 80 + inputIndex : 0]));
  return Buffer.concat(result);
}

function prefixEnd(bytes, raw, inputIndex, layout, verifyCurrent) {
  if (!["ft", "swap", "ftlp"].includes(layout)) return 0;
  const expected = currentData(raw, inputIndex);
  if (verifyCurrent && !bytes.subarray(0, expected.length).equals(expected)) fail("SIGNATURE_PREFIX", "current_tx_data differs from independently serialized current outputs/input tag");
  let offset = expected.length;
  if (bytes[offset++] !== 87) fail("SIGNATURE_LAYOUT_UNREGISTERED", "FT ancestry must begin with OP_7");
  let ancestors = 0;
  // Each ancestor starts with the registered 16-byte header and has exactly ten
  // instructions. Its OP_2 terminator determines the boundary, never DER content.
  while (bytes[offset] === 16) {
    const group = [];
    for (let i = 0; i < 10; i++) { const token = instruction(bytes, offset); group.push(token); offset = token.end; }
    const n = (i) => group[i].data?.length;
    if (n(0) !== 16 || n(1) !== 32 || n(2) !== 32 || n(3) === undefined || n(3) % 40
      || n(4) !== 8 || n(5) === undefined || ![0, 32].includes(n(6)) || ![1, 2].includes(n(7))
      || n(8) === undefined || n(8) % 40 || group[9].opcode !== 82 || ++ancestors > 6) {
      fail("SIGNATURE_LAYOUT_UNREGISTERED", "FT ancestry does not match the pinned pre_pre_tx_data grammar");
    }
  }
  if (!ancestors) fail("SIGNATURE_LAYOUT_UNREGISTERED", "FT ancestry is missing");
  return offset;
}

function signaturePair(bytes, start) {
  if (start === bytes.length) fail("SIGNATURE_MISSING", "registered signature push absent");
  const signature = instruction(bytes, start);
  if (!signature.data?.length || (signature.data.length === 33 && [2, 3].includes(signature.data[0]))) {
    fail("SIGNATURE_MISSING", "registered signature slot is empty or contains a public key");
  }
  if (signature.end === bytes.length) fail("SIGNATURE_PUBLIC_KEY", "registered public-key push absent");
  const publicKey = instruction(bytes, signature.end);
  return { signature, publicKey };
}

// Locators use only the registered prefix grammar and the two designated pushes.
// Their literal tag/coin mutations must be reported before full suffix parsing.
export function locateSigningBoundary(script, raw, inputIndex, recipe) {
  const layout = registered(recipe), bytes = Buffer.from(script, "hex");
  const start = prefixEnd(bytes, raw, inputIndex, layout, false);
  return signaturePair(bytes, start).publicKey.end;
}

function derSignature(data) {
  // fromDER rejects negative, zero/out-of-range, overlong and nonminimal integers.
  if (!data || data.length < 9 || data.length > 73) fail("SIGNATURE_DER", "signature size is not strict DER plus one sighash byte");
  try { return secp256k1.Signature.fromDER(data.subarray(0, -1)); }
  catch { fail("SIGNATURE_DER", "invalid strict DER signature"); }
}
function looksLikeSignature(token) {
  if (token.data?.[0] !== 48) return false;
  try { derSignature(token.data); return true; } catch { return false; }
}
const keyPush = (token) => token?.data?.length === 33 && [2, 3].includes(token.data[0]);

function validateSuffix(tokens, layout, recipe) {
  if (layout === "plain") {
    if (tokens.length) fail("SIGNATURE_LAYOUT_UNREGISTERED", "P2PKH does not permit covenant chunks");
    return;
  }
  if (layout === "pool") {
    if (!tokens.length) fail("SIGNATURE_LAYOUT_UNREGISTERED", "signed Pool recipe requires covenant bytes");
    return; // pool_unlock bytes are all retained and compared exactly.
  }
  const swap = layout === "swap", contractCount = swap ? (recipe.version > 1 ? 34 : 8) : 0;
  const tagCount = Number(swap && recipe.version > 2), coinCount = Number(recipe.coin);
  if (tokens.length !== contractCount + tagCount + coinCount + 11) fail("SIGNATURE_LAYOUT_UNREGISTERED", "FT suffix instruction count does not match its exact recipe");
  const pre = tokens.slice(contractCount + tagCount + coinCount), n = (i) => pre[i].data?.length;
  if (n(0) !== 16 || !n(1) || n(1) % 40 || n(2) !== 32 || n(3) === undefined
    || n(4) !== 8 || n(5) === undefined || n(6) !== 32 || ![1, 2].includes(n(7))
    || n(8) !== 8 || n(9) === undefined || n(10) === undefined) {
    fail("SIGNATURE_LAYOUT_UNREGISTERED", "malformed FT pre_tx_data suffix");
  }
  if (swap && (!tokens[0].data?.length || tokens[0].data.length % 40 || tokens[1].data?.length !== 16
    || tokens[2].data?.length !== 32 || tokens[3].data?.length !== 32)) {
    fail("SIGNATURE_LAYOUT_UNREGISTERED", "malformed FT current-input/contract suffix");
  }
}

function independentDigest(raw, inputIndex, prevout) {
  const script = Buffer.from(prevout.script, "hex"), input = raw.inputs[inputIndex];
  const outputs = raw.outputs.map((o) => { const s = Buffer.from(o.script, "hex"); return Buffer.concat([u64(o.satoshis), compact(s.length), s]); });
  // Pinned sighash.rs::forkid_sighash for the only registered type, ALL|FORKID (0x41).
  return hash2(Buffer.concat([
    u32(raw.version), hash2(Buffer.concat(raw.inputs.map(outpoint))), hash2(Buffer.concat(raw.inputs.map((i) => u32(i.sequence)))),
    outpoint(input), compact(script.length), script, u64(prevout.satoshis), u32(input.sequence), hash2(Buffer.concat(outputs)), u32(raw.lockTime), u32(65),
  ])).toString("hex");
}

export function normalizeSignatures(raw, finalized, requests, context) {
  const body = (tx) => ({ ...tx, inputs: tx.inputs.map((i) => ({ ...i, script: "" })) });
  if (raw.inputs.some((i) => i.script !== "") || JSON.stringify(body(raw)) !== JSON.stringify(body(finalized))) {
    fail("SIGNATURE_TRANSACTION_BODY", "finalization changed bytes outside unlocking scripts");
  }
  if (!Array.isArray(requests)) fail("SIGNATURE_REQUEST_MISSING", "signing requests absent");
  const spends = authenticateSpentInputs(raw, requests, context);
  const result = raw.inputs.map((input, inputIndex) => {
    const spend = spends[inputIndex];
    const matches = requests.filter((r) => r.inputIndex === inputIndex);
    if (!spend.signed) {
      if (matches.length) fail("SIGNATURE_REQUEST_EXTRA", "unsigned Pool path must not receive a signing request");
      const script = finalized.inputs[inputIndex].script;
      const tokens = parseUnlockPushes(script);
      if (!tokens.length) fail("SIGNATURE_LAYOUT_UNREGISTERED", "unsigned Pool covenant is missing");
      if (tokens.some(looksLikeSignature)) fail("SIGNATURE_EXTRA", "unsigned Pool path contains a signature candidate");
      return { prefix: "", publicKey: null, sighashType: null, suffix: script };
    }
    if (!matches.length) fail("SIGNATURE_REQUEST_MISSING", `input ${inputIndex} has no signing request`);
    if (matches.length !== 1) fail("SIGNATURE_REQUEST_AMBIGUOUS", `input ${inputIndex} has multiple signing requests`);
    const request = matches[0], layout = registered(spend.recipe), script = finalized.inputs[inputIndex].script;
    const tokens = parseUnlockPushes(script), bytes = Buffer.from(script, "hex");
    const start = prefixEnd(bytes, raw, inputIndex, layout, true);
    const { signature, publicKey } = signaturePair(bytes, start);
    const candidates = tokens.filter(looksLikeSignature);
    if (candidates.filter((t) => keyPush(tokens[tokens.indexOf(t) + 1])).length > 1) {
      fail("SIGNATURE_AMBIGUOUS", "multiple signature/public-key candidates in a single-signature recipe");
    }
    if (candidates.some((t) => t.start !== start)) fail("SIGNATURE_EXTRA", "extra signature push outside the registered signature slot");
    const parsed = derSignature(signature.data);
    if (parsed.hasHighS()) fail("SIGNATURE_LOW_S", "signature must already be low-S");
    if (request.sighashType !== 65 || signature.data.at(-1) !== request.sighashType) fail("SIGNATURE_SIGHASH", "signature/request sighash must be exactly ALL|FORKID");
    if (!keyPush(publicKey) || publicKey.opcode !== 33 || !hex(request.publicKey)
      || publicKey.data.toString("hex") !== request.publicKey) fail("SIGNATURE_PUBLIC_KEY", "signature slot public key differs from its signing request");
    try { secp256k1.ProjectivePoint.fromHex(request.publicKey).assertValidity(); }
    catch { fail("SIGNATURE_PUBLIC_KEY", "public key is not a valid compressed secp256k1 point"); }
    verifyClassifiedPublicKey(spend.classification, request.publicKey);
    const prevout = spend.prevout;
    const digest = independentDigest(raw, inputIndex, prevout);
    if (request.digest !== digest) fail("SIGNATURE_DIGEST", "declared digest differs from independently serialized ForkID digest");
    if (!secp256k1.verify(parsed, digest, request.publicKey, { lowS: true, prehash: false })) fail("SIGNATURE_INVALID", "signature does not verify for the exact digest and public key");
    validateSuffix(tokens.filter((t) => t.start >= publicKey.end), layout, spend.recipe);
    return {
      prefix: bytes.subarray(0, start).toString("hex"), publicKey: request.publicKey, sighashType: request.sighashType,
      // Preserve the key push encoding as well as every following business byte.
      suffix: bytes.subarray(signature.end).toString("hex"),
    };
  });
  if (requests.length !== spends.filter((s) => s.signed).length) fail("SIGNATURE_REQUEST_EXTRA", "signing request for a nonexistent or unsigned input");
  return result;
}
