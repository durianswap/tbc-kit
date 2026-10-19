import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import fixture from "./fixtures/controlled-pool.json" with { type: "json" };
import {
  TBC_ATOMIC_DECIMALS,
  TransferVerificationError,
  createTbcClient,
  createWasmTbcKeylessEngine,
  formatTbcAtomicAmount,
  parseTbcDisplayAmount,
  verifyTransfer,
} from "../dist/esm/index.js";
import { assertTestnetAddress, createTestnetClient, inspectTbcTransaction } from "../dist/esm/api.js";

const ORIGIN = "https://receipt.test";
const ADDRESS = fixture.address;
const SCRIPT = assertTestnetAddress(ADDRESS).scriptPubKey;
const NATIVE_RAW = [
  "0a000000", "01", "00".repeat(32), "00000000", "00", "ffffffff", "01",
  "404b4c0000000000", "19", SCRIPT, "00000000",
].join("");
const NFT_ADDRESS = "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH";
const NFT_COLLECTION = "08".repeat(32);
const NFT_RAW = "0a0000000108080808080808080808080808080808080808080808080808080808080808080700000000ffffffff03c8000000000000008c5179537f01147f756b756ba87e6c7e786b6b7e6c7ea87e7801247f756b6ba87e6c7eaa56ba01207f547f7581008888786b7e7ea87e7e7eaa6c6c7601207f816b537a887c6c6c766b7b87630088756775240808080808080808080808080808080808080808080808080808080808080808070000008868786c887e7ea857ba8876a96c88ac6a0533436f646564000000000000002876a914751e76e8199196d454941c45d1b3a323f1433bd688ac6a0d56302043757272204e486f6c64000000000000000065006a4c5b7b226e66744e616d65223a2252656365697074204e4654222c2273796d626f6c223a22524e4654222c226465736372697074696f6e223a22726563656970742066697874757265222c2261747472696275746573223a225b5d227d054e5461706500000000";
const NFT_CONTRACT = inspectTbcTransaction(NFT_RAW).txid;
const WASM_URL = new URL("../artifacts/wasm/tbc_keyless_wasm.wasm", import.meta.url);

function response(data, code = "200", status = 200, url) {
  const value = new Response(JSON.stringify({ code, data }), {
    status,
    headers: { "content-type": "application/json" },
  });
  if (url !== undefined) Object.defineProperty(value, "url", { value: url });
  return value;
}

function decoded(raw, confirmations = "0", addresses = {}) {
  const inspected = inspectTbcTransaction(raw);
  return {
    txid: inspected.txid,
    hex: raw,
    confirmations,
    vout: inspected.transaction.outputs.map((output, n) => ({
      n,
      valueSat: output.satoshis.toString(),
      scriptPubKey: {
        hex: Buffer.from(output.scriptPubKey).toString("hex"),
        addresses: addresses[n] ?? [],
      },
    })),
  };
}

function controlledFetch({ transactions = {}, mempool = [], ftMetadata, nftMetadata } = {}) {
  const trace = [];
  const fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    trace.push(`${init?.method ?? "GET"} ${url.pathname}`);
    const txid = url.pathname.match(/^\/api\/tbc\/decode\/txid\/([0-9a-f]{64})$/u)?.[1];
    if (txid !== undefined) {
      return transactions[txid] === undefined
        ? response({}, "404", 404)
        : response(transactions[txid]);
    }
    if (url.pathname === "/api/tbc/mempooltxs") {
      if (mempool instanceof Error) throw mempool;
      return mempool instanceof Response ? mempool : response(mempool);
    }
    const contractId = url.pathname.match(/^\/api\/tbc\/ft\/info\/contract\/([0-9a-f]{64})$/u)?.[1];
    if (contractId !== undefined && ftMetadata?.contractId === contractId) {
      return response(ftMetadata.data);
    }
    const nftId = url.pathname.match(/^\/api\/tbc\/nft\/nftinfo\/nftid\/([0-9a-f]{64})$/u)?.[1];
    if (nftId !== undefined && nftMetadata?.contractId === nftId) {
      return response(nftMetadata.info);
    }
    const history = url.pathname.match(/^\/api\/tbc\/nft\/history\/address\/([^/]+)\/nftid\/([0-9a-f]{64})\/start\/(\d+)\/end\/(\d+)$/u);
    if (history !== null && nftMetadata?.contractId === history[2]) {
      const start = Number(history[3]);
      return response(typeof nftMetadata.historyPage === "function"
        ? nftMetadata.historyPage(start, Number(history[4]))
        : nftMetadata.history);
    }
    throw new Error(`Unexpected controlled request: ${url.pathname}`);
  };
  return { fetch, trace };
}

