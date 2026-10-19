import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createDefaultTbcChainDataResolver,
  createDefaultTbcTestnetNetwork,
  createLazyProductionPoolMaterialSource,
  createPoolSnapshotMaterialRetention,
  hashCanonical,
} from "../dist/esm/wallet.js";
import { createTbcWallet } from "../dist/esm/wallet.js";
import { createTbcClient } from "../dist/esm/index.js";
import { createTbcEngine, createWasmTbcEngineBackend } from "../dist/esm/engine.js";
import { createRequestLedger } from "../dist/esm/testing.js";
import { assertTestnetAddress, inspectTbcTransaction, turingTransactionId } from "../dist/esm/api.js";

const fixture = JSON.parse(await readFile(new URL("./fixtures/controlled-pool.json", import.meta.url), "utf8"));
const CHAIN_ID = "tbc:testnet";
const ADDRESS = fixture.address;
const ACCOUNT = Object.freeze({
  accountId: `${CHAIN_ID}:${ADDRESS}`,
  address: ADDRESS,
  chainId: CHAIN_ID,
  // Public key recovered from the public, already-signed controlled fixture.
  publicKey: "02f4854f6efa9c17e519c401c20b01ee166054a1fcda490f564504239be8e30e42",
});
const NATIVE_SCRIPT = assertTestnetAddress(ADDRESS).scriptPubKey;
const NATIVE_RAW = [
  "0a000000", "01", "00".repeat(32), "00000000", "00", "ffffffff", "01",
  "204e000000000000", "19", NATIVE_SCRIPT, "00000000",
].join("");
const NATIVE_TXID = turingTransactionId(NATIVE_RAW);
const NATIVE_RAW_2 = [
  "0a000000", "01", "11".repeat(32), "00000000", "00", "ffffffff", "01",
  "404b4c0000000000", "19", NATIVE_SCRIPT, "00000000",
].join("");
const NATIVE_TXID_2 = turingTransactionId(NATIVE_RAW_2);

function response(data) {
  return new Response(JSON.stringify({ code: "200", data }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function controlledFetch(trace) {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    trace.push(`${init?.method ?? "GET"} ${url.pathname}`);
    if (url.pathname === "/api/tbc/nodeinfo") return response({ blocks: 1000, bestblockhash: "aa".repeat(32) });
    if (url.pathname === `/api/tbc/utxo/address/${ADDRESS}`) {
      return response({ utxos: [
        { txid: NATIVE_TXID, index: 0, value: "20000", height: 990 },
        { txid: NATIVE_TXID_2, index: 0, value: "5000000", height: 990 },
      ] });
    }
    if (url.pathname.includes("/api/tbc/ft/utxo/combinescript/") && url.pathname.endsWith(`/contract/${fixture.ftContractId}`)) {
      return response({ utxos: [{ ...fixture.ownerCandidate, height: 990 }] });
    }
    const txraw = url.pathname.match(/^\/api\/tbc\/txraw\/txid\/([0-9a-f]{64})$/u)?.[1];
    if (txraw === NATIVE_TXID) return response({ txraw: NATIVE_RAW });
    if (txraw === NATIVE_TXID_2) return response({ txraw: NATIVE_RAW_2 });
    if (txraw !== undefined && fixture.rawTransactions[txraw] !== undefined) {
      return response({ txraw: fixture.rawTransactions[txraw] });
    }
    throw new Error(`Unexpected controlled request: ${url.pathname}`);
  };
}

function requirement(intentType) {
  if (intentType === "tbc.transfer") return {
    intentType, nativeAmount: "1000", assets: [{ kind: "native", minimumAmount: "1000" }], includeAncestry: true,
  };
  if (intentType === "tbc.maintenance.merge") return {
    intentType, assets: [{ kind: "native" }], includeAncestry: false,
  };
  if (intentType === "tbc.pool.ft.merge" || intentType === "tbc.pool.ftlp.merge" || intentType === "tbc.pool.ftlp.burn") return {
    intentType,
    contractIds: [fixture.poolContractId],
    assets: [
      { kind: "native" },
      { kind: "pool", contractId: fixture.poolContractId },
      {
        kind: intentType === "tbc.pool.ft.merge" ? "ft" : "ftlp",
        contractDependency: {
          relation: intentType === "tbc.pool.ft.merge" ? "pool-ft" : "pool-lp",
          contractId: fixture.poolContractId,
        },
      },
    ],
    includeAncestry: true,
  };
  if (intentType === "tbc.ft.create") return {
    intentType, assets: [{ kind: "native" }], includeAncestry: false,
  };
  if (intentType === "tbc.pool.create") return {
    intentType,
    contractIds: [fixture.ftContractId],
    assets: [
      { kind: "native" },
      { kind: "ft", contractId: fixture.ftContractId },
    ],
    includeAncestry: true,
  };
  return {
    intentType,
    contractIds: [fixture.ftContractId],
    nativeAmount: "10000",
    assets: [
      { kind: "native", minimumAmount: "10000" },
      { kind: "ft", contractId: fixture.ftContractId, minimumAmount: "250000" },
    ],
    includeAncestry: true,
  };
}

async function resolve(network, intentType) {
  return await network.resolveChainData({
    version: "1.0",
    chainId: CHAIN_ID,
    accountId: ACCOUNT.accountId,
    requirement: requirement(intentType),
  });
}

test("native transfer retains bounded funding candidates when no single UTXO suffices", async () => {
  for (const maxInputs of [2, 1]) {
    const trace = [];
    const network = createDefaultTbcTestnetNetwork({
      accounts: { current: async () => [ACCOUNT] },
      fetch: async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname === `/api/tbc/utxo/address/${ADDRESS}`) {
          trace.push(`GET ${url.pathname}`);
          return response({ utxos: [
            { txid: NATIVE_TXID, index: 0, value: "1000", height: 990 },
            { txid: NATIVE_TXID, index: 1, value: "8920", height: 990 },
          ] });
        }
        return controlledFetch(trace)(input, init);
      },
      broadcast: { submit: async () => ({}), reconcile: async () => ({}) },
    });
    const resolver = createDefaultTbcChainDataResolver({
      accounts: { current: async () => [ACCOUNT] }, client: network.client, maxInputs,
      snapshotId: () => "native-fragmented-funding", confirmationPolicy: { minConfirmations: "0" },
    });
    const result = await resolver.resolve({ version: "1.0", chainId: CHAIN_ID,
      accountId: ACCOUNT.accountId, requirement: {
        intentType: "tbc.transfer", nativeAmount: "9000",
        assets: [{ kind: "native", minimumAmount: "9000" }], includeAncestry: true,
      } });
    if (maxInputs === 2) {
      assert.equal(result.portError, undefined);
      assert.equal(result.payload.utxos.length, 2);
      assert.deepEqual(result.payload.utxos.map(u => u.satoshis).sort(), ["1000", "8920"]);
      assert.equal(result.payload.parents.length, 0);
    } else assert.equal(result.portError?.name, "CONFLICT");
    assert.equal(trace.filter(p => p.includes("/utxo/address/")).length, 1);
    assert.equal(trace.some(p => p.includes("/txraw/")), false);
  }
});

test("bound session account avoids a second account-provider read", async () => {
  let accountReads = 0;
  const network = createDefaultTbcTestnetNetwork({
    accounts: {
      current: async () => {
        accountReads += 1;
        return [ACCOUNT];
      },
    },
    fetch: controlledFetch([]),
    broadcast: { submit: async () => ({}), reconcile: async () => ({}) },
  });
  const params = {
    version: "1.0",
    chainId: CHAIN_ID,
    accountId: ACCOUNT.accountId,
    requirement: requirement("tbc.transfer"),
  };

  await network.resolveChainData(params, ACCOUNT);
  assert.equal(accountReads, 0, "Kit-supplied verified account must bind Chain Data directly");
  await network.resolveChainData(params);
  assert.equal(accountReads, 1, "unbound callers retain the fresh account read");
});

