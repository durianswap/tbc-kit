import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { secp256k1 } from "@noble/curves/secp256k1.js";
import {
  TWS_RELEASE_FINGERPRINT,
  deriveOperationId,
  hashCanonical,
} from "@tbc-wallet/core";
import {
  createTbcKitMemoryHostStore,
} from "../dist/esm/sqlite.js";
const {
  assertWalletActionApprovalEvidence,
  createApprovalHostEvidenceReader,
  createTbcWallet,
} = await import(process.env.TBC_KIT_WALLET_TEST_MODULE
  ? pathToFileURL(process.env.TBC_KIT_WALLET_TEST_MODULE).href
  : new URL("../dist/esm/wallet.js", import.meta.url).href);
import { prepareTbcTransaction } from "../dist/esm/prepared.js";

const signing = JSON.parse(await readFile(
  new URL("../../../test-vectors/signing.json", import.meta.url),
  "utf8",
));
const integration = JSON.parse(await readFile(
  new URL("../../../test-vectors/integration.json", import.meta.url),
  "utf8",
));
const canonicalTransfer = integration.canonicalTransfer;
const CHAIN_ID = "tbc:mainnet";
const ADDRESS = "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH";
const ACCOUNT_ID = `${CHAIN_ID}:${ADDRESS}`;
const ORIGIN = "https://durianswap.org";
const PRIVATE_KEY = "01".padStart(64, "0");
const LEGACY_DIGEST = "dcbe45621b28154774991a549de8cd58c72ed87bc7d04e0688e80047071259ab";

function permission(capability) {
  return {
    id: `session-execution-${capability}`,
    parentCapability: capability,
    invoker: ORIGIN,
    date: Date.parse("2026-09-17T00:00:00Z"),
    caveats: [
      { type: "restrictChains", value: [CHAIN_ID] },
      { type: "restrictAccounts", value: [ACCOUNT_ID] },
      { type: "restrictMethods", value: [capability] },
    ],
  };
}

function trackedStore() {
  const events = [];
  const target = createTbcKitMemoryHostStore({
    now: () => Date.parse("2026-09-17T00:00:10Z"),
  });
  const store = Object.fromEntries(Object.entries(target).map(([property, value]) => [
    property,
    typeof value !== "function"
      ? value
      : (...args) => {
          events.push(property);
          return Reflect.apply(value, target, args);
        },
  ]));
  return {
    events,
    store: Object.freeze(store),
  };
}

function vectorParams(vector) {
  const envelope = vector.result.envelope;
  return vector.method === "tbc_signMessage"
    ? {
        version: "1.0",
        chainId: CHAIN_ID,
        from: ADDRESS,
        message: envelope.message,
      }
    : {
        version: "1.0",
        chainId: CHAIN_ID,
        from: ADDRESS,
        data: {
          domain: envelope.domain,
          types: envelope.types,
          primaryType: envelope.primaryType,
          message: envelope.message,
        },
      };
}

function freshChainSnapshot(snapshot) {
  const payload = {
    ...structuredClone(snapshot.payload),
    expiresAt: new Date(Date.now() + 300_000).toISOString().replace(/\.\d{3}Z$/u, "Z"),
  };
  return {
    payload,
    snapshotHash: hashCanonical(payload),
  };
}

