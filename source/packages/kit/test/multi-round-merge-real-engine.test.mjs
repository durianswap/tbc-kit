import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { secp256k1 } from "@noble/curves/secp256k1.js";
import {
  createTbcWallet,
  hashCanonical,
} from "../dist/esm/wallet.js";
import { createTbcKitMemoryHostStore } from "../dist/esm/sqlite.js";
import { createTbcEngine, createWasmTbcEngineBackend } from "../dist/esm/engine.js";
import { assertTestnetAddress, parseTbcTransaction, turingTransactionId } from "../dist/esm/api.js";

const NOW = Date.parse("2026-09-23T00:00:00Z");
const CHAIN_ID = "tbc:testnet";
const ADDRESS = "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH";
const PRIVATE_KEY = "01".padStart(64, "0");
const ORIGIN = "https://controlled-multi-round.test";
const AUTHORITY = Object.freeze({
  chainId: CHAIN_ID,
  accountId: `${CHAIN_ID}:${ADDRESS}`,
  origin: ORIGIN,
  sessionId: "controlled-real-engine-merge",
});
const ACCOUNT = Object.freeze({
  accountId: AUTHORITY.accountId,
  address: ADDRESS,
  chainId: CHAIN_ID,
  publicKey: Buffer.from(secp256k1.getPublicKey(PRIVATE_KEY, true)).toString("hex"),
});
const ASSET = Object.freeze({ kind: "tbc" });