test("Pool material capability warms once without starting chain reads", async () => {
  let protocolReads = 0;
  let fetches = 0;
  const source = createLazyProductionPoolMaterialSource({
    native: {
      async protocolInfo() {
        protocolReads += 1;
        return JSON.stringify({
          operations: ["preparePoolNft", "prepareAssetAncestry", "legacyPoolPreview"],
        });
      },
      async execute() {
        throw new Error("native execute must wait for a Pool request");
      },
    },
    fetch: async () => {
      fetches += 1;
      throw new Error("Pool warmup must not read chain state");
    },
    baseUrl: "https://api.testnet.tbc.network/",
    allowedOrigins: ["https://api.testnet.tbc.network"],
  });

  await source.warmup();
  await source.warmup();
  assert.equal(protocolReads, 1);
  assert.equal(fetches, 0);
});

test("Pool swap material reuses the Chain Data native funding selection", async () => {
  const trace = [];
  let suppliedFunding;
  const network = createDefaultTbcTestnetNetwork({
    accounts: { current: async () => [ACCOUNT] },
    fetch: controlledFetch(trace),
    poolMaterial: {
      async resolveSwapTbcForToken(input, funding) {
        assert.equal(input.poolContractId, fixture.poolContractId);
        suppliedFunding = funding;
        assert.equal(typeof funding, "function");
        const selected = await funding();
        assert.equal(selected.address, ADDRESS);
        throw new Error("stop after verifying shared funding");
      },
    },
    broadcast: { submit: async () => ({}), reconcile: async () => ({}) },
  });
  const result = await network.resolveChainData({
    version: "1.0",
    chainId: CHAIN_ID,
    accountId: ACCOUNT.accountId,
    requirement: {
      intentType: "tbc.pool.swap.exactTbcForToken",
      contractIds: [fixture.poolContractId],
      nativeAmount: "1000",
      assets: [
        { kind: "native", minimumAmount: "1000" },
        { kind: "pool", contractId: fixture.poolContractId },
        {
          kind: "ft",
          contractDependency: { relation: "pool-ft", contractId: fixture.poolContractId },
        },
      ],
      includeAncestry: true,
    },
  }, ACCOUNT);
  assert.equal(result.portError?.name, "CONFLICT");
  assert.equal(typeof suppliedFunding, "function");
  assert.equal(trace.filter((entry) => entry.includes(`/api/tbc/utxo/address/${ADDRESS}`)).length, 1);
});

test("default Testnet orchestration handles TBC and FT without consumer selectors or snapshot builders", async () => {
  const trace = [];
  const ledger = createRequestLedger({ enabled: true });
  const network = createDefaultTbcTestnetNetwork({
    accounts: { current: async () => [ACCOUNT] },
    fetch: controlledFetch(trace),
    ledger,
    now: () => Date.parse("2026-09-17T00:00:00Z"),
    snapshotId: (() => { let id = 0; return async () => `snapshot-default-${++id}`; })(),
    broadcast: {
      submit: async () => { throw new Error("not broadcast in controlled R1"); },
      reconcile: async () => { throw new Error("not reconciled in controlled R1"); },
    },
  });

  const tbc = await resolve(network, "tbc.transfer");
  assert.equal(tbc.payload.utxos.length, 1);
  assert.equal(tbc.payload.parents.length, 0, "Rust12 native descriptor path must not fetch a parent");
  assert.equal(tbc.payload.utxos[0].txid, NATIVE_TXID);

  const ftCreate = await resolve(network, "tbc.ft.create");
  assert.equal(ftCreate.payload.parents.length, 0);
  assert.equal(ftCreate.payload.utxos[0].classification, "native");
  assert.equal(trace.some((entry) => entry.includes(NATIVE_TXID)), false, "ordinary native funding parent remains unread");

  const poolCreate = await resolve(network, "tbc.pool.create");
  assert.equal(poolCreate.payload.utxos.some((utxo) => utxo.classification === "ft"), true);
  assert.equal(poolCreate.payload.parents.some((parent) => parent.txid === NATIVE_TXID_2), true, "selected Pool funding proof remains explicit");

  const beforeFt = trace.length;
  const ft = await resolve(network, "tbc.ft.transfer");
  assert.equal(ft.payload.contracts[0].contractId, fixture.ftContractId);
  assert.equal(ft.payload.utxos.filter((utxo) => utxo.classification === "ft").length, 1);
  assert.equal(ft.payload.utxos.find((utxo) => utxo.classification === "ft").txid, fixture.ownerCandidate.txid);
  assert.equal(ft.payload.parents.some((parent) => parent.txid === fixture.ftContractId), true);
  assert.equal(trace.slice(beforeFt).some((entry) => entry.includes(`/decode/`)), false);
  assert.equal(ledger.snapshot().counts["native-index"], 4);
  assert.equal(ledger.snapshot().counts["asset-index"], 2);
  assert.ok(ledger.snapshot().counts.txraw >= 3);
});

function ftFundingCandidates(count, funded = true) {
  const dust = Array.from({ length: count - (funded ? 2 : 0) }, (_, index) => ({
    txid: (index + 1).toString(16).padStart(64, "0"), index: 0, value: "1", height: 990,
  }));
  return funded ? [
    ...dust,
    { txid: NATIVE_TXID_2, index: 0, value: "5000000", height: 990 },
    { txid: NATIVE_TXID, index: 0, value: "20000", height: 990 },
  ] : dust;
}

async function prepareFtFunding(candidates, maxInputs = 128, ftAmount = "250000") {
  const trace = [];
  const fallback = controlledFetch(trace);
  const network = createDefaultTbcTestnetNetwork({
    accounts: { current: async () => [ACCOUNT] },
    now: () => Date.parse("2026-09-17T00:00:00Z"),
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === `/api/tbc/utxo/address/${ADDRESS}`) {
        trace.push(`GET ${path}`);
        return response({ utxos: candidates });
      }
      return fallback(input, init);
    },
  });
  const resolver = createDefaultTbcChainDataResolver({
    accounts: { current: async () => { throw new Error("bound account must be reused"); } },
    client: network.client,
    maxInputs,
    now: () => Date.parse("2026-09-17T00:00:00Z"),
    snapshotId: () => "snapshot-ft-funding-boundary",
    confirmationPolicy: { minConfirmations: "0" },
  });
  const required = requirement("tbc.ft.transfer");
  const snapshot = await resolver.resolve({
    version: "1.0", chainId: CHAIN_ID, accountId: ACCOUNT.accountId,
    requirement: { ...required, assets: [required.assets[0], { ...required.assets[1], minimumAmount: ftAmount }] },
  }, ACCOUNT);
  return { network, snapshot, trace };
}

async function ftFundingPlanParams(engine, prepared, maxFee = "50000") {
  assert.equal(prepared.snapshot.portError, undefined);
  const normalized = await engine.normalizeRequest({
    version: "1.0",
    request: {
      version: "1.0", chainId: CHAIN_ID, from: ADDRESS,
      intent: { version: "1.0", type: "tbc.ft.transfer", contractId: fixture.ftContractId, to: ADDRESS, amount: "250000", attachedTbcAmount: "10000" },
      constraints: { expiresAt: "2026-09-17T00:02:00Z", maxFee, feePreference: "standard" },
    },
  });
  const policy = await prepared.network.resolvePolicy({
    version: "1.0", ...normalized, snapshotHash: prepared.snapshot.snapshotHash,
  });
  assert.equal(policy.portError, undefined);
  return { version: "1.0", ...normalized, snapshot: prepared.snapshot, policy };
}

