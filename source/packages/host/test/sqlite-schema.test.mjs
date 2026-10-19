import assert from "node:assert/strict";
import test from "node:test";

import * as sqlite from "../dist/esm/sqlite.js";

function createRecordingDriver() {
  const transactions = [];
  return {
    transactions,
    driver: {
      dialect: "sqlite",
      async transaction(work) {
        const statements = [];
        transactions.push(statements);
        return work({
          async run(sql, bindings = {}) {
            statements.push({ kind: "run", sql, bindings });
            return { changes: 1 };
          },
          async get(sql, bindings = {}) {
            statements.push({ kind: "get", sql, bindings });
            return null;
          },
          async all(sql, bindings = {}) {
            statements.push({ kind: "all", sql, bindings });
            return [];
          },
        });
      },
    },
  };
}

test("SQLite initializes the exact version-one schema atomically", async () => {
  const recording = createRecordingDriver();
  const store = sqlite.createSqliteTwsHostStore({
    driver: recording.driver,
    namespace: "wallet-a",
    now: () => Date.parse("2026-09-02T00:00:00Z"),
  });

  assert.equal(await store.readOperation("missing-operation"), null);
  assert.equal(sqlite.TWS_HOST_SQLITE_SCHEMA_VERSION, 1);
  assert.deepEqual(sqlite.TWS_HOST_SQLITE_TABLES, [
    "tws_host_metadata",
    "tws_host_operations",
    "tws_host_calls",
    "tws_host_session_commits",
    "tws_host_deliveries",
    "tws_host_leases",
  ]);

  const migrationSql = recording.transactions[0]
    .filter(({ kind }) => kind === "run")
    .map(({ sql }) => sql)
    .join("\n");
  for (const table of sqlite.TWS_HOST_SQLITE_TABLES) {
    assert.match(migrationSql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
  assert.match(
    migrationSql,
    /PRIMARY KEY\s*\(namespace, operation_id\)/,
  );
  assert.equal(
    recording.transactions.filter((statements) =>
      statements.some(({ sql }) => sql.includes("CREATE TABLE")),
    ).length,
    1,
  );
});
