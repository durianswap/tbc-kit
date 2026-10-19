import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const kitRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("bundled Native keyless C ABI is consumable and identical to WASM", () => {
  const evidence = JSON.parse(execFileSync(
    process.execPath,
    [resolve(kitRoot, "scripts/check-keyless-native.mjs")],
    { cwd: resolve(kitRoot, "../.."), encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  ));
  assert.equal(evidence.cRunnerCompiled, true);
  assert.equal(evidence.publicAdapterInvoked, true);
  assert.equal(evidence.wasmNativeIdentity, true);
  assert.equal(evidence.signingOperationRejected, true);
  assert.equal(evidence.networkRequests, 0);
  assert.equal(evidence.broadcasts, 0);
});