test("FT funding retains 128/256 alternatives but Rust spends only one native input plus one FT", async () => {
  const engine = createTbcEngine({ backend: await createWasmTbcEngineBackend(await readFile(
    new URL("../artifacts/wasm/tbc_engine_wasm.wasm", import.meta.url),
  )) });
  const baseline = await prepareFtFunding(ftFundingCandidates(2), 2);
  for (const [count, maxInputs] of [[128, 128], [128, 2], [256, 2]]) {
    const prepared = await prepareFtFunding(ftFundingCandidates(count), maxInputs);
    assert.equal(prepared.snapshot.portError, undefined, "candidate count is not actual input count");
    assert.equal(prepared.snapshot.payload.utxos.length, count + 1);
    assert.deepEqual([...prepared.trace].sort(), [...baseline.trace].sort(), "more funding choices add no HTTP reads");
    const params = await ftFundingPlanParams(engine, prepared);
    const result = await engine.plan(params);
    assert.equal(result.plan.payload.transactions.length, 1);
    const template = result.plan.payload.transactions[0];
    const tx = inspectTbcTransaction(template.unsignedTransaction).transaction;
    assert.equal(tx.inputs.length, 2);
    assert.deepEqual(new Set(tx.inputs.map(({ txid }) => txid)), new Set([fixture.ownerCandidate.txid, NATIVE_TXID]), "Rust retains smallest-sufficient selection, not largest or arbitrary truncation");
    const outputTotal = tx.outputs.reduce((sum, output) => sum + output.satoshis, 0n);
    assert.equal(20000n + 500n - outputTotal, BigInt(template.fee));
    assert.ok(BigInt(template.fee) >= 80n);
    assert.ok(tx.outputs.some(({ satoshis }) => satoshis === 10000n), "attached native principal is covered");
    assert.deepEqual(await engine.validate({ ...params, phase: "plan", plan: result.plan }), { valid: true, violations: [] });
  }
});

test("FT funding keeps actual input, candidate resource, duplicate and FT balance limits", async () => {
  const tooFewSlots = await prepareFtFunding(ftFundingCandidates(128), 1);
  assert.equal(tooFewSlots.snapshot.portError?.name, "CONFLICT", "one native plus one FT still exceeds a one-input budget");
  const tooManyCandidates = await prepareFtFunding(ftFundingCandidates(257));
  assert.equal(tooManyCandidates.snapshot.portError?.name, "CONFLICT", "the independent 256-candidate resource cap is unchanged");
  const candidates = ftFundingCandidates(128);
  const duplicate = await prepareFtFunding([...candidates.slice(1), candidates[1]]);
  assert.equal(duplicate.snapshot.portError?.name, "CONFLICT");
  const insufficientFt = await prepareFtFunding(candidates, 128, "500001");
  assert.equal(insufficientFt.snapshot.portError?.name, "CONFLICT");
});

test("FT fragmented native funding is a bound prerequisite without extra HTTP reads", async () => {
  const engine = createTbcEngine({ backend: await createWasmTbcEngineBackend(await readFile(
    new URL("../artifacts/wasm/tbc_engine_wasm.wasm", import.meta.url),
  )) });
  const baseline = await prepareFtFunding(ftFundingCandidates(2));
  const prepared = await prepareFtFunding([
    { txid: NATIVE_TXID, index: 0, value: "6000", height: 990 },
    { txid: NATIVE_TXID_2, index: 0, value: "6000", height: 990 },
  ]);
  assert.deepEqual([...prepared.trace].sort(), [...baseline.trace].sort());
  const params = await ftFundingPlanParams(engine, prepared);
  const result = await engine.plan(params);
  assert.equal(result.plan.payload.transactions.length, 2);
  const [funding, transfer] = result.plan.payload.transactions;
  assert.equal(funding.id, "native-funding-1");
  assert.equal(funding.role, "maintenance");
  assert.deepEqual(transfer.dependsOn, [funding.id]);
  assert.equal(inspectTbcTransaction(funding.unsignedTransaction).transaction.inputs.length, 2);
  assert.equal(result.plan.payload.signingTasks.length, 2);
  assert.equal(BigInt(result.plan.payload.preview.totalFee), BigInt(funding.fee) + BigInt(transfer.fee));
  assert.deepEqual(await engine.validate({ ...params, phase: "plan", plan: result.plan }), { valid: true, violations: [] });
});

test("Pool funding material keeps alternatives and one preferred parent without enabling historical creation", async () => {
  const trace = [];
  const raw = [NATIVE_RAW.replace("204e000000000000", "7017000000000000"),
    NATIVE_RAW_2.replace("404b4c0000000000", "7017000000000000")];
  const ids = raw.map(turingTransactionId);
  const fallback = controlledFetch(trace);
  const network = createDefaultTbcTestnetNetwork({
    accounts: { current: async () => [ACCOUNT] },
    now: () => Date.parse("2026-09-17T00:00:00Z"),
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === `/api/tbc/utxo/address/${ADDRESS}`) {
        trace.push(`GET ${path}`);
        return response({ utxos: ids.map(txid => ({ txid, index: 0, value: "6000", height: 990 })) });
      }
      const index = ids.findIndex(id => path === `/api/tbc/txraw/txid/${id}`);
      if (index >= 0) { trace.push(`GET ${path}`); return response({ txraw: raw[index] }); }
      return fallback(input, init);
    },
  });
  const snapshot = await resolve(network, "tbc.pool.create");
  assert.equal(snapshot.portError, undefined);
  assert.equal(snapshot.payload.utxos.filter(utxo => utxo.classification === "native").length, 2);
  assert.equal(trace.filter(path => ids.some(id => path.endsWith(`/txraw/txid/${id}`))).length, 1);
  const engine = createTbcEngine({ backend: await createWasmTbcEngineBackend(await readFile(
    new URL("../artifacts/wasm/tbc_engine_wasm.wasm", import.meta.url),
  )) });
  const normalized = await engine.normalizeRequest({ version: "1.0", request: {
    version: "1.0", chainId: CHAIN_ID, from: ADDRESS,
    intent: { version: "1.0", type: "tbc.pool.create", stage: "mint", ftContractId: fixture.ftContractId, lpPlan: 2, serviceProviderTag: "durian" },
    constraints: { maxFee: "50000" },
  } });
  const policy = await network.resolvePolicy({ version: "1.0", ...normalized, snapshotHash: snapshot.snapshotHash });
  const params = { version: "1.0", ...normalized, snapshot, policy };
  // Material selection is unchanged, but the public Engine must no longer
  // accept this historical issuance intent. Supported existing-pool funding
  // plan/finalize coverage lives in the Rust test
  // fragmented_native_funding_pool_finalize_and_validate (add/remove/close/
  // both swap directions), not in a now-prohibited pool creation.
  await assert.rejects(async () => engine.plan(params), error =>
    error.code === "INVALID_REQUEST" && error.message === "historical asset issuance is disabled");
});

test("FT alternatives do not bypass Rust fee funding or maxFee enforcement", async () => {
  const engine = createTbcEngine({ backend: await createWasmTbcEngineBackend(await readFile(
    new URL("../artifacts/wasm/tbc_engine_wasm.wasm", import.meta.url),
  )) });
  const insufficient = await prepareFtFunding(ftFundingCandidates(128, false));
  const params = await ftFundingPlanParams(engine, insufficient);
  await assert.rejects(async () => engine.plan(params), (error) => error.code === "INSUFFICIENT_FUNDS");
  const funded = await prepareFtFunding(ftFundingCandidates(128));
  const capped = await ftFundingPlanParams(engine, funded, "1");
  await assert.rejects(async () => engine.plan(capped), (error) => error.rustCode === "FEE_CAP_EXCEEDED");
});

