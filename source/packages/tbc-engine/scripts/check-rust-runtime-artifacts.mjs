import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as tws from "@tbc-wallet/core";
import { withOutputReview } from "../../../scripts/lib/reviewed-transfer-fixture.mjs";
import {
  createMemoryTwsHostStore,
  createTwsHost,
} from "../../host/dist/esm/index.js";
import { createTbcEngine } from "../dist/esm/index.js";
import { createWasmTbcEngineBackend } from "../dist/esm/wasm.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(packageRoot, "../..");
const nativeTarget = execFileSync("rustc", ["-vV"], { encoding: "utf8" }).match(/^host: (.+)$/m)?.[1];
assert.ok(nativeTarget?.endsWith("apple-darwin"), "Native dylib runtime gate requires a macOS host");
const nativeArtifact = process.env.TBC_ENGINE_NATIVE_ARTIFACT ?? join(packageRoot, "artifacts", "native", nativeTarget, "libtbc_engine_native.dylib");
const wasmArtifact = process.env.TBC_ENGINE_WASM_ARTIFACT ?? join(packageRoot, "artifacts", "wasm", "tbc_engine_wasm.wasm");
const temp = mkdtempSync(join(tmpdir(), "tbc-engine-runtime-"));
const runner = join(temp, "native-artifact-runner");

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function parse(raw, label) {
  const envelope = JSON.parse(raw);
  assert.equal(typeof envelope.ok, "boolean", `${label} omitted its envelope status`);
  return envelope;
}

function permissionFor(base, capability) {
  return {
    ...base,
    id: `permission-${capability.replaceAll("_", "-")}`,
    parentCapability: capability,
    caveats: base.caveats.map((caveat) =>
      caveat.type === "restrictMethods"
        ? { ...caveat, value: [capability] }
        : caveat,
    ),
  };
}

function assertNoSecretMaterial(value) {
  const forbidden = new Set(["privatekey", "privatekeyhex", "privatekeywif", "mnemonic", "seed", "seedphrase", "wif"]);
  const seen = new Set();
  const visit = (candidate, path = "$") => {
    if (candidate === null || typeof candidate !== "object" || seen.has(candidate)) return;
    seen.add(candidate);
    for (const [key, nested] of Object.entries(candidate)) {
      const normalized = key.replaceAll(/[^a-z0-9]/gi, "").toLowerCase();
      assert.equal(forbidden.has(normalized), false, `secret field escaped at ${path}.${key}`);
      visit(nested, `${path}.${key}`);
    }
  };
  visit(value);
}

function tracedEngine(engine, trace, engineParams = []) {
  const invoke = (method, params) => {
    trace.push(`engine.${method}`);
    engineParams.push(structuredClone(params));
    return engine[method](params);
  };
  return Object.freeze({
    normalizeRequest: (params) => invoke("normalizeRequest", params),
    plan: (params) => invoke("plan", params),
    validate: (params) => invoke("validate", params),
    finalize: (params) => invoke("finalize", params),
  });
}

