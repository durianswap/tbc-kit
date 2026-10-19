import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";

const built = await build({ stdin: { contents: 'export * from "./src/index.ts"; export { TWS_RELEASE } from "./src/release.ts";', resolveDir: new URL("../", import.meta.url).pathname },
  bundle: true, write: false, format: "cjs", platform: "node", external: ["@noble/hashes/*"] });
const module = { exports: {} };
new Function("module", "exports", "require", built.outputFiles[0].text)(module, module.exports, createRequire(import.meta.url));
const tws = module.exports;
const integration = JSON.parse(readFileSync(new URL("../../../test-vectors/integration.json", import.meta.url)));
const provider = JSON.parse(readFileSync(new URL("../../../test-vectors/provider.json", import.meta.url)));
const context = provider.trustedContexts[0].context, session = provider.providerSessions.sessionA;
const chainId = integration.canonicalTransfer.request.chainId;
const request = { ...integration.canonicalTransfer.request,
  intent: { type: "tbc-amm-swap", version: "1.0", poolContractId: "11".repeat(32), direction: "tbc-to-ft", amount: "10000", minimumOutput: "0" },
  signingRoles: [{ role: "pool-controller", accountId: `${chainId}:1cMh228HTCiwS8ZsaakH8A8wze1JR5ZsP` }],
};

test("explicit role wire is narrow and does not silently extend old transaction methods", () => {
  tws.assertValidTws("transactionRequest", request);
  for (const roles of [[], [...request.signingRoles, ...request.signingRoles], [{ ...request.signingRoles[0], role: "admin" }],
    [{ ...request.signingRoles[0], privateKey: "not-permitted" }]])
    assert.throws(() => tws.assertValidTws("transactionRequest", { ...request, signingRoles: roles }));
  assert.throws(() => tws.assertValidTws("transactionRequest", { ...integration.canonicalTransfer.request, signingRoles: request.signingRoles }));
});

test("public wallet rejects explicit roles without permission before account/material/approval/signing", async () => {
  for (const method of ["tbc_signTransaction", "tbc_sendTransaction"]) {
    let engineCalls = 0;
    const unexpected = () => { engineCalls++; throw new Error("Engine must not run before role authorization"); };
    const core = tws.createTwsCore({ transactionEngine: { normalizeRequest: unexpected, plan: unexpected, validate: unexpected, finalize: unexpected } });
    let transition = await core.start({ version: "1.0", release: tws.TWS_RELEASE,
      request: { jsonrpc: "2.0", id: `roles-${method}`, method, params: request }, currentContext: context, currentSession: session });
    const ports = [];
    for (let steps = 0; transition.kind !== "complete"; steps++) {
      assert.ok(steps < 10);
      const resume = { version: "1.0", checkpoint: transition.checkpoint, currentContext: context, currentSession: session };
      if (transition.kind === "waiting") {
        const call = transition.calls[0]; ports.push(call.operation);
        assert.ok(["clock.now", "permissionStore.load"].includes(call.operation));
        resume.response = { version: "1.0", callId: call.callId, result: call.operation === "clock.now"
          ? { now: "2026-08-31T12:00:00Z" } : { revision: "0", permissions: [] } };
      }
      transition = await core.resume(resume);
    }
    assert.equal(transition.completion.response.error.code, 4100);
    assert.match(transition.completion.response.error.message, /not authorized/u);
    assert.equal(engineCalls, 0); assert.ok(ports.includes("permissionStore.load"));
  }
});

const owner = integration.canonicalTransfer.snapshot.payload.account;
const controller = { chainId, accountId: request.signingRoles[0].accountId,
  address: "1cMh228HTCiwS8ZsaakH8A8wze1JR5ZsP",
  publicKey: "02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5" };
const identities = [owner, controller];
const permissionBase = JSON.parse(readFileSync(new URL("../../../test-vectors/permissions.json", import.meta.url))).result[0];

