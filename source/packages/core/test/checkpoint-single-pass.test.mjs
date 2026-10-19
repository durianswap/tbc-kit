import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { build } from "esbuild";
import * as core from "../dist/esm/index.js";
import { materializeCheckpoints } from "../../../scripts/lib/lifecycle-conformance.mjs";

test("checkpoint creation hashes its payload once; advance does not reverify its own output", async () => {
  const vectors = JSON.parse(await readFile(new URL("../../../test-vectors/checkpoints.json", import.meta.url), "utf8"));
  const checkpoints = materializeCheckpoints(vectors);
  const planning = checkpoints.find((entry) => entry.id === "planning").checkpoint;
  const approval = checkpoints.find((entry) => entry.id === "approval").checkpoint;
  let payloadHashes = 0;
  let checkpointValidations = 0;
  const compiled = await build({
    entryPoints: [new URL("../src/checkpoint.ts", import.meta.url).pathname],
    bundle: true, platform: "node", format: "cjs", write: false,
    plugins: [{ name: "count-checkpoint-work", setup(builder) {
      builder.onResolve({ filter: /^\.\/(hash|validation)\.js$/ }, (args) => ({ path: args.path, external: true }));
    } }],
  });
  const require = createRequire(import.meta.url);
  const module = { exports: {} };
  const run = vm.runInThisContext(`(function(require, module, exports) { ${compiled.outputFiles[0].text}\n})`);
  run(function(name) {
      if (name === "./hash.js") return { ...core, hashCanonical(value) {
        if (value?.pendingCalls !== undefined && value?.operationId !== undefined) payloadHashes++;
        return core.hashCanonical(value);
      } };
      if (name === "./validation.js") return { ...core, assertValidTws(kind, value) {
        if (kind === "operationCheckpoint") checkpointValidations++;
        return core.assertValidTws(kind, value);
      } };
      return require(name);
    }, module, module.exports);
  const api = module.exports;
  const created = api.createCheckpoint(planning.payload);
  assert.deepEqual(JSON.parse(JSON.stringify(created)), planning);
  assert.equal(payloadHashes, 1, "the hash just computed must not be recomputed for self-comparison");
  assert.equal(checkpointValidations, 1);
  payloadHashes = 0;
  checkpointValidations = 0;
  assert.equal(api.verifyCheckpoint(created, vectors.fixture.basePayload.release), created);
  assert.equal(payloadHashes, 0, "do not hash an already verified immutable local object again");
  assert.equal(checkpointValidations, 0, "do not revalidate an already verified immutable local object");
  assert.deepEqual(JSON.parse(JSON.stringify(api.advanceCheckpoint(created, approval.payload, vectors.fixture.basePayload.release))), approval);
  assert.equal(payloadHashes, 1, "only the new portable output requires a payload hash");
  payloadHashes = 0;
  checkpointValidations = 0;
  assert.deepEqual(JSON.parse(JSON.stringify(api.advanceCheckpoint(planning, approval.payload, vectors.fixture.basePayload.release))), approval);
  assert.equal(payloadHashes, 2, "one hash checks the input, one creates the output");
  assert.equal(checkpointValidations, 2, "validate external input and new output exactly once each");
  const corrupt = structuredClone(created);
  corrupt.checkpointHash = "f".repeat(64);
  Object.freeze(corrupt);
  assert.throws(() => api.verifyCheckpoint(corrupt, vectors.fixture.basePayload.release), (e) => e.code === "CHECKPOINT_HASH_MISMATCH");
  assert.throws(() => api.advanceCheckpoint(corrupt, approval.payload, vectors.fixture.basePayload.release), (e) => e.code === "CHECKPOINT_HASH_MISMATCH");
  assert.throws(() => api.verifyCheckpoint(planning, core.TWS_RELEASE), (e) => e.code === "RELEASE_MISMATCH");
  assert.ok(Object.isFrozen(created.payload.memory));
  // Keep checking the cloned result against the expected release, even if a
  // caller-owned accessor changes that expectation during output cloning.
  const expected = structuredClone(vectors.fixture.basePayload.release);
  const accessorPayload = { ...approval.payload, get data() {
    expected.version = "1.0.0-draft.99";
    return approval.payload.data;
  } };
  assert.throws(() => api.advanceCheckpoint(planning, accessorPayload, expected), (e) => e.code === "RELEASE_MISMATCH");
});
