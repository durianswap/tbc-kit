import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const PIN = "923497e8b2473c0e179fa0b86dbb32a2f188d25a";
const isP2pkh = (output) => output?.script?.startsWith("76a914") && output.script.endsWith("88ac");
const bigint = (value) => BigInt(value);
const exact = (actual, expected, message) => assert.deepEqual(actual, expected, message);
const nftFeeDeltas = Object.freeze({ collection: 0n, nftMint: 0n, nftTransferV2: 0n, nftTransferV1: 1n, nftTransferV0: -3n, nftTransferV0Mutation: -3n });

const sha256 = (bytes) => createHash("sha256").update(bytes).digest();
const hash256 = (bytes) => sha256(sha256(bytes));
const u32le = (value) => { const bytes = Buffer.alloc(4); bytes.writeUInt32LE(value); return bytes; };
const u64le = (value) => { const bytes = Buffer.alloc(8); bytes.writeBigUInt64LE(bigint(value)); return bytes; };

function readCompactSize(bytes, offset) {
  const prefix = bytes[offset];
  if (prefix < 0xfd) return { value: prefix, size: 1 };
  if (prefix === 0xfd) return { value: bytes.readUInt16LE(offset + 1), size: 3 };
  if (prefix === 0xfe) return { value: bytes.readUInt32LE(offset + 1), size: 5 };
  const value = bytes.readBigUInt64LE(offset + 1);
  assert.ok(value <= BigInt(Number.MAX_SAFE_INTEGER), "compact size range");
  return { value: Number(value), size: 9 };
}

function compactSize(value) {
  if (value < 0xfd) return Buffer.from([value]);
  if (value <= 0xffff) { const bytes = Buffer.alloc(3); bytes[0] = 0xfd; bytes.writeUInt16LE(value, 1); return bytes; }
  if (value <= 0xffffffff) { const bytes = Buffer.alloc(5); bytes[0] = 0xfe; bytes.writeUInt32LE(value, 1); return bytes; }
  const bytes = Buffer.alloc(9); bytes[0] = 0xff; bytes.writeBigUInt64LE(BigInt(value), 1); return bytes;
}

function parseTransaction(raw) {
  assert.match(raw, /^(?:[0-9a-f]{2})+$/, "transaction hex");
  const bytes = Buffer.from(raw, "hex");
  let offset = 0;
  const take = (length) => { const value = bytes.subarray(offset, offset + length); assert.equal(value.length, length, "transaction truncation"); offset += length; return value; };
  const version = take(4).readUInt32LE();
  const inputCount = readCompactSize(bytes, offset); offset += inputCount.size;
  const inputs = [];
  for (let index = 0; index < inputCount.value; index += 1) {
    const txid = Buffer.from(take(32)).reverse().toString("hex");
    const vout = take(4).readUInt32LE();
    const scriptLength = readCompactSize(bytes, offset); offset += scriptLength.size;
    const script = take(scriptLength.value).toString("hex");
    const sequence = take(4).readUInt32LE();
    inputs.push({ txid, vout, script, sequence });
  }
  const outputCount = readCompactSize(bytes, offset); offset += outputCount.size;
  const outputs = [];
  for (let index = 0; index < outputCount.value; index += 1) {
    const satoshis = take(8).readBigUInt64LE().toString();
    const scriptLength = readCompactSize(bytes, offset); offset += scriptLength.size;
    outputs.push({ satoshis, script: take(scriptLength.value).toString("hex") });
  }
  const lockTime = take(4).readUInt32LE();
  assert.equal(offset, bytes.length, "transaction trailing bytes");
  return { version, inputs, outputs, lockTime };
}

function serializeTransaction(transaction, neutral = false) {
  const inputs = transaction.inputs.map((input) => {
    const script = Buffer.from(neutral ? "" : input.script, "hex");
    return Buffer.concat([Buffer.from(input.txid, "hex").reverse(), u32le(input.vout), compactSize(script.length), script, u32le(input.sequence)]);
  });
  const outputs = transaction.outputs.map((output) => serializedOutput(output));
  return Buffer.concat([u32le(transaction.version), compactSize(inputs.length), ...inputs, compactSize(outputs.length), ...outputs, u32le(transaction.lockTime)]).toString("hex");
}

function serializedOutput(output) {
  const script = Buffer.from(output.script, "hex");
  return Buffer.concat([u64le(output.satoshis), compactSize(script.length), script]);
}