// Synthetic authority tests do not claim that these mock plans are AMM transactions.
async function authorizedRun(options = {}) {
  const selectedRequest = options.request ?? request;
  const calls = [], engineCalls = [];
  const permissions = ["tbc_accounts", "tbc_signTransaction"].map(capability => ({
    ...permissionBase, id: `roles-${capability}`, parentCapability: capability,
    caveats: permissionBase.caveats.map(caveat => caveat.type === "restrictMethods"
      ? { ...caveat, value: [capability] } : caveat.type === "restrictAccounts"
        ? { ...caveat, value: options.permissionIds ?? identities.map(a => a.accountId) } : caveat),
  }));
  const activeSession = { ...session, state: { ...session.state,
    activeAccountIds: options.sessionIds ?? identities.map(a => a.accountId) } };
  const engine = {
    normalizeRequest({ request: input }) {
      engineCalls.push("normalizeRequest"); const normalized = structuredClone(input);
      options.normalize?.(normalized);
      return { request: normalized, requestHash: tws.hashCanonical(normalized) };
    },
    plan({ request: input, snapshot, policy }) {
      engineCalls.push("plan");
      const payload = structuredClone(integration.canonicalTransfer.plan.payload);
      Object.assign(payload, { requestHash: tws.hashCanonical(input), snapshotHash: snapshot.snapshotHash,
        policyHash: policy.policyHash });
      payload.preview.signingRoles = [{ role: selectedRequest.signingRoles[0].role, account: controller }];
      options.plan?.(payload);
      return { plan: { payload, planHash: tws.hashCanonical(payload) } };
    },
    validate() { engineCalls.push("validate"); return { valid: true, violations: [] }; },
    finalize() { throw new Error("Synthetic authority test must not sign"); },
  };
  const core = tws.createTwsCore({ transactionEngine: engine });
  let transition = await core.start({ version: "1.0", release: tws.TWS_RELEASE,
    request: { jsonrpc: "2.0", id: "roles-authorized", method: "tbc_signTransaction", params: selectedRequest },
    currentContext: context, currentSession: activeSession });
  for (let steps = 0; transition.kind !== "complete"; steps++) {
    assert.ok(steps < 20);
    const resume = { version: "1.0", checkpoint: transition.checkpoint, currentContext: context, currentSession: activeSession };
    if (transition.kind === "waiting") {
      const call = transition.calls[0]; calls.push(call);
      let result;
      switch (call.operation) {
        case "clock.now": result = { now: "2026-08-31T12:00:00Z" }; break;
        case "permissionStore.load": result = { revision: "0", permissions }; break;
        case "accounts.resolve": result = { accounts: options.accounts ?? identities }; break;
        case "chainData.resolve": {
          const payload = { ...structuredClone(integration.canonicalTransfer.snapshot.payload), signingAccounts: [controller] };
          options.snapshot?.(payload);
          result = { payload, snapshotHash: tws.hashCanonical(payload) }; break;
        }
        case "policy.resolve": result = integration.canonicalTransfer.policy; break;
        case "approval.request": result = { status: "rejected", bindingHash: call.params.binding.bindingHash,
          rejectedAt: "2026-08-31T12:00:00Z" }; break;
        default: throw new Error(`Unexpected side effect ${call.operation}`);
      }
      resume.response = { version: "1.0", callId: call.callId, result };
    }
    transition = await core.resume(resume);
  }
  return { completion: transition.completion, calls, engineCalls };
}

test("both role accounts need grants and active-session membership before normalization", async () => {
  for (const options of [{ permissionIds: [owner.accountId] }, { permissionIds: [controller.accountId] },
    { sessionIds: [owner.accountId] }]) {
    const result = await authorizedRun(options);
    assert.equal(result.completion.response.error.code, 4100);
    assert.deepEqual(result.engineCalls, []);
    assert.ok(result.calls.every(call => ["clock.now", "permissionStore.load"].includes(call.operation)));
  }
});

test("one trusted account resolution carries both identities to Chain Data and planning", async () => {
  const result = await authorizedRun();
  assert.equal(result.completion.response.error.code, 4001); // Synthetic reviewer deliberately rejects.
  assert.equal(result.calls.filter(call => call.operation === "approval.request").length, 1);
  const accountCalls = result.calls.filter(call => call.operation === "accounts.resolve");
  assert.equal(accountCalls.length, 1);
  assert.deepEqual(accountCalls[0].params.accountIds, identities.map(a => a.accountId));
  const dataCalls = result.calls.filter(call => call.operation === "chainData.resolve");
  assert.equal(dataCalls.length, 1);
  assert.deepEqual(dataCalls[0].params.signingAccounts, [controller]);
  assert.deepEqual(dataCalls[0].params.signingRoles, request.signingRoles);
  assert.deepEqual(result.engineCalls, ["normalizeRequest", "plan", "validate"]);
});

