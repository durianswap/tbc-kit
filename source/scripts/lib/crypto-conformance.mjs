import { createHash } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1";
import { canonicalize } from "./canonical-json.mjs";
import { materializeCheckpoints } from "./lifecycle-conformance.mjs";
import { deriveCommitId } from "./provider-session-conformance.mjs";
import { readJson } from "./repository.mjs";
import { deriveCallId, deriveOperationId } from "./replay-conformance.mjs";

const NUL = Buffer.from([0]);
const DETERMINISTIC_ID = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const TBC_CHAIN_ID = /^tbc:[a-z0-9_-]{1,32}$/;
const TXID = /^[0-9a-f]{64}$/;

function utf8(value) {
  return Buffer.from(value, "utf8");
}

function assertOperationId(value) {
  if (typeof value !== "string" || !DETERMINISTIC_ID.test(value)) {
    throw new Error("operationId must encode exactly 32 bytes as base64url");
  }
}

export function derivePermissionId(input) {
  assertOperationId(input?.operationId);
  if (typeof input.chainId !== "string" || !TBC_CHAIN_ID.test(input.chainId)) {
    throw new Error("chainId must be a TBC Chain ID");
  }
  if (typeof input.parentCapability !== "string" || input.parentCapability.length === 0) {
    throw new Error("parentCapability must be a non-empty capability name");
  }
  if (!Number.isSafeInteger(input.ordinal) || input.ordinal < 0) {
    throw new Error("ordinal must be a non-negative safe integer");
  }
  return createHash("sha256").update(Buffer.concat([
    utf8("TWS/1.0/permission"),
    NUL,
    utf8(input.operationId),
    NUL,
    utf8(input.chainId),
    NUL,
    utf8(input.parentCapability),
    NUL,
    utf8(String(input.ordinal)),
  ])).digest("base64url");
}

export function deriveBroadcastIdempotencyKey(input) {
  assertOperationId(input?.operationId);
  if (typeof input.txid !== "string" || !TXID.test(input.txid)) {
    throw new Error("txid must be lowercase 32-byte hex");
  }
  return createHash("sha256").update(Buffer.concat([
    utf8("TWS/1.0/broadcast"),
    NUL,
    utf8(input.operationId),
    NUL,
    Buffer.from(input.txid, "hex"),
  ])).digest("base64url");
}

function sha256(value) {
  return createHash("sha256").update(value).digest();
}

