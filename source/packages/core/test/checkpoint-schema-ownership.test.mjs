import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";
import { build } from "esbuild";
import { materializeCheckpoints } from "../../../scripts/lib/lifecycle-conformance.mjs";

const root = new URL("../../../", import.meta.url).pathname;
const require = createRequire(import.meta.url);
function evaluate(code, core) {
  const module = { exports: {} };
  vm.runInThisContext(`(function(require,module,exports){${code}\n})`)(
    name => name === "@tbc-wallet/core" && core ? core : require(name),
    module, module.exports,
  );
  return module.exports;
}
function predecessor(name, version, core) {
  const archive = `${root}release/${name}-${version}-candidate/tbc-wallet-${name}-1.0.0-draft.${version}.tgz`;
  let source = execFileSync("tar", ["-xOf", archive, "package/dist/cjs/index.cjs"], {
    encoding: "utf8", maxBuffer: 12 * 1024 * 1024,
  });
  // Compare the ownership optimization under the SAME current Chain ID grammar.
  // The immutable predecessor archive remains unchanged; this is not a claim
  // that its original public protocol accepts the new official names.
  if (name === "core") source = source.replaceAll("^tbc:[0-9a-f]{32}", "^tbc:[a-z0-9_-]{1,32}");
  return evaluate(source, core);
}

