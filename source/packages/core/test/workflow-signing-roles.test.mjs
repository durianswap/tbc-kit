import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as tws from "../dist/esm/index.js";

const integration = JSON.parse(readFileSync(new URL("../../../test-vectors/integration.json", import.meta.url)));
const provider = JSON.parse(readFileSync(new URL("../../../test-vectors/provider.json", import.meta.url)));
const baseGrant = JSON.parse(readFileSync(new URL("../../../test-vectors/permissions.json", import.meta.url))).result[0];
const owner = integration.canonicalTransfer.snapshot.payload.account;
const controller = { chainId: owner.chainId, address: "1cMh228HTCiwS8ZsaakH8A8wze1JR5ZsP",
  accountId: `${owner.chainId}:1cMh228HTCiwS8ZsaakH8A8wze1JR5ZsP`,
  publicKey: "02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5" };
const second = { chainId: owner.chainId, address: "1CUNEBjYrCn2y1SdiUMohaKUi4wpP326Lb",
  accountId: `${owner.chainId}:1CUNEBjYrCn2y1SdiUMohaKUi4wpP326Lb`,
  publicKey: "02f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9" };
const accounts = [owner, controller, second];
function fixtureTransactions(index) {
  return integration.canonicalTransfer.plan.payload.transactions.map(transaction => ({ ...transaction,
    id: `${transaction.id}-${index}`,
    unsignedTransaction: `${transaction.unsignedTransaction.slice(0, 10)}${String(index + 3).repeat(64)}${transaction.unsignedTransaction.slice(74)}`,
  }));
}
function request(method = "tbc_signWorkflow") {
  const steps = [controller, second].map((account, i) => ({ id: `swap-${i}`, kind: "transaction", dependsOn: [],
    signingRoles: [{ role: "pool-controller", accountId: account.accountId }],
    intent: { type: "tbc-amm-swap", version: "1.0", poolContractId: String(i + 1).repeat(64), direction: "tbc-to-ft", amount: "10000", minimumOutput: "0" } }));
  if (method.includes("Prepared")) for (const step of steps) {
    step.kind = "preparedTransaction";
    const canonical = integration.canonicalTransfer;
    const payload = { version: "1.0", engineProfile: "tbc-engine-plan-v1", createdAt: canonical.snapshot.payload.capturedAt,
      expiresAt: canonical.plan.payload.expiresAt, intentHash: tws.hashCanonical(step.intent),
      transactions: fixtureTransactions(steps.indexOf(step)).map(t => ({ id: t.id, role: t.role, dependsOn: t.dependsOn,
        kind: "fixed", unsignedTransaction: t.unsignedTransaction, fee: t.fee })),
      evidence: { observedAt: canonical.snapshot.payload.capturedAt, parentTransactions: canonical.snapshot.payload.parents, contracts: [] },
      estimatedTotalFee: canonical.plan.payload.preview.totalFee };
    step.proposal = { payload, proposalHash: tws.hashCanonical(payload) };
  }
  steps.push({ id: "message", kind: "message", dependsOn: [], message: { encoding: "utf8", data: "Primary only" } });
  return { version: "1.0", chainId: owner.chainId, from: owner.address, steps };
}

test("workflow roles are per AMM transaction step, never inherited by other kinds", () => {
  for (const method of ["tbc_signWorkflow", "tbc_signPreparedWorkflow"]) {
    const value = request(method), schema = method.includes("Prepared") ? "preparedWorkflowRequest" : "workflowRequest";
    tws.assertValidTws(schema, value);
    for (const mutate of [v => { v.signingRoles = v.steps[0].signingRoles; },
      v => { v.steps[2].signingRoles = v.steps[0].signingRoles; },
      v => { v.steps[0].intent = integration.canonicalTransfer.request.intent; },
      v => { v.steps[0].signingRoles.push(v.steps[0].signingRoles[0]); }]) {
      const changed = structuredClone(value); mutate(changed); assert.throws(() => tws.assertValidTws(schema, changed));
    }
  }
});

test("one lookup set preserves different controllers and deduplicates repeated or primary roles", () => {
  const value = request();
  assert.deepEqual(tws.workflowSigningAccountIds(value), accounts.map(a => a.accountId));
  const resolved = tws.resolveWorkflowSigningAccounts(value, accounts);
  assert.deepEqual(resolved.steps.map(s => [s.stepId, s.roles[0].account.accountId]), [["swap-0", controller.accountId], ["swap-1", second.accountId]]);
  assert.deepEqual(resolved.additional.map(a => a.accountId), [controller.accountId, second.accountId]);
  value.steps[1].signingRoles = value.steps[0].signingRoles;
  assert.deepEqual(tws.workflowSigningAccountIds(value), [owner.accountId, controller.accountId]);
  value.steps[0].signingRoles = value.steps[1].signingRoles = [{ role: "pool-controller", accountId: owner.accountId }];
  assert.deepEqual(tws.resolveWorkflowSigningAccounts(value, accounts).additional, []);
});

