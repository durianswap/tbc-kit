import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1";
import { ComparisonError } from "./comparison-error.mjs";
import { parseRawTransaction } from "./raw-comparator.mjs";
import { PIN, SCENARIOS } from "./protocol.mjs";

const fail = (code, message) => { throw new ComparisonError(code, message); };
const sha = (b) => createHash("sha256").update(b).digest();
const hash160 = (b) => createHash("ripemd160").update(sha(b)).digest("hex");
const word = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b; };
const amount = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };
const outpoint = (i) => Buffer.concat([Buffer.from(i.txid, "hex").reverse(), word(i.vout)]);
const freeze = (o) => { if (o && typeof o === "object") { Object.values(o).forEach(freeze); Object.freeze(o); } return o; };
const assets = freeze(JSON.parse(readFileSync(new URL("./pinned-spent-script-bindings.json", import.meta.url))));
if (assets.pin !== PIN) fail("WRONG_PIN", "spent-script bindings have a different source pin");

// Compile literal byte programs with only the substitution slots declared by the
// pinned ASM. Repeated parameters must match byte-for-byte. No marker/length scan.
const profiles = assets.entries.map((profile) => {
  const seen = new Set();
  const pattern = profile.program.map((part) => {
    if (typeof part === "string") return part;
    if (seen.has(part.field)) return `\\k<${part.field}>`;
    seen.add(part.field);
    return `(?<${part.field}>[0-9a-f]{${part.bytes === null ? "2,150" : part.bytes * 2}})`;
  }).join("");
  return { profile, expression: new RegExp(`^${pattern}$`) };
});

// Pinned transaction.rs::tbc_txid, NOT Bitcoin's hash of serialized raw bytes.
export function independentlyFinalizedTxid(rawHex) {
  const tx = parseRawTransaction(rawHex);
  const root = Buffer.concat([
    word(tx.version), word(tx.lockTime), word(tx.inputs.length), word(tx.outputs.length),
    sha(Buffer.concat(tx.inputs.flatMap((i) => [outpoint(i), word(i.sequence)]))),
    sha(Buffer.concat(tx.inputs.map((i) => sha(Buffer.from(i.script, "hex"))))),
    sha(Buffer.concat(tx.outputs.flatMap((o) => [amount(o.satoshis), sha(Buffer.from(o.script, "hex"))]))),
  ]);
  return sha(sha(root)).reverse().toString("hex");
}

export function classifySpentScript(script) {
  if (typeof script !== "string" || !/^(?:[0-9a-f]{2})+$/.test(script)) fail("SPENT_SCRIPT_UNREGISTERED", "invalid locking-script bytes");
  const p2pkh = /^76a914([0-9a-f]{40})88ac(?:6a10666f7220706f6f6c6e6674206d696e74)?$/.exec(script);
  if (p2pkh) return { family: "p2pkh", owner: p2pkh[1] };
  const matches = profiles.flatMap(({ profile, expression }) => {
    const match = expression.exec(script); return match ? [{ profile, fields: { ...match.groups } }] : [];
  });
  if (!matches.length) fail("SPENT_SCRIPT_UNREGISTERED", "locking script does not match an exact pinned template");
  if (matches.length !== 1) fail("SPENT_SCRIPT_AMBIGUOUS", "multiple exact templates matched");
  const { profile: p, fields: f } = matches[0];
  if (p.family === "pool") {
    const tag = Buffer.from(f.tagHex, "hex");
    if (Number.parseInt(f.tagLengthHex, 16) !== tag.length || tag.some((b) => b > 127)
      || !["1c06", "5c07", "dc07", "1c08"].includes(f.ftCodeSize)) fail("SPENT_SCRIPT_UNREGISTERED", "Pool template parameters are outside the pinned domain");
    const keys = Array.from({ length: p.keyCount ?? 0 }, (_, i) => f[`key${i}`]);
    try { for (const key of keys) secp256k1.ProjectivePoint.fromHex(key).assertValidity(); }
    catch { fail("SIGNATURE_LOCK_BINDING", "Pool key gate contains an invalid public key"); }
    if (new Set(keys).size !== keys.length) fail("SIGNATURE_LOCK_BINDING", "Pool key gate contains duplicate keys");
    return { family: "pool", locked: p.locked, keys, fields: f, ftCodeBytes: Buffer.from(f.ftCodeSize, "hex").readUInt16LE(), large: true };
  }
  const receiver = f.hash.slice(-2);
  if (!Number.parseInt(f.tapeSizeHex, 16) || !["00", "01"].includes(receiver) || (p.family === "ftlp" && receiver !== "00")) {
    fail("SPENT_SCRIPT_UNREGISTERED", "unsupported receiver or Tape-size binding");
  }
  return { family: p.family === "ftlp" ? (p.locked ? "ftlp-locked" : "ftlp") : receiver === "01" ? "pool-held-ft" : "ft",
    version: p.version, coin: p.coin, locked: p.locked ?? false, owner: f.hash.slice(0, 40), fields: f };
}

