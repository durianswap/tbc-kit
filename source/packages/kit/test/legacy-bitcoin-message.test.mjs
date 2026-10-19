import assert from "node:assert/strict";
import test from "node:test";

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { createTbcWallet } from "../dist/esm/wallet.js";

const CHAIN_ID = "tbc:testnet";
const ADDRESS = "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH";
const ACCOUNT_ID = `${CHAIN_ID}:${ADDRESS}`;
const SCALAR = Uint8Array.from({ length: 32 }, (_, index) =>
  index === 31 ? 1 : 0,
);
const PUBLIC_KEY = Buffer.from(secp256k1.getPublicKey(SCALAR, true)).toString(
  "hex",
);
const LEGACY_DIGEST =
  "dcbe45621b28154774991a549de8cd58c72ed87bc7d04e0688e80047071259ab";

function permission(capability) {
  return {
    id: `legacy-message-${capability}`,
    parentCapability: capability,
    invoker: "https://dev.durianswap.org",
    date: Date.parse("2026-09-17T00:00:00Z"),
    caveats: [
      { type: "restrictChains", value: [CHAIN_ID] },
      { type: "restrictAccounts", value: [ACCOUNT_ID] },
      { type: "restrictMethods", value: [capability] },
    ],
  };
}

function createRuntime(trace, digest, legacyEnabled = true) {
  return createTbcWallet({
    accounts: {
      current: async () => [{
        accountId: ACCOUNT_ID,
        address: ADDRESS,
        chainId: CHAIN_ID,
        publicKey: PUBLIC_KEY,
      }],
    },
    approval: {
      async request(params) {
        trace.push({ operation: "approval", params });
        return {
          status: "approved",
          approvalId: "legacy-bitcoin-approval",
          approvalToken: "legacy-bitcoin-token",
          bindingHash: params.binding.bindingHash,
          approvedAt: "2026-09-17T00:00:03Z",
          expiresAt: params.binding.payload.expiresAt,
        };
      },
    },
    signer: {
      async sign(params) {
        trace.push({ operation: "signer", params });
        const signature = secp256k1.sign(params.task.digest, SCALAR, {
          prehash: false,
          lowS: true,
        });
        return {
          taskId: params.task.taskId,
          signatureEncoding: "compact65-recoverable",
          signature: `${(31 + signature.recovery).toString(16)}${signature.toCompactHex()}`,
        };
      },
    },
    storage: {
      async loadPermissions() {
        return {
          revision: "0",
          permissions: [
            permission("tbc_accounts"),
            permission("tbc_signMessage"),
            permission("tbc_signWorkflow"),
          ],
        };
      },
      async commitPermissions() {
        throw new Error("message signing must not commit permissions");
      },
    },
    network: {
      resolveChainData: async () => { throw new Error("unexpected chain data"); },
      resolvePolicy: async () => { throw new Error("unexpected policy"); },
      broadcastSubmit: async () => { throw new Error("unexpected broadcast"); },
      broadcastReconcile: async () => { throw new Error("unexpected reconcile"); },
    },
    legacy: legacyEnabled
      ? {
          async bitcoinMessageDigest(input) {
            trace.push({ operation: "digest", input });
            return digest;
          },
        }
      : false,
    clock: (() => {
      let second = 0;
      return () => `2026-09-17T00:00:0${String(++second)}Z`;
    })(),
    randomBytes: (length) => Uint8Array.from({ length }, (_, index) => index),
  });
}

