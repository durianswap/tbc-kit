import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createDefaultTbcBroadcast,
  createDefaultTbcTestnetBroadcast,
  createPoolTransactionInspector,
  createTbcNetworkContext,
} from "../dist/esm/wallet.js";
import { TestnetNodeError } from "../dist/esm/api.js";
import {
  createTbcKitSqliteBroadcastJournal,
} from "../dist/esm/sqlite.js";

const CHAIN_ID = "tbc:testnet";
const RAW_TRANSACTION = [
  "0a000000",
  "01",
  "00".repeat(32),
  "00000000",
  "00",
  "ffffffff",
  "01",
  "8813000000000000",
  "01",
  "51",
  "00000000",
].join("");
const TXID = createPoolTransactionInspector()(RAW_TRANSACTION).txid;
const RAW_TRANSACTION_TWO = RAW_TRANSACTION.replace("8813000000000000", "8913000000000000");
const TXID_TWO = createPoolTransactionInspector()(RAW_TRANSACTION_TWO).txid;

function openDriver(databaseName = ":memory:") {
  const database = new DatabaseSync(databaseName);
  database.exec("PRAGMA foreign_keys = ON");
  let tail = Promise.resolve();
  const driver = {
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
  };
  return { database, driver };
}

function submitParams(idempotencyKey = "default-broadcast-1") {
  return {
    version: "1.0",
    chainId: CHAIN_ID,
    idempotencyKey,
    transaction: {
      id: "transaction-1",
      role: "primary",
      dependsOn: [],
      rawTransaction: RAW_TRANSACTION,
      txid: TXID,
    },
  };
}

function call(operation, params, callId = `${operation}-call`) {
  return Object.freeze({
    version: "1.0",
    callId,
    operation,
    params: Object.freeze(params),
    execution: Object.freeze({ type: "durable" }),
  });
}

function client(overrides = {}) {
  return {
    async preflightBroadcast() {},
    async broadcast() { return { txid: TXID }; },
    async broadcastBatch() { return [{ txid: TXID, status: "accepted" }]; },
    async getTransactionStatus(txid) {
      return { txid, status: "unknown" };
    },
    ...overrides,
  };
}

function batchParams(idempotencyKey = "default-batch-1") {
  return {
    version: "1.0",
    chainId: CHAIN_ID,
    idempotencyKey,
    transactions: [
      {
        id: "parent",
        role: "prerequisite",
        dependsOn: [],
        rawTransaction: RAW_TRANSACTION,
        txid: TXID,
      },
      {
        id: "child",
        role: "primary",
        dependsOn: ["parent"],
        rawTransaction: RAW_TRANSACTION_TWO,
        txid: TXID_TWO,
      },
    ],
  };
}

test('100 NFT transaction outcomes reconcile read-only; POST batch stays limited to 32', async () => {
  const sqlite = openDriver();
  try {
    const journal = await createTbcKitSqliteBroadcastJournal({ driver: sqlite.driver });
    const observed = [], txids = Array.from({ length: 100 }, (_, i) => (i + 1).toString(16).padStart(64, '0'));
    for (const [i,txid] of txids.entries()) {
      const identity = { idempotencyKey: `nft-reconcile-${i}`, rawHash: txid, txid };
      await journal.beginSubmit(identity); await journal.markUncertain(identity);
    }
    const broadcast = createDefaultTbcTestnetBroadcast({ journal, client: client({
      async getTransactionStatus(txid) { observed.push(txid); return { txid, status: 'mempool', confirmations: '0' }; },
      async broadcast() { throw new Error('Read-only recovery must not submit'); },
      async broadcastBatch() { throw new Error('Over-limit batch must not submit'); },
    }) });
    const params = { version: '1.0', chainId: CHAIN_ID, txids };
    const result = await broadcast.reconcile(params, call('broadcast.reconcile', params));
    assert.equal(result.portError, undefined, JSON.stringify(result));
    assert.equal(result.transactions.length, 100);
    assert.deepEqual(observed, txids);
    assert.equal((await journal.readByTxids(txids)).length, 100);
    const over = { ...params, txids: [...txids, 'ff'.repeat(32)] };
    assert.equal((await broadcast.reconcile(over, call('broadcast.reconcile', over))).portError.name, 'INVALID_INPUT');
    assert.equal(observed.length, 100);
    const submit = { ...batchParams(), transactions: Array.from({ length: 33 }, (_, i) => ({
      ...batchParams().transactions[0], id: `mint-${i}`, txid: txids[i],
    })) };
    assert.equal((await broadcast.submitBatch(submit, call('broadcast.submitBatch', submit))).portError.name, 'INVALID_INPUT');
  } finally { await sqlite.driver.close(); }
});