function response(data) {
  return new Response(JSON.stringify({ code: "200", data }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function permission(capability) {
  return {
    id: `controlled-multi-round-${capability}`,
    parentCapability: capability,
    invoker: ORIGIN,
    date: NOW,
    caveats: [
      { type: "restrictChains", value: [CHAIN_ID] },
      { type: "restrictAccounts", value: [ACCOUNT.accountId] },
      { type: "restrictMethods", value: [capability] },
    ],
  };
}

test("default wallet composition drives representative TBC success through the real Rust Engine and controlled broadcast fixture", async () => {
  let utxos = Array.from({ length: 205 }, (_, index) => Object.freeze({
    txid: hashCanonical({ controlledSource: index }),
    vout: 0,
    satoshis: "10000",
    height: "990",
  }));
  const accepted = [];
  const fetchTrace = [];
  const controlledFetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    fetchTrace.push(`${(init?.method ?? "GET").toUpperCase()} ${url.pathname}`);
    if (url.pathname === "/api/tbc/nodeinfo") {
      return response({ blocks: 1000, bestblockhash: "aa".repeat(32) });
    }
    if (url.pathname === `/api/tbc/utxo/address/${ADDRESS}`) {
      return response({
        utxos: utxos.map(({ txid, vout, satoshis, height }) => ({
          txid, index: vout, value: satoshis, height,
        })),
      });
    }
    throw new Error(`Unexpected controlled multi-round HTTP read: ${url.pathname}`);
  };
  let presentedBatchApprovals = 0;
  let signerCalls = 0;
  let controlledBroadcasts = 0;
  const clockCalls = [];
  const formalExpiries = [];
  const scopeExpiries = [];
  const baseHostStore = createTbcKitMemoryHostStore();
  const leaseAcquires = new Map();
  let injectedHostStoreFailure = false;
  let faultedOperationId;
  let deferFaultedLeaseRelease = true;
  let completedSignerCalls = 0;
  let terminalInspectionReads = 0;
  const recoveringHostStore = Object.freeze({
    ...baseHostStore,
    async readOperation(operationId) {
      const record = await baseHostStore.readOperation(operationId);
      if (
        injectedHostStoreFailure &&
        operationId === faultedOperationId &&
        record !== null &&
        terminalInspectionReads < 6
      ) {
        terminalInspectionReads += 1;
        return Object.freeze({ ...record, terminal: true });
      }
      return record;
    },
    async acquireLease(input) {
      leaseAcquires.set(input.operationId, (leaseAcquires.get(input.operationId) ?? 0) + 1);
      return baseHostStore.acquireLease(input);
    },
    async completeCall(input) {
      const completed = await baseHostStore.completeCall(input);
      if (input.call.operation === "signer.sign") completedSignerCalls += 1;
      return completed;
    },
    async markCallUncertain(input) {
      if (
        !injectedHostStoreFailure &&
        completedSignerCalls === 13 &&
        input.call.operation === "clock.now"
      ) {
        injectedHostStoreFailure = true;
        faultedOperationId = input.lease.operationId;
        throw new Error("controlled failure before the next call becomes uncertain");
      }
      return baseHostStore.markCallUncertain(input);
    },
    async releaseLease(input) {
      if (
        injectedHostStoreFailure &&
        deferFaultedLeaseRelease &&
        input.lease.operationId === faultedOperationId
      ) {
        deferFaultedLeaseRelease = false;
        setTimeout(() => { void baseHostStore.releaseLease(input); }, 10);
        return false;
      }
      return baseHostStore.releaseLease(input);
    },
  });
  const approvalJournal = new Map();
  const issueCredential = (params, prefix) => {
    const approvalId = `${prefix}-${params.binding.bindingHash.slice(0, 12)}`;
    const approvalToken = hashCanonical({ approvalId, bindingHash: params.binding.bindingHash });
    const receipt = Object.freeze({
      status: "approved", approvalId, approvalToken,
      bindingHash: params.binding.bindingHash,
      approvedAt: "2026-09-23T00:00:00Z",
      expiresAt: params.binding.payload.expiresAt,
    });
    approvalJournal.set(approvalId, receipt);
    return receipt;
  };
  const engine = createTbcEngine({
    backend: await createWasmTbcEngineBackend(await readFile(
      new URL("../artifacts/wasm/tbc_engine_wasm.wasm", import.meta.url),
    )),
  });
  const runtime = createTbcWallet({
    accounts: { current: async () => [ACCOUNT] },
    approval: {
      async request() {
        throw new Error("bounded multi-round formal approvals must not reopen native UI");
      },
    },
    multiRoundMerge: {
      async approve({ scope, scopeHash }) {
        presentedBatchApprovals += 1;
        scopeExpiries.push(scope.limits.expiresAt);
        return {
          status: "approved",
          scopeHash,
          approvalId: "controlled-bounded-batch-consent",
          approvedAt: "2026-09-23T00:00:00Z",
          expiresAt: "2026-09-24T00:04:00.777Z",
        };
      },
      async authorizeStep({ params }) {
        formalExpiries.push(params.binding.payload.expiresAt);
        return issueCredential(params, "controlled-merge-step");
      },
    },
    signer: {
      async sign(params, call) {
        signerCalls += 1;
        assert.equal(call.execution.type, "session-only");
        assert.deepEqual(
          approvalJournal.get(params.approval.approvalId),
          params.approval,
          "Signer must verify the wallet-issued journal credential before secp signing",
        );
        return {
          taskId: params.task.taskId,
          signatureEncoding: "compact64",
          signature: secp256k1.sign(params.task.digest, PRIVATE_KEY, {
            prehash: false,
            lowS: true,
          }).toCompactHex(),
        };
      },
    },
    storage: {
      hostStore: recoveringHostStore,
      async loadPermissions() {
        return {
          revision: "0",
          permissions: [permission("tbc_accounts"), permission("tbc_sendTransaction")],
        };
      },
      async commitPermissions(params) {
        return { revisions: params.changes.map(({ scope }) => ({ scope, revision: "1" })) };
      },
    },
    network: {
      defaultTestnet: {
        fetch: controlledFetch,
        now: () => NOW,
        snapshotId: (() => {
          let value = 0;
          return async () => `controlled-multi-round-snapshot-${++value}`;
        })(),
        // CONTROLLED BROADCAST FIXTURE: no real node or funds are contacted.
        broadcast: {
          async submit(params, _client, call) {
            controlledBroadcasts += 1;
            assert.equal(call?.operation, "broadcast.submit");
            const raw = params.transaction.rawTransaction;
            const parsed = parseTbcTransaction(raw);
            const txid = turingTransactionId(raw);
            const spent = new Set(parsed.inputs.map(({ txid: parent, vout }) => `${parent}:${vout}`));
            utxos = utxos.filter(({ txid: parent, vout }) => !spent.has(`${parent}:${vout}`));
            assert.equal(parsed.outputs.length, 1);
            utxos.push(Object.freeze({
              txid,
              vout: 0,
              satoshis: parsed.outputs[0].satoshis.toString(),
              height: "0",
            }));
            accepted.push(txid);
            return { txid, status: "accepted" };
          },
          async reconcile(params) {
            return {
              transactions: params.txids.map((txid) => ({
                txid,
                status: accepted.includes(txid) ? "mempool" : "unknown",
                ...(accepted.includes(txid) ? { confirmations: "0" } : {}),
              })),
            };
          },
        },
      },
    },
    engine,
    clock: (call) => {
      if (call !== undefined && call.operation !== "clock.now") {
        throw new Error(`Clock adapter received the wrong Host operation: ${call.operation}`);
      }
      clockCalls.push(call?.operation ?? "local");
      return "2026-09-23T00:00:00Z";
    },
    randomBytes: (length) => Uint8Array.from({ length }, (_, index) => index),
  });
  const session = await runtime.openSession({
    origin: ORIGIN,
    sessionId: AUTHORITY.sessionId,
    execution: { hostStore: recoveringHostStore },
  });

  const invalidReadCount = fetchTrace.length;
  await assert.rejects(session.provider.request({
    method: "tbc_runMultiRoundMerge",
    params: {
      version: "1.0", chainId: CHAIN_ID, from: ADDRESS,
      clientRequestId: "controlled-invalid-budget",
      asset: ASSET,
      limits: {
        targetUtxoCount: 1, maxTransactions: 0, maxTotalFee: "5000",
        expiresAt: "2026-09-24T00:05:00.983Z", maxIndexRefreshes: 0,
      },
    },
  }), (error) => error?.code === -32602);
  assert.equal(fetchTrace.length, invalidReadCount, "invalid DApp budget must fail before network reads");

  const result = await session.provider.request({
    method: "tbc_runMultiRoundMerge",
    params: {
      version: "1.0", chainId: CHAIN_ID, from: ADDRESS,
      clientRequestId: "controlled-shared-multi-round",
      asset: ASSET,
      limits: {
      targetUtxoCount: 1,
      maxTransactions: 3,
      maxTotalFee: "5000",
      expiresAt: "2026-09-24T00:05:00.983Z",
      maxIndexRefreshes: 0,
      },
    },
  });
  assert.equal(result.atomic, false);
  assert.equal(result.status, "complete", JSON.stringify(result));
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.progress));
  assert.deepEqual(result.progress.map(({ phase }) => phase), [
    "approval", "preparing", "executing", "preparing", "executing",
    "preparing", "executing", "complete",
  ]);
  assert.equal(result.status, "complete");
  assert.equal(result.finalUtxoCount, 1);
  assert.deepEqual(result.steps.map(({ inputCount }) => inputCount), [100, 100, 7]);
  assert.equal(presentedBatchApprovals, 1, "one bounded user consent covers only this finite run");
  assert.equal(controlledBroadcasts, 3);
  assert.equal(signerCalls, 207);
  assert.equal(injectedHostStoreFailure, true);
  assert.equal(typeof faultedOperationId, "string");
  assert.ok(leaseAcquires.get(faultedOperationId) >= 2,
    "the same session operation resumes only after the active lease yields");
  assert.ok(terminalInspectionReads <= 4,
    "a failed resume after terminal inspection must timer-yield instead of tight-looping");
  assert.ok(clockCalls.includes("local"), "wallet-local time checks use no Host-call envelope");
  assert.ok(clockCalls.every((operation) => operation === "local" || operation === "clock.now"));
  assert.deepEqual(scopeExpiries, ["2026-09-24T00:05:00.983Z"]);
  assert.equal(formalExpiries.length, 3);
  assert.ok(formalExpiries.every((value) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)),
    "new Core requests preserve millisecond deadlines without flooring to seconds");
  assert.ok(fetchTrace.filter((edge) => edge.endsWith(`/api/tbc/utxo/address/${ADDRESS}`)).length >= 3);
  assert.equal(utxos.length, 1);
  session.close();
});

