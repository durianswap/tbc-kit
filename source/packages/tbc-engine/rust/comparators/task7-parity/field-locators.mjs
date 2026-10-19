import { ComparisonError } from "./comparison-error.mjs";
import { locateSigningBoundary } from "./signature-normalizer.mjs";

// Independent comparator registry. Authority: 923497e8b2473c0e179fa0b86dbb32a2f188d25a,
// modules/tbc-transaction-engine/rust/vendor/tbc-sdk/src/contracts/:
// pool_nft_v2/builder.rs: init_pool 247-271; create_pool_inner 1807-1817;
// increase_lp_to 487-520; consume_lp_to 843-889; build_standalone_ftlp_tx 2704-2713;
// swap_to_token_to 1128-1197; swap_to_tbc_core 1395-1454; build_merge_pool_ft_round 2840-2862.
// pool_nft_v2/scripts.rs: pool_tape 271-302; ftlp_tape 375-429.
// ft/builder.rs: sign_ft_input 689-715; sign_ft_swap_input 719-760.
// ft/unlock.rs: classify_ft_script 25-83; contract_tx_data 154-194; pre_tx_data 213-239.
// These are layout facts, not producer summaries. Output indexes are zero based.

const fail = (reason, message) => { throw new ComparisonError(`FIELD_LOCATOR_${reason}`, message); };
const freeze = (value) => {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
const output = (family, index, optional = []) => ({ family, index, optional });
const pool = { poolTape: output("pool", 1) };
const lp = (index, locked, optional = []) => ({
  ftlpTape: { ...output("ftlp", index, optional), locked },
  ...(locked ? { ftlpLock: { ...output("ftlp", index, optional), locked, chunk: 1 } } : {}),
});
const create = (locked) => ({ prerequisite: pool, primary: { ...pool, ...lp(5, locked) } });
const remove = (locked) => ({ ...pool, ...lp(6, locked, [8]) });
const standalone = (locked) => lp(1, locked);
const poolMaintenance = {
  ...pool, ftTape: output("ft", 3),
  ftSwapIndexTag: { inputStart: 1, inputEnd: "before-fee", outputIndex: 3, swap: true },
  ftCoinFlag: { inputStart: 1, inputEnd: "before-fee", outputIndex: 3, swap: true },
};
const swap = (toToken) => ({
  ...pool,
  ftTape: output("ft", toToken ? 3 : 4),
  ...(toToken ? { ftSwapIndexTag: { inputStart: 2, inputEnd: "last", outputIndex: 3, swap: true } } : {}),
  ftCoinFlag: { inputStart: toToken ? 2 : 1, inputEnd: toToken ? "last" : 1, outputIndex: toToken ? 3 : 4, swap: toToken },
});

// kind -> role -> field class. Mixed maintenance has two explicitly registered
// variants, selected independently from raw script families; exactly one must match.
export const FIELD_LOCATORS = freeze({
  "create-standard": create(false), "create-locked": create(true),
  "add-standard": { primary: { ...pool, ...lp(5, false) } },
  "add-locked": { primary: { ...pool, ...lp(5, true) } },
  "remove-standard": { primary: remove(false) },
  "remove-locked": { primary: remove(true), maintenance: standalone(true) },
  "close-standard": { primary: remove(false) },
  "close-locked": { primary: remove(true), maintenance: standalone(true) },
  "swap-tbc-for-token": { primary: swap(true) },
  "swap-token-for-tbc": { primary: swap(false) },
  "no-merge": { primary: remove(false) },
  "pool-ft-maintenance": { primary: remove(false), maintenance: poolMaintenance },
  "ftlp-standard-maintenance": { primary: remove(false), maintenance: standalone(false) },
  "ftlp-locked-maintenance": { primary: remove(true), maintenance: standalone(true) },
  "simultaneous-maintenance": { primary: remove(false), maintenance: { variants: [poolMaintenance, standalone(false)] } },
});

const SCENARIO_KINDS = freeze({
  "create-standard-plan-1": "create-standard", "create-standard-plan-2": "create-standard",
  "create-standard-plan-3": "create-standard", "create-standard-plan-4": "create-standard",
  "create-standard-plan-5": "create-standard", "create-standard-plan-6": "create-standard",
  "create-locked-plan-1": "create-locked",
  "add-standard": "add-standard", "add-locked": "add-locked",
  "remove-standard": "remove-standard", "remove-locked": "remove-locked",
  "close-standard": "close-standard", "close-locked": "close-locked",
  "swap-tbc-for-token-standard": "swap-tbc-for-token", "swap-tbc-for-token-locked": "swap-tbc-for-token",
  "swap-token-for-tbc-standard": "swap-token-for-tbc", "swap-token-for-tbc-locked": "swap-token-for-tbc",
  "pool-ft-no-merge-threshold": "no-merge", "ftlp-no-merge-threshold": "no-merge",
  "pool-ft-merge": "pool-ft-maintenance", "pool-ft-multi-round": "pool-ft-maintenance",
  "ftlp-merge-standard": "ftlp-standard-maintenance", "ftlp-multi-round": "ftlp-standard-maintenance",
  "ftlp-merge-locked": "ftlp-locked-maintenance",
  "simultaneous-pool-ft-and-ftlp-maintenance": "simultaneous-maintenance",
});

export const FIELD_CODES = freeze({
  poolTape: "POOL_TAPE_FIELD", ftlpLock: "FTLP_LOCK_FIELD", ftlpTape: "FTLP_TAPE_FIELD",
  ftTape: "FT_TAPE_FIELD", ftSwapIndexTag: "FT_SWAP_INDEX_TAG", ftCoinFlag: "FT_COIN_FLAG",
});

function instructions(script, label, limit = Infinity) {
  if (!/^(?:[0-9a-f]{2})*$/.test(script)) fail("WRONG_SCRIPT", `${label}: invalid script hex`);
  const b = Buffer.from(script, "hex"), result = [];
  let i = 0;
  while (i < b.length && result.length < limit) {
    const start = i, opcode = b[i++];
    let length = null;
    if (opcode <= 75) length = opcode;
    else if (opcode <= 0x4e) {
      const width = 2 ** (opcode - 0x4c);
      if (i + width > b.length) fail("WRONG_SCRIPT", `${label}: truncated push length`);
      length = b.readUIntLE(i, width); i += width;
    }
    const dataStart = i;
    if (length !== null) i += length;
    if (i > b.length) fail("WRONG_SCRIPT", `${label}: truncated push data`);
    result.push({ opcode, data: length === null ? null : b.subarray(dataStart, i), start, end: i, hex: b.subarray(start, i).toString("hex") });
  }
  return result;
}

const marker = (script, name) => typeof script === "string" && script.endsWith(`05${Buffer.from(name).toString("hex")}`);
const lpCode = (script) => marker(script, "\x02Code");
const poolCandidate = (script) => script?.startsWith("006a") && marker(script, "NTape");
const lpIndexes = (raw) => raw.outputs.flatMap((o, i) => marker(o.script, "FTape") && lpCode(raw.outputs[i - 1]?.script) ? [i] : []);

function readTape(script, family, label, locked) {
  if (!script) fail("MISSING", `${label}: script absent`);
  if (!script.startsWith("006a")) fail("WRONG_SCRIPT", `${label}: expected OP_FALSE OP_RETURN Tape`);
  const chunks = instructions(script.slice(4), label);
  for (const item of chunks) {
    const n = item.data?.length;
    if (n === undefined || item.opcode !== (n <= 75 ? n : n <= 255 ? 0x4c : n <= 65535 ? 0x4d : 0x4e)) {
      fail("WRONG_SCRIPT", `${label}: noncanonical Tape push`);
    }
  }
  const lengths = chunks.map((c) => c.data.length);
  const last = chunks.at(-1)?.data.toString();
  if (family === "pool") {
    if (last !== "NTape" || lengths.length !== 8 || lengths[0] !== 64 || lengths[1] !== 24
      || lengths[2] !== 32 || ![1, 2].includes(lengths[3]) || lengths.slice(4, 7).some((n) => n !== 1)) {
      fail("WRONG_SCRIPT", `${label}: malformed Pool Tape fields`);
    }
  } else {
    if (last !== "FTape" || lengths[0] !== 48) fail("WRONG_SCRIPT", `${label}: malformed FT/FTLP Tape`);
    if (locked) {
      if (lengths[1] !== 4 || lengths.slice(2, -1).some((n) => n !== 0)) fail("WRONG_SCRIPT", `${label}: malformed locked FTLP Tape`);
    } else if (![5, 6].includes(lengths.length) || lengths[1] !== 1 || (lengths.length === 6 && lengths[4] !== 4)) {
      fail("WRONG_SCRIPT", `${label}: malformed standard FT/FTLP Tape`);
    }
  }
  return chunks;
}

function outputFields(raw, locator, field) {
  const indexes = [locator.index];
  const candidates = locator.family === "pool"
    ? raw.outputs.flatMap((o, i) => poolCandidate(o.script) ? [i] : [])
    : locator.family === "ftlp" ? lpIndexes(raw) : [];
  const allowed = [locator.index, ...locator.optional];
  if (candidates.length > allowed.length || (candidates.includes(locator.index) && candidates.some((i) => !allowed.includes(i)))) {
    fail("AMBIGUOUS", `${field}: multiple candidate Tapes at outputs ${candidates.join(",")}`);
  }
  for (const index of locator.optional) if (candidates.includes(index)) indexes.push(index);
  return indexes.map((index) => {
    const script = raw.outputs[index]?.script;
    if (!script) fail("MISSING", `${field}: output ${index} absent or empty`);
    if (locator.family === "ftlp" && !lpCode(raw.outputs[index - 1]?.script)) fail("WRONG_SCRIPT", `${field}: output ${index - 1} is not FTLP Code`);
    if (locator.family === "ft" && (!marker(raw.outputs[index - 1]?.script, "2Code") || lpCode(raw.outputs[index - 1]?.script))) fail("WRONG_SCRIPT", `${field}: output ${index - 1} is not FT Code`);
    const chunks = readTape(script, locator.family, `${field} output ${index}`, locator.locked);
    return {
      location: { phase: "unsignedRaw", outputIndex: index, family: locator.family, chunk: locator.chunk ?? null },
      // Preserve every push opcode/byte; lock fields are the full four-byte push.
      value: locator.chunk === undefined ? script : chunks[locator.chunk].hex,
    };
  });
}

function classifyFt(script) {
  const tokens = instructions(script, "FT Code"), fill = tokens.at(-5);
  if (!marker(script, "2Code") || !fill) fail("WRONG_SCRIPT", "FT Code marker/fill absent");
  const length = script.length / 2;
  const fillLength = fill.opcode === 0x5f ? 1 : fill.data?.length ?? fill.opcode;
  const allFF = fill.data?.length > 0 && fill.data.every((b) => b === 255);
  if (length === 1564) return { version: 1, coin: false };
  if (length === 1884) return { version: [1, 2].includes(fillLength) ? 3 : 2, coin: false };
  if (length === 2012 && allFF) {
    if (fillLength === 2) return { version: 3, coin: true };
    if ([11, 54].includes(fillLength)) return { version: 2, coin: true };
    if (fillLength === 28) return { version: 4, coin: false };
  }
  if (length === 2076) return { version: 4, coin: allFF && fillLength === 10 };
  fail("UNREGISTERED", `FT Code layout length=${length}, fill=${fillLength}`);
}

function ftInputFields(raw, finalized, locator, field, spends) {
  const outputScript = raw.outputs[locator.outputIndex - 1]?.script;
  const family = classifyFt(outputScript);
  const indexes = [];
  const last = locator.inputEnd === "last" ? raw.inputs.length - 1
    : locator.inputEnd === "before-fee" ? raw.inputs.length - 2 : locator.inputEnd;
  if (last < locator.inputStart) fail("MISSING", `${field}: no FT inputs`);
  for (let index = locator.inputStart; index <= last; index += 1) indexes.push(index);
  return indexes.map((index) => {
    const script = finalized.inputs[index]?.script;
    if (!script) fail("MISSING", `${field}: finalized FT input ${index} absent`);
    const recipe = spends?.[index]?.recipe;
    if (!recipe || recipe.kind !== (locator.swap ? "ft-swap" : "ft-transfer") || recipe.version !== family.version || recipe.coin !== family.coin) {
      fail("WRONG_SCRIPT", `${field}: output family and authenticated spent recipe disagree`);
    }
    const start = locateSigningBoundary(script, raw, index, recipe);
    const prefix = locator.swap ? (family.version > 1 ? 34 : 8) : 0;
    const hasTag = locator.swap && family.version > 2;
    const contract = instructions(script.slice(start * 2), `${field} FT contract region`, prefix);
    if (contract.length !== prefix) fail("MISSING", `${field}: incomplete FT contract region`);
    const tagIndex = start + (contract.at(-1)?.end ?? 0), coinIndex = tagIndex + Number(hasTag);
    // Both fields are literal one-byte opcodes in the pin. Read their bytes before
    // tokenizing pre_tx_data: a mutated OP_0 must not consume the next push's prefix.
    const tailIndex = coinIndex + Number(family.coin);
    const tail = instructions(script.slice(tailIndex * 2), `${field} FT pre_tx_data`);
    if (tail.length < 11) fail("MISSING", `${field}: incomplete registered FT input region`);
    if (tail.length > 11) fail("AMBIGUOUS", `${field}: extra instructions in registered FT input region`);
    if (tail[0].data?.length !== 16 || !tail[1].data?.length || tail[1].data.length % 40
      || tail[2].data?.length !== 32 || tail[4].data?.length !== 8 || !marker(tail[5].data?.toString("hex"), "2Code")
      || tail[6].data?.length !== 32 || ![1, 2].includes(tail[7].data?.length)
      || tail[8].data?.length !== 8 || !tail[9].data || tail[10].data === null) {
      fail("WRONG_SCRIPT", `${field}: malformed FT pre_tx_data region`);
    }
    const tapeChunks = readTape(tail[9].data.toString("hex"), "ft", `${field} FT input Tape`);
    if ((tapeChunks.length === 6) !== family.coin) fail("WRONG_SCRIPT", `${field}: FT input Tape family disagrees with Code`);
    if (locator.swap) {
      if (!contract[0].data?.length || contract[0].data.length % 40 || contract[1].data?.length !== 16
        || contract[2].data?.length !== 32 || contract[3].data?.length !== 32) {
        fail("WRONG_SCRIPT", `${field}: malformed FT contract/current-input region`);
      }
    }
    const present = field === "ftSwapIndexTag" ? hasTag : family.coin;
    const position = field === "ftSwapIndexTag" ? tagIndex : coinIndex;
    return { location: { phase: "finalizedRaw", inputIndex: index, region: field }, value: present ? script.slice(position * 2, position * 2 + 2) : null };
  });
}

export function assertFieldScope(name, role) {
  const kind = Object.hasOwn(SCENARIO_KINDS, name) ? SCENARIO_KINDS[name] : null;
  if (!kind || !Object.hasOwn(FIELD_LOCATORS[kind], role)) fail("UNREGISTERED", `${name}/${role}: no registered field set`);
  return kind;
}
export function resolveFields(name, role, raw, finalized, spends) {
  const kind = assertFieldScope(name, role);
  let fields = FIELD_LOCATORS[kind][role];
  if (fields.variants) {
    const hasPool = raw.outputs.some((o) => poolCandidate(o.script));
    const hasLP = lpIndexes(raw).length > 0;
    if (hasPool && hasLP) fail("AMBIGUOUS", `${name}/${role}: both maintenance families present`);
    if (!hasPool && !hasLP) fail("MISSING", `${name}/${role}: neither maintenance Tape present`);
    fields = fields.variants[hasPool ? 0 : 1];
  }
  // Validate all locators before comparing any business value, so a locator error
  // cannot be hidden behind a generic output count or script mismatch.
  const resolved = Object.fromEntries(Object.entries(fields).map(([field, locator]) => [field,
    locator.family ? outputFields(raw, locator, field) : ftInputFields(raw, finalized, locator, field, spends),
  ]));
  if (!fields.poolTape && raw.outputs.some((o) => poolCandidate(o.script))) fail("UNREGISTERED", `${name}/${role}: Pool Tape not registered`);
  if (!fields.ftlpTape && lpIndexes(raw).length > 0) fail("UNREGISTERED", `${name}/${role}: FTLP Tape not registered`);
  return resolved;
}
