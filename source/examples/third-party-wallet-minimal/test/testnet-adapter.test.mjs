import assert from "node:assert/strict";
import test from "node:test";

import { secp256k1 } from "@noble/curves/secp256k1.js";

import {
  TestnetAcceptanceError,
  createCredentialFreeTestnetRecord,
  createTbcTestnetRestNodeAccess,
  refreshTbcTestnetAcceptance,
  runTbcTestnetAcceptance,
} from "../dist/esm/testnet-adapter.js";
import {
  createTransferFixture,
  MAINNET_CHAIN_ID,
  TESTNET_CHAIN_ID,
  TESTNET_PROFILE,
} from "../dist/esm/fixtures.js";
import { testEngineBackend } from "./node-wasm-backend.mjs";

const PRIVATE_KEY_HEX = "01".padStart(64, "0");
const PACKAGE_COMMIT = "1d27f5eb300ed68026cfb4791f1ad034c37146ec";

function signDigest(task) {
  return {
    taskId: task.taskId,
    signatureEncoding: "compact64",
    signature: secp256k1
      .sign(task.digest, PRIVATE_KEY_HEX, { prehash: false, lowS: true })
      .toCompactHex(),
  };
}

function testnetInput({ authorizeBroadcast, status = "confirmed" } = {}) {
  const reference = createTransferFixture({
    chainId: TESTNET_CHAIN_ID,
    amount: "1500",
    clientRequestId: "reference",
    utxos: "multi",
  });
  const parentByTxid = new Map(
    reference.snapshot.payload.parents.map((parent) => [parent.txid, parent]),
  );
  const broadcastRaw = [];
  const node = {
    async readTip() {
      return {
        height: "1000",
        hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      };
    },
    async listUnspent(address) {
      assert.equal(address, reference.account.address);
      return reference.snapshot.payload.utxos.map((utxo) => ({
        txid: utxo.txid,
        vout: utxo.vout,
        satoshis: utxo.satoshis,
        height: "900",
      }));
    },
    async readTransaction(txid) {
      const parent = parentByTxid.get(txid);
      assert.ok(parent, txid);
      const utxo = reference.snapshot.payload.utxos.find(
        (candidate) => candidate.txid === txid,
      );
      assert.ok(utxo, txid);
      return {
        txid,
        rawTransaction: parent.rawTransaction,
        outputs: [{
          vout: utxo.vout,
          scriptPubKey: utxo.scriptPubKey,
          addresses: [reference.account.address],
        }],
      };
    },
    async broadcast(rawTransaction) {
      broadcastRaw.push(rawTransaction);
      return { txid: "unused-unless-authorized" };
    },
    async transactionStatus(txid) {
      return { txid, status, confirmations: status === "confirmed" ? "1" : "0" };
    },
  };
  return {
    input: {
      node,
      engineBackend: testEngineBackend,
      source: {
        address: reference.account.address,
        publicKey: reference.account.publicKey,
      },
      destination: reference.request.intent.to,
      amount: "1500",
      clientRequestId: "real-testnet-acceptance",
      expiresAt: "2026-09-02T00:05:00Z",
      packageCommit: PACKAGE_COMMIT,
      policy: {
        feeRateSatPerKb: "80",
        dustThreshold: "24",
        minConfirmations: "1",
        maxFee: "200",
      },
      signer: signDigest,
      clockNow: () => "2026-09-02T00:00:00Z",
      ...(authorizeBroadcast === undefined ? {} : { authorizeBroadcast }),
    },
    broadcastRaw,
  };
}

test("uses TBC's 1-prefixed P2PKH format on the official testnet", () => {
  const mainnet = createTransferFixture({
    chainId: MAINNET_CHAIN_ID,
    amount: "100",
    clientRequestId: "mainnet-address-reference",
    utxos: "single",
  });
  const testnet = createTransferFixture({
    chainId: TESTNET_CHAIN_ID,
    amount: "100",
    clientRequestId: "testnet-address-reference",
    utxos: "single",
  });

  assert.equal(TESTNET_PROFILE.p2pkhVersion, 0x00);
  assert.match(testnet.account.address, /^1/);
  assert.match(testnet.request.intent.to, /^1/);
  assert.equal(testnet.account.address, mainnet.account.address);
  assert.equal(testnet.request.intent.to, mainnet.request.intent.to);
  assert.notEqual(testnet.account.accountId, mainnet.account.accountId);
});

test("dry-runs the live snapshot and verified signer without broadcasting", async () => {
  const { input, broadcastRaw } = testnetInput();
  const result = await runTbcTestnetAcceptance(input);

  assert.equal(result.status, "dry-run");
  assert.equal(result.preview.chainId, TESTNET_CHAIN_ID);
  assert.equal(result.preview.transactions.length, 1);
  assert.match(result.preview.approvalFingerprint, /^[0-9a-f]{64}$/);
  assert.equal(broadcastRaw.length, 0);
  assert.throws(
    () => createCredentialFreeTestnetRecord(result),
    (error) =>
      error instanceof TestnetAcceptanceError &&
      error.code === "CONFIRMATION_REQUIRED",
  );
  assert.throws(
    () => createCredentialFreeTestnetRecord({
      ...result,
      status: "confirmed",
      transactionStatuses: result.transactionIds.map((txid) => ({
        txid,
        status: "mempool",
        confirmations: "0",
      })),
    }),
    (error) =>
      error instanceof TestnetAcceptanceError &&
      error.code === "CONFIRMATION_REQUIRED",
  );
});

