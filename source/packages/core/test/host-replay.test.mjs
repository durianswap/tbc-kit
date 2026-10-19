import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as tws from "../dist/esm/index.js";
import {
  TWS_HOST_PORT_NAMES,
  createMemoryTwsHostStore,
  createTwsHost,
} from "@tbc-wallet/host";
import { createTbcTransferEngine } from "./fixtures/tbc-transfer-engine.mjs";
import { TEST_LEASE_SCHEDULER } from "../../host/test/fixtures/lease-scheduler.mjs";

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
const permissions = JSON.parse(
  await readFile(
    new URL("../../../test-vectors/permissions.json", import.meta.url),
    "utf8",
  ),
);
const canonical = integration.canonicalTransfer;
const initialAuthority = Object.freeze({
  currentContext: structuredClone(provider.trustedContexts[0].context),
  currentSession: structuredClone(provider.providerSessions.sessionA),
});

function clone(value) {
  return structuredClone(value);
}

function same(left, right) {
  return tws.canonicalize(left) === tws.canonicalize(right);
}

function permissionFor(capability, chainId = canonical.request.chainId) {
  const base = permissions.result[0];
  const accountId = `${chainId}:${canonical.request.from}`;
  return {
    ...clone(base),
    id: `public-host-${capability.replaceAll("_", "-")}-${chainId.slice(-6)}`,
    parentCapability: capability,
    caveats: base.caveats.map((caveat) => {
      if (caveat.type === "restrictChains") return { ...caveat, value: [chainId] };
      if (caveat.type === "restrictAccounts") return { ...caveat, value: [accountId] };
      if (caveat.type === "restrictMethods") return { ...caveat, value: [capability] };
      return clone(caveat);
    }),
  };
}

function fixturePorts(counts = new Map()) {
  const count = (operation) => counts.set(operation, (counts.get(operation) ?? 0) + 1);
  const invoke = (call) => {
    count(call.operation);
    switch (call.operation) {
      case "clock.now":
        return { now: "2026-08-31T12:00:11Z" };
      case "permissionStore.load":
        return {
          revision: "0",
          permissions: [
            permissionFor("tbc_accounts", call.params.scope.chainId),
            permissionFor("tbc_signTransaction", call.params.scope.chainId),
            permissionFor("tbc_switchChain", call.params.scope.chainId),
          ],
        };
      case "accounts.resolve":
        return clone(integration.portData.accountsResult);
      case "chainData.resolve":
        return clone(canonical.snapshot);
      case "policy.resolve":
        return clone(canonical.policy);
      case "approval.request":
        return {
          status: "approved",
          approvalId: call.params.binding.payload.operationKind === "transaction"
            ? canonical.approval.approvalId
            : "approval-switch-1",
          approvalToken: "approval-token-public-host-1",
          bindingHash: call.params.binding.bindingHash,
          approvedAt: "2026-08-31T12:00:11Z",
          expiresAt: call.params.binding.payload.expiresAt,
        };
      case "signer.sign":
        return clone(canonical.signature);
      case "permissionStore.commit":
        return {
          revisions: call.params.changes.map(({ scope, expectedRevision }) => ({
            scope,
            revision: String(BigInt(expectedRevision) + 1n),
          })),
        };
      case "broadcast.submit":
        return clone(integration.portData.broadcastSubmitResult);
      case "broadcast.reconcile":
        return clone(integration.portData.broadcastReconcileResult);
      case "entropy.randomBytes":
        return { bytes: "AAECAwQFBgcICQoLDA0ODw" };
      default:
        throw new Error(`unexpected public Host Port: ${call.operation}`);
    }
  };
  return Object.freeze({
    accounts: invoke,
    chainData: invoke,
    policy: invoke,
    permissionStore: invoke,
    approval: invoke,
    signer: invoke,
    broadcast: invoke,
    clock: invoke,
    entropy: invoke,
  });
}

