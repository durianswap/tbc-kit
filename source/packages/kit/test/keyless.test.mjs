import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import fixture from "./fixtures/controlled-pool.json" with { type: "json" };
import {
  TBC_KEYLESS_OPERATIONS,
  createNativeTbcKeylessEngine,
  createWasmTbcKeylessEngine,
} from "../dist/esm/index.js";
import {
  createPoolMaterialNativeProvider,
  createProductionPoolMaterialSource,
} from "../dist/esm/wallet.js";

const artifactUrl = new URL("../artifacts/wasm/tbc_keyless_wasm.wasm", import.meta.url);

test("bundled keyless WASM has no ambient imports and exposes only its restricted ABI", async () => {
  const bytes = await readFile(artifactUrl);
  const module = await WebAssembly.compile(bytes);
  assert.deepEqual(WebAssembly.Module.imports(module), []);
  assert.deepEqual(
    WebAssembly.Module.exports(module).map(({ name }) => name).sort(),
    [
      "memory",
      "tbc_keyless_wasm_alloc",
      "tbc_keyless_wasm_call",
      "tbc_keyless_wasm_free_input",
      "tbc_keyless_wasm_free_result",
      "tbc_keyless_wasm_result_len",
      "tbc_keyless_wasm_result_ptr",
    ].sort(),
  );
});

test("bundled keyless WASM runs the restricted preparation and receipt helpers", async () => {
  const engine = await createWasmTbcKeylessEngine(await readFile(artifactUrl));
  assert.deepEqual(JSON.parse(await engine.protocolInfo()).operations, TBC_KEYLESS_OPERATIONS);

  const preview = JSON.parse(await engine.execute("legacyPoolPreview", JSON.stringify({
    operation: "increaseLp",
    ftContractId: "22".repeat(32),
    ftDecimal: 6,
    amount: "0.001",
    lockTime: 0,
    pool: {
      ftLpRaw: "10000",
      ftARaw: "5000",
      tbcSat: "10000",
      poolValueSat: "11000",
      publicKeyLocked: false,
    },
  })));
  assert.deepEqual(
    { required: preview.ftRequiredRaw, minted: preview.ftlpMintedRaw, after: preview.after },
    {
      required: "500",
      minted: "1000",
      after: { ftLpRaw: "11000", ftARaw: "5500", tbcSat: "11000", poolValueSat: "12000" },
    },
  );

  const source = fixture.poolInfo;
  const info = {
    ftAPartialHash: source.ft_a_partial_hash,
    ftContractId: source.ft_contract_id,
    ftLpPartialHash: source.ft_lp_partial_hash,
    lpBalance: source.lp_balance,
    poolCodeScript: source.pool_code_script,
    serviceFeeRate: source.service_fee_rate,
    serviceProvider: source.service_provider,
    tbcBalance: source.tbc_balance,
    tokenBalance: source.token_balance,
    txid: source.txid,
    value: source.value,
    version: source.version,
    vout: source.vout,
  };
  const descriptor = JSON.parse(await engine.execute("preparePoolNft", JSON.stringify({
    phase: "describe",
    contractId: fixture.poolContractId,
    ownerAddress: fixture.address,
    info,
    poolPreTxraw: fixture.rawTransactions[source.txid],
    ftContractTxraw: fixture.rawTransactions[fixture.ftContractId],
  })));
  assert.equal(descriptor.ftContractId, fixture.ftContractId);
  assert.equal(descriptor.ftDecimal, 6);
  assert.equal(descriptor.stablecoin, false);
  assert.equal(descriptor.pool.ftLpRaw, "10000");

  const parentRaw = fixture.rawTransactions[fixture.ownerCandidate.txid];
  const inspection = JSON.parse(await engine.execute("prepareAssetAncestry", JSON.stringify({
    phase: "inspect",
    items: [{
      parentTxid: fixture.ownerCandidate.txid,
      outputIndex: fixture.ownerCandidate.index,
      parentTxraw: parentRaw,
    }],
  })));
  assert.ok(inspection.items[0].references.length > 0);
  await assert.rejects(engine.execute("sign", "{}"), /KEYLESS_OPERATION_UNAVAILABLE/);
});

test("bundled keyless ABI is consumed through the neutral Pool provider adapter", async () => {
  const engine = await createWasmTbcKeylessEngine(await readFile(artifactUrl));
  const provider = createPoolMaterialNativeProvider(engine);
  const info = JSON.parse(await provider.protocolInfo());
  assert.ok(info.operations.includes("previewLiquidityAdd"));
  assert.equal(info.operations.includes("legacyPoolPreview"), false);
  const preview = JSON.parse(await provider.execute("previewLiquidityAdd", JSON.stringify({
    operation: "increaseLp",
    ftContractId: "22".repeat(32),
    ftDecimal: 6,
    amount: "0.001",
    lockTime: 0,
    pool: {
      ftLpRaw: "10000",
      ftARaw: "5000",
      tbcSat: "10000",
      poolValueSat: "11000",
      publicKeyLocked: false,
    },
  })));
  assert.equal(preview.ftRequiredRaw, "500");
});

test("native keyless adapter never admits signing operations", async () => {
  let calls = 0;
  const engine = createNativeTbcKeylessEngine(async () => {
    calls += 1;
    return "{}";
  });
  await engine.execute("preparePoolNft", "{}");
  await assert.rejects(engine.execute("signTransaction", "{}"), /KEYLESS_OPERATION_UNAVAILABLE/);
  assert.equal(calls, 1);
});

test("Pool material uses the configured trusted origin uniformly", async () => {
  const urls = [];
  const fetch = async (input) => {
    urls.push(new URL(String(input)));
    return new Response(JSON.stringify({ code: "500", data: {} }), { status: 500 });
  };
  const native = {
    protocolInfo: async () => JSON.stringify({ operations: TBC_KEYLESS_OPERATIONS }),
    execute: async () => { throw new Error("should not reach keyless preparation"); },
  };
  const source = await createProductionPoolMaterialSource({
    native,
    fetch,
    baseUrl: "https://trusted.test/root/",
    allowedOrigins: ["https://trusted.test"],
  });
  await assert.rejects(source.resolveLiquidityAdd({
    address: fixture.address,
    receiver: fixture.address,
    poolContractId: fixture.poolContractId,
    tbcAmount: "2000000",
  }), /HTTP 500|rejected/);
  assert.ok(urls.length > 0);
  assert.ok(urls.every((url) => url.origin === "https://trusted.test"));
  assert.ok(urls.every((url) => url.pathname.startsWith("/root/api/tbc/")));
});
