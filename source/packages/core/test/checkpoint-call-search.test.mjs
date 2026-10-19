import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { build } from "esbuild";
import * as core from "../dist/esm/index.js";
import { materializeCheckpoints } from "../../../scripts/lib/lifecycle-conformance.mjs";

test("current calls cost one derivation; older recovery retains the exact 32-revision window", async () => {
  const vectors = JSON.parse(await readFile(new URL("../../../test-vectors/checkpoints.json", import.meta.url), "utf8"));
  const checkpoints = materializeCheckpoints(vectors);
  const source = checkpoints.find((entry) => entry.id === "validating").checkpoint;
  const initialCall = checkpoints.find((entry) => entry.id === "initializing").checkpoint.payload.pendingCalls[0];
  let derivations = 0;
  const compiled = await build({
    entryPoints: [new URL("../src/checkpoint.ts", import.meta.url).pathname],
    bundle: true, platform: "node", format: "cjs", write: false,
    external: ["@noble/hashes/*"],
    plugins: [{ name: "count-call-derivations", setup(builder) {
      builder.onResolve({ filter: /^\.\/identifiers\.js$/ }, () => ({ path: "counted-identifiers", external: true }));
    } }],
  });
  const require = createRequire(import.meta.url);
  const module = { exports: {} };
  vm.runInNewContext(compiled.outputFiles[0].text, {
    module, exports: module.exports, Object, JSON, Uint8Array,
    require(name) {
      return name === "counted-identifiers" ? {
        ...core, deriveCallId(input) { derivations++; return core.deriveCallId(input); },
      } : require(name);
    },
  });
  function checkpoint(issuedRevision, ordinal = "0") {
    const payload = structuredClone(source.payload);
    payload.revision = "48";
    payload.pendingCalls = [structuredClone(initialCall)];
    const call = payload.pendingCalls[0];
    call.callId = core.deriveCallId({ operationId: payload.operationId,
      checkpointRevision: issuedRevision, effectOrdinal: ordinal, operationName: call.operation });
    return { payload, checkpointHash: core.hashCanonical(payload) };
  }
  const verify = (value) => module.exports.verifyCheckpoint(value, vectors.fixture.basePayload.release);
  assert.deepEqual(verify(checkpoint("48")).checkpointHash, checkpoint("48").checkpointHash);
  assert.equal(derivations, 1, "do not brute-force historical revisions for a current call");
  // Fallback order changes, not the accepted IDs, ordinals or recovery horizon.
  for (const [revision, ordinal] of [["48", "31"], ["47", "0"], ["17", "31"]]) {
    assert.equal(verify(checkpoint(revision, ordinal)).checkpointHash, checkpoint(revision, ordinal).checkpointHash);
  }
  for (const [revision, ordinal] of [["16", "0"], ["49", "0"], ["48", "32"]]) {
    assert.throws(() => verify(checkpoint(revision, ordinal)), (error) => error.code === "CALL_ID_MISMATCH");
  }
});
