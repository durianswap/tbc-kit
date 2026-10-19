import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createTbcEngine } from "../dist/esm/index.js";
import { createNativeTbcEngineBackend } from "../dist/esm/native.js";
import { createWasmTbcEngineBackend } from "../dist/esm/wasm.js";

const packageRoot = new URL("../", import.meta.url);

test("WASM facade executes the Rust plan path with exactly four methods", async () => {
  const [wasm, fixture] = await Promise.all([
    readFile(new URL("artifacts/wasm/tbc_engine_wasm.wasm", packageRoot)),
    readFile(new URL("rust/fixtures/tbc-transfer.json", packageRoot), "utf8").then(JSON.parse),
  ]);
  const backend = await createWasmTbcEngineBackend(wasm);
  const engine = createTbcEngine({ backend });
  assert.equal(Object.isFrozen(engine), true);
  assert.deepEqual(Object.keys(engine).sort(), ["finalize", "normalizeRequest", "plan", "validate"]);
  const result = await engine.plan(fixture.planInput);
  assert.equal(result.plan.payload.transactions.length, 1);
  // The plan commits to the readable chain identity; transaction bytes are unchanged.
  assert.equal(result.plan.planHash, "23e5d5d128ba5672ac36fc7375307989ccc0e8adf12fe8638be6ed17bfdb5cd6");
});

test("native backend delegates canonical JSON once and maps Rust errors", async () => {
  const calls = [];
  const backend = createNativeTbcEngineBackend((method, input) => {
    calls.push({ method, input });
    return '{"error":{"code":"INVALID_PLAN","message":"rejected","path":"plan"},"ok":false,"version":"1.0"}';
  });
  const fixture = JSON.parse(
    await readFile(new URL("rust/fixtures/tbc-transfer.json", packageRoot), "utf8"),
  );
  const engine = createTbcEngine({ backend });
  assert.throws(
    () => engine.plan(fixture.planInput),
    (error) => error.code === "INVALID_REQUEST" && error.rustCode === "INVALID_PLAN" && error.path === "plan",
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "plan");
  assert.deepEqual(JSON.parse(calls[0].input), fixture.planInput);
});
