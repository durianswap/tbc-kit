import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hashCanonical } from "@tbc-wallet/core";
import { createTbcEngine, createWasmTbcEngineBackend } from "../dist/esm/engine.js";
import { parseTbcTransaction, turingTransactionId } from "../dist/esm/api.js";
import { prepareTbcTransaction, prepareTbcWorkflow } from "../dist/esm/index.js";
import { createTbcKitMemoryHostStore } from "../dist/esm/sqlite.js";
const walletModule = process.env.TBC_KIT_WALLET_TEST_MODULE
  ? pathToFileURL(process.env.TBC_KIT_WALLET_TEST_MODULE).href
  : new URL("../dist/esm/wallet.js", import.meta.url).href;
const {
  createDefaultTbcChainDataResolver,
  createTbcWallet,
} = await import(walletModule);

const CHAIN_ID = "tbc:testnet";
const ADDRESS = "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH";
const TO = "1cMh228HTCiwS8ZsaakH8A8wze1JR5ZsP";
const PUBLIC_KEY = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const PRIVATE_KEY = "01".padStart(64, "0");
const SCRIPT = "76a914751e76e8199196d454941c45d1b3a323f1433bd688ac";
const TXID = "ddb917e8cad41edda4a38fd8cb8cb51a8511c8bc51ab7f62b97a039af3d9125c";
const RAW = "0a00000001020000000000000000000000000000000000000000000000000000000000000001000000025101ffffffff01b0040000000000001976a914751e76e8199196d454941c45d1b3a323f1433bd688ac01000000";
const ACCOUNT_ID = `${CHAIN_ID}:${ADDRESS}`;
const ORIGIN = "https://wallet.test";
const NOW_EPOCH = Math.floor(Date.now() / 1000) * 1000;
const NOW = new Date(NOW_EPOCH).toISOString().replace(".000Z", "Z");
const EXPIRES = new Date(NOW_EPOCH + 300_000).toISOString().replace(".000Z", "Z");
const CREATED = new Date(NOW_EPOCH - 10_000).toISOString().replace(".000Z", "Z");
const account = Object.freeze({ accountId: ACCOUNT_ID, address: ADDRESS, chainId: CHAIN_ID, publicKey: PUBLIC_KEY });

const backend = await createWasmTbcEngineBackend(await readFile(
  new URL("../artifacts/wasm/tbc_engine_wasm.wasm", import.meta.url),
));

function permission(capability) {
  return {
    id: `preparation-${capability}`,
    parentCapability: capability,
    invoker: ORIGIN,
    date: Date.parse(CREATED),
    caveats: [
      { type: "restrictChains", value: [CHAIN_ID] },
      { type: "restrictAccounts", value: [ACCOUNT_ID] },
      { type: "restrictMethods", value: [capability] },
    ],
  };
}

function snapshot() {
  const payload = Object.freeze({
    version: "1.0",
    snapshotId: `snapshot-${Math.random().toString(16).slice(2)}`,
    chainId: CHAIN_ID,
    block: Object.freeze({ height: "1000", hash: "aa".repeat(32) }),
    capturedAt: NOW,
    expiresAt: EXPIRES,
    account,
    utxos: Object.freeze([Object.freeze({
      txid: TXID,
      vout: 0,
      satoshis: "1200",
      scriptPubKey: SCRIPT,
      confirmations: "100",
      classification: "native",
    })]),
    parents: Object.freeze([Object.freeze({ txid: TXID, rawTransaction: RAW })]),
    contracts: Object.freeze([]),
  });
  return Object.freeze({ payload, snapshotHash: hashCanonical(payload) });
}

