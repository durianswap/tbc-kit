import { secp256k1 } from "@noble/curves/secp256k1.js";
import { ripemd160 } from "@noble/hashes/legacy.js";
import { sha256 } from "@noble/hashes/sha2.js";

const HEX = /^(?:[0-9a-fA-F]{2})+$/u;
const HASH32 = /^[0-9a-f]{64}$/u;
const MAX_TRANSACTION_BYTES = 4 * 1024 * 1024;
const TBC_VERSION = 10;
const SIGHASH_ALL_FORKID = 0x41;

export class ControlledSignatureVerificationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ControlledSignatureVerificationError";
  }
}

function fail(message) {
  throw new ControlledSignatureVerificationError(message);
}

function record(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`Invalid ${label}`);
  }
  return value;
}

function exactKeys(value, expected, label) {
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (keys.length !== wanted.length || keys.some((key, index) => key !== wanted[index])) {
    fail(`Invalid ${label}`);
  }
}

function hexBytes(value, label, maximumBytes = MAX_TRANSACTION_BYTES) {
  if (typeof value !== "string" || !HEX.test(value) || value.length / 2 > maximumBytes) {
    fail(`Invalid ${label}`);
  }
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function bytesHex(bytes) {
  let result = "";
  for (const byte of bytes) result += byte.toString(16).padStart(2, "0");
  return result;
}

function equalBytes(left, right) {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function concat(...chunks) {
  const size = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function reverse(bytes) {
  return Uint8Array.from(bytes).reverse();
}

function u32(value) {
  const result = new Uint8Array(4);
  new DataView(result.buffer).setUint32(0, value, true);
  return result;
}

function u64(value) {
  if (value < 0n || value > 0xffff_ffff_ffff_ffffn) fail("Invalid atomic amount");
  const result = new Uint8Array(8);
  new DataView(result.buffer).setBigUint64(0, value, true);
  return result;
}

function varint(value) {
  if (!Number.isSafeInteger(value) || value < 0) fail("Invalid compact size");
  if (value < 0xfd) return Uint8Array.of(value);
  if (value <= 0xffff) {
    const result = new Uint8Array(3);
    result[0] = 0xfd;
    new DataView(result.buffer).setUint16(1, value, true);
    return result;
  }
  if (value <= 0xffff_ffff) return concat(Uint8Array.of(0xfe), u32(value));
  fail("Compact size exceeds controlled verifier limit");
}

function sha256d(bytes) {
  return sha256(sha256(bytes));
}

class Reader {
  constructor(bytes) {
    this.bytes = bytes;
    this.offset = 0;
  }

  take(size, label) {
    if (!Number.isSafeInteger(size) || size < 0 || this.offset + size > this.bytes.length) {
      fail(`Truncated ${label}`);
    }
    const result = this.bytes.slice(this.offset, this.offset + size);
    this.offset += size;
    return result;
  }

  byte(label) {
    return this.take(1, label)[0];
  }

  u32(label) {
    const bytes = this.take(4, label);
    return new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
  }

  u64(label) {
    const bytes = this.take(8, label);
    return new DataView(bytes.buffer, bytes.byteOffset, 8).getBigUint64(0, true);
  }

  compact(label) {
    const prefix = this.byte(label);
    if (prefix < 0xfd) return prefix;
    if (prefix === 0xfd) {
      const bytes = this.take(2, label);
      const value = new DataView(bytes.buffer, bytes.byteOffset, 2).getUint16(0, true);
      if (value < 0xfd) fail(`Non-canonical ${label}`);
      return value;
    }
    if (prefix === 0xfe) {
      const value = this.u32(label);
      if (value <= 0xffff) fail(`Non-canonical ${label}`);
      return value;
    }
    fail(`${label} exceeds controlled verifier limit`);
  }
}

function parseTransaction(raw, label) {
  const rawBytes = hexBytes(raw, label);
  const reader = new Reader(rawBytes);
  const version = reader.u32(`${label} version`);
  const inputCount = reader.compact(`${label} input count`);
  if (version !== TBC_VERSION || inputCount !== 1) fail(`Unsupported ${label} boundary`);
  const inputs = [];
  for (let index = 0; index < inputCount; index += 1) {
    const prevTxidLE = reader.take(32, `${label} prevout`);
    const outputIndex = reader.u32(`${label} output index`);
    const scriptLength = reader.compact(`${label} input script length`);
    const script = reader.take(scriptLength, `${label} input script`);
    const sequence = reader.u32(`${label} sequence`);
    inputs.push(Object.freeze({ prevTxidLE, outputIndex, script, sequence }));
  }
  const outputCount = reader.compact(`${label} output count`);
  if (outputCount < 1 || outputCount > 64) fail(`Unsupported ${label} output boundary`);
  const outputs = [];
  for (let index = 0; index < outputCount; index += 1) {
    const satoshis = reader.u64(`${label} output amount`);
    const scriptLength = reader.compact(`${label} output script length`);
    const script = reader.take(scriptLength, `${label} output script`);
    outputs.push(Object.freeze({ satoshis, script }));
  }
  const lockTime = reader.u32(`${label} lock time`);
  if (reader.offset !== rawBytes.length) fail(`Trailing ${label} bytes`);
  return Object.freeze({ rawBytes, version, inputs: Object.freeze(inputs), outputs: Object.freeze(outputs), lockTime });
}

function transactionBodyMatches(unsigned, signed) {
  if (
    unsigned.version !== signed.version ||
    unsigned.lockTime !== signed.lockTime ||
    unsigned.inputs.length !== signed.inputs.length ||
    unsigned.outputs.length !== signed.outputs.length
  ) return false;
  for (let index = 0; index < unsigned.inputs.length; index += 1) {
    const left = unsigned.inputs[index];
    const right = signed.inputs[index];
    if (
      !equalBytes(left.prevTxidLE, right.prevTxidLE) ||
      left.outputIndex !== right.outputIndex ||
      left.sequence !== right.sequence
    ) return false;
  }
  return unsigned.outputs.every((output, index) => {
    const candidate = signed.outputs[index];
    return output.satoshis === candidate.satoshis && equalBytes(output.script, candidate.script);
  });
}

function outputBytes(output) {
  return concat(u64(output.satoshis), varint(output.script.length), output.script);
}

// Exact TBC v10 transaction identity from tbc-lib-js 1.0.31 newTxHeader().
function transactionId(transaction) {
  const inputIdentity = transaction.inputs.map((input) =>
    concat(input.prevTxidLE, u32(input.outputIndex), u32(input.sequence)));
  const inputScripts = transaction.inputs.map((input) => sha256(input.script));
  const outputIdentity = transaction.outputs.map((output) => concat(u64(output.satoshis), sha256(output.script)));
  const header = concat(
    u32(transaction.version),
    u32(transaction.lockTime),
    u32(transaction.inputs.length),
    u32(transaction.outputs.length),
    sha256(concat(...inputIdentity)),
    sha256(concat(...inputScripts)),
    sha256(concat(...outputIdentity)),
  );
  return bytesHex(reverse(sha256d(header)));
}

function forkIdDigest(transaction, inputIndex, scriptCode, satoshis) {
  if (inputIndex !== 0 || transaction.inputs.length !== 1) fail("Unsupported signing input boundary");
  const input = transaction.inputs[inputIndex];
  const prevouts = sha256d(concat(...transaction.inputs.map((item) =>
    concat(item.prevTxidLE, u32(item.outputIndex)))));
  const sequences = sha256d(concat(...transaction.inputs.map((item) => u32(item.sequence))));
  const outputs = sha256d(concat(...transaction.outputs.map(outputBytes)));
  const preimage = concat(
    u32(transaction.version),
    prevouts,
    sequences,
    input.prevTxidLE,
    u32(input.outputIndex),
    varint(scriptCode.length),
    scriptCode,
    u64(satoshis),
    u32(input.sequence),
    outputs,
    u32(transaction.lockTime),
    u32(SIGHASH_ALL_FORKID),
  );
  return sha256d(preimage);
}

function atomic(value, label) {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(value)) fail(`Invalid ${label}`);
  const result = BigInt(value);
  if (result > 0xffff_ffff_ffff_ffffn) fail(`Invalid ${label}`);
  return result;
}

function uint32(value, label) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) fail(`Invalid ${label}`);
  return value;
}