async function driveHostTransaction({
  engine,
  vector,
  label,
  expectedRequirement,
  context,
  session,
  permissionBase,
  reject = false,
  send = false,
  loseFirstBroadcastResponse = false,
}) {
  const trace = [];
  const engineParams = [];
  const finalizeCalls = [];
  const wrapped = tracedEngine(engine, trace, engineParams);
  const core = tws.createTwsCore({
    transactionEngine: Object.freeze({
      ...wrapped,
      finalize: (params) => {
        finalizeCalls.push(structuredClone(params));
        return wrapped.finalize(params);
      },
    }),
  });
  const signatures = new Map(
    vector.finalizeInputs
      .flatMap(({ signatures: stage }) => stage)
      .map((signature) => [signature.taskId, signature]),
  );
  const clocks = [
    "2026-08-31T12:00:00Z",
    "2026-08-31T12:00:05Z",
    "2026-08-31T12:00:11Z",
    "2026-08-31T12:00:12Z",
    "2026-08-31T12:00:13Z",
    "2026-08-31T12:00:14Z",
    "2026-08-31T12:00:15Z",
    "2026-08-31T12:00:16Z",
    "2026-08-31T12:00:17Z",
    "2026-08-31T12:00:18Z",
  ];
  const port = (name, handler) => async (call) => {
    trace.push(`port.${call.operation}`);
    return handler(call);
  };
  const unexpected = (name) => port(name, () => {
    throw new Error(`unexpected ${name} Port`);
  });
  const authority = Object.freeze({
    currentContext: context,
    currentSession: session,
  });
  const capability = send ? "tbc_sendTransaction" : "tbc_signTransaction";
  const broadcastTxids = [];
  const host = createTwsHost({
    core,
    store: createMemoryTwsHostStore(),
    authority: Object.freeze({
      read: async () => structuredClone(authority),
      compareAndSwapSession: async () => {
        throw new Error("transaction flow cannot mutate Provider Session authority");
      },
    }),
    ownerId: reject ? `runtime-${label}-reject` : `runtime-${label}`,
    scheduleLeaseHeartbeat(delayMs, run) {
      const handle = setTimeout(run, delayMs);
      return () => clearTimeout(handle);
    },
    leaseTtlMs: 30_000,
    maxSteps: 128,
    ports: Object.freeze({
      accounts: port("accounts", () => ({
        accounts: [vector.planInput.snapshot.payload.account],
      })),
      chainData: port("chainData", (call) => {
        assert.deepEqual(call.params.requirement, expectedRequirement);
        return vector.planInput.snapshot;
      }),
      policy: port("policy", () => vector.planInput.policy),
      permissionStore: port("permissionStore", () => ({
        revision: "0",
        permissions: [
          permissionFor(permissionBase, "tbc_accounts"),
          permissionFor(permissionBase, capability),
        ],
      })),
      approval: port("approval", (call) =>
        reject
          ? {
              status: "rejected",
              bindingHash: call.params.binding.bindingHash,
              rejectedAt: "2026-08-31T12:00:10Z",
            }
          : {
              status: "approved",
              approvalId: `runtime-${label}`,
              approvalToken: `runtime-${label}-token`,
              bindingHash: call.params.binding.bindingHash,
              approvedAt: "2026-08-31T12:00:10Z",
              expiresAt: call.params.binding.payload.expiresAt,
            }),
      signer: port("signer", (call) => {
        const signature = signatures.get(call.params.task.taskId);
        assert.ok(signature, `missing isolated test signature for ${call.params.task.taskId}`);
        return signature;
      }),
      broadcast: send
        ? port("broadcast", (call) => {
            if (call.operation === "broadcast.reconcile") {
              return {
                transactions: call.params.txids.map((txid) => ({
                  txid,
                  status: "mempool",
                  confirmations: "0",
                })),
              };
            }
            broadcastTxids.push(call.params.transaction.txid);
            if (loseFirstBroadcastResponse && broadcastTxids.length === 1) {
              return {
                portError: {
                  name: "UNAVAILABLE",
                  message: "source submission response was lost",
                  retryable: true,
                },
              };
            }
            return { txid: call.params.transaction.txid, status: "accepted" };
          })
        : unexpected("broadcast"),
      clock: port("clock", () => {
        const now = clocks.shift();
        assert.ok(now, "runtime Host exhausted its trusted clocks");
        return { now };
      }),
      entropy: unexpected("entropy"),
    }),
  });
  const result = await host.startOperation({
    version: "1.0",
    release: tws.TWS_RELEASE,
    request: {
      jsonrpc: "2.0",
      id: reject ? `runtime-${label}-reject` : `runtime-${label}`,
      method: capability,
      params: vector.planInput.request,
    },
  });
  assertNoSecretMaterial(engineParams);
  if (reject) {
    assert.equal(result.status, "complete");
    assert.equal(result.completion.response.error.code, 4001);
    assert.equal(trace.some((entry) => entry === "port.signer.sign"), false);
    assert.equal(finalizeCalls.length, 0);
    assert.equal(trace.some((entry) => entry.startsWith("port.broadcast.")), false);
    return { result, trace, finalizeCalls };
  }
  assert.equal(result.status, "complete");
  assert.equal(
    result.completion.response.error,
    undefined,
    JSON.stringify({ result, trace, finalizeCalls: finalizeCalls.length }),
  );
  assert.deepEqual(
    result.completion.response.result.transactions.map(({ txid }) => txid),
    vector.complete.bundle.transactions.map(({ txid }) => txid),
  );
  assert.equal(finalizeCalls.length, vector.finalizeInputs.length);
  assert.equal(
    trace.filter((entry) => entry === "port.approval.request").length,
    1,
  );
  assert.equal(
    trace.filter((entry) => entry === "port.signer.sign").length,
    vector.finalizeInputs.flatMap(({ signatures }) => signatures).length,
  );
  assert.ok(trace.lastIndexOf("engine.finalize") > trace.lastIndexOf("port.signer.sign"));
  if (send) {
    assert.deepEqual(
      broadcastTxids,
      vector.complete.bundle.transactions.map(({ txid }) => txid),
    );
  }
  return { result, trace, finalizeCalls, broadcastTxids };
}

