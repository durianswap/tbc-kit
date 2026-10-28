import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { hashCanonical, chainDataRequirement } from "@tbc-wallet/core";
import { createTbcOfficialApi } from "../dist/esm/api.js";
import { createTbcEngine, createWasmTbcEngineBackend } from "../dist/esm/engine.js";
import { createDefaultTbcChainDataResolver } from "../dist/esm/wallet.js";
import { assertTestnetAddress, inspectTbcTransaction, turingTransactionId } from "../dist/esm/api.js";

const CHAIN_ID = "tbc:testnet";
const ADDRESS = "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH";
const RECIPIENT = "1cMh228HTCiwS8ZsaakH8A8wze1JR5ZsP";
const ACCOUNT = Object.freeze({
  accountId: `${CHAIN_ID}:${ADDRESS}`,
  address: ADDRESS,
  chainId: CHAIN_ID,
  publicKey: "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
});
const SCRIPT = assertTestnetAddress(ADDRESS).scriptPubKey;
const NOW = "2026-09-20T00:00:00Z";
const EXPIRES = "2026-09-20T00:02:00Z";

function nativeRaw(tag) {
  return [
    "0a000000", "01", tag.repeat(32), "00000000", "00", "ffffffff", "01",
    "8096980000000000", "19", SCRIPT, "00000000",
  ].join("");
}

const native = ["11", "12", "13"].map((tag) => {
  const rawTransaction = nativeRaw(tag);
  return { txid: turingTransactionId(rawTransaction), rawTransaction };
});

function requirement(intent) {
  if (intent.type.startsWith('tbc721-standard-')) return chainDataRequirement({intent});
  if (intent.type === "tbc.collection.create") return {
    intentType: intent.type, assets: [{ kind: "native" }], includeAncestry: false,
  };
  const collection = intent.type === "tbc.nft.mint";
  const contractId = collection ? intent.collectionId : intent.contractId;
  return {
    intentType: intent.type,
    contractIds: [contractId],
    assets: [{ kind: "native" }, { kind: collection ? "collection" : "nft", contractId, minimumAmount: "1" }],
    includeAncestry: true,
  };
}

function policy() {
  const payload = Object.freeze({
    version: "1.0", policyId: "nft-three-step", revision: "1", chainId: CHAIN_ID,
    feeRateSatPerKb: "80", dustThreshold: "42", minConfirmations: "0",
    maxBundleTransactions: 32, sighashType: 65, contractPolicies: Object.freeze([]),
    amountLimits: Object.freeze([{ scope: "native", maximum: "2100000000000000" }]),
    expiresAt: "2026-09-20T00:05:00Z",
  });
  return Object.freeze({ payload, policyHash: hashCanonical(payload) });
}

function decoded(rawTransaction, confirmations = "0") {
  const inspected = inspectTbcTransaction(rawTransaction).transaction;
  const txid = turingTransactionId(rawTransaction);
  return {
    txid, rawTransaction, confirmations, inputs: inspected.inputs,
    outputs: inspected.outputs.map((output, vout) => ({
      vout, satoshis: output.satoshis.toString(),
      scriptPubKey: Buffer.from(output.scriptPubKey).toString("hex"), addresses: [],
    })),
  };
}

async function planIntent(engine, resolver, intent, sequence) {
  const snapshot = await resolver.resolve({
    version: "1.0", chainId: CHAIN_ID, accountId: ACCOUNT.accountId,
    requirement: requirement(intent),
  });
  assert.equal(snapshot.portError, undefined);
  const normalized = await engine.normalizeRequest({
    version: "1.0",
    request: {
      version: "1.0", chainId: CHAIN_ID, from: ADDRESS,
      clientRequestId: `nft-three-step-${sequence}`, intent,
      constraints: { expiresAt: EXPIRES, maxFee: "50000", feePreference: "standard" },
    },
  });
  const executionPolicy = policy();
  const params = {
    version: "1.0", request: normalized.request, requestHash: normalized.requestHash,
    snapshot, policy: executionPolicy,
  };
  const result = await engine.plan(params);
  assert.deepEqual(await engine.validate({ ...params, phase: "plan", plan: result.plan }), {
    valid: true, violations: [],
  });
  return { ...params, plan: result.plan };
}

