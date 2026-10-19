import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { build } from "esbuild";

import { createTbcEngine, createWasmTbcEngineBackend } from "../dist/esm/engine.js";
import { createTbcWallet } from "../dist/esm/wallet.js";
import {
  createTbcKitSqliteBroadcastJournal,
  createTbcKitSqliteHostStore,
  createTbcKitMemoryHostStore,
} from "../dist/esm/sqlite.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const helperBuild = await build({
  entryPoints: [resolve(ROOT, "test/controlled-key1-testnet.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  write: false,
});
const helper = await import(
  `data:text/javascript;base64,${Buffer.from(helperBuild.outputFiles[0].contents).toString("base64")}`
);
const { createControlledKey1TestnetFetch } = helper;

const CHAIN_ID = "tbc:testnet";
const ADDRESS = "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH";
const PRIVATE_KEY = "01".padStart(64, "0");
const ACCOUNT = Object.freeze({
  accountId: `${CHAIN_ID}:${ADDRESS}`,
  address: ADDRESS,
  chainId: CHAIN_ID,
  publicKey: Buffer.from(secp256k1.getPublicKey(PRIVATE_KEY, true)).toString("hex"),
});

function openDriver() {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  let tail = Promise.resolve();
  return {
    database,
    driver: {
      dialect: "sqlite",
      transaction(work) {
        const result = tail.then(async () => {
          database.exec("BEGIN IMMEDIATE");
          try {
            const value = await work({
              async run(sql, bindings = {}) {
                const result = database.prepare(sql).run(bindings);
                return { changes: Number(result.changes) };
              },
              async get(sql, bindings = {}) {
                return database.prepare(sql).get(bindings) ?? null;
              },
              async all(sql, bindings = {}) {
                return database.prepare(sql).all(bindings);
              },
            });
            database.exec("COMMIT");
            return value;
          } catch (error) {
            database.exec("ROLLBACK");
            throw error;
          }
        });
        tail = result.then(() => undefined, () => undefined);
        return result;
      },
      async close() {
        await tail;
        database.close();
      },
    },
  };
}

function permission(capability) {
  return {
    id: `default-broadcast-${capability}`,
    parentCapability: capability,
    invoker: "https://default-broadcast.test",
    date: Date.parse("2026-09-18T00:00:00Z"),
    caveats: [
      { type: "restrictChains", value: [CHAIN_ID] },
      { type: "restrictAccounts", value: [ACCOUNT.accountId] },
      { type: "restrictMethods", value: [capability] },
    ],
  };
}

test("a wallet send keeps Host state in-session and persists only submit/reconcile identity", async () => {
  const sqlite = openDriver();
  const hostStore = createTbcKitSqliteHostStore({
    driver: sqlite.driver,
    namespace: "kit-default-broadcast-lifecycle",
  });
  const broadcastJournal = await createTbcKitSqliteBroadcastJournal({ driver: sqlite.driver });
  const baseFetch = createControlledKey1TestnetFetch({ nativeUtxoSatoshis: 5e6 });
  const httpEdges = [];
  let loseFirstPostResponse = true;
  const fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    httpEdges.push(`${method} ${url.pathname}`);
    const response = await baseFetch(input, init);
    if (method === "POST" && url.pathname === "/api/tbc/broadcasttx" && loseFirstPostResponse) {
      loseFirstPostResponse = false;
      throw new Error("controlled response loss after accepted submission");
    }
    return response;
  };
  const engine = createTbcEngine({
    backend: await createWasmTbcEngineBackend(
      await readFile(`${ROOT}/artifacts/wasm/tbc_engine_wasm.wasm`),
    ),
  });
  let approvals = 0;
  let signerCalls = 0;
  const runtime = createTbcWallet({
    accounts: { current: async () => [ACCOUNT] },
    approval: {
      async request(params, call) {
        approvals += 1;
        assert.equal(call.execution.type, "session-only");
        return {
          status: "approved",
          approvalId: "default-broadcast-approval",
          approvalToken: "default-broadcast-token",
          bindingHash: params.binding.bindingHash,
          approvedAt: "2026-09-18T00:00:10Z",
          expiresAt: params.binding.payload.expiresAt,
        };
      },
    },
    signer: {
      async sign(params, call) {
        signerCalls += 1;
        assert.equal(call.execution.type, "session-only");
        return {
          taskId: params.task.taskId,
          signatureEncoding: "compact64",
          signature: secp256k1
            .sign(params.task.digest, PRIVATE_KEY, { prehash: false, lowS: true })
            .toCompactHex(),
        };
      },
    },
    storage: {
      hostStore,
      async loadPermissions() {
        return {
          revision: "0",
          permissions: [permission("tbc_accounts"), permission("tbc_sendTransaction")],
        };
      },
      async commitPermissions(params) {
        return {
          revisions: params.changes.map((change) => ({ scope: change.scope, revision: "1" })),
        };
      },
    },
    network: {
      defaultTestnet: {
        fetch,
        broadcast: { journal: broadcastJournal },
        now: () => Date.parse("2026-09-18T00:00:00Z"),
        snapshotId: async () => "default-broadcast-snapshot",
      },
    },
    engine,
    clock: () => "2026-09-18T00:00:10Z",
    randomBytes: (length) => Uint8Array.from({ length }, (_, index) => index),
  });
  const session = await runtime.openSession({
    origin: "https://default-broadcast.test",
    sessionId: "default-broadcast-session",
    execution: { hostStore: createTbcKitMemoryHostStore() },
  });
  const result = await session.provider.request({
    method: "tbc_sendTransaction",
    params: {
      version: "1.0",
      chainId: CHAIN_ID,
      from: ADDRESS,
      clientRequestId: "default-broadcast-request",
      intent: { type: "tbc.transfer", version: "1.0", to: ADDRESS, amount: "1000" },
      constraints: {
        expiresAt: "2026-09-18T00:02:00Z",
        maxFee: "10000",
        feePreference: "standard",
      },
    },
  });
  assert.equal(approvals, 1);
  assert.ok(signerCalls > 0);
  assert.equal(result.transactions.length, 1);
  assert.equal(result.transactions[0].status, "submitted");
  assert.equal(httpEdges.filter((edge) => edge === "POST /api/tbc/broadcasttx").length, 1);
  assert.equal(httpEdges.filter((edge) => edge.includes("/api/tbc/decode/txid/")).length, 1);
  const records = await broadcastJournal.readByTxids([result.transactions[0].txid]);
  assert.equal(records.length, 1);
  assert.equal(records[0].state, "completed");
  assert.equal(records[0].result.status, "known");
  assert.equal((await session.recoverPending()).length, 0);
  assert.deepEqual(await session.listBroadcastRecovery(), []);
  assert.equal(sqlite.database.prepare(
    "SELECT COUNT(*) AS count FROM tws_host_operations WHERE namespace = ?",
  ).get("kit-default-broadcast-lifecycle").count, 0);
  session.close();
  await sqlite.driver.close();
});
