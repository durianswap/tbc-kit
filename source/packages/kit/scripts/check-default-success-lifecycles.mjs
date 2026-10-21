import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { build } from "esbuild";
import { createTbcClient, prepareTbcTransaction, prepareTbcWorkflow } from "../dist/esm/index.js";
import {
  createApprovalHostEvidenceReader,
  createDefaultTbcTestnetNetwork,
  createTbcWallet,
  createWasmTbcKeylessEngine,
  projectTbcApprovalPresentation,
  TWS_RELEASE_FINGERPRINT,
} from "../dist/esm/wallet.js";
import { createTbcEngine, createWasmTbcEngineBackend } from "../dist/esm/engine.js";
import { createTbcKitMemoryHostStore } from "../dist/esm/sqlite.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const helperBuild = await build({
  entryPoints: [resolve(ROOT, "test/controlled-key1-testnet.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  write: false,
});
const helper = await import(`data:text/javascript;base64,${Buffer.from(helperBuild.outputFiles[0].contents).toString("base64")}`);
const { CONTROLLED_KEY1_POOL, createControlledKey1TestnetFetch } = helper;
const CHAIN_ID = "tbc:testnet";
const ADDRESS = "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH";
// Public scalar-one test key. It owns synthetic fixture outputs only.
const PRIVATE_KEY = "01".padStart(64, "0");
const FT = CONTROLLED_KEY1_POOL.ftContractId;
const POOL = CONTROLLED_KEY1_POOL.poolContractId;
const REMOVE_POOL = CONTROLLED_KEY1_POOL.poolContractId;
const ACCOUNT = Object.freeze({ accountId: `${CHAIN_ID}:${ADDRESS}`, address: ADDRESS, chainId: CHAIN_ID, publicKey: Buffer.from(secp256k1.getPublicKey(PRIVATE_KEY, true)).toString("hex") });
const poolNative = await createWasmTbcKeylessEngine(await readFile(`${ROOT}/artifacts/wasm/tbc_keyless_wasm.wasm`));
const engine = createTbcEngine({ backend: await createWasmTbcEngineBackend(await readFile(`${ROOT}/artifacts/wasm/tbc_engine_wasm.wasm`)) });
const origin = "https://controlled-default-kit.test";
const permission = (capability) => ({ id: `probe-${capability}`, parentCapability: capability, invoker: origin, date: Date.parse("2026-09-17T00:00:00Z"), caveats: [{ type: "restrictChains", value: [CHAIN_ID] }, { type: "restrictAccounts", value: [ACCOUNT.accountId] }, { type: "restrictMethods", value: [capability] }] });
const cases = [
  ["tbc.transfer", { type: "tbc.transfer", version: "1.0", to: ADDRESS, amount: "1000" }, {}],
  ["tbc.ft.create", { type: "tbc.ft.create", version: "1.0", name: "Probe", symbol: "PRB", decimals: 6, initialSupply: "1000000" }, {}],
  ["tbc20-standard-create", { type: "tbc20-standard-create", version: "1.0", name: "Probe", symbol: "PRB", decimals: 6, initialSupply: "1000000" }, {}],
  ["tbc.ft.transfer", { type: "tbc.ft.transfer", version: "1.0", contractId: FT, to: ADDRESS, amount: "250000" }, {}],
  ["tbc.pool.create.mint", { type: "tbc.pool.create", version: "1.0", stage: "mint", ftContractId: FT, lpPlan: 2, serviceProviderTag: "controlled-pool" }, {}],
  ["tbc.pool.create.initialize", { type: "tbc.pool.create", version: "1.0", stage: "initialize", poolContractId: POOL, initialLiquidity: { receiver: ADDRESS, tbcAmount: "1000", ftAmount: "250000" } }, { poolState: "uninitialized" }],
  ["tbc.pool.swap.exactTbcForToken", { type: "tbc.pool.swap.exactTbcForToken", version: "1.0", poolContractId: REMOVE_POOL, receiver: ADDRESS, tbcAmount: "1000", minimumFtAmount: "1" }, { poolOperation: "swap-to-token" }],
  ["tbc.pool.swap.exactTokenForTbc", { type: "tbc.pool.swap.exactTokenForTbc", version: "1.0", poolContractId: REMOVE_POOL, receiver: ADDRESS, ftAmount: "250000", minimumTbcAmount: "1" }, { poolOperation: "swap-to-tbc" }],
  ["tbc.pool.liquidity.add", { type: "tbc.pool.liquidity.add", version: "1.0", poolContractId: POOL, receiver: ADDRESS, tbcAmount: "1000", minimumLpAmount: "1" }, { poolOperation: "increase" }],
  ["tbc.pool.liquidity.remove", { type: "tbc.pool.liquidity.remove", version: "1.0", poolContractId: REMOVE_POOL, receiver: ADDRESS, lpAmount: "100", minimumTbcAmount: "1", minimumFtAmount: "1" }, { poolOperation: "remove" }]
];
async function runCase(label, intent, fetchOptions, mode, exerciseReconcile = false) {
  const urls = [];
  const lifecycle = [];
  const baseFetch = createControlledKey1TestnetFetch({ nativeUtxoSatoshis: 5e6, ...fetchOptions });
  const fetch = (async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const edge = `${(init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase()} ${url.pathname}`;
    urls.push(edge);
    lifecycle.push(`http:${edge}`);
    return baseFetch(input, init);
  });
  let signerCalls = 0;
  let approvals = 0;
  const submitted = [];
  const hostCalls = [];
  const expectedExecutionType = "session-only";
  const observeHostCall = (params, call, operation) => {
    assert.equal(call.operation, operation);
    assert.deepEqual(call.params, params);
    assert.equal(Object.isFrozen(call), true);
    assert.equal(Object.isFrozen(call.params), true);
    assert.equal(call.execution.type, expectedExecutionType);
    assert.equal(Object.isFrozen(call.execution), true);
    hostCalls.push(call);
  };
  const durableHostStore = createTbcKitMemoryHostStore();
  const signOnlyHostStore = createTbcKitMemoryHostStore();
  const evidenceReader = createApprovalHostEvidenceReader({
    store: signOnlyHostStore,
    releaseFingerprint: TWS_RELEASE_FINGERPRINT,
    parseApprovalRequest: (value) => value,
  });
  let presentation;
  const capability = mode === "send" ? "tbc_sendTransaction" : "tbc_signTransaction";
  const runtime = createTbcWallet({
    accounts: { current: async () => [ACCOUNT] },
    approval: { request: async (params, call) => {
      observeHostCall(params, call, "approval.request");
      const evidence = await evidenceReader.read(call.callId, params.binding.bindingHash);
      presentation = projectTbcApprovalPresentation(evidence);
      assert.equal(presentation.binding.status, "verified");
      assert.deepEqual(presentation.businessTerms.value, intent);
      approvals += 1;
      lifecycle.push("approval");
      return { status: "approved", approvalId: `approval-${label}-${mode}`, approvalToken: `token-${label}-${mode}`, bindingHash: params.binding.bindingHash, approvedAt: "2026-09-17T00:00:10Z", expiresAt: params.binding.payload.expiresAt };
    } },
    signer: { sign: async (params, call) => {
      observeHostCall(params, call, "signer.sign");
      signerCalls += 1;
      lifecycle.push(`signer:${params.task.taskId}`);
      return { taskId: params.task.taskId, signatureEncoding: "compact64", signature: secp256k1.sign(params.task.digest, PRIVATE_KEY, { prehash: false, lowS: true }).toCompactHex() };
    } },
    storage: { hostStore: durableHostStore, loadPermissions: async () => ({ revision: "0", permissions: [permission("tbc_accounts"), permission(capability)] }), commitPermissions: async (params) => ({ revisions: params.changes.map((change) => ({ scope: change.scope, revision: "1" })) }) },
    network: { defaultTestnet: {
      fetch,
      poolNative,
      now: () => Date.parse("2026-09-17T00:00:00Z"),
      snapshotId: async () => `snapshot-${label}-${mode}`,
      broadcast: {
        async submit(params, client, call) {
          observeHostCall(params, call, "broadcast.submit");
          lifecycle.push(`submit:${params.transaction.txid}`);
          const result = await client.broadcast(params.transaction.rawTransaction);
          submitted.push(result.txid);
          if (exerciseReconcile && submitted.length === 1) return {
            portError: {
              name: "UNAVAILABLE",
              message: "controlled response loss after accepted submission",
              retryable: true,
            },
          };
          return { txid: result.txid, status: "accepted" };
        },
        async reconcile(params, client, call) {
          observeHostCall(params, call, "broadcast.reconcile");
          lifecycle.push("reconcile");
          return { transactions: await Promise.all(params.txids.map((txid) => client.getTransactionStatus(txid))) };
        },
      },
    } },
    engine,
    clock: () => "2026-09-17T00:00:10Z",
    randomBytes: (length) => Uint8Array.from({ length }, (_, i) => i)
  });
  const session = await runtime.openSession({
    origin,
    sessionId: `controlled-${label}-${mode}`,
    execution: { hostStore: signOnlyHostStore },
  });
  try {
    if (intent.type === "tbc.ft.create" || intent.type === "tbc.pool.create") {
      await assert.rejects(session.provider.request({ method: capability, params: {
        version:"1.0", chainId:CHAIN_ID, from:ADDRESS, intent,
        constraints:{expiresAt:"2026-09-17T00:02:00Z",maxFee:"10000",feePreference:"standard"},
      } }), error => error.code === 4200 && /Historical asset issuance is disabled/.test(error.message));
      assert.equal(approvals,0); assert.equal(signerCalls,0); assert.deepEqual(submitted,[]);
      assert.deepEqual(urls,[],"disabled issuance must fail before chain reads");
      return {label,denied:true,approvalCalls:approvals,signerCalls,submitCalls:submitted.length};
    }
    const result = await session.provider.request({ method: capability, params: { version: "1.0", chainId: CHAIN_ID, from: ADDRESS, clientRequestId: `controlled-${label}-${mode}`, intent, constraints: { expiresAt: "2026-09-17T00:02:00Z", maxFee: "10000", feePreference: "standard" } } });
    const txids = result.transactions.map(({ txid }) => txid);
    assert.equal(approvals, 1);
    assert.ok(signerCalls > 0);
    if (mode === "sign") {
      assert.deepEqual(submitted, []);
      assert.equal(urls.some((edge) => edge === "POST /api/tbc/broadcasttx"), false);
      assert.ok(result.transactions.every(({ status }) => status === undefined));
    } else {
      assert.deepEqual(submitted, txids);
      assert.deepEqual(urls.filter((edge) => edge === "POST /api/tbc/broadcasttx").length, txids.length);
      assert.ok(result.transactions.every(({ status }) => status === "submitted"));
      const lastSigner = lifecycle.reduce((found, event, index) => event.startsWith("signer:") ? index : found, -1);
      const firstSubmit = lifecycle.findIndex((event) => event.startsWith("submit:"));
      assert.ok(firstSubmit > lastSigner);
    }
    const callIds = hostCalls.map(({ callId }) => callId);
    assert.equal(new Set(callIds).size, callIds.length, "every platform callback must retain its distinct Host callId");
    if (exerciseReconcile) {
      assert.equal(hostCalls.filter(({ operation }) => operation === "approval.request").length, 1);
      assert.ok(hostCalls.some(({ operation }) => operation === "signer.sign"));
      assert.equal(hostCalls.filter(({ operation }) => operation === "broadcast.submit").length, txids.length);
      assert.equal(hostCalls.filter(({ operation }) => operation === "broadcast.reconcile").length, 1);
    }
    return {
      label,
      mode,
      transactions: txids.length,
      txids,
      signerCalls,
      approvalCalls: approvals,
      submitCalls: submitted.length,
      httpEdges: urls,
      presentation: {
        businessType: presentation.businessType.value,
        binding: presentation.binding.status,
        actualFeeAtomic: presentation.fees.actualAtomic.value,
        transactions: presentation.counts.transactions.value,
        signingTasks: presentation.counts.signingTasks.value,
        assets: presentation.assets.length,
      },
      hostIdentity: {
        callIds,
        operations: hostCalls.map(({ operation }) => operation),
        frozen: hostCalls.every((call) => Object.isFrozen(call) && Object.isFrozen(call.params)),
        executionTypes: hostCalls.map((call) => call.execution.type),
      },
      resultSha256: createHash("sha256").update(JSON.stringify(result)).digest("hex"),
    };
  } finally {
    session.close();
  }
}

