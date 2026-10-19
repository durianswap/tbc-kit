import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createPoolMaterialLoader,
  createWasmTbcKeylessEngine,
} from "../dist/esm/wallet.js";

const fixture = JSON.parse(await readFile(
  new URL("./fixtures/controlled-pool.json", import.meta.url),
  "utf8",
));
const native = await createWasmTbcKeylessEngine(await readFile(
  new URL("../artifacts/wasm/tbc_keyless_wasm.wasm", import.meta.url),
));

function response(data, { code = "200", message = "OK", status = 200 } = {}) {
  return new Response(JSON.stringify({ code, message, data }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const emptySelectingNative = Object.freeze({
  async execute(operation, requestJson) {
    const request = JSON.parse(requestJson);
    if (operation === "preparePoolNft" && request.phase === "select") {
      return JSON.stringify({
        ownerFtCandidates: [],
        poolFtCandidates: [],
        ftlpCandidates: [],
      });
    }
    return native.execute(operation, requestJson);
  },
});

function loader(finalResponse, nativeProvider = native) {
  return createPoolMaterialLoader({
    native: nativeProvider,
    purpose: "public-material",
    async fetch(input) {
      const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
      if (path === `/api/tbc/pool/poolinfo/poolid/${fixture.poolContractId}`) {
        return response(fixture.poolInfo);
      }
      const txid = path.match(/^\/api\/tbc\/txraw\/txid\/([0-9a-f]{64})$/u)?.[1];
      if (txid !== undefined && fixture.rawTransactions[txid] !== undefined) {
        return response({ txraw: fixture.rawTransactions[txid] });
      }
      if (path.startsWith("/api/tbc/ft/utxo/combinescript/") &&
          path.endsWith(`/contract/${fixture.ftContractId}`)) {
        return response({ utxos: [] });
      }
      if (path === "/api/tbc/block/last/0/1") {
        return response([{ height: 1000 }]);
      }
      if (/^\/api\/tbc\/pool\/lputxo\/scriptpubkeyhash\/[0-9a-f]{64}$/u.test(path)) {
        return finalResponse();
      }
      throw new Error(`Unexpected Pool empty-index request: ${path}`);
    },
  });
}

const request = Object.freeze({
  operation: "indexFtlp",
  addressFrom: fixture.address,
  contractId: fixture.poolContractId,
});

test("LP atomic conversion stays at six decimals when the pool FT has zero decimals", async () => {
  let selected = false;
  const provider = {
    async execute(operation, input) {
      const value = JSON.parse(input);
      if (operation === "preparePoolNft" && value.phase === "describe") {
        const described = JSON.parse(await native.execute(operation, input));
        return JSON.stringify({ ...described, ftDecimal: 0 });
      }
      if (operation === "preparePoolNft" && value.phase === "select") {
        selected = true;
        assert.equal(value.ftDecimal, 0, "FT precision must remain unchanged");
        assert.equal(value.amount, "0.001", "1000 LP atomic = 0.001 LP, not 1000 LP");
        return JSON.stringify({ ownerFtCandidates: [], poolFtCandidates: [], ftlpCandidates: [] });
      }
      return native.execute(operation, input);
    },
  };
  await assert.rejects(loader(() => response({ utxos: [] }), provider)({
    operation: "consumeLp", addressFrom: fixture.address, receiver: fixture.address,
    contractId: fixture.poolContractId, lpAmount: "1000",
  }), /Pool consume requires Pool-held FT and FT-LP inputs/);
  assert.equal(selected, true);
});

test("official successful Pool LP null index is the explicit empty index", async () => {
  const result = await loader(() => response({ utxos: null }))(request);
  assert.equal(result.kind, "ftlp");
  assert.equal(result.poolContractId, fixture.poolContractId);
  assert.equal(result.ftContractId, fixture.ftContractId);
  assert.equal(result.currentPoolTxid, fixture.poolInfo.txid);
  assert.deepEqual(result.utxos, []);
});

test("Pool LP empty-index normalization remains fail-closed", async () => {
  for (const [label, finalResponse] of [
    ["missing", () => response({})],
    ["wrong type", () => response({ utxos: "" })],
    ["business error", () => response({ utxos: null }, { code: "500", message: "failed" })],
    ["HTTP error", () => response({ utxos: null }, { status: 500 })],
  ]) {
    await assert.rejects(loader(finalResponse)(request), undefined, label);
  }
});

test("all existing Pool LP index consumers share explicit-null semantics", async () => {
  const empty = () => response({ utxos: null });
  await assert.rejects(
    loader(empty, emptySelectingNative)({
      operation: "consumeLp",
      addressFrom: fixture.address,
      contractId: fixture.poolContractId,
      receiver: fixture.address,
      lpAmount: "1",
    }),
    /Pool consume requires Pool-held FT and FT-LP inputs/u,
  );
  await assert.rejects(
    loader(empty, emptySelectingNative)({
      operation: "burnFtlp",
      addressFrom: fixture.address,
      contractId: fixture.poolContractId,
    }),
    /Pool maintenance requires a bounded input selection/u,
  );
});
