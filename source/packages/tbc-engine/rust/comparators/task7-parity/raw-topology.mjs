import { createHash } from "node:crypto";

import { ComparisonError } from "./comparison-error.mjs";

const fail = (code, message) => {
  throw new ComparisonError(code, message);
};

const sha256 = (bytes) => createHash("sha256").update(bytes).digest();

const readCompactSize = (raw, cursor, context) => {
  if (cursor.offset >= raw.length) fail("TOPOLOGY_RAW_TRUNCATED", `${context}: missing CompactSize prefix`);
  const prefix = raw[cursor.offset++];
  if (prefix < 0xfd) return prefix;
  const width = prefix === 0xfd ? 2 : prefix === 0xfe ? 4 : 8;
  if (cursor.offset + width > raw.length) fail("TOPOLOGY_RAW_TRUNCATED", `${context}: truncated CompactSize`);
  let value;
  if (width === 2) value = BigInt(raw.readUInt16LE(cursor.offset));
  else if (width === 4) value = BigInt(raw.readUInt32LE(cursor.offset));
  else value = raw.readBigUInt64LE(cursor.offset);
  cursor.offset += width;
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) fail("TOPOLOGY_RAW_RANGE", `${context}: CompactSize exceeds safe range`);
  return Number(value);
};

const take = (raw, cursor, length, context) => {
  if (length < 0 || cursor.offset + length > raw.length) fail("TOPOLOGY_RAW_TRUNCATED", `${context}: truncated field`);
  const value = raw.subarray(cursor.offset, cursor.offset + length);
  cursor.offset += length;
  return value;
};

const parseTransaction = (rawHex, context) => {
  if (typeof rawHex !== "string" || rawHex.length === 0 || rawHex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(rawHex)) {
    fail("TOPOLOGY_RAW_INVALID", `${context}: finalized transaction must be non-empty canonical hex`);
  }
  const raw = Buffer.from(rawHex, "hex");
  const cursor = { offset: 0 };
  const version = take(raw, cursor, 4, `${context}.version`);
  const inputCount = readCompactSize(raw, cursor, `${context}.inputs`);
  const inputs = [];
  for (let inputIndex = 0; inputIndex < inputCount; inputIndex += 1) {
    const hashLe = take(raw, cursor, 32, `${context}.inputs[${inputIndex}].txid`);
    const voutBytes = take(raw, cursor, 4, `${context}.inputs[${inputIndex}].vout`);
    const scriptLength = readCompactSize(raw, cursor, `${context}.inputs[${inputIndex}].scriptSig`);
    const scriptSig = take(raw, cursor, scriptLength, `${context}.inputs[${inputIndex}].scriptSig`);
    const sequence = take(raw, cursor, 4, `${context}.inputs[${inputIndex}].sequence`);
    inputs.push({
      txid: Buffer.from(hashLe).reverse().toString("hex"),
      vout: voutBytes.readUInt32LE(0),
      voutBytes,
      hashLe,
      scriptSig,
      sequence,
    });
  }
  const outputCount = readCompactSize(raw, cursor, `${context}.outputs`);
  const outputs = [];
  for (let outputIndex = 0; outputIndex < outputCount; outputIndex += 1) {
    const amount = take(raw, cursor, 8, `${context}.outputs[${outputIndex}].amount`);
    const scriptLength = readCompactSize(raw, cursor, `${context}.outputs[${outputIndex}].script`);
    const script = take(raw, cursor, scriptLength, `${context}.outputs[${outputIndex}].script`);
    outputs.push({ amount, script });
  }
  const lockTime = take(raw, cursor, 4, `${context}.lockTime`);
  if (cursor.offset !== raw.length) fail("TOPOLOGY_RAW_TRAILING_BYTES", `${context}: ${raw.length - cursor.offset} trailing byte(s)`);
  return { version, inputs, outputs, lockTime };
};

