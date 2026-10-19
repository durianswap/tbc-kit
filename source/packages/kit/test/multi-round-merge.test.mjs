import assert from "node:assert/strict";
import test from "node:test";

import { hashCanonical } from "@tbc-wallet/core";
import {
  createTbcMultiRoundMergeOrchestrator,
  hashTbcMultiRoundMergeState,
  TbcMultiRoundMergeConflictError,
} from "../dist/esm/wallet.js";

const NOW = Date.parse("2026-09-23T00:00:00Z");
const CHAIN_ID = "tbc:testnet";
const ADDRESS = "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH";
const AUTHORITY = Object.freeze({
  chainId: CHAIN_ID,
  accountId: `${CHAIN_ID}:${ADDRESS}`,
  origin: "https://merge.test",
  sessionId: "multi-round-session",
});
const ASSET = Object.freeze({ kind: "tbc" });

function state(count, observedTransactionIds = [], overrides = {}) {
  const payload = {
    version: "1.0",
    authority: AUTHORITY,
    asset: ASSET,
    observedAt: "2026-09-23T00:00:00Z",
    revision: `r-${count}-${observedTransactionIds.join("-")}`,
    utxoCount: count,
    observedTransactionIds,
    ...overrides,
  };
  return Object.freeze({ ...payload, stateHash: hashTbcMultiRoundMergeState(payload) });
}

test("observation time is not part of authoritative index identity", () => {
  const first = state(205, [], { observedAt: "2026-09-23T00:00:00Z" });
  const oneSecondLater = state(205, [], { observedAt: "2026-09-23T00:00:01Z" });
  assert.equal(first.revision, oneSecondLater.revision);
  assert.equal(first.stateHash, oneSecondLater.stateHash);
});

function harness({
  initialCount = 205,
  targetUtxoCount = 1,
  fee = "10",
  maxTotalFee = "1000",
  maxTransactions = 8,
  maxIndexRefreshes = 2,
  executeStatus = "accepted",
  failAt,
  reconcileStatus = "known",
  stall = false,
  wrongState = false,
  expiredStep = false,
  approvalExpiresAt = "2026-09-23T00:04:00Z",
  advanceAfterPrepareMs = 0,
  advanceAfterExecuteMs = 0,
  onExecute,
  throwPrepareAt,
  throwExecuteAt,
  throwReadAfterExecution = false,
  omitWaitForIndex = false,
} = {}) {
  let clock = NOW;
  let current = state(initialCount);
  let approvals = 0;
  let executions = 0;
  let reconciliations = 0;
  let waits = 0;
  const prepared = [];
  const approvedScopes = [];
  const adapter = {
    async readState() {
      if (throwReadAfterExecution && executions > 0) throw new Error("controlled index failure");
      if (wrongState) return state(current.utxoCount, [], { authority: { ...AUTHORITY, ...wrongState } });
      return current;
    },
    async approve(request) {
      approvals += 1;
      approvedScopes.push(request.scope);
      return {
        status: "approved",
        scopeHash: request.scopeHash,
        approvalId: "merge-approval",
        approvedAt: "2026-09-23T00:00:00Z",
        expiresAt: approvalExpiresAt,
      };
    },
    async prepareStep(input) {
      if (input.stepIndex === throwPrepareAt) throw new Error("controlled preparation failure");
      const inputCount = Math.min(100, input.state.utxoCount - targetUtxoCount + 1);
      const value = Object.freeze({
        version: "1.0",
        stepId: `merge-${input.stepIndex}`,
        stepIndex: input.stepIndex,
        authority: AUTHORITY,
        asset: ASSET,
        stateHash: input.state.stateHash,
        materialHash: hashCanonical({ step: input.stepIndex, state: input.state.stateHash }),
        inputCount,
        outputCount: 1,
        fee,
        expiresAt: expiredStep ? "2026-09-22T23:59:59Z" : "2026-09-23T00:03:00Z",
        dependsOn: input.acceptedTxids.slice(-1),
        prepared: Object.freeze({ controlled: true }),
      });
      prepared.push(value);
      clock += advanceAfterPrepareMs;
      return value;
    },
    async executePreparedStep({ step }) {
      executions += 1;
      onExecute?.();
      clock += advanceAfterExecuteMs;
      if (executions === throwExecuteAt) {
        const error = new Error("controlled execution failure");
        error.recoveryId = `durable-operation-${executions}`;
        throw error;
      }
      const txid = hashCanonical({ tx: executions, materialHash: step.materialHash });
      const status = executions === failAt ? "failed" : executeStatus;
      if (status === "pending") {
        return {
          status,
          stepId: step.stepId,
          materialHash: step.materialHash,
          recoveryId: `durable-operation-${executions}`,
          error: "controlled durable Host interruption",
        };
      }
      if (status === "failed" || status === "rejected") {
        return { status, stepId: step.stepId, materialHash: step.materialHash, error: "controlled failure" };
      }
      if (!stall && status !== "uncertain") {
        current = state(current.utxoCount - step.inputCount + 1, [txid]);
      }
      return {
        status,
        stepId: step.stepId,
        materialHash: step.materialHash,
        txid,
        fee: step.fee,
        inputsConsumed: step.inputCount,
        outputsCreated: 1,
      };
    },
    async reconcile({ txid, step }) {
      reconciliations += 1;
      if (reconcileStatus === "known" && !stall) {
        current = state(current.utxoCount - step.inputCount + 1, [txid]);
      }
      return { txid, status: reconcileStatus };
    },
    async waitForIndex() {
      waits += 1;
    },
  };
  if (omitWaitForIndex) delete adapter.waitForIndex;
  const orchestrator = createTbcMultiRoundMergeOrchestrator(adapter, { now: () => clock });
  const run = (overrides = {}) => orchestrator.run({
    authority: AUTHORITY,
    asset: ASSET,
    limits: {
      targetUtxoCount,
      maxTransactions,
      maxTotalFee,
      maxIndexRefreshes,
      indexRefreshDelayMs: 0,
      expiresAt: "2026-09-23T00:05:00Z",
    },
    ...overrides,
  });
  return { run, counts: () => ({ approvals, executions, reconciliations, waits }), prepared, approvedScopes };
}