test("a post-identity adapter exception preserves the nonterminal Host operation as pending", async () => {
  const rows = [0, 1].map((index) => ({
    txid: hashCanonical({ pendingIdentitySource: index }),
    vout: 0,
    satoshis: "10000",
    height: "990",
  }));
  const baseHostStore = createTbcKitMemoryHostStore();
  let faultedOperationId;
  let throwNextDateRead = false;
  let scopeApproved = false;
  const interruptedHostStore = Object.freeze({
    ...baseHostStore,
    async markCallUncertain(input) {
      if (scopeApproved && faultedOperationId === undefined && input.call.operation === "clock.now") {
        faultedOperationId = input.lease.operationId;
        throwNextDateRead = true;
        throw new Error("controlled post-identity Host interruption");
      }
      return baseHostStore.markCallUncertain(input);
    },
  });
  const engine = createTbcEngine({
    backend: await createWasmTbcEngineBackend(await readFile(
      new URL("../artifacts/wasm/tbc_engine_wasm.wasm", import.meta.url),
    )),
  });
  let signerCalls = 0;
  let broadcasts = 0;
  const runtime = createTbcWallet({
    accounts: { current: async () => [ACCOUNT] },
    approval: { async request() { throw new Error("bounded consent must not reopen UI"); } },
    multiRoundMerge: {
      async approve({ scopeHash }) {
        scopeApproved = true;
        return {
          status: "approved", scopeHash, approvalId: "pending-identity-consent",
          approvedAt: "2026-09-23T00:00:00Z", expiresAt: "2026-09-24T00:04:00Z",
        };
      },
      async authorizeStep() { throw new Error("interrupted operation reached credential issuance"); },
    },
    signer: { async sign() { signerCalls += 1; throw new Error("interrupted operation reached Signer"); } },
    storage: {
      hostStore: interruptedHostStore,
      async loadPermissions() {
        return { revision: "0", permissions: [permission("tbc_accounts"), permission("tbc_sendTransaction")] };
      },
      async commitPermissions() { throw new Error("unexpected permission write"); },
    },
    network: {
      defaultTestnet: {
        async fetch(input) {
          const url = new URL(input instanceof Request ? input.url : String(input));
          if (url.pathname === "/api/tbc/nodeinfo") return response({ blocks: 1000, bestblockhash: "aa".repeat(32) });
          if (url.pathname === `/api/tbc/utxo/address/${ADDRESS}`) {
            return response({ utxos: rows.map(({ txid, vout, satoshis, height }) => ({ txid, index: vout, value: satoshis, height })) });
          }
          throw new Error(`Unexpected pending-identity read: ${url.pathname}`);
        },
        now: () => NOW,
        snapshotId: async () => "pending-identity-snapshot",
        broadcast: {
          async submit() { broadcasts += 1; throw new Error("interrupted operation reached POST"); },
          async reconcile() { throw new Error("interrupted operation reached reconciliation"); },
        },
      },
    },
    engine,
    clock: () => "2026-09-23T00:00:00Z",
    randomBytes: (length) => Uint8Array.from({ length }, (_, index) => index),
  });
  const originalDateNow = Date.now;
  Date.now = () => {
    if (throwNextDateRead) {
      throwNextDateRead = false;
      throw new Error("controlled wait-clock interruption");
    }
    return originalDateNow();
  };
  let session;
  try {
    session = await runtime.openSession({
      origin: ORIGIN,
      sessionId: "pending-identity",
      execution: { hostStore: interruptedHostStore },
    });
    const result = await session.runMultiRoundMerge({
      asset: ASSET,
      limits: {
        targetUtxoCount: 1, maxTransactions: 1, maxTotalFee: "5000",
        expiresAt: "2026-09-24T00:05:00Z", maxIndexRefreshes: 0,
      },
    });
    assert.equal(result.status, "uncertain");
    assert.equal(result.reason, "operation-pending");
    assert.equal(result.totalFee, "0");
    assert.equal(result.steps[0].status, "pending");
    assert.equal(result.steps[0].recoveryId, faultedOperationId);
    assert.equal(signerCalls, 0);
    assert.equal(broadcasts, 0);
  } finally {
    Date.now = originalDateNow;
    session?.close();
  }
});