test("a public Standard request cannot select Legacy semantics with a valid marker", async () => {
  const trace = [];
  const runtime = createRuntime(trace, LEGACY_DIGEST);
  const session = await runtime.openSession({
    origin: "https://dev.durianswap.org",
    sessionId: "legacy-bitcoin-vector",
  });
  const delivery = await session.handleRequest({
    id: "legacy-bitcoin-vector",
    method: "tbc_signMessage",
    params: {
      version: "1.0",
      chainId: CHAIN_ID,
      from: ADDRESS,
      clientRequestId: `legacy-bitcoin:${LEGACY_DIGEST}`,
      message: { encoding: "utf8", data: "legacy-order" },
    },
  });
  assert.equal("error" in delivery.response, false);
  assert.notEqual(delivery.response.result.digest, LEGACY_DIGEST);
  assert.deepEqual(trace.map(({ operation }) => operation), [
    "approval",
    "signer",
  ]);
  assert.equal(trace[1].params.task.taskId, "sign-message");
  assert.equal(trace[1].params.task.digest, delivery.response.result.digest);
  session.close();
});

test("wallet-owned Legacy workflow does not revive a session-only result after close", async () => {
  const trace = [];
  const runtime = createRuntime(trace, LEGACY_DIGEST);
  const snapshot = Object.freeze({
    currentContext: Object.freeze({
      sessionId: "legacy-workflow-replay",
      transport: "webview",
      origin: "https://dev.durianswap.org",
      topOrigin: "https://dev.durianswap.org",
      frame: "top",
      navigationId: "legacy-workflow-navigation",
      createdAt: "2026-09-17T00:00:00Z",
    }),
    currentSession: Object.freeze({
      version: "1.0",
      scope: Object.freeze({ walletProfile: "tbc-kit-wallet", sessionId: "legacy-workflow-replay" }),
      state: Object.freeze({
        version: "1.0",
        sessionId: "legacy-workflow-replay",
        revision: "0",
        connected: true,
        activeChainId: CHAIN_ID,
        activeAccountIds: Object.freeze([ACCOUNT_ID]),
      }),
    }),
  });
  const authority = Object.freeze({
    async read() { return structuredClone(snapshot); },
    async compareAndSwapSession() { throw new Error("workflow signing must not mutate the session"); },
  });
  const request = Object.freeze({
    id: "stable-legacy-workflow-request",
    method: "tbc_signWorkflow",
    params: Object.freeze({
      version: "1.0",
      chainId: CHAIN_ID,
      from: ADDRESS,
      failureMode: "continue-independent",
      steps: Object.freeze([Object.freeze({
        id: "legacy-1",
        kind: "message",
        dependsOn: Object.freeze([]),
        message: Object.freeze({ encoding: "utf8", data: "legacy-order" }),
      })]),
    }),
  });
  let session = await runtime.openSession({ authority });
  const first = await session.handleLegacyWorkflowRequest(request);
  session.close();
  const firstEffects = trace.map(({ operation }) => operation);
  assert.deepEqual(firstEffects, ["digest", "approval", "signer"]);

  session = await runtime.openSession({ authority });
  await assert.rejects(
    session.handleLegacyWorkflowRequest(request),
    /Host operation did not produce a response: failed/u,
  );
  assert.deepEqual(trace.map(({ operation }) => operation), [
    ...firstEffects,
    "digest",
    "approval",
  ]);
  session.close();
});

test("wallet-owned Legacy route binds the public Bitcoin vector", async () => {
  const trace = [];
  const runtime = createRuntime(trace, LEGACY_DIGEST);
  const session = await runtime.openSession({
    origin: "https://dev.durianswap.org",
    sessionId: "trusted-legacy-bitcoin-vector",
  });
  const delivery = await session.handleLegacyRequest({
    id: "trusted-legacy-bitcoin-vector",
    method: "tbc_signMessage",
    params: {
      version: "1.0",
      chainId: CHAIN_ID,
      from: ADDRESS,
      clientRequestId: `legacy-bitcoin:${LEGACY_DIGEST}`,
      message: { encoding: "utf8", data: "legacy-order" },
    },
  });
  assert.equal("error" in delivery.response, false);
  assert.equal(delivery.response.id, "trusted-legacy-bitcoin-vector");
  assert.equal(delivery.response.result.digest, LEGACY_DIGEST);
  assert.deepEqual(trace[0], {
    operation: "digest",
    input: {
      version: "1.0",
      message: { encoding: "utf8", data: "legacy-order" },
    },
  });
  assert.equal(trace[1].params.binding.payload.operationHash, LEGACY_DIGEST);
  assert.equal(trace[1].params.preview.digest, LEGACY_DIGEST);
  assert.equal(trace[2].params.task.taskId, "legacy-sign-message");
  assert.equal(trace[2].params.task.digest, LEGACY_DIGEST);
  session.close();
});