test("Kit batch broadcast performs one ordered POST and replays without resending", async () => {
  const sqlite = openDriver();
  const journal = await createTbcKitSqliteBroadcastJournal({ driver: sqlite.driver });
  let posts = 0;
  const broadcast = createDefaultTbcTestnetBroadcast({
    journal,
    client: client({
      async broadcastBatch(raws) {
        posts += 1;
        assert.deepEqual(raws, [RAW_TRANSACTION, RAW_TRANSACTION_TWO]);
        return [
          { txid: TXID, status: "accepted" },
          { txid: TXID_TWO, status: "accepted" },
        ];
      },
    }),
  });
  const params = batchParams();
  const hostCall = call("broadcast.submitBatch", params);
  const expected = {
    transactions: [
      { txid: TXID, status: "accepted" },
      { txid: TXID_TWO, status: "accepted" },
    ],
  };
  assert.deepEqual(await broadcast.submitBatch(params, hostCall), expected);
  assert.deepEqual(await broadcast.submitBatch(params, hostCall), expected);
  assert.equal(posts, 1);
  assert.equal((await journal.read(`${params.idempotencyKey}:0`)).state, "completed");
  assert.equal((await journal.read(`${params.idempotencyKey}:1`)).state, "completed");
  await sqlite.driver.close();
});

for (const recreated of [false, true]) {
  test(`concurrent Kit batches claim one durable POST boundary (recreated=${recreated})`, async () => {
    const sqlite = openDriver();
    const journal = await createTbcKitSqliteBroadcastJournal({ driver: sqlite.driver });
    let release;
    let ready;
    const gate = new Promise((resolve) => { release = resolve; });
    const entered = new Promise((resolve) => { ready = resolve; });
    let preflights = 0;
    let posts = 0;
    const sharedClient = client({
      async preflightBroadcast() {
        preflights += 1;
        if (preflights === 4) ready();
        await gate;
      },
      async broadcastBatch() {
        posts += 1;
        return [
          { txid: TXID, status: "accepted" },
          { txid: TXID_TWO, status: "accepted" },
        ];
      },
    });
    const open = () => createDefaultTbcTestnetBroadcast({ journal, client: sharedClient });
    const firstRuntime = open();
    const secondRuntime = recreated ? open() : firstRuntime;
    const params = batchParams(`concurrent-batch-${recreated}`);
    const hostCall = call("broadcast.submitBatch", params, "concurrent-batch-call");
    const first = firstRuntime.submitBatch(params, hostCall);
    const second = secondRuntime.submitBatch(params, hostCall);
    await entered;
    release();
    const results = await Promise.all([first, second]);
    assert.equal(preflights, 4);
    assert.equal(posts, 1);
    assert.equal(
      results.filter(({ transactions }) => transactions.every(({ status }) => status === "accepted")).length,
      1,
    );
    assert.equal(
      results.filter(({ transactions }) => transactions.every(({ status }) => status === "unknown")).length,
      1,
    );
    await sqlite.driver.close();
  });
}

test("batch journal claims are all-or-none for partial and overlapping identities", async () => {
  const sqlite = openDriver();
  const journal = await createTbcKitSqliteBroadcastJournal({ driver: sqlite.driver });
  const identity = (idempotencyKey, byte) => Object.freeze({
    idempotencyKey,
    rawHash: byte.repeat(64),
    txid: (byte === "f" ? "0" : String(Number.parseInt(byte, 16) + 1)).repeat(64),
    submitContextHash: "a".repeat(64),
  });
  const existing = identity("batch-existing", "1");
  const missing = identity("batch-missing", "3");
  await journal.beginSubmit(existing);
  const partial = await journal.beginSubmitBatch([existing, missing]);
  assert.equal(partial.created, false);
  assert.equal(partial.records[0]?.idempotencyKey, existing.idempotencyKey);
  assert.equal(partial.records[1], null);
  assert.equal(await journal.read(missing.idempotencyKey), null);

  const independent = identity("batch-independent", "5");
  const overlap = Object.freeze({ ...existing, idempotencyKey: "batch-overlap" });
  await assert.rejects(
    journal.beginSubmitBatch([independent, overlap]),
    /Broadcast transaction identity already journaled/u,
  );
  assert.equal(await journal.read(independent.idempotencyKey), null);
  assert.equal(await journal.read(overlap.idempotencyKey), null);
  await sqlite.driver.close();
});