function base(txid, fetch, asset, recipient = { address: ADDRESS }) {
  return {
    network: "testnet",
    baseUrl: ORIGIN,
    allowedOrigins: [ORIGIN],
    fetch,
    txid,
    recipient,
    asset,
    minimumConfirmations: "0",
    now: () => Date.parse("2026-09-18T00:00:00Z"),
  };
}

test("atomic amount helpers are exact and reject excess precision", () => {
  assert.equal(TBC_ATOMIC_DECIMALS, 6);
  assert.equal(formatTbcAtomicAmount("5000000", 6), "5");
  assert.equal(formatTbcAtomicAmount("1", 6), "0.000001");
  assert.equal(parseTbcDisplayAmount("5.000001", 6), "5000001");
  assert.throws(() => parseTbcDisplayAmount("0.0000001", 6), TransferVerificationError);
});

test("TBC receipt keeps content, amount, and confirmation policy independent", async () => {
  const native = decoded(NATIVE_RAW, "3", { 0: [ADDRESS] });
  const network = controlledFetch({ transactions: { [native.txid]: native } });
  const exact = await verifyTransfer({
    ...base(native.txid, network.fetch, { kind: "tbc" }),
    amount: { mode: "exact", atomic: "5000000" },
    minimumConfirmations: "4",
  });
  assert.equal(exact.content.status, "matched");
  assert.deepEqual(exact.content.amount, {
    expectation: "exact", expectedAtomic: "5000000", status: "matched",
    actualAtomic: "5000000", decimals: 6, actualDisplay: "5",
  });
  assert.deepEqual(exact.policy, { minimumConfirmations: "4", status: "insufficient" });
  assert.deepEqual(exact.queries, { decode: 1, mempool: 0, assetMetadata: 0, transactionRaw: 0, post: 0 });

  const unchecked = await verifyTransfer(base(native.txid, network.fetch, { kind: "tbc" }));
  assert.equal(unchecked.content.amount.expectation, "not-checked");
  assert.equal(unchecked.content.amount.status, "not-checked");
  assert.equal(unchecked.content.amount.actualAtomic, "5000000");
  assert.equal(network.trace.filter((item) => item.includes("/decode/")).length, 2);
  assert.equal(network.trace.some((item) => item.includes("txraw") || item.startsWith("POST ")), false);
});

test("missing confirmations fail closed while explicit zero remains mempool", async () => {
  const explicitZero = decoded(NATIVE_RAW, "0", { 0: [ADDRESS] });
  const withoutConfirmations = { ...explicitZero };
  delete withoutConfirmations.confirmations;
  const missingNetwork = controlledFetch({
    transactions: { [withoutConfirmations.txid]: withoutConfirmations },
  });
  const missing = await verifyTransfer(base(
    withoutConfirmations.txid,
    missingNetwork.fetch,
    { kind: "tbc" },
  ));
  assert.deepEqual(missing.observation, { status: "invalid-response", code: "NODE_RESPONSE_INVALID" });
  assert.deepEqual(missing.policy, { minimumConfirmations: "0", status: "unavailable" });
  assert.equal(missing.content.status, "unavailable");
  assert.deepEqual(missing.queries, { decode: 1, mempool: 0, assetMetadata: 0, transactionRaw: 0, post: 0 });
  assert.deepEqual(missingNetwork.trace, [`GET /api/tbc/decode/txid/${withoutConfirmations.txid}`]);

  const zeroNetwork = controlledFetch({
    transactions: { [explicitZero.txid]: explicitZero },
  });
  const zero = await verifyTransfer(base(explicitZero.txid, zeroNetwork.fetch, { kind: "tbc" }));
  assert.deepEqual(zero.observation, { status: "mempool", confirmations: "0" });
  assert.deepEqual(zero.policy, { minimumConfirmations: "0", status: "satisfied" });
  assert.equal(zeroNetwork.trace.some((item) => item.includes("mempooltxs")), false);

  const statusNetwork = controlledFetch({
    transactions: { [withoutConfirmations.txid]: withoutConfirmations },
  });
  const statusClient = createTestnetClient({
    baseUrl: ORIGIN,
    allowedOrigins: [ORIGIN],
    fetch: statusNetwork.fetch,
  });
  await assert.rejects(
    statusClient.getTransactionStatus(withoutConfirmations.txid),
    (error) => error?.code === "NODE_RESPONSE_INVALID",
  );
});

