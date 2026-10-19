import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { cp, rm, writeFile } from "node:fs/promises";
import * as semantic from "../scripts/lib/semantic-conformance.mjs";
import { repositoryRoot } from "../scripts/lib/repository.mjs";

const root = repositoryRoot(import.meta.url);

async function registryCopy(context, prefix) {
  const copyRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
  context.after(() => rm(copyRoot, { recursive: true, force: true }));
  for (const directory of ["schemas", "registry", "test-vectors", "standards"]) {
    await cp(path.join(root, directory), path.join(copyRoot, directory), {
      recursive: true,
    });
  }
  return copyRoot;
}

async function mutateStates(context, prefix, mutation) {
  const copyRoot = await registryCopy(context, prefix);
  const registryPath = path.join(copyRoot, "registry/operation-states.json");
  const registry = JSON.parse(await fs.promises.readFile(registryPath, "utf8"));
  mutation(registry);
  await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
  return copyRoot;
}

test("closes every method path over registered state and effect policies", () => {
  assert.equal(typeof semantic.runStateEffectClosure, "function");
  assert.deepEqual(semantic.runStateEffectClosure(root), {
    methods: 22,
    categories: 12,
    states: 15,
    terminalStates: 4,
    ports: 11,
    operations: 15,
    continueStates: 3,
    selfTransitionStates: 8,
    committingKinds: 2,
    unreachableMethods: [],
    illegalEffects: [],
  });
});

test("never grants Broadcast to the sign-only route", () => {
  assert.equal(typeof semantic.methodCanEmit, "function");
  assert.equal(
    semantic.methodCanEmit(root, "tbc_signTransaction", "broadcast.submit"),
    false,
  );
  assert.equal(
    semantic.methodCanEmit(root, "tbc_sendTransaction", "broadcast.submit"),
    true,
  );
  assert.equal(
    semantic.methodCanEmit(root, "tbc_signPreparedTransaction", "broadcast.submit"),
    false,
  );
  assert.equal(
    semantic.methodCanEmit(root, "tbc_sendPreparedTransaction", "broadcast.submit"),
    true,
  );
});

test("rejects drift in self transitions, method paths and terminal effects", async (context) => {
  const noResolvingSelf = await mutateStates(
    context,
    "tws-no-resolving-self-",
    (registry) => {
      const state = registry.states.find(({ name }) => name === "resolving");
      state.allowedTransitions = state.allowedTransitions.filter(
        (target) => target !== "resolving",
      );
    },
  );
  assert.throws(
    () => semantic.runStateEffectClosure(noResolvingSelf),
    /resolving.*self transition/i,
  );

  const signBroadcast = await mutateStates(
    context,
    "tws-sign-broadcast-",
    (registry) => {
      registry.methodPaths.find(({ category }) => category === "sign-transaction")
        .states.splice(-1, 0, "broadcasting");
    },
  );
  assert.throws(
    () => semantic.runStateEffectClosure(signBroadcast),
    /sign-transaction|broadcast\.submit/i,
  );

  const noPermissionCommit = await mutateStates(
    context,
    "tws-no-permission-commit-",
    (registry) => {
      const path = registry.methodPaths.find(
        ({ category }) => category === "permission-request",
      );
      path.states = path.states.filter((state) => state !== "committing");
    },
  );
  assert.throws(
    () => semantic.runStateEffectClosure(noPermissionCommit),
    /permission-request.*committing/i,
  );

  const terminalPort = await mutateStates(
    context,
    "tws-terminal-port-",
    (registry) => {
      registry.states.find(({ name }) => name === "completed")
        .allowedPortOperations.push("clock.now");
    },
  );
  assert.throws(
    () => semantic.runStateEffectClosure(terminalPort),
    /completed.*Port/i,
  );
});
