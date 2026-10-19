import assert from "node:assert/strict";
import { SCENARIOS, PIN } from "./protocol.mjs";
import { ComparisonError } from "./comparison-error.mjs";
import { FIELD_CODES, resolveFields, assertFieldScope } from "./field-locators.mjs";
import { normalizeSignatures } from "./signature-normalizer.mjs";
import { authenticateSpentInputs, createParentState } from "./spent-script-bindings.mjs";
export { ComparisonError } from "./comparison-error.mjs";

const fail = (code, message) => { throw new ComparisonError(code, message); };

function compactSize(bytes, offset) {
  const prefix = bytes[offset];
  if (prefix < 0xfd) return { value: prefix, size: 1 };
  if (prefix === 0xfd) return { value: bytes.readUInt16LE(offset + 1), size: 3 };
  if (prefix === 0xfe) return { value: bytes.readUInt32LE(offset + 1), size: 5 };
  const value = bytes.readBigUInt64LE(offset + 1);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) fail("RAW_RANGE", "CompactSize exceeds safe range");
  return { value: Number(value), size: 9 };
}

export function parseRawTransaction(raw) {
  if (!/^(?:[0-9a-f]{2})+$/.test(raw)) fail("RAW_HEX", "transaction is not lowercase even-length hex");
  const bytes = Buffer.from(raw, "hex");
  let offset = 0;
  const take = (length) => {
    const value = bytes.subarray(offset, offset + length);
    if (value.length !== length) fail("RAW_TRUNCATED", "transaction ended before declared field length");
    offset += length;
    return value;
  };
  const version = take(4).readUInt32LE();
  const inputCount = compactSize(bytes, offset);
  offset += inputCount.size;
  const inputs = [];
  for (let index = 0; index < inputCount.value; index += 1) {
    const txid = Buffer.from(take(32)).reverse().toString("hex");
    const vout = take(4).readUInt32LE();
    const scriptLength = compactSize(bytes, offset);
    offset += scriptLength.size;
    const script = take(scriptLength.value).toString("hex");
    const sequence = take(4).readUInt32LE();
    inputs.push({ txid, vout, script, sequence });
  }
  const outputCount = compactSize(bytes, offset);
  offset += outputCount.size;
  const outputs = [];
  for (let index = 0; index < outputCount.value; index += 1) {
    const satoshis = take(8).readBigUInt64LE().toString();
    const scriptLength = compactSize(bytes, offset);
    offset += scriptLength.size;
    outputs.push({ satoshis, script: take(scriptLength.value).toString("hex") });
  }
  const lockTime = take(4).readUInt32LE();
  if (offset !== bytes.length) fail("RAW_TRAILING_BYTES", "transaction has trailing bytes");
  return { version, inputs, outputs, lockTime };
}

function equal(actual, expected, code, message) {
  try {
    assert.deepEqual(actual, expected);
  } catch {
    fail(code, message);
  }
}