for (const mediaBytes of [4, 70_000]) {
test(`collection create -> NFT mint -> NFT transfer retains ${mediaBytes} media bytes through Rust-WASM plans`, async () => {
  const mediaBuffer = mediaBytes === 4 ? Buffer.from([1, 2, 3, 4]) : Buffer.alloc(mediaBytes, 42);
  const media = { kind: "base64", mediaType: "image/png", data: mediaBuffer.toString("base64"),
    sha256: createHash("sha256").update(mediaBuffer).digest("hex") };
  const backend = await createWasmTbcEngineBackend(await readFile(
    new URL("../artifacts/wasm/tbc_engine_wasm.wasm", import.meta.url),
  ));
  const engine = createTbcEngine({ backend });
  const state = { phase: 0, collectionId: undefined, mintId: undefined };
  const calls = { collectionIndex: 0, nftIndex: 0, txoStatus: 0, raw: 0, decoded: 0 };
  const rawById = new Map(native.map((item) => [item.txid, item.rawTransaction]));
  const api = createTbcOfficialApi({
    baseUrl: "https://controlled.example",
    fetch: async (input, init) => {
      const url = String(input);
      if (url.includes("/api/tbc/nft/utxo/")) {
        calls.nftIndex += 1;
        const mintRaw = rawById.get(state.mintId);
        assert.ok(mintRaw);
        return new Response(JSON.stringify({ code: 200, message: "OK", data: { utxos: [{
          txid: state.mintId, vout: 0, value: 200, height: -1,
          nft_contract_id: state.mintId, collection_id: state.collectionId,
          script_pubkey: decoded(mintRaw).outputs[0].scriptPubKey,
        }] } }));
      }
      if (url.includes("/api/tbc/txo/status")) {
        calls.txoStatus += 1;
        assert.deepEqual(JSON.parse(String(init.body)), { txos: [{ txid: state.mintId, index: 1 }] });
        return new Response(JSON.stringify({ code: 200, message: "OK", data: { results: [{
          txid: state.mintId, index: 1, value: 100,
          scriptpubkey: `${SCRIPT}6a0d56302043757272204e486f6c64`, status: { spent: false },
        }] } }));
      }
      calls.collectionIndex += 1;
      return new Response(JSON.stringify({ code: 200, message: "OK", data: { utxos: [{
        txid: state.collectionId, index: 1, value: 100,
      }] } }));
    },
  });
  const client = {
    api,
    async getUtxos() {
      const funding = native[state.phase];
      return { tip: { height: "1000", hash: "aa".repeat(32) }, utxos: [{
        txid: funding.txid, vout: 0, satoshis: "10000000", height: "0",
      }] };
    },
    async getRawTransactionBytes(txid) {
      calls.raw += 1;
      const raw = rawById.get(txid);
      if (raw === undefined) throw new Error(`missing controlled raw ${txid}`);
      return raw;
    },
    async getRawTransaction(txid) {
      calls.decoded += 1;
      const raw = rawById.get(txid);
      if (raw === undefined) throw new Error(`missing controlled decoded raw ${txid}`);
      return decoded(raw);
    },
  };
  const resolver = createDefaultTbcChainDataResolver({
    accounts: { current: async () => [ACCOUNT] }, client,
    confirmationPolicy: { minConfirmations: "0" },
    now: () => Date.parse(NOW), snapshotId: (() => { let id = 0; return () => `snapshot-nft-${++id}`; })(),
  });

  const collectionIntent = {
    type: "tbc721-standard-create-collection", version: "1.0", name: "Kit Collection",
    description: "Controlled three-step collection", supply: "2",
    media: mediaBytes === 4 ? { kind: "uri", uri: "ipfs://kit-collection" } : media,
  };
  const collection = await planIntent(engine, resolver, collectionIntent, "collection");
  assert.equal(collection.plan.payload.transactions.length, 1);
  assert.equal(collection.plan.payload.transactions[0].id, "tbc721-standard-create-collection");
  assert.equal(collection.plan.payload.signingTasks.length, 1);
  assert.deepEqual(collection.plan.payload.preview.assetFlows.map(({ kind, direction, amount }) => ({ kind, direction, amount })), [
    { kind: "collection", direction: "create", amount: "2" },
    { kind: "native", direction: "fee", amount: collection.plan.payload.preview.totalFee },
  ]);
  const collectionRaw = collection.plan.payload.transactions[0].unsignedTransaction;
  state.collectionId = turingTransactionId(collectionRaw);
  rawById.set(state.collectionId, collectionRaw);
  resolver.rememberFinalizedTransaction({ txid: state.collectionId, rawTransaction: collectionRaw });

  state.phase = 1;
  const mint = await planIntent(engine, resolver, {
    type: "tbc721-standard-mint", version: "1.0", collectionId: state.collectionId, slot: 1,
    name: "Kit NFT", symbol: "KNFT", description: "Controlled NFT",
    attributes: [{ traitType: "rarity", value: "genesis" }],
    media,
  }, "mint");
  assert.equal(mint.snapshot.payload.utxos.filter((item) => item.classification === "collection-slot").length, 1);
  assert.equal(mint.snapshot.payload.contracts[0].contractId, state.collectionId);
  assert.equal(mint.snapshot.payload.contracts[0].standardId, 'tbc721-standard');
  assert.deepEqual(mint.snapshot.payload.contracts[0].currentOutpoint, {txid:state.collectionId,vout:1});
  assert.equal(mint.plan.payload.transactions[0].id, "tbc721-standard-mint-0");
  assert.equal(mint.plan.payload.signingTasks.length, 2);
  const mintRaw = mint.plan.payload.transactions[0].unsignedTransaction;
  state.mintId = turingTransactionId(mintRaw);
  rawById.set(state.mintId, mintRaw);
  resolver.rememberFinalizedTransaction({ txid: state.mintId, rawTransaction: mintRaw });

  state.phase = 2;
  const transfer = await planIntent(engine, resolver, {
    type: "tbc721-standard-transfer", version: "1.0", contractId: state.mintId, to: RECIPIENT,
  }, "transfer");
  assert.equal(transfer.snapshot.payload.utxos.filter((item) => item.classification === "nft").length, 2);
  assert.equal(transfer.snapshot.payload.contracts[0].contractId, state.mintId);
  assert.equal(transfer.snapshot.payload.contracts[0].standardId, 'tbc721-standard');
  assert.deepEqual(transfer.snapshot.payload.contracts[0].currentOutpoint, {txid:state.mintId,vout:0});
  assert.equal(transfer.plan.payload.transactions[0].id, "tbc721-standard-transfer");
  assert.equal(transfer.plan.payload.signingTasks.length, 3);
  assert.deepEqual(transfer.plan.payload.preview.assetFlows.map(({ kind, direction, amount, to }) => ({ kind, direction, amount, ...(to === undefined ? {} : { to }) })), [
    { kind: "nft", direction: "send", amount: "1", to: RECIPIENT },
    { kind: "native", direction: "fee", amount: transfer.plan.payload.preview.totalFee },
  ]);
  assert.deepEqual(calls, { collectionIndex: 1, nftIndex: 1, txoStatus: 0, raw: 0, decoded: 0 },
    "zero-floor immediate successor path reuses retained bytes and performs no confirmation decode");
});
}

