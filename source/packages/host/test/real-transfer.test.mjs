import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { withOutputReview } from "../../../scripts/lib/reviewed-transfer-fixture.mjs";
import { indexedDB } from "fake-indexeddb";
import {
  TWS_RELEASE,
  createTwsCore,
  hashCanonical,
} from "@tbc-wallet/core";
import { createTbcTransferEngine } from "@tbc-wallet/tbc-engine";
import { createWasmTbcEngineBackend } from "@tbc-wallet/tbc-engine/wasm";
import {
  TWS_HOST_DRIVER_METHODS,
  createMemoryTwsHostStore,
  createTwsHost,
} from "../dist/esm/index.js";
import { createIndexedDbTwsHostStore } from "../dist/esm/indexeddb.js";
import {
  makeRustTransferFixture,
} from "../../tbc-engine/test/fixtures/arbitrary-transfers.mjs";
import { createTbcHostPorts } from "./fixtures/tbc-host-ports.mjs";
import { TEST_LEASE_SCHEDULER } from "./fixtures/lease-scheduler.mjs";

const integration = JSON.parse(
  await readFile(
    new URL("../../../test-vectors/integration.json", import.meta.url),
    "utf8",
  ),
);
const provider = JSON.parse(
  await readFile(
    new URL("../../../test-vectors/provider.json", import.meta.url),
    "utf8",
  ),
);
integration.canonicalTransfer = withOutputReview(integration.canonicalTransfer);
const CANONICAL_SIGHASH =
  "1e06ca3ec00947bc4a174c62fbe08777796b2b525915640c5a144c001c27bf25";
const CANONICAL_TXID =
  "e715bbe7ea8e6e95ff339b24e1e2aaff8771e8e17af4682b775919fad953c907";
const ALTERNATE_RECIPIENT_ADDRESS = "1CUNEBjYrCn2y1SdiUMohaKUi4wpP326Lb";
const rustWasmBackend = await createWasmTbcEngineBackend(
  await readFile(
    new URL(
      "../../tbc-engine/artifacts/wasm/tbc_engine_wasm.wasm",
      import.meta.url,
    ),
  ),
);

function clone(value) {
  return structuredClone(value);
}

function authorityFor(fixture) {
  const context = clone(provider.trustedContexts[0].context);
  const session = clone(provider.providerSessions.sessionA);
  session.state.activeChainId = fixture.request.chainId;
  session.state.activeAccountIds = [
    `${fixture.request.chainId}:${fixture.request.from}`,
  ];
  return { currentContext: context, currentSession: session };
}

function tracedEngine(trace, captures) {
  const engine = createTbcTransferEngine({ backend: rustWasmBackend });
  const invoke = async (operation, params) => {
    const label = operation === "validate"
      ? `engine.validate:${params.phase}`
      : `engine.${operation}`;
    trace.push(label);
    const result = await engine[operation](params);
    captures.push({ operation, params: clone(params), result: clone(result) });
    return result;
  };
  return Object.freeze({
    normalizeRequest: (params) => invoke("normalizeRequest", params),
    plan: (params) => invoke("plan", params),
    validate: (params) => invoke("validate", params),
    finalize: (params) => invoke("finalize", params),
  });
}

function indexOf(trace, label, after = -1) {
  const index = trace.indexOf(label, after + 1);
  assert.notEqual(
    index,
    -1,
    `missing trace step: ${label}; trace=${JSON.stringify(trace)}`,
  );
  return index;
}

function assertMandatoryPipeline(trace) {
  const normalize = indexOf(trace, "engine.normalizeRequest");
  const plan = indexOf(trace, "engine.plan", normalize);
  const binding = trace.findIndex(
    (entry, index) => index > plan && entry.startsWith("approval.binding:"),
  );
  assert.notEqual(binding, -1, "missing approval binding trace");
  const approval = indexOf(trace, "port.approval.request", plan);
  const signer = indexOf(trace, "port.signer.sign", approval);
  const finalize = indexOf(trace, "engine.finalize", signer);
  const broadcast = indexOf(trace, "port.broadcast.submit", finalize);
  assert.ok(normalize < plan && plan < binding && binding <= approval);
  assert.ok(approval < signer && signer < finalize && finalize < broadcast);
}