function publicKeyBytes(value) {
  const bytes = hexBytes(value, "public key", 33);
  if (bytes.length !== 33 || (bytes[0] !== 0x02 && bytes[0] !== 0x03)) fail("Invalid public key");
  try {
    secp256k1.Point.fromHex(bytes);
  } catch {
    fail("Invalid public key");
  }
  return bytes;
}

function p2pkhScript(publicKey) {
  return concat(
    Uint8Array.of(0x76, 0xa9, 0x14),
    ripemd160(sha256(publicKey)),
    Uint8Array.of(0x88, 0xac),
  );
}

function signatureBytes(value, label) {
  const bytes = hexBytes(value, label, 73);
  if (bytes.length < 9 || bytes.length > 73 || bytes.at(-1) !== SIGHASH_ALL_FORKID) {
    fail(`Invalid ${label}`);
  }
  return bytes;
}

function verifySignature(transaction, inputIndex, scriptCode, satoshis, signatureWithType, publicKey, label) {
  const signature = signatureWithType.slice(0, -1);
  let parsed;
  try {
    parsed = secp256k1.Signature.fromBytes(signature, "der");
  } catch {
    fail(`Invalid ${label}`);
  }
  if (parsed.hasHighS()) fail(`Invalid ${label}`);
  const digest = forkIdDigest(transaction, inputIndex, scriptCode, satoshis);
  if (!secp256k1.verify(signature, digest, publicKey, { format: "der", lowS: true, prehash: false })) {
    fail(`Invalid ${label}`);
  }
}