function tapeChunks(script) {
  if (!script?.startsWith("006a")) fail("SIGNATURE_CONTRACT_BINDING", "authenticated Code lacks its adjacent Tape");
  const bytes = Buffer.from(script, "hex"), chunks = [];
  for (let i = 2; i < bytes.length;) {
    const op = bytes[i++]; let n = op;
    if (op === 76) { if (i === bytes.length) fail("SIGNATURE_CONTRACT_BINDING", "truncated Tape length"); n = bytes[i++]; if (n <= 75) fail("SIGNATURE_CONTRACT_BINDING", "noncanonical Tape"); }
    else if (op > 75) fail("SIGNATURE_CONTRACT_BINDING", "unregistered Tape push");
    if (i + n > bytes.length) fail("SIGNATURE_CONTRACT_BINDING", "truncated Tape");
    chunks.push(bytes.subarray(i, i + n)); i += n;
  }
  return chunks;
}

// A resolver is comparator-owned state. Planned outputs become available only after
// their own independent finalization/signature checks have completed in compareEvidence.
export function createParentState(transactions = []) {
  const pending = new Set(transactions.map((t) => independentlyFinalizedTxid(t.finalizedRaw)));
  const verified = new Map();
  return Object.freeze({
    pending,
    verified,
    admit(transaction) {
      const raw = transaction.finalizedRaw, id = independentlyFinalizedTxid(raw);
      if (verified.has(id)) fail("SPENT_PARENT_AMBIGUOUS", "duplicate planned transaction id");
      verified.set(id, Object.freeze({ raw, tx: freeze(parseRawTransaction(raw)), templateId: transaction.templateId }));
    },
  });
}
function parentsFromBytes(raws, state) {
  if (!Array.isArray(raws)) fail("SPENT_PARENT_MISSING", "immutable raw parent transactions are required");
  const records = new Map();
  for (const raw of [...raws]) {
    if (typeof raw !== "string") fail("SPENT_PARENT_MISSING", "parent must be raw transaction bytes, not a producer summary");
    const id = independentlyFinalizedTxid(raw);
    if (records.has(id)) fail("SPENT_PARENT_AMBIGUOUS", "duplicate raw parent txid");
    if (state?.pending.has(id) && !state.verified.has(id)) fail("SPENT_PARENT_UNFINALIZED", "planned parent has not independently finalized");
    records.set(id, Object.freeze({ raw, tx: freeze(parseRawTransaction(raw)) }));
  }
  for (const [id, entry] of state?.verified ?? []) {
    if (records.has(id) && records.get(id).raw !== entry.raw) fail("SPENT_PARENT_AMBIGUOUS", "planned/external parent bytes conflict");
    records.set(id, entry);
  }
  return records;
}
const decodePoolTape = (parent, index, classified) => {
  const chunks = tapeChunks(parent.outputs[index + 1]?.script);
  if (chunks.length !== 8 || chunks[0].length !== 64 || chunks[1].length !== 24 || chunks[2].length !== 32 || chunks[7].toString() !== "NTape") {
    fail("SIGNATURE_CONTRACT_BINDING", "malformed authenticated Pool Tape");
  }
  if (chunks[5].length !== 1 || chunks[5][0] !== Number(classified.locked) || chunks[6].length !== 1 || ![0, 1].includes(chunks[6][0])) {
    fail("SIGNATURE_LOCK_BINDING", "Pool Code key gate disagrees with authenticated Pool Tape");
  }
  return { contract: chunks[2].toString("hex"), ftlpLocked: chunks[6][0] === 1 };
};

function expectedKind(c, scenario) {
  if (c.family === "pool") return c.locked && scenario.startsWith("swap-") ? "pool-signed" : "pool-unsigned";
  return { p2pkh: "p2pkh", ft: "ft-transfer", "pool-held-ft": "ft-swap", ftlp: "ftlp-transfer", "ftlp-locked": "ftlp-locked-transfer" }[c.family];
}

