import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { registerHooks } from "node:module";
import { build } from "esbuild";

// Exercise current source without generating or replacing delivery artifacts.
const result = await build({
  stdin: {
    contents: [
      'export { createTbcClient } from "./client.ts";',
      'export { preparedChainDataRequirement } from "./prepared-chain-data.ts";',
      'export { prepareTbcTransaction, prepareTbcWorkflow } from "./prepared.ts";',
      'export { projectTbcApprovalPresentation, projectTbcApprovalPreparation } from "./approval-presentation.ts";',
      'export { hashCanonical } from "@tbc-wallet/core";',
    ].join("\n"),
    resolveDir: fileURLToPath(new URL("../src/", import.meta.url)),
    loader: "ts",
  },
  bundle: true, write: false, platform: "node", format: "esm", target: "es2022",
  alias: { "@tbc-wallet/core": fileURLToPath(new URL("../../core/src/index.ts", import.meta.url)) },
});
const virtualUrl = new URL("../src/.tbc20-focused-test.mjs", import.meta.url).href;
const hooks = registerHooks({
  resolve(specifier, context, next) {
    return specifier === virtualUrl ? { url: virtualUrl, shortCircuit: true } : next(specifier, context);
  },
  load(url, context, next) {
    return url === virtualUrl ? { source: result.outputFiles[0].text, format: "module", shortCircuit: true } : next(url, context);
  },
});
const { createTbcClient, preparedChainDataRequirement, prepareTbcTransaction, prepareTbcWorkflow,
  projectTbcApprovalPresentation, projectTbcApprovalPreparation, hashCanonical } = await import(virtualUrl);
hooks.deregister();
const FROM = "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH";
const ID = "11".repeat(32);
const TEMPLATE = "0f5db33bb46e4517963cbd383518f74283b5c2c4efb0a733522a1fbc0d4a9f84";
const request = (intent) => ({ version: "1.0", chainId: "tbc:testnet", from: FROM, intent });
const create = { type: "tbc20-standard-create", version: "1.0", name: "Token", symbol: "TOK", decimals: 2, initialSupply: "12345" };
const transfer = { type: "tbc20-standard-transfer", version: "1.0", contractId: ID, to: FROM, amount: "123" };
const merge = { type: "tbc20-standard-merge", version: "1.0", contractId: ID };

test("Prepared single/workflow preserves sanitized Port failure before planning, without retry", async () => {
  for (const workflow of [false, true]) for (const stage of ["chain-data", "policy"]) {
    const counts = { reads: 0, policies: 0, plans: 0 };
    const failure = { portError: { name: "UNAVAILABLE", retryable: true, message: "private upstream detail", details: { secret: "do not expose" } } };
    const options = {
      request: workflow ? { version: "1.0", chainId: "tbc:testnet", from: FROM,
        steps: [{ id: "send", kind: "transaction", dependsOn: [], intent: transfer }] } : request(transfer),
      network: {
        async resolveChainData() { counts.reads++; return stage === "chain-data" ? failure : { payload: {}, snapshotHash: hashCanonical({}) }; },
        async resolvePolicy() { counts.policies++; return failure; },
      },
      engine: {
        normalizeRequest({ request }) { return { request, requestHash: hashCanonical(request) }; },
        plan() { counts.plans++; throw new Error("Must not plan after a Port failure"); },
      },
    };
    await assert.rejects((workflow ? prepareTbcWorkflow : prepareTbcTransaction)(options), error => {
      assert.equal(error.code, "UNAVAILABLE", `${workflow}/${stage}: ${error.message}`); assert.equal(error.retryable, true); assert.equal(error.stage, stage);
      assert.match(error.message, /preparation/); assert.doesNotMatch(error.message, /private|do not expose|JCS/);
      assert.equal(error.cause, undefined); assert.equal(error.details, undefined); return true;
    });
    assert.deepEqual(counts, { reads: 1, policies: stage === "policy" ? 1 : 0, plans: 0 });
  }
});

