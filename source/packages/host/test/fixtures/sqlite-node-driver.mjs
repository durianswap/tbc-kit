import { DatabaseSync } from "node:sqlite";
import { createSqliteTwsHostStore } from "../../dist/esm/sqlite.js";

function transactionAdapter(database) {
  return {
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
  };
}

const fileLocks = new Map();

function lockFor(databaseName, serialize) {
  if (!serialize || databaseName === ":memory:") return { tail: Promise.resolve() };
  const existing = fileLocks.get(databaseName);
  if (existing !== undefined) return existing;
  const lock = { tail: Promise.resolve() };
  fileLocks.set(databaseName, lock);
  return lock;
}

export function createNodeSqliteDriver(
  databaseName = ":memory:",
  { serialize = true } = {},
) {
  const database = new DatabaseSync(databaseName);
  database.exec("PRAGMA foreign_keys = ON");
  const lock = lockFor(databaseName, serialize);
  const driver = {
    dialect: "sqlite",
    transaction(work) {
      const result = lock.tail.then(async () => {
        database.exec("BEGIN IMMEDIATE");
        try {
          const value = await work(transactionAdapter(database));
          database.exec("COMMIT");
          return value;
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
      });
      lock.tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
    async close() {
      await lock.tail;
      database.close();
    },
  };
  return { database, driver };
}

let namespaceOrdinal = 0;

export function createSqliteTestStore({
  databaseName = ":memory:",
  namespace,
  now,
} = {}) {
  namespaceOrdinal += 1;
  const sqlite = createNodeSqliteDriver(databaseName);
  const store = createSqliteTwsHostStore({
    driver: sqlite.driver,
    namespace: namespace ?? `contract-${String(namespaceOrdinal)}`,
    ...(now === undefined ? {} : { now }),
  });
  return { ...sqlite, store };
}