test("multi-round TBC merge exceeds the one-step 100-input bound and terminates at target", async () => {
  const controlled = harness();
  const result = await controlled.run();
  assert.equal(result.status, "complete");
  assert.equal(result.reason, "target-reached");
  assert.equal(result.initialUtxoCount, 205);
  assert.equal(result.finalUtxoCount, 1);
  assert.equal(result.steps.length, 3);
  assert.deepEqual(result.steps.map(({ inputCount }) => inputCount), [100, 100, 7]);
  assert.equal(result.totalFee, "30");
  assert.deepEqual(controlled.counts(), { approvals: 1, executions: 3, reconciliations: 0, waits: 0 });
  assert.deepEqual(controlled.prepared.map(({ dependsOn }) => dependsOn.length), [0, 1, 1]);
});

for (const scenario of [
  {
    name: "Pool-held FT",
    asset: Object.freeze({ kind: "pool-ft", poolContractId: "21".repeat(32) }),
    expectedInputs: [4, 3],
    custody: "pool-contract",
  },
  {
    name: "FTLP",
    asset: Object.freeze({ kind: "ftlp", poolContractId: "21".repeat(32) }),
    expectedInputs: [5, 2],
    custody: "active-account",
  },
]) {
  test(`${scenario.name} uses its existing single-round bound and explicit custody impact`, async () => {
    let currentPoolTxid = "23".repeat(32);
    const poolIdentity = () => Object.freeze({
      poolContractId: scenario.asset.poolContractId,
      ftContractId: "22".repeat(32),
      currentPoolTxid,
    });
    let count = 6;
    let approvedScope;
    const makeState = (observedTransactionIds = []) => {
      const payload = {
        version: "1.0",
        authority: AUTHORITY,
        asset: scenario.asset,
        observedAt: "2026-09-23T00:00:00Z",
        revision: `${scenario.asset.kind}-${count}-${observedTransactionIds.join("-")}`,
        utxoCount: count,
        poolIdentity: poolIdentity(),
        observedTransactionIds,
      };
      return Object.freeze({ ...payload, stateHash: hashTbcMultiRoundMergeState(payload) });
    };
    let current = makeState();
    const orchestrator = createTbcMultiRoundMergeOrchestrator({
      async readState() { return current; },
      async approve({ scope, scopeHash }) {
        approvedScope = scope;
        return {
          status: "approved", scopeHash, approvalId: "pool-approval",
          approvedAt: "2026-09-23T00:00:00Z",
          expiresAt: "2026-09-23T00:04:00Z",
        };
      },
      async prepareStep({ scope, state: observed, stepIndex, acceptedTxids }) {
        const inputCount = Math.min(
          scope.impact.maxAssetInputsPerTransaction,
          observed.utxoCount,
        );
        return Object.freeze({
          version: "1.0", stepId: `merge-${stepIndex}`, stepIndex,
          authority: AUTHORITY, asset: scenario.asset,
          stateHash: observed.stateHash,
          materialHash: hashCanonical({ scenario: scenario.name, stepIndex }),
          inputCount, outputCount: 1, fee: "10",
          expiresAt: "2026-09-23T00:03:00Z",
          dependsOn: acceptedTxids.slice(-1), prepared: {},
        });
      },
      async executePreparedStep({ step }) {
        const txid = hashCanonical({ poolStep: step.stepIndex, kind: scenario.asset.kind });
        count = count - step.inputCount + 1;
        if (scenario.asset.kind === "pool-ft") currentPoolTxid = txid;
        current = makeState([txid]);
        return {
          status: "accepted", stepId: step.stepId,
          materialHash: step.materialHash, txid, fee: step.fee,
          inputsConsumed: step.inputCount, outputsCreated: 1,
        };
      },
      async reconcile({ txid }) { return { txid, status: "known" }; },
    }, { now: () => NOW });
    const result = await orchestrator.run({
      authority: AUTHORITY,
      asset: scenario.asset,
      limits: {
        targetUtxoCount: 1, maxTransactions: 3, maxTotalFee: "100",
        maxIndexRefreshes: 0, indexRefreshDelayMs: 0,
        expiresAt: "2026-09-23T00:05:00Z",
      },
    });
    assert.equal(result.status, "complete");
    assert.deepEqual(result.steps.map(({ inputCount }) => inputCount), scenario.expectedInputs);
    assert.equal(approvedScope.impact.custody, scenario.custody);
    assert.equal(approvedScope.impact.resultOwner, scenario.custody);
    assert.equal(
      approvedScope.impact.maxAssetInputsPerTransaction,
      scenario.expectedInputs[0],
    );
    assert.deepEqual(approvedScope.impact.poolIdentity, {
      poolContractId: scenario.asset.poolContractId,
      ftContractId: "22".repeat(32),
      currentPoolTxid: "23".repeat(32),
    });
  });
}