function bindContracts(spends, records) {
  const poolRecords = [];
  for (const entry of records.values()) for (const [index, o] of entry.tx.outputs.entries()) {
    let c; try { c = classifySpentScript(o.script); } catch { continue; }
    if (c.family === "pool") poolRecords.push({ script: o.script, classification: c, tape: decodePoolTape(entry.tx, index, c) });
  }
  const activePool = spends.find((s) => s.classification.family === "pool");
  for (const spend of spends) {
    const c = spend.classification;
    if (c.family === "p2pkh") continue;
    const ownTape = c.family === "pool" ? decodePoolTape(spend.parent, spend.prevout.vout, c) : null;
    const boundPools = poolRecords.filter((p) => c.family === "pool" ? p.script === spend.prevout.script
      : c.family === "pool-held-ft" ? hash160(Buffer.from(p.script, "hex")) === c.owner
        : c.family.startsWith("ftlp") ? sha(Buffer.from(p.script, "hex")).toString("hex") === c.fields.codeHash
          : activePool ? p.script === activePool.prevout.script : true);
    const unique = new Map(boundPools.map((p) => [p.script, p]));
    if (unique.size !== 1) fail("SIGNATURE_CONTRACT_BINDING", "input does not bind exactly one authenticated Pool Code");
    const pool = [...unique.values()][0];
    if (activePool && pool.script !== activePool.prevout.script) fail("SIGNATURE_CONTRACT_BINDING", "asset binds a different Pool than the spent Pool input");
    const authority = records.get((ownTape ?? pool.tape).contract)?.tx;
    if (!authority?.outputs[0]) fail("SIGNATURE_CONTRACT_BINDING", "Pool Tape FT contract txid has no authenticated raw transaction");
    const ft = classifySpentScript(authority.outputs[0].script);
    if (ft.family !== "ft") fail("SIGNATURE_CONTRACT_BINDING", "FT contract must contain the exact owner-held FT template");
    if (pool.classification.ftCodeBytes !== authority.outputs[0].script.length / 2) fail("SIGNATURE_VERSION_BINDING", "Pool ftCodeSize differs from authenticated FT contract");
    if (c.family === "pool") continue;
    if (c.version !== ft.version || (c.family.startsWith("ftlp") ? spend.prevout.script.length / 2 !== authority.outputs[0].script.length / 2 : c.coin !== ft.coin)) {
      fail("SIGNATURE_VERSION_BINDING", "spent asset version differs from authenticated FT contract");
    }
    const adjacent = spend.parent.outputs[spend.prevout.vout + 1];
    const chunks = tapeChunks(adjacent?.script);
    if (adjacent.satoshis !== "0" || chunks[0]?.length !== 48 || chunks.at(-1)?.toString() !== "FTape"
      || Number.parseInt(c.fields.tapeSizeHex, 16) !== adjacent.script.length / 2) fail("SIGNATURE_CONTRACT_BINDING", "spent Code/Tape size or family differs");
    if (c.family.startsWith("ftlp")) {
      const locked = chunks[1]?.length === 4 && chunks.slice(2, -1).every((b) => b.length === 0);
      if (locked !== c.locked || (c.locked && !pool.tape.ftlpLocked)) fail("SIGNATURE_LOCK_BINDING", "FTLP lock template does not bind its Pool/Tape lock state");
      if (!locked && (![5, 6].includes(chunks.length) || chunks[1]?.length !== 1)) fail("SIGNATURE_LOCK_BINDING", "unlocked FTLP does not have standard Tape fields");
    } else {
      for (const field of c.coin ? ["codeHash", "adminPubHash", "tapeSizeHex"] : ["utxoHex", "tapeSizeHex"]) {
        if (c.fields[field] !== ft.fields[field]) fail("SIGNATURE_CONTRACT_BINDING", "spent FT belongs to a different contract binding");
      }
    }
  }
}