test("Prepared rejects malformed failures and still rejects snapshot/policy hash tampering", async () => {
  const badFailures = [null, {}, { name: "SECRET upstream", retryable: true }, { name: "UNAVAILABLE", retryable: "true" }];
  for (const stage of ["chain-data", "policy"]) for (const value of [
    ...badFailures.map(portError => ({ portError })), { payload: { changed: true }, snapshotHash: hashCanonical({}), policyHash: hashCanonical({}) },
  ]) {
    let plans = 0;
    await assert.rejects(prepareTbcTransaction({ request: request(transfer), network: {
      resolveChainData: async () => stage === "chain-data" ? value : { payload: {}, snapshotHash: hashCanonical({}) },
      resolvePolicy: async () => value,
    }, engine: {
      normalizeRequest: ({ request }) => ({ request, requestHash: hashCanonical(request) }),
      plan: () => { plans++; throw new Error("Must not plan invalid material"); },
    } }), error => {
      assert.match(error.message, /Invalid TBC preparation|hash mismatch/);
      assert.doesNotMatch(error.message, /SECRET/); return true;
    });
    assert.equal(plans, 0);
  }
});

test("new named helpers use existing send/sign channels without changing old FT intents", async () => {
  const calls = [];
  const provider = { async request(call) {
    calls.push(call);
    return call.method === "tbc_requestAccounts" ? [FROM] : {};
  }, on() {}, removeListener() {}, destroy() {} };
  const wallet = await createTbcClient({ network: "testnet", provider }).connect();
  await wallet.createTbc20({ name: "Token", symbol: "TOK", decimals: 2, initialSupply: "12345", to: FROM, constraints: { maxFee: "500" } });
  await wallet.transferTbc20({ contractId: ID, to: FROM, amount: "123" });
  await wallet.mergeTbc20({ contractId: ID });
  await wallet.walletBuild.sign({ intent: transfer });
  await wallet.ft.create({ name: "Old", symbol: "OLD", decimals: 2, initialSupply: "1" });
  await wallet.ft.transfer({ contractId: ID, to: FROM, amount: "1" });
  await wallet.maintenance.mergeFt({ contractId: ID });
  assert.deepEqual(calls.slice(1).map((c) => c.params.intent.type), [create.type, transfer.type, merge.type, transfer.type, "tbc.ft.create", "tbc.ft.transfer", "tbc.ft.merge"]);
  assert.equal(calls[1].params.constraints.maxFee, "500");
  assert.ok(calls.slice(1).every((c, i) => c.method === (i === 3 ? "tbc_signTransaction" : "tbc_sendTransaction")));
});

test("Prepared new requirements retain exact specified inputs and minimal asset dependencies", () => {
  const inputOutpoints = [{ txid: ID, vout: 0 }];
  for (const intent of [create, transfer, merge]) {
    const requirement = preparedChainDataRequirement({ ...request(intent), constraints: { inputOutpoints } });
    assert.deepEqual(requirement.inputOutpoints, inputOutpoints);
    assert.notEqual(requirement.inputOutpoints, inputOutpoints);
    assert.equal(requirement.includeAncestry, intent !== create);
    assert.equal(requirement.assets[0].kind, "native");
    assert.equal(requirement.assets.length, intent === create ? 1 : 2);
    if (intent !== create) assert.equal(requirement.assets[1].contractId, ID);
  }
  assert.equal(preparedChainDataRequirement(request(transfer)).assets[1].minimumAmount, "123");
  assert.equal(preparedChainDataRequirement(request(merge)).assets[1].minimumAmount, undefined);
});

test("AMM role selection stays at the request boundary for named, wallet-built and Prepared helpers", async () => {
  const calls = [];
  const provider = { async request(call) { calls.push(call); return call.method === "tbc_requestAccounts" ? [FROM] : {}; },
    on() {}, removeListener() {}, destroy() {} };
  const wallet = await createTbcClient({ network: "testnet", provider }).connect();
  const signingRoles = [{ role: "pool-controller", accountId: "tbc:testnet:1cMh228HTCiwS8ZsaakH8A8wze1JR5ZsP" }];
  const intent = { type: "tbc-amm-swap", version: "1.0", poolContractId: ID, direction: "tbc-to-ft", amount: "100", minimumOutput: "0" };
  await wallet.amm.swap({ poolContractId: ID, direction: "tbc-to-ft", amount: "100", minimumOutput: "0", signingRoles });
  await wallet.amm.addLiquidity({ poolContractId: ID, budgetAsset: "ft", amount: "100", minimumLpAmount: "0", signingRoles });
  await wallet.amm.removeLiquidity({ poolContractId: ID, lpAmount: "100", minimumTbcAmount: "0", minimumFtAmount: "0", signingRoles });
  await wallet.walletBuild.sign({ intent, signingRoles });
  await wallet.walletBuild.send({ intent, signingRoles });
  // Shape-only provider: real proposal validation is covered by the Rust Host gate.
  await wallet.wallet.signProposal({ intent, signingRoles, proposal: {} });
  await wallet.wallet.sendProposal({ intent, signingRoles, proposal: {} });
  assert.deepEqual(calls.slice(1).map(c => c.method), ["tbc_sendTransaction", "tbc_sendTransaction", "tbc_sendTransaction",
    "tbc_signTransaction", "tbc_sendTransaction", "tbc_signPreparedTransaction", "tbc_sendPreparedTransaction"]);
  for (const { params } of calls.slice(1)) {
    assert.deepEqual(params.signingRoles, signingRoles);
    assert.equal(params.intent.signingRoles, undefined);
  }
});