async function driveTransfer({ fixture, store, ownerId }) {
  const trace = [];
  const captures = [];
  const authority = authorityFor(fixture);
  const harness = createTbcHostPorts({
    fixture,
    authority,
    trace,
    approvalId: ownerId.includes("canonical")
      ? integration.canonicalTransfer.approval.approvalId
      : `approval-${ownerId}`,
  });
  const host = createTwsHost({
    core: createTwsCore({
      transactionEngine: tracedEngine(trace, captures),
    }),
    store,
    authority: harness.authority,
    ports: harness.ports,
    ownerId,
    ...TEST_LEASE_SCHEDULER,
  });
  assert.deepEqual(Object.keys(host).sort(), [...TWS_HOST_DRIVER_METHODS].sort());
  assert.equal("execute" in host, false);
  assert.equal("signAndSend" in host, false);
  const result = await host.startOperation({
    version: "1.0",
    release: TWS_RELEASE,
    request: {
      jsonrpc: "2.0",
      id: ownerId,
      method: "tbc_sendTransaction",
      params: fixture.request,
    },
  });
  assert.equal(result.status, "complete");
  assert.equal(
    "error" in result.completion.response,
    false,
    `real transfer returned an RPC error: ${JSON.stringify(result.completion.response)}`,
  );
  assertMandatoryPipeline(trace);
  return { result, trace, captures, harness, host };
}

test("public Host drives the frozen canonical transfer through real Core and Engine", async () => {
  const canonical = integration.canonicalTransfer;
  const driven = await driveTransfer({
    fixture: canonical,
    store: createMemoryTwsHostStore(),
    ownerId: "real-canonical-transfer",
  });
  const normalized = driven.captures.find(
    ({ operation }) => operation === "normalizeRequest",
  ).result;
  const plan = driven.captures.find(({ operation }) => operation === "plan").result.plan;
  const finalized = driven.captures.find(
    ({ operation }) => operation === "finalize",
  ).result.bundle;
  const approval = driven.harness.calls.find(
    ({ operation }) => operation === "approval.request",
  );
  const signing = driven.harness.calls.find(
    ({ operation }) => operation === "signer.sign",
  );

  assert.equal(normalized.requestHash, canonical.requestHash);
  assert.equal(driven.harness.snapshotHash, canonical.snapshot.snapshotHash);
  assert.equal(driven.harness.policyHash, canonical.policy.policyHash);
  assert.equal(plan.planHash, canonical.plan.planHash);
  assert.equal(approval.params.binding.bindingHash, canonical.binding.bindingHash);
  assert.equal(signing.params.task.digest, CANONICAL_SIGHASH);
  assert.deepEqual(finalized, canonical.bundle);
  assert.equal(hashCanonical(finalized), hashCanonical(canonical.bundle));
  assert.equal(finalized.transactions[0].txid, CANONICAL_TXID);
  assert.deepEqual(
    driven.result.completion.response.result.transactions.map(
      ({ txid, status }) => ({ txid, status }),
    ),
    [{ txid: CANONICAL_TXID, status: "submitted" }],
  );
});

test("public Host accepts varied legal transfer parameters, including testnet", async () => {
  const testnetChainId = "tbc:testnet";
  const cases = [
    {
      name: "multi-input",
      fixture: makeRustTransferFixture({
        amount: 2_100n,
        utxoAmounts: [900n, 1_400n, 800n],
      }),
    },
      {
        name: "no-change",
        fixture: makeRustTransferFixture({
          amount: 1_000n,
          utxoAmounts: [1_080n],
        }),
      },
      {
        name: "exact-change-output",
        fixture: makeRustTransferFixture({
          amount: 1_337n,
          utxoAmounts: [2_417n],
          fee: 80n,
        }),
      },
      {
        name: "custom-policy",
        fixture: makeRustTransferFixture({
          amount: 4_321n,
          utxoAmounts: [2_000n, 3_000n],
          fee: 120n,
          maxFee: 120n,
          minConfirmations: 7,
          confirmations: 9,
        }),
      },
      {
        name: "testnet",
        fixture: makeRustTransferFixture({
          chainId: testnetChainId,
          amount: 1_111n,
          utxoAmounts: [2_000n],
        }),
      },
  ];
  const alternate = makeRustTransferFixture({
      amount: 2_222n,
      utxoAmounts: [3_000n],
      to: ALTERNATE_RECIPIENT_ADDRESS,
    });
  cases.push({ name: "alternate-recipient", fixture: alternate });

    const seen = new Set();
    for (const item of cases) {
      const driven = await driveTransfer({
        fixture: item.fixture,
        store: createMemoryTwsHostStore(),
        ownerId: `real-${item.name}`,
      });
      const bundle = driven.result.completion.response.result;
      assert.equal(bundle.chainId, item.fixture.request.chainId, item.name);
      assert.equal(bundle.from, item.fixture.request.from, item.name);
      assert.equal(bundle.requestHash, item.fixture.requestHash, item.name);
      assert.ok(bundle.transactions.length >= 1, item.name);
      bundle.transactions.forEach(({ txid }) => {
        assert.match(txid, /^[0-9a-f]{64}$/, item.name);
        seen.add(txid);
      });
    }
    assert.equal(seen.size, cases.length);
    assert.notEqual(
      cases.at(-1).fixture.request.intent.to,
      integration.canonicalTransfer.request.intent.to,
    );
});