test("owned checkpoint schemas are reused without trusting transition bodies or external objects", async () => {
  let full = 0;
  globalThis.__twsCountCheckpointSchema = () => full++;
  try {
    const compiled = await build({
      entryPoints: [`${root}packages/core/src/index.ts`], bundle: true,
      platform: "node", format: "cjs", write: false,
      plugins: [{ name: "count-checkpoint-schema", setup(builder) {
        builder.onLoad({ filter: /generated\/validators\.ts$/ }, async ({ path }) => {
          const source = await readFile(path, "utf8");
          let count = 0;
          const contents = source.split(/(?=^function validate\d+\()/m).map(block => {
            if (!/^function validate\d+\(/.test(block) ||
                !block.includes("if(data.payload === undefined)") ||
                !block.includes("if(data.checkpointHash === undefined)")) return block;
            count++;
            return block.replace("let vErrors = null;",
              "globalThis.__twsCountCheckpointSchema();\nlet vErrors = null;");
          }).join("");
          assert.equal(count, 2, "count both AJV checkpoint entry and reference functions");
          return { contents, loader: "ts" };
        });
      } }],
    });
    const core = evaluate(compiled.outputFiles[0].text);
    const oldCore = predecessor("core", "6.19");
    const explicitAdditions = [
      "parseProtocolTimestamp",
      "formatProtocolTimestamp",
      "assertTbcSignInWalletContext",
      "assertWalletActionApprovalEvidence",
      "assertWorkflowDeferredSigningTask",
      "base64Decode",
      "base64Encode",
      "canonicalSigningEnvelope",
      "decodeSigningMessage",
      "inspectTbcSignInMessage",
      "parseTbcSignInMessage",
      "serializeTbcSignInMessage",
      "signingEnvelopeDigest",
      "signingPayload",
      "utf8Decode",
      "verifyTwsRecoverableSignature",
    ];
    assert.deepEqual(
      Object.keys(core).sort(),
      [...Object.keys(oldCore), ...explicitAdditions].sort(),
      "only the explicit public capabilities added since the archived predecessor are exported",
    );
    const vectors = JSON.parse(await readFile(`${root}test-vectors/checkpoints.json`, "utf8"));
    const checkpoints = materializeCheckpoints(vectors);
    const planning = checkpoints.find(entry => entry.id === "planning").checkpoint;
    full = 0;
    const owned = core.createCheckpoint(planning.payload);
    assert.equal(full, 1, "new checkpoint is fully validated before ownership is recorded");
    full = 0;
    for (let i = 0; i < 3; i++) core.assertValidTws("coreTransition", { kind: "continue", checkpoint: owned });
    assert.equal(full, 0, "RED predecessor: these boundaries perform 12 subtree validations");
    assert.equal(core.isValidTws("operationCheckpoint", owned), true);
    assert.equal(full, 0);

    for (const foreign of [structuredClone(owned), Object.freeze(structuredClone(owned)), new Proxy(owned, {})]) {
      full = 0;
      assert.equal(core.isValidTws("operationCheckpoint", foreign), true);
      assert.equal(full, 1, "clones, caller freeze and Proxy never acquire local ownership");
    }
    const mutable = { kind: "continue", checkpoint: owned };
    core.assertValidTws("coreTransition", mutable);
    mutable.kind = "invalid";
    assert.equal(core.isValidTws("coreTransition", mutable), false, "validated outer body is not cached");
    assert.equal(core.isValidTws("coreTransition", { kind: "continue", checkpoint: owned, extra: true }), false);
    assert.equal(core.isValidTws("coreTransition", { kind: "waiting", checkpoint: owned, calls: [{}] }), false);
    assert.throws(() => core.assertPortResult("clock.now", { now: "not-a-time" }));

    function verdict(api, value) {
      try { api.assertValidTws("coreTransition", value); return { valid: true }; }
      catch (error) { return { valid: false, code: error.code, issues: error.issues }; }
    }
    const bad = structuredClone(owned);
    bad.payload.state = "invalid";
    for (const value of [mutable, { kind: "continue", checkpoint: owned, extra: true },
      { kind: "waiting", checkpoint: owned, calls: [{}] },
      { kind: "continue", checkpoint: Object.freeze(bad) }]) {
      assert.deepEqual(verdict(core, value), verdict(oldCore, value), "same failures and schema issue paths");
    }
    const forgedHash = structuredClone(owned);
    forgedHash.checkpointHash = "f".repeat(64);
    assert.throws(() => core.verifyCheckpoint(Object.freeze(forgedHash), planning.payload.release),
      error => error.code === "CHECKPOINT_HASH_MISMATCH");
    for (const entry of checkpoints) {
      const outcomes = [core, oldCore].map(api => {
        try { return { checkpoint: api.createCheckpoint(entry.checkpoint.payload) }; }
        catch (error) { return { name: error.name, code: error.code, message: error.message }; }
      });
      assert.deepEqual(outcomes[0], outcomes[1], `same success or rejection for ${entry.id}`);
    }

    const hostBuild = await build({ entryPoints: [`${root}packages/host/src/index.ts`],
      bundle: true, platform: "node", format: "cjs", write: false, external: ["@tbc-wallet/core"] });
    const host = evaluate(hostBuild.outputFiles[0].text, core);
    const oldHost = predecessor("host", "6.20", oldCore);
    const stores = [host, oldHost].map(api => api.createMemoryTwsHostStore({ now: () => Date.parse("2026-08-31T12:00:00Z") }));
    const payload = structuredClone(planning.payload);
    // Schema-valid public hex only; this is not a real transaction/Engine benchmark.
    payload.memory.chainSnapshot.payload.parents[0].rawTransaction = "ab".repeat(53_255);
    payload.memory.chainSnapshot.snapshotHash = core.hashCanonical(payload.memory.chainSnapshot.payload);
    const apis = [core, oldCore];
    let states = apis.map(api => api.createCheckpoint(payload));
    const leases = await Promise.all(stores.map(store => store.acquireLease({
      operationId: states[0].payload.operationId, ownerId: "schema-ownership-fixture", ttlMs: 60_000,
    })));
    let records = [null, null];
    for (let step = 0; step < 5; step++) {
      full = 0;
      const results = [];
      for (let index = 0; index < 2; index++) {
        const api = apis[index];
        const previous = states[index];
        states[index] = api.advanceCheckpoint(previous, {
          ...previous.payload, revision: String(BigInt(previous.payload.revision) + 1n),
          previousCheckpointHash: previous.checkpointHash,
        }, previous.payload.release);
        const transition = { kind: "continue", checkpoint: states[index] };
        // Core output and Host ingress plus the real memory-store boundary.
        api.assertValidTws("coreTransition", transition);
        api.assertValidTws("coreTransition", transition);
        const committed = await stores[index].commitTransition({ lease: leases[index], transition,
          expected: records[index] === null ? null : {
            storeRevision: records[index].storeRevision, checkpointHash: records[index].checkpointHash,
          } });
        records[index] = committed.operation;
        results.push(committed);
      }
      assert.equal(full, 1, "only the new checkpoint schema walks the large immutable payload");
      assert.deepEqual(states[0], states[1], "identical checkpoint/hash bytes across revisions");
      assert.deepEqual(results[0], results[1], "identical Host records, identities, calls and CAS output");
    }
    console.log("owned-checkpoint schema: 12 repeated traversals -> 0; 5 large-material commits byte-equivalent");
  } finally {
    delete globalThis.__twsCountCheckpointSchema;
  }
});
