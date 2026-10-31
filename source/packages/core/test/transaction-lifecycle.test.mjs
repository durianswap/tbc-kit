import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { withOutputReview } from "../../../scripts/lib/reviewed-transfer-fixture.mjs";
import * as tws from "../dist/esm/index.js";
import { createTbcTransferEngine, createSourceTbcTransferEngine } from "./fixtures/tbc-transfer-engine.mjs";

const integration = JSON.parse(
  await readFile(new URL("../../../test-vectors/integration.json", import.meta.url), "utf8"),
);
const provider = JSON.parse(
  await readFile(new URL("../../../test-vectors/provider.json", import.meta.url), "utf8"),
);
const permissions = JSON.parse(
  await readFile(new URL("../../../test-vectors/permissions.json", import.meta.url), "utf8"),
);
const context = provider.trustedContexts[0].context;
const session = provider.providerSessions.sessionA;
const canonical = withOutputReview(integration.canonicalTransfer);

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

function startInput(method, params = canonical.request) {
  return {
    version: "1.0",
    release: tws.TWS_RELEASE,
    request: {
      jsonrpc: "2.0",
      id: `canonical-${method}`,
      method,
      params,
    },
    currentContext: context,
    currentSession: session,
  };
}

function exactEngineFacade(engine, overrides = {}) {
  return Object.freeze({
    normalizeRequest: overrides.normalizeRequest ?? ((params) => engine.normalizeRequest(params)),
    plan: overrides.plan ?? ((params) => engine.plan(params)),
    validate: overrides.validate ?? ((params) => engine.validate(params)),
    finalize: overrides.finalize ?? ((params) => engine.finalize(params)),
  });
}

function changedPlanFixture() {
  const base = createTbcTransferEngine(integration);
  return {
    ...base,
    engine: exactEngineFacade(base.engine, {
      plan(params) {
        const result = base.engine.plan(params);
        const plan = structuredClone(result.plan);
        plan.payload.preview.totalFee = String(
          BigInt(plan.payload.preview.totalFee) + 1n,
        );
        return { plan };
      },
    }),
  };
}

function invalidPhaseFixture(phase, code) {
  const base = createTbcTransferEngine(integration);
  return {
    ...base,
    engine: exactEngineFacade(base.engine, {
      validate(params) {
        if (params.phase !== phase) return base.engine.validate(params);
        base.record(`validate:${params.phase}`, params);
        return { valid: false, violations: [{ code }] };
      },
    }),
  };
}

function changedBundleFixture(change) {
  const base = createTbcTransferEngine(integration);
  return {
    ...base,
    engine: exactEngineFacade(base.engine, {
      finalize(params) {
        const result = base.engine.finalize(params);
        const bundle = structuredClone(result.bundle);
        if (change === "bytes") {
          bundle.transactions[0].rawTransaction =
            `${bundle.transactions[0].rawTransaction.slice(0, -2)}01`;
        } else if (change === "txid") {
          bundle.transactions[0].txid = "f".repeat(64);
        } else if (change === "fee") {
          bundle.totalFee = String(BigInt(bundle.totalFee) + 1n);
        } else if (change === "artifact") {
          bundle.artifacts = { contractId: "e".repeat(64) };
        }
        return {
          bundle,
          validation: { valid: true, violations: [] },
        };
      },
    }),
  };
}

function multiTransactionFixture() {
  const base = createTbcTransferEngine(integration);
  const second = {
    ...structuredClone(canonical.bundle.transactions[0]),
    id: "tx-2",
    txid: "f".repeat(64),
    role: "maintenance",
    dependsOn: [canonical.bundle.transactions[0].id],
  };
  const bundle = {
    ...structuredClone(canonical.bundle),
    transactions: [structuredClone(canonical.bundle.transactions[0]), second],
  };
  const engine = exactEngineFacade(base.engine, {
    validate(params) {
      if (params.phase === "finalized" || params.phase === "pre-broadcast") {
        return { valid: true, violations: [] };
      }
      return base.engine.validate(params);
    },
    finalize(params) {
      base.engine.finalize(params);
      return {
        bundle: structuredClone(bundle),
        validation: { valid: true, violations: [] },
      };
    },
  });
  return { engine, calls: base.calls, bundle };
}

function multiSignerFixture() {
  const base = createTbcTransferEngine(integration);
  const secondTask = {
    ...structuredClone(canonical.plan.payload.signingTasks[0]),
    taskId: "sign-tx-1-input-1",
    digest: "f".repeat(64),
    inputIndex: 1,
  };
  const engine = exactEngineFacade(base.engine, {
    plan(params) {
      const result = base.engine.plan(params);
      const plan = structuredClone(result.plan);
      plan.payload.signingTasks.push(secondTask);
      plan.planHash = tws.hashCanonical(plan.payload);
      return { plan };
    },
    validate(params) {
      base.record(`validate:${params.phase}`, params);
      return { valid: true, violations: [] };
    },
    finalize(params) {
      base.record("finalize", params);
      return {
        bundle: structuredClone(canonical.bundle),
        validation: { valid: true, violations: [] },
      };
    },
  });
  return { engine, calls: base.calls, secondTask };
}

