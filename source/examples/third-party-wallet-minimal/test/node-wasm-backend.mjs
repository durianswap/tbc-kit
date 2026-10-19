import { readFile } from "node:fs/promises";

import { createWasmTbcEngineBackend } from "@tbc-wallet/tbc-engine/wasm";

const adapterUrl = import.meta.resolve("@tbc-wallet/tbc-engine/wasm");
const wasmUrl = new URL(
  "../../artifacts/wasm/tbc_engine_wasm.wasm",
  adapterUrl,
);

export const testEngineBackend = await createWasmTbcEngineBackend(
  await readFile(wasmUrl),
);