test("Pool state progression accepts only this run's txid and keeps the approved FT identity", async () => {
  const asset = Object.freeze({ kind: "pool-ft", poolContractId: "41".repeat(32) });
  const initialIdentity = Object.freeze({
    poolContractId: asset.poolContractId,
    ftContractId: "42".repeat(32),
    currentPoolTxid: "43".repeat(32),
  });
  let current;
  const makeState = (count, poolIdentity, observedTransactionIds = []) => {
    const payload = {
      version: "1.0", authority: AUTHORITY, asset,
      observedAt: "2026-09-23T00:00:00Z",
      revision: hashCanonical({ count, poolIdentity, observedTransactionIds }),
      utxoCount: count, poolIdentity, observedTransactionIds,
    };
    return Object.freeze({ ...payload, stateHash: hashTbcMultiRoundMergeState(payload) });
  };
  current = makeState(2, initialIdentity);
  const orchestrator = createTbcMultiRoundMergeOrchestrator({
    async readState() { return current; },
    async approve({ scopeHash }) {
      return {
        status: "approved", scopeHash, approvalId: "external-pool-change",
        approvedAt: "2026-09-23T00:00:00Z",
        expiresAt: "2026-09-23T00:04:00Z",
      };
    },
    async prepareStep({ state: observed }) {
      return {
        version: "1.0", stepId: "merge-1", stepIndex: 1,
        authority: AUTHORITY, asset, stateHash: observed.stateHash,
        materialHash: "44".repeat(32), inputCount: 2, outputCount: 1,
        fee: "1", expiresAt: "2026-09-23T00:03:00Z",
        dependsOn: [], prepared: {},
      };
    },
    async executePreparedStep({ step }) {
      const txid = "45".repeat(32);
      current = makeState(1, {
        ...initialIdentity,
        currentPoolTxid: "46".repeat(32),
      }, [txid]);
      return {
        status: "accepted", stepId: step.stepId, materialHash: step.materialHash,
        txid, fee: "1", inputsConsumed: 2, outputsCreated: 1,
      };
    },
    async reconcile({ txid }) { return { txid, status: "known" }; },
  }, { now: () => NOW });
  const result = await orchestrator.run({
    authority: AUTHORITY,
    asset,
    limits: {
      targetUtxoCount: 1, maxTransactions: 1, maxTotalFee: "10",
      maxIndexRefreshes: 0, indexRefreshDelayMs: 0,
      expiresAt: "2026-09-23T00:05:00Z",
    },
  });
  assert.equal(result.status, "partial");
  assert.equal(result.reason, "facts-changed");
});

