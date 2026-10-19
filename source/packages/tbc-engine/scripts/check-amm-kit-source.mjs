#!/usr/bin/env node
// Current-source Kit/Core/Host with real source WASM and synthetic, offline
// material from the public Rust tests. No endpoint or wallet keys are accessed.
// Default mode proves the shared execution seam. --default-*-loader also runs
// actual default material loading with intercepted synthetic HTTP, never a node.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { registerHooks } from "node:module";
import { build } from "esbuild";
import { secp256k1 } from "@noble/curves/secp256k1.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const rust = `${root}packages/tbc-engine/rust/`;
const NOW = new Date().toISOString().replace(/\.\d{3}Z$/u, "Z");
const expires = new Date(Date.parse(NOW) + 120000).toISOString().replace(/\.\d{3}Z$/u, "Z");
const ammBatch = process.argv.includes("--amm-batch");
const unifiedBusiness = process.argv.includes("--unified-business-loader") || process.argv.includes("--unified-controller");
const ammWorkflow = process.argv[2] === "--amm-workflow";
const ammController = ammWorkflow || process.argv.includes("--amm-controller") || process.argv.includes("--unified-controller");
const defaultBusiness = unifiedBusiness || ammController || ammBatch || process.argv.includes("--default-business-loader");
const lpBatch = process.argv.includes("--lp-batch");
const defaultAnchors = lpBatch || defaultBusiness || process.argv.includes("--default-anchor-loader");
if (ammWorkflow) assert.equal(process.argv.length, 5, "--amm-workflow requires fixed upstream and dependency directories");
else assert.deepEqual(process.argv.slice(2), unifiedBusiness ? [ammController ? "--unified-controller" : "--unified-business-loader"] : ammController ? ["--amm-controller"] : ammBatch ? ["--amm-batch"] : lpBatch ? ["--lp-batch"] : defaultBusiness ? ["--default-business-loader"] : defaultAnchors ? ["--default-anchor-loader"] : []);
const sourceBuild = spawnSync("cargo", ["build", "--offline", "--locked", "--release", "-p", "tbc-engine-wasm", "--target", "wasm32-unknown-unknown"], {
  cwd: rust, env: { ...process.env, RUSTFLAGS: '--cfg getrandom_backend="unsupported"' }, encoding: "utf8", timeout: 60000, maxBuffer: 8 * 1024 * 1024,
});
assert.equal(sourceBuild.status, 0, "Source WASM build failed; output withheld");
if (defaultAnchors) {
  const compiled = spawnSync("cargo", ["build", "--offline", "--locked", "--release", "-p", "tbc-keyless-wasm", "--target", "wasm32-unknown-unknown"], {
    cwd: rust, env: { ...process.env, RUSTFLAGS: '--cfg getrandom_backend="unsupported"' }, encoding: "utf8", timeout: 60000, maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(compiled.status, 0, "Keyless source WASM build failed; output withheld");
}
const materials = [];
for (const [target, selected, marker] of ammController ? [
  ["amm_public", "explicit_controller_amm_actions_and_continuation_match_sdk", "AMM"],
] : ammBatch ? [
  ["amm_public", "public_amm_fragmented_holders_share_bound_maintenance_and_business_signing", "AMM"],
] : lpBatch ? [
  ["amm_lp_batch", "public_lp_multiround_uses_shared_binding_and_continuations", "LP"],
] : [
  ["amm_public", "four_public_amm_creates_bind_funded_continuation_and_match_sdk", "AMM"],
  ["amm_public", "eight_public_amm_actions_match_sdk_raw_with_shared_account_and_binding", "AMM"],
  ["lp_public", "six_public_lp_flows_match_sdk_without_current_pool_read", "LP"],
  ["lp_public", "public_lp_lock_uses_same_signer_and_preserves_change_lock", "LP"],
]) {
  const run = spawnSync("cargo", ["test", "--offline", "--locked", "-p", "tbc-engine-core", "--test", target, selected, "--", "--exact", "--nocapture"], {
    cwd: rust, env: { ...process.env, [`${marker}_DUMP_WIRE`]: "1" }, encoding: "utf8", timeout: 60000, maxBuffer: 24 * 1024 * 1024,
  });
  assert.equal(run.status, 0, `Public ${target} fixture failed; output withheld`);
  for (const line of run.stdout.split("\n")) if (line.startsWith(`${marker}_WIRE:`)) {
    const row = JSON.parse(line.slice(marker.length + 6));
    if (row.definition === "planParams") materials.push(row.value);
  }
}
assert.equal(materials.length, ammController ? 9 : ammBatch ? 3 : lpBatch ? 4 : 19);
const bundle = await build({ stdin: { contents: `
  export { createTbcClient } from './packages/kit/src/client.ts';
  export { createTbcWallet } from './packages/kit/src/wallet-runtime.ts';
  export { createDefaultTbcNetwork } from './packages/kit/src/default-network.ts';
  export { createTbcNetworkContext } from './packages/kit/src/network-context.ts';
  export { prepareTbcTransaction, prepareTbcWorkflow } from './packages/kit/src/prepared.ts';
  export { preparedChainDataRequirement } from './packages/kit/src/prepared-chain-data.ts';
  export { createApprovalHostEvidenceReader } from './packages/kit/src/approval-host-evidence.ts';
  export { projectTbcApprovalPresentation, projectTbcApprovalPreparation } from './packages/kit/src/approval-presentation.ts';
  export { inspectTbcTransaction } from './packages/kit/src/testnet-validation.ts';
  export { createMemoryTwsHostStore } from './packages/host/src/index.ts';
  export { chainDataRequirement, hashCanonical, assertValidTws, createTwsCore } from './packages/core/src/index.ts';
  export { assertPreparedProposalForPlan, preparedProposalTransactions } from './packages/core/src/reducers/planning.ts';
  export { TWS_RELEASE_FINGERPRINT } from './packages/core/src/release.ts';
  export { createTbcEngine } from './packages/tbc-engine/src/facade.ts';
  export { createWasmTbcEngineBackend } from './packages/tbc-engine/src/wasm.ts';
  export { createWasmTbcKeylessEngine } from './packages/kit/src/keyless.ts';
`, resolveDir: root, loader: "ts" }, alias: {
  "@tbc-wallet/core": `${root}packages/core/src/index.ts`, "@tbc-wallet/host": `${root}packages/host/src/index.ts`,
  "@tbc-wallet/provider": `${root}packages/provider/src/index.ts`, "@tbc-wallet/provider/in-memory": `${root}packages/provider/src/in-memory.ts`,
}, bundle: true, write: false, format: "esm", platform: "node", target: "node22", logLevel: "silent" });
const virtual = new URL("../../../packages/kit/src/.amm-source-check.mjs", import.meta.url).href;
const hooks = registerHooks({
  resolve(s, c, next) { return s === virtual ? { url: virtual, shortCircuit: true } : next(s, c); },
  load(u, c, next) { return u === virtual ? { source: bundle.outputFiles[0].text, format: "module", shortCircuit: true } : next(u, c); },
});
const kit = await import(virtual); hooks.deregister();
const engine = kit.createTbcEngine({ backend: await kit.createWasmTbcEngineBackend(readFileSync(`${rust}target/wasm32-unknown-unknown/release/tbc_engine_wasm.wasm`)) });
const keyless = defaultAnchors ? await kit.createWasmTbcKeylessEngine(readFileSync(`${rust}target/wasm32-unknown-unknown/release/tbc_keyless_wasm.wasm`)) : undefined;
if (ammWorkflow) {
  const { checkMultiControllerWorkflow } = await import("./lib/amm-workflow-source.mjs");
  await checkMultiControllerWorkflow({ kit, engine, keyless, base: materials[0], upstream: process.argv[3], dependencies: process.argv[4] });
  process.exit(0);
}
if (defaultBusiness && !ammBatch) {
  for (const source of materials.filter(p => p.request.intent.type === "tbc-amm-swap" && p.request.intent.direction === "ft-to-tbc")) {
    const p = structuredClone(source), id = source.request.intent.poolContractId;
    const meta = JSON.parse(await keyless.execute("inspectAmmMaterial", JSON.stringify({ phase: "inspectPool", pool: source.snapshot.payload.parents.find(parent => parent.txid === id) })));
    p.request.intent = { type: "tbc-amm-add-liquidity", version: "1.0", poolContractId: id,
      budgetAsset: "ft", amount: "1000", minimumLpAmount: "0", ...(meta.lpTimelock ? { lockTime: "900000" } : {}) };
    materials.push(p);
  }
}
const types = [...new Set(materials.map(p => p.request.intent.type))];
const checks = [];
let loaderNegatives = 0;
let checkedTamper = false;
let roleNegatives = 0, checkedContinuation = false;
let preparedIsolationChecks = 0;
let workflowMaterialChecks = 0;
let workflowRoleChecks = 0;
const workflowRoleBudgets = [];
for (const material of materials) for (const prepared of [false, true]) {
  if (defaultAnchors && !defaultBusiness && material.request.intent.type !== "tbc-amm-create" && !material.request.intent.type.startsWith("tbc20-lp-")) continue;
  const request = structuredClone(material.request);
  if (unifiedBusiness) request.intent.type = ({ "tbc-amm-swap": "amm.swap", "tbc-amm-add-liquidity": "amm.addLiquidity",
    "tbc-amm-remove-liquidity": "amm.removeLiquidity", "tbc20-lp-transfer": "tbc20Lp.transfer", "tbc20-lp-lock": "tbc20Lp.lock",
    "tbc20-lp-unlock": "tbc20Lp.unlock", "tbc20-lp-merge": "tbc20Lp.merge" })[request.intent.type] ?? request.intent.type;
  request.constraints = { ...request.constraints, expiresAt: expires };
  const snapshot = structuredClone(material.snapshot);
  snapshot.payload.capturedAt = NOW; snapshot.payload.expiresAt = expires;
  snapshot.snapshotHash = kit.hashCanonical(snapshot.payload);
  const account = snapshot.payload.account;
  const signingAccounts = [account, ...(snapshot.payload.signingAccounts ?? [])];
  const testEarlyConsent = ammController && checks.length < 2;
  let earlyReviews = 0;
  let proposalIsolation, approvalFailure;
  let visibleAccounts = signingAccounts, currentAccountReads = 0;
  const currentAccounts = async () => { currentAccountReads++; return visibleAccounts; };
  const trace = [];
  const raws = new Map(snapshot.payload.parents.map(p => [p.txid, p.rawTransaction]));
  const lp = snapshot.payload.utxos.filter(u => u.classification === "ftlp");
  let lpRows = [], lpHash, earliestLpLock = 0n;
  if (defaultAnchors && lp.length) {
    const inspected = JSON.parse(await keyless.execute("inspectAmmMaterial", JSON.stringify({ phase: "inspectAssets",
      parents: [...new Set(lp.map(u => u.txid))].map(txid => ({ txid, rawTransaction: raws.get(txid) })),
      outputs: lp.map(u => ({ txid: u.txid, vout: u.vout, kind: "lp" })),
    })));
    lpRows = inspected.items.map(u => ({ txid: u.txid, index: u.vout, ft_value: u.balance, tbc_value: "500", height: 0, lock_time: 0 }));
    earliestLpLock = inspected.items.reduce((min, u) => BigInt(u.lockTime) < min ? BigInt(u.lockTime) : min, BigInt(inspected.items[0].lockTime));
    const { createHash } = await import("node:crypto");
    lpHash = createHash("sha256").update(Buffer.from(lp[0].scriptPubKey, "hex")).digest().reverse().toString("hex");
  }
  const poolUtxo = snapshot.payload.utxos.find(u => u.classification === "pool");
  let poolInfo, poolFtRows = [], holderFtRows = [], poolCombine, ownerCombine;
  if (defaultAnchors && poolUtxo) {
    const genesisId = request.intent.poolContractId;
    const raw = txid => ({ txid, rawTransaction: raws.get(txid) });
    const meta = JSON.parse(await keyless.execute("inspectAmmMaterial", JSON.stringify({ phase: "inspectPool", pool: raw(genesisId) })));
    const d = JSON.parse(await keyless.execute("inspectAmmMaterial", JSON.stringify({ phase: "describe", poolGenesis: raw(genesisId), ftGenesis: raw(meta.ftContractId), publicKey: account.publicKey, currentPool: raw(poolUtxo.txid) })));
    poolInfo = { txid: poolUtxo.txid, vout: 0, value: poolUtxo.satoshis, pool_code_script: d.poolCodeScript,
      ft_contract_id: d.ftContractId, lp_balance: d.state.lpAmount, token_balance: d.state.ftAmount,
      tbc_balance: d.state.tbcAmount, service_fee_rate: d.serviceFeeRate };
    poolCombine = d.poolCombineScript; ownerCombine = d.ownerCombineScript;
    for (const [classification, rows] of [["pool-ft", poolFtRows], ["ft", holderFtRows]]) {
      const assets = snapshot.payload.utxos.filter(u => u.classification === classification);
      if (!assets.length) continue;
      const parsed = JSON.parse(await keyless.execute("inspectAmmMaterial", JSON.stringify({ phase: "inspectAssets",
        parents: [...new Set(assets.map(u => u.txid))].map(raw), outputs: assets.map(u => ({ txid: u.txid, vout: u.vout, kind: "ft" })),
      })));
      rows.push(...parsed.items.map(u => ({ txid: u.txid, index: u.vout, tbc_value: "500", ft_value: u.balance, height: 0 })));
    }
    if (!ammBatch && !ammController) {
      // The sufficient-single fast path must not fetch irrelevant tiny holder
      // fragments. Their raw is deliberately absent from the synthetic server.
      const extras = Array.from({ length: 8 }, (_, i) => ({ txid: (i + 300).toString(16).padStart(64, "0"), index: 0, tbc_value: "500", ft_value: "1", height: 0 }));
      if (holderFtRows.length) holderFtRows.push(...extras);
      if (lpRows.length) lpRows.push(...extras);
    }
  }
  let approvedHttpCount, readFailure, fetchFailure, failTip = false;
  let delayedAncestor, releaseAncestor, ancestorStarted = false, ancestorReleased = false;
  const proofGate = defaultBusiness && !prepared && request.intent.direction === "ft-to-tbc"
    ? new Promise(resolve => { releaseAncestor = resolve; }) : undefined;
  if (proofGate) delayedAncestor = kit.inspectTbcTransaction(raws.get(poolUtxo.txid)).transaction.inputs[0].txid;
  const policyNetwork = kit.createDefaultTbcNetwork({
    network: kit.createTbcNetworkContext({ network: request.chainId === "tbc:mainnet" ? "mainnet" : "testnet" }),
    accounts: { current: currentAccounts },
    ...(defaultAnchors ? { poolNative: keyless } : {}),
    fetch: async (input, init) => {
      try {
      assert.equal(defaultAnchors, true, "Unexpected HTTP");
      // Concurrent correlation checks have independent operations; one may
      // finish review while the other is still preparing. The normal cases
      // above/below retain the strict per-operation zero-post-approval budget.
      if (proposalIsolation === undefined) assert.equal(approvedHttpCount, undefined, "HTTP after approval");
      assert.equal(init?.method ?? "GET", "GET");
      const url = new URL(String(input));
      assert.equal(url.origin, request.chainId === "tbc:mainnet" ? "https://api.turingbitchain.io" : "https://api.tbcdev.org");
      trace.push(url.pathname);
      let data;
      if (url.pathname === "/api/tbc/nodeinfo") {
        if (failTip) throw new Error("Synthetic tip unavailable");
        data = { blocks: snapshot.payload.block.height, bestblockhash: snapshot.payload.block.hash };
      }
      else if (url.pathname === `/api/tbc/utxo/address/${account.address}`) data = { utxos: [
        ...snapshot.payload.utxos.filter(u => u.classification === "native").map(u => ({ txid: u.txid, index: u.vout, value: u.satoshis, height: 0 })),
        ...(poolUtxo ? Array.from({ length: 16 }, (_, i) => ({ txid: (i + 100).toString(16).padStart(64, "0"), index: 0, value: "1", height: 0 })) : []),
      ] };
      else if (poolInfo && url.pathname === `/api/tbc/pool/poolinfo/poolid/${request.intent.poolContractId}`) data = poolInfo;
      else if (poolCombine && url.pathname === `/api/tbc/ft/utxo/combinescript/${poolCombine}/contract/${poolInfo.ft_contract_id}`) data = { utxos: poolFtRows };
      else if (ownerCombine && url.pathname === `/api/tbc/ft/utxo/combinescript/${ownerCombine}/contract/${poolInfo.ft_contract_id}`) {
        if (releaseAncestor) { assert.equal(ancestorStarted, true); ancestorReleased = true; releaseAncestor(); }
        data = { utxos: holderFtRows };
      }
      else if (lpHash && url.pathname === `/api/tbc/pool/lputxo/scriptpubkeyhash/${lpHash}`) data = {
        // Official LP REST names, not synthetic FT aliases. Exercise the same
        // normalization seam needed by real AMM remove and holder operations.
        utxos: lpRows.map(({ ft_value, tbc_value, ...row }) => ({ ...row, lp_balance: ft_value, tbc_balance: tbc_value })),
      };
      else if (url.pathname.startsWith("/api/tbc/txraw/txid/")) {
        const id = url.pathname.split("/").at(-1); assert.ok(raws.has(id), "Requested unrelated raw");
        if (id === delayedAncestor) { ancestorStarted = true; await proofGate; }
        data = { txraw: raws.get(id) };
      } else throw new Error("Unexpected material endpoint: " + url.pathname);
      return new Response(JSON.stringify({ code: "200", data }), { status: 200 });
      } catch (error) { fetchFailure = error.message; throw error; }
    },
    now: () => Date.parse(NOW), confirmationPolicy: { minConfirmations: "0" },
  });
  let approvals = 0, signatures = 0, reads = 0, dappReads = 0, lastPlan, lastSnapshot, engineFailure;
  let roleReviewAvailable = true, rejectApproval = false, tamperContinuation = false, controllerSignatures = 0;
  const requirement = kit.chainDataRequirement(request);
  assert.deepEqual(kit.preparedChainDataRequirement(request), requirement);
  const network = {
    ...policyNetwork,
    async resolveChainData(params) {
      if (proposalIsolation === undefined) assert.equal(approvals, 0, "Material read after approval"); reads++;
      assert.equal(params.accountId, account.accountId); assert.equal(params.chainId, account.chainId);
      assert.deepEqual(params.requirement, requirement);
      if (!defaultAnchors) return structuredClone(snapshot);
      const result = await policyNetwork.resolveChainData(params, account);
      lastSnapshot = result;
      if (!result.snapshotHash) readFailure = `${request.intent.type}: ${JSON.stringify(result)}; reads=${trace.join(",")}; fetch=${fetchFailure}`;
      assert.ok(result.snapshotHash, `${request.intent.type}: ${JSON.stringify(result)}; reads=${trace.join(",")}`);
      return result;
    },
    async broadcast() { throw new Error("Unexpected broadcast"); },
  };
  const params = prepared ? await kit.prepareTbcTransaction({ request, engine, network: {
    ...network, async resolveChainData(p) { dappReads++; assert.deepEqual(p.requirement, requirement); return defaultAnchors ? policyNetwork.resolveChainData(p, ammController ? undefined : account) : structuredClone(snapshot); },
  } }) : request;
  if (prepared) {
    for (const contract of params.proposal.payload.evidence.contracts) {
      const source = snapshot.payload.contracts.find(c => c.contractId === contract.contractId);
      assert.equal(contract.templateRevision, source.templateRevision);
      assert.equal(contract.standardId, source.standardId);
    }
  }
  const store = kit.createMemoryTwsHostStore({ now: () => Date.parse(NOW) });
  const evidence = kit.createApprovalHostEvidenceReader({ store, releaseFingerprint: kit.TWS_RELEASE_FINGERPRINT,
    parseApprovalRequest(value) { kit.assertValidTws("approvalRequestParams", value); return value; } });
  const permissions = ["tbc_accounts", "tbc_signTransaction"].map(capability => ({ id: `amm-${capability}`, parentCapability: capability,
    invoker: "https://wallet.test", date: Date.parse(NOW), caveats: [
      { type: "restrictChains", value: [account.chainId] }, { type: "restrictAccounts", value: signingAccounts.map(a => a.accountId) }, { type: "restrictMethods", value: [capability] },
    ] }));
  const trackedEngine = Object.fromEntries(["normalizeRequest", "plan", "validate", "finalize"].map(method => [method, async input => {
    try {
      const result = await engine[method](input); if (method === "plan") lastPlan = result.plan;
      if (tamperContinuation && method === "finalize" && result.status === "pending") {
        const wrong = structuredClone(result);
        wrong.signingRequests[0].accountId = signingAccounts.find(a => a.accountId !== wrong.signingRequests[0].accountId).accountId;
        return wrong;
      }
      if (result.valid === false) engineFailure = `${method}:${JSON.stringify(result.violations)}`;
      return result;
    } catch (error) { engineFailure = `${method}:${error.code ?? error.name}`; throw error; }
  }]));
  const runtime = kit.createTbcWallet({ legacy: false, accounts: { current: currentAccounts }, engine: trackedEngine,
    capabilities: { version: "1.0", scopes: [{ chainId: account.chainId, intents: ["tbc.transfer", ...types], profiles: ["core"] }] },
    ...(testEarlyConsent ? { approvalPreparation: {
      begin() {},
      async review(input) {
        earlyReviews++;
        const model = kit.projectTbcApprovalPreparation(input);
        assert.deepEqual(model.signingRoles.value, request.signingRoles);
        assert.equal(model.trust, "intent-bounded");
        if (prepared) assert.ok(input.expiresAt <= Date.parse(input.request.proposal.payload.expiresAt), "Early consent outlived the proposal");
        if (proposalIsolation !== undefined) {
          const expected = proposalIsolation.get(input.requestHash);
          assert.ok(expected, "Early review must retain the full proposal hash");
          expected.preparationId = input.preparationId;
          return { status: expected.status, feeCapAtomic: input.suggestedFeeCapAtomic ?? "1000000" };
        }
        return rejectApproval ? { status: "rejected" } : { status: "approved", feeCapAtomic: input.suggestedFeeCapAtomic ?? "1000000" };
      },
    } } : {}),
    approval: { get supportedSigningRoles() { return ammController && roleReviewAvailable ? ["pool-controller"] : []; }, async request(input, call) {
      try {
      if (defaultAnchors) approvedHttpCount = trace.length;
      approvals++;
      if (proposalIsolation === undefined) assert.equal(input.binding.payload.operationHash, lastPlan.planHash);
      if (testEarlyConsent && proposalIsolation === undefined) assert.equal(call.approvalPreparation?.earlyConsent?.status, rejectApproval ? "rejected" : "approved");
      const bound = await evidence.read(call.callId, input.binding.bindingHash);
      if (prepared) assert.ok(Date.parse(input.binding.payload.expiresAt) <= Date.parse(bound.payload.operation.params.proposal.payload.expiresAt), "Formal approval outlived the proposal");
      const model = kit.projectTbcApprovalPresentation(bound);
      assert.equal(model.trust, "binding-verified"); assert.equal(model.businessType.value, request.intent.type);
      if (request.intent.type.startsWith('amm.') || request.intent.type.startsWith('tbc20Lp.')) {
        assert.equal(model.contractExecution.status, 'known');
        assert.equal(model.contractExecution.value.businessType, request.intent.type);
        assert.equal(model.contractExecution.value.generation, 'current');
        assert.ok(/^(tbc-amm-|tbc20-lp-)/u.test(model.contractExecution.value.implementation));
        const early=kit.projectTbcApprovalPreparation({method:prepared?'tbc_signPreparedTransaction':'tbc_signTransaction',
          operationKind:'transaction',request:params,requestHash:kit.hashCanonical(params),warningScope:[],expiresAt:Date.parse(expires)});
        assert.equal(early.contractExecution.status,'unknown','Early consent cannot assert an unverified template');
      }
      assert.equal(kit.hashCanonical(model.businessTerms.value), kit.hashCanonical(request.intent));
      if (ammController) {
        assert.equal(model.signingRoles.status, "known");
        assert.deepEqual(model.signingRoles.value, request.signingRoles);
        const early = kit.projectTbcApprovalPreparation({ method: prepared ? "tbc_signPreparedTransaction" : "tbc_signTransaction",
          operationKind: "transaction", request: params, requestHash: kit.hashCanonical(params), warningScope: [], expiresAt: Date.parse(expires) });
        assert.equal(early.trust, "intent-bounded"); assert.deepEqual(early.signingRoles.value, request.signingRoles);
      } else assert.equal(model.signingRoles, undefined);
      if (proposalIsolation !== undefined) {
        const expected = proposalIsolation.get(kit.hashCanonical(bound.payload.operation.params));
        assert.ok(expected);
        assert.equal(call.approvalPreparation?.earlyConsent?.status, expected.status);
        assert.equal(call.approvalPreparation?.preparationId, expected.preparationId);
        // Isolate approval correlation without signing another transaction.
        return { status: "rejected", bindingHash: input.binding.bindingHash, rejectedAt: NOW };
      }
      if (rejectApproval) return { status: "rejected", bindingHash: input.binding.bindingHash, rejectedAt: NOW };
      return { status: "approved", approvalId: "amm", approvalToken: "amm-token", bindingHash: input.binding.bindingHash, approvedAt: NOW, expiresAt: input.binding.payload.expiresAt };
      } catch (error) { approvalFailure = error.message; throw error; }
    } },
    signer: { async sign(input) {
      assert.equal(approvals, 1); signatures++;
      const signerIndex = signingAccounts.findIndex(a => a.accountId === input.task.accountId && a.publicKey === input.task.publicKey);
      assert.ok(signerIndex === 0 || (ammController && signerIndex === 1), "Signer task is not owned by a selected account");
      if (signerIndex === 1) controllerSignatures++;
      assert.equal(input.task.signatureEncoding, "compact64");
      // Public scalar 1/2 are invented fixture accounts, never wallet secrets.
      const scalar = (signerIndex + 1).toString(16).padStart(64, "0");
      assert.equal(Buffer.from(secp256k1.getPublicKey(scalar, true)).toString("hex"), input.task.publicKey);
      return { taskId: input.task.taskId, signatureEncoding: "compact64", signature: secp256k1.sign(input.task.digest, scalar, { prehash: false, lowS: true }).toCompactHex() };
    } },
    storage: { async loadPermissions() { return { revision: "0", permissions }; }, async commitPermissions() { throw new Error("Unexpected grant mutation"); } },
    network, clock: () => NOW, randomBytes: length => Uint8Array.from({ length }, (_, i) => i),
  });
  let ids = 0;
  const session = await runtime.openSession({ origin: "https://wallet.test", sessionId: `amm-${checks.length}`,
    requestIdFactory: () => `amm-${++ids}`, execution: { hostStore: store } });
  try {
    let result;
    if (prepared) result = await session.provider.request({ method: "tbc_signPreparedTransaction", params });
    else {
      const exact = { id: `prefetch-${++ids}`, method: "tbc_signTransaction", params };
      const preparation = session.prefetchRequest(exact);
      assert.equal(await preparation.ready, "ready", readFailure ?? JSON.stringify(await preparation.diagnostic));
      assert.equal(approvals + signatures, 0);
      const response = (await session.handleRequest(exact)).response;
      assert.equal(response.error, undefined, JSON.stringify(response.error)); result = response.result;
    }
    assert.equal(approvals, 1); assert.equal(reads, 1); assert.equal(dappReads, prepared ? 1 : 0);
    if (testEarlyConsent) assert.equal(earlyReviews, 1);
    const holderCount = snapshot.payload.utxos.filter(u => u.classification === "ft" || u.classification === "ftlp").length;
    assert.ok(signatures > 0); assert.equal(result.transactions.length, ammBatch || (ammController && holderCount > 1) ? Math.max(1, Math.ceil((holderCount - 1) / 4)) + 1 : lpBatch ? Math.floor((lp.length - 2) / 4) + 1 : request.intent.type === "tbc-amm-create" ? 2 : 1);
    for (const tx of result.transactions) assert.equal(kit.inspectTbcTransaction(tx.rawTransaction).txid, tx.txid);
    if (defaultAnchors) {
      assert.equal(trace.length, approvedHttpCount);
      const rawReads = trace.filter(p => p.startsWith("/api/tbc/txraw/txid/"));
      assert.equal(rawReads.length, new Set(rawReads).size, "Immutable raw was fetched twice");
      assert.deepEqual(new Set(rawReads.map(p => p.split("/").at(-1))), new Set(raws.keys()), "Minimum ancestor set changed");
      assert.equal(trace.filter(p => p === "/api/tbc/nodeinfo").length, prepared ? 2 : 1);
      assert.equal(trace.filter(p => p.includes("/pool/lputxo/")).length, lp.length ? prepared ? 2 : 1 : 0);
      const mutableReads = poolUtxo ? (request.intent.direction === "tbc-to-ft" ? 4 : 5) : lp.length ? 3 : 2;
      assert.equal(trace.length, rawReads.length + mutableReads * (prepared ? 2 : 1));
      if (proofGate) assert.equal(ancestorReleased, true, "Historical proof blocked the asset indexes");
    }
    checks.push(`${request.intent.type}/${prepared ? "prepared" : "ordinary"}:snapshotReads=1,approval=1,signatures=${signatures},accountReads=${currentAccountReads}${defaultAnchors ? `,GET=${trace.length}` : ""}`);
    if (ammController) assert.equal(controllerSignatures, 1, "Controller is requested only for the final business transaction");
    if (testEarlyConsent && prepared) {
      const second = structuredClone(params);
      second.proposal.payload.expiresAt = new Date(Date.parse(second.proposal.payload.expiresAt) - 1000).toISOString().replace(/\.\d{3}Z$/u, "Z");
      second.proposal.proposalHash = kit.hashCanonical(second.proposal.payload);
      const { proposal: _first, ...firstIntent } = params;
      const { proposal: _second, ...secondIntent } = second;
      assert.equal(kit.hashCanonical(firstIntent), kit.hashCanonical(secondIntent));
      proposalIsolation = new Map([[kit.hashCanonical(params), { status: "approved" }], [kit.hashCanonical(second), { status: "rejected" }]]);
      assert.equal(proposalIsolation.size, 2);
      approvals = 0; signatures = 0; approvedHttpCount = undefined;
      const reviewsBefore = earlyReviews;
      const results = await Promise.allSettled([params, second].map(params =>
        session.handleRequest({ id: `proposal-isolation-${++ids}`, method: "tbc_signPreparedTransaction", params })));
      for (const result of results) {
        assert.equal(result.status, "fulfilled", result.reason?.message);
        assert.equal(result.value.response.error?.code, 4001, approvalFailure ?? result.value.response.error?.message);
      }
      assert.equal(approvals, 2); assert.equal(signatures, 0); assert.equal(earlyReviews - reviewsBefore, 2);
      assert.equal(new Set([...proposalIsolation.values()].map(v => v.preparationId)).size, 2);
      proposalIsolation = undefined; approvals = 0; approvedHttpCount = undefined;
      preparedIsolationChecks++;
    }
    if (ammController && !prepared && roleNegatives === 0) {
      approvedHttpCount = undefined; approvals = 0; signatures = 0; controllerSignatures = 0;
      roleReviewAvailable = false;
      const previousEarlyReviews = earlyReviews;
      await assert.rejects(session.provider.request({ method: "tbc_signTransaction", params }));
      assert.equal(approvals + signatures, 0, "Unaware UI must never approve or sign"); roleNegatives++;
      assert.equal(earlyReviews, previousEarlyReviews, "Unaware early reviewer must not be invoked");
      roleReviewAvailable = true;
      rejectApproval = true;
      await assert.rejects(session.provider.request({ method: "tbc_signTransaction", params }), e => e.code === 4001);
      assert.equal(approvals, 1); assert.equal(signatures, 0); roleNegatives++;
      rejectApproval = false; approvedHttpCount = undefined; approvals = 0;
      for (const changed of [[account], [account, { ...signingAccounts[1], publicKey: account.publicKey }]]) {
        visibleAccounts = changed;
        const before = trace.length;
        const handle = session.prefetchRequest({ id: `changed-role-${++ids}`, method: "tbc_signTransaction", params });
        assert.notEqual(await handle.ready, "ready");
        assert.equal(trace.length, before, "Changed role must fail before remote preparation");
        assert.equal(approvals + signatures, 0); handle.cancel(); roleNegatives++;
      }
      visibleAccounts = signingAccounts;
    }
    if (ammController && !prepared && holderCount > 1 && !checkedContinuation) {
      const completeSignatures = signatures;
      approvals = 0; signatures = 0; controllerSignatures = 0; approvedHttpCount = undefined;
      tamperContinuation = true;
      await assert.rejects(session.provider.request({ method: "tbc_signTransaction", params }));
      assert.equal(approvals, 1); assert.ok(signatures > 0 && signatures < completeSignatures);
      assert.equal(controllerSignatures, 0, "Changed deferred task must not reach the controller Signer");
      tamperContinuation = false; checkedContinuation = true; roleNegatives++;
    }
    if (prepared && !checkedTamper && params.proposal.payload.evidence.contracts.some(c => c.standardId === "tbc-amm")) {
      const bad = structuredClone(params);
      const contract = bad.proposal.payload.evidence.contracts.find(c => c.standardId === "tbc-amm");
      contract.templateRevision = contract.templateRevision.startsWith("c98e")
        ? "cf7f95c0483b56ad24825591acbce6e82e37890aa0047fc63183d3fb7a7a4ffc"
        : "c98ecae0a22452ce37bcaf24be0c836521d3de3a75aa8f16cef587b8b6f031b2";
      bad.proposal.proposalHash = kit.hashCanonical(bad.proposal.payload);
      approvals = 0; signatures = 0;
      approvedHttpCount = undefined;
      await assert.rejects(session.provider.request({ method: "tbc_signPreparedTransaction", params: bad }));
      assert.equal(approvals + signatures, 0, "Rehashed Pool template reached approval or signer");
      checkedTamper = true;
    }
  } catch (error) {
    if (prepared && lastPlan) {
      try { kit.assertPreparedProposalForPlan(params, lastSnapshot, lastPlan); }
      catch (check) {
        let changed;
        try { changed = kit.preparedProposalTransactions(lastPlan.payload.transactions).map((tx, i) => Object.keys(tx).filter(k => kit.hashCanonical(tx[k]) !== kit.hashCanonical(params.proposal.payload.transactions[i]?.[k] ?? null))); }
        catch { changed = "dependency parsing"; }
        const proposalParents = params.proposal.payload.evidence.parentTransactions;
        const actualParents = lastSnapshot?.payload.parents.map(({ txid, rawTransaction }) => ({ txid, rawTransaction }));
        const sortedHash = rows => kit.hashCanonical([...rows].sort((a, b) => a.txid.localeCompare(b.txid)));
        engineFailure = `preparedCheck:${check.message}; changedTransactionFields=${JSON.stringify(changed)}; parentOrderEqual=${kit.hashCanonical(proposalParents) === kit.hashCanonical(actualParents ?? [])}; parentSetEqual=${sortedHash(proposalParents) === sortedHash(actualParents ?? [])}`;
      }
    }
    throw new Error(`${request.intent.type}/${prepared ? "prepared" : "ordinary"}: ${error.message}; approvals=${approvals},signatures=${signatures},reads=${reads},engine=${engineFailure ?? "none"}`, { cause: error });
  } finally { await session.close(); }
  if (ammController && !prepared && workflowMaterialChecks === 0) {
    approvedHttpCount = undefined;
    const parameters = { version: "1.0", chainId: account.chainId, accountId: account.accountId, requirement,
      workflowSteps: ["pool-a", "pool-b"].map(stepId => ({ stepId, requirement,
        signingRoles: request.signingRoles, signingAccounts: snapshot.payload.signingAccounts })) };
    // Repeated material scopes deliberately share inputs. This tests loading,
    // not two executable spends; Core planning must still reject double spends.
    const before = trace.length, accountReads = currentAccountReads;
    const loaded = await policyNetwork.resolveChainData(parameters, account);
    assert.ok(loaded.steps, JSON.stringify(loaded));
    assert.deepEqual(loaded.steps.map(s => s.stepId), ["pool-a", "pool-b"]);
    for (const step of loaded.steps) {
      assert.equal(step.snapshot.snapshotHash, kit.hashCanonical(step.snapshot.payload));
      assert.deepEqual(step.snapshot.payload.signingAccounts, snapshot.payload.signingAccounts);
    }
    assert.equal(currentAccountReads, accountReads, "Bound workflow must not resolve accounts again");
    const observed = trace.slice(before);
    assert.equal(observed.filter(p => p === "/api/tbc/nodeinfo").length, 1);
    assert.equal(observed.filter(p => p.includes("/utxo/address/")).length, 1);
    assert.equal(observed.filter(p => p.includes("/poolinfo/")).length, 1);
    assert.equal(new Set(observed).size, observed.length, "Workflow material repeated a shared GET");
    const afterMaterial = trace.length;
    const normalized = await engine.normalizeRequest({ version: "1.0", request });
    for (const step of loaded.steps) {
      const policy = await policyNetwork.resolvePolicy({ version: "1.0", request: normalized.request,
        requestHash: normalized.requestHash, snapshotHash: step.snapshot.snapshotHash });
      const inputs = { version: "1.0", request: normalized.request, requestHash: normalized.requestHash,
        snapshot: step.snapshot, policy };
      const planned = await engine.plan(inputs);
      assert.equal(planned.plan.payload.snapshotHash, step.snapshot.snapshotHash);
      assert.equal((await engine.validate({ ...inputs, phase: "plan", plan: planned.plan })).valid, true);
    }
    assert.equal(trace.length, afterMaterial, "Planning from scoped snapshots must not add HTTP");
    const invalid = structuredClone(parameters);
    invalid.workflowSteps[1].signingAccounts[0].publicKey = account.publicKey;
    const end = trace.length;
    assert.ok((await policyNetwork.resolveChainData(invalid, account)).portError);
    assert.equal(trace.length, end, "Conflicting controller identity reached HTTP");
    const repeated = structuredClone(parameters);
    repeated.workflowSteps[1].stepId = repeated.workflowSteps[0].stepId;
    assert.ok((await policyNetwork.resolveChainData(repeated, account)).portError);
    assert.equal(trace.length, end, "Duplicate step identity reached HTTP");
    const again = await policyNetwork.resolveChainData(parameters, account);
    assert.ok(again.steps);
    assert.equal(trace.slice(end).filter(p => p.includes("/utxo/address/")).length, 1,
      "A later workflow must refresh spend state instead of retaining the previous read scope");
    workflowMaterialChecks++;
  }
  if (ammController && !prepared && (workflowRoleChecks === 0 || (workflowRoleChecks === 2 && snapshot.payload.utxos.filter(u => u.classification === "ft").length > 1))) {
    for (const preparedWorkflow of [false, true]) {
      approvedHttpCount = undefined;
      const workflowHttpStart = trace.length;
      const workflow = { version: "1.0", chainId: account.chainId, from: account.address, expiresAt: expires, steps: [
        { id: "trade", kind: "transaction", dependsOn: [], intent: request.intent, constraints: request.constraints, signingRoles: request.signingRoles },
        { id: "message", kind: "message", dependsOn: ["trade"], message: { encoding: "utf8", data: "Owner only" } },
      ] };
      const wfParams = preparedWorkflow ? await kit.prepareTbcWorkflow({ request: workflow, network: policyNetwork, engine }) : workflow;
      const wfStore = kit.createMemoryTwsHostStore({ now: () => Date.parse(NOW) });
      const wfEvidence = kit.createApprovalHostEvidenceReader({ store: wfStore, releaseFingerprint: kit.TWS_RELEASE_FINGERPRINT,
        parseApprovalRequest(value) { kit.assertValidTws("approvalRequestParams", value); return value; } });
      let wfApprovals = 0, wfSignatures = 0, wfController = 0, wfReads = 0;
      const wfPermissions = ["tbc_accounts", "tbc_signWorkflow", "tbc_signTransaction", "tbc_signMessage"].map(capability => ({
        id: `workflow-${capability}`, parentCapability: capability, invoker: "https://wallet.test", date: Date.parse(NOW), caveats: [
          { type: "restrictChains", value: [account.chainId] },
          { type: "restrictAccounts", value: (capability === "tbc_signMessage" ? [account] : signingAccounts).map(a => a.accountId) },
          { type: "restrictMethods", value: [capability] },
        ],
      }));
      const wfRuntime = kit.createTbcWallet({ legacy: false, accounts: { current: currentAccounts }, engine,
        network: { ...policyNetwork, async resolveChainData(params, call, bound) {
          wfReads++; return policyNetwork.resolveChainData(params, call, bound);
        } },
        storage: { async loadPermissions() { return { revision: "0", permissions: wfPermissions }; }, async commitPermissions() { throw new Error("Unexpected permission write"); } },
        approval: { supportedSigningRoles: ["pool-controller"], async request(input, call) {
          wfApprovals++; approvedHttpCount = trace.length;
          const model = kit.projectTbcApprovalPresentation(await wfEvidence.read(call.callId, input.binding.bindingHash));
          assert.equal(model.operationKind, "workflow");
          if (request.intent.type.startsWith('amm.')) {
            const trade=model.steps.find(step=>step.id==='trade');
            assert.equal(trade.contractExecution.value.businessType,request.intent.type);
            assert.equal(trade.contractExecution.value.generation,'current');
          }
          assert.deepEqual(model.signingRoles.value, request.signingRoles.map(role => ({ ...role, stepId: "trade" })));
          return { status: "approved", approvalId: "role-workflow", approvalToken: "fixture", bindingHash: input.binding.bindingHash,
            approvedAt: NOW, expiresAt: input.binding.payload.expiresAt };
        } },
        signer: { async sign({ task }) {
          assert.equal(wfApprovals, 1); wfSignatures++;
          const index = signingAccounts.findIndex(a => a.accountId === task.accountId && a.publicKey === task.publicKey);
          assert.ok(index === 0 || index === 1);
          if (index === 1) { assert.equal(task.purpose, "transaction"); wfController++; }
          const signature = secp256k1.sign(task.digest, (index + 1).toString(16).padStart(64, "0"), { prehash: false, lowS: true });
          return { taskId: task.taskId, signatureEncoding: task.signatureEncoding,
            signature: task.signatureEncoding === "compact64" ? signature.toCompactHex()
              : Buffer.concat([Buffer.from([31 + signature.recovery]), Buffer.from(signature.toCompactRawBytes())]).toString("hex") };
        } },
        clock: () => NOW, randomBytes: length => Uint8Array.from({ length }, (_, i) => i),
      });
      let sequence = 0;
      const wfSession = await wfRuntime.openSession({ origin: "https://wallet.test", sessionId: `role-workflow-${workflowRoleChecks}`,
        requestIdFactory: () => `wf-${++sequence}`, execution: { hostStore: wfStore } });
      try {
        const delivery = await wfSession.startOperation({ id: `wf-direct-${++sequence}`, method: preparedWorkflow ? "tbc_signPreparedWorkflow" : "tbc_signWorkflow", params: wfParams });
        if (delivery.status === "failed") {
          // Replay only the pure failing Core transition with recorded inputs;
          // no Port callback, signing or broadcast is invoked by this diagnostic.
          const row = await wfStore.readOperation(delivery.operationId), checkpoint = row.transition.checkpoint;
          const pendingCall = checkpoint.payload.pendingCalls[0];
          const callRecord = pendingCall ? await wfStore.readCall(pendingCall.callId) : undefined;
          try { await kit.createTwsCore({ transactionEngine: engine }).resume({ version: "1.0", checkpoint,
            currentContext: checkpoint.payload.context, currentSession: checkpoint.payload.session,
            ...(callRecord?.response ? { response: callRecord.response } : {}) }); }
          catch (error) { throw new Error(`Workflow pure ${checkpoint.payload.state} failure: ${error.code ?? error.name}: ${error.message}`, { cause: error }); }
        }
        assert.equal(delivery.status, "complete", `${request.intent.type}/prepared=${preparedWorkflow}: ${JSON.stringify(delivery.error)}; approvals=${wfApprovals},signatures=${wfSignatures},reads=${wfReads}`);
        assert.equal(delivery.completion.response.error, undefined, JSON.stringify(delivery.completion.response.error));
        const result = delivery.completion.response.result;
        assert.equal(result.steps.length, 2);
        assert.equal(wfApprovals, 1); assert.equal(wfReads, 1); assert.equal(wfController, 1);
        assert.ok(wfSignatures >= 4);
        assert.equal(trace.length, approvedHttpCount, "Workflow added HTTP after approval");
        workflowRoleBudgets.push(`${request.intent.type}/${preparedWorkflow ? "prepared" : "ordinary"}:approvals=${wfApprovals},signatures=${wfSignatures},GET=${trace.length - workflowHttpStart}`);
        workflowRoleChecks++;
      } finally { await wfSession.close(); approvedHttpCount = undefined; }
    }
  }
  if (defaultAnchors && !prepared && lp.length) {
    approvedHttpCount = undefined;
    const originalRows = lpRows, count = signatures;
    const parameters = { version: "1.0", accountId: account.accountId, chainId: account.chainId, requirement,
      ...(ammController ? { signingRoles: request.signingRoles, signingAccounts: snapshot.payload.signingAccounts } : {}) };
    for (const rows of [[], [originalRows[0], originalRows[0]], originalRows.map(r => ({ ...r, ft_value: String(BigInt(r.ft_value) + 1n) }))]) {
      lpRows = rows;
      assert.equal((await policyNetwork.resolveChainData(parameters, account)).portError?.name, "CONFLICT"); loaderNegatives++;
    }
    lpRows = originalRows;
    // An index's false lock_time=0 must not defeat a real height-locked Tape.
    if (earliestLpLock > 0n && earliestLpLock < 500_000_000n) {
      const height = snapshot.payload.block.height;
      // Isolate maturity from the separate irrelevant-candidate fast-path
      // fixture, whose raw is intentionally absent. With every real input
      // locked, that absent raw would otherwise test transport availability.
      lpRows = originalRows.filter(row => raws.has(row.txid));
      snapshot.payload.block.height = String(earliestLpLock - 1n);
      assert.equal((await policyNetwork.resolveChainData(parameters, account)).portError?.name, "CONFLICT"); loaderNegatives++;
      snapshot.payload.block.height = height;
      lpRows = originalRows;
    }
    // Concurrent read failure plus early index failure must not leave an
    // unhandled rejected tip branch after resolve returns its bounded error.
    failTip = true; lpRows = [];
    assert.ok((await policyNetwork.resolveChainData(parameters, account)).portError); loaderNegatives++;
    await new Promise(resolve => setImmediate(resolve));
    failTip = false; lpRows = originalRows;
    assert.equal(signatures, count);
  }
  if (defaultBusiness && !prepared && poolUtxo) {
    approvedHttpCount = undefined;
    const originalInfo = poolInfo, originalPoolRows = poolFtRows, count = signatures;
    const parameters = { version: "1.0", accountId: account.accountId, chainId: account.chainId, requirement,
      ...(ammController ? { signingRoles: request.signingRoles, signingAccounts: snapshot.payload.signingAccounts } : {}) };
    for (const malformed of [
      { ...originalInfo, ft_contract_id: "11".repeat(32) },
      { ...originalInfo, token_balance: String(BigInt(originalInfo.token_balance) + 1n) },
      { ...originalInfo, pool_code_script: "00" },
    ]) {
      poolInfo = malformed;
      assert.equal((await policyNetwork.resolveChainData(parameters, account)).portError?.name, "CONFLICT"); loaderNegatives++;
    }
    poolInfo = originalInfo;
    for (const malformed of [[], [originalPoolRows[0], originalPoolRows[0]], originalPoolRows.map(r => ({ ...r, ft_value: String(BigInt(r.ft_value) + 1n) }))]) {
      poolFtRows = malformed;
      assert.equal((await policyNetwork.resolveChainData(parameters, account)).portError?.name, "CONFLICT"); loaderNegatives++;
    }
    poolFtRows = originalPoolRows;
    assert.equal(signatures, count);
  }
}
// Named helpers are shape-only; shared send/walletBuild covers sign-only too.
const calls = [], address = materials[0].request.from;
const provider = { async request(call) { calls.push(call); return call.method === "tbc_requestAccounts" ? [address] : {}; }, on() {}, removeListener() {}, destroy() {} };
const wallet = await kit.createTbcClient({ network: "testnet", provider }).connect();
for (const [group, name, type] of [["amm", "create", "tbc-amm-create"], ["amm", "addLiquidity", "tbc-amm-add-liquidity"],
  ["amm", "removeLiquidity", "tbc-amm-remove-liquidity"], ["amm", "swap", "tbc-amm-swap"], ["lp", "transfer", "tbc20-lp-transfer"],
  ["lp", "lock", "tbc20-lp-lock"], ["lp", "merge", "tbc20-lp-merge"], ["lp", "unlock", "tbc20-lp-unlock"]]) {
  const exemplar = materials.find(p => p.request.intent.type === type)?.request.intent ?? { poolContractId: "11".repeat(32), amount: "1", lockTime: "900000" };
  const { type: ignored, version, ...input } = exemplar;
  await wallet[group][name]({ ...input, constraints: { maxFee: "10000" } });
  assert.equal(calls.at(-1).params.intent.type, ({"tbc-amm-add-liquidity":"amm.addLiquidity","tbc-amm-remove-liquidity":"amm.removeLiquidity","tbc-amm-swap":"amm.swap"})[type]??type);
  assert.equal(calls.at(-1).method, "tbc_sendTransaction");
}
assert.equal(checkedTamper, true);
if (ammController) { assert.equal(roleNegatives, 5); assert.equal(checkedContinuation, true); assert.equal(preparedIsolationChecks, 1); assert.equal(workflowMaterialChecks, 1); assert.equal(workflowRoleChecks, 4); }
if (workflowRoleChecks) console.log(`AMM_ROLE_WORKFLOW_PASS ${workflowRoleChecks} Host cases; ${workflowRoleBudgets.join(" ")}; post-approval HTTP=0; broadcast POST=0`);
for (const networkName of ["mainnet", "testnet"]) {
  const network = kit.createDefaultTbcNetwork({ network: kit.createTbcNetworkContext({ network: networkName }),
    accounts: { current: async () => [] }, now: () => Date.parse(NOW), fetch: async () => { throw new Error("Policy performed a read"); } });
  for (const type of types) {
    const request = structuredClone(materials.find(p => p.request.intent.type === type).request);
    request.chainId = `tbc:${networkName}`;
    const input = { version: "1.0", request, requestHash: kit.hashCanonical(request), snapshotHash: "11".repeat(32) };
    const result = await network.resolvePolicy(input);
    assert.equal(result.payload.dustThreshold, "10"); assert.equal(result.payload.feeRateSatPerKb, "80");
    assert.equal(result.payload.chainId, request.chainId); assert.equal(result.payload.contractPolicies[0].allowedVersions[0], "pool3");
    assert.equal((await network.resolvePolicy({ ...input, requestHash: "00".repeat(32) })).portError.name, "INVALID_INPUT");
    request.chainId = networkName === "mainnet" ? "tbc:testnet" : "tbc:mainnet";
    assert.equal((await network.resolvePolicy({ ...input, request, requestHash: kit.hashCanonical(request) })).portError.name, "UNAUTHORIZED");
  }
}
// Controller fixtures also exercise all three FT-budget add variants derived
// from ordinary/locked/fragmented sell material above.
assert.equal(checks.length, ammController ? 24 : ammBatch ? 6 : lpBatch ? 8 : defaultBusiness ? 42 : defaultAnchors ? 22 : 38);
console.log(`AMM_KIT_SOURCE_PASS ${checks.length} Host cases; ${checks.join(" ")}; ${roleNegatives} role lifecycle negatives; ${preparedIsolationChecks} concurrent Prepared consent isolation pair; ${workflowMaterialChecks} workflow scoped material checks; wrong Prepared Pool template rejected before approval/signing; two-network policy is read-free; ${defaultAnchors ? `real default ${defaultBusiness ? "AMM/LP" : "create/LP"} loader with synthetic HTTP; ${loaderNegatives} loader negatives; minimum ancestors, fresh indexes and raw reuse verified; post-approval HTTP=0 for individual success cases` : "custom synthetic material; default HTTP loader not exercised; HTTP=0"}, broadcast POST=0`);
