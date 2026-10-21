import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hashCanonical } from "@tbc-wallet/core";
import { createTbcEngine, createWasmTbcEngineBackend } from "../dist/esm/engine.js";
import { parseTbcTransaction } from "../dist/esm/api.js";
import {
  createTbcBackendService,
  TbcBackendServiceError,
} from "../dist/esm/wallet.js";

const CHAIN_ID = "tbc:testnet";
const ADDRESS = "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH";
const ACCOUNT_ID = `${CHAIN_ID}:${ADDRESS}`;
const TO = "1cMh228HTCiwS8ZsaakH8A8wze1JR5ZsP";
const PRIVATE_KEY = "01".padStart(64, "0");
const PUBLIC_KEY = Buffer.from(secp256k1.getPublicKey(PRIVATE_KEY, true)).toString("hex");
const SCRIPT = "76a914751e76e8199196d454941c45d1b3a323f1433bd688ac";
const RAW_A = "0a00000001020000000000000000000000000000000000000000000000000000000000000001000000025101ffffffff01b0040000000000001976a914751e76e8199196d454941c45d1b3a323f1433bd688ac01000000";
const RAW_B = `${RAW_A.slice(0, -8)}02000000`;
const TXID_A = "ddb917e8cad41edda4a38fd8cb8cb51a8511c8bc51ab7f62b97a039af3d9125c";
const TXID_B = "6827ea3ab2a6f97e3ee48ba6202bdf9314b475d0cbbf644335dab449e77954c6";
const NOW = "2026-09-25T00:00:00Z";
const EXPIRES = "2026-09-25T00:05:00Z";
const account = Object.freeze({ accountId: ACCOUNT_ID, address: ADDRESS, chainId: CHAIN_ID, publicKey: PUBLIC_KEY });
const kitRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const wasmBackend = await createWasmTbcEngineBackend(await readFile(
  new URL("../artifacts/wasm/tbc_engine_wasm.wasm", import.meta.url),
));

test("backend example is sign-only by default and sends only after explicit opt-in", () => {
  const run = (...args) => JSON.parse(execFileSync(
    process.execPath,
    [resolve(kitRoot, "examples/backend-node/run.mjs"), ...args],
    { cwd: resolve(kitRoot, "../.."), encoding: "utf8" },
  ));
  const signed = run();
  assert.equal(signed.action, "sign");
  assert.equal(signed.submitCalls, 0);
  assert.equal(signed.reconcileCalls, 0);
  assert.equal(signed.externalPosts, 0);
  const sent = run("--send");
  assert.equal(sent.action, "send");
  assert.equal(sent.submitCalls, 1);
  assert.equal(sent.reconcileCalls, 1);
  assert.equal(sent.externalPosts, 0);
});

function snapshot(sequence = 0) {
  const payload = Object.freeze({
    version: "1.0",
    snapshotId: `backend-snapshot-${sequence}`,
    chainId: CHAIN_ID,
    block: Object.freeze({ height: "1000", hash: "aa".repeat(32) }),
    capturedAt: NOW,
    expiresAt: EXPIRES,
    account,
    utxos: Object.freeze([
      Object.freeze({ txid: TXID_A, vout: 0, satoshis: "1200", scriptPubKey: SCRIPT, confirmations: "100", classification: "native" }),
      Object.freeze({ txid: TXID_B, vout: 0, satoshis: "1200", scriptPubKey: SCRIPT, confirmations: "100", classification: "native" }),
    ]),
    parents: Object.freeze([
      Object.freeze({ txid: TXID_A, rawTransaction: RAW_A }),
      Object.freeze({ txid: TXID_B, rawTransaction: RAW_B }),
    ]),
    contracts: Object.freeze([]),
  });
  return Object.freeze({ payload, snapshotHash: hashCanonical(payload) });
}

function policy() {
  const payload = Object.freeze({
    version: "1.0",
    policyId: "backend-service-test",
    revision: "1",
    chainId: CHAIN_ID,
    feeRateSatPerKb: "80",
    dustThreshold: "24",
    minConfirmations: "1",
    maxBundleTransactions: 32,
    sighashType: 65,
    contractPolicies: Object.freeze([]),
    amountLimits: Object.freeze([Object.freeze({ scope: "native", maximum: "2100000000000000" })]),
    expiresAt: EXPIRES,
  });
  return Object.freeze({ payload, policyHash: hashCanonical(payload) });
}

function signer(observed) {
  return Object.freeze({
    async sign(params) {
      observed.push("signer");
      const signature = secp256k1.sign(params.task.digest, PRIVATE_KEY, { prehash: false, lowS: true });
      const recoverable = params.task.signatureEncoding === "compact65-recoverable";
      return Object.freeze({
        taskId: params.task.taskId,
        signatureEncoding: recoverable ? "compact65-recoverable" : "compact64",
        signature: recoverable
          ? `${(31 + signature.recovery).toString(16)}${signature.toCompactHex()}`
          : signature.toCompactHex(),
      });
    },
  });
}

