import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";

import {
  materializeCheckpoints,
  materializeTransitions,
} from "../../../scripts/lib/lifecycle-conformance.mjs";
import * as core from "../dist/esm/index.js";

const rootUrl = new URL("../../../", import.meta.url);
const readJson = async (path) =>
  JSON.parse(await readFile(new URL(path, rootUrl), "utf8"));

test("snapshot confirmations may be absent but explicit counts retain lexical validation and distinct hashes", async () => {
  const fixture = (await readJson("test-vectors/integration.json")).canonicalTransfer;
  const snapshot = structuredClone(fixture.snapshot);
  assert.ok(snapshot?.payload?.utxos?.length, "canonical snapshot fixture");
  delete snapshot.payload.utxos[0].confirmations;
  snapshot.snapshotHash = core.hashCanonical(snapshot.payload);
  core.assertValidTws("chainDataResolveResult", snapshot);
  const absentHash = snapshot.snapshotHash;
  snapshot.payload.utxos[0].confirmations = "0";
  snapshot.snapshotHash = core.hashCanonical(snapshot.payload);
  core.assertValidTws("chainDataResolveResult", snapshot);
  assert.notEqual(snapshot.snapshotHash, absentHash);
  // common.uint32String leaves the numeric upper bound to Engine semantics.
  for (const count of [null, "", "00", "-1", 0]) {
    snapshot.payload.utxos[0].confirmations = count;
    assert.throws(() => core.assertValidTws("chainDataResolveResult", snapshot));
  }
});

function resolvePointer(root, pointer) {
  return pointer
    .slice(1)
    .split("/")
    .reduce((value, key) => value[key.replaceAll("~1", "/").replaceAll("~0", "~")], root);
}

function mutate(value, mutation) {
  const clone = structuredClone(value);
  const segments = mutation.path.slice(1).split("/");
  const key = segments.pop();
  const parent = segments.reduce((current, segment) => current[segment], clone);
  if (mutation.operation === "delete") delete parent[key];
  else parent[key] = structuredClone(mutation.value);
  return clone;
}

