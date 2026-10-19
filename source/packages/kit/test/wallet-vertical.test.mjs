import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hashCanonical, TWS_RELEASE_FINGERPRINT } from "@tbc-wallet/core";
import { createTbcClient } from "../dist/esm/index.js";
import { createTbcEngine, createWasmTbcEngineBackend } from "../dist/esm/engine.js";
import { createTbcKitMemoryHostStore } from "../dist/esm/sqlite.js";
const walletModule = process.env.TBC_KIT_WALLET_TEST_MODULE
  ? pathToFileURL(process.env.TBC_KIT_WALLET_TEST_MODULE).href
  : new URL("../dist/esm/wallet.js", import.meta.url).href;
const {
  createApprovalHostEvidenceReader,
  createTbcWallet,
  projectTbcApprovalPresentation,
} = await import(walletModule);

const CHAIN_ID = "tbc:testnet";
const ADDRESS = "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH";
const PUBLIC_KEY = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const SCRIPT = "76a914751e76e8199196d454941c45d1b3a323f1433bd688ac";
const TXID = "ddb917e8cad41edda4a38fd8cb8cb51a8511c8bc51ab7f62b97a039af3d9125c";
const RAW = "0a00000001020000000000000000000000000000000000000000000000000000000000000001000000025101ffffffff01b0040000000000001976a914751e76e8199196d454941c45d1b3a323f1433bd688ac01000000";
const ACCOUNT_ID = `${CHAIN_ID}:${ADDRESS}`;
const NOW = "2026-09-02T00:00:10Z";

function permission(capability) {
  return {
    id: `kit-${capability}`,
    parentCapability: capability,
    invoker: "https://wallet.test",
    date: Date.parse("2026-09-02T00:00:00Z"),
    caveats: [
      { type: "restrictChains", value: [CHAIN_ID] },
      { type: "restrictAccounts", value: [ACCOUNT_ID] },
      { type: "restrictMethods", value: [capability] },
    ],
  };
}

