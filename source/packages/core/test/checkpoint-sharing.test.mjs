import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as core from "../dist/esm/index.js";
import { materializeCheckpoints } from "../../../scripts/lib/lifecycle-conformance.mjs";

test("advancing reuses unchanged owned data, never caller-frozen mutable data", async () => {
  const vectors = JSON.parse(await readFile(new URL("../../../test-vectors/checkpoints.json", import.meta.url), "utf8"));
  const entries = materializeCheckpoints(vectors);
  const before = entries.find(x => x.id === "planning").checkpoint;
  const after = entries.find(x => x.id === "approval").checkpoint;
  const previous = core.createCheckpoint(before.payload);
  const nextPayload = { ...after.payload, memory: { ...after.payload.memory } };
  for (const field of ["release", "requestId", "operation", "context", "session"]) nextPayload[field] = previous.payload[field];
  for (const [field, value] of Object.entries(previous.payload.memory)) {
    if (core.canonicalize(value) === core.canonicalize(nextPayload.memory[field])) nextPayload.memory[field] = value;
  }
  const next = core.advanceCheckpoint(previous, nextPayload, before.payload.release);
  assert.deepEqual(next, after, "portable bytes/hash and approval semantics must not change");
  assert.equal(next.payload.memory.executionPolicy, previous.payload.memory.executionPolicy);
  assert.equal(next.payload.operation, previous.payload.operation);
  assert.equal(next.payload.context, previous.payload.context);
  assert.notEqual(next.payload.memory, nextPayload.memory);

  const caller = structuredClone(before.payload);
  Object.freeze(caller.memory.executionPolicy);
  const isolated = core.createCheckpoint(caller);
  assert.notEqual(isolated.payload.memory.executionPolicy, caller.memory.executionPolicy);
  caller.memory.executionPolicy.payload.allowUnconfirmed = !caller.memory.executionPolicy.payload.allowUnconfirmed;
  assert.deepEqual(isolated, before, "Object.freeze from a caller is not ownership evidence");
});