async function captureRequirement({
  engine,
  request,
  account,
  context,
  session,
  permissionBase,
}) {
  const core = tws.createTwsCore({ transactionEngine: engine });
  let transition = await core.start({
    version: "1.0",
    release: tws.TWS_RELEASE,
    request: {
      jsonrpc: "2.0",
      id: `requirement-${request.intent.type}`,
      method: "tbc_signTransaction",
      params: request,
    },
    currentContext: context,
    currentSession: session,
  });
  for (let steps = 0; steps < 16; steps += 1) {
    if (transition.kind === "continue") {
      transition = await core.resume({
        version: "1.0",
        checkpoint: transition.checkpoint,
        currentContext: context,
        currentSession: session,
      });
      continue;
    }
    assert.equal(transition.kind, "waiting");
    const call = transition.calls[0];
    if (call.operation === "chainData.resolve") return call.params.requirement;
    const result = call.operation === "clock.now"
      ? { now: "2026-08-31T12:00:00Z" }
      : call.operation === "permissionStore.load"
        ? {
            revision: "0",
            permissions: [
              permissionFor(permissionBase, "tbc_accounts"),
              permissionFor(permissionBase, "tbc_signTransaction"),
            ],
          }
        : call.operation === "accounts.resolve"
          ? { accounts: [account] }
          : undefined;
    assert.notEqual(result, undefined, `unexpected requirement Port: ${call.operation}`);
    transition = await core.resume({
      version: "1.0",
      checkpoint: transition.checkpoint,
      response: { version: "1.0", callId: call.callId, result },
      currentContext: context,
      currentSession: session,
    });
  }
  throw new Error("Core did not request chain data");
}