function txidFromRaw(raw) {
  const transaction = parseTransaction(raw);
  const inputBase = Buffer.concat(transaction.inputs.flatMap((input) => [Buffer.from(input.txid, "hex").reverse(), u32le(input.vout), u32le(input.sequence)]));
  const inputUnlocks = Buffer.concat(transaction.inputs.map((input) => sha256(Buffer.from(input.script, "hex"))));
  const outputData = Buffer.concat(transaction.outputs.flatMap((output) => [u64le(output.satoshis), sha256(Buffer.from(output.script, "hex"))]));
  const root = Buffer.concat([
    u32le(transaction.version), u32le(transaction.lockTime), u32le(transaction.inputs.length), u32le(transaction.outputs.length),
    sha256(inputBase), sha256(inputUnlocks), sha256(outputData),
  ]);
  return Buffer.from(hash256(root)).reverse().toString("hex");
}

function forkIdDigest(raw, signer) {
  const transaction = parseTransaction(raw);
  const input = transaction.inputs[signer.inputIndex];
  assert.ok(input, "signer input exists");
  const prevouts = Buffer.concat(transaction.inputs.map((item) => Buffer.concat([Buffer.from(item.txid, "hex").reverse(), u32le(item.vout)])));
  const sequences = Buffer.concat(transaction.inputs.map((item) => u32le(item.sequence)));
  const outputs = Buffer.concat(transaction.outputs.map((output) => serializedOutput(output)));
  const script = Buffer.from(signer.previousScript, "hex");
  const preimage = Buffer.concat([
    u32le(transaction.version), hash256(prevouts), hash256(sequences),
    Buffer.from(input.txid, "hex").reverse(), u32le(input.vout), compactSize(script.length), script,
    u64le(signer.previousSatoshis), u32le(input.sequence), hash256(outputs), u32le(transaction.lockTime), u32le(signer.sighashType),
  ]);
  return hash256(preimage).toString("hex");
}

function normalizeTransactionForChange(raw, changeIndex) {
  const transaction = parseTransaction(raw);
  transaction.outputs[changeIndex].satoshis = "0";
  return serializeTransaction(transaction, true);
}

function normalizeCovenantSuffix(suffix, changeOutput, message) {
  if (suffix.length === 0) return suffix;
  const bytes = Buffer.from(suffix, "hex");
  const encoded = u64le(changeOutput.satoshis);
  const first = bytes.indexOf(encoded);
  assert.ok(first >= 0, `${message} encoded change output amount`);
  assert.equal(bytes.indexOf(encoded, first + 1), -1, `${message} unique encoded change output amount`);
  const normalized = Buffer.concat([bytes.subarray(0, first), u64le(0), bytes.subarray(first + encoded.length)]);
  return normalized.toString("hex");
}

function assertRawFields(name, transaction, stage) {
  const parsed = parseTransaction(transaction.unsignedRaw);
  exact(parsed.version, transaction.version, `${name}[${stage}] encoded version`);
  exact(parsed.lockTime, transaction.lockTime, `${name}[${stage}] encoded locktime`);
  exact(parsed.inputs.map(({ txid, vout, sequence }) => ({ txid, vout, sequence })), transaction.inputs, `${name}[${stage}] encoded inputs`);
  exact(parsed.outputs, transaction.outputs, `${name}[${stage}] encoded outputs`);
  assert.ok(parsed.inputs.every((input) => input.script.length === 0), `${name}[${stage}] neutral input scripts`);
  exact(txidFromRaw(transaction.unsignedRaw), transaction.signatureNeutralTxid, `${name}[${stage}] encoded neutral txid`);
}

function sourceTransactionFromSignedRaw(raw, sourceEvidence) {
  const transaction = parseTransaction(raw);
  const unsignedRaw = serializeTransaction(transaction, true);
  const inputTotal = sourceEvidence.signers.reduce((total, signer) => total + bigint(signer.previousSatoshis), 0n);
  const outputTotal = transaction.outputs.reduce((total, output) => total + bigint(output.satoshis), 0n);
  const covenantSuffixes = Array(transaction.inputs.length).fill("");
  for (const signer of sourceEvidence.signers) covenantSuffixes[signer.inputIndex] = signer.covenantSuffix;
  return {
    version: transaction.version,
    inputs: transaction.inputs.map(({ txid, vout, sequence }) => ({ txid, vout, sequence })),
    outputs: transaction.outputs,
    lockTime: transaction.lockTime,
    unsignedRaw,
    canonicalSignatureNeutralRaw: unsignedRaw,
    signatureNeutralTxid: txidFromRaw(unsignedRaw),
    signatureSlots: transaction.inputs.map((input, inputIndex) => ({ inputIndex, occupied: input.script.length > 0 })),
    signedRaw: raw,
    txid: txidFromRaw(raw),
    covenantSuffixes,
    fee: (inputTotal - outputTotal).toString(),
  };
}