test("Kit wallet composes all nine Ports for a real Rust-WASM TBC vertical path", async () => {
  const backend = await createWasmTbcEngineBackend(await readFile(new URL("../artifacts/wasm/tbc_engine_wasm.wasm", import.meta.url)));
  const account = { accountId: ACCOUNT_ID, address: ADDRESS, chainId: CHAIN_ID, publicKey: PUBLIC_KEY };
  const snapshotPayload = {
    version: "1.0", snapshotId: "snapshot-kit-vertical", chainId: CHAIN_ID,
    block: { height: "1000", hash: "aa".repeat(32) },
    capturedAt: "2026-09-02T00:00:00Z", expiresAt: "2026-09-02T00:05:00Z",
    account,
    utxos: [{ txid: TXID, vout: 0, satoshis: "1200", scriptPubKey: SCRIPT, confirmations: "100", classification: "native" }],
    parents: [{ txid: TXID, rawTransaction: RAW }], contracts: [],
  };
  const policyPayload = {
    version: "1.0", policyId: "policy-kit-vertical", revision: "1", chainId: CHAIN_ID,
    feeRateSatPerKb: "80", dustThreshold: "24", minConfirmations: "1",
    maxBundleTransactions: 32, sighashType: 65, contractPolicies: [],
    amountLimits: [{ scope: "native", maximum: "2100000000000000" }],
    expiresAt: "2026-09-02T00:05:00Z",
  };
  const permissions = [permission("tbc_accounts"), permission("tbc_sendTransaction")];
  const trace = [];
  const portCalls = [];
  const hostStore = createTbcKitMemoryHostStore({ now: () => Date.parse(NOW) });
  const evidenceReader = createApprovalHostEvidenceReader({
    store: hostStore,
    releaseFingerprint: TWS_RELEASE_FINGERPRINT,
    parseApprovalRequest: (value) => value,
  });
  let approvalPresentation;
  let approvalProjectionError;
  let approvalEvidence;
  const runtime = createTbcWallet({
    accounts: { current: async () => [account] },
    approval: {
      async request(params, call) {
        trace.push("approval");
        portCalls.push(call);
        assert.equal(call.operation, "approval.request");
        assert.deepEqual(call.params, params);
        assert.ok(Object.isFrozen(call) && Object.isFrozen(call.params));
        if (params.binding.payload.operationKind === "transaction") {
          approvalEvidence = await evidenceReader.read(call.callId, params.binding.bindingHash);
          try {
            approvalPresentation = projectTbcApprovalPresentation(approvalEvidence);
          } catch (error) {
            approvalProjectionError = new Error(JSON.stringify({
              message: error instanceof Error ? error.message : String(error),
              operation: approvalEvidence.payload.operation,
              normalizedTransaction: approvalEvidence.memory.normalizedTransaction,
              memoryRequestHash: approvalEvidence.memory.requestHash,
            }));
          }
        }
        return {
          status: "approved",
          approvalId: `approval-${trace.length}`,
          approvalToken: `token-${trace.length}`,
          bindingHash: params.binding.bindingHash,
          approvedAt: NOW,
          expiresAt: params.binding.payload.expiresAt,
        };
      },
    },
    signer: {
      async sign(params, call) {
        trace.push("signer");
        portCalls.push(call);
        assert.equal(call.operation, "signer.sign");
        assert.deepEqual(call.params, params);
        assert.ok(Object.isFrozen(call) && Object.isFrozen(call.params));
        return {
          taskId: params.task.taskId,
          signatureEncoding: "compact64",
          signature: secp256k1.sign(params.task.digest, "01".padStart(64, "0"), { prehash: false, lowS: true }).toCompactHex(),
        };
      },
    },
    storage: {
      async loadPermissions() { return { revision: "0", permissions }; },
      async commitPermissions(params) { return { revisions: params.changes.map((change) => ({ scope: change.scope, revision: "1" })) }; },
    },
    network: {
      async resolveChainData() { trace.push("chainData"); return { payload: snapshotPayload, snapshotHash: hashCanonical(snapshotPayload) }; },
      async resolvePolicy() { trace.push("policy"); return { payload: policyPayload, policyHash: hashCanonical(policyPayload) }; },
      async broadcastSubmit(params) { trace.push("broadcast"); return { txid: params.transaction.txid, status: "accepted" }; },
      async broadcastReconcile(params) { return { transactions: params.txids.map((txid) => ({ txid, status: "mempool" })) }; },
    },
    engine: createTbcEngine({ backend }),
    clock: () => NOW,
    randomBytes: () => Uint8Array.from({ length: 16 }, (_, index) => index),
  });
  const session = await runtime.openSession({
    origin: "https://wallet.test",
    sessionId: "kit-vertical",
    execution: { hostStore },
  });
  const client = createTbcClient({ network: CHAIN_ID, provider: session.provider, requestIdFactory: () => "kit-vertical-request" });
  const wallet = await client.connect();
  trace.length = 0;
  portCalls.length = 0;
  const result = await wallet.sendTbc({ to: "1cMh228HTCiwS8ZsaakH8A8wze1JR5ZsP", amount: "1000", constraints: { maxFee: "200" } });
  assert.equal(result.transactions.length, 1);
  assert.equal(result.transactions[0].status, "submitted");
  assert.deepEqual(trace, ["chainData", "policy", "approval", "signer", "broadcast"]);
  assert.equal(portCalls.length, 2);
  assert.ok(portCalls.every(({ version, callId }) => version === "1.0" && typeof callId === "string" && callId.length >= 16));
  assert.notEqual(portCalls[0].callId, portCalls[1].callId);
  assert.ifError(approvalProjectionError ?? (approvalPresentation === undefined
    ? new Error(JSON.stringify({
        call: approvalEvidence?.call,
        payloadOperation: approvalEvidence?.payload?.operation,
        memoryKeys: Object.keys(approvalEvidence?.memory ?? {}),
      }))
    : undefined));
  assert.equal(approvalPresentation.trust, "binding-verified");
  assert.equal(approvalPresentation.businessType.value, "tbc.transfer");
  assert.deepEqual(approvalPresentation.businessTerms.value, {
    version: "1.0",
    type: "tbc.transfer",
    to: "1cMh228HTCiwS8ZsaakH8A8wze1JR5ZsP",
    amount: "1000",
  });
  assert.equal(approvalPresentation.counts.transactions.value, 1);
  session.close();
});