test("invalid confirmation metadata fails closed without mempool inference", async () => {
  const transaction = decoded(NATIVE_RAW, "0", { 0: [ADDRESS] });
  delete transaction.confirmations;

  const invalid = { ...transaction, confirmations: "-1" };
  const invalidNetwork = controlledFetch({
    transactions: { [transaction.txid]: invalid },
    mempool: [transaction.txid],
  });
  const result = await verifyTransfer(base(transaction.txid, invalidNetwork.fetch, { kind: "tbc" }));
  assert.deepEqual(result.observation, { status: "invalid-response", code: "NODE_RESPONSE_INVALID" });
  assert.equal(result.content.status, "unavailable");
  assert.equal(invalidNetwork.trace.some((item) => item.includes("mempooltxs")), false);

  const nullDataNetwork = controlledFetch({
    transactions: { [transaction.txid]: null },
    mempool: [transaction.txid],
  });
  const nullData = await verifyTransfer(base(transaction.txid, nullDataNetwork.fetch, { kind: "tbc" }));
  assert.deepEqual(nullData.observation, { status: "invalid-response", code: "NODE_RESPONSE_INVALID" });
  assert.equal(nullData.content.status, "unavailable");
  assert.equal(nullDataNetwork.trace.some((item) => item.includes("mempooltxs")), false);
});

test("construction raw-transaction reads reject missing confirmations without mempool I/O", async () => {
  const transaction = decoded(NATIVE_RAW, "0", { 0: [ADDRESS] });
  delete transaction.confirmations;
  const network = controlledFetch({
    transactions: { [transaction.txid]: transaction },
  });
  const client = createTestnetClient({
    baseUrl: ORIGIN,
    allowedOrigins: [ORIGIN],
    fetch: network.fetch,
  });
  await assert.rejects(
    client.getRawTransaction(transaction.txid),
    (error) => error?.code === "NODE_RESPONSE_INVALID",
  );
  assert.deepEqual(network.trace, [`GET /api/tbc/decode/txid/${transaction.txid}`]);
});

