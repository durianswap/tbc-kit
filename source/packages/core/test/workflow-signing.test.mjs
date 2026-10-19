import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { secp256k1 } from "@noble/curves/secp256k1";
import * as tws from "../dist/esm/index.js";

const integration = JSON.parse(
  await readFile(new URL("../../../test-vectors/integration.json", import.meta.url), "utf8"),
);
const provider = JSON.parse(
  await readFile(new URL("../../../test-vectors/provider.json", import.meta.url), "utf8"),
);
const permissions = JSON.parse(
  await readFile(new URL("../../../test-vectors/permissions.json", import.meta.url), "utf8"),
);
const workflow = JSON.parse(
  await readFile(new URL("../../../test-vectors/workflow.json", import.meta.url), "utf8"),
);

const canonical = integration.canonicalTransfer;
const vector = workflow.vectors[0];
const context = provider.trustedContexts[0].context;
const session = provider.providerSessions.sessionA;
const privateKey = Uint8Array.from({ length: 32 }, (_, index) => index === 31 ? 1 : 0);
function standaloneAction(method, format = "raw") {
  const { chainId, from, expiresAt, steps } = reviewedWorkflowRequest();
  const base = { version: "1.0", chainId, from, expiresAt };
  if (method === "tbc_signReviewedTransaction") return {
    ...base, maxFee: "0", request: format === "raw" ? steps[0].request : {
      payload: { format: "associated", sourceTransaction: "00", sourceInputs: [], children: [] },
    },
  };
  const algorithm = "tbc-bie1-secp256k1-aes128-cbc-hmac-sha256-v1";
  return method === "tbc_encrypt"
    ? { ...base, algorithm, message: { encoding: "utf8", data: "hello" } }
    : { ...base, algorithm, ciphertext: Buffer.alloc(85, 9).toString("base64") };
}

test("independent reviewed/crypto methods do not require workflow permission or construct a workflow plan", async () => {
  for (const [method, format] of [
    ["tbc_signReviewedTransaction", "raw"], ["tbc_signReviewedTransaction", "associated"],
    ["tbc_encrypt"], ["tbc_decrypt"],
  ]) {
    const request = standaloneAction(method, format);
    const result = await drive({ engine: undefined, calls: [] }, {
      method, request, permissionCapabilities: ["tbc_accounts", "tbc_signTransaction", "tbc_crypto"],
    });
    assert.equal(result.transition.checkpoint.payload.state, "completed");
    assert.ok(result.checkpoints.every(c => c.payload.operation.method === method && c.payload.memory.workflowPlan === undefined));
    assert.equal(result.ports.filter(c => c.operation === "approval.request").length, 1);
    assert.equal(result.ports.some(c => ["chainData.resolve", "policy.resolve", "broadcast.submit"].includes(c.operation)), false);
    const output = result.transition.completion.response.result;
    assert.equal(output.steps, undefined);
    if (method === "tbc_signReviewedTransaction") {
      assert.equal(output.requestHash, tws.hashCanonical(request));
      assert.equal(result.ports.filter(c => c.operation === "reviewedTransaction.review").length, 1);
      assert.equal(result.ports.filter(c => c.operation === "reviewedTransaction.execute").length, 1);
    } else {
      assert.equal(output.algorithm, request.algorithm);
      assert.equal(result.ports.filter(c => c.operation === "crypto.execute").length, 1);
    }
  }
});

test("oversized UTF-8 encryption is rejected before approval or private execution", async () => {
  const single = {...standaloneAction("tbc_encrypt"), message: {encoding:"utf8", data:"中".repeat(21846)}};
  const workflow = {version:single.version, chainId:single.chainId, from:single.from, expiresAt:single.expiresAt,
    steps:[{id:"oversize",kind:"encrypt",dependsOn:[],algorithm:single.algorithm,message:single.message}]};
  for (const [method,request] of [["tbc_encrypt",single],["tbc_signWorkflow",workflow],["tbc_sendWorkflow",workflow],
    ["tbc_signPreparedWorkflow",workflow],["tbc_sendPreparedWorkflow",workflow]]) {
    const result = await drive({engine:undefined,calls:[]},{method,request});
    assert.equal(result.transition.completion.response.error.code,-32602,method);
    assert.deepEqual(result.ports.map(call=>call.operation),["clock.now"],method);
  }
});