test("default multi-round entry proves send permission before private index reads or scope UI", async () => {
  let privateIndexReads = 0;
  let scopePrompts = 0;
  let credentialCalls = 0;
  let signerCalls = 0;
  const forbiddenEngine = Object.freeze({
    async normalizeRequest() { throw new Error("permission gate reached Engine"); },
    async plan() { throw new Error("permission gate reached Engine"); },
    async validate() { throw new Error("permission gate reached Engine"); },
    async finalize() { throw new Error("permission gate reached Engine"); },
  });
  const runtime = createTbcWallet({
    accounts: { current: async () => [ACCOUNT] },
    approval: { async request() { throw new Error("permission gate reached approval"); } },
    multiRoundMerge: {
      async approve() { scopePrompts += 1; throw new Error("permission gate reached scope UI"); },
      async authorizeStep() { credentialCalls += 1; throw new Error("permission gate reached credential issuance"); },
    },
    signer: { async sign() { signerCalls += 1; throw new Error("permission gate reached Signer"); } },
    storage: {
      async loadPermissions() { return { revision: "0", permissions: [] }; },
      async commitPermissions() { throw new Error("unexpected permission write"); },
    },
    network: {
      defaultTestnet: {
        async fetch(input) {
          const url = new URL(input instanceof Request ? input.url : String(input));
          if (url.pathname.includes("/utxo/")) privateIndexReads += 1;
          throw new Error("permission gate reached network");
        },
        now: () => NOW,
        snapshotId: async () => "permission-gate-snapshot",
      },
    },
    engine: forbiddenEngine,
    clock: () => "2026-09-23T00:00:00Z",
    randomBytes: (length) => new Uint8Array(length),
  });
  const session = await runtime.openSession({ origin: ORIGIN, sessionId: "permission-gate" });
  await assert.rejects(
    session.provider.request({
      method: "tbc_runMultiRoundMerge",
      params: {
        version: "1.0", chainId: CHAIN_ID, from: ADDRESS,
        clientRequestId: "permission-gated-shared-merge",
        asset: ASSET,
        limits: {
        targetUtxoCount: 1, maxTransactions: 1, maxTotalFee: "5000",
        expiresAt: "2026-09-24T00:05:00Z", maxIndexRefreshes: 0,
        },
      },
    }),
    (error) => error?.code === 4100,
  );
  assert.equal(privateIndexReads, 0);
  assert.equal(scopePrompts, 0);
  assert.equal(credentialCalls, 0);
  assert.equal(signerCalls, 0);
  session.close();
});