test("receipt fetch rejects a cross-origin final response URL and requests redirect errors", async () => {
  const transaction = decoded(NATIVE_RAW, "1", { 0: [ADDRESS] });
  let redirect;
  const allowedFetch = async (input, init) => {
    redirect = init?.redirect;
    return response(transaction, "200", 200, String(input));
  };
  const allowed = await verifyTransfer(base(transaction.txid, allowedFetch, { kind: "tbc" }));
  assert.equal(allowed.content.status, "matched");
  assert.equal(redirect, "error");

  const redirected = await verifyTransfer(base(
    transaction.txid,
    async (_input, init) => {
      assert.equal(init?.redirect, "error");
      return response(transaction, "200", 200, `https://redirected.example/api/tbc/decode/txid/${transaction.txid}`);
    },
    { kind: "tbc" },
  ));
  assert.deepEqual(redirected.observation, {
    status: "invalid-response",
    code: "NODE_RESPONSE_INVALID",
  });
  assert.equal(redirected.content.status, "unavailable");

  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (_input, init) => {
      assert.equal(init?.redirect, "error");
      return response(transaction, "200", 200, `https://redirected.example/api/tbc/decode/txid/${transaction.txid}`);
    };
    const defaultOptions = base(transaction.txid, undefined, { kind: "tbc" });
    delete defaultOptions.fetch;
    const defaultRedirected = await verifyTransfer(defaultOptions);
    assert.deepEqual(defaultRedirected.observation, {
      status: "invalid-response",
      code: "NODE_RESPONSE_INVALID",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("FT receipt binds contract, recipient, atomic quantity, and metadata decimals", async () => {
  const raw = fixture.rawTransactions[fixture.ownerCandidate.txid];
  const transaction = decoded(raw, "0", { 0: [ADDRESS] });
  const creation = inspectTbcTransaction(fixture.rawTransactions[fixture.ftContractId]);
  const codeScript = Buffer.from(creation.transaction.outputs[0].scriptPubKey).toString("hex");
  const tapeScript = Buffer.from(creation.transaction.outputs[1].scriptPubKey).toString("hex");
  const network = controlledFetch({
    transactions: { [transaction.txid]: transaction },
    ftMetadata: {
      contractId: fixture.ftContractId,
      data: {
        code_script: codeScript,
        tape_script: tapeScript,
        amount: "100000000",
        decimal: 6,
        name: "Controlled Pool Token",
        symbol: "CPT",
      },
    },
  });
  const inspector = await createWasmTbcKeylessEngine(await readFile(WASM_URL));
  const result = await verifyTransfer({
    ...base(transaction.txid, network.fetch, { kind: "ft", contractId: fixture.ftContractId }),
    amount: { mode: "minimum", atomic: "500000" },
    assetInspector: inspector,
  });
  assert.equal(result.content.status, "matched");
  assert.equal(result.content.asset.identity, fixture.ftContractId);
  assert.deepEqual(result.content.amount, {
    expectation: "minimum", expectedAtomic: "500000", status: "matched",
    actualAtomic: "500000", decimals: 6, actualDisplay: "0.5",
  });
  assert.deepEqual(result.queries, { decode: 1, mempool: 0, assetMetadata: 1, transactionRaw: 0, post: 0 });
  assert.equal(network.trace.length, 2);
});

test("NFT receipt binds contract metadata, indexed recipient history, and canonical hold owner as one item", async () => {
  const transaction = decoded(NFT_RAW, "1", { 1: [NFT_ADDRESS] });
  const nftMetadata = {
    contractId: NFT_CONTRACT,
    info: {
      collection_id: NFT_COLLECTION,
      collection_index: 7,
      nft_contract_id: NFT_CONTRACT,
      nft_holder: NFT_ADDRESS,
      nft_transfer_count: 0,
    },
    history: {
      address: NFT_ADDRESS,
      collection_id: NFT_COLLECTION,
      collection_index: 7,
      nft_contract_id: NFT_CONTRACT,
      history_count: 1,
      result: [{ txid: transaction.txid, sender_address: NFT_ADDRESS, recipient_address: NFT_ADDRESS }],
    },
  };
  const nftNetwork = controlledFetch({ transactions: { [transaction.txid]: transaction }, nftMetadata });
  const inspector = await createWasmTbcKeylessEngine(await readFile(WASM_URL));
  const result = await verifyTransfer({
    ...base(
      transaction.txid,
      nftNetwork.fetch,
      { kind: "nft", contractId: NFT_CONTRACT },
      { address: NFT_ADDRESS },
    ),
    assetInspector: inspector,
  });
  assert.equal(result.content.status, "matched");
  assert.equal(result.content.asset.identity, NFT_CONTRACT);
  assert.deepEqual(result.content.amount, {
    expectation: "nft-singleton", status: "matched", actualAtomic: "1",
  });
  assert.deepEqual(result.queries, { decode: 1, mempool: 0, assetMetadata: 2, transactionRaw: 0, post: 0 });
  assert.equal(nftNetwork.trace.length, 3);
});

test("NFT history pagination finds a later-page transfer within the bounded budget", async () => {
  const transaction = decoded(NFT_RAW, "1", { 1: [NFT_ADDRESS] });
  const decoys = (start, count) => Array.from({ length: count }, (_, index) => ({
    txid: (start + index + 1).toString(16).padStart(64, "0"),
    sender_address: NFT_ADDRESS,
    recipient_address: NFT_ADDRESS,
  }));
  const nftMetadata = {
    contractId: NFT_CONTRACT,
    info: {
      collection_id: NFT_COLLECTION,
      collection_index: 7,
      nft_contract_id: NFT_CONTRACT,
      nft_holder: NFT_ADDRESS,
      nft_transfer_count: 101,
    },
    historyPage(start) {
      return {
        address: NFT_ADDRESS,
        nft_contract_id: NFT_CONTRACT,
        history_count: 101,
        result: start === 0
          ? decoys(0, 100)
          : [{ txid: transaction.txid, sender_address: NFT_ADDRESS, recipient_address: NFT_ADDRESS }],
      };
    },
  };
  const network = controlledFetch({ transactions: { [transaction.txid]: transaction }, nftMetadata });
  const inspector = await createWasmTbcKeylessEngine(await readFile(WASM_URL));
  const result = await verifyTransfer({
    ...base(transaction.txid, network.fetch, { kind: "nft", contractId: NFT_CONTRACT }, { address: NFT_ADDRESS }),
    assetInspector: inspector,
  });
  assert.equal(result.content.status, "matched");
  assert.deepEqual(result.queries, { decode: 1, mempool: 0, assetMetadata: 3, transactionRaw: 0, post: 0 });
  assert.equal(network.trace.filter((item) => item.includes("/nft/history/")).length, 2);
});

test("NFT history beyond the five-page budget is unavailable rather than mismatched", async () => {
  const transaction = decoded(NFT_RAW, "1", { 1: [NFT_ADDRESS] });
  const nftMetadata = {
    contractId: NFT_CONTRACT,
    info: {
      collection_id: NFT_COLLECTION,
      collection_index: 7,
      nft_contract_id: NFT_CONTRACT,
      nft_holder: NFT_ADDRESS,
      nft_transfer_count: 600,
    },
    historyPage(start) {
      return {
        address: NFT_ADDRESS,
        nft_contract_id: NFT_CONTRACT,
        history_count: 600,
        result: Array.from({ length: 100 }, (_, index) => ({
          txid: (start + index + 1).toString(16).padStart(64, "0"),
          sender_address: NFT_ADDRESS,
          recipient_address: NFT_ADDRESS,
        })),
      };
    },
  };
  const network = controlledFetch({ transactions: { [transaction.txid]: transaction }, nftMetadata });
  const inspector = await createWasmTbcKeylessEngine(await readFile(WASM_URL));
  const result = await verifyTransfer({
    ...base(transaction.txid, network.fetch, { kind: "nft", contractId: NFT_CONTRACT }, { address: NFT_ADDRESS }),
    assetInspector: inspector,
  });
  assert.equal(result.content.status, "unavailable");
  assert.equal(result.content.asset.status, "unavailable");
  assert.equal(result.content.reasons.includes("NFT_HISTORY_INCOMPLETE"), true);
  assert.equal(result.content.reasons.includes("NFT_HISTORY_MISMATCH"), false);
  assert.deepEqual(result.queries, { decode: 1, mempool: 0, assetMetadata: 6, transactionRaw: 0, post: 0 });
  assert.equal(network.trace.filter((item) => item.includes("/nft/history/")).length, 5);
});

test("client-bound receipt verification inherits mainnet/testnet/custom API configuration without cross-network sharing", async () => {
  const transaction = decoded(NATIVE_RAW, "1", { 0: [ADDRESS] });
  const mainnet = controlledFetch({ transactions: { [transaction.txid]: transaction } });
  const testnet = controlledFetch({ transactions: { [transaction.txid]: transaction } });
  const mainClient = createTbcClient({
    network: "mainnet",
    api: { baseUrl: "https://mainnet-proxy.example", fetch: mainnet.fetch },
  });
  const testClient = createTbcClient({ network: "testnet", api: { fetch: testnet.fetch } });
  const input = {
    txid: transaction.txid,
    recipient: { address: ADDRESS },
    asset: { kind: "tbc" },
    minimumConfirmations: "0",
  };
  const [mainA, mainB, test] = await Promise.all([
    mainClient.verifyTransfer(input),
    mainClient.verifyTransfer(input),
    testClient.verifyTransfer(input),
  ]);
  assert.equal(mainA.source.network, "mainnet");
  assert.equal(mainA.source.chainId, "tbc:mainnet");
  assert.equal(mainA.source.origin, "https://mainnet-proxy.example");
  assert.equal(mainB.content.status, "matched");
  assert.equal(test.source.network, "testnet");
  assert.equal(test.source.chainId, "tbc:testnet");
  assert.equal(test.source.origin, "https://api.tbcdev.org");
  assert.equal(mainnet.trace.length, 1, "same-client concurrent decode must single-flight");
  assert.equal(testnet.trace.length, 1, "testnet must use its own configured client");
});

test("not-found, request failure, and invalid node response stay distinguishable", async () => {
  const txid = "11".repeat(32);
  const missing = controlledFetch();
  const notFound = await verifyTransfer(base(txid, missing.fetch, { kind: "tbc" }));
  assert.equal(notFound.observation.status, "not-found");
  assert.equal(notFound.content.status, "unavailable");

  const requestFailed = await verifyTransfer(base(txid, async () => { throw new Error("offline"); }, { kind: "tbc" }));
  assert.deepEqual(requestFailed.observation, { status: "request-failed", code: "NODE_REQUEST_FAILED" });

  const invalid = await verifyTransfer(base(txid, async () => new Response("not json"), { kind: "tbc" }));
  assert.deepEqual(invalid.observation, { status: "invalid-response", code: "NODE_RESPONSE_INVALID" });
});