test("Kit batch broadcast stops dependent success claims after a rejected prerequisite", async () => {
  const sqlite = openDriver();
  const journal = await createTbcKitSqliteBroadcastJournal({ driver: sqlite.driver });
  const broadcast = createDefaultTbcTestnetBroadcast({
    journal,
    client: client({
      async broadcastBatch() {
        return [
          { txid: TXID, status: "rejected", reason: "controlled rejection" },
          { txid: TXID_TWO, status: "accepted" },
        ];
      },
    }),
  });
  const params = batchParams("dependency-stop");
  assert.deepEqual(
    await broadcast.submitBatch(params, call("broadcast.submitBatch", params)),
    {
      transactions: [
        { txid: TXID, status: "rejected", reason: "controlled rejection" },
        { txid: TXID_TWO, status: "unknown", reason: "A prerequisite transaction was not accepted" },
      ],
    },
  );
  assert.equal((await journal.read(`${params.idempotencyKey}:0`)).state, "completed");
  assert.equal((await journal.read(`${params.idempotencyKey}:1`)).state, "uncertain");
  await sqlite.driver.close();
});

test("Kit batch broadcast retains ambiguous outcomes and never blindly resends", async () => {
  const sqlite = openDriver();
  const journal = await createTbcKitSqliteBroadcastJournal({ driver: sqlite.driver });
  let posts = 0;
  const broadcast = createDefaultTbcTestnetBroadcast({
    journal,
    client: client({
      async broadcastBatch() {
        posts += 1;
        throw new Error("controlled response loss");
      },
    }),
  });
  const params = batchParams("ambiguous-batch");
  const hostCall = call("broadcast.submitBatch", params);
  const first = await broadcast.submitBatch(params, hostCall);
  const replay = await broadcast.submitBatch(params, hostCall);
  assert.equal(posts, 1);
  assert.deepEqual(first.transactions.map(({ status }) => status), ["unknown", "unknown"]);
  assert.deepEqual(replay.transactions.map(({ status }) => status), ["unknown", "unknown"]);
  assert.equal((await journal.read(`${params.idempotencyKey}:0`)).state, "uncertain");
  assert.equal((await journal.read(`${params.idempotencyKey}:1`)).state, "uncertain");
  await sqlite.driver.close();
});

test("Kit default broadcast persists accepted identity and replays without a second POST", async () => {
  const sqlite = openDriver();
  const journal = await createTbcKitSqliteBroadcastJournal({
    driver: sqlite.driver,
    now: () => Date.parse("2026-09-18T00:00:00Z"),
  });
  let posts = 0;
  const broadcast = createDefaultTbcTestnetBroadcast({
    journal,
    client: client({
      async broadcast() {
        posts += 1;
        return { txid: TXID };
      },
    }),
  });
  const params = submitParams();
  const hostCall = call("broadcast.submit", params);
  assert.deepEqual(await broadcast.submit(params, hostCall), {
    txid: TXID,
    status: "accepted",
  });
  assert.deepEqual(await broadcast.submit(params, hostCall), {
    txid: TXID,
    status: "accepted",
  });
  assert.equal(posts, 1);
  assert.equal((await journal.read(params.idempotencyKey)).state, "completed");
  await sqlite.driver.close();
});

