import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  TBC_KIT_HOST_RELEASE_FINGERPRINT,
  createTbcKitHostEvidenceReader,
  createTbcKitMemoryHostStore,
  createTbcKitPostSignerRecoveryReader,
  createTbcKitSqliteHostStore,
} from "../dist/esm/sqlite.js";
import { createTbcWallet } from "../dist/esm/wallet.js";

const CHAIN_ID = "tbc:testnet";
const ADDRESS = "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH";
const ACCOUNT_ID = `${CHAIN_ID}:${ADDRESS}`;
const PROFILE = "kit-sqlite-recovery";
const NAMESPACE = "kit-candidate-sqlite-recovery";

function openDriver(databaseName, options = {}) {
  const database = new DatabaseSync(databaseName);
  database.exec("PRAGMA foreign_keys = ON");
  let failAfterCallCommit = options.failAfterCallCommit === true;
  let tail = Promise.resolve();
  const driver = {
    dialect: "sqlite",
    transaction(work) {
      const result = tail.then(async () => {
        let wroteCall = false;
        const transaction = {
          async run(sql, bindings = {}) {
            const result = database.prepare(sql).run(bindings);
            if (/\b(?:INSERT|UPDATE)\b[\s\S]*\btws_host_calls\b/iu.test(sql)) wroteCall = true;
            return { changes: Number(result.changes) };
          },
          async get(sql, bindings = {}) {
            return database.prepare(sql).get(bindings) ?? null;
          },
          async all(sql, bindings = {}) {
            return database.prepare(sql).all(bindings);
          },
        };
        database.exec("BEGIN IMMEDIATE");
        let value;
        try {
          value = await work(transaction);
          database.exec("COMMIT");
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
        if (failAfterCallCommit && wroteCall) {
          failAfterCallCommit = false;
          throw new Error("controlled process loss after durable waiting-call commit");
        }
        return value;
      });
      tail = result.then(() => undefined, () => undefined);
      return result;
    },
    async close() {
      await tail;
      database.close();
    },
  };
  return { database, driver };
}

function authoritySource() {
  let authority = {
    currentContext: {
      sessionId: "kit-sqlite-session",
      transport: "webview",
      origin: "https://dev.durianswap.org",
      topOrigin: "https://dev.durianswap.org",
      frame: "top",
      navigationId: "kit-sqlite-navigation",
      createdAt: "2026-09-17T00:00:00Z",
    },
    currentSession: {
      version: "1.0",
      scope: { walletProfile: PROFILE, sessionId: "kit-sqlite-session" },
      state: {
        version: "1.0",
        sessionId: "kit-sqlite-session",
        revision: "0",
        connected: true,
        activeChainId: CHAIN_ID,
        activeAccountIds: [ACCOUNT_ID],
      },
    },
  };
  return {
    async read() { return structuredClone(authority); },
    async compareAndSwapSession(input) {
      assert.deepEqual(input.expected, authority);
      authority = {
        currentContext: structuredClone(input.expected.currentContext),
        currentSession: {
          version: "1.0",
          scope: structuredClone(input.mutation.payload.scope),
          state: structuredClone(input.mutation.payload.target),
        },
      };
      return {
        acknowledgment: {
          version: "1.0",
          commitId: input.commitId,
          status: "committed",
          revision: input.mutation.payload.target.revision,
        },
        authority: structuredClone(authority),
      };
    },
  };
}

function createRuntime(hostStore, authority, effects, clock) {
  const forbidden = async () => {
    effects.transactionPorts += 1;
    throw new Error("unexpected transaction Port");
  };
  return createTbcWallet({
    profile: PROFILE,
    accounts: {
      current: async () => [{
        accountId: ACCOUNT_ID,
        address: ADDRESS,
        chainId: CHAIN_ID,
        publicKey: "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
      }],
    },
    approval: {
      async request(params) {
        effects.approvals += 1;
        return {
          status: "approved",
          approvalId: "kit-sqlite-approval",
          approvalToken: "kit-sqlite-token",
          bindingHash: params.binding.bindingHash,
          approvedAt: "2026-09-17T00:00:10Z",
          expiresAt: params.binding.payload.expiresAt,
        };
      },
    },
    signer: { sign: forbidden },
    storage: {
      hostStore,
      async loadPermissions() {
        effects.permissionLoads += 1;
        return { revision: "0", permissions: [] };
      },
      async commitPermissions(params) {
        effects.permissionCommits += 1;
        return { revisions: params.changes.map((change) => ({ scope: change.scope, revision: "1" })) };
      },
    },
    network: {
      resolveChainData: forbidden,
      resolvePolicy: forbidden,
      broadcastSubmit: forbidden,
      broadcastReconcile: forbidden,
    },
    clock,
    randomBytes: (length) => Uint8Array.from({ length }, (_, index) => index),
  });
}

test("new wallet work never enters or resumes the historical SQLite Host store", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tbc-kit-sqlite-"));
  const databaseName = join(directory, "kit.sqlite");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const authority = authoritySource();
  const effects = { approvals: 0, permissionLoads: 0, permissionCommits: 0, transactionPorts: 0 };

  const sqlite = openDriver(databaseName);
  const hostStore = createTbcKitSqliteHostStore({ driver: sqlite.driver, namespace: NAMESPACE });
  const evidence = createTbcKitHostEvidenceReader(hostStore);
  assert.equal(Object.isFrozen(evidence), true);
  assert.deepEqual(Object.keys(evidence).sort(), ["readCall", "readDelivery", "readOperation"]);
  const runtime = createRuntime(hostStore, authority, effects, () => "2026-09-17T00:00:10Z");
  const sessionStore = createTbcKitMemoryHostStore();
  const session = await runtime.openSession({ authority, execution: { hostStore: sessionStore } });
  await session.provider.request({ method: "tbc_requestAccounts" });
  assert.deepEqual(await session.recoverPending(), []);
  await assert.rejects(
    session.recoverPostSigner("historical-operation"),
    /does not resume Host operations after restart/u,
  );
  assert.equal(sqlite.database.prepare(
    "SELECT COUNT(*) AS count FROM tws_host_operations WHERE namespace = ?",
  ).get(NAMESPACE).count, 0);
  assert.equal(await evidence.readOperation("historical-operation"), null);
  session.close();
  await sqlite.driver.close();
});