test("public merge resolution is isolated, bounded, and routes Pool FT and FTLP independently", async () => {
  const trace = [];
  const calls = [];
  const poolMaterial = {
    async resolvePoolFtMerge(input, funding) {
      calls.push(["pool-ft", input]);
      await funding();
      return { utxos: [], parents: [], contracts: [], policy: { lpPlan: 2, serviceProviderTag: "merge-test", serviceFeeRate: 35 } };
    },
    async resolveFtlpMerge(input, funding) {
      calls.push(["ftlp", input]);
      await funding();
      return { utxos: [], parents: [], contracts: [], policy: { lpPlan: 2, serviceProviderTag: "merge-test", serviceFeeRate: 35 } };
    },
    async resolveFtlpBurn(input, funding) {
      calls.push(["ftlp-burn", input]);
      await funding();
      return { utxos: [], parents: [], contracts: [], policy: { lpPlan: 2, serviceProviderTag: "merge-test", serviceFeeRate: 35 } };
    },
  };
  const network = createDefaultTbcTestnetNetwork({
    accounts: { current: async () => [ACCOUNT] },
    fetch: controlledFetch(trace),
    poolMaterial,
    now: () => Date.parse("2026-09-17T00:00:00Z"),
    snapshotId: (() => { let id = 0; return async () => `snapshot-public-merge-${++id}`; })(),
    broadcast: { submit: async () => ({}), reconcile: async () => ({}) },
  });

  const native = await resolve(network, "tbc.maintenance.merge");
  assert.equal(native.portError, undefined);
  assert.deepEqual(native.payload.utxos.map(({ txid }) => txid), [NATIVE_TXID, NATIVE_TXID_2]);
  assert.equal(native.payload.parents.length, 0, "native merge must not fetch ancestry");
  const afterNative = trace.length;

  const poolFt = await resolve(network, "tbc.pool.ft.merge");
  const ftlp = await resolve(network, "tbc.pool.ftlp.merge");
  const burn = await resolve(network, "tbc.pool.ftlp.burn");
  assert.equal(poolFt.portError, undefined);
  assert.equal(ftlp.portError, undefined);
  assert.equal(burn.portError, undefined);
  assert.deepEqual(calls, [
    ["pool-ft", { address: ADDRESS, poolContractId: fixture.poolContractId }],
    ["ftlp", { address: ADDRESS, poolContractId: fixture.poolContractId }],
    ["ftlp-burn", { address: ADDRESS, poolContractId: fixture.poolContractId }],
  ]);
  const burnRequest = {
    version: "1.0", chainId: CHAIN_ID, from: ADDRESS,
    intent: { version: "1.0", type: "tbc.pool.ftlp.burn", poolContractId: fixture.poolContractId },
  };
  const burnPolicy = await network.resolvePolicy({
    version: "1.0",
    request: burnRequest,
    requestHash: hashCanonical(burnRequest),
    snapshotHash: burn.snapshotHash,
  });
  assert.equal(burnPolicy.portError, undefined);
  assert.deepEqual(burnPolicy.payload.pool, {
    lpPlan: 2,
    serviceProviderTag: "merge-test",
    serviceFeeRate: 35,
  });
  const mismatchedRequest = {
    ...burnRequest,
    intent: { ...burnRequest.intent, poolContractId: "00".repeat(32) },
  };
  const mismatchedPolicy = await network.resolvePolicy({
    version: "1.0",
    request: mismatchedRequest,
    requestHash: hashCanonical(mismatchedRequest),
    snapshotHash: burn.snapshotHash,
  });
  assert.equal(mismatchedPolicy.portError.name, "INVALID_INPUT", "Pool policy must remain bound to the exact contract and snapshot");
  assert.equal(
    trace.slice(0, afterNative).some((entry) => entry.includes("/txraw/")),
    false,
    "native merge does not pay the Pool proof-read cost",
  );
});

test("public FTLP burn crosses strict Provider and the default bound Pool policy into the real Rust plan", async () => {
  const backend = await createWasmTbcEngineBackend(await readFile(new URL("../artifacts/wasm/tbc_engine_wasm.wasm", import.meta.url)));
  const actual = createTbcEngine({ backend });
  const planInputs = [];
  const engine = Object.freeze({
    normalizeRequest: actual.normalizeRequest,
    async plan(params) {
      planInputs.push(params);
      return await actual.plan(params);
    },
    validate: actual.validate,
    finalize: actual.finalize,
  });
  const poolCalls = [];
  const poolMaterial = {
    async resolveFtlpBurn(input, funding) {
      poolCalls.push(input);
      await funding();
      return {
        utxos: [], parents: [], contracts: [],
        policy: { lpPlan: 2, serviceProviderTag: "burn-policy", serviceFeeRate: 35 },
      };
    },
  };
  let signerCalls = 0;
  let broadcasts = 0;
  let transactionApprovals = 0;
  const origin = "https://burn-policy.test";
  const permission = (capability) => ({
    id: `burn-${capability}`,
    parentCapability: capability,
    invoker: origin,
    date: Date.parse("2026-09-17T00:00:00Z"),
    caveats: [
      { type: "restrictChains", value: [CHAIN_ID] },
      { type: "restrictAccounts", value: [ACCOUNT.accountId] },
      { type: "restrictMethods", value: [capability] },
    ],
  });
  const runtime = createTbcWallet({
    accounts: { current: async () => [ACCOUNT] },
    approval: {
      async request(params) {
        if (params.binding.payload.operationKind === "permission") {
          return {
            status: "approved",
            approvalId: "burn-permission",
            approvalToken: "burn-permission-token",
            bindingHash: params.binding.bindingHash,
            approvedAt: "2026-09-17T00:00:10Z",
            expiresAt: params.binding.payload.expiresAt,
          };
        }
        transactionApprovals += 1;
        return { status: "rejected", bindingHash: params.binding.bindingHash, rejectedAt: "2026-09-17T00:00:10Z" };
      },
    },
    signer: { async sign() { signerCalls += 1; return {}; } },
    storage: {
      async loadPermissions() {
        return { revision: "0", permissions: [permission("tbc_accounts"), permission("tbc_sendTransaction")] };
      },
      async commitPermissions(params) {
        return { revisions: params.changes.map((change) => ({ scope: change.scope, revision: "1" })) };
      },
    },
    network: {
      defaultTestnet: {
        fetch: controlledFetch([]),
        poolMaterial,
        now: () => Date.parse("2026-09-17T00:00:00Z"),
        snapshotId: async () => "snapshot-default-ftlp-burn",
        broadcast: {
          async submit() { broadcasts += 1; return {}; },
          async reconcile() { return { transactions: [] }; },
        },
      },
    },
    engine,
    clock: () => "2026-09-17T00:00:10Z",
    randomBytes: () => Uint8Array.from({ length: 16 }, (_, index) => index),
  });
  const session = await runtime.openSession({ origin, sessionId: "default-ftlp-burn" });
  let requestSequence = 0;
  const wallet = await createTbcClient({
    network: CHAIN_ID,
    provider: session.provider,
    requestIdFactory: () => `default-ftlp-burn-request-${++requestSequence}`,
  }).connect();
  const error = await wallet.maintenance.burnFtlp({ poolContractId: fixture.poolContractId })
    .then(() => undefined, (caught) => caught);
  assert.ok(error, "controlled empty FTLP material must stop without signing or broadcast");
  assert.deepEqual(poolCalls, [{ address: ADDRESS, poolContractId: fixture.poolContractId }]);
  assert.equal(planInputs.length, 1, "default policy must authorize the exact burn into planning");
  assert.equal(planInputs[0].request.intent.type, "tbc.pool.ftlp.burn");
  assert.equal(planInputs[0].request.intent.poolContractId, fixture.poolContractId);
  assert.deepEqual(planInputs[0].policy.payload.pool, {
    lpPlan: 2,
    serviceProviderTag: "burn-policy",
    serviceFeeRate: 35,
  });
  assert.equal(signerCalls, 0);
  assert.equal(broadcasts, 0);
  assert.equal(transactionApprovals, 0);

  session.close();
});