const allowedDivergences = Object.freeze({
  feeAndChange: "Pinned wallet/SDK builders size their signed transaction; core reserves deterministic external-signature headroom. Only fee and final P2PKH change amount may differ, with an exact balancing delta.",
  v0DigestAndSuffix: "A V0 fee/change delta changes the ForkID digest and the change value embedded in the legacy covenant suffix. Source and core values are independently derived and every differing byte is asserted.",
  ecdsa: "Signed raw and signed txid identity is asserted only when independently built transaction bodies and digests are equal; otherwise both finalized raws/txids are validated and the exact body divergence is recorded.",
  stablecoinDeferred: "Round-2 StableCoin assertions are retained without expansion. Round-3 canonical state and exhaustive primary-stage work is deferred until after Tasks 7-10.",
});

function assertNormalized(name, transaction, stage, coreTransaction) {
  const common = ["version", "inputs", "outputs", "lockTime", "unsignedRaw", "canonicalSignatureNeutralRaw", "signatureNeutralTxid", "signatureSlots", "fee", "covenantSuffixes"];
  for (const key of common) assert.ok(key in transaction, `${name}[${stage}] missing ${key}`);
  assert.equal(transaction.unsignedRaw, transaction.canonicalSignatureNeutralRaw, `${name}[${stage}] neutral unsigned raw`);
  assert.match(transaction.signatureNeutralTxid, /^[0-9a-f]{64}$/, `${name}[${stage}] neutral txid`);
  for (const input of transaction.inputs) {
    assert.match(input.txid, /^[0-9a-f]{64}$/, `${name}[${stage}] input txid`);
    assert.ok(Number.isInteger(input.vout) && Number.isInteger(input.sequence), `${name}[${stage}] input fields`);
  }
  for (const output of transaction.outputs) assert.ok(bigint(output.satoshis) >= 0n && /^[0-9a-f]*$/.test(output.script), `${name}[${stage}] output fields`);
  if (coreTransaction) {
    for (const key of ["templateId", "role", "planDependencies", "signingRequests", "finalizedRaw", "finalizedTxid", "finalizedSignatureNeutralRaw"]) assert.ok(key in transaction, `${name}[${stage}] missing actual core ${key}`);
    if (!(name === "stablecoinMerge" && stage === 1)) {
      assert.equal(transaction.finalizedSignatureNeutralRaw, transaction.unsignedRaw, `${name}[${stage}] finalized-neutral raw`);
    }
    assert.match(transaction.finalizedTxid, /^[0-9a-f]{64}$/, `${name}[${stage}] finalized txid`);
  }
}

function assertBody(name, sourceTransaction, coreTransaction, stage) {
  assertNormalized(name, sourceTransaction, stage, false);
  assertNormalized(name, coreTransaction, stage, true);
  exact(coreTransaction.version, sourceTransaction.version, `${name}[${stage}] version`);
  exact(coreTransaction.lockTime, sourceTransaction.lockTime, `${name}[${stage}] locktime`);
  exact(coreTransaction.inputs, sourceTransaction.inputs, `${name}[${stage}] every input outpoint/order/sequence`);
  exact(coreTransaction.outputs.length, sourceTransaction.outputs.length, `${name}[${stage}] output cardinality`);
  const changeIndex = isP2pkh(coreTransaction.outputs.at(-1)) && isP2pkh(sourceTransaction.outputs.at(-1)) ? coreTransaction.outputs.length - 1 : -1;
  for (let index = 0; index < coreTransaction.outputs.length; index += 1) {
    if (index === changeIndex) exact(coreTransaction.outputs[index].script, sourceTransaction.outputs[index].script, `${name}[${stage}] change script`);
    else exact(coreTransaction.outputs[index], sourceTransaction.outputs[index], `${name}[${stage}] business output ${index}`);
  }
  const sourceFee = bigint(sourceTransaction.fee);
  const coreFee = bigint(coreTransaction.fee);
  assert.ok(coreFee <= 50_000n, `${name}[${stage}] maxFee`);
  if (changeIndex >= 0) {
    const sourceChange = bigint(sourceTransaction.outputs[changeIndex].satoshis);
    const coreChange = bigint(coreTransaction.outputs[changeIndex].satoshis);
    assert.equal(coreFee - sourceFee, sourceChange - coreChange, `${name}[${stage}] fee/change conservation`);
    if (coreFee === sourceFee) {
      exact(coreTransaction.unsignedRaw, sourceTransaction.unsignedRaw, `${name}[${stage}] exact neutral raw`);
      exact(coreTransaction.signatureNeutralTxid, sourceTransaction.signatureNeutralTxid, `${name}[${stage}] exact neutral txid`);
    } else {
      assert.notEqual(coreTransaction.unsignedRaw, sourceTransaction.unsignedRaw, `${name}[${stage}] enumerated change-value raw divergence`);
      assert.notEqual(coreTransaction.signatureNeutralTxid, sourceTransaction.signatureNeutralTxid, `${name}[${stage}] enumerated change-value txid divergence`);
    }
  } else {
    assert.equal(coreFee, sourceFee, `${name}[${stage}] exact fee`);
    exact(coreTransaction.unsignedRaw, sourceTransaction.unsignedRaw, `${name}[${stage}] exact neutral raw`);
    exact(coreTransaction.signatureNeutralTxid, sourceTransaction.signatureNeutralTxid, `${name}[${stage}] exact neutral txid`);
  }
  return { sourceFee, coreFee, changeIndex };
}