function stagedFinalizeFixture({ rejectPending = false } = {}) {
  const base = createTbcTransferEngine(integration);
  const secondTask = {
    ...structuredClone(canonical.plan.payload.signingTasks[0]),
    taskId: "sign-stage-2-input-0",
    digest: "e".repeat(64),
  };
  let continuation;
  const engine = exactEngineFacade(base.engine, {
    validate(params) {
      base.record(`validate:${params.phase}`, params);
      if (params.phase === "finalized" || params.phase === "pre-broadcast") {
        return rejectPending && params.pending !== undefined
          ? {
              valid: false,
              violations: [{ code: "ARTIFACT_MISMATCH", path: "/pending" }],
            }
          : { valid: true, violations: [] };
      }
      return base.engine.validate(params);
    },
    finalize(params) {
      base.record("finalize", params);
      if (params.continuation === undefined) {
        continuation = {
          version: "1.0",
          method: "finalize",
          family: "ft",
          requestHash: params.requestHash,
          planHash: params.plan.planHash,
          bindingHash: params.binding.bindingHash,
          approvalId: params.approval.approvalId,
          sessionId: "staged-session",
          stage: 1,
          stageCommitment: "d".repeat(64),
          signingStage: { opaque: "engine-owned" },
        };
        return {
          status: "pending",
          continuation,
          signingRequests: [secondTask],
        };
      }
      assert.deepEqual(params.continuation, continuation);
      assert.deepEqual(
        params.signatures.map(({ taskId }) => taskId),
        [secondTask.taskId],
      );
      return {
        bundle: structuredClone(canonical.bundle),
        validation: { valid: true, violations: [] },
      };
    },
  });
  return { engine, calls: base.calls, secondTask };
}

function portResult(call, method, clocks, overrides = {}) {
  if (overrides[call.operation]) return overrides[call.operation](call);
  switch (call.operation) {
    case "clock.now":
      return { now: clocks.shift() };
    case "permissionStore.load":
      {
        const capability = method === "tbc_signPreparedTransaction"
          ? "tbc_signTransaction"
          : method === "tbc_sendPreparedTransaction"
            ? "tbc_sendTransaction"
            : method;
      return {
        revision: "0",
        permissions: [permissionFor("tbc_accounts"), permissionFor(capability)],
      };
      }
    case "accounts.resolve":
      return integration.portData.accountsResult;
    case "chainData.resolve":
      return canonical.snapshot;
    case "policy.resolve":
      return canonical.policy;
    case "approval.request":
      return {
        ...canonical.approval,
        bindingHash: call.params.binding.bindingHash,
      };
    case "signer.sign":
      return canonical.signature;
    case "broadcast.submit":
      return integration.portData.broadcastSubmitResult;
    case "broadcast.reconcile":
      return integration.portData.broadcastReconcileResult;
    default:
      throw new Error(`unexpected Port operation: ${call.operation}`);
  }
}

async function drive(method, engineFixture, overrides = {}) {
  const core = tws.createTwsCore({ transactionEngine: engineFixture.engine });
  const ports = [];
  const states = [];
  const checkpoints = [];
  const clocks = [
    "2026-08-31T12:00:00Z",
    "2026-08-31T12:00:05Z",
    "2026-08-31T12:00:11Z",
    "2026-08-31T12:00:12Z",
    "2026-08-31T12:00:13Z",
    "2026-08-31T12:00:14Z",
    "2026-08-31T12:00:15Z",
  ];
  let transition = await core.start(startInput(method, overrides.params ?? canonical.request));
  for (let steps = 0; transition.kind !== "complete"; steps += 1) {
    assert.ok(steps < 40, "transaction lifecycle did not terminate");
    states.push(transition.checkpoint.payload.state);
    checkpoints.push(transition.checkpoint);
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
    ports.push({ operation: call.operation, params: structuredClone(call.params) });
    const reply = portResult(call, method, clocks, overrides);
    transition = await core.resume({
      version: "1.0",
      checkpoint: transition.checkpoint,
      response: {
        version: "1.0",
        callId: call.callId,
        ...(reply?.portError === undefined
          ? { result: reply }
          : { error: reply.portError }),
      },
      currentContext: context,
      currentSession: session,
    });
  }
  states.push(transition.checkpoint.payload.state);
  checkpoints.push(transition.checkpoint);
  return {
    transition,
    ports,
    states,
    checkpoints,
    engineCalls: engineFixture.calls,
  };
}

async function rejectBeforePreparedSideEffects(params, engineFixture) {
  const core = tws.createTwsCore({ transactionEngine: engineFixture.engine });
  const observedSideEffects = [];
  let transition = await core.start(startInput("tbc_signPreparedTransaction", params));
  try {
    for (let steps = 0; transition.kind !== "complete"; steps += 1) {
      assert.ok(steps < 40, "prepared rejection lifecycle did not terminate");
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
      if (["approval.request", "signer.sign", "broadcast.submit"].includes(call.operation)) {
        observedSideEffects.push(call.operation);
      }
      transition = await core.resume({
        version: "1.0",
        checkpoint: transition.checkpoint,
        response: {
          version: "1.0",
          callId: call.callId,
          result: portResult(call, "tbc_signPreparedTransaction", [
            "2026-08-31T12:00:00Z",
            "2026-08-31T12:00:05Z",
          ]),
        },
        currentContext: context,
        currentSession: session,
      });
    }
  } catch (error) {
    return { error, observedSideEffects };
  }
  throw new Error("tampered prepared request unexpectedly completed");
}

