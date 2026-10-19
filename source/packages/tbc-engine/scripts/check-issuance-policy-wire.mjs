#!/usr/bin/env node
// Source-only native Rust / real WASM parity. No delivery artifacts, wallet
// secrets, network, signing or broadcasts. Captured fixture wire stays in RAM.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { build } from "esbuild";

const rust = fileURLToPath(new URL("../rust/", import.meta.url));
function cargo(args, env = {}) {
  const run = spawnSync("cargo", args, {
    cwd: rust, env: { ...process.env, ...env }, encoding: "utf8",
    timeout: 120_000, maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (run.error || run.status !== 0) {
    throw new Error(`Source policy gate failed (status=${run.status}, signal=${run.signal}); captured material withheld`);
  }
  return run.stdout;
}

try {
  const output = cargo(["test", "--locked", "--offline", "-p", "tbc-engine-core",
    "--lib", "issuance_policy_tests", "--", "--test-threads=1", "--nocapture"],
  { ISSUANCE_POLICY_DUMP_WIRE: "1" });
  if (!output.includes("test result: ok. 2 passed; 0 failed;")) {
    throw new Error("Expected both policy tests to execute");
  }
  const marker = "ISSUANCE_POLICY_WIRE:";
  const records = output.split(/\r?\n/u).filter(line => line.includes(marker))
    .map(line => JSON.parse(line.slice(line.indexOf(marker) + marker.length)));
  cargo(["build", "--offline", "--locked", "--release", "-p", "tbc-engine-wasm",
    "--target", "wasm32-unknown-unknown"], { RUSTFLAGS: '--cfg getrandom_backend="unsupported"' });
  const bundled = await build({
    entryPoints: [fileURLToPath(new URL("../src/wasm.ts", import.meta.url))],
    bundle: true, write: false, format: "esm", platform: "node", logLevel: "silent",
  });
  const { createWasmTbcEngineBackend } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].contents).toString("base64")}`);
  const wasm = await createWasmTbcEngineBackend(readFileSync(`${rust}/target/wasm32-unknown-unknown/release/tbc_engine_wasm.wasm`));
  const counts = { normalizeRequest: 0, plan: 0, validate: 0, finalize: 0 };
  for (const [index, record] of records.entries()) {
    if (!Object.hasOwn(counts, record.method)) throw new Error("Unexpected wire method");
    const actual = JSON.parse(await wasm.call(record.method, JSON.stringify(record.input)));
    if (!isDeepStrictEqual(actual, record.result)) throw new Error(`Native Rust/WASM mismatch at record ${index}; material withheld`);
    counts[record.method]++;
  }
  if (!isDeepStrictEqual(counts, { normalizeRequest: 5, plan: 4, validate: 4, finalize: 1 })) {
    throw new Error("Incomplete public issuance/recovery wire coverage");
  }
  console.log(JSON.stringify({ result: "ISSUANCE_POLICY_SOURCE_PARITY_PASS", calls: records.length, counts, deliveryArtifactsChanged: false }));
} catch {
  console.error("Issuance policy source parity failed; captured fixture material withheld. Run focused Rust tests for diagnostics.");
  process.exitCode = 1;
}