test("single-flight remains active when request observation is disabled", async () => {
  let fetches = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const fetch = async (input) => {
    fetches += 1;
    await gate;
    const url = new URL(String(input));
    if (url.pathname === "/api/tbc/nodeinfo") return response({ blocks: 1000, bestblockhash: "aa".repeat(32) });
    if (url.pathname === `/api/tbc/utxo/address/${ADDRESS}`) {
      return new Response(JSON.stringify({ code: "400", data: {} }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected ${url.pathname}`);
  };
  const { client } = createDefaultTbcTestnetNetwork({
    accounts: { current: async () => [ACCOUNT] },
    fetch,
    broadcast: { submit: async () => ({}), reconcile: async () => ({}) },
  });
  const first = client.getUtxos(ADDRESS).catch(() => undefined);
  const duplicate = client.getUtxos(ADDRESS).catch(() => undefined);
  await Promise.resolve();
  assert.equal(fetches, 2, "nodeinfo and UTXO index each single-flight once");
  release();
  await Promise.all([first, duplicate]);
  assert.equal(fetches, 2);
});

test("FT selected-parent and creation reads start together", async () => {
  let releaseSelectedParent;
  const selectedParentGate = new Promise((resolve) => { releaseSelectedParent = resolve; });
  let creationStarted = false;
  let signalCreationStarted;
  const creationStartedSignal = new Promise((resolve) => { signalCreationStarted = resolve; });
  const client = {
    async getUtxos() {
      return {
        tip: { height: "1000", hash: "aa".repeat(32) },
        utxos: [{ txid: NATIVE_TXID, vout: 0, satoshis: "20000", height: "990" }],
      };
    },
    async getFtUtxos() {
      return [{
        txid: fixture.ownerCandidate.txid,
        vout: fixture.ownerCandidate.index,
        satoshis: String(fixture.ownerCandidate.tbc_value),
        ftAmount: String(fixture.ownerCandidate.ft_value),
        height: "990",
      }];
    },
    async getRawTransactionBytes(txid) {
      if (txid === fixture.ownerCandidate.txid) await selectedParentGate;
      if (txid === fixture.ftContractId) {
        creationStarted = true;
        signalCreationStarted();
      }
      const raw = fixture.rawTransactions[txid];
      if (raw === undefined) throw new Error(`missing controlled raw ${txid}`);
      return raw;
    },
    async getRawTransaction() { throw new Error("unexpected decoded read"); },
  };
  const resolver = createDefaultTbcChainDataResolver({
    accounts: { current: async () => [ACCOUNT] },
    client,
    now: () => Date.parse("2026-09-17T00:00:00Z"),
    snapshotId: async () => "snapshot-ft-parallel-parents",
  });
  const resolving = resolver.resolve({
    version: "1.0",
    chainId: CHAIN_ID,
    accountId: ACCOUNT.accountId,
    requirement: requirement("tbc.ft.transfer"),
  });
  await Promise.race([
    creationStartedSignal,
    new Promise((resolve) => setTimeout(resolve, 50)),
  ]);
  assert.equal(creationStarted, true, "creation bytes must start while the selected parent is held");
  releaseSelectedParent();
  const result = await resolving;
  assert.equal("portError" in result, false);
});

test("FT decoded confirmation state stays fresh across resolver requests", async () => {
  const selectedRaw = fixture.rawTransactions[fixture.ownerCandidate.txid];
  const selected = inspectTbcTransaction(selectedRaw).transaction;
  let confirmations = "0";
  let decodedReads = 0;
  const client = {
    async getUtxos() {
      return {
        tip: { height: "1000", hash: "aa".repeat(32) },
        utxos: [{ txid: NATIVE_TXID, vout: 0, satoshis: "20000", height: "990" }],
      };
    },
    async getFtUtxos() {
      return [{
        txid: fixture.ownerCandidate.txid,
        vout: fixture.ownerCandidate.index,
        satoshis: String(fixture.ownerCandidate.tbc_value),
        ftAmount: String(fixture.ownerCandidate.ft_value),
      }];
    },
    async getRawTransaction(txid) {
      assert.equal(txid, fixture.ownerCandidate.txid);
      decodedReads += 1;
      return {
        txid,
        rawTransaction: selectedRaw,
        confirmations,
        inputs: selected.inputs,
        outputs: selected.outputs.map((output, vout) => ({
          vout,
          satoshis: output.satoshis.toString(),
          scriptPubKey: Buffer.from(output.scriptPubKey).toString("hex"),
          addresses: [],
        })),
      };
    },
    async getRawTransactionBytes(txid) {
      const raw = fixture.rawTransactions[txid];
      if (raw === undefined) throw new Error(`missing controlled raw ${txid}`);
      return raw;
    },
  };
  const resolver = createDefaultTbcChainDataResolver({
    accounts: { current: async () => [ACCOUNT] },
    client,
    now: () => Date.parse("2026-09-17T00:00:00Z"),
    snapshotId: (() => { let id = 0; return async () => `snapshot-ft-fresh-${++id}`; })(),
  });
  const first = await resolver.resolve({
    version: "1.0", chainId: CHAIN_ID, accountId: ACCOUNT.accountId,
    requirement: requirement("tbc.ft.transfer"),
  });
  confirmations = "1";
  const second = await resolver.resolve({
    version: "1.0", chainId: CHAIN_ID, accountId: ACCOUNT.accountId,
    requirement: requirement("tbc.ft.transfer"),
  });
  assert.equal(first.payload.utxos.find((utxo) => utxo.classification === "ft").confirmations, "0");
  assert.equal(second.payload.utxos.find((utxo) => utxo.classification === "ft").confirmations, "1");
  assert.equal(decodedReads, 2);
});

test("zero-floor FT construction omits unknown confirmation counts without decode", async () => {
  const client = {
    async getUtxos() {
      return { tip: { height: "1000", hash: "aa".repeat(32) },
        utxos: [{ txid: NATIVE_TXID, vout: 0, satoshis: "20000", height: "990" }] };
    },
    async getFtUtxos() {
      return [{ txid: fixture.ownerCandidate.txid, vout: fixture.ownerCandidate.index,
        satoshis: String(fixture.ownerCandidate.tbc_value), ftAmount: String(fixture.ownerCandidate.ft_value) }];
    },
    async getRawTransaction() { throw Error("CONFIRMATION_ONLY_DECODE"); },
    async getRawTransactionBytes(txid) {
      const raw = fixture.rawTransactions[txid];
      if (raw === undefined) throw Error(`missing fixture ${txid}`);
      return raw;
    },
  };
  const resolveWith = async (minConfirmations) => {
    const resolver = createDefaultTbcChainDataResolver({
      accounts: { current: async () => [ACCOUNT] }, client,
      confirmationPolicy: { minConfirmations },
    });
    return resolver.resolve({ version: "1.0", chainId: CHAIN_ID, accountId: ACCOUNT.accountId,
      requirement: requirement("tbc.ft.transfer") });
  };
  const zero = await resolveWith("0");
  assert.equal(zero.portError, undefined);
  const ft = zero.payload.utxos.find((u) => u.classification === "ft");
  assert.equal(Object.hasOwn(ft, "confirmations"), false);
  assert.equal(zero.payload.utxos.find((u) => u.classification === "native").confirmations, "11");
  const positive = await resolveWith("1");
  assert.ok(positive.portError, "positive floor cannot succeed without a confirmation observation");
});

test("FT indexed then missing height falls back to a fresh decoded observation", async () => {
  const selectedRaw = fixture.rawTransactions[fixture.ownerCandidate.txid];
  const selected = inspectTbcTransaction(selectedRaw).transaction;
  let indexed = true;
  let decodedReads = 0;
  const client = {
    async getUtxos() {
      return {
        tip: { height: "1000", hash: "aa".repeat(32) },
        utxos: [{ txid: NATIVE_TXID, vout: 0, satoshis: "20000", height: "990" }],
      };
    },
    async getFtUtxos() {
      return [{
        txid: fixture.ownerCandidate.txid,
        vout: fixture.ownerCandidate.index,
        satoshis: String(fixture.ownerCandidate.tbc_value),
        ftAmount: String(fixture.ownerCandidate.ft_value),
        ...(indexed ? { height: "990" } : {}),
      }];
    },
    async getRawTransaction(txid) {
      assert.equal(txid, fixture.ownerCandidate.txid);
      decodedReads += 1;
      return {
        txid,
        rawTransaction: selectedRaw,
        confirmations: "0",
        inputs: selected.inputs,
        outputs: selected.outputs.map((output, vout) => ({
          vout,
          satoshis: output.satoshis.toString(),
          scriptPubKey: Buffer.from(output.scriptPubKey).toString("hex"),
          addresses: [],
        })),
      };
    },
    async getRawTransactionBytes(txid) {
      const raw = fixture.rawTransactions[txid];
      if (raw === undefined) throw new Error(`missing controlled raw ${txid}`);
      return raw;
    },
  };
  const resolver = createDefaultTbcChainDataResolver({
    accounts: { current: async () => [ACCOUNT] }, client,
    now: () => Date.parse("2026-09-17T00:00:00Z"),
    snapshotId: (() => { let id = 0; return async () => `snapshot-ft-height-${++id}`; })(),
  });
  const first = await resolver.resolve({
    version: "1.0", chainId: CHAIN_ID, accountId: ACCOUNT.accountId,
    requirement: requirement("tbc.ft.transfer"),
  });
  indexed = false;
  const second = await resolver.resolve({
    version: "1.0", chainId: CHAIN_ID, accountId: ACCOUNT.accountId,
    requirement: requirement("tbc.ft.transfer"),
  });
  assert.equal(first.payload.utxos.find((utxo) => utxo.classification === "ft").confirmations, "11");
  assert.equal(second.payload.utxos.find((utxo) => utxo.classification === "ft").confirmations, "0");
  assert.equal(decodedReads, 1);
});

test("LP readIndex resolves from the native index without waiting for funding parent bytes", async () => {
  let releaseFundingParent;
  const fundingParentGate = new Promise((resolve) => { releaseFundingParent = resolve; });
  let fundingParentStarted = false;
  let indexResolved = false;
  const poolMaterial = {
    async resolveLiquidityAdd(_input, funding) {
      const index = await funding.readIndex();
      assert.equal(index.tipHeight, "1000");
      assert.equal(index.indexedHeights[NATIVE_TXID_2], "990");
      assert.equal(index.selectedParentTxid, NATIVE_TXID_2);
      indexResolved = true;
      await funding();
      return {
        utxos: [],
        parents: [],
        contracts: [],
        policy: { lpPlan: 2, serviceProviderTag: "controlled-pool", serviceFeeRate: 35 },
        review: {
          ftContractId: fixture.ftContractId,
          ftRequiredRaw: "250000",
          ftlpDeltaRaw: "1000",
          lockTime: "0",
          feeFundingCapAtomic: "5000000",
          poolBefore: { tbcSat: "10000", ftARaw: "2500000", ftLpRaw: "10000", poolValueSat: "11000" },
          poolAfter: { tbcSat: "11000", ftARaw: "2750000", ftLpRaw: "11000", poolValueSat: "12000" },
        },
      };
    },
  };
  const client = {
    async getUtxos() {
      return {
        tip: { height: "1000", hash: "aa".repeat(32) },
        utxos: [{ txid: NATIVE_TXID_2, vout: 0, satoshis: "5000000", height: "990" }],
      };
    },
    async getNativeUtxoParent() {
      fundingParentStarted = true;
      await fundingParentGate;
      return {
        txid: NATIVE_TXID_2,
        rawTransaction: NATIVE_RAW_2,
        confirmations: "11",
        inputs: [{ txid: "11".repeat(32), vout: 0 }],
        outputs: [{ vout: 0, satoshis: "5000000", scriptPubKey: NATIVE_SCRIPT, addresses: [ADDRESS] }],
      };
    },
    async getRawTransaction() { throw new Error("unexpected decoded read"); },
    async getFtUtxos() { throw new Error("unexpected FT index read"); },
  };
  const resolver = createDefaultTbcChainDataResolver({
    accounts: { current: async () => [ACCOUNT] },
    client,
    poolMaterial,
    now: () => Date.parse("2026-09-17T00:00:00Z"),
    snapshotId: async () => "snapshot-lp-index-parallel",
  });
  const resolving = resolver.resolve({
    version: "1.0",
    chainId: CHAIN_ID,
    accountId: ACCOUNT.accountId,
    requirement: {
      intentType: "tbc.pool.liquidity.add",
      contractIds: [fixture.ftContractId],
      nativeAmount: "10000",
      assets: [
        { kind: "native", minimumAmount: "10000" },
        { kind: "pool", contractId: fixture.ftContractId },
        { kind: "ft", contractDependency: { relation: "pool-ft", contractId: fixture.ftContractId } },
      ],
      includeAncestry: true,
    },
  });
  for (let turn = 0; turn < 12 && !indexResolved; turn += 1) await Promise.resolve();
  assert.equal(fundingParentStarted, true);
  assert.equal(indexResolved, true, "LP lock-height index must not wait for funding parent bytes");
  releaseFundingParent();
  const result = await resolving;
  assert.equal("portError" in result, false);
});

test("default network shares one exact-byte inspector across client proof and Chain Data material", async () => {
  const calls = new Map();
  const parsed = new Map();
  const inspectTransaction = (raw) => {
    calls.set(raw, (calls.get(raw) ?? 0) + 1);
    let value = parsed.get(raw);
    if (value === undefined) {
      value = inspectTbcTransaction(raw);
      parsed.set(raw, value);
    }
    return value;
  };
  const network = createDefaultTbcTestnetNetwork({
    accounts: { current: async () => [ACCOUNT] },
    fetch: controlledFetch([]),
    inspectTransaction,
    now: () => Date.parse("2026-09-17T00:00:00Z"),
    snapshotId: async () => "snapshot-shared-exact-byte-inspector",
    broadcast: { submit: async () => ({}), reconcile: async () => ({}) },
  });
  const result = await resolve(network, "tbc.ft.transfer");
  assert.equal("portError" in result, false);
  const creationRaw = fixture.rawTransactions[fixture.ftContractId];
  assert.equal(calls.get(creationRaw), 2, "client proof and material conversion must use the same inspector");
  assert.equal(parsed.has(creationRaw), true);
});

test("default Pool orchestration reuses the wallet source and exports exact LP snapshot material", async () => {
  const retained = createPoolSnapshotMaterialRetention(
    () => Date.parse("2026-09-17T00:00:00Z"),
  );
  const material = {
    utxos: [],
    parents: [],
    contracts: [],
    policy: {
      lpPlan: 2,
      serviceProviderTag: "controlled-pool",
      serviceFeeRate: 35,
    },
    review: {
      ftContractId: fixture.ftContractId,
      ftRequiredRaw: "250000",
      ftlpDeltaRaw: "1000",
      lockTime: "0",
      feeFundingCapAtomic: "5000000",
      poolBefore: {
        tbcSat: "10000",
        ftARaw: "2500000",
        ftLpRaw: "10000",
        poolValueSat: "11000",
      },
      poolAfter: {
        tbcSat: "11000",
        ftARaw: "2750000",
        ftLpRaw: "11000",
        poolValueSat: "12000",
      },
    },
  };
  let resolutions = 0;
  const poolMaterial = {
    async resolveLiquidityAdd(input) {
      resolutions += 1;
      assert.deepEqual(input, requestInput);
      return material;
    },
  };
  const network = createDefaultTbcTestnetNetwork({
    accounts: { current: async () => [ACCOUNT] },
    fetch: controlledFetch([]),
    poolMaterial,
    rememberPoolSnapshotMaterial: retained.remember,
    now: () => Date.parse("2026-09-17T00:00:00Z"),
    snapshotId: async () => "snapshot-default-pool-shared-material",
    broadcast: { submit: async () => ({}), reconcile: async () => ({}) },
  });
  const requestInput = {
    address: ADDRESS,
    receiver: ADDRESS,
    poolContractId: fixture.ftContractId,
    tbcAmount: "10000",
  };
  const result = await network.resolveChainData({
    version: "1.0",
    chainId: CHAIN_ID,
    accountId: ACCOUNT.accountId,
    requirement: {
      intentType: "tbc.pool.liquidity.add",
      contractIds: [fixture.ftContractId],
      nativeAmount: "10000",
      assets: [
        { kind: "native", minimumAmount: "10000" },
        { kind: "pool", contractId: fixture.ftContractId },
        {
          kind: "ft",
          contractDependency: {
            relation: "pool-ft",
            contractId: fixture.ftContractId,
          },
        },
      ],
      includeAncestry: true,
    },
  });
  assert.equal(result.portError, undefined);
  const shared = retained.readAdd(
    { snapshotHash: result.snapshotHash, chainId: CHAIN_ID },
    requestInput,
  );
  assert.equal(shared, material);
  assert.equal(resolutions, 1, "the default network must use the injected wallet source exactly once");
  assert.equal(
    retained.readAdd(
      { snapshotHash: "00".repeat(32), chainId: CHAIN_ID },
      requestInput,
    ),
    undefined,
    "retention must not become a cross-snapshot cache",
  );
});

test("default Pool initialize retains only the exact unexpired snapshot material", async () => {
  let currentTime = Date.parse("2026-09-17T00:00:00Z");
  const retained = createPoolSnapshotMaterialRetention(() => currentTime);
  const material = {
    utxos: [],
    parents: [],
    contracts: [],
    policy: {
      lpPlan: 2,
      serviceProviderTag: "controlled-pool-initialize",
      serviceFeeRate: 35,
    },
  };
  const requestInput = {
    address: ADDRESS,
    receiver: ADDRESS,
    poolContractId: fixture.ftContractId,
    tbcAmount: "10000",
    ftAmount: "250000",
  };
  let resolutions = 0;
  const poolMaterial = {
    async resolveCreateInitialize(input) {
      resolutions += 1;
      assert.deepEqual(input, requestInput);
      return material;
    },
  };
  const network = createDefaultTbcTestnetNetwork({
    accounts: { current: async () => [ACCOUNT] },
    fetch: controlledFetch([]),
    poolMaterial,
    rememberPoolSnapshotMaterial: retained.remember,
    now: () => currentTime,
    snapshotId: async () => "snapshot-default-pool-initialize-material",
    broadcast: { submit: async () => ({}), reconcile: async () => ({}) },
  });
  const result = await network.resolveChainData({
    version: "1.0",
    chainId: CHAIN_ID,
    accountId: ACCOUNT.accountId,
    requirement: {
      intentType: "tbc.pool.create",
      contractIds: [fixture.ftContractId],
      nativeAmount: "10000",
      assets: [
        { kind: "native", minimumAmount: "10000" },
        { kind: "pool", contractId: fixture.ftContractId },
        {
          kind: "ft",
          minimumAmount: "250000",
          contractDependency: {
            relation: "pool-ft",
            contractId: fixture.ftContractId,
          },
        },
      ],
      includeAncestry: true,
    },
  });
  assert.equal(result.portError, undefined);
  const binding = { snapshotHash: result.snapshotHash, chainId: CHAIN_ID };
  assert.equal(retained.readInitialize(binding, requestInput), material);
  assert.equal(resolutions, 1, "approval reuse must not call the initialize loader again");
  assert.equal(
    retained.readInitialize({ ...binding, snapshotHash: "00".repeat(32) }, requestInput),
    undefined,
    "a different snapshot must miss",
  );
  assert.equal(
    retained.readInitialize({ ...binding, chainId: "tbc:wrong-chain" }, requestInput),
    undefined,
    "a different chain must miss",
  );
  assert.equal(
    retained.readInitialize(binding, { ...requestInput, ftAmount: "250001" }),
    undefined,
    "a different initialize input must miss",
  );
  currentTime += 120_000;
  assert.equal(
    retained.readInitialize(binding, requestInput),
    undefined,
    "expired material must fall back to the ordinary loader",
  );
  const fallback = retained.readInitialize(binding, requestInput) ??
    await poolMaterial.resolveCreateInitialize(requestInput);
  assert.equal(fallback, material);
  assert.equal(resolutions, 2, "an exact retention miss must leave the loader path available");
});

test("default Pool swaps retain exact snapshot material for zero-read approval reuse", async () => {
  for (const direction of ["tbc-for-token", "token-for-tbc"]) {
    let currentTime = Date.parse("2026-09-17T00:00:00Z");
    const retained = createPoolSnapshotMaterialRetention(() => currentTime);
    const inputAmount = direction === "tbc-for-token" ? "10000" : "250000";
    const requestInput = {
      address: ADDRESS,
      receiver: ADDRESS,
      poolContractId: fixture.ftContractId,
      ...(direction === "tbc-for-token"
        ? { tbcAmount: inputAmount }
        : { ftAmount: inputAmount }),
    };
    const material = {
      utxos: [
        {
          txid: "bb".repeat(32),
          vout: 0,
          satoshis: "500",
          scriptPubKey: "51",
          confirmations: "0",
          classification: "pool-source",
        },
      ],
      parents: [],
      contracts: [],
      policy: {
        lpPlan: 2,
        serviceProviderTag: `controlled-pool-swap-${direction}`,
        serviceFeeRate: 35,
      },
      review: {
        direction,
        ftContractId: fixture.ftContractId,
        inputAmount,
        feeFundingCapAtomic: "5000000",
        poolBefore: {
          tbcSat: "10000",
          ftARaw: "2500000",
          ftLpRaw: "10000",
          poolValueSat: "11000",
        },
      },
    };
    let resolutions = 0;
    const poolMaterial = direction === "tbc-for-token"
      ? {
          async resolveSwapTbcForToken(input) {
            resolutions += 1;
            assert.deepEqual(input, requestInput);
            return material;
          },
        }
      : {
          async resolveSwapTokenForTbc(input) {
            resolutions += 1;
            assert.deepEqual(input, requestInput);
            return material;
          },
        };
    const trace = [];
    const network = createDefaultTbcTestnetNetwork({
      accounts: { current: async () => [ACCOUNT] },
      fetch: controlledFetch(trace),
      poolMaterial,
      rememberPoolSnapshotMaterial: retained.remember,
      now: () => currentTime,
      snapshotId: async () => `snapshot-default-pool-swap-${direction}`,
      broadcast: { submit: async () => ({}), reconcile: async () => ({}) },
    });
    const result = await network.resolveChainData({
      version: "1.0",
      chainId: CHAIN_ID,
      accountId: ACCOUNT.accountId,
      requirement: {
        intentType:
          direction === "tbc-for-token"
            ? "tbc.pool.swap.exactTbcForToken"
            : "tbc.pool.swap.exactTokenForTbc",
        contractIds: [fixture.ftContractId],
        ...(direction === "tbc-for-token"
          ? { nativeAmount: inputAmount }
          : {}),
        assets: [
          {
            kind: "native",
            ...(direction === "tbc-for-token"
              ? { minimumAmount: inputAmount }
              : {}),
          },
          { kind: "pool", contractId: fixture.ftContractId },
          {
            kind: "ft",
            ...(direction === "token-for-tbc"
              ? { minimumAmount: inputAmount }
              : {}),
            contractDependency: {
              relation: "pool-ft",
              contractId: fixture.ftContractId,
            },
          },
        ],
        includeAncestry: true,
      },
    });
    assert.equal(result.portError, undefined);
    const binding = { snapshotHash: result.snapshotHash, chainId: CHAIN_ID };
    const read = direction === "tbc-for-token"
      ? retained.readSwapTbcForToken
      : retained.readSwapTokenForTbc;
    const readsBeforeApproval = trace.length;
    assert.equal(read(binding, requestInput), material);
    assert.deepEqual(
      result.payload.utxos.find(
        ({ txid, vout }) => txid === material.utxos[0].txid && vout === 0,
      ),
      material.utxos[0],
      "retention must preserve the same confirmation evidence bound into the snapshot",
    );
    assert.equal(trace.length, readsBeforeApproval, "approval reuse must add zero API reads");
    assert.equal(resolutions, 1, "approval reuse must not call the swap loader again");
    assert.equal(
      read({ ...binding, snapshotHash: "00".repeat(32) }, requestInput),
      undefined,
      "a different snapshot must miss",
    );
    assert.equal(
      read({ ...binding, chainId: "tbc:wrong-chain" }, requestInput),
      undefined,
      "a different chain must miss",
    );
    assert.equal(
      read({ ...binding, sourceIdentity: "wrong-source" }, requestInput),
      undefined,
      "a different trusted source must miss",
    );
    assert.equal(
      read(binding, { ...requestInput, address: "wrong-account" }),
      undefined,
      "a different account must miss",
    );
    assert.equal(
      read(binding, { ...requestInput, receiver: "wrong-receiver" }),
      undefined,
      "a different receiver must miss",
    );
    assert.equal(
      read(binding, { ...requestInput, poolContractId: "cc".repeat(32) }),
      undefined,
      "a different Pool must miss",
    );
    assert.equal(
      read(binding, {
        ...requestInput,
        ...(direction === "tbc-for-token"
          ? { tbcAmount: (BigInt(inputAmount) + 1n).toString() }
          : { ftAmount: (BigInt(inputAmount) + 1n).toString() }),
      }),
      undefined,
      "a different swap amount must miss",
    );
    currentTime += 120_000;
    assert.equal(
      read(binding, requestInput),
      undefined,
      "expired swap material must miss",
    );
  }
});

test("default historical FT issuance is denied before planning while holder transfer still reaches approval", async () => {
  const backend = await createWasmTbcEngineBackend(await readFile(new URL("../artifacts/wasm/tbc_engine_wasm.wasm", import.meta.url)));
  const actual = createTbcEngine({ backend });
  let plans = 0;
  let planError;
  const engine = Object.freeze({
    normalizeRequest: actual.normalizeRequest,
    async plan(params) {
      plans += 1;
      try { return await actual.plan(params); }
      catch (error) { planError = error; throw error; }
    },
    validate: actual.validate,
    finalize: actual.finalize,
  });
  let approvals = 0;
  let signerCalls = 0;
  let broadcasts = 0;
  const permission = (capability) => ({
    id: `r1-${capability}`,
    parentCapability: capability,
    invoker: "https://wallet.test",
    date: Date.parse("2026-09-17T00:00:00Z"),
    caveats: [
      { type: "restrictChains", value: [CHAIN_ID] },
      { type: "restrictAccounts", value: [ACCOUNT.accountId] },
      { type: "restrictMethods", value: [capability] },
    ],
  });
  const runtime = createTbcWallet({
    accounts: { current: async () => [ACCOUNT] },
    approval: {
      async request(params) {
        approvals += 1;
        if (params.binding.payload.operationKind === "permission") {
          return {
            status: "approved",
            approvalId: "r1-permission-approval",
            approvalToken: "r1-permission-token",
            bindingHash: params.binding.bindingHash,
            approvedAt: "2026-09-17T00:00:10Z",
            expiresAt: params.binding.payload.expiresAt,
          };
        }
        return { status: "rejected", bindingHash: params.binding.bindingHash, rejectedAt: "2026-09-17T00:00:10Z" };
      },
    },
    signer: { async sign() { signerCalls += 1; return {}; } },
    storage: {
      async loadPermissions() { return { revision: "0", permissions: [permission("tbc_accounts"), permission("tbc_sendTransaction")] }; },
      async commitPermissions(params) { return { revisions: params.changes.map((change) => ({ scope: change.scope, revision: "1" })) }; },
    },
    network: {
      defaultTestnet: {
        fetch: controlledFetch([]),
        now: () => Date.parse("2026-09-17T00:00:00Z"),
        snapshotId: async () => "snapshot-default-ft-host",
        broadcast: {
          async submit() { broadcasts += 1; return {}; },
          async reconcile() { return { transactions: [] }; },
        },
      },
    },
    engine,
    clock: () => "2026-09-17T00:00:10Z",
    randomBytes: () => Uint8Array.from({ length: 16 }, (_, index) => index),
  });
  const session = await runtime.openSession({ origin: "https://wallet.test", sessionId: "r1-default-ft" });
  let requestSequence = 0;
  const client = createTbcClient({ network: CHAIN_ID, provider: session.provider, requestIdFactory: () => `r1-default-ft-request-${++requestSequence}` });
  const wallet = await client.connect();
  const approvalsBeforeCreate = approvals;
  const createError = await wallet.ft.create({ name: "Kit Token", symbol: "KIT", decimals: 6, initialSupply: "1000000" })
    .then(() => undefined, (caught) => caught);
  assert.equal(createError?.code, 4200);
  assert.match(createError?.message, /Historical asset issuance is disabled: tbc\.ft\.create/u);
  assert.equal(plans, 0);
  assert.equal(approvals, approvalsBeforeCreate);
  const transferError = await wallet.ft.transfer({ contractId: fixture.ftContractId, to: ADDRESS, amount: "250000" })
    .then(() => undefined, (caught) => caught);
  if (planError !== undefined) throw planError;
  assert.equal(transferError?.code, 4001, "FT transfer approval rejection remains outside Kit custody");
  assert.equal(plans, 1);
  assert.equal(approvals, approvalsBeforeCreate + 1);
  assert.equal(signerCalls, 0);
  assert.equal(broadcasts, 0);
  session.close();
});

test("default historical Pool mint is denied before planning, approval, custody or broadcast", async () => {
  const backend = await createWasmTbcEngineBackend(await readFile(new URL("../artifacts/wasm/tbc_engine_wasm.wasm", import.meta.url)));
  const actual = createTbcEngine({ backend });
  let plans = 0;
  let planError;
  const engine = Object.freeze({
    normalizeRequest: actual.normalizeRequest,
    async plan(params) {
      plans += 1;
      try { return await actual.plan(params); }
      catch (error) { planError = error; throw error; }
    },
    validate: actual.validate,
    finalize: actual.finalize,
  });
  let signerCalls = 0;
  let broadcasts = 0;
  let transactionApprovals = 0;
  const origin = "https://pool-create.test";
  const permission = (capability) => ({
    id: `pool-${capability}`,
    parentCapability: capability,
    invoker: origin,
    date: Date.parse("2026-09-17T00:00:00Z"),
    caveats: [
      { type: "restrictChains", value: [CHAIN_ID] },
      { type: "restrictAccounts", value: [ACCOUNT.accountId] },
      { type: "restrictMethods", value: [capability] },
    ],
  });
  const runtime = createTbcWallet({
    accounts: { current: async () => [ACCOUNT] },
    approval: {
      async request(params) {
        if (params.binding.payload.operationKind === "permission") return {
          status: "approved",
          approvalId: "pool-permission",
          approvalToken: "pool-token",
          bindingHash: params.binding.bindingHash,
          approvedAt: "2026-09-17T00:00:10Z",
          expiresAt: params.binding.payload.expiresAt,
        };
        transactionApprovals += 1;
        return { status: "rejected", bindingHash: params.binding.bindingHash, rejectedAt: "2026-09-17T00:00:10Z" };
      },
    },
    signer: { async sign() { signerCalls += 1; return {}; } },
    storage: {
      async loadPermissions() { return { revision: "0", permissions: [permission("tbc_accounts"), permission("tbc_sendTransaction")] }; },
      async commitPermissions(params) { return { revisions: params.changes.map((change) => ({ scope: change.scope, revision: "1" })) }; },
    },
    network: {
      defaultTestnet: {
        fetch: controlledFetch([]),
        now: () => Date.parse("2026-09-17T00:00:00Z"),
        snapshotId: async () => "snapshot-default-pool-create",
        broadcast: {
          async submit() { broadcasts += 1; return {}; },
          async reconcile() { return { transactions: [] }; },
        },
      },
    },
    engine,
    clock: () => "2026-09-17T00:00:10Z",
    randomBytes: () => Uint8Array.from({ length: 16 }, (_, index) => index),
  });
  const session = await runtime.openSession({ origin, sessionId: "default-pool-create" });
  const client = createTbcClient({ network: CHAIN_ID, provider: session.provider, requestIdFactory: () => "default-pool-create-request" });
  const wallet = await client.connect();
  const error = await wallet.pool.create({
    stage: "mint",
    ftContractId: fixture.ftContractId,
    lpPlan: 2,
    serviceProviderTag: "durian",
  }).then(() => undefined, (caught) => caught);
  if (planError !== undefined) throw planError;
  assert.equal(error?.code, 4200);
  assert.match(error?.message, /Historical asset issuance is disabled: tbc\.pool\.create/u);
  assert.equal(plans, 0);
  assert.equal(transactionApprovals, 0);
  assert.equal(signerCalls, 0);
  assert.equal(broadcasts, 0);
  session.close();
});