async function prepare(contract) {
  const raw = ["0a000000", "01", "22".repeat(32), "00000000", "00", "ffffffff", "01", "2a00000000000000", "01", "51", "00000000"].join("");
  const capturedAt = "2026-09-28T00:00:00Z";
  const snapshotPayload = { capturedAt, parents: [], contracts: [contract] };
  const policyPayload = {};
  const planPayload = { expiresAt: "2026-09-28T00:05:00Z", transactions: [{ id: "tbc20", role: transfer.type, dependsOn: [], unsignedTransaction: raw, fee: "1" }], preview: { totalFee: "1" } };
  return prepareTbcTransaction({
    request: request(transfer),
    network: {
      async resolveChainData() { return { payload: snapshotPayload, snapshotHash: hashCanonical(snapshotPayload) }; },
      async resolvePolicy() { return { payload: policyPayload, policyHash: hashCanonical(policyPayload) }; },
    },
    engine: {
      normalizeRequest({ request }) { return { request, requestHash: hashCanonical(request) }; },
      plan() { return { plan: { payload: planPayload, planHash: hashCanonical(planPayload) } }; },
      validate() { return { valid: true }; },
    },
  });
}

test("Prepared workflow preserves per-step controller selection with one material read per transaction", async () => {
  // Shape-only Engine: this proves Kit routing, not AMM construction or signing.
  const roles = ["1cMh228HTCiwS8ZsaakH8A8wze1JR5ZsP", "1CUNEBjYrCn2y1SdiUMohaKUi4wpP326Lb"]
    .map(address => [{ role: "pool-controller", accountId: `tbc:testnet:${address}` }]);
  const steps = roles.map((signingRoles, index) => ({ id: `swap-${index}`, kind: "transaction", dependsOn: [], signingRoles,
    intent: { type: "tbc-amm-swap", version: "1.0", poolContractId: String(index + 1).repeat(64),
      direction: "tbc-to-ft", amount: "100", minimumOutput: "0" } }));
  steps.push({ id: "message", kind: "message", dependsOn: [], message: { encoding: "utf8", data: "Owner only" } });
  const reads = [], plans = [];
  const prepared = await prepareTbcWorkflow({
    request: { version: "1.0", chainId: "tbc:testnet", from: FROM, steps },
    network: {
      async resolveChainData(params) {
        reads.push(params);
        const payload = { capturedAt: "2026-09-28T00:00:00Z", parents: [], contracts: [] };
        return { payload, snapshotHash: hashCanonical(payload) };
      },
      async resolvePolicy() { return { payload: {}, policyHash: hashCanonical({}) }; },
    },
    engine: {
      normalizeRequest({ request }) { return { request, requestHash: hashCanonical(request) }; },
      plan({ request }) {
        plans.push(request);
        const raw = ["0a000000", "01", String(plans.length + 2).repeat(64), "00000000", "00", "ffffffff",
          "01", "2a00000000000000", "01", "51", "00000000"].join("");
        const payload = { expiresAt: "2026-09-28T00:05:00Z", transactions: [{ id: "swap", role: request.intent.type,
          dependsOn: [], unsignedTransaction: raw, fee: "1" }], preview: { totalFee: "1" } };
        return { plan: { payload, planHash: hashCanonical(payload) } };
      },
      validate() { return { valid: true }; },
    },
  });
  assert.equal(reads.length, 2);
  assert.equal(plans.length, 2);
  for (let i = 0; i < 2; i++) {
    assert.deepEqual(reads[i].signingRoles, roles[i]);
    assert.deepEqual(plans[i].signingRoles, roles[i]);
    assert.deepEqual(prepared.steps[i].signingRoles, roles[i]);
    assert.equal(prepared.steps[i].kind, "preparedTransaction");
    assert.equal(prepared.steps[i].intent.signingRoles, undefined);
    assert.ok(Object.isFrozen(prepared.steps[i].signingRoles));
  }
  assert.deepEqual(prepared.steps[2], steps[2]);
  assert.equal(prepared.signingRoles, undefined);
  for (const [method, value] of [["tbc_signWorkflow", { version: "1.0", chainId: "tbc:testnet", from: FROM, steps }],
    ["tbc_signPreparedWorkflow", prepared]]) {
    const presentation = projectTbcApprovalPreparation({ method, operationKind: "workflow", request: value,
      requestHash: hashCanonical(value), warningScope: [], expiresAt: Date.parse("2026-09-28T00:05:00Z") });
    assert.deepEqual(presentation.signingRoles, { status: "known", source: "preparation-scope",
      value: roles.map((role, index) => ({ ...role[0], stepId: `swap-${index}` })) });
    assert.equal(presentation.trust, "intent-bounded");
    assert.equal(presentation.binding.status, "not-created");
    assert.equal(presentation.counts.signingTasks.status, "unknown");
  }
});