function p2pkhUnlock(script, publicKey, label) {
  if (script.length < 2) fail(`Invalid ${label}`);
  const signatureLength = script[0];
  if (signatureLength < 9 || signatureLength > 73 || 1 + signatureLength >= script.length) {
    fail(`Invalid ${label}`);
  }
  const signature = script.slice(1, 1 + signatureLength);
  const publicKeyLength = script[1 + signatureLength];
  const keyStart = 2 + signatureLength;
  if (publicKeyLength !== 33 || keyStart + publicKeyLength !== script.length) fail(`Invalid ${label}`);
  const pushedPublicKey = script.slice(keyStart);
  if (!equalBytes(pushedPublicKey, publicKey)) fail(`Invalid ${label}`);
  return signatureBytes(bytesHex(signature), label);
}

function transactionRows(result, expectedCount, associated) {
  const bundle = record(result, "reviewed result");
  if (bundle.version !== "1.0" || !Array.isArray(bundle.transactions) || bundle.transactions.length !== expectedCount) {
    fail("Invalid reviewed result");
  }
  return bundle.transactions.map((candidate, index) => {
    const row = record(candidate, "reviewed transaction result");
    const expectedId = `tx-${String(index + 1)}`;
    const expectedRole = associated && index === 0 ? "prerequisite" : "primary";
    const expectedDependencies = associated && index === 1 ? ["tx-1"] : [];
    if (
      row.id !== expectedId ||
      row.role !== expectedRole ||
      !Array.isArray(row.dependsOn) ||
      row.dependsOn.length !== expectedDependencies.length ||
      row.dependsOn.some((value, dependencyIndex) => value !== expectedDependencies[dependencyIndex]) ||
      typeof row.txid !== "string" || !HASH32.test(row.txid) ||
      typeof row.rawTransaction !== "string"
    ) fail("Invalid reviewed transaction result");
    const transaction = parseTransaction(row.rawTransaction, `result transaction ${String(index)}`);
    if (transactionId(transaction) !== row.txid) fail("Invalid reviewed transaction identity");
    return transaction;
  });
}