test("NFT material fails closed on mismatched collection slot and positive-floor missing confirmation", async () => {
  const collectionRaw = [
    "0a000000", "01", "21".repeat(32), "00000000", "00", "ffffffff", "02",
    "0000000000000000", "02", "006a",
    "6400000000000000", "28", SCRIPT, "6a0d5630204d696e74204e486f6c64", "00000000",
  ].join("");
  const collectionId = turingTransactionId(collectionRaw);
  let decodedReads = 0;
  const client = {
    api: {
      async utxosByScriptHash() { return { utxos: [{ txid: collectionId, index: "1", value: "101" }] }; },
    },
    async getUtxos() { return { tip: { height: "1000", hash: "aa".repeat(32) }, utxos: [{ txid: native[0].txid, vout: 0, satoshis: "10000000", height: "0" }] }; },
    async getRawTransactionBytes() { return collectionRaw; },
    async getRawTransaction() { decodedReads += 1; throw new Error("confirmation unavailable"); },
  };
  const resolveWith = (minConfirmations) => createDefaultTbcChainDataResolver({
    accounts: { current: async () => [ACCOUNT] }, client, confirmationPolicy: { minConfirmations },
  }).resolve({ version: "1.0", chainId: CHAIN_ID, accountId: ACCOUNT.accountId, requirement: {
    intentType: "tbc.nft.mint", contractIds: [collectionId], includeAncestry: true,
    assets: [{ kind: "native" }, { kind: "collection", contractId: collectionId, minimumAmount: "1" }],
  } });
  const mismatch = await resolveWith("0");
  assert.equal(mismatch.portError.name, "CONFLICT");
  assert.equal(decodedReads, 0, "zero floor must not trigger a confirmation-only decode");
  client.api.utxosByScriptHash = async () => ({ utxos: [{ txid: collectionId, index: "1", value: "100" }] });
  const positive = await resolveWith("1");
  assert.ok(positive.portError);
  assert.equal(decodedReads, 1, "positive floor must require a fresh confirmation observation");
});