test("missing, duplicate, cross-chain and cross-step key aliases cannot resolve", () => {
  for (const identities of [[owner, controller], [...accounts, controller],
    [owner, controller, { ...second, publicKey: controller.publicKey }],
    [owner, controller, { ...second, accountId: second.accountId, address: owner.address }]]) {
    assert.throws(() => tws.resolveWorkflowSigningAccounts(request(), identities));
  }
  const value = request(); value.steps[0].signingRoles[0].accountId = `${owner.chainId === "tbc:testnet" ? "tbc:mainnet" : "tbc:testnet"}:${controller.address}`;
  assert.throws(() => tws.workflowSigningAccountIds(value));
});

async function drive(method, options = {}) {
  const value = request(method), ports = [];
  if (options.singleOwner) {
    value.steps[0].intent = structuredClone(integration.canonicalTransfer.request.intent);
    for (const step of value.steps) delete step.signingRoles;
  }
  const context = provider.trustedContexts[0].context;
  const session = structuredClone(provider.providerSessions.sessionA);
  session.state.activeAccountIds = (options.active ?? accounts).map(a => a.accountId).sort();
  const permissions = ["tbc_accounts", "tbc_signWorkflow", "tbc_signTransaction", "tbc_sendTransaction", "tbc_signMessage"].map(capability => ({
    ...baseGrant, id: `workflow-roles-${capability}`, parentCapability: capability,
    caveats: baseGrant.caveats.map(c => c.type === "restrictMethods" ? { ...c, value: [capability] } :
      c.type === "restrictAccounts" ? { ...c, value: (capability === "tbc_signMessage" || capability === options.primaryOnly ? [owner] : accounts).map(a => a.accountId) } : c),
  }));
  // Controlled plan fixture proves Core authority/review, not AMM construction.
  const core = tws.createTwsCore({ transactionEngine: {
    normalizeRequest({ request }) { return { request, requestHash: tws.hashCanonical(request) }; },
    plan({ request, requestHash, snapshot, policy }) {
      const index = request.intent.poolContractId === undefined ? 0 : Number(request.intent.poolContractId[0]) - 1;
      const plan = structuredClone(integration.canonicalTransfer.plan);
      Object.assign(plan.payload, { requestHash, snapshotHash: snapshot.snapshotHash, policyHash: policy.policyHash,
        transactions: fixtureTransactions(index) });
      if (!options.singleOwner) plan.payload.preview.signingRoles = [{ role: "pool-controller", account: accounts[index + 1] }];
      const signer = options.singleOwner ? owner : accounts[index + 1];
      for (const task of plan.payload.signingTasks) Object.assign(task, {
        taskId: `${task.taskId}-${index}`, transactionTemplateId: `${task.transactionTemplateId}-${index}`,
        accountId: signer.accountId, publicKey: signer.publicKey,
      });
      options.plan?.(plan, index);
      plan.planHash = tws.hashCanonical(plan.payload);
      return { plan };
    },
    validate() { return { valid: true, violations: [] }; },
    finalize() { throw new Error("Authority fixture must reject approval before signing"); },
  } });
  let state = await core.start({ version: "1.0", release: tws.TWS_RELEASE,
    request: { jsonrpc: "2.0", id: "role-workflow", method, params: value }, currentContext: context, currentSession: session });
  for (let n = 0; state.kind !== "complete"; n++) {
    assert.ok(n < 24);
    const input = { version: "1.0", checkpoint: state.checkpoint, currentContext: context, currentSession: session };
    if (state.kind === "waiting") {
      const call = state.calls[0]; ports.push(call);
      assert.ok(["clock.now", "permissionStore.load", "accounts.resolve", "chainData.resolve", "policy.resolve", "approval.request"].includes(call.operation));
      let material;
      if (call.operation === "chainData.resolve") {
        material = { version: "1.0", steps: call.params.workflowSteps.map(step => {
          const payload = structuredClone(integration.canonicalTransfer.snapshot.payload);
          if (step.signingAccounts !== undefined) payload.signingAccounts = step.signingAccounts;
          return { stepId: step.stepId, snapshot: { payload, snapshotHash: tws.hashCanonical(payload) } };
        }) };
        options.material?.(material);
      }
      input.response = { version: "1.0", callId: call.callId, result: call.operation === "clock.now" ? { now: "2026-08-31T12:00:00Z" }
        : call.operation === "permissionStore.load" ? { revision: "0", permissions }
        : call.operation === "chainData.resolve" ? material
        : call.operation === "policy.resolve" ? structuredClone(integration.canonicalTransfer.policy)
        : call.operation === "approval.request" ? { status: "rejected", bindingHash: call.params.binding.bindingHash, rejectedAt: "2026-08-31T12:00:00Z" }
        : { accounts: options.resolved ?? accounts } };
    }
    state = await core.resume(input);
  }
  return { state, ports };
}