test("Kit wallet binds injected WebView authority and invalidates an in-flight request after navigation", async () => {
  const profile = "mobile-authority-profile";
  const account = { accountId: ACCOUNT_ID, address: ADDRESS, chainId: CHAIN_ID, publicKey: PUBLIC_KEY };
  const initialAuthority = () => ({
    currentContext: {
      sessionId: "authority-probe",
      transport: "webview",
      origin: "https://dev.durianswap.org",
      topOrigin: "https://dev.durianswap.org",
      frame: "top",
      navigationId: "navigation-one",
      createdAt: "2026-09-17T00:00:00Z",
    },
    currentSession: {
      version: "1.0",
      scope: { walletProfile: profile, sessionId: "authority-probe" },
      state: {
        version: "1.0",
        sessionId: "authority-probe",
        revision: "0",
        connected: true,
        activeChainId: CHAIN_ID,
        activeAccountIds: [ACCOUNT_ID],
      },
    },
  });
  const authorityController = () => {
    let current = initialAuthority();
    return {
      source: {
        async read() { return structuredClone(current); },
        async compareAndSwapSession(input) {
          assert.deepEqual(input.expected, current);
          current = {
            currentContext: structuredClone(input.expected.currentContext),
            currentSession: {
              version: "1.0",
              scope: structuredClone(input.mutation.payload.scope),
              state: structuredClone(input.mutation.payload.target),
            },
          };
          return {
            acknowledgment: {
              version: "1.0",
              commitId: input.commitId,
              status: "committed",
              revision: input.mutation.payload.target.revision,
            },
            authority: structuredClone(current),
          };
        },
      },
      navigate(navigationId) {
        current = {
          ...current,
          currentContext: { ...current.currentContext, navigationId },
        };
      },
    };
  };
  const forbidden = async () => { throw new Error("unexpected transaction adapter call"); };
  const createRuntime = (approval, commits) => createTbcWallet({
    profile,
    accounts: { current: async () => [account] },
    approval: { request: approval },
    signer: { sign: forbidden },
    storage: {
      async loadPermissions() { return { revision: "0", permissions: [] }; },
      async commitPermissions(params) {
        commits.push(params);
        return { revisions: params.changes.map((change) => ({ scope: change.scope, revision: "1" })) };
      },
    },
    network: {
      resolveChainData: forbidden,
      resolvePolicy: forbidden,
      broadcastSubmit: forbidden,
      broadcastReconcile: forbidden,
    },
    clock: () => "2026-09-17T00:00:10Z",
    randomBytes: (length) => Uint8Array.from({ length }, (_, index) => index),
  });

  const acceptedAuthority = authorityController();
  const acceptedCommits = [];
  let acceptedApproval;
  const acceptedRuntime = createRuntime(async (params) => {
    acceptedApproval = params;
    assert.deepEqual(params.requester, {
      transport: "webview",
      origin: "https://dev.durianswap.org",
      topOrigin: "https://dev.durianswap.org",
      frame: "top",
    });
    assert.equal(params.binding.payload.contextHash, hashCanonical(initialAuthority().currentContext));
    assert.equal(params.binding.payload.origin, "https://dev.durianswap.org");
    assert.equal(params.binding.payload.sessionId, "authority-probe");
    return {
      status: "approved",
      approvalId: "authority-approved",
      approvalToken: "authority-token",
      bindingHash: params.binding.bindingHash,
      approvedAt: "2026-09-17T00:00:10Z",
      expiresAt: params.binding.payload.expiresAt,
    };
  }, acceptedCommits);
  const acceptedSession = await acceptedRuntime.openSession({ authority: acceptedAuthority.source });
  assert.deepEqual(await acceptedSession.provider.request({ method: "tbc_requestAccounts" }), [ADDRESS]);
  assert.ok(acceptedApproval);
  assert.equal(acceptedCommits.length, 1);
  acceptedSession.close();

  const changedAuthority = authorityController();
  const changedCommits = [];
  let changedApprovals = 0;
  const changedRuntime = createRuntime(async (params) => {
    changedApprovals += 1;
    changedAuthority.navigate("navigation-two");
    return {
      status: "approved",
      approvalId: "stale-navigation-approval",
      approvalToken: "stale-navigation-token",
      bindingHash: params.binding.bindingHash,
      approvedAt: "2026-09-17T00:00:10Z",
      expiresAt: params.binding.payload.expiresAt,
    };
  }, changedCommits);
  const changedSession = await changedRuntime.openSession({ authority: changedAuthority.source });
  await assert.rejects(changedSession.provider.request({ method: "tbc_requestAccounts" }));
  assert.equal(changedApprovals, 1);
  assert.equal(changedCommits.length, 0, "navigation change must prevent permission commit");
  changedSession.close();
});