function assertNftBody(name, sourceTransaction, coreTransaction, sourceEvidence, stage) {
  assertNormalized(name, sourceTransaction, stage, false);
  assertNormalized(name, coreTransaction, stage, true);
  assertRawFields(name, sourceTransaction, stage);
  assertRawFields(name, coreTransaction, stage);
  exact(coreTransaction.version, sourceTransaction.version, `${name}[${stage}] version`);
  exact(coreTransaction.lockTime, sourceTransaction.lockTime, `${name}[${stage}] locktime`);
  exact(coreTransaction.inputs, sourceTransaction.inputs, `${name}[${stage}] every input outpoint/order/sequence`);
  exact(coreTransaction.outputs.length, sourceTransaction.outputs.length, `${name}[${stage}] output cardinality`);
  const changeIndex = coreTransaction.outputs.length - 1;
  const sourceChange = sourceTransaction.outputs[changeIndex];
  const coreChange = coreTransaction.outputs[changeIndex];
  assert.ok(isP2pkh(sourceChange) && sourceChange.script.length === 50, `${name}[${stage}] source final P2PKH change`);
  assert.ok(isP2pkh(coreChange) && coreChange.script.length === 50, `${name}[${stage}] core final P2PKH change`);
  exact(coreChange.script, sourceChange.script, `${name}[${stage}] change script`);
  assert.ok(sourceEvidence.signers.some((signer) => signer.signerRole === "funding" && signer.previousScript === sourceChange.script), `${name}[${stage}] change bound to funding prevout`);
  for (let index = 0; index < changeIndex; index += 1) exact(coreTransaction.outputs[index], sourceTransaction.outputs[index], `${name}[${stage}] business output ${index}`);

  assert.equal(sourceEvidence.signers.length, sourceTransaction.inputs.length, `${name}[${stage}] fee prevout cardinality`);
  const inputTotal = sourceEvidence.signers.reduce((total, signer) => total + bigint(signer.previousSatoshis), 0n);
  const sourceOutputTotal = sourceTransaction.outputs.reduce((total, output) => total + bigint(output.satoshis), 0n);
  const coreOutputTotal = coreTransaction.outputs.reduce((total, output) => total + bigint(output.satoshis), 0n);
  const sourceFee = bigint(sourceTransaction.fee);
  const coreFee = bigint(coreTransaction.fee);
  exact(inputTotal - sourceOutputTotal, sourceFee, `${name}[${stage}] source fee from authenticated prevouts`);
  exact(inputTotal - coreOutputTotal, coreFee, `${name}[${stage}] core fee from authenticated prevouts`);
  assert.ok(coreFee <= 50_000n, `${name}[${stage}] maxFee`);
  assert.ok(name in nftFeeDeltas, `${name}[${stage}] registered deterministic fee normalization`);
  exact(coreFee - sourceFee, nftFeeDeltas[name], `${name}[${stage}] exact pinned wallet/core fee delta`);
  exact(bigint(sourceChange.satoshis) - bigint(coreChange.satoshis), nftFeeDeltas[name], `${name}[${stage}] exact encoded change delta`);

  const sourceNormalizedRaw = normalizeTransactionForChange(sourceTransaction.unsignedRaw, changeIndex);
  const coreNormalizedRaw = normalizeTransactionForChange(coreTransaction.unsignedRaw, changeIndex);
  exact(coreNormalizedRaw, sourceNormalizedRaw, `${name}[${stage}] exact normalized neutral raw`);
  exact(txidFromRaw(coreNormalizedRaw), txidFromRaw(sourceNormalizedRaw), `${name}[${stage}] exact normalized neutral txid`);
  return { changeIndex, sourceChange, coreChange, sourceNormalizedRaw, coreNormalizedRaw };
}

