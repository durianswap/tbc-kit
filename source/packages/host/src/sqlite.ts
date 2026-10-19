import { createSqliteStore } from "./sqlite-store.js";
import type { TwsHostStore } from "./store.js";
import type { TwsSqliteHostStoreOptions } from "./sqlite-types.js";

export type {
  TwsSqliteBindings,
  TwsSqliteDriver,
  TwsSqliteHostStore,
  TwsSqliteHostStoreOptions,
  TwsSqliteRow,
  TwsSqliteRunResult,
  TwsSqliteTransaction,
  TwsSqliteValue,
} from "./sqlite-types.js";
export {
  TWS_HOST_SQLITE_SCHEMA_VERSION,
  TWS_HOST_SQLITE_TABLES,
} from "./sqlite-schema.js";
export { TWS_HOST_SQLITE_MAX_CANONICAL_JSON_BYTES } from "./sqlite-codec.js";

export function createSqliteTwsHostStore(
  options: TwsSqliteHostStoreOptions,
): TwsHostStore {
  return createSqliteStore(options);
}