test("Kit default broadcast reopens an ambiguous POST and only reconciles", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tbc-kit-default-broadcast-"));
  const databaseName = join(directory, "broadcast.sqlite");
  t.after(() => rm(directory, { recursive: true, force: true }));
  let sqlite = openDriver(databaseName);
  let journal = await createTbcKitSqliteBroadcastJournal({ driver: sqlite.driver });
  const counts = { posts: 0, status: 0 };
  let broadcast = createDefaultTbcTestnetBroadcast({
    journal,
    client: client({
      async broadcast() {
        counts.posts += 1;
        throw new Error("controlled response loss");
      },
      async getTransactionStatus(txid) {
        counts.status += 1;
        return { txid, status: "mempool", confirmations: "0" };
      },
    }),
  });
  const params = submitParams();
  const hostCall = call("broadcast.submit", params);
  assert.deepEqual(await broadcast.submit(params, hostCall), {
    portError: {
      name: "UNAVAILABLE",
      retryable: true,
      message: "TBC Testnet submission outcome is unknown",
    },
  });
  await sqlite.driver.close();
  sqlite = openDriver(databaseName);
  journal = await createTbcKitSqliteBroadcastJournal({ driver: sqlite.driver });
  broadcast = createDefaultTbcTestnetBroadcast({
    journal,
    client: client({
      async broadcast() {
        counts.posts += 1;
        throw new Error("a recovered uncertain identity must not POST");
      },
      async getTransactionStatus(txid) {
        counts.status += 1;
        return { txid, status: "mempool", confirmations: "0" };
      },
    }),
  });
  assert.deepEqual(await broadcast.submit(params, hostCall), {
    portError: {
      name: "UNAVAILABLE",
      retryable: true,
      message: "TBC Testnet submission outcome is unknown",
    },
  });
  assert.equal(counts.posts, 1);
  const reconcileParams = { version: "1.0", chainId: CHAIN_ID, txids: [TXID] };
  assert.deepEqual(
    await broadcast.reconcile(
      reconcileParams,
      call("broadcast.reconcile", reconcileParams),
    ),
    { transactions: [{ txid: TXID, status: "mempool", confirmations: "0" }] },
  );
  assert.deepEqual(counts, { posts: 1, status: 1 });
  assert.equal((await journal.read(params.idempotencyKey)).state, "completed");
  await sqlite.driver.close();
});

test("Kit records a local preflight rejection as not-submitted and permits a fresh identity", async () => {
  const sqlite = openDriver();
  const journal = await createTbcKitSqliteBroadcastJournal({ driver: sqlite.driver });
  let preflights = 0;
  let posts = 0;
  const broadcast = createDefaultTbcTestnetBroadcast({
    journal,
    client: client({
      async preflightBroadcast() {
        preflights += 1;
        if (preflights === 1) {
          throw new TestnetNodeError("INVALID_INPUT", "controlled local preflight rejection");
        }
      },
      async broadcast() {
        posts += 1;
        return { txid: TXID };
      },
    }),
  });
  const first = submitParams("preflight-rejected");
  assert.equal(
    (await broadcast.submit(first, call("broadcast.submit", first))).portError.name,
    "INVALID_INPUT",
  );
  assert.equal((await journal.read(first.idempotencyKey)).state, "not-submitted");
  assert.equal(posts, 0);
  const second = submitParams("fresh-after-preflight");
  assert.equal((await broadcast.submit(second, call("broadcast.submit", second))).status, "accepted");
  assert.deepEqual({ preflights, posts }, { preflights: 2, posts: 1 });
  await sqlite.driver.close();
});

test("startup recovery audits prepared intent and queries only uncertain identity", async () => {
  const sqlite = openDriver();
  const journal = await createTbcKitSqliteBroadcastJournal({ driver: sqlite.driver });
  let statusReads = 0;
  const broadcast = createDefaultTbcTestnetBroadcast({
    journal,
    client: client({
      async getTransactionStatus(txid) {
        statusReads += 1;
        return { txid, status: "unknown" };
      },
    }),
  });
  const identity = Object.freeze({
    idempotencyKey: "crash-before-post",
    rawHash: "11".repeat(32),
    txid: "22".repeat(32),
    submitContextHash: "33".repeat(32),
  });
  const first = await journal.beginSubmit(identity);
  const second = await journal.beginSubmit(identity);
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.deepEqual(await broadcast.listRecovery(), [first.record]);
  assert.equal((await broadcast.recover([identity.txid])).portError.name, "CONFLICT");
  assert.equal(statusReads, 0, "prepared means the POST boundary was not entered");
  await journal.markUncertain(identity);
  assert.deepEqual(await broadcast.recover([identity.txid]), {
    transactions: [{ txid: identity.txid, status: "unknown" }],
  });
  assert.equal(statusReads, 1);
  assert.equal((await journal.read(identity.idempotencyKey)).state, "uncertain");
  await sqlite.driver.close();
});