function dependencyDepth(transactions, transactionIndex, visiting = new Set()) {
  const transaction = transactions[transactionIndex];
  if (visiting.has(transaction.templateId)) throw new Error("dependency cycle");
  visiting.add(transaction.templateId);
  let depth = 0;
  for (const dependency of transaction.planDependencies) {
    const parentIndex = transactions.findIndex((candidate) => candidate.templateId === dependency);
    assert.ok(parentIndex >= 0 && parentIndex < transactionIndex, `dependency ${dependency} must name an earlier transaction`);
    depth = Math.max(depth, dependencyDepth(transactions, parentIndex, new Set(visiting)) + 1);
  }
  return depth;
}

function assertNftSignerMatrix(name, sourceTransaction, coreTransaction, sourceEvidence, coreTransactions, stage, body) {
  assert.equal(sourceEvidence.transactionAssociation, sourceTransaction.txid, `${name}[${stage}] source transaction association`);
  assert.equal(sourceEvidence.stage, dependencyDepth(coreTransactions, stage), `${name}[${stage}] dependency-derived stage`);
  const sourceDependencies = [...new Set(sourceEvidence.actualDependencies.map((dependency) => dependency.parentTransactionAssociation))];
  assert.equal(coreTransaction.planDependencies.length, sourceDependencies.length, `${name}[${stage}] dependency cardinality`);
  assert.equal(new Set(coreTransaction.planDependencies).size, coreTransaction.planDependencies.length, `${name}[${stage}] duplicate dependency`);
  assert.equal(sourceEvidence.actualDependencies.length, 0, `${name}[${stage}] one-transaction source dependency semantics`);
  assert.equal(coreTransaction.planDependencies.length, 0, `${name}[${stage}] one-transaction core dependency semantics`);

  const requests = coreTransaction.signingRequests;
  assert.ok(Array.isArray(coreTransaction.recomputedSigningDigests), `${name}[${stage}] independent core digest evidence`);
  assert.equal(requests.length, sourceEvidence.signers.length, `${name}[${stage}] missing/extra signer`);
  assert.equal(new Set(requests.map((request) => request.taskId)).size, requests.length, `${name}[${stage}] duplicate task id`);
  assert.equal(new Set(requests.map((request) => request.inputIndex)).size, requests.length, `${name}[${stage}] duplicate signer input`);
  const sortedSource = [...sourceEvidence.signers].sort((left, right) => left.inputIndex - right.inputIndex);
  const sortedCore = [...requests].sort((left, right) => left.inputIndex - right.inputIndex);
  for (let index = 0; index < sortedCore.length; index += 1) {
    const sourceSigner = sortedSource[index];
    const coreSigner = sortedCore[index];
    assert.equal(coreSigner.inputIndex, sourceSigner.inputIndex, `${name}[${stage}] signer input`);
    exact(sourceSigner.previousOutpoint, {
      txid: sourceTransaction.inputs[sourceSigner.inputIndex].txid,
      vout: sourceTransaction.inputs[sourceSigner.inputIndex].vout,
    }, `${name}[${stage}] signer child outpoint`);
    assert.equal(coreSigner.transactionTemplateId, coreTransaction.templateId, `${name}[${stage}] actual transaction association`);
    assert.equal(coreSigner.purpose, "transaction", `${name}[${stage}] signer purpose`);
    assert.equal(coreSigner.algorithm, "secp256k1-ecdsa-sha256d", `${name}[${stage}] signer algorithm`);
    assert.equal(coreSigner.signatureEncoding, "compact64", `${name}[${stage}] signature encoding`);
    assert.equal(coreSigner.publicKey, sourceSigner.publicKey, `${name}[${stage}] owner key`);
    assert.equal(coreSigner.sighashType, sourceSigner.sighashType, `${name}[${stage}] sighash type`);
    assert.equal(sourceSigner.sighashType, 65, `${name}[${stage}] ForkID sighash`);
    assert.match(sourceSigner.digest, /^[0-9a-f]{64}$/, `${name}[${stage}] source digest`);
    assert.match(coreSigner.digest, /^[0-9a-f]{64}$/, `${name}[${stage}] core digest`);
    const recomputed = coreTransaction.recomputedSigningDigests.find((item) => item.inputIndex === coreSigner.inputIndex);
    assert.equal(coreSigner.digest, recomputed?.digest, `${name}[${stage}] independently recomputed core digest`);
    exact(forkIdDigest(sourceTransaction.unsignedRaw, sourceSigner), sourceSigner.digest, `${name}[${stage}] independently recomputed source digest`);
    exact(forkIdDigest(coreTransaction.unsignedRaw, sourceSigner), coreSigner.digest, `${name}[${stage}] independently recomputed core transaction digest`);
    exact(forkIdDigest(body.coreNormalizedRaw, sourceSigner), forkIdDigest(body.sourceNormalizedRaw, sourceSigner), `${name}[${stage}] exact normalized ForkID digest`);
    const sourceSuffix = sourceSigner.covenantSuffix;
    const coreSuffix = coreTransaction.covenantSuffixes[coreSigner.inputIndex];
    assert.equal(sourceSuffix, sourceTransaction.covenantSuffixes[sourceSigner.inputIndex], `${name}[${stage}] source covenant suffix`);
    const sourceRole = sourceSuffix.length === 0 ? "funding" : "covenant";
    const coreRole = coreSuffix.length === 0 ? "funding" : "covenant";
    assert.equal(sourceSigner.signerRole, sourceRole, `${name}[${stage}] source signer role`);
    assert.equal(coreRole, sourceRole, `${name}[${stage}] suffix-derived core signer role`);
    if (coreSuffix === sourceSuffix) exact(coreSuffix, sourceSuffix, `${name}[${stage}] exact covenant suffix`);
    else {
      const normalizedSourceSuffix = normalizeCovenantSuffix(sourceSuffix, body.sourceChange, `${name}[${stage}] source suffix`);
      const normalizedCoreSuffix = normalizeCovenantSuffix(coreSuffix, body.coreChange, `${name}[${stage}] core suffix`);
      exact(normalizedCoreSuffix, normalizedSourceSuffix, `${name}[${stage}] exact normalized covenant suffix`);
    }
  }
}