test("a held DApp merge rejects a concurrent run and cancelling the rejected request cannot affect the first", async () => {
  const rows = [0, 1].map((index) => ({
    txid: hashCanonical({ concurrentMergeSource: index }),
    vout: 0,
    satoshis: "10000",
    height: "990",
  }));
  let releaseFirstApproval;
  const firstApprovalRelease = new Promise((resolve) => { releaseFirstApproval = resolve; });
  let markFirstApprovalEntered;
  const firstApprovalEntered = new Promise((resolve) => { markFirstApprovalEntered = resolve; });
  let approvals = 0;
  let privateIndexReads = 0;
  const runtime = createTbcWallet({
    accounts: { current: async () => [ACCOUNT] },
    approval: { async request() { throw new Error("concurrent merge reopened ordinary approval"); } },
    multiRoundMerge: {
      async approve({ scopeHash }) {
        approvals += 1;
        if (approvals === 1) {
          markFirstApprovalEntered();
          await firstApprovalRelease;
        }
        return { status: "rejected", scopeHash };
      },
      async authorizeStep() { throw new Error("rejected merge reached credential issuance"); },
    },
    signer: { async sign() { throw new Error("rejected merge reached Signer"); } },
    storage: {
      async loadPermissions() {
        return { revision: "0", permissions: [permission("tbc_accounts"), permission("tbc_sendTransaction")] };
      },
      async commitPermissions() { throw new Error("unexpected permission write"); },
    },
    network: {
      defaultTestnet: {
        async fetch(input) {
          const url = new URL(input instanceof Request ? input.url : String(input));
          if (url.pathname === "/api/tbc/nodeinfo") {
            return response({ blocks: 1000, bestblockhash: "aa".repeat(32) });
          }
          if (url.pathname === `/api/tbc/utxo/address/${ADDRESS}`) {
            privateIndexReads += 1;
            return response({
              utxos: rows.map(({ txid, vout, satoshis, height }) => ({
                txid, index: vout, value: satoshis, height,
              })),
            });
          }
          throw new Error(`Unexpected concurrent merge read: ${url.pathname}`);
        },
        now: () => NOW,
        snapshotId: async () => "concurrent-merge-snapshot",
      },
    },
    engine: Object.freeze({
      async normalizeRequest() { throw new Error("rejected merge reached Engine"); },
      async plan() { throw new Error("rejected merge reached Engine"); },
      async validate() { throw new Error("rejected merge reached Engine"); },
      async finalize() { throw new Error("rejected merge reached Engine"); },
    }),
    clock: () => "2026-09-23T00:00:00Z",
    randomBytes: (length) => new Uint8Array(length),
  });
  const session = await runtime.openSession({ origin: ORIGIN, sessionId: "concurrent-merge" });
  const params = (clientRequestId) => ({
    version: "1.0", chainId: CHAIN_ID, from: ADDRESS, clientRequestId,
    asset: ASSET,
    limits: {
      targetUtxoCount: 1, maxTransactions: 1, maxTotalFee: "5000",
      expiresAt: "2026-09-24T00:05:00Z", maxIndexRefreshes: 0,
    },
  });
  const first = session.provider.request({
    method: "tbc_runMultiRoundMerge",
    params: params("held-first-merge"),
  });
  let firstSettled = false;
  void first.then(() => { firstSettled = true; }, () => { firstSettled = true; });
  await firstApprovalEntered;

  const secondAbort = new AbortController();
  const second = session.provider.request({
    method: "tbc_runMultiRoundMerge",
    params: params("cancelled-second-merge"),
  }, { signal: secondAbort.signal });
  await assert.rejects(second, (error) =>
    error?.code === -32603 &&
    error?.message === "A multi-round merge is already active in this wallet session");
  secondAbort.abort();
  await Promise.resolve();
  assert.equal(approvals, 1, "the conflicting run must not reach bounded approval");
  assert.equal(privateIndexReads, 1, "the conflicting run must not read a private index");
  assert.equal(firstSettled, false, "cancelling the conflicting request must not cancel the held run");

  releaseFirstApproval();
  const firstResult = await first;
  assert.equal(firstResult.status, "stopped");
  assert.equal(firstResult.reason, "approval-rejected");
  const thirdResult = await session.provider.request({
    method: "tbc_runMultiRoundMerge",
    params: params("post-release-third-merge"),
  });
  assert.equal(thirdResult.status, "stopped");
  assert.equal(thirdResult.reason, "approval-rejected");
  assert.equal(approvals, 2, "a later run may enter only after the first fully settles");
  assert.equal(privateIndexReads, 2);
  session.close();
});