test("all four workflow methods resolve roles once without giving controllers message authority", async () => {
  for (const method of ["tbc_signWorkflow", "tbc_sendWorkflow", "tbc_signPreparedWorkflow", "tbc_sendPreparedWorkflow"]) {
    const { state, ports } = await drive(method);
    assert.equal(state.completion.response.error.code, 4001);
    const approvals = ports.filter(p => p.operation === "approval.request");
    assert.equal(approvals.length, 1);
    assert.deepEqual(approvals[0].params.preview.signingRoles.map(r => [r.stepId, r.account.accountId]),
      [["swap-0", controller.accountId], ["swap-1", second.accountId]]);
    const resolutions = ports.filter(p => p.operation === "accounts.resolve");
    assert.equal(resolutions.length, 1);
    assert.deepEqual(resolutions[0].params.accountIds, accounts.map(a => a.accountId));
    const material = ports.filter(p => p.operation === "chainData.resolve");
    assert.equal(material.length, 1);
    assert.deepEqual(material[0].params.workflowSteps.map(s => [s.stepId, s.signingAccounts.map(a => a.accountId)]),
      [["swap-0", [controller.accountId]], ["swap-1", [second.accountId]]]);
    assert.equal(material[0].params.signingAccounts, undefined);
  }
});

test("missing controller grants or active session membership reject before account/material resolution", async () => {
  for (const options of [{ primaryOnly: "tbc_signTransaction" }, { primaryOnly: "tbc_signWorkflow" }, { active: [owner, controller] }]) {
    const { state, ports } = await drive("tbc_signWorkflow", options);
    assert.equal(state.completion.response.error.code, 4100);
    assert.equal(ports.some(p => p.operation === "accounts.resolve"), false);
  }
});

test("role workflow validates the raw account response before any material request", async () => {
  await assert.rejects(drive("tbc_signWorkflow", { resolved: [...accounts, controller] }), error => error.code === "ENGINE_ARTIFACT_MISMATCH");
});

test("workflow material cannot cross-bind steps, add accounts or replace their identities", async () => {
  for (const material of [value => value.steps.reverse(), value => value.steps.pop(), value => {
    const payload = value.steps[0].snapshot.payload;
    payload.signingAccounts = [second];
    value.steps[0].snapshot.snapshotHash = tws.hashCanonical(payload);
  }, value => { value.steps[0].snapshot.payload.block.height = "1"; }]) {
    await assert.rejects(drive("tbc_signWorkflow", { material }), error => error.code === "ENGINE_ARTIFACT_MISMATCH");
  }
});

test("a child Engine cannot borrow another step's controller or omit its review role", async () => {
  for (const plan of [p => { p.payload.signingTasks[0].accountId = second.accountId; p.payload.signingTasks[0].publicKey = second.publicKey; },
    p => { delete p.payload.preview.signingRoles; }]) {
    await assert.rejects(drive("tbc_signWorkflow", { plan }), error => error.code === "ENGINE_ARTIFACT_MISMATCH");
  }
});

test("the aggregate approval cannot outlive the earliest role-scoped material", async () => {
  const expiry = "2026-08-31T12:00:30Z";
  const { ports } = await drive("tbc_signWorkflow", { material(value) {
    value.steps[1].snapshot.payload.expiresAt = expiry;
    value.steps[1].snapshot.snapshotHash = tws.hashCanonical(value.steps[1].snapshot.payload);
  } });
  assert.equal(ports.find(p => p.operation === "approval.request").params.binding.payload.expiresAt, expiry);
});

test("different businesses under one account keep per-step material and reject cross-binding before approval", async () => {
  const result = await drive("tbc_signWorkflow", { singleOwner: true });
  assert.equal(result.state.completion.response.error.code, 4001);
  const material = result.ports.filter(p => p.operation === "chainData.resolve");
  assert.equal(material.length, 1);
  assert.deepEqual(material[0].params.workflowSteps.map(s => s.requirement.intentType), ["tbc.transfer", "tbc-amm-swap"]);
  assert.ok(material[0].params.workflowSteps.every(s => s.signingAccounts === undefined && s.signingRoles === undefined));
  assert.equal(result.ports.filter(p => p.operation === "approval.request").length, 1);
  for (const material of [v => v.steps.reverse(), v => v.steps.pop(), v => {
    v.steps[0].snapshot.payload.account = controller;
    v.steps[0].snapshot.snapshotHash = tws.hashCanonical(v.steps[0].snapshot.payload);
  }, v => { v.steps[0].snapshot.payload.block.height = "1"; }]) {
    await assert.rejects(drive("tbc_signWorkflow", { singleOwner: true, material }), e => e.code === "ENGINE_ARTIFACT_MISMATCH");
  }
});