test("startup recovery is isolated by the wallet-owned account scope", async () => {
  const sqlite = openDriver();
  const journal = await createTbcKitSqliteBroadcastJournal({ driver: sqlite.driver });
  const accountA = "aa".repeat(32);
  const accountB = "bb".repeat(32);
  const identities = [accountB, accountA].map((accountScopeHash, index) => Object.freeze({
    idempotencyKey: `account-scope-${index}`,
    rawHash: `${index + 1}`.repeat(64),
    txid: `${index + 3}`.repeat(64),
    submitContextHash: `${index + 5}`.repeat(64),
    accountScopeHash,
  }));
  for (const identity of identities) {
    await journal.beginSubmit(identity);
    await journal.markUncertain(identity);
  }
  let statusReads = 0;
  const broadcast = createDefaultTbcTestnetBroadcast({
    journal,
    accountScopeHash: async () => accountA,
    client: client({
      async getTransactionStatus(txid) {
        statusReads += 1;
        return { txid, status: "unknown" };
      },
    }),
  });
  assert.deepEqual((await broadcast.listRecovery(1)).map(({ txid }) => txid), [identities[1].txid]);
  assert.equal((await broadcast.recover([identities[0].txid])).portError.name, "CONFLICT");
  assert.equal(statusReads, 0);
  assert.equal((await broadcast.recover([identities[1].txid])).transactions[0].status, "unknown");
  assert.equal(statusReads, 1);
  await sqlite.driver.close();
});

test("Kit can consume the existing Mobile v1 broadcast tables without copying history", async () => {
  const sqlite = openDriver();
  const journal = await createTbcKitSqliteBroadcastJournal({
    driver: sqlite.driver,
    schema: "legacy-tws-mobile-v1",
  });
  const broadcast = createDefaultTbcTestnetBroadcast({ journal, client: client() });
  const params = submitParams("legacy-table-request");
  assert.equal((await broadcast.submit(params, call("broadcast.submit", params))).status, "accepted");
  const tables = sqlite.database.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'tws_mobile_broadcast_%' ORDER BY name",
  ).all().map(({ name }) => name);
  assert.deepEqual(tables, [
    "tws_mobile_broadcast_aborts",
    "tws_mobile_broadcast_intents",
    "tws_mobile_broadcast_results",
  ]);
  const reopened = await createTbcKitSqliteBroadcastJournal({
    driver: sqlite.driver,
    schema: "legacy-tws-mobile-v1",
  });
  assert.deepEqual(await reopened.read(params.idempotencyKey), await journal.read(params.idempotencyKey));
  await sqlite.driver.close();
});

test("unified Mainnet and Testnet broadcasts reject a shared journal and isolate identical keys", async () => {
  const mainnetSqlite = openDriver();
  const testnetSqlite = openDriver();
  const journal = await createTbcKitSqliteBroadcastJournal({ driver: mainnetSqlite.driver });
  const counts = { mainnet: 0, testnet: 0 };
  const mainnetContext = createTbcNetworkContext({ network: "mainnet" });
  const testnetContext = createTbcNetworkContext({ network: "testnet" });
  const mainnet = createDefaultTbcBroadcast({
    network: mainnetContext,
    journal,
    client: client({
      async broadcast() {
        counts.mainnet += 1;
        return { txid: TXID };
      },
    }),
  });
  assert.throws(() => createDefaultTbcBroadcast({
    network: testnetContext,
    journal,
    client: client(),
  }), /cannot be shared across TBC network sources/);
  const testnetJournal = await createTbcKitSqliteBroadcastJournal({ driver: testnetSqlite.driver });
  const testnet = createDefaultTbcBroadcast({
    network: testnetContext,
    journal: testnetJournal,
    client: client({
      async broadcast() {
        counts.testnet += 1;
        return { txid: TXID };
      },
    }),
  });
  const common = submitParams("same-wallet-action");
  const mainnetParams = { ...common, chainId: mainnetContext.chainId };
  const testnetParams = { ...common, chainId: testnetContext.chainId };
  assert.equal(
    (await mainnet.submit(mainnetParams, call("broadcast.submit", mainnetParams))).status,
    "accepted",
  );
  assert.deepEqual(
    await testnet.submit(testnetParams, call("broadcast.submit", testnetParams)),
    { txid: TXID, status: "accepted" },
  );
  assert.deepEqual(counts, { mainnet: 1, testnet: 1 });
  assert.equal(
    (await mainnet.submit(testnetParams, call("broadcast.submit", testnetParams))).portError.name,
    "UNAUTHORIZED",
  );
  await mainnetSqlite.driver.close();
  await testnetSqlite.driver.close();
});