const uint32Le = (value) => {
  const bytes = Buffer.allocUnsafe(4);
  bytes.writeUInt32LE(value, 0);
  return bytes;
};

const transactionId = (transaction) => {
  // Pinned transaction.rs::tbc_txid commits to parsed consensus fields rather
  // than hashing the serialized transaction wholesale. Outpoint hashes remain
  // in wire little-endian order here; only the final digest is reversed for
  // the canonical displayed txid.
  const inputHeaders = transaction.inputs.flatMap((input) => [
    input.hashLe,
    input.voutBytes,
    input.sequence,
  ]);
  const root = Buffer.concat([
    transaction.version,
    transaction.lockTime,
    uint32Le(transaction.inputs.length),
    uint32Le(transaction.outputs.length),
    sha256(Buffer.concat(inputHeaders)),
    sha256(Buffer.concat(transaction.inputs.map((input) => sha256(input.scriptSig)))),
    sha256(Buffer.concat(transaction.outputs.map((output) => Buffer.concat([output.amount, sha256(output.script)])))),
  ]);
  return Buffer.from(sha256(sha256(root))).reverse().toString("hex");
};

const finalizedRaw = (transaction, context) => {
  const candidates = [transaction?.finalizedRaw, transaction?.rawTransaction].filter((value) => value !== undefined);
  if (candidates.length !== 1) fail("TOPOLOGY_RAW_SOURCE", `${context}: expected exactly one finalized raw transaction field`);
  return candidates[0];
};

const manifestParentRaws = (inputManifest) => {
  const parents = inputManifest?.externalParents;
  if (!Array.isArray(parents)) fail("TOPOLOGY_EXTERNAL_MANIFEST", "input manifest must declare externalParents as an array");
  return parents.map((parent, index) => {
    if (typeof parent === "object" && parent !== null && typeof parent.rawTransaction !== "string") {
      fail("TOPOLOGY_EXTERNAL_METADATA_ONLY", `inputManifest.externalParents[${index}] lacks raw transaction bytes`);
    }
    const raw = typeof parent === "string" ? parent : parent?.rawTransaction;
    const parsed = parseTransaction(raw, `inputManifest.externalParents[${index}]`);
    const txid = transactionId(parsed);
    if (typeof parent === "object" && parent !== null && parent.txid !== undefined && parent.txid !== txid) {
      fail(
        "TOPOLOGY_EXTERNAL_TXID_MISMATCH",
        `inputManifest.externalParents[${index}].txid ${parent.txid} does not match raw bytes ${txid}`,
      );
    }
    return { parsed, txid, index };
  });
};

const uniqueTxidPositions = (entries, code, label) => {
  const positions = new Map();
  for (const entry of entries) {
    const position = entry.position ?? entry.index;
    if (positions.has(entry.txid)) fail(code, `${label}: duplicate txid ${entry.txid} at ${positions.get(entry.txid)} and ${position}`);
    positions.set(entry.txid, position);
  }
  return positions;
};