test("typed material failures survive Core without approval or signing and without private diagnostics", async () => {
  for (const [name, code, executionName] of [
    ["INVALID_INPUT", -32602], ["UNAUTHORIZED", 4100], ["REJECTED", 4001],
    ["CONFLICT", -32000, "CONFLICT"], ["NOT_FOUND", -32000, "PLANNING_FAILED"],
    ["UNAVAILABLE", -32000, "PLANNING_FAILED"], ["INTERNAL_ERROR", -32603],
  ]) {
    const result = await drive("tbc_sendTransaction", createTbcTransferEngine(integration), {
      "chainData.resolve": () => ({ portError: {
        name, retryable: name === "UNAVAILABLE", message: "private-adapter-diagnostic",
        details: { secret: "never-forward", reason: "arbitrary-untrusted-reason" },
      } }),
    });
    const error = result.transition.completion.response.error;
    assert.equal(error.code, code, name);
    if (executionName !== undefined) {
      assert.equal(error.data.name, executionName);
      assert.equal(error.data.retryable, name === "UNAVAILABLE");
    }
    assert.equal(JSON.stringify(error).includes("private-adapter"), false);
    assert.equal(JSON.stringify(error).includes("never-forward"), false);
    assert.equal(JSON.stringify(error).includes("arbitrary-untrusted"), false);
    assert.equal(result.ports.some(p => ["approval.request", "signer.sign", "broadcast.submit"].includes(p.operation)), false);
    assertPersistableCheckpointChain(result.checkpoints);
  }
});

test("unsupported Pool and zero-retained-fee reasons are safe typed Provider failures", async () => {
  for (const reason of ["UNSUPPORTED_POOL_OPERATION", "AMM_RETAINED_FEE_ZERO", "AMM_POOL_INACTIVE"]) {
    const result = await drive("tbc_sendTransaction", createTbcTransferEngine(integration), {
      "chainData.resolve": () => ({ portError: {
        name: reason === "AMM_POOL_INACTIVE" ? "CONFLICT" : "INVALID_INPUT", retryable: false,
        message: "must-not-be-forwarded", details: { reason, privateValue: "must-not-be-forwarded" },
      } }),
    });
    const error = result.transition.completion.response.error;
    assert.equal(error.code, reason === "AMM_POOL_INACTIVE" ? -32000 : -32602);
    assert.equal((error.data.details ?? error.data).reason, reason);
    assert.equal(JSON.stringify(error).includes("must-not-be-forwarded"), false);
    assert.equal(result.ports.some(p => p.operation === "signer.sign"), false);
  }
});

async function reachPendingCall(method, engineFixture, targetOperation) {
  const core = tws.createTwsCore({ transactionEngine: engineFixture.engine });
  const clocks = [
    "2026-08-31T12:00:00Z",
    "2026-08-31T12:00:05Z",
    "2026-08-31T12:00:11Z",
  ];
  let transition = await core.start(startInput(method));
  for (let steps = 0; steps < 30; steps += 1) {
    if (transition.kind === "waiting") {
      const call = transition.calls[0];
      if (call.operation === targetOperation) {
        return { core, transition, call };
      }
      const result = portResult(call, method, clocks);
      transition = await core.resume({
        version: "1.0",
        checkpoint: transition.checkpoint,
        response: { version: "1.0", callId: call.callId, result },
        currentContext: context,
        currentSession: session,
      });
    } else if (transition.kind === "continue") {
      transition = await core.resume({
        version: "1.0",
        checkpoint: transition.checkpoint,
        currentContext: context,
        currentSession: session,
      });
    } else {
      break;
    }
  }
  throw new Error(`did not reach pending ${targetOperation}`);
}

function engineOperations(result) {
  return result.engineCalls.map(({ operation }) => operation);
}

function assertPersistableCheckpointChain(checkpoints) {
  checkpoints.forEach((checkpoint, index) => {
    assert.equal(checkpoint.payload.revision, String(index));
    if (index > 0) {
      assert.equal(
        checkpoint.payload.previousCheckpointHash,
        checkpoints[index - 1].checkpointHash,
      );
    }
  });
}

function preparedRequest() {
  const payload = {
    version: "1.0",
    engineProfile: "tbc-engine-plan-v1",
    createdAt: canonical.snapshot.payload.capturedAt,
    expiresAt: canonical.plan.payload.expiresAt,
    intentHash: tws.hashCanonical(canonical.request.intent),
    transactions: canonical.plan.payload.transactions.map((transaction) => ({
      id: transaction.id,
      role: transaction.role,
      dependsOn: transaction.dependsOn,
      kind: "fixed",
      unsignedTransaction: transaction.unsignedTransaction,
      fee: transaction.fee,
    })),
    evidence: {
      observedAt: canonical.snapshot.payload.capturedAt,
      parentTransactions: canonical.snapshot.payload.parents,
      contracts: [],
    },
    estimatedTotalFee: canonical.plan.payload.preview.totalFee,
  };
  return {
    ...canonical.request,
    proposal: { payload, proposalHash: tws.hashCanonical(payload) },
  };
}

function preparedWithExpiry(expiresAt) {
  const request = preparedRequest();
  request.proposal.payload.expiresAt = expiresAt;
  request.proposal.proposalHash = tws.hashCanonical(request.proposal.payload);
  return request;
}

test("Prepared proposal expiry rejects at entry without material or signer work", async () => {
  for (const method of ["tbc_signPreparedTransaction", "tbc_sendPreparedTransaction"]) {
    const result = await drive(method, await createSourceTbcTransferEngine(), {
      params: preparedWithExpiry("2026-08-31T12:00:00Z"),
    });
    assert.equal(result.transition.completion.response.error?.code, 4100);
    assert.match(result.transition.completion.response.error.message, /proposal has expired/u);
    assert.deepEqual(result.ports.map(p => p.operation), ["clock.now"]);
    assert.equal(result.engineCalls.length, 0);
  }
});

