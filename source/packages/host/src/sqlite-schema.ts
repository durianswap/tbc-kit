import { TwsHostError } from "./errors.js";
import type { TwsSqliteTransaction } from "./sqlite-types.js";

export const TWS_HOST_SQLITE_SCHEMA_VERSION = 1;

export const TWS_HOST_SQLITE_TABLES = Object.freeze([
  "tws_host_metadata",
  "tws_host_operations",
  "tws_host_calls",
  "tws_host_session_commits",
  "tws_host_deliveries",
  "tws_host_leases",
] as const);

const SCHEMA_STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS tws_host_metadata (
    namespace TEXT NOT NULL,
    metadata_key TEXT NOT NULL,
    metadata_value TEXT NOT NULL,
    PRIMARY KEY (namespace, metadata_key)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS tws_host_operations (
    namespace TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    release_fingerprint TEXT NOT NULL,
    terminal INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    canonical_json TEXT NOT NULL,
    PRIMARY KEY (namespace, operation_id)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS tws_host_calls (
    namespace TEXT NOT NULL,
    call_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    canonical_json TEXT NOT NULL,
    PRIMARY KEY (namespace, call_id)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS tws_host_session_commits (
    namespace TEXT NOT NULL,
    commit_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    canonical_json TEXT NOT NULL,
    PRIMARY KEY (namespace, commit_id)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS tws_host_deliveries (
    namespace TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    delivery_id TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    canonical_json TEXT NOT NULL,
    PRIMARY KEY (namespace, operation_id),
    UNIQUE (namespace, delivery_id)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS tws_host_leases (
    namespace TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    fencing_counter TEXT NOT NULL,
    active INTEGER NOT NULL,
    canonical_json TEXT,
    PRIMARY KEY (namespace, operation_id)
  ) STRICT`,
  "CREATE INDEX IF NOT EXISTS tws_host_operations_recovery ON tws_host_operations (namespace, release_fingerprint, terminal, created_at, operation_id)",
  "CREATE INDEX IF NOT EXISTS tws_host_calls_operation ON tws_host_calls (namespace, operation_id)",
] as const);

function schemaCorrupt(): never {
  throw new TwsHostError(
    "HOST_STORE_CORRUPT",
    "The SQLite Host Store schema version is invalid.",
  );
}

export async function initializeSqliteSchema(
  transaction: TwsSqliteTransaction,
  namespace: string,
): Promise<void> {
  for (const statement of SCHEMA_STATEMENTS) {
    await transaction.run(statement);
  }
  const row = await transaction.get(
    "SELECT metadata_value FROM tws_host_metadata WHERE namespace = :namespace AND metadata_key = :metadataKey",
    { namespace, metadataKey: "schema-version" },
  );
  if (row === null) {
    await transaction.run(
      "INSERT INTO tws_host_metadata (namespace, metadata_key, metadata_value) VALUES (:namespace, :metadataKey, :metadataValue)",
      {
        namespace,
        metadataKey: "schema-version",
        metadataValue: String(TWS_HOST_SQLITE_SCHEMA_VERSION),
      },
    );
    return;
  }
  if (row.metadata_value !== String(TWS_HOST_SQLITE_SCHEMA_VERSION)) {
    schemaCorrupt();
  }
}