function transaction(clientRequestId, txid = TXID_A) {
  return Object.freeze({
    version: "1.0",
    chainId: CHAIN_ID,
    from: ADDRESS,
    clientRequestId,
    intent: Object.freeze({ version: "1.0", type: "tbc.transfer", to: TO, amount: "1000" }),
    constraints: Object.freeze({ maxFee: "200", inputOutpoints: Object.freeze([{ txid, vout: 0 }]) }),
  });
}

test("backend prepares and signs a 500-input native merge with one approval and no extra data reads", async () => {
  let reads = 0, approvals = 0;
  const observed = [];
  const payload = { ...snapshot().payload, parents: [], utxos: Array.from({ length: 500 }, (_, i) => ({
    txid: (i + 1).toString(16).padStart(64, "0"), vout: 0, satoshis: "1200",
    scriptPubKey: SCRIPT, confirmations: "100", classification: "native",
  })) };
  const material = { payload, snapshotHash: hashCanonical(payload) };
  const service = createTbcBackendService({
    serviceId: "backend-native-merge-500", account, engine: createTbcEngine({ backend: wasmBackend }),
    network: { async resolveChainData() { reads++; return material; }, async resolvePolicy() { return policy(); } },
    signer: signer(observed), clock: () => NOW,
    authorize: async () => { approvals++; return { status: "approved", decisionId: "merge-500-once", approvedAt: NOW }; },
  });
  try {
    const prepared = await service.prepareTransaction({ version: "1.0", chainId: CHAIN_ID, from: ADDRESS,
      clientRequestId: "native-500", intent: { version: "1.0", type: "tbc.maintenance.merge" },
      constraints: { maxFee: "10000" } });
    const result = await service.executePrepared({ kind: "transaction", action: "sign", prepared });
    assert.equal(result.transactions.length, 1);
    assert.equal(parseTbcTransaction(result.transactions[0].rawTransaction).inputs.length, 500);
    assert.equal(observed.length, 500);
    assert.equal(approvals, 1);
    assert.equal(reads, 2, "one prepare read and one existing Prepared revalidation read, not per-input reads");
  } finally { service.close(); }
});

test("Prepared FTLP burn requests the same native, pool and LP material as wallet construction", async () => {
  const poolContractId = "ab".repeat(32);
  const reads = [];
  const stop = new Error("material boundary reached without signing");
  const service = createTbcBackendService({
    serviceId: "prepared-burn-requirement",
    account,
    engine: createTbcEngine({ backend: wasmBackend }),
    network: {
      async resolveChainData(input) { reads.push(input.requirement); throw stop; },
      async resolvePolicy() { return policy(); },
    },
  });
  try {
    await assert.rejects(service.prepareTransaction({
      ...transaction("prepared-burn"),
      intent: { version: "1.0", type: "tbc.pool.ftlp.burn", poolContractId },
      constraints: { maxFee: "10000" },
    }), error => error === stop);
    assert.deepEqual(reads, [{
      intentType: "tbc.pool.ftlp.burn", includeAncestry: true, contractIds: [poolContractId],
      assets: [{ kind: "native" }, { kind: "pool", contractId: poolContractId },
        { kind: "ftlp", contractDependency: { relation: "pool-lp", contractId: poolContractId } }],
    }]);
  } finally { service.close(); }
});

test("backend facade keeps preparation keyless and executes exact Prepared bytes only with explicit authorization", async () => {
  let chainReads = 0;
  const engineCalls = [];
  const rawEngine = createTbcEngine({ backend: wasmBackend });
  const engine = Object.freeze(Object.fromEntries(["normalizeRequest", "plan", "validate", "finalize"].map((method) => [
    method,
    async (params) => {
      engineCalls.push(method);
      return rawEngine[method](params);
    },
  ])));
  const network = Object.freeze({
    async resolveChainData() { chainReads += 1; return snapshot(chainReads); },
    async resolvePolicy() { return policy(); },
  });
  const prepareOnly = createTbcBackendService({
    serviceId: "org.example.prepare-only",
    account,
    network,
    engine,
  });
  const prepared = await prepareOnly.prepareTransaction(transaction("backend-prepare-only"));
  assert.equal(chainReads, 1);
  assert.equal(engineCalls.filter((method) => method === "plan").length, 1);
  await assert.rejects(
    prepareOnly.executePrepared({ kind: "transaction", action: "sign", prepared }),
    /requires explicit authorize and signer/u,
  );
  prepareOnly.close();

  const observed = [];
  const executor = createTbcBackendService({
    serviceId: "org.example.backend-signer",
    account,
    network,
    engine,
    authorize: async ({ approvalRequest }) => {
      observed.push("authorize");
      assert.equal(typeof approvalRequest, "object");
      return Object.freeze({ status: "approved", decisionId: "backend-decision-1", approvedAt: NOW });
    },
    signer: signer(observed),
    clock: () => NOW,
    randomBytes: (length) => Uint8Array.from({ length }, (_, index) => index),
  });
  const serialized = JSON.parse(JSON.stringify(prepared));
  const result = await executor.executePrepared({ kind: "transaction", action: "sign", prepared: serialized });
  assert.deepEqual(observed, ["authorize", "signer"]);
  assert.ok(Array.isArray(result.transactions));
  assert.equal(engineCalls.filter((method) => method === "plan").length, 2, "one wallet-side re-plan must revalidate Prepared material");
  assert.equal(chainReads, 2, "one preparation read plus one wallet-side Prepared revalidation read");
  executor.close();
});