test("the final accepted transaction completes at the exact transaction budget", async () => {
  const result = await harness({ maxTransactions: 3 }).run();
  assert.equal(result.status, "complete");
  assert.equal(result.reason, "target-reached");
  assert.equal(result.finalUtxoCount, 1);
  assert.equal(result.steps.length, 3);
});

test("approval expiry is rechecked after asynchronous preparation", async () => {
  const controlled = harness({
    approvalExpiresAt: "2026-09-23T00:00:01Z",
    advanceAfterPrepareMs: 2_000,
  });
  const result = await controlled.run();
  assert.equal(result.status, "stopped");
  assert.equal(result.reason, "expired");
  assert.equal(controlled.counts().executions, 0);
});

test("scope authority, asset and limits are recursively immutable", async () => {
  const base = harness({ initialCount: 2, targetUtxoCount: 1 });
  const authority = { ...AUTHORITY };
  const asset = { kind: "tbc" };
  await base.run({ authority, asset, onProgress() {} });
  const scope = base.approvedScopes[0];
  assert.ok(Object.isFrozen(scope));
  assert.ok(Object.isFrozen(scope.authority));
  assert.ok(Object.isFrozen(scope.asset));
  assert.ok(Object.isFrozen(scope.limits));
  authority.sessionId = "mutated";
  asset.kind = "ft";
  assert.equal(scope.authority.sessionId, AUTHORITY.sessionId);
  assert.equal(scope.asset.kind, "tbc");
});

test("partial cancellation preserves accepted steps and never executes the next prepared step", async () => {
  const controlled = harness();
  const controller = new AbortController();
  const result = await controlled.run({
    signal: controller.signal,
    onProgress(progress) {
      if (progress.phase === "preparing" && progress.stepIndex === 2) controller.abort();
    },
  });
  assert.equal(result.status, "partial");
  assert.equal(result.reason, "cancelled");
  assert.equal(result.steps.length, 1);
  assert.deepEqual(controlled.counts(), { approvals: 1, executions: 1, reconciliations: 0, waits: 0 });
});

test("fee budget exhaustion stops before Signer or POST for the over-budget step", async () => {
  const controlled = harness({ fee: "60", maxTotalFee: "100" });
  const result = await controlled.run();
  assert.equal(result.status, "partial");
  assert.equal(result.reason, "fee-budget-exhausted");
  assert.equal(result.totalFee, "60");
  assert.equal(result.steps.length, 1);
  assert.deepEqual(controlled.counts(), { approvals: 1, executions: 1, reconciliations: 0, waits: 0 });
});

test("a later step failure returns the already accepted txid as partial success", async () => {
  const controlled = harness({ failAt: 2 });
  const result = await controlled.run();
  assert.equal(result.status, "partial");
  assert.equal(result.reason, "step-failed");
  assert.equal(result.steps.length, 2);
  assert.equal(result.steps[0].status, "accepted");
  assert.equal(result.steps[1].status, "failed");
  assert.match(result.steps[0].txid, /^[0-9a-f]{64}$/u);
  assert.deepEqual(controlled.counts(), { approvals: 1, executions: 2, reconciliations: 0, waits: 0 });
});

test("a nonterminal pre-broadcast Host operation retains its recovery identity without fee exposure", async () => {
  const result = await harness({ initialCount: 2, executeStatus: "pending" }).run();
  assert.equal(result.status, "uncertain");
  assert.equal(result.reason, "operation-pending");
  assert.equal(result.totalFee, "0");
  assert.equal(result.steps.length, 1);
  assert.deepEqual(result.steps[0], {
    stepId: "merge-1",
    recoveryId: "durable-operation-1",
    status: "pending",
    fee: "0",
    inputCount: 2,
    outputCount: 1,
    dependsOn: [],
  });
});