test("wallet-action approval evidence is projected once and rejects plan, account, context, preview and review tampering", async () => {
  for (const method of ["tbc_signReviewedTransaction", "tbc_encrypt", "tbc_decrypt"]) {
    const result = await drive({ engine: undefined, calls: [] }, {
      method,
      request: standaloneAction(method),
      stopAt: (_transition, call) => call.operation === "approval.request",
    });
    const evidence = tws.assertWalletActionApprovalEvidence({
      checkpoint: result.transition.checkpoint,
      approvalCall: result.call,
      approvalRequest: result.call.params,
    });
    assert.equal(evidence.method, method);
    assert.equal(evidence.chainId, result.transition.checkpoint.payload.operation.params.chainId);
    assert.equal(evidence.accountId, `${evidence.chainId}:${evidence.from}`);
    assert.equal(evidence.origin, context.origin);
    assert.equal(evidence.planHash, result.transition.checkpoint.payload.memory.walletActionPlan.planHash);
    assert.equal(evidence.approvalBinding.payload.operationHash, evidence.planHash);
    assert.equal(evidence.kind, method === "tbc_signReviewedTransaction" ? "reviewed-transaction" : "crypto");
    assert.equal(Object.hasOwn(evidence.task, "publicKey"), false);
    assert.ok(Object.isFrozen(evidence));
    assert.ok(Object.isFrozen(evidence.task));
  }

  const crypto = await drive({ engine: undefined, calls: [] }, {
    method: "tbc_encrypt",
    request: standaloneAction("tbc_encrypt"),
    stopAt: (_transition, call) => call.operation === "approval.request",
  });
  const rejectMutation = (mutate) => {
    const checkpoint = structuredClone(crypto.transition.checkpoint);
    mutate(checkpoint);
    checkpoint.checkpointHash = tws.hashCanonical(checkpoint.payload);
    const call = checkpoint.payload.pendingCalls.find(({ operation }) => operation === "approval.request");
    assert.ok(call);
    assert.throws(() => tws.assertWalletActionApprovalEvidence({
      checkpoint,
      approvalCall: call,
      approvalRequest: call.params,
    }));
  };
  rejectMutation(({ payload }) => {
    payload.memory.walletActionPlan.payload.task.message.data = "tampered";
    payload.memory.walletActionPlan.planHash = tws.hashCanonical(payload.memory.walletActionPlan.payload);
  });
  rejectMutation(({ payload }) => {
    payload.memory.accountResolutions[0].result.accounts[0].publicKey = `03${"11".repeat(32)}`;
  });
  rejectMutation(({ payload }) => {
    payload.memory.approvalPreview.message.data = "tampered";
  });
  rejectMutation(({ payload }) => {
    const binding = payload.memory.approvalBinding;
    binding.payload.origin = "https://evil.example";
    binding.bindingHash = tws.hashCanonical(binding.payload);
    const callBinding = payload.pendingCalls.find(({ operation }) => operation === "approval.request").params.binding;
    callBinding.payload.origin = binding.payload.origin;
    callBinding.bindingHash = binding.bindingHash;
  });
  const requestMutation = structuredClone(crypto.call.params);
  requestMutation.preview.message.data = "tampered";
  assert.throws(() => tws.assertWalletActionApprovalEvidence({
    checkpoint: crypto.transition.checkpoint,
    approvalCall: crypto.call,
    approvalRequest: requestMutation,
  }));

  const reviewed = await drive({ engine: undefined, calls: [] }, {
    method: "tbc_signReviewedTransaction",
    request: standaloneAction("tbc_signReviewedTransaction"),
    stopAt: (_transition, call) => call.operation === "approval.request",
  });
  const reviewedCheckpoint = structuredClone(reviewed.transition.checkpoint);
  for (const mutate of [
    checkpoint => { checkpoint.payload.memory.walletActionPlan.payload.task.policyMaterial.resolvedOutputs.push({txid:"22".repeat(32),vout:0,satoshis:"1",scriptPubKey:"51"}); },
    checkpoint => { delete checkpoint.payload.memory.walletActionPlan.payload.task.policyMaterial; },
  ]) {
    const changed = structuredClone(reviewed.transition.checkpoint);
    mutate(changed);
    changed.payload.memory.walletActionPlan.planHash = tws.hashCanonical(changed.payload.memory.walletActionPlan.payload);
    changed.checkpointHash = tws.hashCanonical(changed.payload);
    const call = changed.payload.pendingCalls.find(({operation}) => operation === "approval.request");
    assert.throws(() => tws.assertWalletActionApprovalEvidence({checkpoint:changed,approvalCall:call,approvalRequest:call.params}));
  }
  reviewedCheckpoint.payload.memory.walletActionPlan.payload.review.reviewHash = "11".repeat(32);
  reviewedCheckpoint.payload.memory.walletActionPlan.payload.task.reviewHash = "11".repeat(32);
  reviewedCheckpoint.payload.memory.walletActionPlan.planHash = tws.hashCanonical(
    reviewedCheckpoint.payload.memory.walletActionPlan.payload,
  );
  reviewedCheckpoint.checkpointHash = tws.hashCanonical(reviewedCheckpoint.payload);
  const reviewedCall = reviewedCheckpoint.payload.pendingCalls.find(
    ({ operation }) => operation === "approval.request",
  );
  assert.throws(() => tws.assertWalletActionApprovalEvidence({
    checkpoint: reviewedCheckpoint,
    approvalCall: reviewedCall,
    approvalRequest: reviewedCall.params,
  }));
});

test("standalone actions retain rejection, exact permission and reviewed-result checks", async () => {
  for (const method of ["tbc_signReviewedTransaction", "tbc_encrypt", "tbc_decrypt"]) {
    const request = standaloneAction(method);
    const rejected = await drive({ engine: undefined, calls: [] }, { method, request, reject: true });
    assert.equal(rejected.transition.completion.response.error.code, 4001);
    assert.equal(rejected.ports.some(c => c.operation.endsWith(".execute")), false);
    const denied = await drive({ engine: undefined, calls: [] }, {
      method, request, permissionCapabilities: ["tbc_accounts", "tbc_signWorkflow"],
    });
    assert.equal(denied.transition.completion.response.error.code, 4100);
  }
  await assert.rejects(() => drive({ engine: undefined, calls: [] }, {
    method: "tbc_signReviewedTransaction", request: standaloneAction("tbc_signReviewedTransaction"), invalidReviewedRequestHash: true,
  }), /approved review/);
});

test("standalone crypto and true workflow consume the same private execution result", async () => {
  const request = standaloneAction("tbc_encrypt");
  const single = await drive({ engine: undefined, calls: [] }, { method: "tbc_encrypt", request });
  const batch = await drive({ engine: undefined, calls: [] }, { request: {
    version: "1.0", chainId: request.chainId, from: request.from, expiresAt: request.expiresAt,
    steps: [
      { id: "first", kind: "encrypt", dependsOn: [], algorithm: request.algorithm, message: request.message },
      { id: "second", kind: "decrypt", dependsOn: ["first"], algorithm: request.algorithm, ciphertext: standaloneAction("tbc_decrypt").ciphertext },
    ],
  } });
  assert.equal(single.transition.completion.response.result.ciphertext, batch.transition.completion.response.result.steps[0].result.ciphertext);
  assert.equal(batch.ports.filter(c => c.operation === "approval.request").length, 1);
});

test("standalone private execution refuses navigation or approved-plan tampering", async () => {
  const result = await drive({ engine: undefined, calls: [] }, {
    method: "tbc_encrypt", request: standaloneAction("tbc_encrypt"),
    stopAt: (_transition, call) => call.operation === "crypto.execute",
  });
  const response = { version: "1.0", callId: result.call.callId, result: portResult(result.call, []) };
  await assert.rejects(() => result.core.resume({
    version: "1.0", checkpoint: result.transition.checkpoint, response,
    currentContext: { ...context, navigationId: "different-navigation" }, currentSession: session,
  }));
  const mutated = structuredClone(result.transition.checkpoint);
  mutated.payload.memory.walletActionPlan.payload.task.message.data = "changed";
  mutated.payload.memory.walletActionPlan.planHash = tws.hashCanonical(mutated.payload.memory.walletActionPlan.payload);
  mutated.checkpointHash = tws.hashCanonical(mutated.payload);
  await assert.rejects(() => result.core.resume({
    version: "1.0", checkpoint: mutated, response, currentContext: context, currentSession: session,
  }), /plan differs|binding|task changed/);
});