test("backend facade reuses Prepared workflow planning and performs one explicit batch submit", async () => {
  let chainReads = 0;
  let batchSubmits = 0;
  const engineCalls = [];
  const observed = [];
  const rawEngine = createTbcEngine({ backend: wasmBackend });
  const engine = Object.freeze(Object.fromEntries(["normalizeRequest", "plan", "validate", "finalize"].map((method) => [
    method,
    async (params) => {
      engineCalls.push(method);
      return rawEngine[method](params);
    },
  ])));
  const network = Object.freeze({
    async resolveChainData() { chainReads += 1; return snapshot(chainReads); },
    async resolvePolicy() { return policy(); },
    async broadcastSubmit() { throw new Error("workflow must use batch submit"); },
    async broadcastSubmitBatch(params) {
      batchSubmits += 1;
      return Object.freeze({
        transactions: Object.freeze(params.transactions.map(({ txid }) => Object.freeze({ txid, status: "accepted" }))),
      });
    },
    async broadcastReconcile(params) {
      return Object.freeze({ transactions: Object.freeze(params.txids.map((txid) => Object.freeze({ txid, status: "mempool" }))) });
    },
  });
  const service = createTbcBackendService({
    serviceId: "org.example.backend-batch",
    account,
    network,
    engine,
    authorize: async () => {
      observed.push("authorize");
      return Object.freeze({ status: "approved", decisionId: "backend-batch-decision", approvedAt: NOW });
    },
    signer: signer(observed),
    clock: () => NOW,
    randomBytes: (length) => Uint8Array.from({ length }, (_, index) => 255 - index),
  });
  const prepared = await service.prepareWorkflow(Object.freeze({
    version: "1.0",
    chainId: CHAIN_ID,
    from: ADDRESS,
    clientRequestId: "backend-two-step",
    maxTotalFee: "400",
    steps: Object.freeze([
      Object.freeze({ id: "first", kind: "transaction", dependsOn: Object.freeze([]), intent: transaction("first", TXID_A).intent, constraints: transaction("first", TXID_A).constraints }),
      Object.freeze({ id: "second", kind: "transaction", dependsOn: Object.freeze([]), intent: transaction("second", TXID_B).intent, constraints: transaction("second", TXID_B).constraints }),
    ]),
  }));
  const result = await service.executePrepared({ kind: "workflow", action: "send", prepared });
  assert.equal(chainReads, 3, "two preparation reads plus one wallet-side workflow revalidation read");
  assert.equal(engineCalls.filter((method) => method === "plan").length, 4, "two preparation plans plus two wallet-side step re-plans");
  assert.equal(batchSubmits, 1);
  assert.equal(observed.filter((entry) => entry === "authorize").length, 1);
  assert.equal(observed.filter((entry) => entry === "signer").length, 2);
  assert.equal(result.transactions.length, 2);
  assert.ok(result.transactions.every(({ status }) => status === "accepted"));
  service.close();
});

test("backend facade preserves Provider rejection and never reaches Signer", async () => {
  const observed = [];
  const service = createTbcBackendService({
    serviceId: "org.example.backend-reject",
    account,
    network: Object.freeze({
      async resolveChainData() { return snapshot(); },
      async resolvePolicy() { return policy(); },
    }),
    engine: createTbcEngine({ backend: wasmBackend }),
    authorize: async () => Object.freeze({ status: "rejected", rejectedAt: NOW }),
    signer: signer(observed),
    clock: () => NOW,
    randomBytes: (length) => new Uint8Array(length),
  });
  const prepared = await service.prepareTransaction(transaction("backend-reject"));
  await assert.rejects(
    service.executePrepared({ kind: "transaction", action: "sign", prepared }),
    (error) => error instanceof TbcBackendServiceError && error.code === 4001,
  );
  assert.deepEqual(observed, []);
  service.close();
});