function crashStore(base, operation, window) {
  let crashed = false;
  if (window === "after-effect-before-response") {
    return Object.freeze({
      ...base,
      completeCall: async (input) => {
        if (!crashed && input.call.operation === operation) {
          crashed = true;
          throw new Error("simulated crash after real Port effect");
        }
        return base.completeCall(input);
      },
    });
  }
  return Object.freeze({
    ...base,
    commitTransition: async (input) => {
      const operationId = input.transition.checkpoint.payload.operationId;
      const previous = await base.readOperation(operationId);
      const call = previous?.transition.kind === "waiting"
        ? previous.transition.calls[0]
        : undefined;
      const journal = call === undefined ? null : await base.readCall(call.callId);
      if (
        !crashed &&
        call?.operation === operation &&
        journal?.status === "completed"
      ) {
        crashed = true;
        throw new Error("simulated crash after real Port response persistence");
      }
      return base.commitTransition(input);
    },
  });
}

let databaseOrdinal = 0;
for (const adapter of [
  {
    name: "Memory",
    create: () => {
      const store = createMemoryTwsHostStore();
      return { first: store, reopen: () => store };
    },
  },
  {
    name: "IndexedDB",
    create: () => {
      databaseOrdinal += 1;
      const databaseName = `real-transfer-crash-${String(databaseOrdinal)}`;
      return {
        first: createIndexedDbTwsHostStore({ factory: indexedDB, databaseName }),
        reopen: () => createIndexedDbTwsHostStore({ factory: indexedDB, databaseName }),
      };
    },
  },
]) {
  for (const crash of [
    ["signer.sign", "after-effect-before-response", 2],
    ["broadcast.submit", "after-response-before-resume", 1],
  ]) {
    const [operation, window, expectedAttempts] = crash;
    test(`${adapter.name} recovers a real ${operation} ${window} crash`, async () => {
      const canonical = integration.canonicalTransfer;
      const trace = [];
      const captures = [];
      const authority = authorityFor(canonical);
      const harness = createTbcHostPorts({
        fixture: canonical,
        authority,
        trace,
        approvalId: canonical.approval.approvalId,
      });
      const stores = adapter.create();
      const first = createTwsHost({
        core: createTwsCore({ transactionEngine: tracedEngine(trace, captures) }),
        store: crashStore(stores.first, operation, window),
        authority: harness.authority,
        ports: harness.ports,
        ownerId: `${adapter.name}-${operation}-first`,
        ...TEST_LEASE_SCHEDULER,
      });
      const interrupted = await first.startOperation({
        version: "1.0",
        release: TWS_RELEASE,
        request: {
          jsonrpc: "2.0",
          id: `${adapter.name}-${operation}`,
          method: "tbc_sendTransaction",
          params: canonical.request,
        },
      });
      assert.equal(interrupted.status, "failed");

      const recovered = createTwsHost({
        core: createTwsCore({ transactionEngine: tracedEngine(trace, captures) }),
        store: stores.reopen(),
        authority: harness.authority,
        ports: harness.ports,
        ownerId: `${adapter.name}-${operation}-recovered`,
        ...TEST_LEASE_SCHEDULER,
      });
      const completed = await recovered.resumeOperation({
        operationId: interrupted.operationId,
      });
      assert.equal(completed.status, "complete");
      assert.deepEqual(
        completed.completion.response.result.transactions.map(
          ({ txid, status }) => ({ txid, status }),
        ),
        [{ txid: CANONICAL_TXID, status: "submitted" }],
      );
      assert.equal(harness.effects(operation), 1);
      assert.equal(harness.attempts(operation), expectedAttempts);
    });
  }
}