function roleFamilies(scenario, role, spends) {
  if (!SCENARIOS.includes(scenario)) fail("SIGNATURE_LAYOUT_ROLE", "unregistered transaction scenario");
  const n = spends.length, families = spends.map((s) => s.classification.family);
  const isLp = (family) => ["ftlp", "ftlp-locked"].includes(family);
  let valid = false;
  if (role === "prerequisite") valid = scenario.startsWith("create-") && n > 0 && families.every((f) => f === "p2pkh");
  else if (role === "maintenance") {
    if (families[0] === "pool") valid = (scenario.startsWith("pool-ft-") || scenario.startsWith("simultaneous-")) && n >= 3 && families.at(-1) === "p2pkh" && families.slice(1, -1).every((f) => f === "pool-held-ft");
    else valid = (scenario.startsWith("ftlp-") || scenario.startsWith("simultaneous-") || ["remove-locked", "close-locked"].includes(scenario)) && n >= 2 && families.at(-1) === "p2pkh" && families.slice(0, -1).every(isLp);
  } else if (role === "primary" && families[0] === "pool") {
    if (scenario.startsWith("create-") || scenario.startsWith("add-") || scenario.startsWith("swap-token-")) valid = n === 3 && families[1] === "ft" && families[2] === "p2pkh";
    else if (scenario.startsWith("swap-tbc-")) valid = n >= 3 && families[1] === "p2pkh" && families.slice(2).every((f) => f === "pool-held-ft");
    else valid = n >= 4 && isLp(families[1]) && families.at(-1) === "p2pkh" && families.slice(2, -1).every((f) => f === "pool-held-ft");
  }
  if (!valid) fail("SIGNATURE_LAYOUT_ROLE", `${scenario}/${role} does not register spent families ${families.join(",")}`);
}

export function authenticateSpentInputs(raw, requests, context = {}) {
  const records = parentsFromBytes(context.parentRaws, context.parentState);
  const spends = raw.inputs.map((input, inputIndex) => {
    const entry = records.get(input.txid);
    if (!entry) {
      if (context.parentState?.pending.has(input.txid)) fail("SPENT_PARENT_UNFINALIZED", "input references an unfinalized planned parent");
      fail("SPENT_PARENT_MISSING", `input ${inputIndex} parent txid does not match any immutable raw parent`);
    }
    const output = entry.tx.outputs[input.vout];
    if (!output) fail("SPENT_PREVOUT_MISSING", `input ${inputIndex} parent has no output ${input.vout}`);
    const classification = classifySpentScript(output.script);
    if (context.role === "prerequisite" && classification.family !== "p2pkh") fail("SIGNATURE_LAYOUT_ROLE", "Pool create prerequisite spends only P2PKH funding/source inputs");
    const kind = expectedKind(classification, context.scenario ?? "");
    const recipe = kind.startsWith("ft") ? { kind, version: classification.version, coin: classification.family.startsWith("ftlp") ? false : classification.coin } : { kind };
    const matches = (requests ?? []).filter((r) => r.inputIndex === inputIndex);
    if (kind !== "pool-unsigned" && !matches.length) fail("SIGNATURE_REQUEST_MISSING", `input ${inputIndex} has no signing request`);
    if (matches.length > 1) fail("SIGNATURE_REQUEST_AMBIGUOUS", `input ${inputIndex} has ambiguous signing requests`);
    const request = matches[0];
    const claimed = request?.recipe;
    if (claimed) {
      if (!["p2pkh", "pool-signed", "pool-unsigned", "ft-transfer", "ft-swap", "ftlp-transfer", "ftlp-locked-transfer"].includes(claimed.kind)) fail("SIGNATURE_LAYOUT_UNREGISTERED", "producer claims an unregistered recipe");
      if (claimed.kind !== kind) fail("SIGNATURE_LAYOUT_TYPE", "claimed unlock layout does not match authenticated spent-script type");
      if (Object.keys(claimed).some((key) => !Object.hasOwn(recipe, key))) fail("SIGNATURE_LAYOUT_UNREGISTERED", "producer-selected layout field is not registered");
      if (kind.startsWith("ft") && (claimed.version !== recipe.version || claimed.coin !== recipe.coin)) fail("SIGNATURE_VERSION_BINDING", "declared FT version/coin mode differs from authenticated script");
    }
    const prevout = { txid: input.txid, vout: input.vout, script: output.script, satoshis: output.satoshis };
    if (request?.prevout && Object.entries(prevout).some(([key, value]) => request.prevout[key] !== value)) fail("SIGNATURE_PREVOUT", "producer prevout differs from the actual authenticated parent output");
    return { prevout, classification, recipe, parent: entry.tx, signed: kind !== "pool-unsigned" };
  });
  bindContracts(spends, records);
  roleFamilies(context.scenario, context.role, spends);
  return spends;
}

export function verifyClassifiedPublicKey(classification, publicKey) {
  if (["p2pkh", "ft", "ftlp", "ftlp-locked"].includes(classification.family)
    && hash160(Buffer.from(publicKey, "hex")) !== classification.owner) fail("SIGNATURE_PUBLIC_KEY", "public key does not own the authenticated spent script");
  if (classification.family === "pool" && classification.locked && !classification.keys.includes(publicKey)) fail("SIGNATURE_PUBLIC_KEY", "public key is absent from the authenticated Pool lock gate");
}