test("backend facade rejects changed Prepared evidence and missing send capability before authorization", async () => {
  const observed = [];
  let chainReads = 0;
  const service = createTbcBackendService({
    serviceId: "org.example.backend-fail-closed",
    account,
    network: Object.freeze({
      async resolveChainData() { chainReads += 1; return snapshot(chainReads); },
      async resolvePolicy() { return policy(); },
    }),
    engine: createTbcEngine({ backend: wasmBackend }),
    authorize: async () => {
      observed.push("authorize");
      return Object.freeze({ status: "approved", decisionId: "must-not-run", approvedAt: NOW });
    },
    signer: signer(observed),
    clock: () => NOW,
    randomBytes: (length) => new Uint8Array(length),
  });
  const prepared = await service.prepareTransaction(transaction("backend-fail-closed"));
  const changed = JSON.parse(JSON.stringify(prepared));
  changed.proposal.payload.estimatedTotalFee = "199";
  await assert.rejects(
    service.executePrepared({ kind: "transaction", action: "sign", prepared: changed }),
    /Prepared proposal hash does not match its payload/u,
  );
  assert.deepEqual(observed, []);
  await assert.rejects(
    service.executePrepared({ kind: "transaction", action: "send", prepared }),
    /requires explicit broadcast and reconciliation/u,
  );
  assert.deepEqual(observed, []);
  assert.equal(chainReads, 1, "caller-invalid Prepared material and missing send capability add no read");
  service.close();
});

test("backend facade keeps exact Prepared send identity stable across service recreation", async () => {
  const ids = [];
  const calls = [];
  const results = new Map();
  let chainReads = 0;
  const network = Object.freeze({
    async resolveChainData() { chainReads += 1; return snapshot(chainReads); },
    async resolvePolicy() { return policy(); },
    async broadcastSubmit(params, call) {
      ids.push(params.idempotencyKey);
      calls.push(call.callId);
      const prior = results.get(params.idempotencyKey);
      if (prior !== undefined) return prior;
      const result = Object.freeze({ txid: params.transaction.txid, status: "accepted" });
      results.set(params.idempotencyKey, result);
      return result;
    },
    async broadcastReconcile(params) {
      return Object.freeze({ transactions: Object.freeze(params.txids.map((txid) => Object.freeze({ txid, status: "mempool", confirmations: "0" }))) });
    },
  });
  const engine = createTbcEngine({ backend: wasmBackend });
  const prepared = await createTbcBackendService({
    serviceId: "org.example.identity",
    account,
    network,
    engine,
  }).prepareTransaction(transaction("backend-stable-identity"));
  const createExecutor = () => createTbcBackendService({
    serviceId: "org.example.identity",
    account,
    network,
    engine,
    authorize: async () => Object.freeze({ status: "approved", decisionId: "stable-decision", approvedAt: NOW }),
    signer: signer([]),
    clock: () => NOW,
    randomBytes: (length) => new Uint8Array(length),
  });
  const first = createExecutor();
  const second = createExecutor();
  await first.executePrepared({ kind: "transaction", action: "send", prepared });
  await second.executePrepared({ kind: "transaction", action: "send", prepared });
  assert.equal(ids.length, 2);
  assert.equal(ids[0], ids[1], "durable adapters must see one stable submit identity after recreation");
  assert.equal(calls[0], calls[1], "the exact Host submit call identity must also remain stable");
  assert.equal(results.size, 1, "the controlled durable adapter must reuse the completed result instead of POSTing again");
  first.close();
  second.close();
});

test("backend facade reconciles an uncertain single send exactly once and never resubmits", async () => {
  let submits = 0;
  let reconciles = 0;
  const network = Object.freeze({
    async resolveChainData() { return snapshot(); },
    async resolvePolicy() { return policy(); },
    async broadcastSubmit() {
      submits += 1;
      return Object.freeze({
        portError: Object.freeze({
          name: "UNAVAILABLE",
          message: "controlled uncertain submission",
          retryable: true,
        }),
      });
    },
    async broadcastReconcile(params) {
      reconciles += 1;
      return Object.freeze({
        transactions: Object.freeze(params.txids.map((txid) => Object.freeze({
          txid,
          status: "unknown",
        }))),
      });
    },
  });
  const service = createTbcBackendService({
    serviceId: "org.example.uncertain",
    account,
    network,
    engine: createTbcEngine({ backend: wasmBackend }),
    authorize: async () => Object.freeze({ status: "approved", decisionId: "uncertain-decision", approvedAt: NOW }),
    signer: signer([]),
    clock: () => NOW,
    randomBytes: (length) => new Uint8Array(length),
  });
  const prepared = await service.prepareTransaction(transaction("backend-uncertain"));
  await assert.rejects(
    service.executePrepared({ kind: "transaction", action: "send", prepared }),
    /could not be confirmed/u,
  );
  assert.equal(submits, 1);
  assert.equal(reconciles, 1);
  service.close();
});