function verifyRaw(payload, result, publicKey) {
  exactKeys(payload, ["format", "transactions"], "controlled raw request");
  if (!Array.isArray(payload.transactions) || payload.transactions.length !== 1) {
    fail("Unsupported controlled raw request boundary");
  }
  const requested = record(payload.transactions[0], "controlled raw transaction");
  exactKeys(requested, ["rawTransaction", "inputs"], "controlled raw transaction");
  if (!Array.isArray(requested.inputs) || requested.inputs.length !== 1) {
    fail("Unsupported controlled raw input boundary");
  }
  const input = record(requested.inputs[0], "controlled raw input");
  exactKeys(input, ["satoshis", "scriptPubKey"], "controlled raw input");
  const unsigned = parseTransaction(requested.rawTransaction, "controlled raw transaction");
  if (unsigned.inputs[0].script.length !== 0) fail("Controlled raw transaction must be unsigned");
  const rows = transactionRows(result, 1, false);
  if (rows[0].rawBytes.length !== unsigned.rawBytes.length || !equalBytes(rows[0].rawBytes, unsigned.rawBytes)) {
    fail("Raw result transaction changed");
  }
  if (!Array.isArray(result.detachedSignatures) || result.detachedSignatures.length !== 1 ||
      !Array.isArray(result.detachedSignatures[0]) || result.detachedSignatures[0].length !== 1) {
    fail("Invalid raw detached signature matrix");
  }
  const signature = signatureBytes(result.detachedSignatures[0][0], "raw detached signature");
  verifySignature(
    unsigned,
    0,
    hexBytes(input.scriptPubKey, "raw input script"),
    atomic(input.satoshis, "raw input amount"),
    signature,
    publicKey,
    "raw detached signature",
  );
  return Object.freeze({
    valid: true,
    kind: "raw",
    transactionCount: 1,
    verifiedInputCount: 1,
    dependencyCount: 0,
    outputsMatch: true,
  });
}