function permissionFor(capability) {
  const base = permissions.result[0];
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

function workflowEngine(options = {}) {
  const calls = [];
  const record = (operation, params) => calls.push({ operation, params: structuredClone(params) });
  const engine = Object.freeze({
    normalizeRequest(params) {
      record("normalizeRequest", params);
      return {
        request: structuredClone(params.request),
        requestHash: tws.hashCanonical(params.request),
      };
    },
    plan(params) {
      record("plan", params);
      if (options.rejectPlanAmount === params.request.intent.amount) {
        throw Object.assign(new Error("controlled invalid request"), {
          name: "TbcEngineError",
          code: "INVALID_REQUEST",
        });
      }
      const plan = structuredClone(canonical.plan);
      const suffix = params.request.intent.amount === "2" ? "-second" : "";
      if (suffix !== "") {
        for (const transaction of plan.payload.transactions) {
          transaction.id += suffix;
          if (options.overlapInputs !== true) {
            transaction.unsignedTransaction = `${transaction.unsignedTransaction.slice(0, 10)}${"22".repeat(32)}${transaction.unsignedTransaction.slice(74)}`;
            transaction.templateHash = "22".repeat(32);
          }
        }
        for (const task of plan.payload.signingTasks) {
          task.taskId += suffix;
          task.transactionTemplateId += suffix;
        }
      }
      plan.payload.requestHash = params.requestHash;
      plan.payload.snapshotHash = params.snapshot.snapshotHash;
      plan.payload.policyHash = params.policy.policyHash;
      plan.payload.chainId = params.request.chainId;
      plan.payload.accountId = `${params.request.chainId}:${params.request.from}`;
      plan.planHash = tws.hashCanonical(plan.payload);
      return { plan };
    },
    validate(params) {
      record(`validate:${params.phase}`, params);
      if (options.invalidPhase === params.phase) {
        return { valid: false, violations: [{ code: "WORKFLOW_TEST_FAILURE" }] };
      }
      return { valid: true, violations: [] };
    },
    finalize(params) {
      record("finalize", params);
      const stage = (params.continuation?.stage ?? 0) + 1;
      if (stage <= (options.pendingStages ?? 0)) {
        const task = { ...params.plan.payload.signingTasks[0], taskId: `stage-${stage}` };
        return {
          status: "pending",
          continuation: {
            version: "1.0", method: "finalize", family: "pool",
            requestHash: params.requestHash, planHash: params.plan.planHash,
            bindingHash: params.binding.bindingHash, approvalId: params.approval.approvalId,
            sessionId: session.scope.sessionId, stage: options.repeatStage && stage === 2 ? 1 : stage,
            stageCommitment: String(stage).repeat(64),
            signingStage: { signingRequests: [task] },
          },
          signingRequests: [task],
        };
      }
      const bundle = structuredClone(canonical.bundle);
      bundle.requestHash = params.requestHash;
      bundle.approvalId = params.approval.approvalId;
      if (options.artifactId !== undefined) {
        bundle.artifacts = { contractId: options.artifactId };
      }
      return {
        bundle,
        validation: options.invalidFinalize
          ? { valid: false, violations: [{ code: "SIGNATURE_INVALID" }] }
          : { valid: true, violations: [] },
      };
    },
  });
  return { engine, calls };
}

test("workflow retains multiple finalize stages without rewriting earlier signing evidence", async () => {
  const result = await drive(workflowEngine({ pendingStages: 2 }));
  assert.equal(result.transition.completion.response.error, undefined);
  assert.equal(result.ports.filter(call => call.operation === "approval.request").length, 1);
  const finalizes = result.engineCalls.filter(call => call.operation === "finalize");
  assert.equal(finalizes.length, 3);
  assert.deepEqual(finalizes.map(call => call.params.signatures.map(s => s.taskId)), [
    canonical.plan.payload.signingTasks.map(task => task.taskId), ["stage-1"], ["stage-2"],
  ]);
  const progress = result.transition.checkpoint.payload.memory.workflowProgress.steps[0];
  assert.deepEqual(progress.finalizationStages.map(s => s.continuation.stage), [1, 2]);

  // Checkpoint transitions must retain exact earlier continuation, signature and task bytes.
  const index = result.checkpoints.findIndex(c =>
    c.payload.memory.workflowProgress?.steps[0]?.finalizationStages?.length === 2);
  const previous = result.checkpoints[index - 1];
  const next = result.checkpoints[index];
  assert.deepEqual(tws.advanceCheckpoint(previous, next.payload), next);
  for (const change of [
    step => { step.finalizationStages[0].continuation.bindingHash = "ee".repeat(32); },
    step => { step.finalizationStages.reverse(); },
    step => { step.finalizationStages.shift(); },
    step => { step.signatures[0].signature = "ee".repeat(64); },
    step => { step.signingTasks[0].digest = "ee".repeat(32); },
  ]) {
    const payload = structuredClone(next.payload);
    change(payload.memory.workflowProgress.steps[0]);
    assert.throws(() => tws.advanceCheckpoint(previous, payload),
      error => error.code === "MEMORY_NOT_MONOTONIC");
  }
});

test("workflow rejects a replayed continuation before another signature", async () => {
  const result = await drive(workflowEngine({ pendingStages: 2, repeatStage: true }));
  assert.equal(result.transition.completion.response.error.code, -32603);
  assert.equal(result.ports.filter(call => call.operation === "signer.sign").length,
    canonical.plan.payload.signingTasks.length + 1);
});

function recoverableResult(task) {
  const digest = Uint8Array.from(Buffer.from(task.digest, "hex"));
  const signature = secp256k1.sign(digest, privateKey, {
    prehash: false,
    lowS: true,
  });
  const framed = Buffer.concat([
    Buffer.from([31 + signature.recovery]),
    Buffer.from(signature.toCompactRawBytes()),
  ]);
  return {
    taskId: task.taskId,
    signatureEncoding: task.signatureEncoding,
    signature: framed.toString("hex"),
  };
}

function portResult(call, clocks, options = {}) {
  switch (call.operation) {
    case "clock.now":
      return { now: clocks.shift() };
    case "permissionStore.load":
      return {
        revision: "0",
        permissions: (options.permissionCapabilities ?? [
          "tbc_accounts",
          "tbc_signWorkflow",
          "tbc_sendTransaction",
          "tbc_signTransaction",
          "tbc_signMessage",
          "tbc_signTypedData",
          "tbc_crypto",
        ]).map(permissionFor),
      };
    case "accounts.resolve":
      return integration.portData.accountsResult;
    case "chainData.resolve":
      return canonical.snapshot;
    case "policy.resolve":
      return options.policyResult?.(call) ?? canonical.policy;
    case "approval.request":
      if (options.reject) return { status: "rejected", bindingHash: call.params.binding.bindingHash, rejectedAt: "2026-08-31T12:00:10Z" };
      return {
        status: "approved",
        approvalId: "approval-workflow-1",
        approvalToken: "approval-token-workflow-1",
        bindingHash: call.params.binding.bindingHash,
        approvedAt: "2026-08-31T12:00:10Z",
        expiresAt: call.params.binding.payload.expiresAt,
      };
    case "signer.sign":
      if (call.params.task.purpose === "transaction") {
        return { ...canonical.signature, taskId: call.params.task.taskId };
      }
      return options.invalidTypedSignature
        ? {
            taskId: call.params.task.taskId,
            signatureEncoding: call.params.task.signatureEncoding,
            signature: "1f".repeat(65),
          }
        : recoverableResult(call.params.task);
    case "crypto.execute":
      return call.params.task.purpose === "encrypt"
        ? {
            taskId: call.params.task.taskId,
            algorithm: call.params.task.algorithm,
            ciphertext: Buffer.alloc(85, 7).toString("base64"),
          }
        : {
            taskId: call.params.task.taskId,
            algorithm: call.params.task.algorithm,
          message: { encoding: "hex", data: "68656c6c6f" },
        };
    case "reviewedTransaction.review": {
      const payload = {
        preview: {
          operationKind: "transaction",
          assetFlows: [],
          totalFee: "0",
          transactionCount: 1,
          warnings: [],
          irreversible: true,
        },
        totalFee: "0",
        expiresAt: "2026-08-31T12:02:00Z",
      };
      payload.policyMaterial = { resolvedOutputs: [] };
      return { payload, reviewHash: tws.hashCanonical(payload) };
    }
    case "reviewedTransaction.execute": {
      const bundle = structuredClone(canonical.bundle);
      bundle.requestHash = options.invalidReviewedRequestHash
        ? "f".repeat(64)
        : call.params.task.requestHash;
      bundle.approvalId = call.params.approval.approvalId;
      bundle.totalFee = "0";
      if (options.reviewedDetachedSignatures !== undefined) {
        bundle.detachedSignatures = options.reviewedDetachedSignatures;
      }
      return {
        taskId: call.params.task.taskId,
        reviewHash: call.params.task.reviewHash,
        bundle,
      };
    }
    case "broadcast.submitBatch":
      return {
        transactions: call.params.transactions.map(({ txid }) => ({
          txid,
          status: "accepted",
        })),
      };
    default:
      throw new Error(`unexpected Port operation: ${call.operation}`);
  }
}

async function drive(engineFixture, options = {}) {
  const request = options.request ?? vector.request;
  const method = options.method ?? "tbc_signWorkflow";
  const coreDependencies = {
    transactionEngine: engineFixture.engine,
    ...(options.legacyBitcoinMessageDigest === undefined
      ? {}
      : { legacyBitcoinMessageDigest: options.legacyBitcoinMessageDigest }),
  };
  let core = tws.createTwsCore(coreDependencies);
  const ports = [];
  const checkpoints = [];
  const clocks = [
    "2026-08-31T12:00:00Z",
    "2026-08-31T12:00:05Z",
    ...Array.from(
      { length: 20 },
      (_, index) => `2026-08-31T12:00:${String(index + 11).padStart(2, "0")}Z`,
    ),
  ];
  let transition = await core.start({
    version: "1.0",
    release: tws.TWS_RELEASE,
    request: {
      jsonrpc: "2.0",
      id: "workflow-order-1",
      method,
      params: request,
    },
    currentContext: context,
    currentSession: session,
  });
  for (let steps = 0; transition.kind !== "complete"; steps += 1) {
    assert.ok(steps < 40, "workflow signing did not terminate");
    checkpoints.push(transition.checkpoint);
    assert.equal("completion" in transition, false, "partial workflow result escaped");
    if (
      options.restoreAfterTransaction &&
      transition.checkpoint.payload.state === "finalizing" &&
      transition.checkpoint.payload.memory.workflowProgress?.steps[0]?.status === "finalized"
    ) {
      core = tws.createTwsCore(coreDependencies);
    }
    if (transition.kind === "continue") {
      transition = await core.resume({
        version: "1.0",
        checkpoint: transition.checkpoint,
        currentContext: context,
        currentSession: session,
      });
      continue;
    }
    const call = transition.calls[0];
    ports.push(structuredClone(call));
    if (options.stopAt?.(transition, call)) {
      return {
        core,
        transition,
        call,
        ports,
        checkpoints,
        engineCalls: engineFixture.calls,
      };
    }
    const fail = options.failPort?.(call) === true;
    transition = await core.resume({
      version: "1.0",
      checkpoint: transition.checkpoint,
      response: {
        version: "1.0",
        callId: call.callId,
        ...(fail
          ? {
              error: {
                name: "UNAVAILABLE",
                message: "controlled workflow child failure",
                retryable: false,
              },
            }
          : { result: portResult(call, clocks, options) }),
      },
      currentContext: context,
      currentSession: session,
    });
  }
  checkpoints.push(transition.checkpoint);
  return { transition, ports, checkpoints, engineCalls: engineFixture.calls };
}

function preparedWorkflowRequest() {
  const request = structuredClone(vector.request);
  const transaction = canonical.plan.payload.transactions[0];
  const intent = request.steps[0].intent;
  const snapshot = canonical.snapshot.payload;
  const payload = {
    version: "1.0",
    engineProfile: "tbc-engine-plan-v1",
    createdAt: snapshot.capturedAt,
    expiresAt: canonical.plan.payload.expiresAt,
    intentHash: tws.hashCanonical(intent),
    transactions: [{
      id: transaction.id,
      role: transaction.role,
      dependsOn: transaction.dependsOn,
      kind: "fixed",
      unsignedTransaction: transaction.unsignedTransaction,
      fee: transaction.fee,
    }],
    evidence: {
      observedAt: snapshot.capturedAt,
      parentTransactions: snapshot.parents.map(({ txid, rawTransaction }) => ({ txid, rawTransaction })),
      contracts: [],
    },
    estimatedTotalFee: canonical.plan.payload.preview.totalFee,
  };
  request.steps[0] = {
    ...request.steps[0],
    kind: "preparedTransaction",
    proposal: { payload, proposalHash: tws.hashCanonical(payload) },
  };
  return request;
}

test("prepared workflow independently replans and signs its approved proposal", async () => {
  const result = await drive(workflowEngine(), {
    method: "tbc_signPreparedWorkflow",
    request: preparedWorkflowRequest(),
  });
  assert.equal(result.transition.checkpoint.payload.state, "completed");
  assert.equal(result.transition.completion.response.result.steps[0].kind, "preparedTransaction");
  assert.equal(result.transition.completion.response.result.steps[1].kind, "typedData");
  assert.equal(
    result.transition.checkpoint.payload.memory.approvalBinding.payload.method,
    "tbc_signPreparedWorkflow",
  );
});

test("Prepared workflow uses the earliest child proposal expiry", async () => {
  for (const expiresAt of ["2026-08-31T12:00:00Z", "2026-08-31T12:00:30Z"]) {
    const request = preparedWorkflowRequest();
    request.steps[0].proposal.payload.expiresAt = expiresAt;
    request.steps[0].proposal.proposalHash = tws.hashCanonical(request.steps[0].proposal.payload);
    const result = await drive(workflowEngine(), { method: "tbc_signPreparedWorkflow", request });
    if (expiresAt.endsWith("00:00Z")) {
      assert.equal(result.transition.completion.response.error?.code, 4100);
      assert.deepEqual(result.ports.map(p => p.operation), ["clock.now"]);
      assert.equal(result.engineCalls.length, 0);
    } else {
      assert.equal(result.transition.checkpoint.payload.state, "completed");
      assert.equal(result.ports.find(p => p.operation === "approval.request").params.binding.payload.expiresAt, expiresAt);
      assert.equal(result.ports.filter(p => p.operation === "chainData.resolve").length, 1);
    }
  }
});

test("Prepared batch cannot hide an expired later proposal or expire while UI is open", async () => {
  for (const method of ["tbc_signPreparedWorkflow", "tbc_sendPreparedWorkflow"]) {
    const request = preparedWorkflowRequest();
    const expired = structuredClone(request.steps[0]);
    expired.id = "expired-child";
    expired.proposal.payload.expiresAt = "2026-08-31T12:00:00Z";
    expired.proposal.proposalHash = tws.hashCanonical(expired.proposal.payload);
    request.steps.push(expired);
    const result = await drive(workflowEngine(), { method, request });
    assert.equal(result.transition.completion.response.error?.code, 4100);
    assert.deepEqual(result.ports.map(p => p.operation), ["clock.now"]);

    const live = preparedWorkflowRequest();
    live.steps[0].proposal.payload.expiresAt = "2026-08-31T12:00:11Z";
    live.steps[0].proposal.proposalHash = tws.hashCanonical(live.steps[0].proposal.payload);
    const late = await drive(workflowEngine(), { method, request: live });
    assert.equal(late.transition.completion.response.error?.code, 4100);
    assert.equal(late.ports.filter(p => p.operation === "approval.request").length, 1);
    assert.equal(late.ports.some(p => p.operation === "signer.sign" || p.operation.startsWith("broadcast.")), false);
  }
});

test("prepared workflow rejects a caller-tampered proposal hash as Invalid Params", async () => {
  const request = preparedWorkflowRequest();
  request.steps[0].proposal.proposalHash = "0".repeat(64);
  const result = await drive(workflowEngine(), {
    method: "tbc_signPreparedWorkflow",
    request,
  });
  assert.deepEqual(result.transition.completion.response.error, {
    code: -32602,
    message: "Prepared proposal hash does not match its payload",
  });
  assert.deepEqual(result.ports.map(({ operation }) => operation), ["clock.now"]);
  assert.deepEqual(result.engineCalls, []);
});

test("Prepared workflow independent clocks cannot extend wallet approval expiry", async () => {
  for (const method of ["tbc_signPreparedWorkflow", "tbc_sendPreparedWorkflow"]) {
    const request = preparedWorkflowRequest();
    const proposal = request.steps[0].proposal;
    proposal.payload.createdAt = new Date(Date.parse(proposal.payload.createdAt) + 1000).toISOString();
    proposal.payload.evidence.observedAt = proposal.payload.createdAt;
    proposal.payload.expiresAt = new Date(Date.parse(proposal.payload.expiresAt) + 1000).toISOString();
    proposal.proposalHash = tws.hashCanonical(proposal.payload);
    const result = await drive(workflowEngine(), {method, request});
    assert.equal(result.transition.checkpoint.payload.state, "completed");
    const approvals = result.ports.filter(p => p.operation === "approval.request");
    assert.equal(approvals.length, 1);
    assert.ok(Date.parse(approvals[0].params.binding.payload.expiresAt) <= Date.parse(canonical.plan.payload.expiresAt));
    assert.equal(result.ports.filter(p => p.operation === "chainData.resolve").length, 1);
  }
});

test("send workflow reuses one approval and emits one ordered batch submit", async () => {
  const result = await drive(workflowEngine(), {
    method: "tbc_sendWorkflow",
    permissionCapabilities: [
      "tbc_accounts",
      "tbc_signWorkflow",
      "tbc_signTransaction",
      "tbc_signTypedData",
      "tbc_sendTransaction",
    ],
  });
  assert.equal(result.transition.completion.response.result.status, "complete");
  assert.equal(result.transition.completion.response.result.workflow.steps.length, 2);
  assert.deepEqual(
    result.ports.filter(({ operation }) => operation.startsWith("broadcast."))
      .map(({ operation }) => operation),
    ["broadcast.submitBatch"],
  );
  assert.equal(result.ports.filter(({ operation }) => operation === "approval.request").length, 1);
});

test("workflow signs and finalizes by topology, derives txids, and returns atomically", async (t) => {
  const result = await drive(workflowEngine());
  t.diagnostic(`checkpoints=${result.checkpoints.length} ports=${result.ports.length} engineCalls=${result.engineCalls.length}`);
  assert.equal(result.checkpoints.filter((checkpoint) =>
    checkpoint.payload.state === "planning").length, 0,
  "a freshly prepared workflow must enter approval without a Host round trip");
  assert.deepEqual(
    result.ports.map(({ operation }) => operation),
    [
      "clock.now",
      "permissionStore.load",
      "accounts.resolve",
      "chainData.resolve",
      "policy.resolve",
      "clock.now",
      "approval.request",
      "clock.now",
      "signer.sign",
      "clock.now",
      "clock.now",
      "signer.sign",
    ],
  );
  assert.equal(
    result.ports.some(({ operation }) => operation.startsWith("broadcast.")),
    false,
  );
  assert.deepEqual(
    result.engineCalls.map(({ operation }) => operation),
    [
      "normalizeRequest",
      "plan",
      "validate:plan",
      "normalizeRequest",
      "validate:pre-sign",
      "normalizeRequest",
      "finalize",
      "validate:finalized",
    ],
  );
  const output = result.transition.completion.response.result;
  assert.equal(output.workflowPlanHash, result.transition.checkpoint.payload.memory.workflowPlan.workflowPlanHash);
  assert.deepEqual(output.steps.map(({ id, kind }) => ({ id, kind })), [
    { id: "trade", kind: "transaction" },
    { id: "order", kind: "typedData" },
  ]);
  assert.equal(
    output.steps[1].result.envelope.message.txids[0],
    output.steps[0].result.transactions[0].txid,
  );
  assert.equal(
    output.steps[1].result.digest,
    tws.signingEnvelopeDigest(output.steps[1].result.envelope),
  );
  assert.equal(
    result.transition.checkpoint.payload.memory.workflowProgress.completedStepIds.length,
    2,
  );
});

test("multiple transaction steps share one snapshot but bind distinct policies", async () => {
  const request = structuredClone(vector.request);
  request.maxTotalFee = "160";
  request.steps = [
    request.steps[0],
    {
      ...structuredClone(request.steps[0]),
      id: "trade-second",
      dependsOn: ["trade"],
      intent: { ...request.steps[0].intent, amount: "2" },
    },
  ];
  const policies = new Map();
  const policyResult = (call) => {
    const policy = structuredClone(canonical.policy);
    policy.payload.policyId = `policy-${call.params.request.intent.amount}`;
    policy.policyHash = tws.hashCanonical(policy.payload);
    policies.set(call.params.requestHash, policy.policyHash);
    return policy;
  };
  const result = await drive(workflowEngine(), { request, policyResult });
  assert.equal(result.transition.checkpoint.payload.state, "completed");
  assert.equal(
    result.ports.filter(({ operation }) => operation === "chainData.resolve").length,
    1,
  );
  assert.equal(
    result.ports.filter(({ operation }) => operation === "policy.resolve").length,
    2,
  );
  const plans = result.transition.checkpoint.payload.memory.workflowPlan.payload.transactionPlans;
  assert.equal(plans.length, 2);
  for (const { plan } of plans) {
    assert.equal(plan.payload.policyHash, policies.get(plan.payload.requestHash));
  }
  assert.notEqual(plans[0].plan.payload.policyHash, plans[1].plan.payload.policyHash);
});

test("workflow Chain Data carries the stable exact union of explicit native inputs", async () => {
  const request = structuredClone(vector.request);
  const first = { txid: "11".repeat(32), vout: 0 };
  const second = { txid: "22".repeat(32), vout: 1 };
  request.maxTotalFee = "160";
  request.steps = [
    { ...request.steps[0], constraints: { ...request.steps[0].constraints, inputOutpoints: [first] } },
    {
      ...structuredClone(request.steps[0]),
      id: "trade-second-explicit",
      dependsOn: [],
      intent: { ...request.steps[0].intent, amount: "2" },
      constraints: { ...request.steps[0].constraints, inputOutpoints: [second, first] },
    },
  ];
  const result = await drive(workflowEngine(), {
    request,
    stopAt: (_transition, call) => call.operation === "chainData.resolve",
  });
  assert.deepEqual(result.call.params.requirement.inputOutpoints, [first, second]);
});

test("deterministic workflow planning rejection returns a Provider invalid-request error", async () => {
  const request = structuredClone(vector.request);
  request.maxTotalFee = "160";
  request.steps = [
    request.steps[0],
    {
      ...structuredClone(request.steps[0]),
      id: "trade-invalid-plan",
      dependsOn: [],
      intent: { ...request.steps[0].intent, amount: "2" },
    },
  ];
  const result = await drive(workflowEngine({ rejectPlanAmount: "2" }), { request });
  assert.equal(result.transition.checkpoint.payload.state, "failed");
  assert.deepEqual(result.transition.completion.response.error, {
    code: -32602,
    message: "Workflow planning rejected the invalid request",
  });
  assert.equal(result.ports.some(({ operation }) => operation === "approval.request"), false);
  assert.equal(result.ports.some(({ operation }) => operation === "signer.sign"), false);
  assert.equal(result.ports.some(({ operation }) => operation.startsWith("broadcast.")), false);
});

test("workflow fails closed when transaction steps select the same input outpoint", async () => {
  const request = structuredClone(vector.request);
  request.maxTotalFee = "160";
  request.steps = [
    request.steps[0],
    {
      ...structuredClone(request.steps[0]),
      id: "trade-overlap",
      dependsOn: [],
      intent: { ...request.steps[0].intent, amount: "2" },
    },
  ];
  await assert.rejects(
    drive(workflowEngine({ overlapInputs: true }), { request }),
    /same input outpoint/,
  );
});

test("workflow resumes after an upstream bundle was finalized", async () => {
  const result = await drive(workflowEngine(), { restoreAfterTransaction: true });
  assert.equal(result.transition.checkpoint.payload.state, "completed");
  assert.equal(result.transition.completion.response.result.steps.length, 2);
});

test("workflow derives an approved contract artifact without adding a replacement", async () => {
  const artifactId = "3".repeat(64);
  const request = structuredClone(vector.request);
  request.steps[1] = {
    id: "order",
    kind: "typedData",
    dependsOn: ["trade"],
    data: {
      domain: {
        name: "DurianSwap Contract",
        version: "1",
        origin: context.origin,
        chainId: vector.request.chainId,
      },
      types: {
        Contract: [{ name: "contractId", type: "bytes32" }],
      },
      primaryType: "Contract",
      message: { contractId: { $tbcBinding: "unresolved" } },
    },
    bindings: [{
      target: "/message/contractId",
      source: { stepId: "trade", output: "artifacts.contractId" },
    }],
  };
  const result = await drive(workflowEngine({ artifactId }), { request });
  assert.equal(
    result.transition.completion.response.result.steps[1].result.envelope.message.contractId,
    artifactId,
  );
  assert.equal(
    Object.keys(
      result.transition.completion.response.result.steps[1].result.envelope.message,
    ).length,
    1,
  );
});

test("workflow failure after a transaction signature never exposes partial results", async () => {
  const result = await drive(workflowEngine({ invalidFinalize: true }));
  assert.equal(result.transition.checkpoint.payload.state, "failed");
  assert.equal("result" in result.transition.completion.response, false);
  assert.equal("steps" in result.transition.completion.response.error, false);
  assert.equal("signatures" in result.transition.completion.response.error, false);
});

test("workflow rejects a rehashed deferred source and target type before approval", async () => {
  const reached = await drive(workflowEngine(), {
    stopAt: (transition, call) =>
      transition.checkpoint.payload.state === "approval" &&
      call.operation === "clock.now",
  });
  const forged = structuredClone(reached.transition.checkpoint);
  // The immutable checkpoint may structurally share request bindings with its
  // derived plan. An attacker changing only the derived plan must not mutate
  // the operation request as an accidental side effect of this test clone.
  const plan = structuredClone(forged.payload.memory.workflowPlan);
  forged.payload.memory.workflowPlan = plan;
  plan.payload.deferredSigningTasks[0].source.output = "primaryTransactionId";
  plan.payload.deferredSigningTasks[0].targetType = "bytes32";
  plan.payload.preview.bindings[0].sourceOutput = "primaryTransactionId";
  plan.payload.preview.bindings[0].targetType = "bytes32";
  plan.workflowPlanHash = tws.hashCanonical(plan.payload);
  const binding = forged.payload.memory.approvalBinding;
  binding.payload.operationHash = plan.workflowPlanHash;
  binding.bindingHash = tws.hashCanonical(binding.payload);
  forged.checkpointHash = tws.hashCanonical(forged.payload);

  await assert.rejects(
    reached.core.resume({
      version: "1.0",
      checkpoint: forged,
      response: {
        version: "1.0",
        callId: reached.call.callId,
        result: { now: "2026-08-31T12:00:05Z" },
      },
      currentContext: context,
      currentSession: session,
    }),
    (error) =>
      error instanceof tws.TwsEngineError &&
      error.code === "ENGINE_ARTIFACT_MISMATCH",
  );
});

test("five explicit typed-data steps preserve topology without entropy", async () => {
  const txid = "2".repeat(64);
  const steps = Array.from({ length: 5 }, (_, index) => ({
    id: `order-${String(index + 1)}`,
    kind: "typedData",
    dependsOn: index === 0 ? [] : [`order-${String(index)}`],
    data: {
      domain: {
        name: "Workflow Orders",
        version: "1",
        origin: context.origin,
        chainId: vector.request.chainId,
      },
      types: {
        Order: [
          { name: "side", type: "string" },
          { name: "txids", type: "bytes32[]" },
        ],
      },
      primaryType: "Order",
      message: { side: "buy", txids: [txid] },
    },
    bindings: [],
  }));
  const request = {
    version: "1.0",
    chainId: vector.request.chainId,
    from: vector.request.from,
    expiresAt: vector.request.expiresAt,
    maxTotalFee: "0",
    steps,
  };
  const result = await drive(
    { engine: undefined, calls: [] },
    { request },
  );
  const output = result.transition.completion.response.result;
  assert.equal(output.steps.length, 5);
  assert.deepEqual(
    output.steps.map(({ id }) => id),
    steps.map(({ id }) => id),
  );
  assert.equal(
    result.ports.some(({ operation }) => operation === "entropy.randomBytes"),
    false,
  );
  assert.equal(
    result.ports.some(({ operation }) =>
      ["chainData.resolve", "policy.resolve", "broadcast.submit"].includes(operation),
    ),
    false,
  );
});

test("standard message step shares one workflow approval and performs no chain read", async () => {
  const request = {
    version: "1.0",
    chainId: vector.request.chainId,
    from: vector.request.from,
    expiresAt: vector.request.expiresAt,
    maxTotalFee: "0",
    steps: [{
      id: "message",
      kind: "message",
      dependsOn: [],
      message: { encoding: "utf8", data: "standard workflow message" },
    }],
  };
  const result = await drive({ engine: undefined, calls: [] }, { request });
  const output = result.transition.completion.response.result;
  assert.equal(output.steps[0].kind, "message");
  assert.equal(output.steps[0].result.scheme, "tbc-message");
  assert.deepEqual(output.steps[0].result.envelope.message, request.steps[0].message);
  assert.equal(
    result.ports.filter(({ operation }) => operation === "approval.request").length,
    1,
  );
  assert.equal(
    result.ports.some(({ operation }) =>
      operation === "chainData.resolve" || operation === "policy.resolve"
    ),
    false,
  );
});

test("standard crypto steps use the wallet secret port, one approval, and zero chain reads", async () => {
  const algorithm = "tbc-bie1-secp256k1-aes128-cbc-hmac-sha256-v1";
  const request = {
    version: "1.0",
    chainId: vector.request.chainId,
    from: vector.request.from,
    expiresAt: vector.request.expiresAt,
    maxTotalFee: "0",
    steps: [
      {
        id: "encrypt",
        kind: "encrypt",
        dependsOn: [],
        algorithm,
        message: { encoding: "utf8", data: "hello" },
      },
      {
        id: "decrypt",
        kind: "decrypt",
        dependsOn: ["encrypt"],
        algorithm,
        ciphertext: Buffer.alloc(85, 9).toString("base64"),
      },
    ],
  };
  const result = await drive({ engine: undefined, calls: [] }, { request });
  const output = result.transition.completion.response.result;
  assert.deepEqual(output.steps.map(({ kind }) => kind), ["encrypt", "decrypt"]);
  assert.equal(output.steps[0].result.algorithm, algorithm);
  assert.deepEqual(output.steps[1].result.message, { encoding: "hex", data: "68656c6c6f" });
  assert.equal(
    result.ports.filter(({ operation }) => operation === "approval.request").length,
    1,
  );
  assert.equal(
    result.ports.filter(({ operation }) => operation === "crypto.execute").length,
    2,
  );
  assert.equal(
    result.ports.some(({ operation }) =>
      operation === "chainData.resolve" || operation === "policy.resolve"
    ),
    false,
  );
});

function reviewedWorkflowRequest() {
  return {
    version: "1.0",
    chainId: vector.request.chainId,
    from: vector.request.from,
    expiresAt: vector.request.expiresAt,
    maxTotalFee: "0",
    steps: [{
      id: "reviewed",
      kind: "reviewedTransaction",
      dependsOn: [],
      request: {
        payload: {
          format: "raw",
          transactions: [{
            rawTransaction: "00",
            inputs: [{ satoshis: "1", scriptPubKey: "00" }],
          }],
        },
      },
    }],
  };
}

test("reviewed transaction binds pre-approval review to one post-approval wallet execution", async () => {
  const result = await drive(
    { engine: undefined, calls: [] },
    { request: reviewedWorkflowRequest() },
  );
  assert.equal(result.transition.checkpoint.payload.state, "completed");
  assert.equal(result.transition.completion.response.result.steps[0].kind, "reviewedTransaction");
  assert.equal(
    result.ports.filter(({ operation }) => operation === "reviewedTransaction.review").length,
    1,
  );
  assert.equal(
    result.ports.filter(({ operation }) => operation === "approval.request").length,
    1,
  );
  assert.equal(
    result.ports.filter(({ operation }) => operation === "reviewedTransaction.execute").length,
    1,
  );
  assert.equal(
    result.ports.some(({ operation }) =>
      operation === "chainData.resolve" || operation === "policy.resolve" ||
      operation === "signer.sign"
    ),
    false,
  );
  const review = result.transition.checkpoint.payload.memory.reviewedTransactionReviews[0];
  const task = result.transition.checkpoint.payload.memory.workflowPlan.payload.reviewedTransactionTasks[0];
  assert.equal(review.reviewHash, tws.hashCanonical(review.payload));
  assert.equal(task.reviewHash, review.reviewHash);
  assert.deepEqual(task.policyMaterial, review.payload.policyMaterial);
  assert.equal(task.contextHash, result.transition.checkpoint.payload.contextHash);
});

test("reviewed transaction rejects a wallet result rebound to another request", async () => {
  await assert.rejects(
    drive(
      { engine: undefined, calls: [] },
      { request: reviewedWorkflowRequest(), invalidReviewedRequestHash: true },
    ),
    (error) =>
      error instanceof tws.TwsStateError && error.code === "PORT_RESULT_INVALID",
  );
});

test("reviewed raw transaction exposes detached signatures bound to its approved input matrix", async () => {
  const result = await drive(
    { engine: undefined, calls: [] },
    {
      request: reviewedWorkflowRequest(),
      reviewedDetachedSignatures: [["aa"]],
    },
  );
  assert.deepEqual(
    result.transition.completion.response.result.steps[0].result.detachedSignatures,
    [["aa"]],
  );
  await assert.rejects(
    drive(
      { engine: undefined, calls: [] },
      {
        request: reviewedWorkflowRequest(),
        reviewedDetachedSignatures: [["aa", "bb"]],
      },
    ),
    (error) =>
      error instanceof tws.TwsStateError && error.code === "PORT_RESULT_INVALID",
  );
});

test("reviewed transaction IDs bind one later JSON message under the same approval", async () => {
  const request = reviewedWorkflowRequest();
  request.steps.push({
    id: "receipt",
    kind: "message",
    dependsOn: ["reviewed"],
    message: { encoding: "utf8", data: JSON.stringify({ order: "42" }) },
    bindings: [{
      target: "settlement",
      source: { stepId: "reviewed", output: "transactionIds" },
    }],
  });
  const standard = await drive({ engine: undefined, calls: [] }, { request });
  const standardMessage = standard.transition.completion.response.result.steps[1].result;
  assert.equal(standardMessage.scheme, "tbc-message");
  assert.deepEqual(
    JSON.parse(standardMessage.envelope.message.data).settlement,
    canonical.bundle.transactions.map(({ txid }) => txid),
  );
  assert.equal(
    standard.ports.filter(({ operation }) => operation === "approval.request").length,
    1,
  );

  let trustedDigests = 0;
  const legacy = await drive({ engine: undefined, calls: [] }, {
    request,
    async legacyBitcoinMessageDigest({ message }) {
      trustedDigests += 1;
      return tws.hashCanonical({ domain: "controlled-legacy-bitcoin-message", message });
    },
  });
  const legacyMessage = legacy.transition.completion.response.result.steps[1].result;
  assert.equal(legacyMessage.scheme, "legacy-bitcoin-message");
  assert.equal(Object.hasOwn(legacyMessage, "signingPayload"), false);
  assert.equal(trustedDigests, 2, "trusted profile checks the approved template and resolved message");
});

test("private deferred task verification rederives trusted Legacy dependencies and fails closed without authority", async () => {
  const request = reviewedWorkflowRequest();
  request.steps.push({ id: "receipt", kind: "message", dependsOn: ["reviewed"],
    message: { encoding: "utf8", data: JSON.stringify({ order: "42" }) },
    bindings: [{ target: "txids", source: { stepId: "reviewed", output: "transactionIds" } }],
  });
  const messages = [];
  const digest = ({ message }) => {
    messages.push(JSON.parse(message.data));
    return tws.hashCanonical({ domain: "controlled-legacy-bitcoin-message", message });
  };
  const result = await drive({ engine: undefined, calls: [] }, {
    request, legacyBitcoinMessageDigest: digest,
    stopAt: (_transition, call) => call.operation === "signer.sign" && call.params.task.purpose === "message",
  });
  const checkpoint = result.transition.checkpoint, task = result.call.params.task;
  await assert.rejects(tws.assertWorkflowDeferredSigningTask(checkpoint, "receipt", task));
  await tws.assertWorkflowDeferredSigningTask(checkpoint, "receipt", task, digest);
  assert.deepEqual(messages.at(-1), { order: "42", txids: canonical.bundle.transactions.map(({ txid }) => txid) });
  for (const changed of [{ ...task, digest: "00".repeat(32) }, { ...task, accountId: "other" }, { ...task, origin: "https://evil.example" }]) {
    await assert.rejects(tws.assertWorkflowDeferredSigningTask(checkpoint, "receipt", changed, digest));
  }
  await assert.rejects(tws.assertWorkflowDeferredSigningTask(checkpoint, "receipt", task, () => "00".repeat(32)));
  await assert.rejects(tws.assertWorkflowDeferredSigningTask(checkpoint, "receipt", task, () => undefined));
  await assert.rejects(tws.assertWorkflowDeferredSigningTask(checkpoint, "unapproved", task, digest));
  const changedDependency = structuredClone(checkpoint);
  changedDependency.payload.memory.workflowProgress.steps[0].reviewedTransactionResult.bundle.transactions[0].txid = "00".repeat(32);
  await assert.rejects(tws.assertWorkflowDeferredSigningTask(changedDependency, "receipt", task, digest));
});

test("continue-independent records one child failure, skips dependents, and runs independent children", async () => {
  const algorithm = "tbc-bie1-secp256k1-aes128-cbc-hmac-sha256-v1";
  const request = {
    version: "1.0",
    chainId: vector.request.chainId,
    from: vector.request.from,
    expiresAt: vector.request.expiresAt,
    maxTotalFee: "0",
    failureMode: "continue-independent",
    steps: [
      {
        id: "fails",
        kind: "encrypt",
        dependsOn: [],
        algorithm,
        message: { encoding: "utf8", data: "first" },
      },
      {
        id: "blocked",
        kind: "decrypt",
        dependsOn: ["fails"],
        algorithm,
        ciphertext: Buffer.alloc(85, 3).toString("base64"),
      },
      {
        id: "independent",
        kind: "encrypt",
        dependsOn: [],
        algorithm,
        message: { encoding: "utf8", data: "third" },
      },
    ],
  };
  const result = await drive({ engine: undefined, calls: [] }, {
    request,
    failPort(call) {
      return call.operation === "crypto.execute" && call.params.task.taskId === "crypto-fails";
    },
  });
  const output = result.transition.completion.response.result;
  assert.equal(output.failureMode, "continue-independent");
  assert.deepEqual(output.steps.map((step) => step.status ?? "completed"), [
    "failed",
    "skipped",
    "completed",
  ]);
  assert.equal(output.steps[0].error.code, "HOST_UNAVAILABLE");
  assert.equal(output.steps[1].error.code, "DEPENDENCY_FAILED");
  assert.equal(output.steps[2].result.taskId, "crypto-independent");
  assert.equal(
    result.ports.filter(({ operation }) => operation === "approval.request").length,
    1,
  );
  assert.deepEqual(
    result.ports.filter(({ operation }) => operation === "crypto.execute")
      .map(({ params }) => params.task.taskId),
    ["crypto-fails", "crypto-independent"],
  );
});

test("workflow crypto requires its dedicated permission before approval or secret execution", async () => {
  const request = {
    ...vector.request,
    steps: [{
      id: "encrypt-only",
      kind: "encrypt",
      dependsOn: [],
      algorithm: "tbc-bie1-secp256k1-aes128-cbc-hmac-sha256-v1",
      message: { encoding: "utf8", data: "permission-bound" },
    }],
  };
  const result = await drive(workflowEngine(), {
    request,
    permissionCapabilities: ["tbc_accounts", "tbc_signWorkflow"],
  });
  assert.equal(result.transition.completion.response.error.code, 4100);
  assert.equal(result.ports.some(({ operation }) => operation === "approval.request"), false);
  assert.equal(result.ports.some(({ operation }) => operation === "crypto.execute"), false);
});