test("wallet formal-credential rejection is terminal before Signer and POST with zero fee exposure", async () => {
  const rows = [0, 1].map((index) => ({
    txid: hashCanonical({ credentialRejectionSource: index }),
    vout: 0,
    satoshis: "10000",
    height: "990",
  }));
  let scopePrompts = 0;
  let credentialCalls = 0;
  let signerCalls = 0;
  let broadcasts = 0;
  const clientRequestIds = [];
  const actualEngine = createTbcEngine({
    backend: await createWasmTbcEngineBackend(await readFile(
      new URL("../artifacts/wasm/tbc_engine_wasm.wasm", import.meta.url),
    )),
  });
  const engine = Object.freeze({
    async normalizeRequest(params) {
      clientRequestIds.push(params.request.clientRequestId);
      return actualEngine.normalizeRequest(params);
    },
    plan: actualEngine.plan,
    validate: actualEngine.validate,
    finalize: actualEngine.finalize,
  });
  const runtime = createTbcWallet({
    accounts: { current: async () => [ACCOUNT] },
    approval: { async request() { throw new Error("bounded consent must not reopen UI"); } },
    multiRoundMerge: {
      async approve({ scopeHash }) {
        scopePrompts += 1;
        return {
          status: "approved", scopeHash, approvalId: `credential-rejection-scope-${scopePrompts}`,
          approvedAt: "2026-09-23T00:00:00Z", expiresAt: "2026-09-24T00:04:00Z",
        };
      },
      async authorizeStep() {
        credentialCalls += 1;
        return { portError: { name: "UNAUTHORIZED", retryable: false, message: "Scope credential unavailable" } };
      },
    },
    signer: { async sign() { signerCalls += 1; throw new Error("rejected credential reached Signer"); } },
    storage: {
      async loadPermissions() {
        return { revision: "0", permissions: [permission("tbc_accounts"), permission("tbc_sendTransaction")] };
      },
      async commitPermissions() { throw new Error("unexpected permission write"); },
    },
    network: {
      defaultTestnet: {
        async fetch(input) {
          const url = new URL(input instanceof Request ? input.url : String(input));
          if (url.pathname === "/api/tbc/nodeinfo") return response({ blocks: 1000, bestblockhash: "aa".repeat(32) });
          if (url.pathname === `/api/tbc/utxo/address/${ADDRESS}`) {
            return response({ utxos: rows.map(({ txid, vout, satoshis, height }) => ({ txid, index: vout, value: satoshis, height })) });
          }
          throw new Error(`Unexpected credential-rejection read: ${url.pathname}`);
        },
        now: () => NOW,
        snapshotId: async () => "credential-rejection-snapshot",
        broadcast: {
          async submit() { broadcasts += 1; throw new Error("rejected credential reached POST"); },
          async reconcile() { throw new Error("rejected credential reached reconciliation"); },
        },
      },
    },
    engine,
    clock: () => "2026-09-23T00:00:00Z",
    randomBytes: (length) => Uint8Array.from({ length }, (_, index) => index),
  });
  const session = await runtime.openSession({ origin: ORIGIN, sessionId: "credential-rejection" });
  const run = () => session.runMultiRoundMerge({
    asset: ASSET,
    limits: {
      targetUtxoCount: 1, maxTransactions: 1, maxTotalFee: "5000",
      expiresAt: "2026-09-24T00:05:00Z", maxIndexRefreshes: 0,
    },
  });
  const first = await run();
  const second = await run();
  for (const result of [first, second]) {
    assert.equal(result.status, "stopped");
    assert.match(result.reason, /^step-(?:rejected|failed)$/u);
    assert.equal(result.totalFee, "0");
    assert.equal(result.steps.length, 1);
    assert.equal(result.steps[0].fee, "0");
    assert.notEqual(result.reason, "broadcast-uncertain");
  }
  assert.equal(scopePrompts, 2);
  assert.equal(credentialCalls, 2, "a newly approved run must not replay the prior Host failure");
  assert.equal(clientRequestIds.length, 2);
  assert.notEqual(clientRequestIds[0], clientRequestIds[1]);
  assert.equal(signerCalls, 0);
  assert.equal(broadcasts, 0);
  session.close();
});