const signOnly = [];
const disabled = [];
for (const [label, intent, fetchOptions] of cases) {
  const result = await runCase(label, intent, fetchOptions, "sign");
  (result.denied ? disabled : signOnly).push(result);
}
const representativeSend = await runCase(cases[2][0], cases[2][1], cases[2][2], "send", true);

async function runPrepared(mode, intent, label) {
  const httpEdges = [];
  const submitted = [];
  const baseFetch = createControlledKey1TestnetFetch({ nativeUtxoSatoshis: 5e6 });
  const fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    httpEdges.push(`${(init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase()} ${url.pathname}`);
    return baseFetch(input, init);
  };
  const networkAt = (observedAt, role) => createDefaultTbcTestnetNetwork({
    accounts: { current: async () => [ACCOUNT] },
    fetch,
    poolNative,
    now: () => Date.parse(observedAt),
    snapshotId: async () => `snapshot-prepared-${mode}-${role}`,
    broadcast: {
      async submit(params, client) {
        const result = await client.broadcast(params.transaction.rawTransaction);
        submitted.push(result.txid);
        return { txid: result.txid, status: "accepted" };
      },
      async reconcile(params, client) {
        return { transactions: await Promise.all(params.txids.map((txid) => client.getTransactionStatus(txid))) };
      },
    },
  });
  const dappObservedAt = "2026-09-17T00:00:00Z";
  const walletObservedAt = "2026-09-17T00:00:30Z";
  const dappNetwork = networkAt(dappObservedAt, "dapp");
  const walletNetwork = networkAt(walletObservedAt, "wallet");
  const request = Object.freeze({
    version: "1.0",
    chainId: CHAIN_ID,
    from: ADDRESS,
    clientRequestId: `prepared-${label}-${mode}`,
    intent: Object.freeze(intent),
    constraints: Object.freeze({ expiresAt: "2026-09-17T00:02:00Z", maxFee: "10000", feePreference: "standard" }),
  });
  const prepared = await prepareTbcTransaction({ request, network: dappNetwork, engine });
  let signerCalls = 0;
  let approvalCalls = 0;
  const capability = mode === "send" ? "tbc_sendTransaction" : "tbc_signTransaction";
  const expectedExecutionType = "session-only";
  const durableHostStore = createTbcKitMemoryHostStore();
  const signOnlyHostStore = createTbcKitMemoryHostStore();
  const runtime = createTbcWallet({
    accounts: { current: async () => [ACCOUNT] },
    approval: { request: async (params, call) => {
      assert.equal(call.execution.type, expectedExecutionType);
      approvalCalls += 1;
      return { status: "approved", approvalId: `prepared-approval-${mode}`, approvalToken: `prepared-token-${mode}`, bindingHash: params.binding.bindingHash, approvedAt: "2026-09-17T00:00:10Z", expiresAt: params.binding.payload.expiresAt ?? "2026-09-17T00:02:00Z" };
    } },
    signer: { sign: async (params, call) => {
      assert.equal(call.execution.type, expectedExecutionType);
      signerCalls += 1;
      return { taskId: params.task.taskId, signatureEncoding: "compact64", signature: secp256k1.sign(params.task.digest, PRIVATE_KEY, { prehash: false, lowS: true }).toCompactHex() };
    } },
    storage: { hostStore: durableHostStore, loadPermissions: async () => ({ revision: "0", permissions: [permission("tbc_accounts"), permission(capability)] }), commitPermissions: async (params) => ({ revisions: params.changes.map((change) => ({ scope: change.scope, revision: "1" })) }) },
    network: walletNetwork,
    engine,
    clock: () => "2026-09-17T00:00:10Z",
    randomBytes: (length) => Uint8Array.from({ length }, (_, index) => index),
  });
  const session = await runtime.openSession({
    origin,
    sessionId: `prepared-${mode}`,
    execution: { hostStore: signOnlyHostStore },
  });
  try {
    const authorizedProvider = Object.freeze({
      ...session.provider,
      request: (request, options) => request.method === "tbc_requestAccounts"
        ? Promise.resolve([ADDRESS])
        : session.provider.request(request, options),
    });
    const client = createTbcClient({ network: CHAIN_ID, provider: authorizedProvider, requestIdFactory: () => `prepared-provider-${mode}` });
    const connected = await client.connect();
    const input = { intent: request.intent, proposal: prepared.proposal, constraints: request.constraints, clientRequestId: request.clientRequestId };
    let result;
    try {
      result = mode === "send"
        ? await connected.wallet.sendProposal(input)
        : await connected.wallet.signProposal(input);
    } catch (error) {
      throw new Error(`prepared ${mode} failed after approvals=${approvalCalls} signer=${signerCalls} http=${httpEdges.join(",")}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    assert.ok(result.transactions.length > 0);
    assert.ok(signerCalls > 0);
    if (mode === "sign") {
      assert.deepEqual(submitted, []);
      assert.equal(httpEdges.includes("POST /api/tbc/broadcasttx"), false);
    } else {
      assert.deepEqual(submitted, result.transactions.map(({ txid }) => txid));
    }
    return {
      label,
      mode,
      transactions: result.transactions.length,
      proposalKinds: prepared.proposal.payload.transactions.map(({ kind }) => kind),
      signerCalls,
      submitCalls: submitted.length,
      httpEdges,
      proposalHash: prepared.proposal.proposalHash,
      dappObservedAt,
      walletObservedAt,
      executionType: expectedExecutionType,
    };
  } finally {
    session.close();
  }
}

async function runPreparedWorkflow() {
  const httpEdges = [];
  const baseFetch = createControlledKey1TestnetFetch({ nativeUtxoSatoshis: 5e6 });
  const fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    httpEdges.push(`${(init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase()} ${url.pathname}`);
    return baseFetch(input, init);
  };
  const networkAt = (observedAt, role) => createDefaultTbcTestnetNetwork({
    accounts: { current: async () => [ACCOUNT] },
    fetch,
    poolNative,
    now: () => Date.parse(observedAt),
    snapshotId: async () => `snapshot-prepared-workflow-${role}`,
  });
  const request = Object.freeze({
    version: "1.0",
    chainId: CHAIN_ID,
    from: ADDRESS,
    clientRequestId: "prepared-workflow-ft-create",
    expiresAt: "2026-09-17T00:02:00Z",
    maxTotalFee: "10000",
    steps: Object.freeze([Object.freeze({
      id: "create-ft",
      kind: "transaction",
      dependsOn: Object.freeze([]),
      intent: Object.freeze({ type: "tbc20-standard-create", version: "1.0", name: "Workflow Probe", symbol: "WFP", decimals: 6, initialSupply: "1000000" }),
      constraints: Object.freeze({ expiresAt: "2026-09-17T00:02:00Z", maxFee: "10000", feePreference: "standard" }),
    })]),
  });
  const prepared = await prepareTbcWorkflow({
    request,
    network: networkAt("2026-09-17T00:00:00Z", "dapp"),
    engine,
  });
  let approvalCalls = 0;
  let signerCalls = 0;
  const durableHostStore = createTbcKitMemoryHostStore();
  const signOnlyHostStore = createTbcKitMemoryHostStore();
  const runtime = createTbcWallet({
    accounts: { current: async () => [ACCOUNT] },
    approval: { request: async (params, call) => {
      assert.equal(call.execution.type, "session-only");
      approvalCalls += 1;
      return { status: "approved", approvalId: "prepared-workflow-approval", approvalToken: "prepared-workflow-token", bindingHash: params.binding.bindingHash, approvedAt: "2026-09-17T00:00:10Z", expiresAt: params.binding.payload.expiresAt };
    } },
    signer: { sign: async (params, call) => {
      assert.equal(call.execution.type, "session-only");
      signerCalls += 1;
      return { taskId: params.task.taskId, signatureEncoding: "compact64", signature: secp256k1.sign(params.task.digest, PRIVATE_KEY, { prehash: false, lowS: true }).toCompactHex() };
    } },
    storage: { hostStore: durableHostStore, loadPermissions: async () => ({ revision: "0", permissions: [permission("tbc_accounts"), permission("tbc_signWorkflow"), permission("tbc_signTransaction")] }), commitPermissions: async (params) => ({ revisions: params.changes.map((change) => ({ scope: change.scope, revision: "1" })) }) },
    network: networkAt("2026-09-17T00:00:30Z", "wallet"),
    engine,
    clock: () => "2026-09-17T00:00:10Z",
    randomBytes: (length) => Uint8Array.from({ length }, (_, index) => index),
  });
  const session = await runtime.openSession({
    origin,
    sessionId: "prepared-workflow",
    execution: { hostStore: signOnlyHostStore },
  });
  try {
    const authorizedProvider = Object.freeze({
      ...session.provider,
      request: (request, options) => request.method === "tbc_requestAccounts"
        ? Promise.resolve([ADDRESS])
        : session.provider.request(request, options),
    });
    const connected = await createTbcClient({ network: CHAIN_ID, provider: authorizedProvider }).connect();
    const { version: _version, chainId: _chainId, from: _from, ...input } = prepared;
    const result = await connected.wallet.signPreparedWorkflow(input);
    assert.equal(result.steps[0].kind, "preparedTransaction");
    assert.equal(result.steps[0].result.transactions.length, 2);
    assert.equal(approvalCalls, 1);
    assert.ok(signerCalls > 1);
    assert.equal(httpEdges.includes("POST /api/tbc/broadcasttx"), false);
    return {
      steps: result.steps.length,
      transactions: result.steps[0].result.transactions.length,
      proposalKinds: prepared.steps[0].proposal.payload.transactions.map(({ kind }) => kind),
      approvalCalls,
      signerCalls,
      httpEdges,
      executionType: "session-only",
    };
  } finally {
    session.close();
  }
}

const prepared = {
  sign: await runPrepared("sign", { type: "tbc.transfer", version: "1.0", to: ADDRESS, amount: "1000" }, "transfer"),
  send: await runPrepared("send", { type: "tbc.transfer", version: "1.0", to: ADDRESS, amount: "1000" }, "transfer"),
  deferredBundle: await runPrepared("sign", { type: "tbc20-standard-create", version: "1.0", name: "Prepared Probe", symbol: "PRP", decimals: 6, initialSupply: "1000000" }, "tbc20-create"),
  preparedWorkflow: await runPreparedWorkflow(),
};

console.log(JSON.stringify({
  phase: "S2-default-http-success",
  package: "@tbc/kit",
  engine: "bundled Rust-WASM",
  keyless: "bundled real keyless WASM",
  fixture: "public scalar-one synthetic Testnet fixture",
  resolverOverride: false,
  policyOverride: false,
  cases: signOnly.length,
  disabled,
  signOnly,
  representativeSend,
  prepared,
}, null, 2));