try {
  execFileSync("cc", [
    join(packageRoot, "scripts", "native-artifact-runner.c"),
    nativeArtifact,
    "-I", join(packageRoot, "rust", "crates", "tbc-engine-native", "include"),
    `-Wl,-rpath,${dirname(nativeArtifact)}`,
    "-o", runner,
  ], { stdio: "inherit" });

  const wasmBytes = readFileSync(wasmArtifact);
  const wasm = await createWasmTbcEngineBackend(wasmBytes);
  const nativeCall = (method, input) => execFileSync(runner, [method, input], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  const parityCall = async (method, input, label) => {
    const wasmRaw = await wasm.call(method, input);
    const nativeRaw = nativeCall(method, input);
    assert.equal(nativeRaw, wasmRaw, `${label} native/WASM response bytes differ`);
    return { raw: wasmRaw, envelope: parse(wasmRaw, label) };
  };

  const tbc = JSON.parse(readFileSync(join(packageRoot, "rust", "fixtures", "tbc-transfer.json"), "utf8"));
  const reviewed = withOutputReview(tbc.finalizeInput);
  tbc.finalizeInput = reviewed;
  tbc.validateInput.plan = reviewed.plan;
  const checks = [];
  for (const [method, input, label] of [
    ["plan", tbc.planInput, "tbc.transfer plan"],
    ["validate", tbc.validateInput, "tbc.transfer validate"],
    ["finalize", tbc.finalizeInput, "tbc.transfer externally signed finalize"],
  ]) {
    const result = await parityCall(method, JSON.stringify(input), label);
    assert.equal(result.envelope.ok, true, `${label} failed`);
    checks.push({ label, method, resultSha256: sha256(result.raw) });
  }

  const cappedNormalize = structuredClone(tbc.normalizeInput);
  cappedNormalize.request.constraints.maxFee = "1";
  const normalized = await parityCall("normalizeRequest", JSON.stringify(cappedNormalize), "fee-cap normalize");
  assert.equal(normalized.envelope.ok, true);
  const cappedPlan = structuredClone(tbc.planInput);
  cappedPlan.request = normalized.envelope.result.request;
  cappedPlan.requestHash = normalized.envelope.result.requestHash;
  const capped = await parityCall("plan", JSON.stringify(cappedPlan), "fee-cap rejection");
  assert.equal(capped.envelope.ok, false);
  assert.equal(capped.envelope.error.code, "FEE_CAP_EXCEEDED");
  checks.push({ label: "fee cap rejects an otherwise fundable transfer", method: "plan", errorCode: capped.envelope.error.code, resultSha256: sha256(capped.raw) });

  const generatedFt = JSON.parse(execFileSync("cargo", [
    "run", "--quiet", "--locked", "--offline", "-p", "tbc-engine-core", "--example", "export_runtime_vectors",
  ], { cwd: join(packageRoot, "rust"), encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }));
  const ftCreatePlan = await parityCall(
    "plan",
    JSON.stringify(generatedFt.ft.create.planInput),
    "FT create plan",
  );
  assert.equal(ftCreatePlan.envelope.ok, true, "FT create plan failed");
  assert.equal(
    ftCreatePlan.envelope.result.plan.payload.preview.assetFlows[0].direction,
    "create",
  );
  assert.deepEqual(
    ftCreatePlan.envelope.result.plan.payload.preview.warnings,
    [],
  );
  const ftCreateStages = [];
  for (const [index, input] of generatedFt.ft.create.finalizeInputs.entries()) {
    const stage = await parityCall(
      "finalize",
      JSON.stringify(input),
      `FT create finalize stage ${index}`,
    );
    assert.equal(stage.envelope.ok, true, `FT create finalize stage ${index} failed`);
    ftCreateStages.push(stage);
  }
  assert.equal(ftCreateStages[0].envelope.result.status, "pending");
  assert.ok(ftCreateStages.at(-1).envelope.result.bundle);
  const completedStageInput = generatedFt.ft.create.finalizeInputs.at(-1);
  const preBroadcastInput = {
    ...structuredClone(completedStageInput),
    phase: "pre-broadcast",
    bundle: structuredClone(generatedFt.ft.create.complete.bundle),
  };
  const preBroadcast = await parityCall(
    "validate",
    JSON.stringify(preBroadcastInput),
    "FT create staged pre-broadcast validation",
  );
  assert.equal(preBroadcast.envelope.ok, true);
  assert.deepEqual(preBroadcast.envelope.result, { valid: true, violations: [] });
  tws.assertValidTws("validationResult", preBroadcast.envelope.result);
  const missingContinuation = structuredClone(preBroadcastInput);
  delete missingContinuation.continuation;
  const rejectedPreBroadcast = await parityCall(
    "validate",
    JSON.stringify(missingContinuation),
    "FT create pre-broadcast missing continuation",
  );
  assert.equal(rejectedPreBroadcast.envelope.ok, true);
  assert.equal(rejectedPreBroadcast.envelope.result.valid, false);
  tws.assertValidTws("validationResult", rejectedPreBroadcast.envelope.result);
  assert.deepEqual(rejectedPreBroadcast.envelope.result.violations, [
    { code: "SIGNATURE_INVALID", path: "/signatures" },
  ]);
  checks.push({
    label: "tbc.ft.create staged plan, finalize, and pre-broadcast validate",
    method: "plan/finalize/validate",
    stages: ftCreateStages.length,
    resultSha256: sha256([
      ...ftCreateStages.map(({ raw }) => raw),
      preBroadcast.raw,
      rejectedPreBroadcast.raw,
    ].join("\n")),
  });

  const labeledFtCreate = structuredClone(generatedFt.ft.create.planInput);
  labeledFtCreate.snapshot.payload.account.label = "Primary TBC";
  labeledFtCreate.snapshot.snapshotHash = tws.hashCanonical(
    labeledFtCreate.snapshot.payload,
  );
  const labeledPlan = await parityCall(
    "plan",
    JSON.stringify(labeledFtCreate),
    "Core-valid account label",
  );
  assert.equal(labeledPlan.envelope.ok, true, "Rust rejected Core-valid account label");
  checks.push({
    label: "Core-valid optional account label",
    method: "plan",
    resultSha256: sha256(labeledPlan.raw),
  });

  const ftDirect = await parityCall("plan", JSON.stringify(generatedFt.ft.direct), "FT plan");
  assert.equal(ftDirect.envelope.ok, true, "FT plan failed");
  checks.push({
    label: "tbc.ft.transfer plan",
    method: "plan",
    transactions: ftDirect.envelope.result.plan.payload.transactions.length,
    resultSha256: sha256(ftDirect.raw),
  });
  const ftStaged = await parityCall("plan", JSON.stringify(generatedFt.ft.mergeRequired), "FT parent-child dependency plan");
  assert.equal(ftStaged.envelope.ok, true, "FT parent-child dependency plan failed");
  assert.equal(ftStaged.envelope.result.plan.payload.transactions.length, 2);
  checks.push({
    label: "tbc.ft.transfer maintenance-to-primary parent-child plan",
    method: "plan",
    transactions: 2,
    resultSha256: sha256(ftStaged.raw),
  });

  const poolAdd = generatedFt.pool.addLiquidity;
  assertNoSecretMaterial(poolAdd);
  tws.assertValidTws("planParams", poolAdd.planInput);
  tws.assertValidTws("chainDataResolveResult", poolAdd.planInput.snapshot);
  assert.ok(
    poolAdd.planInput.snapshot.payload.utxos.some(
      (utxo) => utxo.classification === "pool-ft",
    ),
    "tbc.pool.liquidity.add fixture is missing pool-ft",
  );
  const poolAddNormalized = await parityCall(
    "normalizeRequest",
    JSON.stringify({ version: "1.0", request: poolAdd.planInput.request }),
    "Pool LP increase normalize",
  );
  assert.equal(poolAddNormalized.envelope.ok, true);
  const poolAddPlan = await parityCall(
    "plan",
    JSON.stringify(poolAdd.planInput),
    "Pool LP increase plan",
  );
  assert.equal(poolAddPlan.envelope.ok, true);
  tws.assertValidTws("planResult", poolAddPlan.envelope.result);
  tws.assertValidTws(
    "approvalPreview",
    poolAddPlan.envelope.result.plan.payload.preview,
  );
  assert.ok(
    poolAddPlan.envelope.result.plan.payload.preview.assetFlows.some(
      (flow) => flow.kind === "pool" && flow.direction === "contract",
    ),
    "Pool LP increase preview is missing explicit Pool contract flow semantics",
  );
  const poolAddPlanValidation = await parityCall(
    "validate",
    JSON.stringify({
      ...structuredClone(poolAdd.planInput),
      phase: "plan",
      plan: structuredClone(poolAddPlan.envelope.result.plan),
    }),
    "Pool LP increase plan validation",
  );
  assert.deepEqual(poolAddPlanValidation.envelope.result, {
    valid: true,
    violations: [],
  });
  const poolAddFinalizeStages = [];
  for (const [index, input] of poolAdd.finalizeInputs.entries()) {
    const stage = await parityCall(
      "finalize",
      JSON.stringify(input),
      `Pool LP increase finalize stage ${index}`,
    );
    assert.equal(stage.envelope.ok, true);
    poolAddFinalizeStages.push(stage);
  }
  assert.ok(poolAddFinalizeStages.at(-1).envelope.result.bundle);
  const poolAddFinalValidation = await parityCall(
    "validate",
    JSON.stringify({
      ...structuredClone(poolAdd.finalizeInputs.at(-1)),
      phase: "finalized",
      bundle: structuredClone(poolAdd.complete.bundle),
    }),
    "Pool LP increase finalized validation",
  );
  assert.deepEqual(poolAddFinalValidation.envelope.result, {
    valid: true,
    violations: [],
  });
  checks.push({
    label: "tbc.pool.liquidity.add four-method external-signature lifecycle",
    method: "normalizeRequest/plan/validate/finalize",
    stages: poolAddFinalizeStages.length,
    transactions: poolAdd.complete.bundle.transactions.length,
    resultSha256: sha256([
      poolAddNormalized.raw,
      poolAddPlan.raw,
      poolAddPlanValidation.raw,
      ...poolAddFinalizeStages.map(({ raw }) => raw),
      poolAddFinalValidation.raw,
    ].join("\n")),
  });

  for (const name of ["tokenSwap", "fragmentedRemove", "maintenanceRemove", "ftlpBurn"]) {
    const vector = generatedFt.pool[name];
    assertNoSecretMaterial(vector);
    const planned = await parityCall("plan", JSON.stringify(vector.planInput), `${name} plan`);
    assert.equal(planned.envelope.ok, true);
    const stages = [];
    for (const [index, input] of vector.finalizeInputs.entries()) {
      const stage = await parityCall("finalize", JSON.stringify(input), `${name} finalize stage ${index}`);
      assert.equal(stage.envelope.ok, true);
      stages.push(stage);
    }
    assert.deepEqual(stages.at(-1).envelope.result.bundle, vector.complete.bundle);
    const checked = await parityCall("validate", JSON.stringify({
      ...structuredClone(vector.finalizeInputs.at(-1)),
      phase: "finalized",
      bundle: structuredClone(vector.complete.bundle),
    }), `${name} finalized validation`);
    assert.deepEqual(checked.envelope.result, { valid: true, violations: [] });
    checks.push({
      label: `${name} Pool-held FT native/WASM external-signature lifecycle`,
      method: "plan/finalize/validate",
      stages: stages.length,
      transactions: vector.complete.bundle.transactions.length,
      resultSha256: sha256([planned.raw, ...stages.map(({ raw }) => raw), checked.raw].join("\n")),
    });
  }

  const poolRemove = generatedFt.pool.removeLiquidity;
  const poolRemoveIntent = poolRemove.planInput.request.intent;
  const poolRemoveNormalized = await parityCall(
    "normalizeRequest",
    JSON.stringify({ version: "1.0", request: poolRemove.planInput.request }),
    "Pool LP decrease normalize",
  );
  assert.equal(poolRemoveNormalized.envelope.ok, true);
  const poolRemovePlan = await parityCall(
    "plan",
    JSON.stringify(poolRemove.planInput),
    "Pool LP decrease plan",
  );
  assert.equal(poolRemovePlan.envelope.ok, true);
  tws.assertValidTws("planResult", poolRemovePlan.envelope.result);
  assert.deepEqual(
    poolRemovePlan.envelope.result.plan.payload.transactions.map(({ role }) => role),
    ["primary"],
  );
  const poolRemovePlanValidation = await parityCall(
    "validate",
    JSON.stringify({
      ...structuredClone(poolRemove.planInput),
      phase: "plan",
      plan: structuredClone(poolRemovePlan.envelope.result.plan),
    }),
    "Pool LP decrease plan validation",
  );
  assert.deepEqual(poolRemovePlanValidation.envelope.result, {
    valid: true,
    violations: [],
  });
  const poolRemoveFinalizeStages = [];
  for (const [index, input] of poolRemove.finalizeInputs.entries()) {
    const stage = await parityCall(
      "finalize",
      JSON.stringify(input),
      `Pool LP decrease finalize stage ${index}`,
    );
    assert.equal(stage.envelope.ok, true);
    poolRemoveFinalizeStages.push(stage);
  }
  const poolRemoveFinalValidation = await parityCall(
    "validate",
    JSON.stringify({
      ...structuredClone(poolRemove.finalizeInputs.at(-1)),
      phase: "finalized",
      bundle: structuredClone(poolRemove.complete.bundle),
    }),
    "Pool LP decrease finalized validation",
  );
  assert.deepEqual(poolRemoveFinalValidation.envelope.result, {
    valid: true,
    violations: [],
  });
  checks.push({
    label: "tbc.pool.liquidity.remove four-method external-signature lifecycle",
    method: "normalizeRequest/plan/validate/finalize",
    stages: poolRemoveFinalizeStages.length,
    transactions: poolRemove.complete.bundle.transactions.length,
    resultSha256: sha256([
      poolRemoveNormalized.raw,
      poolRemovePlan.raw,
      poolRemovePlanValidation.raw,
      ...poolRemoveFinalizeStages.map(({ raw }) => raw),
      poolRemoveFinalValidation.raw,
    ].join("\n")),
  });

  // Retained historical creation inputs must fail at the public boundary,
  // not be relabelled as successful current-standard issuance.
  for (const input of [generatedFt.pool.createPlanInput,
      generatedFt.pool.createMintInput, generatedFt.pool.createInitializeInput]) {
    const rejected = await parityCall("plan", JSON.stringify(input), "disabled Pool2 creation");
    assert.equal(rejected.envelope.ok, false);
    assert.equal(rejected.envelope.error.code, "UNSUPPORTED_INTENT");
    checks.push({ label: "historical Pool2 issuance rejected", method: "plan", resultSha256: sha256(rejected.raw) });
  }

  const unknownPoolClassification = structuredClone(
    generatedFt.pool.addLiquidity.planInput.snapshot,
  );
  unknownPoolClassification.payload.utxos.find(
    (utxo) => utxo.classification === "pool-ft",
  ).classification = "pool-internal";
  assert.throws(() =>
    tws.assertValidTws("chainDataResolveResult", unknownPoolClassification),
  );

  const poolPlan = await parityCall("plan", JSON.stringify(generatedFt.pool.swap.planInput), "Pool swap plan");
  assert.equal(poolPlan.envelope.ok, true, "Pool swap plan failed");
  checks.push({
    label: "tbc.pool.swap.exactTbcForToken plan",
    method: "plan",
    transactions: poolPlan.envelope.result.plan.payload.transactions.length,
    resultSha256: sha256(poolPlan.raw),
  });
  const poolFinalize = await parityCall("finalize", JSON.stringify(generatedFt.pool.swap.finalizeInput), "Pool swap externally signed finalize");
  assert.equal(poolFinalize.envelope.ok, true, "Pool swap externally signed finalize failed");
  assert.ok(poolFinalize.envelope.result.bundle, "direct Pool swap did not complete to a bundle");
  checks.push({
    label: "tbc.pool.swap.exactTbcForToken externally signed finalize",
    method: "finalize",
    resultSha256: sha256(poolFinalize.raw),
  });

  const provider = JSON.parse(
    readFileSync(join(repoRoot, "test-vectors", "provider.json"), "utf8"),
  );
  const permissionVectors = JSON.parse(
    readFileSync(join(repoRoot, "test-vectors", "permissions.json"), "utf8"),
  );
  const context = provider.trustedContexts[0].context;
  const session = provider.providerSessions.sessionA;
  const realEngine = createTbcEngine({ backend: wasm });
  const hostResult = await driveHostTransaction({
    engine: realEngine,
    vector: generatedFt.ft.create,
    label: "ft-create",
    expectedRequirement: {
      intentType: "tbc20-standard-create",
      includeAncestry: false,
      assets: [{ kind: "native" }],
    },
    context,
    session,
    permissionBase: permissionVectors.result[0],
    send: true,
  });
  checks.push({
    label: "Host/Core/WASM FT create approval-bound staged send lifecycle",
    method: "host.startOperation",
    stages: hostResult.finalizeCalls.length,
    resultSha256: sha256(JSON.stringify(hostResult.result.completion.response.result)),
  });
  const recoveryResult = await driveHostTransaction({
    engine: realEngine,
    vector: generatedFt.ft.create,
    label: "ft-create-recovery",
    expectedRequirement: {
      intentType: "tbc20-standard-create",
      includeAncestry: false,
      assets: [{ kind: "native" }],
    },
    context,
    session,
    permissionBase: permissionVectors.result[0],
    send: true,
    loseFirstBroadcastResponse: true,
  });
  checks.push({
    label: "Host/Core/WASM FT create recovers a known source prefix without duplicate posts",
    method: "host.startOperation",
    sourcePosts: recoveryResult.broadcastTxids.filter(
      (txid) => txid === generatedFt.ft.create.complete.bundle.transactions[0].txid,
    ).length,
    suffixPosts: recoveryResult.broadcastTxids.filter(
      (txid) => txid === generatedFt.ft.create.complete.bundle.transactions[1].txid,
    ).length,
    resultSha256: sha256(JSON.stringify(recoveryResult.result.completion.response.result)),
  });
  await driveHostTransaction({
    engine: realEngine,
    vector: generatedFt.ft.create,
    label: "ft-create-reject",
    expectedRequirement: {
      intentType: "tbc20-standard-create",
      includeAncestry: false,
      assets: [{ kind: "native" }],
    },
    context,
    session,
    permissionBase: permissionVectors.result[0],
    reject: true,
    send: true,
  });
  checks.push({
    label: "Host/Core rejection prevents sign finalize and broadcast",
    method: "host.startOperation",
    resultSha256: sha256("rejected-before-signer-finalize-broadcast"),
  });

  const poolAddIntent = poolAdd.planInput.request.intent;
  const poolHostResult = await driveHostTransaction({
    engine: realEngine,
    vector: poolAdd,
    label: "pool-lp-increase",
    expectedRequirement: {
      intentType: "tbc.pool.liquidity.add",
      includeAncestry: true,
      contractIds: [poolAddIntent.poolContractId],
      nativeAmount: poolAddIntent.tbcAmount,
      assets: [
        { kind: "native", minimumAmount: poolAddIntent.tbcAmount },
        { kind: "pool", contractId: poolAddIntent.poolContractId },
        {
          kind: "ft",
          contractDependency: {
            relation: "pool-ft",
            contractId: poolAddIntent.poolContractId,
          },
        },
      ],
    },
    context,
    session,
    permissionBase: permissionVectors.result[0],
  });
  checks.push({
    label: "Host/Core/WASM Pool LP increase approval-bound sign-only lifecycle",
    method: "host.startOperation",
    stages: poolHostResult.finalizeCalls.length,
    signerCalls: poolHostResult.trace.filter(
      (entry) => entry === "port.signer.sign",
    ).length,
    broadcasts: poolHostResult.trace.filter(
      (entry) => entry.startsWith("port.broadcast."),
    ).length,
    resultSha256: sha256(
      JSON.stringify(poolHostResult.result.completion.response.result),
    ),
  });

  for (const [label, vector, expectedRequirement] of [
    ["pool-ftlp-burn", generatedFt.pool.ftlpBurn, {
      intentType: "tbc.pool.ftlp.burn",
      includeAncestry: true,
      contractIds: [generatedFt.pool.ftlpBurn.planInput.request.intent.poolContractId],
      assets: [
        { kind: "native" },
        { kind: "pool", contractId: generatedFt.pool.ftlpBurn.planInput.request.intent.poolContractId },
        {
          kind: "ftlp",
          contractDependency: {
            relation: "pool-lp",
            contractId: generatedFt.pool.ftlpBurn.planInput.request.intent.poolContractId,
          },
        },
      ],
    }],
  ]) {
    const result = await driveHostTransaction({
      engine: realEngine,
      vector,
      label,
      expectedRequirement,
      context,
      session,
      permissionBase: permissionVectors.result[0],
    });
    checks.push({
      label: `Host/Core/WASM ${label} approval-bound sign-only lifecycle`,
      method: "host.startOperation",
      stages: result.finalizeCalls.length,
      signerCalls: result.trace.filter((entry) => entry === "port.signer.sign").length,
      broadcasts: result.trace.filter((entry) => entry.startsWith("port.broadcast.")).length,
      resultSha256: sha256(JSON.stringify(result.result.completion.response.result)),
    });
  }

  const { createTbcProvider } = await import(
    join(repoRoot, "packages", "provider", "dist", "esm", "index.js")
  );
  const { createInMemoryTransport } = await import(
    join(repoRoot, "packages", "provider", "dist", "esm", "in-memory.js")
  );
  const { TBC_PROVIDER_FEATURE, isTbcProviderFeature } = await import(
    join(repoRoot, "packages", "wallet-standard", "dist", "esm", "index.js")
  );
  let poolRemoveHostResult;
  const poolRemoveTransport = createInMemoryTransport({
    handler: async (request) => {
      assert.equal(request.method, "tbc_signTransaction");
      assert.deepEqual(request.params, poolRemove.planInput.request);
      poolRemoveHostResult = await driveHostTransaction({
        engine: realEngine,
        vector: poolRemove,
        label: "pool-lp-decrease-provider",
        expectedRequirement: {
          intentType: "tbc.pool.liquidity.remove",
          includeAncestry: true,
          contractIds: [poolRemoveIntent.poolContractId],
          assets: [
            { kind: "native" },
            { kind: "pool", contractId: poolRemoveIntent.poolContractId },
            {
              kind: "ftlp",
              contractDependency: {
                relation: "pool-lp",
                contractId: poolRemoveIntent.poolContractId,
              },
              minimumAmount: poolRemoveIntent.lpAmount,
            },
          ],
        },
        context,
        session,
        permissionBase: permissionVectors.result[0],
      });
      return {
        deliveryId: sha256(`pool-remove:${request.id}`),
        response: {
          jsonrpc: "2.0",
          id: request.id,
          result: poolRemoveHostResult.result.completion.response.result,
        },
        events: [],
      };
    },
  });
  const poolRemoveProvider = createTbcProvider({ transport: poolRemoveTransport.transport });
  const poolRemoveFeature = Object.freeze({
    version: "1.0.0",
    provider: poolRemoveProvider,
  });
  assert.equal(isTbcProviderFeature(poolRemoveFeature), true);
  const poolRemoveWallet = Object.freeze({
    version: "1.0.0",
    name: "Controlled Pool Remove Wallet",
    icon: "data:image/svg+xml;base64,PHN2Zy8+",
    chains: Object.freeze([poolRemove.planInput.request.chainId]),
    accounts: Object.freeze([]),
    features: Object.freeze({ [TBC_PROVIDER_FEATURE]: poolRemoveFeature }),
  });
  const poolRemoveProviderResult = await poolRemoveWallet.features[TBC_PROVIDER_FEATURE].provider.request({
    method: "tbc_signTransaction",
    params: poolRemove.planInput.request,
  });
  assert.deepEqual(
    poolRemoveProviderResult.transactions.map(({ txid }) => txid),
    poolRemove.complete.bundle.transactions.map(({ txid }) => txid),
  );
  assert.equal(poolRemoveHostResult.finalizeCalls.length, poolRemove.finalizeInputs.length);
  assert.equal(
    poolRemoveHostResult.trace.some((entry) => entry.startsWith("port.broadcast.")),
    false,
  );
  await driveHostTransaction({
    engine: realEngine,
    vector: poolRemove,
    label: "pool-lp-decrease-reject",
    expectedRequirement: {
      intentType: "tbc.pool.liquidity.remove",
      includeAncestry: true,
      contractIds: [poolRemoveIntent.poolContractId],
      assets: [
        { kind: "native" },
        { kind: "pool", contractId: poolRemoveIntent.poolContractId },
        {
          kind: "ftlp",
          contractDependency: {
            relation: "pool-lp",
            contractId: poolRemoveIntent.poolContractId,
          },
          minimumAmount: poolRemoveIntent.lpAmount,
        },
      ],
    },
    context,
    session,
    permissionBase: permissionVectors.result[0],
    reject: true,
  });
  checks.push({
    label: "Wallet Standard/Provider/Core/Host/WASM Pool LP decrease approval and rejection",
    method: "tbc:provider/tbc_signTransaction/host.startOperation",
    stages: poolRemoveHostResult.finalizeCalls.length,
    signerCalls: poolRemoveHostResult.trace.filter((entry) => entry === "port.signer.sign").length,
    broadcasts: 0,
    resultSha256: sha256(JSON.stringify(poolRemoveProviderResult)),
  });

  const ftRequirement = await captureRequirement({
    engine: realEngine,
    request: generatedFt.ft.direct.request,
    account: generatedFt.ft.direct.snapshot.payload.account,
    context,
    session,
    permissionBase: permissionVectors.result[0],
  });
  const ftIntent = generatedFt.ft.direct.request.intent;
  assert.deepEqual(ftRequirement.contractIds, [ftIntent.contractId]);
  assert.deepEqual(
    ftRequirement.assets.find(({ kind }) => kind === "ft"),
    {
      kind: "ft",
      contractId: ftIntent.contractId,
      minimumAmount: ftIntent.amount,
    },
  );
  const poolRequirement = await captureRequirement({
    engine: realEngine,
    request: generatedFt.pool.tokenSwapPlanInput.request,
    account: generatedFt.pool.tokenSwapPlanInput.snapshot.payload.account,
    context,
    session,
    permissionBase: permissionVectors.result[0],
  });
  const poolIntent = generatedFt.pool.tokenSwapPlanInput.request.intent;
  assert.deepEqual(poolRequirement.contractIds, [poolIntent.poolContractId]);
  assert.deepEqual(
    poolRequirement.assets.find(
      ({ contractDependency }) => contractDependency?.relation === "pool-ft",
    ),
    {
      kind: "ft",
      contractDependency: {
        relation: "pool-ft",
        contractId: poolIntent.poolContractId,
      },
      minimumAmount: poolIntent.ftAmount,
    },
  );
  checks.push({
    label: "Core exact FT and Pool chain-data requirements",
    method: "core.start/resume",
    resultSha256: sha256(JSON.stringify([ftRequirement, poolRequirement])),
  });

  const report = {
    version: "1.0",
    actualArtifactExecution: {
      native: `${nativeTarget} dylib loaded by a compiled C ABI consumer`,
      wasm: "wasm32-unknown-unknown module instantiated with zero imports through the shipped TypeScript adapter",
    },
    checks,
    mobileArtifacts: {
      ios: "built and packaged as device/simulator XCFramework; not executed inside the downstream app in this stage",
      android: "built as three jniLibs ABIs; not executed inside the downstream app in this stage",
    },
    sharedCoreEvidence: "All family, signing, continuation, and fee-envelope suites execute the same tbc-engine-core linked into these artifacts.",
    artifacts: {
      nativeSha256: sha256(readFileSync(nativeArtifact)),
      wasmSha256: sha256(wasmBytes),
      wasmImports: WebAssembly.Module.imports(new WebAssembly.Module(wasmBytes)),
    },
  };
  const reportPath = process.env.TBC_ENGINE_RUNTIME_REPORT
    ?? join(packageRoot, "evidence", "runtime-artifact-report.json");
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(
    reportPath,
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(`actual native/WASM artifact runtime parity passed (${checks.length} checks)`);
} finally {
  rmSync(temp, { force: true, recursive: true });
}