const compareDeclaredDependencies = (transactions, declaredTransactions, edges) => {
  if (!Array.isArray(declaredTransactions) || declaredTransactions.length !== transactions.length) {
    fail("DECLARED_DEPENDENCY_COUNT", "production-core declared transaction count does not match finalized transactions");
  }
  const ids = new Map();
  for (let position = 0; position < declaredTransactions.length; position += 1) {
    const declared = declaredTransactions[position];
    if (typeof declared?.id !== "string" || declared.id.length === 0) fail("DECLARED_DEPENDENCY_ID", `declaredTransactions[${position}].id is missing`);
    if (ids.has(declared.id)) fail("DECLARED_DEPENDENCY_DUPLICATE_ID", `duplicate declared transaction id ${declared.id}`);
    if (declared.role !== transactions[position].role) fail("DECLARED_DEPENDENCY_ROLE", `declared transaction ${declared.id} role does not match finalized role`);
    ids.set(declared.id, position);
  }
  for (let childPosition = 0; childPosition < declaredTransactions.length; childPosition += 1) {
    const declared = declaredTransactions[childPosition];
    const dependencies = declared.dependsOn ?? [];
    if (!Array.isArray(dependencies)) fail("DECLARED_DEPENDENCY_SHAPE", `${declared.id}.dependsOn must be an array`);
    if (new Set(dependencies).size !== dependencies.length) fail("DECLARED_DEPENDENCY_DUPLICATE_EDGE", `${declared.id}.dependsOn contains duplicate edges`);
    for (const dependency of dependencies) {
      if (dependency === declared.id) fail("DECLARED_DEPENDENCY_SELF", `${declared.id} depends on itself`);
      if (!ids.has(dependency)) fail("DECLARED_DEPENDENCY_MISSING", `${declared.id} depends on missing transaction ${dependency}`);
      if (ids.get(dependency) >= childPosition) fail("DECLARED_DEPENDENCY_FORWARD", `${declared.id} depends on non-earlier transaction ${dependency}`);
    }
    const expected = [...new Set(edges
      .filter((edge) => edge.childPosition === childPosition)
      .map((edge) => declaredTransactions[edge.parentPosition].id))];
    if (expected.length !== dependencies.length || expected.some((id, index) => dependencies[index] !== id)) {
      fail("DECLARED_DEPENDENCY_MISMATCH", `${declared.id}.dependsOn ${JSON.stringify(dependencies)} does not match raw parents ${JSON.stringify(expected)}`);
    }
  }
};

export const deriveRawTopology = ({ producer, scenario, transactions, inputManifest, declaredTransactions }) => {
  if (!Array.isArray(transactions) || transactions.length === 0) fail("TOPOLOGY_TRANSACTION_COUNT", `${scenario}: finalized transactions must be non-empty`);
  const parsedTransactions = transactions.map((transaction, position) => {
    if (typeof transaction?.role !== "string" || transaction.role.length === 0) fail("TOPOLOGY_ROLE_MISSING", `${scenario}.transactions[${position}]: role is missing`);
    const parsed = parseTransaction(finalizedRaw(transaction, `${scenario}.transactions[${position}]`), `${scenario}.transactions[${position}]`);
    return { position, role: transaction.role, parsed, txid: transactionId(parsed) };
  });
  const internalPositions = uniqueTxidPositions(parsedTransactions, "TOPOLOGY_INTERNAL_TXID_DUPLICATE", scenario);
  const externalParents = manifestParentRaws(inputManifest);
  const externalPositions = uniqueTxidPositions(externalParents, "TOPOLOGY_EXTERNAL_TXID_DUPLICATE", `${scenario}.externalParents`);
  for (const txid of internalPositions.keys()) {
    if (externalPositions.has(txid)) fail("TOPOLOGY_PARENT_DOMAIN_OVERLAP", `${scenario}: txid ${txid} is both internal and external`);
  }

  const edges = [];
  const externalInputs = [];
  const usedExternalParents = new Set();
  for (const child of parsedTransactions) {
    for (let childInputIndex = 0; childInputIndex < child.parsed.inputs.length; childInputIndex += 1) {
      const input = child.parsed.inputs[childInputIndex];
      if (internalPositions.has(input.txid)) {
        const parentPosition = internalPositions.get(input.txid);
        if (parentPosition === child.position) fail("TOPOLOGY_SELF_EDGE", `${scenario}: transaction ${child.position} input ${childInputIndex} spends itself`);
        if (parentPosition > child.position) fail("TOPOLOGY_FORWARD_EDGE", `${scenario}: transaction ${child.position} input ${childInputIndex} spends later transaction ${parentPosition}`);
        const parent = parsedTransactions[parentPosition];
        if (input.vout >= parent.parsed.outputs.length) fail("TOPOLOGY_PARENT_VOUT", `${scenario}: internal parent ${parentPosition} has no output ${input.vout}`);
        edges.push({
          childPosition: child.position,
          childRole: child.role,
          childInputIndex,
          parentPosition,
          parentRole: parent.role,
          parentVout: input.vout,
        });
      } else {
        if (!externalPositions.has(input.txid)) fail("TOPOLOGY_EXTERNAL_PARENT_MISSING", `${scenario}: input ${child.position}:${childInputIndex} parent ${input.txid} is absent from immutable input manifest`);
        const external = externalParents[externalPositions.get(input.txid)];
        if (input.vout >= external.parsed.outputs.length) fail("TOPOLOGY_EXTERNAL_PARENT_VOUT", `${scenario}: external parent ${input.txid} has no output ${input.vout}`);
        usedExternalParents.add(external.index);
        externalInputs.push({
          childPosition: child.position,
          childRole: child.role,
          childInputIndex,
          manifestParentIndex: external.index,
          parentVout: input.vout,
        });
      }
    }
  }
  const unusedExternal = externalParents.find(({ index }) => !usedExternalParents.has(index));
  if (unusedExternal) {
    fail("TOPOLOGY_EXTERNAL_PARENT_UNUSED", `${scenario}: external parent ${unusedExternal.txid} is not consumed`);
  }

  if (producer === "production-core") compareDeclaredDependencies(parsedTransactions, declaredTransactions, edges);
  return {
    producer,
    scenario,
    transactionCount: parsedTransactions.length,
    roles: parsedTransactions.map(({ role }) => role),
    edges,
    externalInputs,
  };
};

