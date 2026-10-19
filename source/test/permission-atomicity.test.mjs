import assert from "node:assert/strict";
import test from "node:test";
import { readJson, repositoryRoot } from "../scripts/lib/repository.mjs";
import { validatePermissionStoreChange } from "../scripts/lib/semantic-conformance.mjs";

const root = repositoryRoot(import.meta.url);
const vectors = readJson(root, "test-vectors/permissions.json");

function operation(registry, name) {
  return registry.ports
    .flatMap((port) => port.operations)
    .find((candidate) => candidate.name === name);
}

function caveat(permission, type) {
  return permission.caveats.find((candidate) => candidate.type === type);
}

test("uses one atomic batch without adding a Host Port operation", () => {
  const registry = readJson(root, "registry/integration-ports.json");

  assert.equal(registry.ports.length, 11);
  assert.equal(
    registry.ports.flatMap((port) => port.operations).length,
    15,
  );
  assert.deepEqual(operation(registry, "permissionStore.commit").semantics, {
    replay: "exact-response-by-callId",
    atomicity: "all-or-none",
    conflict: "no-write",
  });
});

test("sorts unique batch scopes and returns the same scopes", () => {
  const changes = vectors.commit.params.changes;
  const scopeKeys = changes.map(
    (change) => `${change.scope.origin}\u0000${change.scope.chainId}`,
  );

  assert.deepEqual(scopeKeys, [...scopeKeys].sort());
  assert.equal(new Set(scopeKeys).size, scopeKeys.length);
  assert.deepEqual(
    vectors.commit.result.revisions.map((entry) => entry.scope),
    changes.map((entry) => entry.scope),
  );
});

test("keeps every stored permission local to its scope", () => {
  for (const change of vectors.commit.params.changes) {
    for (const permission of change.permissions) {
      assert.deepEqual(caveat(permission, "restrictChains").value, [
        change.scope.chainId,
      ]);
      for (const accountId of caveat(permission, "restrictAccounts").value) {
        assert.ok(accountId.startsWith(`${change.scope.chainId}:`));
      }
    }
  }
});

test("binds proposal, preview, approval and commit to identical chains", () => {
  const proposalChains = vectors.proposal.payload.changes.map(
    (change) => change.scope.chainId,
  );

  assert.deepEqual(vectors.bindingChainIds, proposalChains);
  assert.deepEqual(vectors.previewChainIds, proposalChains);
  assert.deepEqual(
    vectors.commit.params.changes.map((change) => change.scope.chainId),
    proposalChains,
  );
});

test("previews exact grants without exposing opaque Permission ids", () => {
  const preview = readJson(root, "test-vectors/approval.json").previews.find(
    (candidate) => candidate.operationKind === "permission",
  );

  assert.deepEqual(
    preview.granted.map((grant) => grant.chainId),
    vectors.previewChainIds,
  );
  assert.ok(preview.granted.every((grant) => !("id" in grant)));
});

test("revokes every origin scope in one disconnect batch", () => {
  assert.deepEqual(
    vectors.disconnectCommit.params.changes.map((change) => change.scope),
    vectors.commit.params.changes.map((change) => change.scope),
  );
  assert.ok(
    vectors.disconnectCommit.params.changes.every(
      (change) => change.permissions.length === 0,
    ),
  );
});

test("rejects an account caveat from another chain", () => {
  const failure = vectors.semanticFailures.find(
    (vector) => vector.id === "cross-chain-account-caveat",
  );

  assert.throws(
    () => validatePermissionStoreChange(failure.change),
    new RegExp(failure.expectedViolation),
  );
});