test("abort and expiry reached during execution are not relabeled as ordinary step failures", async () => {
  const controller = new AbortController();
  const aborted = await harness({
    initialCount: 2,
    failAt: 1,
    onExecute: () => controller.abort(),
  }).run({ signal: controller.signal });
  assert.equal(aborted.status, "stopped");
  assert.equal(aborted.reason, "cancelled");
  assert.equal(aborted.steps.length, 0);
  assert.equal(aborted.totalFee, "0");

  const expired = await harness({
    initialCount: 2,
    failAt: 1,
    advanceAfterExecuteMs: 4 * 60_000,
  }).run();
  assert.equal(expired.status, "stopped");
  assert.equal(expired.reason, "expired");
  assert.equal(expired.steps.length, 0);
  assert.equal(expired.totalFee, "0");
});

test("adapter failures retain completed steps and durable uncertain identity", async () => {
  const preparation = harness({ throwPrepareAt: 2 });
  const partial = await preparation.run();
  assert.equal(partial.status, "partial");
  assert.equal(partial.reason, "step-failed");
  assert.equal(partial.steps.length, 1);

  const execution = harness({ throwExecuteAt: 1 });
  const uncertain = await execution.run();
  assert.equal(uncertain.status, "uncertain");
  assert.equal(uncertain.reason, "broadcast-uncertain");
  assert.equal(uncertain.steps[0].recoveryId, "durable-operation-1");

  const indexing = harness({ throwReadAfterExecution: true });
  const stalled = await indexing.run();
  assert.equal(stalled.status, "partial");
  assert.equal(stalled.reason, "index-stalled");
  assert.equal(stalled.steps.length, 1);
});

test("index lag is bounded and stops without a busy loop when no progress is visible", async () => {
  const controlled = harness({ stall: true, maxIndexRefreshes: 2 });
  const result = await controlled.run();
  assert.equal(result.status, "partial");
  assert.equal(result.reason, "index-stalled");
  assert.equal(result.steps.length, 1);
  assert.deepEqual(controlled.counts(), { approvals: 1, executions: 1, reconciliations: 0, waits: 2 });
});

test("the default index refresh path yields to a real timer", async () => {
  const controlled = harness({ stall: true, maxIndexRefreshes: 1, omitWaitForIndex: true });
  const started = performance.now();
  const result = await controlled.run({
    limits: {
      targetUtxoCount: 1, maxTransactions: 8, maxTotalFee: "1000",
      maxIndexRefreshes: 1, indexRefreshDelayMs: 5,
      expiresAt: "2026-09-23T00:05:00Z",
    },
  });
  assert.equal(result.reason, "index-stalled");
  assert.ok(performance.now() - started >= 4, "default refresh must not become a synchronous busy loop");
});

test("an uncertain POST is reconciled once and is never executed again while unknown", async () => {
  const controlled = harness({ executeStatus: "uncertain", reconcileStatus: "unknown" });
  const result = await controlled.run();
  assert.equal(result.status, "uncertain");
  assert.equal(result.reason, "broadcast-uncertain");
  assert.equal(result.steps[0].status, "uncertain");
  assert.equal(result.totalFee, "10", "unknown submission retains its approved fee exposure");
  assert.deepEqual(controlled.counts(), { approvals: 1, executions: 1, reconciliations: 1, waits: 0 });
});

test("wrong session, account or network state is rejected before approval, Signer and POST", async () => {
  for (const wrongState of [
    { sessionId: "wrong" },
    { accountId: `${CHAIN_ID}:1LEF3thAWxd4WG8nvtjPb4An6kGCoweUu6` },
    { chainId: "tbc:mainnet" },
  ]) {
    const controlled = harness({ wrongState });
    await assert.rejects(controlled.run(), TbcMultiRoundMergeConflictError);
    assert.deepEqual(controlled.counts(), { approvals: 0, executions: 0, reconciliations: 0, waits: 0 });
  }
});

test("expired prepared material stops before execution", async () => {
  const controlled = harness({ expiredStep: true });
  const result = await controlled.run();
  assert.equal(result.status, "stopped");
  assert.equal(result.reason, "expired");
  assert.deepEqual(controlled.counts(), { approvals: 1, executions: 0, reconciliations: 0, waits: 0 });
});