const edgeIdentityWithoutVout = (edge) => JSON.stringify([
  edge.childPosition,
  edge.childRole,
  edge.childInputIndex,
  edge.parentPosition,
  edge.parentRole,
]);

const edgeIdentity = (edge) => JSON.stringify([
  edge.childPosition,
  edge.childRole,
  edge.childInputIndex,
  edge.parentPosition,
  edge.parentRole,
  edge.parentVout,
]);

export const compareRawTopologies = (source, core) => {
  if (source.transactionCount !== core.transactionCount || JSON.stringify(source.roles) !== JSON.stringify(core.roles)) {
    fail("TOPOLOGY_ROLE_ORDER", `${source.scenario}: ordered transaction roles differ`);
  }
  const sourceByInput = new Map(source.edges.map((edge) => [edgeIdentityWithoutVout(edge), edge]));
  const coreByInput = new Map(core.edges.map((edge) => [edgeIdentityWithoutVout(edge), edge]));
  for (const [identity, sourceEdge] of sourceByInput) {
    const coreEdge = coreByInput.get(identity);
    if (coreEdge && coreEdge.parentVout !== sourceEdge.parentVout) fail("TOPOLOGY_PARENT_VOUT", `${source.scenario}: parent vout differs for ${identity}`);
  }
  const sourceMembership = source.edges.map(edgeIdentity).sort();
  const coreMembership = core.edges.map(edgeIdentity).sort();
  if (JSON.stringify(sourceMembership) === JSON.stringify(coreMembership)) {
    if (JSON.stringify(source.edges.map(edgeIdentity)) !== JSON.stringify(core.edges.map(edgeIdentity))) {
      fail("TOPOLOGY_EDGE_ORDER", `${source.scenario}: canonical internal edge order differs`);
    }
  } else {
    const sourceSet = new Set(sourceMembership);
    const coreSet = new Set(coreMembership);
    const missing = sourceMembership.filter((edge) => !coreSet.has(edge));
    const extra = coreMembership.filter((edge) => !sourceSet.has(edge));
    if (missing.length > 0) fail("TOPOLOGY_EDGE_MISSING", `${source.scenario}: missing internal edge ${missing[0]}`);
    if (extra.length > 0) fail("TOPOLOGY_EDGE_EXTRA", `${source.scenario}: extra internal edge ${extra[0]}`);
  }
  return { ok: true, transactionCount: source.transactionCount, internalEdgeCount: source.edges.length };
};