test("Kit memory store exposes same-release live evidence without claiming restart recovery", async () => {
  const authority = authoritySource();
  const calls = [];
  const hostStore = createTbcKitMemoryHostStore({
    now: () => Date.parse("2026-09-17T00:00:10Z"),
  });
  const evidence = createTbcKitHostEvidenceReader(hostStore);
  const runtime = createTbcWallet({
    profile: PROFILE,
    accounts: {
      current: async () => [{
        accountId: ACCOUNT_ID,
        address: ADDRESS,
        chainId: CHAIN_ID,
        publicKey: "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
      }],
    },
    approval: {
      async request(params, call) {
        calls.push(call);
        return {
          status: "approved",
          approvalId: "kit-memory-approval",
          approvalToken: "kit-memory-token",
          bindingHash: params.binding.bindingHash,
          approvedAt: "2026-09-17T00:00:10Z",
          expiresAt: params.binding.payload.expiresAt,
        };
      },
    },
    signer: { async sign() { throw new Error("unexpected signer"); } },
    storage: {
      hostStore,
      async loadPermissions() { return { revision: "0", permissions: [] }; },
      async commitPermissions(params) {
        return { revisions: params.changes.map((change) => ({ scope: change.scope, revision: "1" })) };
      },
    },
    network: {
      async resolveChainData() { throw new Error("unexpected chain data"); },
      async resolvePolicy() { throw new Error("unexpected policy"); },
      async broadcastSubmit() { throw new Error("unexpected broadcast"); },
      async broadcastReconcile() { throw new Error("unexpected reconcile"); },
    },
    clock: () => "2026-09-17T00:00:10Z",
    randomBytes: (length) => Uint8Array.from({ length }, (_, index) => index),
  });
  const session = await runtime.openSession({ authority, execution: { hostStore } });
  const delivery = await session.handleRequest({
    id: "kit-memory-request",
    method: "tbc_requestAccounts",
  });
  assert.ok("result" in delivery.response);
  assert.equal(calls.length, 1);
  const call = await evidence.readCall(calls[0].callId);
  assert.equal(call.operation, "approval.request");
  assert.equal(call.status, "completed");
  assert.equal((await evidence.readOperation(call.operationId)).terminal, true);
  assert.equal((await evidence.readDelivery(call.operationId)).operationId, call.operationId);
  session.close();

  const fresh = createTbcKitMemoryHostStore();
  const freshEvidence = createTbcKitHostEvidenceReader(fresh);
  assert.equal(await freshEvidence.readCall(calls[0].callId), null);
  const freshRuntime = createRuntime(
    fresh,
    authority,
    { approvals: 0, permissionLoads: 0, permissionCommits: 0, transactionPorts: 0 },
    () => "2026-09-17T00:00:10Z",
  );
  const freshSession = await freshRuntime.openSession({ authority, execution: { hostStore: fresh } });
  assert.deepEqual(await freshSession.recoverPending(), []);
  freshSession.close();
});

test("session-only pure signing leaves the configured durable SQLite Host untouched", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tbc-kit-session-routing-"));
  const databaseName = join(directory, "kit.sqlite");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sqlite = openDriver(databaseName);
  const durableHostStore = createTbcKitSqliteHostStore({
    driver: sqlite.driver,
    namespace: `${NAMESPACE}-session-routing`,
  });
  const authority = authoritySource();
  const effects = { approvals: 0, permissionLoads: 0, permissionCommits: 0, transactionPorts: 0 };
  const runtime = createRuntime(
    durableHostStore,
    authority,
    effects,
    () => "2026-09-17T00:00:10Z",
  );
  const session = await runtime.openSession({ authority });
  const invalid = await session.handleRequest({
    id: "sqlite-session-signing",
    method: "tbc_signMessage",
    params: {},
  });
  assert.ok("error" in invalid.response);
  const beforeDurableRequest = sqlite.database.prepare(
    "SELECT COUNT(*) AS count FROM tws_host_operations WHERE namespace = ?",
  ).get(`${NAMESPACE}-session-routing`);
  assert.equal(Number(beforeDurableRequest.count), 0);

  await session.handleRequest({
    id: "sqlite-durable-permission",
    method: "tbc_requestAccounts",
  });
  const afterDurableRequest = sqlite.database.prepare(
    "SELECT COUNT(*) AS count FROM tws_host_operations WHERE namespace = ?",
  ).get(`${NAMESPACE}-session-routing`);
  assert.equal(Number(afterDurableRequest.count), 0);
  session.close();
  await sqlite.driver.close();
});