test("normalization cannot substitute another authorized account or remove the controller role", async () => {
  for (const normalize of [r => { r.from = controller.address; }, r => { delete r.signingRoles; }]) {
    await assert.rejects(() => authorizedRun({ normalize }), /authorized chain or account/u);
  }
});

test("trusted resolution and Chain Data cannot duplicate, omit or replace role identities", async () => {
  for (const accounts of [[owner], [owner, controller, controller], [owner, { ...controller, publicKey: owner.publicKey }]]) {
    await assert.rejects(() => authorizedRun({ accounts }), /missing or ambiguous|ambiguous across/u);
  }
  for (const snapshot of [p => { delete p.signingAccounts; }, p => { p.signingAccounts[0] = owner; },
    p => { p.account = controller; }, p => { p.signingAccounts[0] = { ...controller, publicKey: owner.publicKey }; }]) {
    await assert.rejects(() => authorizedRun({ snapshot }), /trusted signing accounts/u);
  }
});

test("plan review and initial tasks cannot change roles independently of their trusted accounts", async () => {
  for (const plan of [p => { p.preview.signingRoles[0].account = owner; },
    p => { p.signingTasks[0].publicKey = controller.publicKey; }]) {
    await assert.rejects(() => authorizedRun({ plan }), /trusted signing roles|authorized role account/u);
  }
});

test("local role binding handles same-account controller without additional material or task ambiguity", () => {
  const same = { ...request, signingRoles: [{ role: "pool-controller", accountId: owner.accountId }] };
  assert.deepEqual(tws.transactionSigningAccountIds(same), [owner.accountId]);
  const resolved = tws.resolveTransactionSigningAccounts(same, identities);
  assert.deepEqual(resolved.additional, []);
  tws.assertTransactionSigningSnapshot(same, identities, { chainId, account: owner });
  assert.throws(() => tws.assertTransactionSigningSnapshot(same, identities, { chainId, account: owner, signingAccounts: [] }), /trusted signing accounts/u);
  tws.assertTransactionRoleTasks(request, identities, [{ accountId: controller.accountId, publicKey: controller.publicKey.slice(2) }]);
  assert.throws(() => tws.assertTransactionRoleTasks(request, identities,
    [{ accountId: owner.accountId, publicKey: controller.publicKey }]), /authorized role account/u);
});

test("Coin admin reuses per-account grants, one resolution and exact task/preview binding", async () => {
  const coin = { ...request, intent: { type: "tbc20-stablecoin-create", version: "1.0", name: "Coin", symbol: "C", decimals: 0, initialSupply: "10" },
    signingRoles: [{ role: "coin-admin", accountId: controller.accountId }] };
  const result = await authorizedRun({ request: coin });
  assert.equal(result.completion.response.error.code, 4001);
  assert.equal(result.calls.filter(c => c.operation === "approval.request").length, 1);
  assert.equal(result.calls.filter(c => c.operation === "accounts.resolve").length, 1);
  const data = result.calls.filter(c => c.operation === "chainData.resolve");
  assert.equal(data.length, 1);
  assert.deepEqual(data[0].params.signingRoles, coin.signingRoles);
  assert.deepEqual(data[0].params.signingAccounts, [controller]);
  for (const options of [{ permissionIds: [owner.accountId] }, { sessionIds: [owner.accountId] }]) {
    const denied = await authorizedRun({ request: coin, ...options });
    assert.equal(denied.completion.response.error.code, 4100);
    assert.deepEqual(denied.engineCalls, []);
  }
  for (const options of [{ snapshot: p => { p.signingAccounts = [owner]; } },
    { plan: p => { p.preview.signingRoles[0].role = "pool-controller"; } },
    { plan: p => { p.signingTasks[0].publicKey = controller.publicKey; } }]) {
    await assert.rejects(() => authorizedRun({ request: coin, ...options }), /trusted signing accounts|trusted signing roles|authorized role account/u);
  }
});