function authoritySource() {
  let current = clone(initialAuthority);
  const commits = new Map();
  let effects = 0;
  return {
    source: Object.freeze({
      read: async () => clone(current),
      compareAndSwapSession: async (input) => {
        const existing = commits.get(input.commitId);
        if (existing !== undefined) {
          if (!same(existing.input, input)) throw new Error("commitId collision");
          return clone(existing.result);
        }
        if (!same(input.expected, current)) throw new Error("stale authority");
        effects += 1;
        current = {
          currentContext: clone(input.expected.currentContext),
          currentSession: {
            version: "1.0",
            scope: clone(input.mutation.payload.scope),
            state: clone(input.mutation.payload.target),
          },
        };
        const result = {
          acknowledgment: {
            version: "1.0",
            commitId: input.commitId,
            status: "committed",
            revision: input.mutation.payload.target.revision,
          },
          authority: clone(current),
        };
        commits.set(input.commitId, { input: clone(input), result: clone(result) });
        return result;
      },
    }),
    get current() {
      return clone(current);
    },
    get effects() {
      return effects;
    },
  };
}

function startInput(method = "tbc_signTransaction", params = canonical.request, id = method) {
  return {
    version: "1.0",
    release: tws.TWS_RELEASE,
    request: { jsonrpc: "2.0", id, method, params },
  };
}

function makeHost() {
  const counts = new Map();
  const store = createMemoryTwsHostStore();
  const authority = authoritySource();
  const host = createTwsHost({
    core: tws.createTwsCore({
      transactionEngine: createTbcTransferEngine(integration).engine,
    }),
    ports: fixturePorts(counts),
    store,
    authority: authority.source,
    ownerId: "core-public-host",
    ...TEST_LEASE_SCHEDULER,
  });
  return { host, store, counts, authority };
}

test("Core integration exposes nine required and two optional Host Ports", () => {
  assert.deepEqual(TWS_HOST_PORT_NAMES, [
    "accounts",
    "chainData",
    "policy",
    "permissionStore",
    "approval",
    "signer",
    "crypto",
    "reviewedTransaction",
    "broadcast",
    "clock",
    "entropy",
  ]);
  const base = {
    core: tws.createTwsCore(),
    ports: fixturePorts(),
    store: createMemoryTwsHostStore(),
    authority: authoritySource().source,
    ownerId: "boundary-check",
    ...TEST_LEASE_SCHEDULER,
  };
  assert.doesNotThrow(() => createTwsHost(base));
  for (const extra of ["vaultHandle", "onSign", "execute", "telemetry"]) {
    assert.throws(
      () => createTwsHost({ ...base, ports: { ...base.ports, [extra]: () => undefined } }),
      /nine|port|unknown|capability/i,
      extra,
    );
  }
});

test("public Host completes and exactly replays the canonical real-Core signing path", async () => {
  const { host, store, counts } = makeHost();
  const input = startInput();
  const first = await host.startOperation(input);
  assert.equal(first.status, "complete");
  assert.deepEqual(first.completion.response.result, canonical.bundle);
  assert.deepEqual([...counts.keys()], [
    "clock.now",
    "permissionStore.load",
    "accounts.resolve",
    "chainData.resolve",
    "policy.resolve",
    "approval.request",
    "signer.sign",
  ]);
  const beforeReplay = [...counts.entries()];
  const replay = await host.startOperation(input);
  assert.deepEqual(replay, first);
  assert.deepEqual([...counts.entries()], beforeReplay);
  assert.equal((await store.readDelivery(first.operationId)).status, "delivered");
});

test("public Host persists and acknowledges the real-Core Provider Session CAS once", async () => {
  const targetChain = "tbc:testnet";
  const { host, store, authority } = makeHost();
  const result = await host.startOperation(
    startInput("tbc_switchChain", { chainId: targetChain }, "switch-public-host"),
  );
  assert.equal(result.status, "complete");
  assert.equal(result.completion.response.result, null);
  assert.equal(authority.effects, 1);
  assert.equal(authority.current.currentSession.state.activeChainId, targetChain);
  assert.equal((await store.readDelivery(result.operationId)).status, "delivered");
  assert.deepEqual(await host.resumeOperation({ operationId: result.operationId }), result);
  assert.equal(authority.effects, 1);
});