function compareTransaction(source, core, name, index, sourceParents, coreParents) {
  equal(core.templateId, source.templateId, "MAINTENANCE_ORDER", `${name}[${index}] template order`);
  equal(core.stage, source.stage, "STAGE_ROLE", `${name}[${index}] stage`);
  equal(core.role, source.role, "STAGE_ROLE", `${name}[${index}] role`);
  equal(core.dependencies, source.dependencies, "DEPENDENCY", `${name}[${index}] dependency graph`);
  equal(core.auxiliaryParents, source.auxiliaryParents, "AUXILIARY_PARENT_ORDER", `${name}[${index}] auxiliary parent order`);

  const sourceRaw = parseRawTransaction(source.unsignedRaw);
  const coreRaw = parseRawTransaction(core.unsignedRaw);
  equal(coreRaw.version, sourceRaw.version, "HEADER_VERSION", `${name}[${index}] version`);
  equal(coreRaw.lockTime, sourceRaw.lockTime, "LOCK_TIME", `${name}[${index}] lock time`);
  equal(coreRaw.inputs.length, sourceRaw.inputs.length, "INPUT_OUTPOINT", `${name}[${index}] input count`);
  for (let inputIndex = 0; inputIndex < sourceRaw.inputs.length; inputIndex += 1) {
    const a = sourceRaw.inputs[inputIndex];
    const b = coreRaw.inputs[inputIndex];
    equal({ txid: b.txid, vout: b.vout }, { txid: a.txid, vout: a.vout }, "INPUT_OUTPOINT", `${name}[${index}] input ${inputIndex} outpoint`);
    equal(b.sequence, a.sequence, "INPUT_SEQUENCE", `${name}[${index}] input ${inputIndex} sequence`);
  }
  // Legacy declarations never select a byte. Preserve declaration differences as
  // errors rather than normalizing them away; the registry alone resolves fields.
  equal(core.fieldLocators, source.fieldLocators, "FIELD_LOCATOR_UNREGISTERED", `${name}[${index}] conflicting producer locator declarations`);
  for (const field of Object.keys(source.fieldLocators ?? {})) {
    if (!Object.hasOwn(FIELD_CODES, field)) fail("FIELD_LOCATOR_UNREGISTERED", `${name}[${index}] unregistered field class ${field}`);
  }
  const sourceFinal = parseRawTransaction(source.finalizedRaw);
  const coreFinal = parseRawTransaction(core.finalizedRaw);
  const sourceContext = { parentRaws: source.parentRaws, scenario: name, role: source.role, parentState: sourceParents };
  const coreContext = { parentRaws: core.parentRaws, scenario: name, role: core.role, parentState: coreParents };
  assertFieldScope(name, source.role);
  assertFieldScope(name, core.role);
  const sourceSpends = authenticateSpentInputs(sourceRaw, source.signingRequests, sourceContext);
  const coreSpends = authenticateSpentInputs(coreRaw, core.signingRequests, coreContext);
  const sourceFields = resolveFields(name, source.role, sourceRaw, sourceFinal, sourceSpends);
  const coreFields = resolveFields(name, core.role, coreRaw, coreFinal, coreSpends);
  equal(Object.keys(coreFields), Object.keys(sourceFields), "FIELD_LOCATOR_UNREGISTERED", `${name}[${index}] resolved field classes differ`);
  // Lock fields precede their enclosing Tape comparison to preserve the intended code.
  const fields = Object.keys(sourceFields).sort((a, b) => Number(b === "ftlpLock") - Number(a === "ftlpLock"));
  for (const field of fields) {
    equal(coreFields[field].map((v) => v.location), sourceFields[field].map((v) => v.location), "FIELD_LOCATOR_UNREGISTERED", `${name}[${index}] ${field} locations differ`);
    equal(coreFields[field].map((v) => v.value), sourceFields[field].map((v) => v.value), FIELD_CODES[field], `${name}[${index}] ${field}`);
  }
  equal(coreRaw.outputs.length, sourceRaw.outputs.length, "OUTPUT_SCRIPT", `${name}[${index}] output count`);

  for (let outputIndex = 0; outputIndex < sourceRaw.outputs.length; outputIndex += 1) {
    const a = sourceRaw.outputs[outputIndex];
    const b = coreRaw.outputs[outputIndex];
    if (outputIndex === source.changeIndex) {
      equal({ satoshis: b.satoshis, script: b.script }, { satoshis: a.satoshis, script: a.script }, "FEE_CHANGE", `${name}[${index}] fee/change output`);
    } else {
      equal(b.satoshis, a.satoshis, "OUTPUT_AMOUNT", `${name}[${index}] output ${outputIndex} amount`);
      equal(b.script, a.script, "OUTPUT_SCRIPT", `${name}[${index}] output ${outputIndex} script`);
    }
  }
  equal(core.poolState, source.poolState, "POOL_STATE", `${name}[${index}] Pool state`);
  equal(core.reserveAndValueDeltas, source.reserveAndValueDeltas, "RESERVE_VALUE_DELTA", `${name}[${index}] reserve/value deltas`);
  equal({ fee: core.fee, changeIndex: core.changeIndex }, { fee: source.fee, changeIndex: source.changeIndex }, "FEE_CHANGE", `${name}[${index}] fee/change metadata`);
  equal(core.signingRequests, source.signingRequests, "SIGNING_ASSOCIATION", `${name}[${index}] signing association`);

  equal(coreFinal.inputs.length, sourceFinal.inputs.length, "POOL_UNLOCK_SUFFIX", `${name}[${index}] finalized input count`);
  const sourceScripts = normalizeSignatures(sourceRaw, sourceFinal, source.signingRequests, sourceContext);
  const coreScripts = normalizeSignatures(coreRaw, coreFinal, core.signingRequests, coreContext);
  for (let inputIndex = 0; inputIndex < sourceFinal.inputs.length; inputIndex += 1) {
    const a = sourceScripts[inputIndex];
    const b = coreScripts[inputIndex];
    equal(b.prefix, a.prefix, "SIGNATURE_PREFIX", `${name}[${index}] finalized current/ancestry prefix`);
    equal(b.publicKey, a.publicKey, "SIGNING_ASSOCIATION", `${name}[${index}] finalized public key`);
    equal(b.suffix, a.suffix, "POOL_UNLOCK_SUFFIX", `${name}[${index}] finalized covenant suffix`);
  }
  sourceParents.admit(source);
  coreParents.admit(core);
}

export function compareEvidence(source, core) {
  equal(source.pin, PIN, "WRONG_PIN", "source pin");
  equal(core.pin, PIN, "WRONG_PIN", "core pin");
  equal(source.producer, "pinned-source", "PRODUCER_IDENTITY", "source producer identity");
  equal(core.producer, "production-core", "PRODUCER_IDENTITY", "core producer identity");
  equal(source.scenarios.map(({ name }) => name), SCENARIOS, "MATRIX", "source scenario matrix");
  equal(core.scenarios.map(({ name }) => name), SCENARIOS, "MATRIX", "core scenario matrix");

  for (let scenarioIndex = 0; scenarioIndex < SCENARIOS.length; scenarioIndex += 1) {
    const a = source.scenarios[scenarioIndex];
    const b = core.scenarios[scenarioIndex];
    const sourcePrimary = a.transactions.filter(({ role }) => role === "primary");
    const corePrimary = b.transactions.filter(({ role }) => role === "primary");
    if (corePrimary.length !== 1 || b.transactions.at(-1)?.role !== "primary") {
      fail("MISSING_PRIMARY", `${b.name} must contain exactly one final primary transaction`);
    }
    if (b.transactions.some(({ role, publicIntent }) => role === "maintenance" && publicIntent)) {
      fail("EXTRA_PUBLIC_MAINTENANCE", `${b.name} exposes maintenance as a public operation`);
    }
    equal(corePrimary.length, sourcePrimary.length, "MISSING_PRIMARY", `${b.name} primary cardinality`);
    equal(b.transactions.map(({ role }) => role), a.transactions.map(({ role }) => role), "MAINTENANCE_ORDER", `${b.name} maintenance order`);
    equal(b.transactions.length, a.transactions.length, "MAINTENANCE_ORDER", `${b.name} transaction count`);
    const sourceParents = createParentState(a.transactions), coreParents = createParentState(b.transactions);
    for (let index = 0; index < a.transactions.length; index += 1) {
      compareTransaction(a.transactions[index], b.transactions[index], a.name, index, sourceParents, coreParents);
    }
  }
  return { ok: true, scenarios: SCENARIOS.length };
}
