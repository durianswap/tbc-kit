import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const packageUrl = new URL("../package.json", import.meta.url);
const runtimeUrl = new URL("../dist/esm/index.js", import.meta.url);
const candidateUrl = new URL("../../../release/tws-v1-candidate.json", import.meta.url);

test("package boundary is publishable, portable, and encapsulated", async () => {
  const manifest = JSON.parse(await readFile(packageUrl, "utf8"));

  assert.equal(manifest.name, "@tbc-wallet/core");
  assert.equal(manifest.version, "1.0.0-draft.6.10");
  assert.equal(manifest.private, false);
  assert.equal(manifest.sideEffects, false);
  assert.deepEqual(Object.keys(manifest.dependencies), [
    "@noble/curves",
    "@noble/hashes",
  ]);
  assert.deepEqual(Object.keys(manifest.exports), [".", "./release"]);
  assert.equal(manifest.exports["."]["react-native"], "./dist/esm/index.js");
  assert.equal(manifest.exports["."].import, "./dist/esm/index.js");
  assert.equal(manifest.exports["."].require, "./dist/cjs/index.cjs");
  assert.equal(manifest.exports["."].types, "./dist/types/index.d.ts");
});

test("package boundary exports the v1 Candidate release and no execute shortcut", async () => {
  const runtime = await import(runtimeUrl);
  const candidate = JSON.parse(await readFile(candidateUrl, "utf8"));

  assert.deepEqual(runtime.TWS_RELEASE, {
    version: candidate.candidateVersion,
    schemaBundleSha256: candidate.schemaBundleSha256,
    registryBundleSha256: candidate.registryBundleSha256,
  });
  assert.match(runtime.TWS_RELEASE_FINGERPRINT, /^[0-9a-f]{64}$/);
  assert.equal(runtime.TWS_PROTOCOL_COMMIT, null);
  assert.equal("execute" in runtime, false);
});