function walletOptions(hostStore, observed, signer = {}) {
  const forbidden = async () => {
    throw new Error("unexpected transaction Port");
  };
  return {
    accounts: {
      current: async () => [{
        accountId: ACCOUNT_ID,
        address: ADDRESS,
        chainId: CHAIN_ID,
        publicKey: Buffer.from(secp256k1.getPublicKey(PRIVATE_KEY, true)).toString("hex"),
      }],
    },
    approval: {
      async request(params, call) {
        observed.push(call);
        return {
          status: "approved",
          approvalId: `approval-${params.preview.kind}`,
          approvalToken: `token-${params.preview.kind}`,
          bindingHash: params.binding.bindingHash,
          approvedAt: "2026-09-17T00:00:10Z",
          expiresAt: params.binding.payload.expiresAt,
        };
      },
    },
    signer: {
      async sign(params, call) {
        observed.push(call);
        signer.calls = (signer.calls ?? 0) + 1;
        const signature = secp256k1.sign(params.task.digest, PRIVATE_KEY, {
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
      hostStore,
      async loadPermissions(_params, call) {
        observed.push(call);
        return {
          revision: "0",
          permissions: [
            permission("tbc_accounts"),
            permission("tbc_signMessage"),
            permission("tbc_signTypedData"),
          ],
        };
      },
      async commitPermissions() {
        throw new Error("signing must not commit permissions");
      },
    },
    network: {
      resolveChainData: forbidden,
      resolvePolicy: forbidden,
      broadcastSubmit: forbidden,
      broadcastReconcile: forbidden,
    },
    clock: (_call) => "2026-09-17T00:00:10Z",
    randomBytes: (length) => Uint8Array.from({ length }, (_, index) => index),
  };
}

function transactionWorkflowEngine(previewWarnings) {
  return Object.freeze({
    normalizeRequest(params) {
      return {
        request: structuredClone(params.request),
        requestHash: hashCanonical(params.request),
      };
    },
    plan(params) {
      const plan = structuredClone(canonicalTransfer.plan);
      plan.payload.requestHash = params.requestHash;
      plan.payload.snapshotHash = params.snapshot.snapshotHash;
      plan.payload.policyHash = params.policy.policyHash;
      plan.payload.chainId = params.request.chainId;
      plan.payload.accountId = `${params.request.chainId}:${params.request.from}`;
      if (previewWarnings !== undefined) {
        plan.payload.preview.warnings = [...previewWarnings];
      }
      plan.planHash = hashCanonical(plan.payload);
      return { plan };
    },
    validate() {
      return { valid: true, violations: [] };
    },
    finalize(params) {
      const bundle = structuredClone(canonicalTransfer.bundle);
      bundle.requestHash = params.requestHash;
      bundle.approvalId = params.approval.approvalId;
      return { bundle, validation: { valid: true, violations: [] } };
    },
  });
}

test("Kit owns pure-signing Host routing and exposes session-only Signer execution", async () => {
  const durable = trackedStore();
  const live = trackedStore();
  const observed = [];
  const signer = { calls: 0 };
  const runtime = createTbcWallet(walletOptions(durable.store, observed, signer));
  const session = await runtime.openSession({
    origin: ORIGIN,
    sessionId: "session-execution-signing",
    signOnly: { hostStore: live.store },
  });

  const message = signing.vectors.find(({ method }) => method === "tbc_signMessage");
  const typedData = signing.vectors.find(({ method }) => method === "tbc_signTypedData");
  assert.ok(message && typedData);
  const messageRequest = {
    id: "session-message",
    method: message.method,
    params: vectorParams(message),
  };
  const first = await session.handleRequest(messageRequest);
  const callsAfterFirst = signer.calls;
  const replay = await session.handleRequest(messageRequest);
  assert.deepEqual(replay.response, first.response);
  assert.equal(signer.calls, callsAfterFirst, "replay must not invoke Signer twice");

  const typed = await session.handleRequest({
    id: "session-typed-data",
    method: typedData.method,
    params: vectorParams(typedData),
  });
  assert.equal("error" in typed.response, false);
  assert.equal(durable.events.length, 0, "pure signing must not touch the durable Host store");
  assert.ok(live.events.length > 0);
  assert.ok(observed.length > 0);
  assert.ok(observed.every((call) => call.execution.type === "session-only"));
  assert.ok(observed.every((call) => Object.isFrozen(call.execution)));
  session.close();
});

test("pure signing defaults to an internal live-session store", async () => {
  const durable = trackedStore();
  const observed = [];
  const runtime = createTbcWallet(walletOptions(durable.store, observed, { calls: 0 }));
  const session = await runtime.openSession({
    origin: ORIGIN,
    sessionId: "session-signing-default",
  });
  const message = signing.vectors.find(({ method }) => method === "tbc_signMessage");
  assert.ok(message);
  const delivery = await session.handleRequest({
    id: "durable-signing-default",
    method: message.method,
    params: vectorParams(message),
  });
  assert.equal("error" in delivery.response, false, JSON.stringify(delivery.response));
  assert.equal(durable.events.length, 0);
  assert.ok(observed.every((call) => call.execution.type === "session-only"));
  session.close();
});

test("shared approval preparation covers exact no-fee message consent", async () => {
  const durable = trackedStore();
  const observed = [];
  const reviews = [];
  const signer = { calls: 0 };
  const base = walletOptions(durable.store, observed, signer);
  const runtime = createTbcWallet({
    ...base,
    approvalPreparation: {
      begin() {},
      async review(input) {
        reviews.push(input);
        return { status: "approved" };
      },
    },
    approval: {
      async request(params, call) {
        observed.push(call);
        assert.deepEqual(call.approvalPreparation?.earlyConsent, {
          status: "approved",
        });
        return {
          status: "approved",
          approvalId: "message-early-approval",
          approvalToken: "message-early-token",
          bindingHash: params.binding.bindingHash,
          approvedAt: "2026-09-17T00:00:10Z",
          expiresAt: params.binding.payload.expiresAt,
        };
      },
    },
  });
  const session = await runtime.openSession({
    origin: ORIGIN,
    sessionId: "shared-message-approval-preparation",
  });
  const message = signing.vectors.find(({ method }) => method === "tbc_signMessage");
  assert.ok(message);
  const delivery = await session.handleRequest({
    id: "shared-message-approval-preparation",
    method: message.method,
    params: vectorParams(message),
  });
  assert.equal("error" in delivery.response, false);
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].method, "tbc_signMessage");
  assert.equal(reviews[0].operationKind, "message");
  assert.equal(reviews[0].requiresFeeCap, false);
  assert.equal(reviews[0].suggestedFeeCapAtomic, undefined);
  assert.equal(signer.calls, 1);
  session.close();
});

test("pure crypto workflow early consent has no fee prompt and no chain reads", async () => {
  const durable = trackedStore();
  const observed = [];
  const reviews = [];
  let cryptoCalls = 0;
  const base = walletOptions(durable.store, observed, { calls: 0 });
  const runtime = createTbcWallet({
    ...base,
    approvalPreparation: {
      begin() {},
      async review(input) {
        reviews.push(input);
        assert.equal(input.method, "tbc_signWorkflow");
        assert.equal(input.operationKind, "workflow");
        assert.equal(input.request.steps[0].kind, "encrypt");
        assert.equal(input.requiresFeeCap, false);
        assert.equal(input.suggestedFeeCapAtomic, undefined);
        return { status: "approved" };
      },
    },
    approval: {
      async request(params, call) {
        observed.push(call);
        assert.deepEqual(call.approvalPreparation?.earlyConsent, {
          status: "approved",
        });
        assert.equal(params.preview.totalFee, "0");
        return {
          status: "approved",
          approvalId: "crypto-early-approval",
          approvalToken: "crypto-early-token",
          bindingHash: params.binding.bindingHash,
          approvedAt: "2026-09-17T00:00:10Z",
          expiresAt: params.binding.payload.expiresAt,
        };
      },
    },
    crypto: {
      async execute(params, call) {
        observed.push(call);
        cryptoCalls += 1;
        return {
          taskId: params.task.taskId,
          algorithm: params.task.algorithm,
          ciphertext: Buffer.alloc(85, 7).toString("base64"),
        };
      },
    },
    storage: {
      ...base.storage,
      async loadPermissions(_params, call) {
        observed.push(call);
        return {
          revision: "0",
          permissions: [
            permission("tbc_accounts"),
            permission("tbc_signWorkflow"),
            permission("tbc_crypto"),
          ],
        };
      },
    },
  });
  const session = await runtime.openSession({
    origin: ORIGIN,
    sessionId: "shared-crypto-approval-preparation",
  });
  const delivery = await session.handleRequest({
    id: "shared-crypto-approval-preparation",
    method: "tbc_signWorkflow",
    params: {
      version: "1.0",
      chainId: CHAIN_ID,
      from: ADDRESS,
      steps: [{
        id: "encrypt",
        kind: "encrypt",
        dependsOn: [],
        algorithm: "tbc-bie1-secp256k1-aes128-cbc-hmac-sha256-v1",
        message: { encoding: "utf8", data: "hello" },
      }],
    },
  });
  assert.equal("error" in delivery.response, false, JSON.stringify(delivery.response));
  assert.equal(reviews.length, 1);
  assert.equal(cryptoCalls, 1);
  assert.equal(observed.some(({ operation }) =>
    operation === "chainData.resolve" || operation === "policy.resolve"
  ), false);
  session.close();
});

test("Legacy-off direct Standard workflow shares one preparing UI with its exact approval", async () => {
  const durable = trackedStore();
  const observed = [];
  const lifecycle = [];
  const base = walletOptions(durable.store, observed, { calls: 0 });
  const runtime = createTbcWallet({
    ...base,
    legacy: false,
    approvalPreparation: {
      begin(input) {
        lifecycle.push({ type: "begin", input });
      },
      async review() { return { status: "rejected" }; },
      finish(input) {
        lifecycle.push({ type: "finish", input });
      },
    },
    storage: {
      ...base.storage,
      async loadPermissions(_params, call) {
        observed.push(call);
        return {
          revision: "0",
          permissions: [
            permission("tbc_accounts"),
            permission("tbc_signWorkflow"),
            permission("tbc_signMessage"),
          ],
        };
      },
    },
  });
  const session = await runtime.openSession({
    origin: ORIGIN,
    sessionId: "standard-workflow-preparation-direct",
  });
  const params = {
    version: "1.0",
    chainId: CHAIN_ID,
    from: ADDRESS,
    clientRequestId: "direct-standard-preparation",
    failureMode: "atomic",
    steps: [{
      id: "message-1",
      kind: "message",
      dependsOn: [],
      message: { encoding: "utf8", data: "prepared while visible" },
    }],
  };
  const delivery = await session.handleRequest({
    id: "direct-standard-preparation",
    method: "tbc_signWorkflow",
    params,
  });
  assert.equal("error" in delivery.response, false);
  const approvalCalls = observed.filter(({ operation }) => operation === "approval.request");
  assert.equal(approvalCalls.length, 1);
  assert.equal(lifecycle[0].type, "begin");
  assert.equal(lifecycle.at(-1).type, "finish");
  assert.equal(lifecycle.at(-1).input.outcome, "complete");
  assert.deepEqual(approvalCalls[0].approvalPreparation, {
    preparationId: lifecycle[0].input.preparationId,
    method: "tbc_signWorkflow",
    operationKind: "workflow",
    requestHash: hashCanonical(params),
    startedAt: lifecycle[0].input.startedAt,
    state: "ready",
    earlyConsent: { status: "rejected" },
  });
  await assert.rejects(
    session.handleLegacyWorkflowRequest({
      id: "legacy-disabled",
      method: "tbc_signWorkflow",
      params,
    }),
    /unavailable/u,
  );
  session.close();
});

test("bounded early consent waits for exact Core material and still signs under one approval", async () => {
  const observed = [];
  const lifecycle = [];
  let approvals = 0;
  let signerCalls = 0;
  let resolveDecision;
  const decision = new Promise((resolve) => { resolveDecision = resolve; });
  let signalPolicy;
  const policyReached = new Promise((resolve) => { signalPolicy = resolve; });
  let chainReads = 0;
  let policyReads = 0;
  const hostStore = createTbcKitMemoryHostStore({
    now: () => Date.parse("2026-08-31T12:00:10Z"),
  });
  const runtime = createTbcWallet({
    legacy: false,
    accounts: {
      current: async () => [{
        accountId: ACCOUNT_ID,
        address: ADDRESS,
        chainId: CHAIN_ID,
        publicKey: Buffer.from(secp256k1.getPublicKey(PRIVATE_KEY, true)).toString("hex"),
      }],
    },
    approvalPreparation: {
      begin(input) { lifecycle.push({ type: "begin", input }); },
      async review(input) {
        lifecycle.push({ type: "review", input });
        assert.equal(input.suggestedFeeCapAtomic, "1000");
        assert.equal(input.request.steps[0].intent.type, "tbc.transfer");
        return decision;
      },
      finish(input) { lifecycle.push({ type: "finish", input }); },
    },
    approval: {
      async request(params, call) {
        approvals += 1;
        observed.push(call);
        if (call.approvalPreparation?.earlyConsent?.status !== "approved") {
          return {
            status: "rejected",
            bindingHash: params.binding.bindingHash,
            rejectedAt: "2026-08-31T12:00:10Z",
          };
        }
        return {
          status: "approved",
          approvalId: "early-consent-approval",
          approvalToken: "early-consent-token",
          bindingHash: params.binding.bindingHash,
          approvedAt: "2026-08-31T12:00:10Z",
          expiresAt: params.binding.payload.expiresAt,
        };
      },
    },
    signer: {
      async sign(params) {
        signerCalls += 1;
        if (params.task.purpose === "transaction") {
          return { ...canonicalTransfer.signature, taskId: params.task.taskId };
        }
        const signature = secp256k1.sign(params.task.digest, PRIVATE_KEY, {
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
      hostStore,
      async loadPermissions() {
        return {
          revision: "0",
          permissions: [
            permission("tbc_accounts"),
            permission("tbc_signWorkflow"),
            permission("tbc_signTransaction"),
            permission("tbc_signMessage"),
          ],
        };
      },
      async commitPermissions() { throw new Error("unexpected permission write"); },
    },
    network: {
      async resolveChainData() {
        chainReads += 1;
        return structuredClone(canonicalTransfer.snapshot);
      },
      async resolvePolicy() {
        policyReads += 1;
        signalPolicy();
        return structuredClone(canonicalTransfer.policy);
      },
      async broadcastSubmit() { throw new Error("unexpected broadcast"); },
      async broadcastReconcile() { throw new Error("unexpected reconcile"); },
    },
    engine: transactionWorkflowEngine(),
    clock: () => "2026-08-31T12:00:10Z",
    randomBytes: (length) => Uint8Array.from({ length }, (_, index) => index),
  });
  const session = await runtime.openSession({
    origin: ORIGIN,
    sessionId: "standard-workflow-early-consent",
  });
  const pendingDelivery = session.handleRequest({
    id: "standard-workflow-early-consent",
    method: "tbc_signWorkflow",
    params: {
      version: "1.0",
      chainId: CHAIN_ID,
      from: ADDRESS,
      clientRequestId: "standard-workflow-early-consent",
      maxTotalFee: "1000",
      failureMode: "continue-independent",
      steps: [{
        id: "legacy-1",
        kind: "transaction",
        dependsOn: [],
        intent: canonicalTransfer.request.intent,
        constraints: canonicalTransfer.request.constraints,
      }, {
        id: "legacy-2",
        kind: "message",
        dependsOn: ["legacy-1"],
        message: { encoding: "utf8", data: JSON.stringify({ order: "42" }) },
        bindings: [{
          target: "settlement",
          source: { stepId: "legacy-1", output: "transactionIds" },
        }],
      }],
    },
  });
  await policyReached;
  assert.equal(chainReads, 1);
  assert.equal(policyReads, 1);
  assert.equal(approvals, 0, "formal approval waits for the one visible decision");
  assert.equal(signerCalls, 0, "Signer remains blocked while preparation runs");
  resolveDecision({ status: "approved" });
  const delivery = await pendingDelivery;
  assert.equal("error" in delivery.response, false, JSON.stringify({
    response: delivery.response,
    approvalPreparation: observed[0]?.approvalPreparation,
  }));
  assert.equal(approvals, 1);
  assert.equal(signerCalls, 2);
  assert.deepEqual(observed[0].approvalPreparation?.earlyConsent, {
    status: "approved",
    feeCapAtomic: "1000",
  });
  assert.deepEqual(lifecycle.map(({ type }) => type), ["begin", "review", "finish"]);
  assert.equal(lifecycle.at(-1).input.outcome, "complete");

  await assert.rejects(
    session.handleRequest({
      id: "standard-workflow-over-fee",
      method: "tbc_signWorkflow",
      params: {
      version: "1.0",
      chainId: CHAIN_ID,
      from: ADDRESS,
      clientRequestId: "standard-workflow-over-fee",
      maxTotalFee: "79",
      failureMode: "continue-independent",
      steps: [{
        id: "legacy-1",
        kind: "transaction",
        dependsOn: [],
        intent: canonicalTransfer.request.intent,
        constraints: canonicalTransfer.request.constraints,
      }, {
        id: "legacy-2",
        kind: "message",
        dependsOn: ["legacy-1"],
        message: { encoding: "utf8", data: JSON.stringify({ order: "42" }) },
        bindings: [{
          target: "settlement",
          source: { stepId: "legacy-1", output: "transactionIds" },
        }],
      }],
      },
    }),
    /did not produce a response: failed/u,
  );
  assert.equal(approvals, 1, "over-cap material must stop before formal approval");
  assert.equal(signerCalls, 2, "over-cap material must not reach Signer");

  const changedParams = {
    version: "1.0",
    chainId: CHAIN_ID,
    from: ADDRESS,
    clientRequestId: "standard-workflow-changed-after-review",
    maxTotalFee: "1000",
    failureMode: "continue-independent",
    steps: [{
      id: "legacy-1",
      kind: "transaction",
      dependsOn: [],
      intent: structuredClone(canonicalTransfer.request.intent),
      constraints: canonicalTransfer.request.constraints,
    }, {
      id: "legacy-2",
      kind: "message",
      dependsOn: ["legacy-1"],
      message: { encoding: "utf8", data: JSON.stringify({ order: "42" }) },
      bindings: [{
        target: "settlement",
        source: { stepId: "legacy-1", output: "transactionIds" },
      }],
    }],
  };
  const changed = session.handleRequest({
    id: "standard-workflow-changed-after-review",
    method: "tbc_signWorkflow",
    params: changedParams,
  });
  changedParams.steps[0].intent.amount = "1001";
  const changedDelivery = await changed;
  assert.equal("error" in changedDelivery.response, true);
  assert.equal(approvals, 2);
  assert.equal(observed.at(-1).approvalPreparation, undefined);
  assert.equal(signerCalls, 2, "changed intent must not reuse early consent");

  const expiredConsent = await session.handleRequest({
      id: "standard-workflow-expired-consent",
      method: "tbc_signWorkflow",
      params: {
        version: "1.0",
        chainId: CHAIN_ID,
        from: ADDRESS,
        clientRequestId: "standard-workflow-expired-consent",
        expiresAt: "2026-08-31T12:00:05Z",
        maxTotalFee: "1000",
        failureMode: "continue-independent",
        steps: [{
          id: "legacy-1",
          kind: "transaction",
          dependsOn: [],
          intent: canonicalTransfer.request.intent,
          constraints: canonicalTransfer.request.constraints,
        }, {
          id: "legacy-2",
          kind: "message",
          dependsOn: ["legacy-1"],
          message: { encoding: "utf8", data: JSON.stringify({ order: "42" }) },
          bindings: [{
            target: "settlement",
            source: { stepId: "legacy-1", output: "transactionIds" },
          }],
        }],
      },
    });
  assert.equal(expiredConsent.response.error.code, 4100);
  assert.equal(expiredConsent.response.error.data.reason, "RECEIPT_EXPIRED");
  assert.equal(approvals, 2);
  assert.equal(signerCalls, 2, "expired early consent must not reach Signer");
  session.close();
});

for (const preparedMode of [false, true]) {
test(`generic approval preparation keeps exact dynamic-binding consent for ${preparedMode ? "Prepared" : "ordinary"} formal approval`, async (t) => {
  t.mock.timers.enable({apis: ["Date"], now: Date.parse("2026-08-31T12:00:10Z")});
  const method = preparedMode ? "tbc_signPreparedWorkflow" : "tbc_signWorkflow";
  const proposal = preparedMode ? (await prepareTbcTransaction({
    request: canonicalTransfer.request,
    network: {
      async resolveChainData() { return structuredClone(canonicalTransfer.snapshot); },
      async resolvePolicy() { return structuredClone(canonicalTransfer.policy); },
    },
    engine: transactionWorkflowEngine(),
  })).proposal : undefined;
  const lifecycle = [];
  const approvalCalls = [];
  let signerCalls = 0;
  const runtime = createTbcWallet({
    legacy: false,
    accounts: {
      current: async () => [{
        accountId: ACCOUNT_ID,
        address: ADDRESS,
        chainId: CHAIN_ID,
        publicKey: Buffer.from(secp256k1.getPublicKey(PRIVATE_KEY, true)).toString("hex"),
      }],
    },
    approvalPreparation: {
      begin(input) { lifecycle.push({ type: "begin", input }); },
      async review(input) {
        lifecycle.push({ type: "review", input });
        assert.equal(input.method, method);
        assert.equal(input.operationKind, "workflow");
        assert.equal(input.request.steps.length, 2);
        assert.deepEqual(input.request.steps[1].bindings, [{
          target: "settlement",
          source: { stepId: "legacy-1", output: "transactionIds" },
        }]);
        assert.equal(input.suggestedFeeCapAtomic, "1000");
        return { status: "approved", feeCapAtomic: "1000" };
      },
      finish(input) { lifecycle.push({ type: "finish", input }); },
    },
    approval: {
      async request(params, call) {
        approvalCalls.push({ params, call });
        assert.deepEqual(params.preview.warnings, ["DYNAMIC_BINDING"]);
        if (call.approvalPreparation?.earlyConsent?.status !== "approved") {
          return {
            status: "rejected",
            bindingHash: params.binding.bindingHash,
            rejectedAt: "2026-08-31T12:00:10Z",
          };
        }
        return {
          status: "approved",
          approvalId: "generic-dynamic-binding-approval",
          approvalToken: "generic-dynamic-binding-token",
          bindingHash: params.binding.bindingHash,
          approvedAt: "2026-08-31T12:00:10Z",
          expiresAt: params.binding.payload.expiresAt,
        };
      },
    },
    signer: {
      async sign(params) {
        signerCalls += 1;
        if (params.task.purpose === "transaction") {
          return { ...canonicalTransfer.signature, taskId: params.task.taskId };
        }
        const signature = secp256k1.sign(params.task.digest, PRIVATE_KEY, {
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
      hostStore: createTbcKitMemoryHostStore({
        now: () => Date.parse("2026-08-31T12:00:10Z"),
      }),
      async loadPermissions() {
        return {
          revision: "0",
          permissions: [
            permission("tbc_accounts"),
            permission("tbc_signWorkflow"),
            permission("tbc_signTransaction"),
            permission("tbc_signMessage"),
          ],
        };
      },
      async commitPermissions() { throw new Error("unexpected permission write"); },
    },
    network: {
      async resolveChainData() { return structuredClone(canonicalTransfer.snapshot); },
      async resolvePolicy() { return structuredClone(canonicalTransfer.policy); },
      async broadcastSubmit() { throw new Error("unexpected broadcast"); },
      async broadcastReconcile() { throw new Error("unexpected reconcile"); },
    },
    engine: transactionWorkflowEngine(),
    clock: () => "2026-08-31T12:00:10Z",
    randomBytes: (length) => Uint8Array.from({ length }, (_, index) => index),
  });
  const session = await runtime.openSession({
    origin: ORIGIN,
    sessionId: "generic-dynamic-binding-approval",
  });
  const delivery = await session.handleRequest({
    id: "generic-dynamic-binding-approval",
    method,
    params: {
      version: "1.0",
      chainId: CHAIN_ID,
      from: ADDRESS,
      clientRequestId: "generic-dynamic-binding-approval",
      maxTotalFee: "1000",
      failureMode: "continue-independent",
      steps: [{
        id: "legacy-1",
        kind: preparedMode ? "preparedTransaction" : "transaction",
        ...(preparedMode ? {proposal} : {}),
        dependsOn: [],
        intent: canonicalTransfer.request.intent,
        constraints: canonicalTransfer.request.constraints,
      }, {
        id: "legacy-2",
        kind: "message",
        dependsOn: ["legacy-1"],
        message: { encoding: "utf8", data: JSON.stringify({ order: "42" }) },
        bindings: [{
          target: "settlement",
          source: { stepId: "legacy-1", output: "transactionIds" },
        }],
      }],
    },
  });
  assert.equal("error" in delivery.response, false, JSON.stringify(delivery.response));
  assert.equal(approvalCalls.length, 1);
  assert.deepEqual(approvalCalls[0].call.approvalPreparation.earlyConsent, {
    status: "approved",
    feeCapAtomic: "1000",
  });
  assert.equal(signerCalls, 2);
  assert.deepEqual(lifecycle.map(({ type }) => type), ["begin", "review", "finish"]);
  assert.equal(lifecycle.at(-1).input.outcome, "complete");
  if (preparedMode) {
    const ahead = structuredClone(proposal);
    ahead.payload.expiresAt = "2026-08-31T12:00:00Z";
    ahead.proposalHash = hashCanonical(ahead.payload);
    const refused = await session.handleRequest({id: "prepared-clock-refusal", method: "tbc_signPreparedTransaction",
      params: {...canonicalTransfer.request, proposal: ahead}});
    assert.equal(refused.response.error?.code, 4100);
    assert.match(refused.response.error.message, /proposal has expired/);
    assert.equal(signerCalls, 2, "a rejected proposal must not add a signature");
    const stillConnected = await session.handleRequest({id: "after-clock-refusal", method: "tbc_chainId"});
    assert.equal(stillConnected.response.result, CHAIN_ID, "request refusal must preserve the connection");
  }
  session.close();
});
}

test("Legacy generic workflow starts exact chain-data prefetch after review begins", async () => {
  const lifecycle = [];
  const observed = [];
  let chainReads = 0;
  let policyReads = 0;
  const hostStore = createTbcKitMemoryHostStore({
    now: () => Date.parse("2026-08-31T12:00:10Z"),
  });
  const runtime = createTbcWallet({
    legacy: { async bitcoinMessageDigest() { return LEGACY_DIGEST; } },
    accounts: {
      current: async () => [{
        accountId: ACCOUNT_ID,
        address: ADDRESS,
        chainId: CHAIN_ID,
        publicKey: Buffer.from(secp256k1.getPublicKey(PRIVATE_KEY, true)).toString("hex"),
      }],
    },
    approvalPreparation: {
      begin() {
        lifecycle.push("begin");
      },
      async review(input) {
        lifecycle.push("review");
        return { status: "approved", feeCapAtomic: "1000" };
      },
      finish(input) {
        lifecycle.push(`finish:${input.outcome}`);
      },
    },
    approval: {
      async request(params, call) {
        observed.push({ params, call });
        return {
          status: "approved",
          approvalId: "legacy-prefetch-approval",
          approvalToken: "legacy-prefetch-token",
          bindingHash: params.binding.bindingHash,
          approvedAt: "2026-08-31T12:00:10Z",
          expiresAt: params.binding.payload.expiresAt,
        };
      },
    },
    signer: {
      async sign(params) {
        if (params.task.purpose === "transaction") {
          return { ...canonicalTransfer.signature, taskId: params.task.taskId };
        }
        const signature = secp256k1.sign(params.task.digest, PRIVATE_KEY, {
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
      hostStore,
      async loadPermissions() {
        return {
          revision: "0",
          permissions: [
            permission("tbc_accounts"),
            permission("tbc_signWorkflow"),
            permission("tbc_signTransaction"),
            permission("tbc_signMessage"),
          ],
        };
      },
      async commitPermissions() {
        throw new Error("unexpected permission write");
      },
    },
    network: {
      async resolveChainData() {
        assert.ok(lifecycle.includes("begin"), "prefetch must start after review shell begins");
        chainReads += 1;
        return structuredClone(canonicalTransfer.snapshot);
      },
      async resolvePolicy() {
        policyReads += 1;
        return structuredClone(canonicalTransfer.policy);
      },
      async broadcastSubmit() {
        throw new Error("unexpected broadcast");
      },
      async broadcastReconcile() {
        throw new Error("unexpected reconcile");
      },
    },
    engine: transactionWorkflowEngine(),
    clock: () => "2026-08-31T12:00:10Z",
    randomBytes: (length) => Uint8Array.from({ length }, (_, index) => index),
  });
  const session = await runtime.openSession({
    origin: ORIGIN,
    sessionId: "legacy-generic-workflow-prefetch",
  });
  const delivery = await session.handleLegacyWorkflowRequest({
    id: "legacy-prefetch-request",
    method: "tbc_signWorkflow",
    params: {
      version: "1.0",
      chainId: CHAIN_ID,
      from: ADDRESS,
      clientRequestId: "legacy-prefetch-request",
      maxTotalFee: "1000",
      failureMode: "continue-independent",
      steps: [{
        id: "legacy-1",
        kind: "transaction",
        dependsOn: [],
        intent: canonicalTransfer.request.intent,
        constraints: canonicalTransfer.request.constraints,
      }, {
        id: "legacy-2",
        kind: "message",
        dependsOn: ["legacy-1"],
        message: { encoding: "utf8", data: JSON.stringify({ order: "42" }) },
        bindings: [{
          target: "settlement",
          source: { stepId: "legacy-1", output: "transactionIds" },
        }],
      }],
    },
  });
  assert.equal("error" in delivery.response, false, JSON.stringify(delivery.response));
  assert.equal(chainReads, 1, "generic Legacy workflow must consume one prefetched Chain Data result");
  assert.equal(policyReads, 1);
  assert.equal(observed.length, 1, "one formal approval remains");
  assert.deepEqual(lifecycle, ["begin", "review", "finish:complete"]);
  session.close();
});

test("generic dynamic-binding consent does not cover an undisplayed preview warning", async () => {
  const approvalCalls = [];
  let signerCalls = 0;
  const runtime = createTbcWallet({
    legacy: false,
    accounts: {
      current: async () => [{
        accountId: ACCOUNT_ID,
        address: ADDRESS,
        chainId: CHAIN_ID,
        publicKey: Buffer.from(secp256k1.getPublicKey(PRIVATE_KEY, true)).toString("hex"),
      }],
    },
    approvalPreparation: {
      begin() {},
      async review(input) {
        assert.equal(input.request.steps.length, 2);
        return { status: "approved", feeCapAtomic: "1000" };
      },
    },
    approval: {
      async request(params, call) {
        approvalCalls.push(call);
        assert.deepEqual(params.preview.warnings, ["PRICE_IMPACT", "DYNAMIC_BINDING"]);
        assert.equal(
          call.approvalPreparation?.earlyConsent,
          undefined,
          "a warning absent from the early exact request review requires formal wallet approval",
        );
        return {
          status: "approved",
          approvalId: "unknown-warning-formal-approval",
          approvalToken: "unknown-warning-formal-token",
          bindingHash: params.binding.bindingHash,
          approvedAt: "2026-08-31T12:00:10Z",
          expiresAt: params.binding.payload.expiresAt,
        };
      },
    },
    signer: {
      async sign(params) {
        signerCalls += 1;
        if (params.task.purpose === "transaction") {
          return { ...canonicalTransfer.signature, taskId: params.task.taskId };
        }
        const signature = secp256k1.sign(params.task.digest, PRIVATE_KEY, {
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
      hostStore: createTbcKitMemoryHostStore({
        now: () => Date.parse("2026-08-31T12:00:10Z"),
      }),
      async loadPermissions() {
        return {
          revision: "0",
          permissions: [
            permission("tbc_accounts"),
            permission("tbc_signWorkflow"),
            permission("tbc_signTransaction"),
            permission("tbc_signMessage"),
          ],
        };
      },
      async commitPermissions() { throw new Error("unexpected permission write"); },
    },
    network: {
      async resolveChainData() { return structuredClone(canonicalTransfer.snapshot); },
      async resolvePolicy() { return structuredClone(canonicalTransfer.policy); },
      async broadcastSubmit() { throw new Error("unexpected broadcast"); },
      async broadcastReconcile() { throw new Error("unexpected reconcile"); },
    },
    engine: transactionWorkflowEngine(["PRICE_IMPACT"]),
    clock: () => "2026-08-31T12:00:10Z",
    randomBytes: (length) => Uint8Array.from({ length }, (_, index) => index),
  });
  const session = await runtime.openSession({
    origin: ORIGIN,
    sessionId: "generic-dynamic-binding-unknown-warning",
  });
  const delivery = await session.handleRequest({
    id: "generic-dynamic-binding-unknown-warning",
    method: "tbc_signWorkflow",
    params: {
      version: "1.0",
      chainId: CHAIN_ID,
      from: ADDRESS,
      clientRequestId: "generic-dynamic-binding-unknown-warning",
      maxTotalFee: "1000",
      failureMode: "continue-independent",
      steps: [{
        id: "legacy-1",
        kind: "transaction",
        dependsOn: [],
        intent: canonicalTransfer.request.intent,
        constraints: canonicalTransfer.request.constraints,
      }, {
        id: "legacy-2",
        kind: "message",
        dependsOn: ["legacy-1"],
        message: { encoding: "utf8", data: JSON.stringify({ order: "42" }) },
        bindings: [{
          target: "settlement",
          source: { stepId: "legacy-1", output: "transactionIds" },
        }],
      }],
    },
  });
  assert.equal("error" in delivery.response, false, JSON.stringify(delivery.response));
  assert.equal(approvalCalls.length, 1);
  assert.equal(signerCalls, 2);
  session.close();
});

for (const consentCase of [
  { name: "plain", warnings: [], cap: "1000", approved: true },
  { name: "funding prerequisite", warnings: ["MULTI_TRANSACTION", "MAINTENANCE_TRANSACTION"], cap: "1000", approved: true },
  { name: "undisclosed risk", warnings: ["MULTI_TRANSACTION", "MAINTENANCE_TRANSACTION", "PRICE_IMPACT"], cap: "1000", approved: false },
  { name: "fee exceeds consent", warnings: ["MULTI_TRANSACTION", "MAINTENANCE_TRANSACTION"], cap: "0", approved: false },
  { name: "consent widens request", warnings: [], cap: "50000", approved: false },
]) test(`shared approval preparation covers a Standard LP transaction without duplicate reads: ${consentCase.name}`, async () => {
  const lifecycle = [];
  const approvalCalls = [];
  const chainCalls = [];
  let chainReads = 0;
  let policyReads = 0;
  let signerCalls = 0;
  let resolveDecision;
  const decision = new Promise((resolve) => { resolveDecision = resolve; });
  let signalPolicy;
  const policyReached = new Promise((resolve) => { signalPolicy = resolve; });
  const runtime = createTbcWallet({
    legacy: false,
    accounts: {
      current: async () => [{
        accountId: ACCOUNT_ID,
        address: ADDRESS,
        chainId: CHAIN_ID,
        publicKey: Buffer.from(secp256k1.getPublicKey(PRIVATE_KEY, true)).toString("hex"),
      }],
    },
    approvalPreparation: {
      begin(input) { lifecycle.push({ type: "begin", input }); },
      async review(input) {
        lifecycle.push({ type: "review", input });
        assert.equal(input.method, "tbc_signTransaction");
        assert.equal(input.operationKind, "transaction");
        assert.equal(input.request.intent.type, "tbc.pool.liquidity.add");
        assert.deepEqual(input.warningScope, ["MULTI_TRANSACTION", "MAINTENANCE_TRANSACTION"]);
        assert.equal(input.requiresFeeCap, true);
        assert.equal(input.suggestedFeeCapAtomic, "1000");
        return decision;
      },
      finish(input) { lifecycle.push({ type: "finish", input }); },
    },
    approval: {
      async request(params, call) {
        approvalCalls.push(call);
        if (call.approvalPreparation?.earlyConsent?.status !== "approved") {
          return {
            status: "rejected",
            bindingHash: params.binding.bindingHash,
            rejectedAt: "2026-08-31T12:00:10Z",
          };
        }
        return {
          status: "approved",
          approvalId: "lp-shared-approval",
          approvalToken: "lp-shared-token",
          bindingHash: params.binding.bindingHash,
          approvedAt: "2026-08-31T12:00:10Z",
          expiresAt: params.binding.payload.expiresAt,
        };
      },
    },
    signer: {
      async sign(params) {
        signerCalls += 1;
        return { ...canonicalTransfer.signature, taskId: params.task.taskId };
      },
    },
    storage: {
      hostStore: createTbcKitMemoryHostStore({
        now: () => Date.parse("2026-08-31T12:00:10Z"),
      }),
      async loadPermissions() {
        return {
          revision: "0",
          permissions: [
            permission("tbc_accounts"),
            permission("tbc_signTransaction"),
          ],
        };
      },
      async commitPermissions() { throw new Error("unexpected permission write"); },
    },
    network: {
      async resolveChainData(_params, call) {
        chainCalls.push({ params: _params, call });
        chainReads += 1;
        return freshChainSnapshot(canonicalTransfer.snapshot);
      },
      async resolvePolicy() {
        policyReads += 1;
        signalPolicy();
        return structuredClone(canonicalTransfer.policy);
      },
      async broadcastSubmit() { throw new Error("unexpected broadcast"); },
      async broadcastReconcile() { throw new Error("unexpected reconcile"); },
    },
    engine: transactionWorkflowEngine(consentCase.warnings),
    clock: () => "2026-08-31T12:00:10Z",
    randomBytes: (length) => Uint8Array.from({ length }, (_, index) => index),
  });
  const session = await runtime.openSession({
    origin: ORIGIN,
    sessionId: "shared-lp-approval-preparation",
  });
  const pending = session.handleRequest({
    id: "shared-lp-add",
    method: "tbc_signTransaction",
    params: {
      version: "1.0",
      chainId: CHAIN_ID,
      from: ADDRESS,
      clientRequestId: "shared-lp-add",
      intent: {
        version: "1.0",
        type: "tbc.pool.liquidity.add",
        poolContractId: "22".repeat(32),
        receiver: ADDRESS,
        tbcAmount: "1000",
        minimumLpAmount: "1",
      },
      constraints: { maxFee: "1000" },
    },
  });
  await policyReached;
  assert.equal(chainReads, 1);
  assert.equal(policyReads, 1);
  assert.equal(approvalCalls.length, 0);
  assert.equal(signerCalls, 0);
  resolveDecision({ status: "approved", feeCapAtomic: consentCase.cap });
  const delivery = await pending;
  assert.equal("error" in delivery.response, !consentCase.approved, JSON.stringify(delivery.response));
  assert.equal(chainReads, 1, "formal execution must reuse its in-flight Chain Data work");
  assert.equal(chainCalls.length, 1);
  assert.equal(
    chainCalls[0].call,
    undefined,
    "Standard approval must start the memory-only prefetch; formal Host execution must consume it",
  );
  assert.equal(policyReads, 1, "formal execution must reuse its in-flight policy work");
  assert.equal(approvalCalls.length, 1);
  assert.equal(signerCalls, consentCase.approved ? 1 : 0);
  assert.deepEqual(approvalCalls[0].approvalPreparation?.earlyConsent, consentCase.approved ? {
    status: "approved",
    feeCapAtomic: "1000",
  } : undefined);
  assert.deepEqual(lifecycle.map(({ type }) => type), ["begin", "review", "finish"]);
  session.close();
});

test("disabled historical FT issuance cannot be re-enabled by early consent", async () => {
  for (const { warnings, expectedEarlyConsent } of [
    { warnings: ["FT_MINT_V4"], expectedEarlyConsent: true },
    { warnings: ["FT_MINT_V4", "PRICE_IMPACT"], expectedEarlyConsent: false },
  ]) {
    const approvalCalls = [];
    let signerCalls = 0;
    const runtime = createTbcWallet({
      legacy: false,
      accounts: {
        current: async () => [{
          accountId: ACCOUNT_ID,
          address: ADDRESS,
          chainId: CHAIN_ID,
          publicKey: Buffer.from(secp256k1.getPublicKey(PRIVATE_KEY, true)).toString("hex"),
        }],
      },
      approvalPreparation: {
        begin() {},
        async review(input) {
          assert.equal(input.request.intent.type, "tbc.ft.create");
          assert.deepEqual(input.warningScope, ["FT_MINT_V4"]);
          return { status: "approved" };
        },
        finish() {},
      },
      approval: {
        async request(params, call) {
          approvalCalls.push(call);
          assert.equal(
            call.approvalPreparation?.earlyConsent?.status === "approved",
            expectedEarlyConsent,
          );
          return {
            status: "approved",
            approvalId: expectedEarlyConsent ? "ft-mint-early" : "ft-mint-formal",
            approvalToken: expectedEarlyConsent ? "ft-mint-early-token" : "ft-mint-formal-token",
            bindingHash: params.binding.bindingHash,
            approvedAt: "2026-08-31T12:00:10Z",
            expiresAt: params.binding.payload.expiresAt,
          };
        },
      },
      signer: {
        async sign(params) {
          signerCalls += 1;
          return { ...canonicalTransfer.signature, taskId: params.task.taskId };
        },
      },
      storage: {
        hostStore: createTbcKitMemoryHostStore({
          now: () => Date.parse("2026-08-31T12:00:10Z"),
        }),
        async loadPermissions() {
          return {
            revision: "0",
            permissions: [permission("tbc_accounts"), permission("tbc_signTransaction")],
          };
        },
        async commitPermissions() { throw new Error("unexpected permission write"); },
      },
      network: {
        async resolveChainData() { return freshChainSnapshot(canonicalTransfer.snapshot); },
        async resolvePolicy() { return structuredClone(canonicalTransfer.policy); },
        async broadcastSubmit() { throw new Error("unexpected broadcast"); },
        async broadcastReconcile() { throw new Error("unexpected reconcile"); },
      },
      engine: transactionWorkflowEngine(warnings),
      clock: () => "2026-08-31T12:00:10Z",
      randomBytes: (length) => Uint8Array.from({ length }, (_, index) => index),
    });
    const session = await runtime.openSession({
      origin: ORIGIN,
      sessionId: `ft-mint-warning-${expectedEarlyConsent ? "fixed" : "unknown"}`,
    });
    const delivery = await session.handleRequest({
      id: `ft-mint-warning-${expectedEarlyConsent ? "fixed" : "unknown"}`,
      method: "tbc_signTransaction",
      params: {
        version: "1.0",
        chainId: CHAIN_ID,
        from: ADDRESS,
        clientRequestId: `ft-mint-warning-${expectedEarlyConsent ? "fixed" : "unknown"}`,
        intent: {
          version: "1.0",
          type: "tbc.ft.create",
          name: "Candidate Token",
          symbol: "C142",
          decimals: 6,
          initialSupply: "1000000",
        },
        constraints: { maxFee: "1000" },
      },
    });
    assert.equal(delivery.response.error?.code, 4200);
    assert.match(delivery.response.error.message, /Historical asset issuance is disabled/);
    assert.equal(approvalCalls.length, 0);
    assert.equal(signerCalls, 0);
    session.close();
  }
});

for (const expiryCase of ["approved", "rejected", "timer-cancelled"]) {
test(`early consent expiry preserves cancellation but never late approval: ${expiryCase}`, async () => {
  let resolveDecision;
  const decision = new Promise((resolve) => { resolveDecision = resolve; });
  let signalReview;
  const reviewReached = new Promise((resolve) => { signalReview = resolve; });
  const approvalCalls = [];
  const finishes = [];
  let signerCalls = 0;
  const runtime = createTbcWallet({
    legacy: false,
    accounts: {
      current: async () => [{
        accountId: ACCOUNT_ID,
        address: ADDRESS,
        chainId: CHAIN_ID,
        publicKey: Buffer.from(secp256k1.getPublicKey(PRIVATE_KEY, true)).toString("hex"),
      }],
    },
    approvalPreparation: {
      begin() {},
      review(input) {
        if (input.request.clientRequestId === "presentation-throws") {
          throw new Error("presentation unavailable");
        }
        signalReview(input);
        return decision;
      },
      finish(input) { finishes.push(input); },
    },
    approval: {
      async request(params, call) {
        approvalCalls.push(call);
        return {
          status: "rejected",
          bindingHash: params.binding.bindingHash,
          rejectedAt: "2026-08-31T12:00:10Z",
        };
      },
    },
    signer: {
      async sign() {
        signerCalls += 1;
        throw new Error("rejected preparation must not reach Signer");
      },
    },
    storage: {
      hostStore: createTbcKitMemoryHostStore({
        now: () => Date.parse("2026-08-31T12:00:10Z"),
      }),
      async loadPermissions() {
        return {
          revision: "0",
          permissions: [
            permission("tbc_accounts"),
            permission("tbc_signWorkflow"),
            permission("tbc_signTransaction"),
            permission("tbc_signMessage"),
          ],
        };
      },
      async commitPermissions() { throw new Error("unexpected permission write"); },
    },
    network: {
      async resolveChainData() { return structuredClone(canonicalTransfer.snapshot); },
      async resolvePolicy() { return structuredClone(canonicalTransfer.policy); },
      async broadcastSubmit() { throw new Error("unexpected broadcast"); },
      async broadcastReconcile() { throw new Error("unexpected reconcile"); },
    },
    engine: transactionWorkflowEngine(),
    clock: () => "2026-08-31T12:00:10Z",
    randomBytes: (length) => Uint8Array.from({ length }, (_, index) => index),
  });
  const session = await runtime.openSession({
    origin: ORIGIN,
    sessionId: "early-consent-post-await-recheck",
  });
  const steps = [{
    id: "legacy-1",
    kind: "transaction",
    dependsOn: [],
    intent: canonicalTransfer.request.intent,
    constraints: canonicalTransfer.request.constraints,
  }, {
    id: "legacy-2",
    kind: "message",
    dependsOn: ["legacy-1"],
    message: { encoding: "utf8", data: JSON.stringify({ settlement: [] }) },
    bindings: [{
      target: "settlement",
      source: { stepId: "legacy-1", output: "transactionIds" },
    }],
  }];
  const expiresAt = new Date(Date.now() + 1500).toISOString().replace(/\.\d{3}Z$/u, "Z");
  const expired = session.handleRequest({
    id: "review-crosses-expiry",
    method: "tbc_signWorkflow",
    params: {
      version: "1.0",
      chainId: CHAIN_ID,
      from: ADDRESS,
      clientRequestId: "review-crosses-expiry",
      expiresAt,
      maxTotalFee: "1000",
      failureMode: "continue-independent",
      steps,
    },
  });
  const reviewInput = await reviewReached;
  // Let formal preparation reach its pending consent await before advancing
  // past expiry; opening the early loading UI alone is not that boundary.
  await new Promise((resolve) => setImmediate(resolve));
  if (expiryCase === "timer-cancelled") {
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, reviewInput.expiresAt - Date.now()) + 20));
  } else while (Date.now() <= reviewInput.expiresAt) {
    // Keep this turn occupied so the authorization check, not the cleanup
    // timer, is what rejects the now-expired early decision.
  }
  if (expiryCase !== "timer-cancelled") assert.equal(finishes.length, 0);
  resolveDecision({ status: expiryCase === "approved" ? "approved" : "rejected" });
  const expiredDelivery = await expired;
  assert.equal("error" in expiredDelivery.response, true);
  assert.equal(approvalCalls.length, 1);
  if (expiryCase === "approved") {
    assert.equal(approvalCalls[0].approvalPreparation, undefined);
  } else {
    assert.equal(approvalCalls[0].approvalPreparation?.earlyConsent?.status, "rejected");
    assert.equal(expiredDelivery.response.error.code, 4001);
  }
  assert.equal(signerCalls, 0);

  const fallbackDelivery = await session.handleRequest({
    id: "presentation-throws",
    method: "tbc_signWorkflow",
    params: {
      version: "1.0",
      chainId: CHAIN_ID,
      from: ADDRESS,
      clientRequestId: "presentation-throws",
      maxTotalFee: "1000",
      failureMode: "continue-independent",
      steps,
    },
  });
  assert.equal("error" in fallbackDelivery.response, true);
  assert.equal(approvalCalls.length, 2);
  assert.equal(approvalCalls[1].approvalPreparation.state, "ready");
  assert.equal(approvalCalls[1].approvalPreparation.earlyConsent, undefined);
  assert.equal(signerCalls, 0);
  session.close();
});

}

test("identical concurrent Standard workflows never cross-adopt a preparing UI", async () => {
  const durable = trackedStore();
  const lifecycle = [];
  const approvalCalls = [];
  let releaseApprovals;
  const approvalGate = new Promise((resolve) => { releaseApprovals = resolve; });
  let bothApprovals;
  const approvalsReached = new Promise((resolve) => { bothApprovals = resolve; });
  const base = walletOptions(durable.store, [], { calls: 0 });
  const runtime = createTbcWallet({
    ...base,
    legacy: false,
    approvalPreparation: {
      begin(input) { lifecycle.push({ type: "begin", input }); },
      async review() { return { status: "rejected" }; },
      finish(input) { lifecycle.push({ type: "finish", input }); },
    },
    approval: {
      async request(params, call) {
        approvalCalls.push({ params, call });
        const approvalIndex = approvalCalls.length;
        if (approvalCalls.length === 2) bothApprovals();
        await approvalGate;
        return {
          status: "approved",
          approvalId: `approval-${approvalIndex}`,
          approvalToken: `token-${approvalIndex}`,
          bindingHash: params.binding.bindingHash,
          approvedAt: "2026-09-17T00:00:10Z",
          expiresAt: params.binding.payload.expiresAt,
        };
      },
    },
    storage: {
      ...base.storage,
      async loadPermissions() {
        return {
          revision: "0",
          permissions: [
            permission("tbc_accounts"),
            permission("tbc_signWorkflow"),
            permission("tbc_signMessage"),
          ],
        };
      },
    },
  });
  const session = await runtime.openSession({
    origin: ORIGIN,
    sessionId: "standard-workflow-preparation-concurrent",
  });
  const params = {
    version: "1.0",
    chainId: CHAIN_ID,
    from: ADDRESS,
    clientRequestId: "same-request-hash",
    failureMode: "atomic",
    steps: [{
      id: "message-1",
      kind: "message",
      dependsOn: [],
      message: { encoding: "utf8", data: "same request" },
    }],
  };
  const first = session.handleRequest({ id: "concurrent-a", method: "tbc_signWorkflow", params });
  const second = session.handleRequest({ id: "concurrent-b", method: "tbc_signWorkflow", params });
  await approvalsReached;
  assert.equal(lifecycle.filter(({ type }) => type === "begin").length, 2);
  assert.equal(approvalCalls.length, 2);
  assert.ok(approvalCalls.every(({ call }) => call.approvalPreparation === undefined));
  releaseApprovals();
  const deliveries = await Promise.all([first, second]);
  assert.ok(deliveries.every(({ response }) => !("error" in response)));
  assert.equal(lifecycle.filter(({ type }) => type === "finish").length, 2);
  session.close();
});

test("an approvalPreparation handle cannot cross wallet sessions", async () => {
  const durable = trackedStore();
  const options = walletOptions(durable.store, [], { calls: 0 });
  const runtime = createTbcWallet({
    ...options,
    legacy: { async bitcoinMessageDigest() { return LEGACY_DIGEST; } },
  });
  const first = await runtime.openSession({ origin: ORIGIN, sessionId: "preparation-owner" });
  const second = await runtime.openSession({ origin: ORIGIN, sessionId: "preparation-other" });
  const handle = first.beginApprovalPreparation({
    requestId: "cross-session",
    method: "tbc_signWorkflow",
    requestCount: 1,
    inputHash: "11".repeat(32),
  });
  await assert.rejects(
    second.handleLegacyWorkflowRequest({
      id: "cross-session",
      method: "tbc_signWorkflow",
      approvalPreparation: handle,
      params: {
        version: "1.0",
        chainId: CHAIN_ID,
        from: ADDRESS,
        steps: [{
          id: "message-1",
          kind: "message",
          dependsOn: [],
          message: { encoding: "utf8", data: "cross-session" },
        }],
      },
    }),
    /Unknown or expired Standard approval preparation/u,
  );
  handle.cancel();
  first.close();
  second.close();
});

test("wallet-native session exposes Kit-owned start, inspect, and resume without a WebView", async () => {
  const historical = trackedStore();
  const live = trackedStore();
  const runtime = createTbcWallet(walletOptions(historical.store, [], { calls: 0 }));
  const session = await runtime.openSession({
    origin: "https://wallet-native.tbc-kit.invalid",
    sessionId: "wallet-native-operation-facade",
    execution: { hostStore: live.store },
  });
  const started = await session.startOperation({
    id: "wallet-native-chain-id",
    method: "tbc_chainId",
  });
  assert.equal(started.status, "complete");
  const inspection = await session.inspectOperation(started.operationId);
  assert.equal(inspection.operationId, started.operationId);
  assert.equal(inspection.terminal, true);
  assert.equal(inspection.state, "completed");
  const resumed = await session.resumeOperation(started.operationId);
  assert.equal(resumed.status, "complete");
  assert.deepEqual(resumed.completion.response, started.completion.response);
  assert.ok(live.events.length > 0);
  assert.equal(historical.events.length, 0);
  session.close();
});

test("wallet-native cancellation does not interrupt an in-flight session callback", async () => {
  const historical = trackedStore();
  const live = trackedStore();
  const sessionId = "wallet-native-cancel";
  const createdAt = "2026-09-17T00:00:00Z";
  const authority = {
    currentContext: {
      sessionId,
      transport: "remote",
      origin: "https://wallet-native.tbc-kit.invalid",
      topOrigin: "https://wallet-native.tbc-kit.invalid",
      frame: "top",
      createdAt,
    },
    currentSession: {
      version: "1.0",
      scope: { walletProfile: "tbc-kit-wallet", sessionId },
      state: {
        version: "1.0",
        sessionId,
        revision: "0",
        connected: true,
        activeChainId: CHAIN_ID,
        activeAccountIds: [ACCOUNT_ID],
      },
    },
  };
  let releaseClock;
  let clockStarted;
  const clockReached = new Promise((resolve) => {
    clockStarted = resolve;
  });
  const clockRelease = new Promise((resolve) => {
    releaseClock = resolve;
  });
  const options = walletOptions(historical.store, [], { calls: 0 });
  const runtime = createTbcWallet({
    ...options,
    clock: async () => {
      clockStarted();
      await clockRelease;
      return "2026-09-17T00:00:10Z";
    },
  });
  const session = await runtime.openSession({
    authority: {
      read: async () => structuredClone(authority),
      compareAndSwapSession: async () => {
        throw new Error("chain-id cancellation must not mutate authority");
      },
    },
    execution: { hostStore: live.store },
  });
  const request = { id: "wallet-native-cancel-chain-id", method: "tbc_chainId" };
  const operationId = deriveOperationId({
    releaseFingerprint: TWS_RELEASE_FINGERPRINT,
    contextHash: hashCanonical(authority.currentContext),
    requestId: request.id,
    operation: { method: request.method, params: [] },
  });

  const started = session.startOperation(request);
  await clockReached;
  const queued = await session.cancelOperation(operationId);
  assert.deepEqual(queued, { status: "busy", operationId, retryable: true });
  releaseClock();

  const completed = await started;
  assert.equal(completed.status, "complete");
  const inspection = await session.inspectOperation(operationId);
  assert.equal(inspection.terminal, true);
  assert.equal(inspection.state, "completed");
  session.close();
});

test("Kit routes every new method through one session-scoped Host store", async () => {
  const historical = trackedStore();
  const live = trackedStore();
  const runtime = createTbcWallet(walletOptions(historical.store, [], { calls: 0 }));
  const session = await runtime.openSession({
    origin: ORIGIN,
    sessionId: "session-execution-classifier",
    execution: { hostStore: live.store },
  });
  const signOnlyMethods = [
    "tbc_signMessage",
    "tbc_signTypedData",
    "tbc_signTransaction",
    "tbc_signPreparedTransaction",
    "tbc_signWorkflow",
    "tbc_signPreparedWorkflow",
    "tbc_signReviewedTransaction",
    "tbc_encrypt",
    "tbc_decrypt",
  ];
  for (const method of signOnlyMethods) {
    const historicalBefore = historical.events.length;
    const liveBefore = live.events.length;
    await session.handleRequest({ id: `route-${method}`, method, params: {} });
    assert.equal(historical.events.length, historicalBefore, `${method} touched historical Host`);
    assert.ok(live.events.length > liveBefore, `${method} did not use session Host`);
  }
  for (const method of ["tbc_sendTransaction", "tbc_sendPreparedTransaction", "tbc_chainId"]) {
    const historicalBefore = historical.events.length;
    const liveBefore = live.events.length;
    await session.handleRequest({
      id: `route-${method}`,
      method,
      ...(method === "tbc_chainId" ? {} : { params: {} }),
    });
    assert.equal(historical.events.length, historicalBefore, `${method} touched historical Host`);
    assert.ok(live.events.length > liveBefore, `${method} did not use session Host`);
  }
  session.close();
});

test("wallet-owned Legacy message mapping retains session-only execution and approval binding", async () => {
  const durable = trackedStore();
  const live = trackedStore();
  const observed = [];
  const runtime = createTbcWallet({
    ...walletOptions(durable.store, observed, { calls: 0 }),
    legacy: {
      async bitcoinMessageDigest() {
        return LEGACY_DIGEST;
      },
    },
  });
  const session = await runtime.openSession({
    origin: ORIGIN,
    sessionId: "session-execution-legacy",
    signOnly: { hostStore: live.store },
  });
  const delivery = await session.handleLegacyRequest({
    id: "session-execution-legacy",
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
  assert.equal(delivery.response.result.digest, LEGACY_DIGEST);
  assert.equal(durable.events.length, 0);
  assert.ok(live.events.length > 0);
  assert.ok(observed.every((call) => call.execution.type === "session-only"));
  session.close();
});

test("wallet-owned Legacy crypto action executes the independent session-only method", async () => {
  const durable = trackedStore();
  const observed = [];
  const base = walletOptions(durable.store, observed, { calls: 0 });
  const runtime = createTbcWallet({
    ...base,
    legacy: { async bitcoinMessageDigest() { return LEGACY_DIGEST; } },
    storage: {
      ...base.storage,
      async loadPermissions(_params, call) {
        observed.push(call);
        return { revision: "0", permissions: [permission("tbc_accounts"), permission("tbc_crypto")] };
      },
    },
    crypto: {
      async execute(params, call) {
        observed.push(call);
        return {
          taskId: params.task.taskId,
          algorithm: params.task.algorithm,
          ciphertext: Buffer.alloc(85, 4).toString("base64"),
        };
      },
    },
  });
  const session = await runtime.openSession({
    origin: ORIGIN,
    sessionId: "session-execution-legacy-action",
  });
  const delivery = await session.handleLegacyActionRequest({
    id: "legacy-encrypt-action",
    method: "tbc_encrypt",
    params: {
      version: "1.0",
      chainId: CHAIN_ID,
      from: ADDRESS,
      algorithm: "tbc-bie1-secp256k1-aes128-cbc-hmac-sha256-v1",
      message: { encoding: "utf8", data: "private" },
    },
  });
  assert.equal("error" in delivery.response, false, JSON.stringify(delivery.response));
  assert.equal(delivery.response.result.algorithm, "tbc-bie1-secp256k1-aes128-cbc-hmac-sha256-v1");
  assert.equal(durable.events.length, 0);
  assert.ok(observed.length > 0);
  assert.ok(observed.every((call) => call.execution.type === "session-only"));
  session.close();
});

test("wallet-action evidence helper consumes one trusted Host read and fails closed on detached tampering", async () => {
  const durable = trackedStore();
  const live = trackedStore();
  const base = walletOptions(durable.store, [], { calls: 0 });
  let hostEvidence;
  let actionEvidence;
  const runtime = createTbcWallet({
    ...base,
    storage: {
      ...base.storage,
      async loadPermissions() {
        return {
          revision: "0",
          permissions: [permission("tbc_accounts"), permission("tbc_crypto")],
        };
      },
    },
    approval: {
      async request(params, call) {
        const reader = createApprovalHostEvidenceReader({
          store: live.store,
          releaseFingerprint: TWS_RELEASE_FINGERPRINT,
          parseApprovalRequest: (value) => value,
        });
        hostEvidence = await reader.read(call.callId, params.binding.bindingHash);
        actionEvidence = assertWalletActionApprovalEvidence(hostEvidence);
        return {
          status: "approved",
          approvalId: "approval-wallet-action-evidence",
          approvalToken: "token-wallet-action-evidence",
          bindingHash: params.binding.bindingHash,
          approvedAt: "2026-09-17T00:00:10Z",
          expiresAt: params.binding.payload.expiresAt,
        };
      },
    },
    crypto: {
      async execute(params) {
        return {
          taskId: params.task.taskId,
          algorithm: params.task.algorithm,
          ciphertext: Buffer.alloc(85, 7).toString("base64"),
        };
      },
    },
  });
  const session = await runtime.openSession({
    origin: ORIGIN,
    sessionId: "session-wallet-action-evidence",
    signOnly: { hostStore: live.store },
  });
  const request = {
    version: "1.0",
    chainId: CHAIN_ID,
    from: ADDRESS,
    algorithm: "tbc-bie1-secp256k1-aes128-cbc-hmac-sha256-v1",
    message: { encoding: "utf8", data: "private" },
  };
  const delivery = await session.handleRequest({
    id: "wallet-action-evidence",
    method: "tbc_encrypt",
    params: request,
  });
  assert.equal("error" in delivery.response, false, JSON.stringify(delivery.response));
  assert.equal(actionEvidence.method, "tbc_encrypt");
  assert.equal(actionEvidence.kind, "crypto");
  assert.equal(actionEvidence.origin, ORIGIN);
  assert.equal(actionEvidence.chainId, CHAIN_ID);
  assert.equal(actionEvidence.accountId, ACCOUNT_ID);
  assert.deepEqual(actionEvidence.request, request);
  assert.equal(actionEvidence.approvalBinding.payload.operationHash, actionEvidence.planHash);
  assert.deepEqual(actionEvidence.task, {
    purpose: "encrypt",
    taskId: "crypto-single",
    algorithm: request.algorithm,
  });
  assert.equal(Object.hasOwn(actionEvidence.task, "publicKey"), false);
  assert.ok(Object.isFrozen(actionEvidence));

  const tampered = structuredClone(hostEvidence);
  tampered.operation.transition.checkpoint.payload.memory.walletActionPlan.payload.task.message.data = "page-tamper";
  tampered.operation.transition.checkpoint.payload.memory.walletActionPlan.planHash = hashCanonical(
    tampered.operation.transition.checkpoint.payload.memory.walletActionPlan.payload,
  );
  tampered.operation.transition.checkpoint.checkpointHash = hashCanonical(
    tampered.operation.transition.checkpoint.payload,
  );
  assert.throws(
    () => assertWalletActionApprovalEvidence(tampered),
    /Wallet action approval evidence is invalid/u,
  );
  assert.equal(durable.events.length, 0);
  session.close();
});

test("wallet bootstrap rejects a missing Signer and two competing session Host stores", async () => {
  const durable = trackedStore();
  const options = walletOptions(durable.store, []);
  assert.throws(
    () => createTbcWallet({ ...options, signer: undefined }),
    /wallet-owned Signer/u,
  );
  const runtime = createTbcWallet(options);
  await assert.rejects(
    runtime.openSession({
      origin: ORIGIN,
      sessionId: "shared-sign-only-store",
      execution: { hostStore: trackedStore().store },
      signOnly: { hostStore: durable.store },
    }),
    /Configure one session execution Host store/u,
  );
});