test("requires an exact preview echo before the public pipeline can broadcast", async () => {
  const denied = testnetInput({
    authorizeBroadcast: async () => ({
      status: "approved",
      approvalFingerprint: "0".repeat(64),
    }),
  });
  await assert.rejects(
    runTbcTestnetAcceptance(denied.input),
    (error) =>
      error instanceof TestnetAcceptanceError &&
      error.code === "AUTHORIZATION_MISMATCH",
  );
  assert.equal(denied.broadcastRaw.length, 0);

  let approvedPreview;
  const approved = testnetInput({
    authorizeBroadcast: async (preview) => {
      approvedPreview = preview;
      return {
        status: "approved",
        approvalFingerprint: preview.approvalFingerprint,
      };
    },
  });
  approved.input.node.broadcast = async (rawTransaction) => {
    approved.broadcastRaw.push(rawTransaction);
    return { txid: approvedPreview.transactions[0].txid };
  };
  const result = await runTbcTestnetAcceptance(approved.input);

  assert.equal(result.status, "confirmed");
  assert.equal(approved.broadcastRaw.length, 1);
  const record = createCredentialFreeTestnetRecord(result);
  assert.deepEqual(Object.keys(record), [
    "schemaVersion",
    "status",
    "chainId",
    "sourceAddress",
    "destinationAddress",
    "transactionIds",
    "packageCommit",
    "preparedAt",
    "verifiedAt",
  ]);
  assert.equal(JSON.stringify(record).includes(approved.broadcastRaw[0]), false);
});

test("normalizes the official REST contract without accepting URL credentials", async () => {
  assert.throws(
    () => createTbcTestnetRestNodeAccess({
      baseUrl: "https://token@example.test",
      fetch,
    }),
    (error) =>
      error instanceof TestnetAcceptanceError && error.code === "INVALID_INPUT",
  );
  const txid = "a".repeat(64);
  const calls = [];
  const node = createTbcTestnetRestNodeAccess({
    baseUrl: "https://api.tbcdev.org",
    async fetch(url, init) {
      const requestUrl = new URL(url);
      calls.push({ path: requestUrl.pathname, init });
      let data;
      switch (requestUrl.pathname) {
        case "/api/tbc/nodeinfo":
          data = { blocks: 1000, bestblockhash: "b".repeat(64) };
          break;
        case "/api/tbc/utxo/address/source-address":
          data = { utxos: [{ txid, index: 1, value: 500, height: 990 }] };
          break;
        case `/api/tbc/txraw/txid/${txid}`:
          data = { txraw: "00" };
          break;
        case `/api/tbc/decode/txid/${txid}`:
          data = {
            txid,
            hex: "00",
            confirmations: 2,
            vout: [{
              n: 1,
              scriptPubKey: { hex: "51", addresses: ["source-address"] },
            }],
          };
          break;
        case "/api/tbc/broadcasttx":
          assert.deepEqual(JSON.parse(init.body), { txraw: "00" });
          data = { txid };
          break;
        default:
          throw new Error(`unexpected ${requestUrl.pathname}`);
      }
      return new Response(JSON.stringify({ code: "200", data }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  assert.deepEqual(await node.readTip(), {
    height: "1000",
    hash: "b".repeat(64),
  });
  assert.deepEqual(await node.listUnspent("source-address"), [{
    txid,
    vout: 1,
    satoshis: "500",
    height: "990",
  }]);
  assert.equal((await node.readTransaction(txid)).outputs[0].scriptPubKey, "51");
  assert.deepEqual(await node.broadcast("00"), { txid });
  assert.deepEqual(await node.transactionStatus(txid), {
    txid,
    status: "confirmed",
    confirmations: "2",
  });
  assert.equal(calls.some(({ init }) => init?.method === "POST"), true);
});

test("keeps an accepted broadcast pending when confirmation lookup races", async () => {
  let approvedPreview;
  const pending = testnetInput({
    authorizeBroadcast: async (preview) => {
      approvedPreview = preview;
      return {
        status: "approved",
        approvalFingerprint: preview.approvalFingerprint,
      };
    },
  });
  pending.input.node.broadcast = async (rawTransaction) => {
    pending.broadcastRaw.push(rawTransaction);
    return { txid: approvedPreview.transactions[0].txid };
  };
  pending.input.node.transactionStatus = async () => {
    throw new Error("indexer has not observed the accepted transaction yet");
  };

  const result = await runTbcTestnetAcceptance(pending.input);
  assert.equal(result.status, "broadcast");
  assert.deepEqual(result.transactionStatuses, [{
    txid: result.transactionIds[0],
    status: "unknown",
  }]);
  assert.equal(pending.broadcastRaw.length, 1);

  pending.input.node.transactionStatus = async (txid) => ({
    txid,
    status: "confirmed",
    confirmations: "1",
  });
  const confirmed = await refreshTbcTestnetAcceptance(
    pending.input.node,
    result,
    "2026-09-02T00:01:00Z",
  );
  assert.equal(confirmed.status, "confirmed");
  assert.equal(
    createCredentialFreeTestnetRecord(confirmed).verifiedAt,
    "2026-09-02T00:01:00Z",
  );
});

test("rechecks trusted time after operator approval and blocks an expired preview", async () => {
  let now = "2026-09-02T00:00:00Z";
  const expired = testnetInput({
    authorizeBroadcast: async (preview) => {
      now = "2026-09-02T00:06:00Z";
      return {
        status: "approved",
        approvalFingerprint: preview.approvalFingerprint,
      };
    },
  });
  expired.input.clockNow = () => now;

  await assert.rejects(runTbcTestnetAcceptance(expired.input));
  assert.equal(expired.broadcastRaw.length, 0);
});