test("Prepared evidence retains complete new identity but not old version labels", async () => {
  const base = { contractId: ID, family: "ft", creationTxid: ID };
  const binding = { standardId: "tbc20-standard", protocolVersion: "tbc20", templateRevision: TEMPLATE, genesisOutpoint: { txid: ID, vout: 0 } };
  const prepared = await prepare({ ...base, ...binding });
  assert.deepEqual(prepared.proposal.payload.evidence.contracts[0], { contractId: ID, family: "ft", sourceTransactionId: ID, ...binding });
  assert.ok(Object.isFrozen(prepared.proposal.payload.evidence.contracts[0].genesisOutpoint));
  const old = await prepare({ ...base, protocolVersion: "4.0" });
  assert.deepEqual(old.proposal.payload.evidence.contracts[0], { contractId: ID, family: "ft", sourceTransactionId: ID });
  await assert.rejects(prepare({ ...base, ...binding, templateRevision: "00".repeat(32) }));
  await assert.rejects(prepare({ ...base, standardId: "tbc20-standard" }));
});

test("new creation review renders token precision without relabeling native fees", () => {
  const transaction = request(create);
  const requestHash = hashCanonical(transaction);
  const preview = { operationKind: "transaction", assetFlows: [
    { kind: "ft", direction: "create", amount: "12345", from: FROM, to: FROM },
    { kind: "native", direction: "fee", amount: "80", from: FROM },
  ], totalFee: "80", transactionCount: 2, warnings: [], irreversible: false };
  const payload = { requestHash, preview, transactions: [{ id: "source" }, { id: "genesis" }], signingTasks: [] };
  const planHash = hashCanonical(payload);
  const bindingPayload = { version: "1.0", method: "tbc_signTransaction", operationKind: "transaction", contextHash: "22".repeat(32), origin: "https://wallet.example", sessionId: "tbc20-test", chainId: "tbc:testnet", accountId: `tbc:testnet:${FROM}`, requestHash, operationHash: planHash, expiresAt: "2026-09-28T00:05:00Z" };
  const binding = { payload: bindingPayload, bindingHash: hashCanonical(bindingPayload) };
  const params = { version: "1.0", binding, requester: { transport: "remote", origin: "https://wallet.example", topOrigin: "https://wallet.example", frame: "top" }, preview };
  const model = projectTbcApprovalPresentation({
    callId: "call", operationId: "operation", releaseFingerprint: "08".repeat(32), params,
    call: { callId: "call", operation: "approval.request", params },
    payload: { operationId: "operation", operation: { method: "tbc_signTransaction", params: transaction } },
    memory: { requestHash, approvalBinding: binding, approvalPreview: preview, normalizedTransaction: { request: transaction, requestHash }, executionPlan: { payload, planHash } },
  });
  assert.equal(model.assets[0].symbol.value, "TOK");
  assert.equal(model.assets[0].amount.display.value, "123.45");
  assert.equal(model.assets[1].amount.precision.status, "unknown");
});