test("Prepared proposal caps formal approval and cannot expire during UI wait then sign", async () => {
  for (const method of ["tbc_signPreparedTransaction", "tbc_sendPreparedTransaction"]) {
    const expiresAt = "2026-08-31T12:00:11Z";
    const result = await drive(method, await createSourceTbcTransferEngine(), {
      params: preparedWithExpiry(expiresAt),
      "approval.request": call => ({ ...canonical.approval,
        bindingHash: call.params.binding.bindingHash, expiresAt: call.params.binding.payload.expiresAt }),
    });
    const review = result.ports.find(p => p.operation === "approval.request");
    assert.equal(review.params.binding.payload.expiresAt, expiresAt);
    assert.equal(result.transition.completion.response.error?.code, 4100);
    assert.equal(result.ports.some(p => p.operation === "signer.sign" || p.operation.startsWith("broadcast.")), false);
  }
});

test("Prepared shorter valid proposal retains the same one-approval transaction path", async () => {
  const expiresAt = "2026-08-31T12:00:30Z";
  const result = await drive("tbc_signPreparedTransaction", await createSourceTbcTransferEngine(), {
    params: preparedWithExpiry(expiresAt),
    "approval.request": call => ({ ...canonical.approval,
      bindingHash: call.params.binding.bindingHash, expiresAt: call.params.binding.payload.expiresAt }),
  });
  assert.equal(result.transition.checkpoint.payload.state, "completed");
  assert.equal(result.ports.find(p => p.operation === "approval.request").params.binding.payload.expiresAt, expiresAt);
  assert.equal(result.ports.filter(p => p.operation === "chainData.resolve").length, 1);
  assert.equal(result.ports.filter(p => p.operation === "approval.request").length, 1);
});

test("Prepared material that expires before formal approval never opens approval or signs", async () => {
  const fixture = await createSourceTbcTransferEngine();
  let approvals = 0, signatures = 0;
  await assert.rejects(drive("tbc_signPreparedTransaction", fixture, {
    params: preparedWithExpiry("2026-08-31T12:00:05Z"),
    "approval.request": () => { approvals++; throw new Error("Expired review must not open"); },
    "signer.sign": () => { signatures++; throw new Error("Expired review must not sign"); },
  }), error => error.code === "RECEIPT_EXPIRED");
  assert.equal(approvals + signatures, 0);
  assert.equal(fixture.calls.some(c => c.operation === "finalize"), false);
});

test("prepared fixed transaction is re-planned, approved, signed, and finalized", async () => {
  const fixture = createTbcTransferEngine(integration);
  const result = await drive("tbc_signPreparedTransaction", fixture, {
    params: preparedRequest(),
  });
  assert.equal(result.transition.checkpoint.payload.state, "completed", JSON.stringify({
    completion: result.transition.completion,
    ports: result.ports,
    states: result.states,
    engineCalls: result.engineCalls.map(({ operation }) => operation),
  }));
  assert.deepEqual(result.transition.completion.response.result, canonical.bundle);
  assert.equal(result.ports.filter(({ operation }) => operation === "approval.request").length, 1);
  assert.equal(result.ports.filter(({ operation }) => operation === "signer.sign").length, 1);
  assert.equal(result.ports.filter(({ operation }) => operation === "broadcast.submit").length, 0);
});

test("prepared fixed transaction accepts a later wallet observation of identical material", async () => {
  const laterSnapshot = structuredClone(canonical.snapshot);
  laterSnapshot.payload.capturedAt = "2026-08-31T12:00:30Z";
  laterSnapshot.snapshotHash = tws.hashCanonical(laterSnapshot.payload);
  const fixture = createTbcTransferEngine(integration);
  const result = await drive("tbc_signPreparedTransaction", fixture, {
    params: preparedRequest(),
    "chainData.resolve": () => laterSnapshot,
  });
  assert.equal(result.transition.checkpoint.payload.state, "completed");
  assert.equal(result.ports.filter(({ operation }) => operation === "approval.request").length, 1);
  assert.equal(result.ports.filter(({ operation }) => operation === "signer.sign").length, 1);
});

test("prepared proposal hash tampering fails before approval, signing, or broadcast", async () => {
  const params = structuredClone(preparedRequest());
  params.proposal.proposalHash = "f".repeat(64);
  const fixture = createTbcTransferEngine(integration);
  const rejected = await drive("tbc_signPreparedTransaction", fixture, { params });
  assert.deepEqual(rejected.transition.completion.response.error, {
    code: -32602,
    message: "Prepared proposal hash does not match its payload",
  });
  assert.deepEqual(
    rejected.ports.map(({ operation }) => operation),
    ["clock.now"],
  );
  assert.deepEqual(engineOperations(rejected), []);
});

test("Prepared independent clocks retain wallet expiry and the same transaction path", async () => {
  for (const method of ["tbc_signPreparedTransaction", "tbc_sendPreparedTransaction"]) {
    const params = structuredClone(preparedRequest());
    params.proposal.payload.createdAt = new Date(Date.parse(params.proposal.payload.createdAt) + 1000).toISOString();
    params.proposal.payload.evidence.observedAt = params.proposal.payload.createdAt;
    params.proposal.payload.expiresAt = new Date(Date.parse(params.proposal.payload.expiresAt) + 1000).toISOString();
    params.proposal.proposalHash = tws.hashCanonical(params.proposal.payload);
    const result = await drive(method, createTbcTransferEngine(integration), {params});
    assert.equal(result.transition.checkpoint.payload.state, "completed");
    const approvals = result.ports.filter(p => p.operation === "approval.request");
    assert.equal(approvals.length, 1);
    assert.ok(Date.parse(approvals[0].params.binding.payload.expiresAt) <= Date.parse(canonical.plan.payload.expiresAt));
    assert.equal(result.ports.filter(p => p.operation === "chainData.resolve").length, 1);
    assert.equal(result.ports.filter(p => p.operation === "signer.sign").length, 1);
  }
});