function verifyAssociated(payload, result, publicKey) {
  exactKeys(payload, ["format", "sourceTransaction", "sourceInputs", "children"], "controlled associated request");
  if (!Array.isArray(payload.sourceInputs) || payload.sourceInputs.length !== 1 ||
      !Array.isArray(payload.children) || payload.children.length !== 1) {
    fail("Unsupported controlled associated request boundary");
  }
  const sourceInput = record(payload.sourceInputs[0], "controlled associated source input");
  exactKeys(sourceInput, ["txid", "outputIndex", "satoshis", "scriptPubKey", "signingProfile"], "controlled associated source input");
  if (sourceInput.signingProfile !== "p2pkh" || typeof sourceInput.txid !== "string" || !HASH32.test(sourceInput.txid)) {
    fail("Invalid controlled associated source input");
  }
  const child = record(payload.children[0], "controlled associated child");
  exactKeys(child, ["inputs", "outputs"], "controlled associated child");
  if (!Array.isArray(child.inputs) || child.inputs.length !== 1 ||
      !Array.isArray(child.outputs) || child.outputs.length !== 1) {
    fail("Unsupported controlled associated child boundary");
  }
  const childInput = record(child.inputs[0], "controlled associated child input");
  exactKeys(childInput, ["outputIndex", "signingProfile"], "controlled associated child input");
  if (childInput.signingProfile !== "p2pkh") fail("Invalid controlled associated child input");
  const approvedOutput = record(child.outputs[0], "controlled associated child output");
  exactKeys(approvedOutput, ["satoshis", "scriptPubKey"], "controlled associated child output");
  if (Object.hasOwn(result, "detachedSignatures")) fail("Associated result must not contain detached signatures");

  const unsignedSource = parseTransaction(payload.sourceTransaction, "controlled associated source");
  if (unsignedSource.inputs[0].script.length !== 0) fail("Controlled associated source must be unsigned");
  if (
    bytesHex(reverse(unsignedSource.inputs[0].prevTxidLE)) !== sourceInput.txid ||
    unsignedSource.inputs[0].outputIndex !== uint32(sourceInput.outputIndex, "associated source output index")
  ) fail("Associated source outpoint mismatch");

  const rows = transactionRows(result, 2, true);
  const signedSource = rows[0];
  const signedChild = rows[1];
  if (!transactionBodyMatches(unsignedSource, signedSource)) fail("Associated source body changed");

  const parentTxid = transactionId(signedSource);
  if (
    bytesHex(reverse(signedChild.inputs[0].prevTxidLE)) !== parentTxid ||
    signedChild.inputs[0].outputIndex !== uint32(childInput.outputIndex, "associated child output index") ||
    signedChild.lockTime !== 0 ||
    signedChild.inputs[0].sequence !== 0xffff_ffff ||
    signedChild.outputs.length !== 1
  ) fail("Associated child dependency mismatch");

  const expectedPublicKeyScript = p2pkhScript(publicKey);
  const sourceScript = hexBytes(sourceInput.scriptPubKey, "associated source script");
  if (!equalBytes(sourceScript, expectedPublicKeyScript)) fail("Associated source is not the controlled account P2PKH");
  const childPrevout = signedSource.outputs[signedChild.inputs[0].outputIndex];
  if (childPrevout === undefined || !equalBytes(childPrevout.script, expectedPublicKeyScript)) {
    fail("Associated child prevout is not the controlled account P2PKH");
  }
  const outputScript = hexBytes(approvedOutput.scriptPubKey, "associated approved output script");
  const outputAmount = atomic(approvedOutput.satoshis, "associated approved output amount");
  if (!equalBytes(outputScript, expectedPublicKeyScript) ||
      signedChild.outputs[0].satoshis !== outputAmount ||
      !equalBytes(signedChild.outputs[0].script, outputScript)) {
    fail("Associated approved output mismatch");
  }

  const sourceSignature = p2pkhUnlock(signedSource.inputs[0].script, publicKey, "associated source signature");
  verifySignature(
    signedSource,
    0,
    sourceScript,
    atomic(sourceInput.satoshis, "associated source amount"),
    sourceSignature,
    publicKey,
    "associated source signature",
  );
  const childSignature = p2pkhUnlock(signedChild.inputs[0].script, publicKey, "associated child signature");
  verifySignature(
    signedChild,
    0,
    childPrevout.script,
    childPrevout.satoshis,
    childSignature,
    publicKey,
    "associated child signature",
  );

  return Object.freeze({
    valid: true,
    kind: "associated",
    transactionCount: 2,
    verifiedInputCount: 2,
    dependencyCount: 1,
    outputsMatch: true,
  });
}

/**
 * Independent, fail-closed verifier for this acceptance's one-input raw and
 * two-transaction P2PKH associated fixtures. It returns only safe booleans and
 * counts; raw transactions, signatures and digests never leave this call.
 */
export function verifyControlledReviewedResult({ request, result, publicKey }) {
  try {
    const reviewedRequest = record(request, "controlled reviewed request");
    exactKeys(reviewedRequest, ["payload"], "controlled reviewed request");
    const payload = record(reviewedRequest.payload, "controlled reviewed payload");
    const key = publicKeyBytes(publicKey);
    if (payload.format === "raw") return verifyRaw(payload, record(result, "reviewed result"), key);
    if (payload.format === "associated") return verifyAssociated(payload, record(result, "reviewed result"), key);
    fail("Unsupported controlled reviewed format");
  } catch (error) {
    if (error instanceof ControlledSignatureVerificationError) throw error;
    throw new ControlledSignatureVerificationError("Controlled signature verification failed");
  }
}
