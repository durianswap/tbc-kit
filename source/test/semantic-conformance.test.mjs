import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { cp, rm, writeFile } from "node:fs/promises";
import { repositoryRoot } from "../scripts/lib/repository.mjs";
import {
  findForbiddenFields,
  normalizeForbiddenFieldName,
  runSemanticConformance,
} from "../scripts/lib/semantic-conformance.mjs";

const root = repositoryRoot(import.meta.url);

async function semanticCopy(context, prefix) {
  const copyRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
  context.after(() => rm(copyRoot, { recursive: true, force: true }));
  for (const directory of ["schemas", "registry", "test-vectors", "standards"]) {
    await cp(path.join(root, directory), path.join(copyRoot, directory), {
      recursive: true,
    });
  }
  return copyRoot;
}

async function mutateJson(copyRoot, relativePath, mutation) {
  const absolutePath = path.join(copyRoot, relativePath);
  const value = JSON.parse(await fs.promises.readFile(absolutePath, "utf8"));
  mutation(value);
  await writeFile(absolutePath, `${JSON.stringify(value, null, 2)}\n`);
}

test("keeps all normative registry sets exact and synchronized", () => {
  assert.deepEqual(runSemanticConformance(root), {
    methods: 22,
    events: 6,
    intents: 14,
    legacyFlags: 18,
    ports: 11,
    operations: 15,
    portErrors: 9,
    phases: 4,
    violations: 26,
    forbiddenFields: 14,
    semanticNegative: 10,
    hashBindings: 18,
    states: 15,
    terminalStates: 4,
    methodCategories: 12,
    continueStates: 3,
    selfTransitionStates: 8,
    committingKinds: 2,
    cancellationReasons: 11,
    stateNames: [
      "approval",
      "authorizing",
      "broadcasting",
      "cancelled",
      "committing",
      "completed",
      "failed",
      "finalizing",
      "initializing",
      "planning",
      "reconciliation",
      "rejected",
      "resolving",
      "signing",
      "validating",
    ],
    trustedContexts: 3,
    trustedContextFailures: 1,
    approvalBindings: 8,
    approvalPreviews: 6,
    approvalFailures: 2,
    permissionScopes: 2,
    permissionFailures: 4,
    workflowPlans: 1,
    workflowDerivations: 1,
    workflowFailures: 7,
    restrictedFields: 5,
    ordinaryDataFixtures: 3,
  });
});

test("normalizes private-key aliases without changing unrelated names", () => {
  assert.equal(
    normalizeForbiddenFieldName("private_key-wif"),
    "privatekeywif",
  );
  assert.equal(
    normalizeForbiddenFieldName("PRIVATE.KEY.WIF"),
    "privatekeywif",
  );
  assert.deepEqual(
    findForbiddenFields(
      { nested: { private_key_wif: "redacted", requestHash: "safe" } },
      ["privateKeyWif"],
    ),
    ["/nested/private_key_wif"],
  );
});

test("rejects a method path with an illegal state transition", async (context) => {
  const copyRoot = await semanticCopy(context, "tws-state-mutation-");
  await mutateJson(copyRoot, "registry/operation-states.json", (registry) => {
    registry.states.find(({ name }) => name === "initializing")
      .allowedTransitions = ["failed", "cancelled"];
  });
  assert.throws(
    () => runSemanticConformance(copyRoot),
    /illegal transition initializing -> validating/,
  );
});

test("rejects a method whose approval operation kind drifts", async (context) => {
  const copyRoot = await semanticCopy(context, "tws-approval-mutation-");
  await mutateJson(copyRoot, "registry/methods.json", (registry) => {
    registry.methods.find(({ name }) => name === "tbc_sendTransaction")
      .operationKind = "message";
  });
  assert.throws(
    () => runSemanticConformance(copyRoot),
    /operationKind differs/,
  );
});

test("rejects a forbidden secret field in a canonical fixture", async (context) => {
  const copyRoot = await semanticCopy(context, "tws-secret-mutation-");
  await mutateJson(copyRoot, "test-vectors/integration.json", (vectors) => {
    vectors.canonicalTransfer.request.vault_handle = "must-not-cross-boundary";
  });
  assert.throws(
    () => runSemanticConformance(copyRoot),
    /forbidden fields|SECRET_FIELD_PRESENT/i,
  );
});

test("rejects a cross-chain active account through the semantic runner", async (context) => {
  const copyRoot = await semanticCopy(context, "tws-cross-chain-session-");
  await mutateJson(copyRoot, "test-vectors/provider.json", (vectors) => {
    vectors.providerSessions.sessionA.state.activeAccountIds = [
      "tbc:other:1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH",
    ];
  });
  assert.throws(
    () => runSemanticConformance(copyRoot),
    /PROVIDER_SESSION_ACCOUNT_CHAIN_MISMATCH/,
  );
});

test("rejects restricted or forbidden data in every ordinary boundary", async (context) => {
  const mutations = [
    ["log", "rawTransaction", "00"],
    ["telemetry", "approvalToken", "opaque"],
    ["port-error", "signature", "opaque"],
    ["log", "checkpoint", {}],
    ["telemetry", "envelope", { message: "complete payload" }],
    ["port-error", "privateKeyWif", "forbidden"],
  ];
  for (const [kind, field, value] of mutations) {
    const copyRoot = await semanticCopy(
      context,
      `tws-ordinary-${kind}-${field}-`,
    );
    await mutateJson(copyRoot, "test-vectors/integration.json", (vectors) => {
      vectors.restrictedDataPolicy.ordinaryFixtures
        .find((fixture) => fixture.kind === kind)
        .value[field] = value;
    });
    assert.throws(
      () => runSemanticConformance(copyRoot),
      new RegExp(`Ordinary ${kind} fixture contains restricted data.*${field}`),
    );
  }
});