test("prepared unsigned bytes tampering fails against the wallet-replanned transaction set", async () => {
  const params = structuredClone(preparedRequest());
  const transaction = params.proposal.payload.transactions[0];
  const replacement = transaction.unsignedTransaction.endsWith("00") ? "01" : "00";
  transaction.unsignedTransaction = `${transaction.unsignedTransaction.slice(0, -2)}${replacement}`;
  params.proposal.proposalHash = tws.hashCanonical(params.proposal.payload);
  const fixture = createTbcTransferEngine(integration);
  const rejected = await rejectBeforePreparedSideEffects(params, fixture);
  assert.equal(rejected.error?.code, "ENGINE_ARTIFACT_MISMATCH");
  assert.deepEqual(rejected.observedSideEffects, []);
  assert.equal(fixture.calls.some(({ operation }) => operation === "finalize"), false);
});

test("pending finalization reuses approval and returns through durable signing", async () => {
  const fixture = stagedFinalizeFixture();
  const result = await drive("tbc_signTransaction", fixture, {
    "signer.sign": (call) => ({
      ...canonical.signature,
      taskId: call.params.task.taskId,
    }),
  });
  assert.equal(result.transition.checkpoint.payload.state, "completed");
  assert.equal(
    result.ports.filter(({ operation }) => operation === "approval.request").length,
    1,
  );
  assert.equal(
    result.ports.filter(({ operation }) => operation === "signer.sign").length,
    2,
  );
  assert.equal(
    result.engineCalls.filter(({ operation }) => operation === "finalize").length,
    2,
  );
  assert.equal(
    result.engineCalls.some(
      ({ operation, params }) =>
        operation === "validate:finalized" && params.pending !== undefined,
    ),
    true,
  );
  assertPersistableCheckpointChain(result.checkpoints);
});

test("pending finalization carries its continuation through pre-broadcast validation", async () => {
  const fixture = stagedFinalizeFixture();
  const result = await drive("tbc_sendTransaction", fixture, {
    "signer.sign": (call) => ({
      ...canonical.signature,
      taskId: call.params.task.taskId,
    }),
  });
  assert.equal(result.transition.checkpoint.payload.state, "completed");
  const preBroadcast = fixture.calls.find(
    ({ operation }) => operation === "validate:pre-broadcast",
  );
  assert.equal(preBroadcast.params.continuation.stage, 1);
  assert.equal(
    result.ports.filter(({ operation }) => operation === "broadcast.submit").length,
    canonical.bundle.transactions.length,
  );
  assertPersistableCheckpointChain(result.checkpoints);
});

test("rejection and invalid pending artifacts cannot reach another signer or broadcast", async () => {
  const rejected = stagedFinalizeFixture();
  const rejection = await drive("tbc_sendTransaction", rejected, {
    "approval.request": (call) => ({
      status: "rejected",
      bindingHash: call.params.binding.bindingHash,
      rejectedAt: "2026-08-31T12:00:10Z",
    }),
  });
  assert.equal(rejection.transition.checkpoint.payload.state, "rejected");
  assert.equal(
    rejection.ports.some(({ operation }) => operation === "signer.sign"),
    false,
  );
  assert.equal(
    rejection.ports.some(({ operation }) => operation.startsWith("broadcast.")),
    false,
  );
  assert.equal(
    rejected.calls.some(({ operation }) => operation === "finalize"),
    false,
  );

  const invalid = stagedFinalizeFixture({ rejectPending: true });
  const failed = await drive("tbc_sendTransaction", invalid);
  assert.equal(failed.transition.checkpoint.payload.state, "failed");
  assert.equal(
    failed.ports.filter(({ operation }) => operation === "signer.sign").length,
    1,
  );
  assert.equal(
    failed.ports.some(({ operation }) => operation.startsWith("broadcast.")),
    false,
  );
});

test("fresh planning enters approval without an intermediate planned checkpoint", async (t) => {
  const result = await drive("tbc_signTransaction", createTbcTransferEngine(integration));
  t.diagnostic(`checkpoints=${result.checkpoints.length} ports=${result.ports.length} engineCalls=${result.engineCalls.length}`);
  assert.equal(result.checkpoints.filter((checkpoint) =>
    checkpoint.payload.state === "planning" &&
    checkpoint.payload.memory.executionPlan !== undefined).length, 0);
  assert.equal(engineOperations(result).filter((operation) => operation === "plan").length, 1);
  assert.equal(engineOperations(result).filter((operation) => operation === "validate:plan").length, 1);
  const approval = result.ports.find(({ operation }) => operation === "approval.request");
  assert.equal(approval.params.binding.payload.operationHash, canonical.plan.planHash);
  assertPersistableCheckpointChain(result.checkpoints);
});