function policy() {
  const payload = Object.freeze({
    version: "1.0",
    policyId: "policy-request-preparation",
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

function request(clientRequestId = "prepared-exact-request") {
  return Object.freeze({
    id: "request-preparation",
    method: "tbc_sendTransaction",
    params: Object.freeze({
      version: "1.0",
      chainId: CHAIN_ID,
      from: ADDRESS,
      clientRequestId,
      intent: Object.freeze({ version: "1.0", type: "tbc.transfer", to: TO, amount: "1000" }),
      constraints: Object.freeze({ maxFee: "200" }),
    }),
  });
}

function trackedStore() {
  const events = [];
  const target = createTbcKitMemoryHostStore({ now: () => Date.parse(NOW) });
  return {
    events,
    store: Object.freeze(Object.fromEntries(Object.entries(target).map(([name, value]) => [
      name,
      typeof value !== "function" ? value : (...args) => {
        events.push(name);
        return Reflect.apply(value, target, args);
      },
    ]))),
  };
}

function createRuntime(
  resolveChainData,
  observed,
  store,
  authority,
  accountsCurrent = async () => [account],
  engineCalls = [],
  onPerformance,
  runtimeOptions = {},
) {
  const underlyingEngine = createTbcEngine({ backend });
  const engine = Object.freeze(Object.fromEntries([
    "normalizeRequest",
    "plan",
    "validate",
    "finalize",
  ].map((method) => [method, (params) => {
    engineCalls.push(method);
    return underlyingEngine[method](params);
  }])));
  return createTbcWallet({
    profile: authority === undefined ? undefined : "request-preparation-profile",
    accounts: { current: accountsCurrent },
    ...(runtimeOptions.approvalPreparation === undefined
      ? {}
      : { approvalPreparation: runtimeOptions.approvalPreparation }),
    approval: {
      async request(params, call) {
        observed.push(call.operation);
        if (runtimeOptions.rejectApproval === true) {
          return {
            status: "rejected",
            bindingHash: params.binding.bindingHash,
            rejectedAt: NOW,
          };
        }
        return {
          status: "approved",
          approvalId: "request-preparation-approval",
          approvalToken: "request-preparation-token",
          bindingHash: params.binding.bindingHash,
          approvedAt: NOW,
          expiresAt: params.binding.payload.expiresAt,
        };
      },
    },
    signer: {
      async sign(params, call) {
        observed.push(call.operation);
        return {
          taskId: params.task.taskId,
          signatureEncoding: "compact64",
          signature: secp256k1.sign(params.task.digest, PRIVATE_KEY, { prehash: false, lowS: true }).toCompactHex(),
        };
      },
    },
    storage: {
      hostStore: store,
      async loadPermissions() {
        observed.push("permissionStore.load");
        return {
          revision: "0",
          permissions: runtimeOptions.permissions ?? [
            permission("tbc_accounts"),
            permission("tbc_sendTransaction"),
          ],
        };
      },
      async commitPermissions() { throw new Error("unexpected permission commit"); },
    },
    network: {
      resolveChainData,
      async resolvePolicy() { observed.push("policy.resolve"); return runtimeOptions.policy ?? policy(); },
      async broadcastSubmit(params) {
        observed.push("broadcast.submit");
        return { txid: params.transaction.txid, status: "accepted" };
      },
      async broadcastReconcile(params) {
        return { transactions: params.txids.map((txid) => ({ txid, status: "mempool" })) };
      },
    },
    engine,
    clock: () => NOW,
    randomBytes: (length) => Uint8Array.from({ length }, (_, index) => index),
    onPerformance,
  });
}

test("wallet request preparation performs only read-only Chain Data and exact execution consumes it once", async () => {
  const host = trackedStore();
  const observed = [];
  const engineCalls = [];
  const chainCalls = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const runtime = createRuntime(async (params, call) => {
    chainCalls.push({ params, call });
    await gate;
    return snapshot();
  }, observed, host.store, undefined, undefined, engineCalls);
  const session = await runtime.openSession({ origin: ORIGIN, sessionId: "request-preparation-exact" });
  const exact = request();
  const preparation = session.prefetchRequest(exact);
  while (chainCalls.length === 0) await Promise.resolve();
  assert.equal(chainCalls[0].call, undefined, "prefetch must not impersonate a Host Port call");
  assert.deepEqual(observed, []);
  assert.deepEqual(engineCalls, ["normalizeRequest"]);
  assert.deepEqual(host.events, [], "prefetch must not write or read the Host journal");
  release();
  assert.equal(await preparation.ready, "ready");
  assert.deepEqual(await preparation.diagnostic, {
    status: "ready",
    stage: "chain-data",
    category: "ready",
  });

  const delivery = await session.handleRequest(exact);
  assert.equal("error" in delivery.response, false, JSON.stringify(delivery.response));
  assert.equal(chainCalls.length, 1, "exact execution must consume the prepared snapshot");
  assert.deepEqual(observed, [
    "permissionStore.load",
    "policy.resolve",
    "approval.request",
    "signer.sign",
    "broadcast.submit",
  ]);
  assert.ok(engineCalls.includes("finalize"));
  session.close();
});

test("exact completed and in-flight request identities reuse one execution before preparation", async () => {
  const host = trackedStore();
  const observed = [];
  const chainCalls = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const runtime = createRuntime(async (params, call) => {
    chainCalls.push({ params, call });
    await gate;
    return snapshot();
  }, observed, host.store);
  const session = await runtime.openSession({ origin: ORIGIN, sessionId: "request-identity-reuse" });
  const exact = request("request-identity-reuse");
  const first = session.handleRequest(exact);
  while (chainCalls.length === 0) await Promise.resolve();
  const concurrent = session.handleRequest(exact);
  release();
  const [firstDelivery, concurrentDelivery] = await Promise.all([first, concurrent]);
  assert.deepEqual(concurrentDelivery, firstDelivery);
  const completedDelivery = await session.handleRequest(exact);
  assert.deepEqual(completedDelivery, firstDelivery);
  assert.equal(chainCalls.length, 1, "replay must not restart Chain Data preparation");
  await assert.rejects(
    session.handleRequest(request("same-id-different-input")),
    /request id cannot be reused with different input/u,
  );
  assert.equal(chainCalls.length, 1);
  session.close();
});

test("automatic preparation starts only after Core authorizes remote reads", async () => {
  const host = trackedStore();
  const observed = [];
  const lifecycle = [];
  let chainReads = 0;
  const runtime = createRuntime(
    async () => {
      chainReads += 1;
      return snapshot();
    },
    observed,
    host.store,
    undefined,
    undefined,
    [],
    undefined,
    {
      permissions: [],
      approvalPreparation: {
        begin(input) { lifecycle.push({ type: "begin", input }); },
        async review(input) {
          lifecycle.push({ type: "review", input });
          return { status: "approved" };
        },
        finish(input) { lifecycle.push({ type: "finish", input }); },
      },
    },
  );
  const session = await runtime.openSession({
    origin: ORIGIN,
    sessionId: "unauthorized-auto-preparation",
  });
  const delivery = await session.handleRequest(request("unauthorized-auto-preparation"));
  assert.deepEqual(delivery.response.error?.code, 4100);
  assert.equal(chainReads, 0, "unauthorized preparation must not perform remote Chain Data reads");
  assert.deepEqual(observed, ["permissionStore.load"]);
  assert.equal(lifecycle.filter(({ type }) => type === "begin").length, 1);
  assert.equal(lifecycle.filter(({ type }) => type === "finish").length, 1);
  session.close();
});

test("reports sanitized per-Port snapshot, callback, and result diagnostics", async () => {
  const host = trackedStore();
  const observed = [];
  const diagnostics = [];
  const runtime = createRuntime(
    async () => snapshot(),
    observed,
    host.store,
    undefined,
    undefined,
    [],
    (event) => {
      diagnostics.push(event);
      if (event.stage === "port-wallet-callback") throw new Error("observer");
    },
  );
  const session = await runtime.openSession({
    origin: ORIGIN,
    sessionId: "request-preparation-port-diagnostics",
  });
  const delivery = await session.handleRequest(request());
  assert.equal("error" in delivery.response, false, JSON.stringify(delivery.response));
  assert.ok(diagnostics.length > 0);
  assert.deepEqual(
    new Set(diagnostics.map(({ stage }) => stage)),
    new Set([
      "port-call-snapshot",
      "port-wallet-callback",
      "port-result-snapshot",
    ]),
  );
  assert.ok(diagnostics.every((event) =>
    event.component === "host-port" &&
    event.count === 1 &&
    Number.isFinite(event.durationMs) &&
    event.durationMs >= 0 &&
    Number.isSafeInteger(event.bytes) &&
    event.bytes >= 0 &&
    !Object.hasOwn(event, "params") &&
    !Object.hasOwn(event, "result") &&
    !Object.hasOwn(event, "signature")
  ));
  assert.ok(diagnostics.some((event) =>
    event.stage === "port-call-snapshot" && event.bytes > 0
  ));
  assert.ok(diagnostics.some((event) =>
    event.stage === "port-result-snapshot" && event.bytes > 0
  ));
  session.close();
});

test("skips per-Port diagnostic byte encoding when no observer is configured", async (t) => {
  const originalEncode = TextEncoder.prototype.encode;
  t.after(() => {
    TextEncoder.prototype.encode = originalEncode;
  });

  const countEncodes = async (onPerformance) => {
    let encodeCalls = 0;
    TextEncoder.prototype.encode = function (...args) {
      encodeCalls += 1;
      return Reflect.apply(originalEncode, this, args);
    };
    const host = trackedStore();
    const runtime = createRuntime(
      async () => {
        throw new Error("unexpected Chain Data read");
      },
      [],
      host.store,
      undefined,
      undefined,
      [],
      onPerformance,
    );
    const session = await runtime.openSession({
      origin: ORIGIN,
      sessionId: onPerformance === undefined
        ? "port-diagnostics-disabled"
        : "port-diagnostics-enabled",
    });
    const delivery = await session.handleRequest({
      id: "port-diagnostic-encoding",
      method: "tbc_getCapabilities",
      params: {},
    });
    assert.equal("error" in delivery.response, false, JSON.stringify(delivery.response));
    session.close();
    return encodeCalls;
  };

  const withoutObserver = await countEncodes(undefined);
  const withObserver = await countEncodes(() => {});

  assert.ok(
    withoutObserver < withObserver,
    `expected disabled diagnostics to encode less often (${withoutObserver} vs ${withObserver})`,
  );
});

test("request preparation exposes only a sanitized Chain Data miss category", async () => {
  const host = trackedStore();
  const observed = [];
  const runtime = createRuntime(async () => ({
    portError: {
      name: "CONFLICT",
      retryable: false,
      message: "private upstream detail must not escape",
    },
  }), observed, host.store);
  const session = await runtime.openSession({
    origin: ORIGIN,
    sessionId: "request-preparation-diagnostic",
  });
  const preparation = session.prefetchRequest(request());
  assert.equal(await preparation.ready, "miss");
  assert.deepEqual(await preparation.diagnostic, {
    status: "miss",
    stage: "chain-data",
    category: "chain-data-conflict",
  });
  assert.equal(JSON.stringify(await preparation.diagnostic).includes("private"), false);
  session.close();
});

test("request hash mismatch cannot consume preparation even when Chain Data params are identical", async () => {
  const host = trackedStore();
  const observed = [];
  const chainCalls = [];
  const runtime = createRuntime(async (params, call) => {
    chainCalls.push({ params, call });
    return snapshot();
  }, observed, host.store);
  const session = await runtime.openSession({ origin: ORIGIN, sessionId: "request-preparation-mismatch" });
  const preparation = session.prefetchRequest(request("request-a"));
  assert.equal(await preparation.ready, "ready");
  const delivery = await session.handleRequest(request("request-b"));
  assert.equal("error" in delivery.response, false, JSON.stringify(delivery.response));
  assert.equal(chainCalls.length, 2, "mismatch must fall back to normal Chain Data resolution");
  assert.equal(chainCalls[0].call, undefined);
  assert.equal(chainCalls[1].call.operation, "chainData.resolve");
  assert.equal(chainCalls[1].call.execution.type, "session-only");
  session.close();
});

test("navigation invalidation discards prepared bytes before Host execution", async () => {
  const host = trackedStore();
  const observed = [];
  const chainCalls = [];
  let current = {
    currentContext: {
      sessionId: "request-preparation-authority",
      transport: "webview",
      origin: ORIGIN,
      topOrigin: ORIGIN,
      frame: "top",
      navigationId: "navigation-one",
      createdAt: CREATED,
    },
    currentSession: {
      version: "1.0",
      scope: { walletProfile: "request-preparation-profile", sessionId: "request-preparation-authority" },
      state: {
        version: "1.0",
        sessionId: "request-preparation-authority",
        revision: "0",
        connected: true,
        activeChainId: CHAIN_ID,
        activeAccountIds: [ACCOUNT_ID],
      },
    },
  };
  const authority = {
    async read() { return structuredClone(current); },
    async compareAndSwapSession() { throw new Error("unexpected authority commit"); },
  };
  const runtime = createRuntime(async (params, call) => {
    chainCalls.push({ params, call });
    return snapshot();
  }, observed, host.store, authority);
  const session = await runtime.openSession({ authority });
  const preparation = session.prefetchRequest(request());
  assert.equal(await preparation.ready, "ready");
  current = {
    ...current,
    currentContext: { ...current.currentContext, navigationId: "navigation-two" },
  };
  await assert.rejects(session.handleRequest(request()));
  assert.equal(chainCalls.length, 1, "stale preparation must not reach a normal or prepared execution");
  assert.deepEqual(observed, []);
  session.close();
});

test("wallet rejection cancellation makes an exact later execution miss and resolve normally", async () => {
  const host = trackedStore();
  const observed = [];
  const chainCalls = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const runtime = createRuntime(async (params, call) => {
    chainCalls.push({ params, call });
    if (call === undefined) await gate;
    return snapshot();
  }, observed, host.store);
  const session = await runtime.openSession({ origin: ORIGIN, sessionId: "request-preparation-cancel" });
  const preparation = session.prefetchRequest(request());
  while (chainCalls.length === 0) await Promise.resolve();
  preparation.cancel();
  assert.equal(await preparation.ready, "discarded");
  assert.deepEqual(await preparation.diagnostic, {
    status: "discarded",
    stage: "lifecycle",
    category: "cancelled",
  });
  release();
  const delivery = await session.handleRequest(request());
  assert.equal("error" in delivery.response, false, JSON.stringify(delivery.response));
  assert.equal(chainCalls.length, 2);
  assert.equal(chainCalls[1].call.operation, "chainData.resolve");
  session.close();
});

test("real Engine prepared workflows reject overlapping selection and honor disjoint explicit inputs", async () => {
  const secondRaw = `${RAW.slice(0, -8)}02000000`;
  const secondTxid = turingTransactionId(secondRaw);
  const base = snapshot();
  const payload = Object.freeze({
    ...base.payload,
    snapshotId: "snapshot-real-workflow-inputs",
    utxos: Object.freeze([
      base.payload.utxos[0],
      Object.freeze({ ...base.payload.utxos[0], txid: secondTxid }),
    ]),
    parents: Object.freeze([
      base.payload.parents[0],
      Object.freeze({ txid: secondTxid, rawTransaction: secondRaw }),
    ]),
  });
  const chainSnapshot = Object.freeze({ payload, snapshotHash: hashCanonical(payload) });
  const network = Object.freeze({
    async resolveChainData() { return chainSnapshot; },
    async resolvePolicy() { return policy(); },
  });
  const engine = createTbcEngine({ backend });
  const step = (id, inputOutpoints) => Object.freeze({
    id,
    kind: "transaction",
    dependsOn: Object.freeze([]),
    intent: Object.freeze({ version: "1.0", type: "tbc.transfer", to: TO, amount: "1000" }),
    constraints: Object.freeze({ maxFee: "200", ...(inputOutpoints === undefined ? {} : { inputOutpoints }) }),
  });
  const workflow = (steps) => Object.freeze({
    version: "1.0",
    chainId: CHAIN_ID,
    from: ADDRESS,
    maxTotalFee: "400",
    steps: Object.freeze(steps),
  });

  await assert.rejects(
    prepareTbcWorkflow({ request: workflow([step("one"), step("two")]), network, engine }),
    /same input outpoint/,
  );

  const firstOutpoint = Object.freeze([{ txid: TXID, vout: 0 }]);
  const secondOutpoint = Object.freeze([{ txid: secondTxid, vout: 0 }]);
  const prepared = await prepareTbcWorkflow({
    request: workflow([step("one", firstOutpoint), step("two", secondOutpoint)]),
    network,
    engine,
  });
  const selected = prepared.steps.map(({ proposal }) => {
    const transaction = proposal.payload.transactions[0];
    assert.equal(transaction.kind, "fixed");
    return parseTbcTransaction(transaction.unsignedTransaction).inputs[0].txid;
  });
  assert.deepEqual(selected, [TXID, secondTxid]);

  const observed = [];
  const ordinaryHost = trackedStore();
  const runtime = createRuntime(
    async () => chainSnapshot,
    observed,
    ordinaryHost.store,
    undefined,
    undefined,
    [],
    undefined,
    { permissions: [
      permission("tbc_accounts"),
      permission("tbc_signTransaction"),
      permission("tbc_signWorkflow"),
    ] },
  );
  const session = await runtime.openSession({ origin: ORIGIN, sessionId: "real-workflow-explicit-inputs" });
  const delivery = await session.handleRequest({
    id: "ordinary-disjoint",
    method: "tbc_signWorkflow",
    params: workflow([step("one", firstOutpoint), step("two", secondOutpoint)]),
  });
  assert.equal(
    "error" in delivery.response,
    false,
    JSON.stringify({ response: delivery.response, observed, hostEvents: ordinaryHost.events }),
  );
  assert.deepEqual(
    delivery.response.result.steps.map(({ result }) =>
      parseTbcTransaction(result.transactions[0].rawTransaction).inputs[0].txid
    ),
    [TXID, secondTxid],
  );
  session.close();

  const overlapObserved = [];
  const overlapRuntime = createRuntime(
    async () => chainSnapshot,
    overlapObserved,
    trackedStore().store,
    undefined,
    undefined,
    [],
    undefined,
    { permissions: [
      permission("tbc_accounts"),
      permission("tbc_signTransaction"),
      permission("tbc_signWorkflow"),
    ] },
  );
  const overlapSession = await overlapRuntime.openSession({ origin: ORIGIN, sessionId: "real-workflow-overlap" });
  await assert.rejects(
    overlapSession.handleRequest({
      id: "ordinary-overlap",
      method: "tbc_signWorkflow",
      params: workflow([step("one"), step("two")]),
    }),
    /Host operation did not produce a response: failed/,
  );
  assert.equal(overlapObserved.includes("signer.sign"), false);
  overlapSession.close();
});

test("real WASM and default Chain Data preserve the exact Candidate170 split inputs for Prepared and ordinary workflows", async () => {
  const splitTxid = "71b925f72ad397b87458717ef8c63e68a2c78902f02196172395535e73cd55e0";
  const indexed = Object.freeze([
    Object.freeze({ txid: splitTxid, vout: 0, satoshis: "1000000", height: "0" }),
    Object.freeze({ txid: splitTxid, vout: 1, satoshis: "5473944887", height: "0" }),
  ]);
  let utxoReads = 0;
  let parentReads = 0;
  const resolver = createDefaultTbcChainDataResolver({
    accounts: { current: async () => [account] },
    client: {
      async getUtxos(address) {
        utxoReads += 1;
        assert.equal(address, ADDRESS);
        return {
          tip: Object.freeze({ height: "834171", hash: "aa".repeat(32) }),
          utxos: indexed,
        };
      },
      async getRawTransaction() {
        parentReads += 1;
        throw new Error("native transfer must not read parent raw transactions");
      },
    },
    now: () => NOW_EPOCH,
    snapshotId: () => "snapshot-candidate170-split-exact-inputs",
    confirmationPolicy: { minConfirmations: "0" },
  });
  const policyPayload = Object.freeze({ ...policy().payload, minConfirmations: "0" });
  const zeroConfirmationPolicy = Object.freeze({
    payload: policyPayload,
    policyHash: hashCanonical(policyPayload),
  });
  const network = Object.freeze({
    resolveChainData: (params) => resolver.resolve(params, account),
    async resolvePolicy() { return zeroConfirmationPolicy; },
  });
  const engine = createTbcEngine({ backend });
  const exactRequest = (vout) => Object.freeze({
    version: "1.0",
    chainId: CHAIN_ID,
    from: ADDRESS,
    intent: Object.freeze({ version: "1.0", type: "tbc.transfer", to: ADDRESS, amount: "100000" }),
    constraints: Object.freeze({
      expiresAt: EXPIRES,
      maxFee: "2500",
      inputOutpoints: Object.freeze([Object.freeze({ txid: splitTxid, vout })]),
    }),
  });

  const preparedSingle = await prepareTbcTransaction({
    request: exactRequest(1),
    network,
    engine,
  });
  const singleInput = parseTbcTransaction(
    preparedSingle.proposal.payload.transactions[0].unsignedTransaction,
  ).inputs[0];
  assert.deepEqual({ txid: singleInput.txid, vout: singleInput.vout }, { txid: splitTxid, vout: 1 });

  const workflowRequest = Object.freeze({
    version: "1.0",
    chainId: CHAIN_ID,
    from: ADDRESS,
    maxTotalFee: "5000",
    steps: Object.freeze([0, 1].map((vout) => Object.freeze({
      id: vout === 0 ? "split-small" : "split-change",
      kind: "transaction",
      dependsOn: Object.freeze([]),
      intent: exactRequest(vout).intent,
      constraints: exactRequest(vout).constraints,
    }))),
  });
  const preparedWorkflow = await prepareTbcWorkflow({ request: workflowRequest, network, engine });
  assert.deepEqual(preparedWorkflow.steps.map(({ proposal }) => {
    const input = parseTbcTransaction(proposal.payload.transactions[0].unsignedTransaction).inputs[0];
    return { txid: input.txid, vout: input.vout };
  }), [{ txid: splitTxid, vout: 0 }, { txid: splitTxid, vout: 1 }]);

  const observed = [];
  const requirements = [];
  const runtime = createRuntime(
    async (params) => {
      requirements.push(params.requirement);
      return resolver.resolve(params, account);
    },
    observed,
    trackedStore().store,
    undefined,
    undefined,
    [],
    undefined,
    {
      rejectApproval: true,
      policy: zeroConfirmationPolicy,
      permissions: [
        permission("tbc_accounts"),
        permission("tbc_signTransaction"),
        permission("tbc_signWorkflow"),
      ],
    },
  );
  const session = await runtime.openSession({ origin: ORIGIN, sessionId: "candidate170-split-exact-union" });
  const delivery = await session.handleRequest({
    id: "candidate170-split-ordinary",
    method: "tbc_signWorkflow",
    params: workflowRequest,
  });
  assert.deepEqual(delivery.response.error, { code: 4001, message: "User rejected the request" });
  assert.deepEqual(requirements[0].inputOutpoints, [
    { txid: splitTxid, vout: 0 },
    { txid: splitTxid, vout: 1 },
  ]);
  assert.deepEqual(observed, ["permissionStore.load", "policy.resolve", "policy.resolve", "approval.request"]);
  assert.equal(observed.includes("signer.sign"), false);
  assert.equal(observed.some((operation) => operation.startsWith("broadcast.")), false);
  session.close();

  const missing = await resolver.resolve({
    version: "1.0",
    chainId: CHAIN_ID,
    accountId: ACCOUNT_ID,
    requirement: {
      intentType: "tbc.transfer",
      nativeAmount: "100000",
      inputOutpoints: [{ txid: splitTxid, vout: 2 }],
      assets: [{ kind: "native", minimumAmount: "100000" }],
      includeAncestry: false,
    },
  }, account);
  assert.equal(missing.portError?.name, "CONFLICT");
  assert.equal(parentReads, 0, "exact native input resolution must not add parent raw reads");
  assert.equal(utxoReads, 5);
});
