import assert from "node:assert/strict";
import test from "node:test";
import {
  listFiles,
  readJson,
  repositoryRoot,
} from "../scripts/lib/repository.mjs";

test("finds the canonical protocol asset roots from the script location", () => {
  const root = repositoryRoot(import.meta.url);
  assert.deepEqual(
    listFiles(root, "schemas", ".json").map((file) => file.relativePath),
    [
      "schemas/common.schema.json",
      "schemas/conformance-manifest.schema.json",
      "schemas/error-registry.schema.json",
      "schemas/event-registry.schema.json",
      "schemas/hash-binding-registry.schema.json",
      "schemas/integration-port-registry.schema.json",
      "schemas/integration.schema.json",
      "schemas/method-registry.schema.json",
      "schemas/network-registry.schema.json",
      "schemas/operation-state-registry.schema.json",
      "schemas/permissions.schema.json",
      "schemas/prepared-transaction.schema.json",
      "schemas/prepared-workflow.schema.json",
      "schemas/provider.schema.json",
      "schemas/reviewed-transaction.schema.json",
      "schemas/signing.schema.json",
      "schemas/transaction-request.schema.json",
      "schemas/wallet-actions.schema.json",
      "schemas/workflow.schema.json",
    ],
  );
  assert.equal(
    readJson(root, "registry/integration-ports.json").version,
    "1.0.0",
  );
});