test("stored plans remain resumable without replanning and fresh invalid plans never request approval", async () => {
  const completed = await drive("tbc_signTransaction", createTbcTransferEngine(integration));
  const initial = completed.checkpoints.find((checkpoint) => checkpoint.payload.state === "planning");
  const planned = tws.advanceCheckpoint(initial, {
    ...initial.payload,
    revision: String(BigInt(initial.payload.revision) + 1n),
    previousCheckpointHash: initial.checkpointHash,
    expiresAt: canonical.plan.payload.expiresAt,
    memory: { ...initial.payload.memory, executionPlan: canonical.plan },
  });
  const fixture = createTbcTransferEngine(integration);
  const resumed = await tws.createTwsCore({ transactionEngine: fixture.engine }).resume({
    version: "1.0", checkpoint: JSON.parse(JSON.stringify(planned)),
    currentContext: context, currentSession: session,
  });
  assert.equal(resumed.checkpoint.payload.state, "approval");
  assert.deepEqual(fixture.calls.map(({ operation }) => operation), ["validate:plan"]);
  const invalid = await drive("tbc_signTransaction", invalidPhaseFixture("plan", "PLAN_HASH_MISMATCH"));
  assert.equal(invalid.transition.checkpoint.payload.state, "failed");
  assert.equal(invalid.ports.some(({ operation }) => /approval|signer|broadcast/.test(operation)), false);
});

test("insufficient funding completes a sanitized business error before approval or signing", async () => {
  const fixture = createTbcTransferEngine(integration);
  fixture.engine = exactEngineFacade(fixture.engine, {plan() {
    throw Object.assign(new Error("private backend material must not escape"), {name:"TbcEngineError",code:"INSUFFICIENT_FUNDS"});
  }});
  const result = await drive("tbc_sendTransaction", fixture);
  assert.deepEqual(result.transition.completion.response.error, {
    code:-32000, message:"Insufficient spendable funds for the transaction and fee",
    data:{name:"INSUFFICIENT_FUNDS",stage:"planning",retryable:false},
  });
  assert.equal(result.ports.some(({operation})=>/approval|signer|broadcast/.test(operation)),false);
  assertPersistableCheckpointChain(result.checkpoints);
});

test("canonical TBC transaction sign path preserves plan, approval, signer, and finalize order", async () => {
  const result = await drive(
    "tbc_signTransaction",
    createTbcTransferEngine(integration),
  );
  assert.deepEqual(engineOperations(result), [
    "normalizeRequest",
    "plan",
    "validate:plan",
    "validate:pre-sign",
    "finalize",
    "validate:finalized",
  ]);
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
    ],
  );
  assert.equal(
    result.ports.some(({ operation }) => operation.startsWith("broadcast.")),
    false,
  );
  assert.deepEqual(result.transition.completion.response.result, canonical.bundle);
  for (const checkpoint of result.checkpoints.filter(
    (candidate) => candidate.payload.memory.normalizedTransaction !== undefined,
  )) {
    assert.ok(
      Date.parse(checkpoint.payload.expiresAt) <=
        Date.parse(canonical.request.constraints.expiresAt),
    );
  }
  assertPersistableCheckpointChain(result.checkpoints);
});

test("multi-task signing obtains a fresh clock before every signer and finalization", async () => {
  const fixture = multiSignerFixture();
  const result = await drive("tbc_signTransaction", fixture, {
    "signer.sign": (call) => ({
      ...canonical.signature,
      taskId: call.params.task.taskId,
    }),
  });
  const firstSigner = result.ports.findIndex(
    ({ operation }) => operation === "signer.sign",
  );
  assert.deepEqual(
    result.ports.slice(firstSigner).map(({ operation }) => operation),
    ["signer.sign", "clock.now", "signer.sign", "clock.now"],
  );
  assert.equal(
    result.engineCalls.find(({ operation }) => operation === "finalize").params
      .signatures.length,
    2,
  );
  assertPersistableCheckpointChain(result.checkpoints);
});

test("replaying an exact signer response is deterministic and cannot advance its successor", async () => {
  const reached = await reachPendingCall(
    "tbc_signTransaction",
    createTbcTransferEngine(integration),
    "signer.sign",
  );
  const input = {
    version: "1.0",
    checkpoint: reached.transition.checkpoint,
    response: {
      version: "1.0",
      callId: reached.call.callId,
      result: canonical.signature,
    },
    currentContext: context,
    currentSession: session,
  };
  const first = await reached.core.resume(input);
  const replay = await reached.core.resume(input);
  assert.deepEqual(replay, first);
  await assert.rejects(
    reached.core.resume({ ...input, checkpoint: first.checkpoint }),
    (error) =>
      error instanceof tws.TwsStateError &&
      error.code === "PORT_RESPONSE_NOT_PENDING",
  );
});

test("canonical TBC transaction send path validates and broadcasts once with the business idempotency key", async () => {
  const fixture = createTbcTransferEngine(integration);
  const result = await drive("tbc_sendTransaction", fixture);
  assert.deepEqual(engineOperations(result), [
    "normalizeRequest",
    "plan",
    "validate:plan",
    "validate:pre-sign",
    "finalize",
    "validate:finalized",
    "validate:pre-broadcast",
  ]);
  const submits = result.ports.filter(
    ({ operation }) => operation === "broadcast.submit",
  );
  assert.equal(submits.length, 1);
  assert.deepEqual(submits[0].params, {
    ...integration.portData.broadcastSubmitParams,
    idempotencyKey: tws.deriveBroadcastIdempotencyKey({
      operationId: result.transition.checkpoint.payload.operationId,
      txid: canonical.bundle.transactions[0].txid,
    }),
  });
  assert.deepEqual(result.transition.completion.response.result.transactions, [
    {
      id: canonical.bundle.transactions[0].id,
      txid: canonical.bundle.transactions[0].txid,
      status: "submitted",
      role: canonical.bundle.transactions[0].role,
      dependsOn: canonical.bundle.transactions[0].dependsOn,
    },
  ]);
  assert.equal(
    fixture.calls.filter(({ operation }) => operation === "finalize").length,
    1,
  );
  assertPersistableCheckpointChain(result.checkpoints);
});