test("a forged wallet-local request ID cannot activate Legacy semantics", async () => {
  const trace = [];
  const runtime = createRuntime(trace, LEGACY_DIGEST);
  const session = await runtime.openSession({
    origin: "https://dev.durianswap.org",
    sessionId: "forged-wallet-local-route",
  });
  await assert.rejects(
    session.handleRequest({
      id: "kit-legacy:attacker-controlled",
      method: "tbc_signMessage",
      params: {
        version: "1.0",
        chainId: CHAIN_ID,
        from: ADDRESS,
        clientRequestId: `legacy-bitcoin:${LEGACY_DIGEST}`,
        message: { encoding: "utf8", data: "legacy-order" },
      },
    }),
    /Reserved wallet-owned request identity/u,
  );
  assert.deepEqual(trace, []);
  session.close();
});

test("disabled Legacy rejects the wallet-owned route before approval", async () => {
  const trace = [];
  const runtime = createRuntime(trace, LEGACY_DIGEST, false);
  const session = await runtime.openSession({
    origin: "https://dev.durianswap.org",
    sessionId: "disabled-wallet-local-route",
  });
  await assert.rejects(
    session.handleLegacyRequest({
      id: "disabled-wallet-local-route",
      method: "tbc_signMessage",
      params: {
        version: "1.0",
        chainId: CHAIN_ID,
        from: ADDRESS,
        clientRequestId: `legacy-bitcoin:${LEGACY_DIGEST}`,
        message: { encoding: "utf8", data: "legacy-order" },
      },
    }),
    /Legacy Bitcoin message signing is unavailable/u,
  );
  assert.deepEqual(trace, []);
  session.close();
});

test("Kit rejects a mismatched Legacy marker before approval or Signer", async () => {
  const trace = [];
  const runtime = createRuntime(trace, "00".repeat(32));
  const session = await runtime.openSession({
    origin: "https://dev.durianswap.org",
    sessionId: "legacy-bitcoin-mismatch",
  });
  await assert.rejects(
    session.handleLegacyRequest({
      id: "legacy-bitcoin-mismatch",
      method: "tbc_signMessage",
      params: {
        version: "1.0",
        chainId: CHAIN_ID,
        from: ADDRESS,
        clientRequestId: `legacy-bitcoin:${LEGACY_DIGEST}`,
        message: { encoding: "utf8", data: "legacy-order" },
      },
    }),
    /Host operation did not produce a response: failed/u,
  );
  assert.deepEqual(trace.map(({ operation }) => operation), ["digest"]);
  session.close();
});

test("Kit leaves an unmarked Standard message on the canonical digest path", async () => {
  const trace = [];
  const runtime = createRuntime(trace, LEGACY_DIGEST);
  const session = await runtime.openSession({
    origin: "https://dev.durianswap.org",
    sessionId: "standard-message-isolation",
  });
  const delivery = await session.handleRequest({
    id: "standard-message-isolation",
    method: "tbc_signMessage",
    params: {
      version: "1.0",
      chainId: CHAIN_ID,
      from: ADDRESS,
      message: { encoding: "utf8", data: "legacy-order" },
    },
  });
  assert.equal("error" in delivery.response, false);
  assert.deepEqual(trace.map(({ operation }) => operation), [
    "approval",
    "signer",
  ]);
  assert.equal(trace[1].params.task.taskId, "sign-message");
  assert.notEqual(trace[1].params.task.digest, LEGACY_DIGEST);
  assert.equal(
    delivery.response.result.digest,
    trace[1].params.task.digest,
  );
  session.close();
});
