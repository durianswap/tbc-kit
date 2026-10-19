import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";

import {
  TBC_MAINNET_PROFILE,
  TBC_TESTNET_PROFILE,
  createTbcEngine as createBrowserTbcEngine,
} from "../dist/esm/engine.js";

const require = createRequire(import.meta.url);
const vector = require("../../../test-vectors/integration.json").canonicalTransfer;

test("engine entry exposes the frozen same-release network profiles", () => {
  assert.deepEqual(TBC_MAINNET_PROFILE, {
    chainId: "tbc:mainnet",
    p2pkhVersion: 0,
    transactionVersion: 10,
  });
  assert.deepEqual(TBC_TESTNET_PROFILE, {
    chainId: "tbc:testnet",
    p2pkhVersion: 0,
    transactionVersion: 10,
  });
  assert.equal(Object.isFrozen(TBC_MAINNET_PROFILE), true);
  assert.equal(Object.isFrozen(TBC_TESTNET_PROFILE), true);
});

test("installed Node ESM and CommonJS engines load the bundled file WASM by default", async () => {
  const nodeEntry = await import("@tbc/kit/engine");
  const esm = nodeEntry.createTbcEngine();
  const esmResult = await esm.normalizeRequest({
    version: "1.0",
    request: vector.request,
  });
  assert.equal(esmResult.requestHash, vector.requestHash);

  const cjs = require("@tbc/kit/engine");
  const cjsResult = await cjs.createTbcEngine().normalizeRequest({
    version: "1.0",
    request: vector.request,
  });
  assert.equal(cjsResult.requestHash, vector.requestHash);
});

test("an explicitly injected fetch remains authoritative for a file URL", async () => {
  const url = new URL("../artifacts/wasm/tbc_engine_wasm.wasm", import.meta.url);
  const bytes = await readFile(url);
  let calls = 0;
  const engine = createBrowserTbcEngine({
    wasm: {
      url,
      async fetch(input) {
        calls += 1;
        assert.equal(String(input), url.href);
        return new Response(bytes, { status: 200 });
      },
    },
  });
  const result = await engine.normalizeRequest({
    version: "1.0",
    request: vector.request,
  });
  assert.equal(result.requestHash, vector.requestHash);
  assert.equal(calls, 1);
});