test("canonical TBC transaction reconciles one ambiguous broadcast without resubmitting", async () => {
  const result = await drive(
    "tbc_sendTransaction",
    createTbcTransferEngine(integration),
    {
      "broadcast.submit": () => ({
        portError: {
          name: "UNAVAILABLE",
          message: "submission outcome is unknown",
          retryable: true,
        },
      }),
    },
  );
  assert.deepEqual(
    result.ports
      .filter(({ operation }) => operation.startsWith("broadcast."))
      .map(({ operation }) => operation),
    ["broadcast.submit", "broadcast.reconcile"],
  );
  assert.equal(result.transition.checkpoint.payload.state, "completed");
  assertPersistableCheckpointChain(result.checkpoints);
});

test("multi-transaction broadcast obtains a fresh clock before every submission", async () => {
  const fixture = multiTransactionFixture();
  const result = await drive("tbc_sendTransaction", fixture, {
    "broadcast.submit": (call) => ({
      txid: call.params.transaction.txid,
      status: "accepted",
    }),
  });
  const firstSubmit = result.ports.findIndex(
    ({ operation }) => operation === "broadcast.submit",
  );
  assert.deepEqual(
    result.ports.slice(firstSubmit).map(({ operation }) => operation),
    ["broadcast.submit", "clock.now", "broadcast.submit"],
  );
  assert.deepEqual(
    result.transition.completion.response.result.transactions.map(
      ({ txid }) => txid,
    ),
    fixture.bundle.transactions.map(({ txid }) => txid),
  );
  assertPersistableCheckpointChain(result.checkpoints);
});

test("known reconciled source prefix continues only the unsubmitted dependent suffix", async () => {
  const fixture = multiTransactionFixture();
  const posts = [];
  const result = await drive(
    "tbc_sendTransaction",
    fixture,
    {
      "broadcast.submit": (call) => {
        posts.push(call.params.transaction.txid);
        return posts.length === 1
          ? {
              portError: {
                name: "UNAVAILABLE",
                message: "source submission response was lost",
                retryable: true,
              },
            }
          : {
              txid: call.params.transaction.txid,
              status: "accepted",
            };
      },
      "broadcast.reconcile": (call) => ({
        transactions: call.params.txids.map((txid) => ({
          txid,
          status: "mempool",
          confirmations: "0",
        })),
      }),
    },
  );
  assert.deepEqual(
    result.ports
      .filter(({ operation }) => operation.startsWith("broadcast."))
      .map(({ operation }) => operation),
    ["broadcast.submit", "broadcast.reconcile", "broadcast.submit"],
  );
  assert.equal(result.transition.checkpoint.payload.state, "completed");
  assert.deepEqual(posts, fixture.bundle.transactions.map(({ txid }) => txid));
  assert.deepEqual(
    result.transition.completion.response.result.transactions.map(({ txid }) => txid),
    posts,
  );
  assertPersistableCheckpointChain(result.checkpoints);
});

for (const status of ["unknown", "rejected"]) {
  test(`an ambiguous source that reconciles as ${status} remains fail-closed`, async () => {
    const fixture = multiTransactionFixture();
    const posts = [];
    const result = await drive("tbc_sendTransaction", fixture, {
      "broadcast.submit": (call) => {
        posts.push(call.params.transaction.txid);
        return {
          portError: {
            name: "UNAVAILABLE",
            message: "source submission response was lost",
            retryable: true,
          },
        };
      },
      "broadcast.reconcile": (call) => ({
        transactions: call.params.txids.map((txid) => ({ txid, status })),
      }),
    });
    assert.equal(result.transition.checkpoint.payload.state, "failed");
    assert.deepEqual(posts, [fixture.bundle.transactions[0].txid]);
    assert.equal(
      result.ports.filter(({ operation }) => operation === "broadcast.submit").length,
      1,
    );
    assertPersistableCheckpointChain(result.checkpoints);
  });
}