function sha256d(value) {
  return sha256(sha256(value));
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: ${actual} != ${expected}`);
  }
}

function decodeJsonPointerSegment(segment) {
  return segment.replaceAll("~1", "/").replaceAll("~0", "~");
}

function resolvePointer(root, pointer) {
  if (!pointer.startsWith("/")) throw new Error(`Invalid JSON Pointer: ${pointer}`);
  return pointer
    .slice(1)
    .split("/")
    .map(decodeJsonPointerSegment)
    .reduce((value, key) => value[key], root);
}

export function resolveHashKnownAnswerSource(root, vector) {
  const sourceDocument = readJson(root, `test-vectors/${vector.source.file}`);
  if (vector.source.pointer) {
    return structuredClone(resolvePointer(sourceDocument, vector.source.pointer));
  }
  if (vector.source.checkpointId) {
    const checkpoint = materializeCheckpoints(sourceDocument).find(
      ({ id }) => id === vector.source.checkpointId,
    )?.checkpoint;
    if (!checkpoint) {
      throw new Error(`Unknown hash KAT checkpoint: ${vector.source.checkpointId}`);
    }
    return structuredClone(checkpoint.payload);
  }
  throw new Error(`Hash KAT ${vector.name} has no source selector`);
}

function evaluateHashBinding(binding, input) {
  if (binding.canonicalization === "rfc8785-jcs-utf8") {
    return sha256(Buffer.from(canonicalize(input), "utf8")).toString("hex");
  }
  if (binding.canonicalization === "raw-bytes") {
    return sha256(Buffer.from(input, "hex")).toString("hex");
  }
  if (binding.canonicalization === "identity-hash32") return input;
  throw new Error(`Unknown hash canonicalization: ${binding.canonicalization}`);
}

function compactSize(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`Invalid CompactSize value: ${value}`);
  }
  if (value < 0xfd) return Buffer.from([value]);
  if (value <= 0xffff) {
    const encoded = Buffer.alloc(3);
    encoded[0] = 0xfd;
    encoded.writeUInt16LE(value, 1);
    return encoded;
  }
  if (value <= 0xffffffff) {
    const encoded = Buffer.alloc(5);
    encoded[0] = 0xfe;
    encoded.writeUInt32LE(value, 1);
    return encoded;
  }
  throw new RangeError(`CompactSize exceeds uint32: ${value}`);
}

class TransactionReader {
  constructor(buffer) {
    this.buffer = buffer;
    this.offset = 0;
  }

  readBytes(length) {
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new RangeError(`Invalid read length: ${length}`);
    }
    const end = this.offset + length;
    if (end > this.buffer.length) {
      throw new Error("Truncated transaction");
    }
    const value = this.buffer.subarray(this.offset, end);
    this.offset = end;
    return value;
  }

  readUInt32LEBytes() {
    return this.readBytes(4);
  }

  readCompactSize() {
    const prefix = this.readBytes(1)[0];
    if (prefix < 0xfd) return prefix;
    if (prefix === 0xfd) return this.readBytes(2).readUInt16LE(0);
    if (prefix === 0xfe) return this.readBytes(4).readUInt32LE(0);
    const value = this.readBytes(8).readBigUInt64LE(0);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new RangeError("CompactSize exceeds safe integer range");
    }
    return Number(value);
  }

  assertFinished() {
    if (this.offset !== this.buffer.length) {
      throw new Error(`Transaction has ${this.buffer.length - this.offset} trailing bytes`);
    }
  }
}

function int32LE(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0x7fffffff) {
    throw new RangeError(`Count exceeds int32: ${value}`);
  }
  const encoded = Buffer.alloc(4);
  encoded.writeInt32LE(value);
  return encoded;
}

function parseTransaction(rawHex) {
  if (!/^(?:[0-9a-f]{2})+$/.test(rawHex)) {
    throw new TypeError("Raw transaction must be lowercase even-length hex");
  }
  const reader = new TransactionReader(Buffer.from(rawHex, "hex"));
  const version = reader.readUInt32LEBytes();
  const inputCount = reader.readCompactSize();
  const inputs = [];
  for (let index = 0; index < inputCount; index += 1) {
    const previousTransaction = reader.readBytes(32);
    const outputIndex = reader.readUInt32LEBytes();
    const scriptLength = reader.readCompactSize();
    const script = reader.readBytes(scriptLength);
    const sequence = reader.readUInt32LEBytes();
    inputs.push({ previousTransaction, outputIndex, script, sequence });
  }
  const outputCount = reader.readCompactSize();
  const outputs = [];
  for (let index = 0; index < outputCount; index += 1) {
    const satoshis = reader.readBytes(8);
    const scriptLength = reader.readCompactSize();
    const script = reader.readBytes(scriptLength);
    outputs.push({ satoshis, script });
  }
  const lockTime = reader.readUInt32LEBytes();
  reader.assertFinished();
  return { version, inputCount, inputs, outputCount, outputs, lockTime };
}

export function tbcVersion10Txid(rawHex) {
  const transaction = parseTransaction(rawHex);
  if (transaction.version.readUInt32LE(0) < 10) {
    throw new Error("TBC transaction-header txid requires version >= 10");
  }
  const inputHeaders = Buffer.concat(
    transaction.inputs.map((input) =>
      Buffer.concat([
        input.previousTransaction,
        input.outputIndex,
        input.sequence,
      ]),
    ),
  );
  const inputScriptHashes = Buffer.concat(
    transaction.inputs.map((input) => sha256(input.script)),
  );
  const outputHeaders = Buffer.concat(
    transaction.outputs.map((output) =>
      Buffer.concat([output.satoshis, sha256(output.script)]),
    ),
  );
  const header = Buffer.concat([
    transaction.version,
    transaction.lockTime,
    int32LE(transaction.inputCount),
    int32LE(transaction.outputCount),
    sha256(inputHeaders),
    sha256(inputScriptHashes),
    sha256(outputHeaders),
  ]);
  return Buffer.from(sha256d(header)).reverse().toString("hex");
}

function verifyRecoverableSignature(vector, digest) {
  const recoverable = Buffer.from(vector.result.signature, "base64");
  if (recoverable.length !== 65) {
    throw new Error(`${vector.id} recoverable signature is not 65 bytes`);
  }
  const header = recoverable[0];
  if (header < 27 || header > 34) {
    throw new Error(`${vector.id} recovery header is outside 27..34`);
  }
  const headerFlags = header - 27;
  const recovery = headerFlags & 3;
  const compressed = (headerFlags & 4) !== 0;
  const signature = secp256k1.Signature.fromCompact(
    recoverable.subarray(1),
  ).addRecoveryBit(recovery);
  if (
    !secp256k1.verify(signature, digest, vector.result.publicKey, {
      prehash: false,
      lowS: true,
    })
  ) {
    throw new Error(`${vector.id} signature does not verify`);
  }
  const recoveredKey = signature
    .recoverPublicKey(digest)
    .toBytes(compressed);
  assertEqual(
    Buffer.from(recoveredKey).toString("hex"),
    vector.result.publicKey,
    `${vector.id} recovered public key`,
  );
}

export function runCryptoConformance(root) {
  const signing = readJson(root, "test-vectors/signing.json");
  let signingCount = 0;
  for (const vector of signing.vectors) {
    const canonical = canonicalize(vector.result.envelope);
    assertEqual(canonical, vector.result.canonical, `${vector.id} canonical`);
    const magic = Buffer.from(vector.magic, "utf8");
    const message = vector.result.envelope.message;
    const body = vector.result.envelope.type === "tbc.message"
      ? message.encoding === "utf8"
        ? Buffer.from(message.data, "utf8")
        : Buffer.from(message.data, message.encoding)
      : Buffer.from(canonical, "utf8");
    const payload = Buffer.concat([
      compactSize(magic.length),
      magic,
      compactSize(body.length),
      body,
    ]);
    assertEqual(payload.toString("hex"), vector.payloadHex, `${vector.id} payload`);
    assertEqual(
      payload.toString("base64"),
      vector.result.signingPayload,
      `${vector.id} signing payload`,
    );
    const digest = sha256d(payload);
    assertEqual(digest.toString("hex"), vector.result.digest, `${vector.id} digest`);
    verifyRecoverableSignature(vector, digest);
    signingCount += 1;
  }

  const integration = readJson(root, "test-vectors/integration.json");
  const canonicalTransfer = integration.canonicalTransfer;
  const fixture = integration.fixture;
  const hashBindings = [
    [canonicalTransfer.request, canonicalTransfer.requestHash, "request"],
    [
      canonicalTransfer.snapshot.payload,
      canonicalTransfer.snapshot.snapshotHash,
      "snapshot",
    ],
    [
      canonicalTransfer.policy.payload,
      canonicalTransfer.policy.policyHash,
      "policy",
    ],
    [canonicalTransfer.plan.payload, canonicalTransfer.plan.planHash, "plan"],
    [
      canonicalTransfer.binding.payload,
      canonicalTransfer.binding.bindingHash,
      "binding",
    ],
  ];
  for (const [payload, expectedHash, label] of hashBindings) {
    assertEqual(
      sha256(Buffer.from(canonicalize(payload), "utf8")).toString("hex"),
      expectedHash,
      `${label} hash`,
    );
  }

  const hashRegistry = readJson(root, "registry/hash-bindings.json");
  const bindingByName = new Map(
    hashRegistry.bindings.map((binding) => [binding.name, binding]),
  );
  if (
    integration.hashKnownAnswers.length !== hashRegistry.bindings.length ||
    new Set(integration.hashKnownAnswers.map(({ name }) => name)).size !==
      hashRegistry.bindings.length
  ) {
    throw new Error("HASH_KAT_COVERAGE_MISMATCH");
  }
  for (const vector of integration.hashKnownAnswers) {
    const binding = bindingByName.get(vector.name);
    if (!binding) throw new Error(`HASH_KAT_UNKNOWN_BINDING: ${vector.name}`);
    assertEqual(
      evaluateHashBinding(
        binding,
        resolveHashKnownAnswerSource(root, vector),
      ),
      vector.expected,
      `${vector.name} known answer`,
    );
  }

  const template = canonicalTransfer.plan.payload.transactions[0];
  const signingTask = canonicalTransfer.plan.payload.signingTasks[0];
  assertEqual(
    sha256(Buffer.from(template.unsignedTransaction, "hex")).toString("hex"),
    template.templateHash,
    "template hash",
  );
  assertEqual(
    tbcVersion10Txid(fixture.parentTransaction),
    fixture.parentTxid,
    "parent TBC v10 txid",
  );
  const sighashDigest = sha256d(Buffer.from(fixture.sighashPreimage, "hex"));
  assertEqual(
    sighashDigest.toString("hex"),
    fixture.sighashDigest,
    "sighash digest",
  );
  assertEqual(signingTask.digest, fixture.sighashDigest, "signing task digest");
  if (signingTask.sighashType !== 0x41) {
    throw new Error(`Expected sighash type 0x41, received ${signingTask.sighashType}`);
  }

  const privateKey = "01".padStart(64, "0");
  const signature = secp256k1.sign(sighashDigest, privateKey, {
    prehash: false,
    lowS: true,
  });
  const compactSignature = signature.toCompactHex();
  assertEqual(compactSignature, fixture.signatureCompact64, "fixture compact64");
  assertEqual(
    compactSignature,
    canonicalTransfer.signature.signature,
    "Signer result compact64",
  );
  if (signature.hasHighS()) throw new Error("Fixture signature is high-S");
  if (
    !secp256k1.verify(signature, sighashDigest, fixture.publicKey, {
      prehash: false,
      lowS: true,
    })
  ) {
    throw new Error("Fixture signature does not verify");
  }

  const derWithSighash = Buffer.concat([
    Buffer.from(signature.toDERRawBytes()),
    Buffer.from([signingTask.sighashType]),
  ]);
  assertEqual(
    derWithSighash.toString("hex"),
    fixture.signatureDerWithSighash,
    "DER signature with sighash",
  );
  const publicKey = Buffer.from(fixture.publicKey, "hex");
  const scriptSig = Buffer.concat([
    Buffer.from([derWithSighash.length]),
    derWithSighash,
    Buffer.from([publicKey.length]),
    publicKey,
  ]);
  const unsigned = Buffer.from(template.unsignedTransaction, "hex");
  if (unsigned[41] !== 0) {
    throw new Error("Canonical unsigned transaction input script is not empty");
  }
  const finalRaw = Buffer.concat([
    unsigned.subarray(0, 41),
    compactSize(scriptSig.length),
    scriptSig,
    unsigned.subarray(42),
  ]).toString("hex");
  const finalized = canonicalTransfer.bundle.transactions[0];
  assertEqual(finalRaw, finalized.rawTransaction, "final raw transaction");
  assertEqual(
    tbcVersion10Txid(finalRaw),
    finalized.txid,
    "final TBC v10 txid",
  );

  const workflow = readJson(root, "test-vectors/workflow.json");
  let workflowDerivationCount = 0;
  for (const vector of workflow.vectors) {
    const actualRequestHash = sha256(
      Buffer.from(canonicalize(vector.request), "utf8"),
    ).toString("hex");
    assertEqual(
      actualRequestHash,
      vector.plan.payload.requestHash,
      `${vector.id} workflow request hash`,
    );
    const actualPlanHash = sha256(
      Buffer.from(canonicalize(vector.plan.payload), "utf8"),
    ).toString("hex");
    assertEqual(
      actualPlanHash,
      vector.plan.workflowPlanHash,
      `${vector.id} workflow plan hash`,
    );
    const canonical = canonicalize(vector.derivation.resolvedEnvelope);
    assertEqual(
      canonical,
      vector.derivation.canonical,
      `${vector.id} deferred typed data canonical`,
    );
    const magic = Buffer.from("TBC Signed Typed Data:\n", "utf8");
    const body = Buffer.from(canonical, "utf8");
    const digest = sha256d(
      Buffer.concat([
        compactSize(magic.length),
        magic,
        compactSize(body.length),
        body,
      ]),
    ).toString("hex");
    assertEqual(
      digest,
      vector.derivation.digest,
      `${vector.id} deferred typed data digest`,
    );
    assertEqual(
      digest,
      vector.derivation.concreteTask.digest,
      `${vector.id} concrete task digest`,
    );
    workflowDerivationCount += 1;
  }

  const replay = readJson(root, "test-vectors/port-replay.json");
  assertEqual(
    deriveOperationId(replay.ids.operation.input),
    replay.ids.operation.expected,
    "operationId known answer",
  );
  assertEqual(
    deriveCallId(replay.ids.call.input),
    replay.ids.call.expected,
    "callId known answer",
  );
  const provider = readJson(root, "test-vectors/provider.json").providerSessions;
  assertEqual(
    deriveCommitId(provider.commitId.input),
    provider.switchA.commitId,
    "commitId known answer",
  );

  const identifiers = readJson(root, "test-vectors/identifiers.json");
  assertEqual(
    derivePermissionId(identifiers.permission.input),
    identifiers.permission.expected,
    "permissionId known answer",
  );
  assertEqual(
    derivePermissionId(identifiers.permissionSecondary.input),
    identifiers.permissionSecondary.expected,
    "secondary permissionId known answer",
  );
  assertEqual(
    deriveBroadcastIdempotencyKey(identifiers.broadcast.input),
    identifiers.broadcast.expected,
    "broadcast idempotency key known answer",
  );
  const permissions = readJson(root, "test-vectors/permissions.json");
  assertEqual(
    permissions.proposal.payload.changes[0].permissions[0].id,
    identifiers.permission.expected,
    "permission proposal primary id",
  );
  assertEqual(
    permissions.proposal.payload.changes[1].permissions[0].id,
    identifiers.permissionSecondary.expected,
    "permission proposal secondary id",
  );
  assertEqual(
    integration.portData.broadcastSubmitParams.idempotencyKey,
    identifiers.broadcast.expected,
    "broadcast submit idempotency key",
  );

  const lifecycle = readJson(root, "test-vectors/checkpoints.json");
  const checkpoints = materializeCheckpoints(lifecycle);
  for (const { id, checkpoint } of checkpoints) {
    assertEqual(
      sha256(Buffer.from(canonicalize(checkpoint.payload), "utf8")).toString("hex"),
      checkpoint.checkpointHash,
      `${id} checkpoint hash`,
    );
  }

  return {
    signing: signingCount,
    integrationHashes: hashBindings.length,
    templates: 1,
    signatures: 1,
    txids: 2,
    workflowDerivations: workflowDerivationCount,
    hashKnownAnswers: integration.hashKnownAnswers.length,
    deterministicIds: 5,
    checkpointHashes: checkpoints.length,
  };
}
