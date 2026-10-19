import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { canonicalize } from "../scripts/lib/canonical-json.mjs";
import { readJson, repositoryRoot } from "../scripts/lib/repository.mjs";

const root = repositoryRoot(import.meta.url);

function bindingHash(payload) {
  return createHash("sha256")
    .update(Buffer.from(canonicalize(payload), "utf8"))
    .digest("hex");
}

test("keeps the approval method and operation kind mapping exact", () => {
  const methods = readJson(root, "registry/methods.json").methods;
  const actual = Object.fromEntries(
    methods
      .filter((method) => method.operationKind !== null)
      .map((method) => [method.name, method.operationKind]),
  );

  assert.deepEqual(actual, {
    tbc_requestAccounts: "permission",
    tbc_switchChain: "switchChain",
    tbc_signMessage: "message",
    tbc_signTypedData: "typedData",
    tbc_signTransaction: "transaction",
    tbc_signPreparedTransaction: "transaction",
    tbc_sendTransaction: "transaction",
    tbc_sendPreparedTransaction: "transaction",
    tbc_signReviewedTransaction: "transaction",
    tbc_encrypt: "crypto",
    tbc_decrypt: "crypto",
    tbc_signWorkflow: "workflow",
    tbc_signPreparedWorkflow: "workflow",
    tbc_sendWorkflow: "workflow",
    tbc_sendPreparedWorkflow: "workflow",
    wallet_requestPermissions: "permission",
  });
});

test("distinguishes sign-only and send approval bytes", () => {
  const bindings = readJson(root, "test-vectors/approval.json").bindings;
  const sign = bindings.find((vector) => vector.method === "tbc_signTransaction");
  const send = bindings.find((vector) => vector.method === "tbc_sendTransaction");

  assert.equal(sign.binding.payload.operationHash, send.binding.payload.operationHash);
  assert.notEqual(sign.binding.bindingHash, send.binding.bindingHash);
  assert.equal(sign.binding.bindingHash, bindingHash(sign.binding.payload));
  assert.equal(send.binding.bindingHash, bindingHash(send.binding.payload));
});

test("uses chainIds only for permission approval", () => {
  const bindings = readJson(root, "test-vectors/approval.json").bindings;

  for (const { binding } of bindings) {
    if (binding.payload.operationKind === "permission") {
      assert.ok(Array.isArray(binding.payload.chainIds));
      assert.ok(!("chainId" in binding.payload));
    } else {
      assert.equal(typeof binding.payload.chainId, "string");
      assert.ok(!("chainIds" in binding.payload));
    }
  }
});

test("provides one strict preview vector for every operation kind", () => {
  const previews = readJson(root, "test-vectors/approval.json").previews;

  assert.deepEqual(
    previews.map((preview) => preview.operationKind).sort(),
    ["message", "permission", "switchChain", "transaction", "typedData", "workflow"],
  );
});

test("registers operationHash as an identity binding over an existing hash", () => {
  const operationHash = readJson(root, "registry/hash-bindings.json").bindings.find(
    (binding) => binding.name === "operationHash",
  );

  assert.equal(operationHash.inputSchema, "common.schema.json#/$defs/hash32");
  assert.equal(operationHash.canonicalization, "identity-hash32");
});