test("canonical TBC transaction rejects engine shortcuts and mutated security artifacts", async () => {
  const exact = createTbcTransferEngine(integration).engine;
  assert.throws(
    () => tws.createTwsCore({
      transactionEngine: { ...exact, execute() {} },
    }),
    /execute|four|facade/i,
  );

  const mutable = { ...exact };
  const captured = tws.assertTransactionEngine(mutable);
  mutable.normalizeRequest = () => ({ mutated: true });
  assert.equal(
    (await captured.normalizeRequest({
      version: "1.0",
      request: canonical.request,
    })).requestHash,
    canonical.requestHash,
  );

  const accessor = {
    plan: exact.plan,
    validate: exact.validate,
    finalize: exact.finalize,
  };
  Object.defineProperty(accessor, "normalizeRequest", {
    enumerable: true,
    get: () => exact.normalizeRequest,
  });
  assert.throws(
    () => tws.assertTransactionEngine(accessor),
    /data-property|facade/i,
  );

  await assert.rejects(
    drive(
      "tbc_signTransaction",
      changedPlanFixture(),
    ),
    /plan|hash|validation/i,
  );

  await assert.rejects(
    drive(
      "tbc_signTransaction",
      createTbcTransferEngine(integration),
      {
        "signer.sign": () => ({
          ...canonical.signature,
          taskId: "wrong-signing-task",
        }),
      },
    ),
    (error) => error instanceof tws.TwsStateError && error.code === "PORT_RESULT_INVALID",
  );

  const invalid = await drive(
    "tbc_signTransaction",
    invalidPhaseFixture("pre-sign", "SIGNING_TASK_MISMATCH"),
  );
  assert.equal(invalid.transition.checkpoint.payload.state, "failed");
  assert.equal(invalid.transition.completion.response.error.code, -32603);

  await assert.rejects(
    drive(
      "tbc_signTransaction",
      createTbcTransferEngine(integration),
      {
        "signer.sign": () => ({
          ...canonical.signature,
          signature: `${canonical.signature.signature.slice(0, -1)}0`,
        }),
      },
    ),
    (error) => error?.name === "TbcEngineError" && error.code === "SIGNATURE_INVALID",
  );

  for (const changedBundle of ["bytes", "txid", "fee", "artifact"]) {
    const changed = await drive(
      "tbc_signTransaction",
      changedBundleFixture(changedBundle),
    );
    assert.equal(
      changed.transition.checkpoint.payload.state,
      "failed",
      changedBundle,
    );
  }

  await assert.rejects(
    drive(
      "tbc_signTransaction",
      createTbcTransferEngine(integration),
      {
        "approval.request": (call) => ({
          ...canonical.approval,
          bindingHash: call.params.binding.bindingHash.replace(/^./, "f"),
        }),
      },
    ),
    (error) =>
      error instanceof tws.TwsApprovalError &&
      error.code === "RECEIPT_BINDING_MISMATCH",
  );

  const rollbackClocks = [
    "2026-08-31T12:00:00Z",
    "2026-08-31T12:00:05Z",
    "2026-08-31T12:00:09Z",
  ];
  await assert.rejects(
    drive(
      "tbc_signTransaction",
      createTbcTransferEngine(integration),
      { "clock.now": () => ({ now: rollbackClocks.shift() }) },
    ),
    (error) =>
      error instanceof tws.TwsApprovalError &&
      error.code === "RECEIPT_TIME_INVALID",
  );

  const finalizingExpiredClocks = [
    "2026-08-31T12:00:00Z",
    "2026-08-31T12:00:05Z",
    "2026-08-31T12:00:11Z",
    canonical.approval.expiresAt,
  ];
  await assert.rejects(
    drive(
      "tbc_signTransaction",
      createTbcTransferEngine(integration),
      { "clock.now": () => ({ now: finalizingExpiredClocks.shift() }) },
    ),
    (error) =>
      error instanceof tws.TwsApprovalError && error.code === "RECEIPT_EXPIRED",
  );
});

test("an approval that expires before signing becomes an auditable terminal failure", async () => {
  const clocks = [
    "2026-08-31T12:00:00Z",
    "2026-08-31T12:00:05Z",
    canonical.approval.expiresAt,
  ];
  const result = await drive(
    "tbc_signTransaction",
    createTbcTransferEngine(integration),
    { "clock.now": () => ({ now: clocks.shift() }) },
  );
  assert.equal(result.transition.checkpoint.payload.state, "failed");
  assert.deepEqual(result.transition.completion.response.error, {
    code: 4100,
    message: "Approval expired before signing",
  });
  assert.equal(
    result.ports.filter(({ operation }) => operation === "signer.sign").length,
    0,
  );
  assert.equal(
    result.ports.filter(({ operation }) => operation === "broadcast.submit").length,
    0,
  );
});

test("a sign-only operation cannot be forged into the broadcast reducer", async () => {
  const result = await drive(
    "tbc_signTransaction",
    createTbcTransferEngine(integration),
  );
  const finalizing = result.checkpoints.find(
    (checkpoint) =>
      checkpoint.payload.state === "finalizing" &&
      checkpoint.payload.pendingCalls.length === 1,
  );
  assert.ok(finalizing);
  const revision = String(BigInt(finalizing.payload.revision) + 1n);
  const call = {
    version: "1.0",
    callId: tws.deriveCallId({
      operationId: finalizing.payload.operationId,
      checkpointRevision: revision,
      effectOrdinal: "0",
      operationName: "clock.now",
    }),
    operation: "clock.now",
    params: { version: "1.0" },
  };
  const forged = tws.advanceCheckpoint(finalizing, {
    ...finalizing.payload,
    revision,
    previousCheckpointHash: finalizing.checkpointHash,
    state: "broadcasting",
    pendingCalls: [call],
    memory: {
      ...finalizing.payload.memory,
      finalizedBundle: canonical.bundle,
      broadcastProgress: {
        attempts: [],
        submittedTransactionIds: [],
        reconciliationAttempts: 0,
      },
    },
    data: { finalizedBundle: canonical.bundle },
  });
  const core = tws.createTwsCore({
    transactionEngine: createTbcTransferEngine(integration).engine,
  });
  await assert.rejects(
    core.resume({
      version: "1.0",
      checkpoint: forged,
      response: {
        version: "1.0",
        callId: call.callId,
        result: { now: "2026-08-31T12:00:13Z" },
      },
      currentContext: context,
      currentSession: session,
    }),
    (error) =>
      error instanceof tws.TwsStateError && error.code === "STATE_MISMATCH",
  );
});