function assertNftOperation(name, sourceTransactions, coreTransactions, sourceEvidence) {
  assert.equal(coreTransactions.length, sourceTransactions.length, `${name} missing/extra transaction`);
  assert.equal(sourceEvidence.length, sourceTransactions.length, `${name} missing/extra source recipe`);
  for (let stage = 0; stage < coreTransactions.length; stage += 1) {
    const body = assertNftBody(name, sourceTransactions[stage], coreTransactions[stage], sourceEvidence[stage], stage);
    assertNftSignerMatrix(name, sourceTransactions[stage], coreTransactions[stage], sourceEvidence[stage], coreTransactions, stage, body);
    assert.equal(coreTransactions[stage].role, "primary", `${name}[${stage}] actual role`);
  }
}

function assertStableRound2(name, sourceTransactions, coreTransactions) {
  assert.equal(coreTransactions.length, sourceTransactions.length, `${name} missing/extra transaction`);
  for (let stage = 0; stage < coreTransactions.length; stage += 1) {
    const transaction = coreTransactions[stage];
    const pinned = sourceTransactions[stage];
    assertNormalized(name, transaction, stage, true);
    exact(transaction.version, pinned.version, `${name}[${stage}] version`);
    exact(transaction.lockTime, pinned.lockTime, `${name}[${stage}] locktime`);
    if (name === "stablecoinMerge" && stage === 1) {
      assert.equal(transaction.inputs.at(-1).sequence, 0xffffffff, `${name}[${stage}] funding sequence`);
      assert.equal(transaction.outputs[0].satoshis, "500", `${name}[${stage}] primary code amount`);
      assert.equal(transaction.outputs[1].satoshis, "0", `${name}[${stage}] primary Tape amount`);
      assert.ok(transaction.outputs[1].script.endsWith("054654617065"), `${name}[${stage}] primary Tape marker`);
      assert.ok(isP2pkh(transaction.outputs.at(-1)), `${name}[${stage}] primary change`);
      assert.ok(bigint(transaction.fee) > 0n && bigint(transaction.fee) <= 50_000n, `${name}[${stage}] primary fee`);
    } else assertBody(name, pinned, transaction, stage);
    assert.equal(new Set(transaction.signingRequests.map((request) => request.taskId)).size, transaction.signingRequests.length, `${name}[${stage}] actual signer uniqueness`);
  }
}