test("FT steps retain the five-input Engine boundary", async () => {
  const contractId = "ab".repeat(32);
  let current = state(12, [], { asset: { kind: "ft", contractId } });
  const adapter = {
    readState: async () => current,
    approve: async ({ scopeHash }) => ({
      status: "approved", scopeHash, approvalId: "ft-approval",
      approvedAt: "2026-09-23T00:00:00Z", expiresAt: "2026-09-23T00:04:00Z",
    }),
    prepareStep: async ({ state: view, stepIndex, acceptedTxids }) => ({
      version: "1.0", stepId: `merge-${stepIndex}`, stepIndex,
      authority: AUTHORITY, asset: { kind: "ft", contractId }, stateHash: view.stateHash,
      materialHash: hashCanonical({ stepIndex, stateHash: view.stateHash }),
      inputCount: Math.min(5, view.utxoCount), outputCount: 1, fee: "5",
      expiresAt: "2026-09-23T00:03:00Z", dependsOn: acceptedTxids.slice(-1), prepared: {},
    }),
    executePreparedStep: async ({ step }) => {
      const txid = hashCanonical({ ft: step.stepId });
      current = state(current.utxoCount - step.inputCount + 1, [txid], { asset: { kind: "ft", contractId } });
      return { status: "accepted", stepId: step.stepId, materialHash: step.materialHash, txid, fee: step.fee, inputsConsumed: step.inputCount, outputsCreated: 1 };
    },
    reconcile: async ({ txid }) => ({ txid, status: "known" }),
  };
  const result = await createTbcMultiRoundMergeOrchestrator(adapter, { now: () => NOW }).run({
    authority: AUTHORITY,
    asset: { kind: "ft", contractId },
    limits: { targetUtxoCount: 1, maxTransactions: 4, maxTotalFee: "100", expiresAt: "2026-09-23T00:05:00Z" },
  });
  assert.equal(result.status, "complete");
  assert.deepEqual(result.steps.map(({ inputCount }) => inputCount), [5, 5, 4]);
});

test("Stablecoin reuses the five-input coordinator and binds the zero-confirmation parent in round two", async () => {
  const contractId = "cd".repeat(32);
  const asset = Object.freeze({ kind: "stablecoin", contractId });
  const makeState = (count, observedTransactionIds = []) => state(count, observedTransactionIds, { asset });
  let current = makeState(6);
  const prepared = [];
  const orchestrator = createTbcMultiRoundMergeOrchestrator({
    async readState() { return current; },
    async approve({ scope, scopeHash }) {
      assert.deepEqual(scope.impact, {
        custody: "active-account",
        resultOwner: "active-account",
        maxAssetInputsPerTransaction: 5,
      });
      return {
        status: "approved", scopeHash, approvalId: "stablecoin-approval",
        approvedAt: "2026-09-23T00:00:00Z", expiresAt: "2026-09-23T00:04:00Z",
      };
    },
    async prepareStep({ state: view, stepIndex, acceptedTxids }) {
      const step = Object.freeze({
        version: "1.0", stepId: `merge-${stepIndex}`, stepIndex,
        authority: AUTHORITY, asset, stateHash: view.stateHash,
        materialHash: hashCanonical({ stablecoin: stepIndex, stateHash: view.stateHash }),
        inputCount: Math.min(5, view.utxoCount), outputCount: 1,
        fee: "7", expiresAt: "2026-09-23T00:03:00Z",
        dependsOn: acceptedTxids.slice(-1), prepared: {},
      });
      prepared.push(step);
      return step;
    },
    async executePreparedStep({ step }) {
      const txid = hashCanonical({ stablecoinTx: step.stepId });
      current = makeState(current.utxoCount - step.inputCount + 1, [txid]);
      return {
        status: "accepted", stepId: step.stepId, materialHash: step.materialHash,
        txid, fee: step.fee, inputsConsumed: step.inputCount, outputsCreated: 1,
      };
    },
    async reconcile({ txid }) { return { txid, status: "known" }; },
  }, { now: () => NOW });
  const result = await orchestrator.run({
    authority: AUTHORITY,
    asset,
    limits: {
      targetUtxoCount: 1, maxTransactions: 2, maxTotalFee: "20",
      maxIndexRefreshes: 0, expiresAt: "2026-09-23T00:05:00Z",
    },
  });
  assert.equal(result.status, "complete");
  assert.equal(result.finalUtxoCount, 1);
  assert.deepEqual(result.steps.map(({ inputCount }) => inputCount), [5, 2]);
  assert.deepEqual(prepared.map(({ dependsOn }) => dependsOn.length), [0, 1]);
  assert.equal(prepared[1].dependsOn[0], result.steps[0].txid);
});