test("default wallet composition drives controlled FT multi-round success through the real Rust Engine", async () => {
  const ownerScript = assertTestnetAddress(ADDRESS).scriptPubKey;
  // Historical issuance is retired. Start from the committed public scalar-one
  // holder fixture, then exercise real transfers and merge without a mint bypass.
  const existing = JSON.parse(await readFile(new URL('./fixtures/controlled-pool-key1.json',import.meta.url),'utf8'));
  assert.equal(existing.address,ADDRESS);
  const contractId = existing.ftContractId;
  const rawTransactions = new Map(Object.entries(existing.rawTransactions));
  const funding = [["8096980000000000", "10000000"], ["002d310100000000", "20000000"]];
  const fundingRaw = funding.map(([amount], index) => [
    "0a000000", "01", String(index).padStart(2, "0").repeat(32), "00000000", "00", "ffffffff",
    "01", amount, "19", ownerScript, "00000000",
  ].join(""));
  let nativeUtxos = fundingRaw.map((raw, index) => {
    const txid = turingTransactionId(raw);
    rawTransactions.set(txid, raw);
    return { txid, vout: 0, satoshis: funding[index][1], height: "990" };
  });
  let ftUtxos = [{txid:existing.ownerCandidate.txid,vout:existing.ownerCandidate.index,
    satoshis:String(existing.ownerCandidate.tbc_value),ftAmount:existing.ownerCandidate.ft_value,height:'990'}];
  const accepted = new Set();
  const ftTrace = [];
  const amountFromTape = (script) => {
    const slot = script.slice(3, 11);
    let value = 0n;
    for (let index = 7; index >= 0; index -= 1) value = value * 256n + BigInt(slot[index]);
    return value.toString();
  };
  const controlledFetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    ftTrace.push(url.pathname);
    if (url.pathname === "/api/tbc/nodeinfo") return response({ blocks: 1000, bestblockhash: "aa".repeat(32) });
    if (url.pathname === `/api/tbc/ft/info/contract/${contractId}`) {
      const tx=parseTbcTransaction(rawTransactions.get(contractId));
      return response({code_script:Buffer.from(tx.outputs[0].scriptPubKey).toString('hex'),
        tape_script:Buffer.from(tx.outputs[1].scriptPubKey).toString('hex'),
        amount:'1000000',decimal:0,name:'Merge Fixture',symbol:'MRG'});
    }
    if (url.pathname === `/api/tbc/utxo/address/${ADDRESS}`) {
      return response({ utxos: nativeUtxos.map((item) => ({
        txid: item.txid, index: item.vout, value: item.satoshis, height: Number(item.height),
      })) });
    }
    if (url.pathname.includes("/api/tbc/ft/utxo/combinescript/")) {
      return response({ utxos: ftUtxos.map((item) => ({
        txid: item.txid, index: item.vout, tbc_value: item.satoshis,
        ft_value: item.ftAmount, height: Number(item.height),
      })) });
    }
    const txid = url.pathname.match(/^\/api\/tbc\/txraw\/txid\/([0-9a-f]{64})$/u)?.[1];
    if (txid !== undefined && rawTransactions.has(txid)) return response({ txraw: rawTransactions.get(txid) });
    throw new Error(`Unexpected controlled FT HTTP read: ${url.pathname}`);
  };
  let scopeApprovals = 0;
  let ordinaryApprovals = 0;
  let signerCalls = 0;
  let broadcasts = 0;
  const approvalJournal = new Map();
  const issueCredential = (params, prefix) => {
    const approvalId = `${prefix}-${params.binding.bindingHash.slice(0, 12)}`;
    const approvalToken = hashCanonical({ approvalId, bindingHash: params.binding.bindingHash });
    const receipt = Object.freeze({
      status: "approved", approvalId, approvalToken,
      bindingHash: params.binding.bindingHash,
      approvedAt: "2026-09-23T00:00:00Z",
      expiresAt: params.binding.payload.expiresAt,
    });
    approvalJournal.set(approvalId, receipt);
    return receipt;
  };
  const actualEngine = createTbcEngine({
    backend: await createWasmTbcEngineBackend(await readFile(
      new URL("../artifacts/wasm/tbc_engine_wasm.wasm", import.meta.url),
    )),
  });
  let planError;
  const engine = Object.freeze({
    normalizeRequest: actualEngine.normalizeRequest,
    async plan(params) {
      try { return await actualEngine.plan(params); }
      catch (error) { planError = error; throw error; }
    },
    validate: actualEngine.validate,
    finalize: actualEngine.finalize,
  });
  const runtime = createTbcWallet({
    accounts: { current: async () => [ACCOUNT] },
    approval: {
      async request(params) {
        ordinaryApprovals += 1;
        return issueCredential(params, `ft-setup-${ordinaryApprovals}`);
      },
    },
    multiRoundMerge: {
      async approve({ scopeHash }) {
        scopeApprovals += 1;
        return {
          status: "approved", scopeHash, approvalId: "ft-bounded-consent",
          approvedAt: "2026-09-23T00:00:00Z", expiresAt: "2026-09-24T00:04:00Z",
        };
      },
      async authorizeStep({ params }) {
        return issueCredential(params, "controlled-ft-merge-step");
      },
    },
    signer: {
      async sign(params) {
        signerCalls += 1;
        assert.deepEqual(
          approvalJournal.get(params.approval.approvalId),
          params.approval,
          "Signer must verify the wallet-issued journal credential before secp signing",
        );
        return {
          taskId: params.task.taskId, signatureEncoding: "compact64",
          signature: secp256k1.sign(params.task.digest, PRIVATE_KEY, { prehash: false, lowS: true }).toCompactHex(),
        };
      },
    },
    storage: {
      async loadPermissions() {
        return { revision: "0", permissions: [permission("tbc_accounts"), permission("tbc_sendTransaction")] };
      },
      async commitPermissions(params) {
        return { revisions: params.changes.map(({ scope }) => ({ scope, revision: "1" })) };
      },
    },
    network: {
      defaultTestnet: {
        fetch: controlledFetch,
        now: () => NOW,
        snapshotId: (() => { let value = 0; return async () => `controlled-ft-snapshot-${++value}`; })(),
        broadcast: {
          async submit(params) {
            broadcasts += 1;
            const raw = params.transaction.rawTransaction;
            const parsed = parseTbcTransaction(raw);
            const txid = turingTransactionId(raw);
            rawTransactions.set(txid, raw);
            const spent = new Set(parsed.inputs.map((input) => `${input.txid}:${input.vout}`));
            nativeUtxos = nativeUtxos.filter((item) => !spent.has(`${item.txid}:${item.vout}`));
            ftUtxos = ftUtxos.filter((item) => !spent.has(`${item.txid}:${item.vout}`));
            parsed.outputs.forEach((output, vout) => {
              if (Buffer.from(output.scriptPubKey).toString("hex") === ownerScript) {
                nativeUtxos.push({ txid, vout, satoshis: output.satoshis.toString(), height: "0" });
              }
              try {
                const tape = parsed.outputs[vout + 1]?.scriptPubKey;
                const marker = Buffer.from(tape?.slice(-5) ?? []).toString("utf8");
                if (tape?.[0] !== 0 || tape?.[1] !== 0x6a || tape?.[2] !== 0x30 || marker !== "FTape") {
                  throw new Error("not an FT output");
                }
                ftUtxos.push({
                  txid, vout, satoshis: output.satoshis.toString(),
                  ftAmount: amountFromTape(parsed.outputs[vout + 1].scriptPubKey), height: "0",
                });
              } catch {}
            });
            accepted.add(txid);
            return { txid, status: "accepted" };
          },
          async reconcile(params) {
            return { transactions: params.txids.map((txid) => ({
              txid, status: accepted.has(txid) ? "mempool" : "unknown",
              ...(accepted.has(txid) ? { confirmations: "0" } : {}),
            })) };
          },
        },
      },
    },
    engine,
    clock: () => "2026-09-23T00:00:00Z",
    randomBytes: (length) => Uint8Array.from({ length }, (_, index) => index + 1),
  });
  const session = await runtime.openSession({ origin: ORIGIN, sessionId: "controlled-real-engine-ft-merge" });
  const send = async (intent, sequence) => {
    try {
      return await session.provider.request({
        method: "tbc_sendTransaction",
        params: {
          version: "1.0", chainId: CHAIN_ID, from: ADDRESS,
          clientRequestId: `controlled-ft-setup-${sequence}`,
          intent,
          constraints: { expiresAt: "2026-09-24T00:03:00Z", maxFee: "5000", feePreference: "standard" },
        },
      });
    } catch (error) {
      throw new Error(`${error.message}; sequence=${sequence}; plan=${planError?.message ?? "none"}; trace=${ftTrace.join(",")}`, { cause: error });
    }
  };
  for (let index = 1; index <= 5; index += 1) {
    await send({
      version: "1.0", type: "tbc.ft.transfer", contractId, to: ADDRESS,
      amount: String(index * 10000), attachedTbcAmount: "10000",
    }, index);
  }
  assert.equal(ftUtxos.length, 6, "controlled Engine setup creates six indexed FT outputs");
  const setupSignerCalls = signerCalls;
  const result = await session.runMultiRoundMerge({
    asset: { kind: "ft", contractId },
    limits: {
      targetUtxoCount: 1, maxTransactions: 2, maxTotalFee: "10000",
      expiresAt: "2026-09-24T00:05:00Z", maxIndexRefreshes: 0,
    },
  });
  assert.equal(result.status, "complete");
  assert.equal(result.finalUtxoCount, 1);
  assert.deepEqual(result.steps.map(({ inputCount }) => inputCount), [5, 2]);
  assert.equal(scopeApprovals, 1);
  assert.equal(ordinaryApprovals, 5, "merge steps consume the bounded consent without reopening UI");
  assert.ok(signerCalls > setupSignerCalls, "real Rust Engine merge tasks reached the real secp Signer");
  assert.equal(broadcasts, 7);
  session.close();
});