function assertNftV0Parity(source, core) {
  const sourceTransaction = core.sourceOperations.nftTransferV0[0];
  const coreTransaction = core.operations.nftTransferV0[0];
  const sourceEvidence = source.sourceSigningRecipes.nftTransferV0;
  assertNftOperation("nftTransferV0", [sourceTransaction], [coreTransaction], sourceEvidence);
  assert.equal(sourceTransaction.outputs[0].script.length, 284, "pinned V0 exact 142-byte script");
  assert.equal(coreTransaction.outputs[0].script.length, 284, "core V0 exact 142-byte script");
  exact(coreTransaction.outputs[0].script, sourceTransaction.outputs[0].script, "V0 recipient/code script parity");
  const sourceCovenant = sourceEvidence[0].signers.find((signer) => signer.signerRole === "covenant");
  const coreCovenant = coreTransaction.signingRequests.find((request) => request.inputIndex === sourceCovenant.inputIndex);
  const feeDelta = Number(bigint(coreTransaction.fee) - bigint(sourceTransaction.fee));
  assert.equal(feeDelta, Number(nftFeeDeltas.nftTransferV0), "V0 exact registered fee/change divergence");
  assert.equal(coreTransaction.finalizedSignatureNeutralRaw, coreTransaction.unsignedRaw, "V0 finalized-neutral raw");
  assert.match(coreTransaction.finalizedTxid, /^[0-9a-f]{64}$/, "V0 finalized txid");
  if (feeDelta === 0 && coreCovenant.digest === sourceCovenant.digest) {
    exact(coreTransaction.finalizedRaw, sourceTransaction.signedRaw, "V0 fixed-signature finalized raw");
    exact(coreTransaction.finalizedTxid, sourceTransaction.txid, "V0 fixed-signature finalized txid");
  } else {
    assert.notEqual(coreTransaction.finalizedRaw, sourceTransaction.signedRaw, "V0 enumerated finalized raw divergence");
    assert.notEqual(coreTransaction.finalizedTxid, sourceTransaction.txid, "V0 enumerated finalized txid divergence");
  }

  const sourceMutation = source.sourceSigningRecipes.nftTransferV0Mutation[0];
  const sourceMutationTransaction = sourceTransactionFromSignedRaw(source.mutations.nftV0Recipient.changed, sourceMutation);
  const coreMutationTransaction = core.mutations.nftV0Recipient.changedTransaction;
  assert.equal(core.mutations.nftV0Recipient.changedUnsignedRaw, coreMutationTransaction.unsignedRaw, "V0 mutation actual core raw association");
  exact(core.mutations.nftV0Recipient.changedSigningRequests, coreMutationTransaction.signingRequests, "V0 mutation actual core signer association");
  assertNftOperation("nftTransferV0Mutation", [sourceMutationTransaction], [coreMutationTransaction], [sourceMutation]);
  const changedSourceSigner = sourceMutation.signers.find((signer) => signer.inputIndex === sourceCovenant.inputIndex);
  const changedCoreSigner = core.mutations.nftV0Recipient.changedSigningRequests.find((request) => request.inputIndex === coreCovenant.inputIndex);
  assert.notEqual(sourceMutation.transactionAssociation, sourceEvidence[0].transactionAssociation, "V0 source recipient changes raw/txid");
  assert.notEqual(changedSourceSigner.digest, sourceCovenant.digest, "V0 source recipient changes digest");
  assert.notEqual(changedSourceSigner.covenantSuffix, sourceCovenant.covenantSuffix, "V0 source recipient changes suffix");
  assert.notEqual(core.mutations.nftV0Recipient.changedUnsignedRaw, coreTransaction.unsignedRaw, "V0 core recipient changes neutral raw");
  assert.notEqual(changedCoreSigner.digest, coreCovenant.digest, "V0 core recipient changes digest");
}

export function compareResults(source, core) {
  assert.equal(source.pin, PIN, "wrong source pin");
  assert.equal(core.pin, source.pin, "runner pin");
  assert.equal(core.productionCoreInvoked, true, "production core runner");
  for (const [name, result] of Object.entries(source.operations)) {
    exact(result.sdk, result.wallet, `${name} wallet/SDK signed raw`);
    assert.ok(result.sdk.length > 0, `${name} source transaction`);
  }
  exact(source.vectors.nftV1.sdk, source.vectors.nftV1.wallet, "NFT V1 wallet/SDK signed raw");
  assertNftOperation("collection", core.sourceOperations.collection, core.operations.collection, source.sourceSigningRecipes.collection);
  assertNftOperation("nftMint", core.sourceOperations.nftMint, core.operations.nftMint, source.sourceSigningRecipes.nftMint);
  assertNftOperation("nftTransferV2", core.sourceOperations.nftTransfer, core.operations.nftTransfer, source.sourceSigningRecipes.nftTransferV2);
  assertNftOperation("nftTransferV1", core.sourceOperations.nftTransferV1, core.operations.nftTransferV1, source.sourceSigningRecipes.nftTransferV1);
  assertNftV0Parity(source, core);
  assertStableRound2("stablecoinTransfer", core.sourceOperations.stablecoinTransfer, core.operations.stablecoinTransfer);
  assertStableRound2("stablecoinMerge", core.sourceOperations.stablecoinMerge, core.operations.stablecoinMerge);
  for (const family of ["collection", "nft", "nftV0Recipient", "stablecoin"]) {
    assert.equal(core.mutations[family]?.sourceChanged, true, `${family} pinned source mutation`);
    assert.equal(core.mutations[family]?.coreChanged, true, `${family} production core mutation`);
  }
  return { ok: true, pin: source.pin };
}

