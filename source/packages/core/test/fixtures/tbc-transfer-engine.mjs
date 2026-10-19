import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createTbcTransferEngine as createRealTbcTransferEngine } from "@tbc-wallet/tbc-engine";
import { createWasmTbcEngineBackend } from "@tbc-wallet/tbc-engine/wasm";

const backend = await createWasmTbcEngineBackend(
  await readFile(
    new URL(
      "../../../tbc-engine/artifacts/wasm/tbc_engine_wasm.wasm",
      import.meta.url,
    ),
  ),
);

function clone(value) {
  return structuredClone(value);
}

export function createTbcTransferEngine(_integration) {
  return trackedEngine(backend);
}

let sourceBackend;
/** Build current Rust only for tests of new semantics; never rewrite frozen artifacts. */
export async function createSourceTbcTransferEngine() {
  sourceBackend ??= (async () => {
    const rust = new URL("../../../tbc-engine/rust/", import.meta.url);
    await promisify(execFile)("cargo", ["build", "--offline", "--locked", "--release",
      "-p", "tbc-engine-wasm", "--target", "wasm32-unknown-unknown"], {
      cwd: fileURLToPath(rust), env: { ...process.env, RUSTFLAGS: '--cfg getrandom_backend="unsupported"' },
      timeout: 120000, maxBuffer: 8 * 1024 * 1024,
    });
    return createWasmTbcEngineBackend(await readFile(new URL("target/wasm32-unknown-unknown/release/tbc_engine_wasm.wasm", rust)));
  })();
  return trackedEngine(await sourceBackend);
}

function trackedEngine(backend) {
  const realEngine = createRealTbcTransferEngine({ backend });
  const calls = [];
  const record = (operation, params) => {
    calls.push({ operation, params: clone(params) });
  };
  const invoke = (operation, params) => {
    record(
      operation === "validate" ? `validate:${params.phase}` : operation,
      params,
    );
    return realEngine[operation](params);
  };

  const engine = Object.freeze({
    normalizeRequest: (params) => invoke("normalizeRequest", params),
    plan: (params) => invoke("plan", params),
    validate: (params) => invoke("validate", params),
    finalize: (params) => invoke("finalize", params),
  });

  return { engine, calls, record };
}