async function referenceAjv() {
  const schemaNames = [
    "common.schema.json",
    "conformance-manifest.schema.json",
    "error-registry.schema.json",
    "event-registry.schema.json",
    "hash-binding-registry.schema.json",
    "integration-port-registry.schema.json",
    "integration.schema.json",
    "method-registry.schema.json",
    "network-registry.schema.json",
    "operation-state-registry.schema.json",
    "permissions.schema.json",
    "prepared-transaction.schema.json",
    "provider.schema.json",
    "reviewed-transaction.schema.json",
    "signing.schema.json",
    "transaction-request.schema.json",
    "workflow.schema.json",
  ];
  const schemas = await Promise.all(
    schemaNames.map(async (name) => [name, await readJson(`schemas/${name}`)]),
  );
  const ids = new Map(schemas.map(([name, schema]) => [name, schema.$id]));
  const ajv = new Ajv2020({ strict: true, allErrors: true, validateFormats: true });
  ajv.addFormat("uri", (value) => {
    try {
      new URL(value);
      return true;
    } catch {
      return false;
    }
  });
  ajv.addFormat("date-time", /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/);
  for (const [, schema] of schemas) ajv.addSchema(schema);
  return (reference, value) => {
    const [name, fragment = ""] = reference.split("#");
    const validator = ajv.getSchema(`${ids.get(name)}${fragment ? `#${fragment}` : ""}`);
    assert.ok(validator, reference);
    return validator(value);
  };
}

test("validator parity covers all frozen Core inputs, checkpoints, and transitions", async () => {
  const [lifecycle, provider, replay, invalid] = await Promise.all([
    readJson("test-vectors/checkpoints.json"),
    readJson("test-vectors/provider.json"),
    readJson("test-vectors/port-replay.json"),
    readJson("test-vectors/invalid.json"),
  ]);
  const checkpoints = materializeCheckpoints(lifecycle);
  const byId = new Map(checkpoints.map((entry) => [entry.id, entry.checkpoint]));
  const transitions = materializeTransitions(lifecycle, checkpoints);
  const referenceValid = await referenceAjv();

  const positive = [
    [
      "startInput",
      "integration.schema.json#/$defs/startInput",
      {
        version: "1.0",
        release: lifecycle.fixture.basePayload.release,
        request: provider.concurrentRequests[0],
        currentContext: lifecycle.fixture.basePayload.context,
        currentSession: provider.providerSessions.sessionA,
      },
    ],
    [
      "resumeInput",
      "integration.schema.json#/$defs/resumeInput",
      {
        version: "1.0",
        checkpoint: byId.get("initializing"),
        response: replay.exactReplays.find((entry) => entry.id === "clock-response")
          .firstResponse,
        currentContext: lifecycle.fixture.basePayload.context,
        currentSession: provider.providerSessions.sessionA,
      },
    ],
    [
      "commitAckInput",
      "integration.schema.json#/$defs/commitAckInput",
      {
        version: "1.0",
        checkpoint: byId.get("committing"),
        acknowledgment: provider.providerSessions.commitAck,
        currentContext: lifecycle.fixture.basePayload.context,
        currentSession: {
          version: "1.0",
          scope: provider.providerSessions.sessionA.scope,
          state: provider.providerSessions.switchA.payload.target,
        },
      },
    ],
    [
      "cancelInput",
      "integration.schema.json#/$defs/cancelInput",
      {
        version: "1.0",
        checkpoint: byId.get("cancelled"),
        reason: "REQUEST_ABORTED",
        currentContext: lifecycle.fixture.basePayload.context,
        currentSession: provider.providerSessions.sessionA,
      },
    ],
  ];

  for (const [name, reference, value] of positive) {
    assert.equal(referenceValid(reference, value), true, reference);
    assert.equal(core.isValidTws(name, value), true, name);
    assert.doesNotThrow(() => core.assertValidTws(name, value));
  }
  for (const checkpoint of checkpoints.map((entry) => entry.checkpoint)) {
    assert.equal(core.isValidTws("operationCheckpoint", checkpoint), true);
  }
  for (const { transition } of transitions) {
    assert.equal(core.isValidTws("coreTransition", transition), true);
  }

  const selectedInvalid = invalid.vectors.filter((vector) =>
    [
      "integration.schema.json#/$defs/startInput",
      "integration.schema.json#/$defs/operationCheckpoint",
      "integration.schema.json#/$defs/coreTransition",
    ].includes(vector.schema),
  );
  for (const vector of selectedInvalid) {
    let value = vector.instance;
    if (vector.checkpointId) value = byId.get(vector.checkpointId);
    if (vector.transitionId) {
      value = transitions.find((entry) => entry.id === vector.transitionId).transition;
    }
    if (vector.mutation) value = mutate(value, vector.mutation);
    const name = vector.schema.endsWith("/startInput")
      ? "startInput"
      : vector.schema.endsWith("/operationCheckpoint")
        ? "operationCheckpoint"
        : "coreTransition";
    assert.equal(referenceValid(vector.schema, value), false, vector.id);
    assert.equal(core.isValidTws(name, value), false, vector.id);
    assert.throws(
      () => core.assertValidTws(name, value),
      (error) =>
        error instanceof core.TwsValidationError &&
        error.code === "TWS_SCHEMA_INVALID" &&
        error.validator === name &&
        error.issues.length > 0,
      vector.id,
    );
  }
});

test("validator parity validates each of the eleven Port result unions", async () => {
  const integration = await readJson("test-vectors/integration.json");
  for (const example of integration.portExamples) {
    const result = resolvePointer(integration, example.resultPointer);
    assert.doesNotThrow(() => core.assertPortResult(example.operation, result));
    if (example.operation === "reviewedTransaction.review") {
      const missingPolicy = structuredClone(result);
      delete missingPolicy.payload.policyMaterial;
      assert.throws(() => core.assertPortResult(example.operation, missingPolicy), core.TwsValidationError);
    }
    assert.throws(
      () => core.assertPortResult(example.operation, { ...result, unexpected: true }),
      core.TwsValidationError,
      example.operation,
    );
  }
  assert.throws(
    () => core.assertPortResult("providerSession.load", {}),
    /unknown TWS Port operation/,
  );
});

test("chain-data UTXO classification covers Pool planner inputs", async () => {
  const integration = await readJson("test-vectors/integration.json");
  const example = integration.portExamples.find(
    ({ operation }) => operation === "chainData.resolve",
  );
  const baseline = resolvePointer(integration, example.resultPointer);

  for (const classification of ["pool-ft", "pool-source"]) {
    const result = structuredClone(baseline);
    result.payload.utxos[0].classification = classification;
    assert.doesNotThrow(() =>
      core.assertValidTws("chainDataResolveResult", result),
    );
  }

  const invalid = structuredClone(baseline);
  invalid.payload.utxos[0].classification = "pool-internal";
  assert.throws(() => core.assertValidTws("chainDataResolveResult", invalid));
});

test("approval preview preserves explicit Pool contract flow semantics", () => {
  const preview = {
    operationKind: "transaction",
    assetFlows: [{ kind: "pool", direction: "contract", amount: "0" }],
    totalFee: "0",
    transactionCount: 1,
    warnings: [],
    irreversible: true,
  };
  assert.doesNotThrow(() => core.assertValidTws("approvalPreview", preview));

  const invalid = structuredClone(preview);
  invalid.assetFlows[0].direction = "internal";
  assert.throws(() => core.assertValidTws("approvalPreview", invalid));
});

test("approval previews accept only the current unversioned signing schemes", () => {
  const message = {
    operationKind: "message",
    scheme: "tbc-message",
    message: { encoding: "utf8", data: "Approve login" },
    digest: "88".repeat(32),
    warnings: [],
  };
  const typedData = {
    operationKind: "typedData",
    scheme: "tbc-typed-data",
    domain: {
      name: "DurianSwap Order",
      version: "1",
      chainId: "tbc:mainnet",
    },
    types: { Order: [{ name: "amount", type: "uint256" }] },
    primaryType: "Order",
    message: { amount: "1" },
    digest: "aa".repeat(32),
    warnings: [],
  };

  assert.doesNotThrow(() => core.assertValidTws("approvalPreview", message));
  assert.doesNotThrow(() => core.assertValidTws("approvalPreview", typedData));
  assert.throws(() => core.assertValidTws("approvalPreview", {
    ...message,
    scheme: "tbc-message-v1",
  }));
  assert.throws(() => core.assertValidTws("approvalPreview", {
    ...typedData,
    scheme: "tbc-typed-data-v1",
  }));
});

test("generated validators are CSP-safe and the runtime bundle has no Ajv import", async () => {
  const generated = await readFile(
    new URL("../src/generated/validators.ts", import.meta.url),
    "utf8",
  );
  const runtime = await readFile(new URL("../dist/esm/index.js", import.meta.url), "utf8");

  assert.doesNotMatch(generated, /new Function|eval\s*\(/);
  assert.doesNotMatch(runtime, /new Function|eval\s*\(/);
  assert.doesNotMatch(runtime, /^\s*import[^;\n]*["']ajv\//m);
  assert.doesNotMatch(
    runtime,
    /^\s*(?:const|let|var)[^=\n]*=\s*require\(["']ajv\//m,
  );
});