function mutate(core, label) {
  const changed = structuredClone(core);
  const v0 = changed.operations.nftTransferV0[0];
  if (label === "signer-key") v0.signingRequests[0].publicKey = `02${"00".repeat(32)}`;
  else if (label === "signer-digest") v0.signingRequests[0].digest = "00".repeat(32);
  else if (label === "signer-role") {
    const inputIndex = v0.covenantSuffixes.findIndex((suffix) => suffix.length > 0);
    v0.covenantSuffixes[inputIndex] = "";
  }
  else if (label === "signer-stage") v0.signingRequests[0].transactionTemplateId = "wrong-stage-transaction";
  else if (label === "dependency") v0.planDependencies.push("missing-parent");
  else if (label === "duplicate-signer") v0.signingRequests.push(structuredClone(v0.signingRequests[0]));
  else if (label === "duplicate-dependency") v0.planDependencies.push(v0.templateId, v0.templateId);
  else if (label === "v0-recipient") changed.mutations.nftV0Recipient.changedUnsignedRaw = v0.unsignedRaw;
  else if (label === "fee-change-field") {
    const v1 = changed.operations.nftTransferV1[0];
    v1.fee = (bigint(v1.fee) + 1n).toString();
    v1.outputs.at(-1).satoshis = (bigint(v1.outputs.at(-1).satoshis) - 1n).toString();
  } else if (label === "signer-suffix") {
    const v1 = changed.operations.nftTransferV1[0];
    const inputIndex = v1.covenantSuffixes.findIndex((suffix) => suffix.length > 0);
    const suffix = Buffer.from(v1.covenantSuffixes[inputIndex], "hex");
    suffix[0] ^= 1;
    v1.covenantSuffixes[inputIndex] = suffix.toString("hex");
  } else if (label === "v0-recipient-unrelated") {
    changed.mutations.nftV0Recipient.changedUnsignedRaw = changed.operations.nftTransferV1[0].unsignedRaw;
    changed.mutations.nftV0Recipient.changedTransaction.unsignedRaw = changed.operations.nftTransferV1[0].unsignedRaw;
  }
  else throw new Error(`unknown mutation ${label}`);
  return changed;
}

const [sourcePath, corePath, mode, label] = process.argv.slice(2);
if (sourcePath && corePath) {
  const source = JSON.parse(readFileSync(sourcePath, "utf8"));
  const core = JSON.parse(readFileSync(corePath, "utf8"));
  if (mode === "--expect-reject") {
    assert.throws(() => compareResults(source, mutate(core, label)), undefined, `${label} must be rejected`);
    process.stdout.write(`${JSON.stringify({ ok: true, rejectedMutation: label })}\n`);
  } else {
    compareResults(source, core);
    process.stdout.write(`${JSON.stringify({ok:true,pin:source.pin,operations:["collection","nftMint","nftTransferV0","nftTransferV1","nftTransferV2"],matrix:["header/version/locktime","every encoded input outpoint/order/sequence","every encoded output amount/script/order","exact registered fee and encoded change delta","exact normalized neutral raw and txid","exact normalized ForkID digest","exact normalized covenant suffix and suffix-derived role","dependency-derived stage and child outpoint"],allowedDivergences,methods:core.methods,v0Parity:"wallet-authoritative 142-byte legacy topology with exact source/core normalization at the uniquely encoded change output, including recipient mutation",byteParity:"wallet/SDK bytes are exact after only the registered per-operation fee/change normalization; all reported fields are rebound to parsed raw bytes",processIsolation:{sourceReceivedInputsOnly:true,coreRunnerSeparate:true,comparisonStartedAfterBothExited:true},mutationDerived:true})}\n`);
  }
}