test("collection mint uses one exact TXO fallback only while the script index is lagging", async () => {
  const collectionRaw = [
    "0a000000", "01", "31".repeat(32), "00000000", "00", "ffffffff", "02",
    "0000000000000000", "02", "006a",
    "6400000000000000", "28", SCRIPT, "6a0d5630204d696e74204e486f6c64", "00000000",
  ].join("");
  const collectionId = turingTransactionId(collectionRaw);
  const resolveWith = async (statuses) => {
    let statusReads = 0;
    let decodedReads = 0;
    const client = {
      api: {
        async utxosByScriptHash() { return { utxos: [] }; },
        async txoStatus(input, options) {
          statusReads += 1;
          assert.deepEqual(input, { txos: [{ txid: collectionId, index: 1 }] });
          assert.equal(options.category, "asset-index");
          return { txos: statuses };
        },
      },
      async getUtxos() {
        return { tip: { height: "1000", hash: "aa".repeat(32) }, utxos: [{
          txid: native[0].txid, vout: 0, satoshis: "10000000", height: "0",
        }] };
      },
      async getRawTransactionBytes(txid) {
        assert.equal(txid, collectionId);
        return collectionRaw;
      },
      async getRawTransaction() { decodedReads += 1; throw new Error("zero floor must not decode"); },
    };
    const result = await createDefaultTbcChainDataResolver({
      accounts: { current: async () => [ACCOUNT] }, client,
      confirmationPolicy: { minConfirmations: "0" },
      snapshotId: () => "snapshot-index-lag",
    }).resolve({ version: "1.0", chainId: CHAIN_ID, accountId: ACCOUNT.accountId, requirement: {
      intentType: "tbc.nft.mint", contractIds: [collectionId], includeAncestry: true,
      assets: [{ kind: "native" }, { kind: "collection", contractId: collectionId, minimumAmount: "1" }],
    } });
    return { result, statusReads, decodedReads };
  };

  const available = await resolveWith([{
    txid: collectionId, index: "1", value: "100", spent: false,
    scriptPubKey: `${SCRIPT}6a0d5630204d696e74204e486f6c64`,
  }]);
  assert.equal(available.result.portError, undefined);
  assert.equal(available.result.payload.utxos.filter(item => item.classification === "collection-slot").length, 1);
  assert.equal(available.statusReads, 1);
  assert.equal(available.decodedReads, 0);

  const notIndexed = await resolveWith([]);
  assert.deepEqual(notIndexed.result.portError, {
    name: "UNAVAILABLE", retryable: true, message: "TBC chain data is temporarily unavailable",
  });

  const spent = await resolveWith([{ txid: collectionId, index: "1", value: "100", spent: true }]);
  assert.equal(spent.result.portError.name, "CONFLICT");
  assert.equal(spent.result.portError.retryable, false);
});
