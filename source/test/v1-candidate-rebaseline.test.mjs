import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const readJson = async (relative) =>
  JSON.parse(await readFile(new URL(relative, root), "utf8"));

const PREPARED_METHODS = Object.freeze({
  tbc_signPreparedTransaction: {
    permission: "tbc_signTransaction",
    params: "prepared-transaction.schema.json#/$defs/preparedTransactionRequest",
    result: "transaction-request.schema.json#/$defs/signedTransactionBundle",
    operationKind: "transaction",
    effect: "signed-transaction",
  },
  tbc_sendPreparedTransaction: {
    permission: "tbc_sendTransaction",
    params: "prepared-transaction.schema.json#/$defs/preparedTransactionRequest",
    result: "transaction-request.schema.json#/$defs/submittedTransactionBundle",
    operationKind: "transaction",
    effect: "broadcast",
  },
  tbc_signPreparedWorkflow: {
    permission: "tbc_signWorkflow",
    params: "prepared-workflow.schema.json#/$defs/request",
    result: "workflow.schema.json#/$defs/result",
    operationKind: "workflow",
    effect: "signed-workflow",
  },
});

test("v1 Candidate exposes one exact 22-method Provider baseline", async () => {
  const [{ methods }, { events }, manifest] = await Promise.all([
    readJson("registry/methods.json"),
    readJson("registry/events.json"),
    readJson("release/tws-v1-candidate.json"),
  ]);
  assert.equal(methods.length, 22);
  assert.equal(new Set(methods.map(({ name }) => name)).size, 22);
  assert.equal(events.length, 6);
  assert.equal(manifest.providerMethodCount, 22);
  assert.equal(manifest.providerEventCount, 6);
  assert.equal(manifest.compatibilityBaseline, "legacy-window-turing-only");
});

test("Prepared methods are mandatory first-class methods without new permission categories", async () => {
  const [{ methods }, permissions] = await Promise.all([
    readJson("registry/methods.json"),
    readJson("schemas/permissions.schema.json"),
  ]);
  const permissionNames = new Set(permissions.$defs.permissionName.enum);
  for (const [name, expected] of Object.entries(PREPARED_METHODS)) {
    const method = methods.find((candidate) => candidate.name === name);
    assert.ok(method, `${name} is missing`);
    assert.equal(method.params.kind, "named");
    assert.equal(method.params.schema, expected.params);
    assert.equal(method.result.schema, expected.result);
    assert.equal(method.operationKind, expected.operationKind);
    assert.equal(method.effect, expected.effect);
    assert.deepEqual(method.authorization.permissions, [
      "tbc_accounts",
      expected.permission,
    ]);
    assert.ok(permissionNames.has(expected.permission));
    assert.ok(!permissionNames.has(name));
  }
});

test("Prepared transaction dependencies use parsed input bindings, never byte offsets", async () => {
  const schema = await readJson("schemas/prepared-transaction.schema.json");
  assert.deepEqual(
    schema.$defs.deferredInput.required,
    ["inputIndex", "sourceTransactionId", "sourceOutputIndex"],
  );
  assert.equal(schema.$defs.deferredInput.additionalProperties, false);
  const serialized = JSON.stringify(schema);
  assert.ok(!serialized.includes("byteOffset"));
  assert.ok(!serialized.includes("jsonPointer"));
  assert.ok(!serialized.includes("privateKey"));
  assert.ok(!serialized.includes("wif"));
});

test("Prepared methods share the existing transaction and workflow state paths", async () => {
  const { methodPaths } = await readJson("registry/operation-states.json");
  const expected = {
    "sign-transaction": ["tbc_signTransaction", "tbc_signPreparedTransaction"],
    "send-transaction": ["tbc_sendTransaction", "tbc_sendPreparedTransaction"],
    "sign-workflow": ["tbc_signWorkflow", "tbc_signPreparedWorkflow"],
  };
  for (const [category, methods] of Object.entries(expected)) {
    const path = methodPaths.find((candidate) => candidate.category === category);
    assert.deepEqual(path?.methods, methods);
  }
});

test("proposal validation has stable structured execution errors", async () => {
  const errors = await readJson("registry/errors.json");
  const names = new Set(errors.executionErrors.map(({ name }) => name));
  assert.deepEqual(
    [...Object.keys(PREPARED_METHODS)].filter((name) => names.has(name)),
    [],
  );
  for (const name of [
    "INVALID_PROPOSAL",
    "PROPOSAL_HASH_MISMATCH",
    "PROPOSAL_SEMANTIC_MISMATCH",
    "PROPOSAL_STALE",
  ]) {
    assert.ok(names.has(name), `${name} is missing`);
  }
});
