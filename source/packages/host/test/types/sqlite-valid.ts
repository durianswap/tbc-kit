import type { TwsHostStore } from "@tbc-wallet/host";
import {
  createSqliteTwsHostStore,
  TWS_HOST_SQLITE_MAX_CANONICAL_JSON_BYTES,
  type TwsSqliteBindings,
  type TwsSqliteDriver,
  type TwsSqliteRow,
  type TwsSqliteTransaction,
  type TwsSqliteValue,
} from "@tbc-wallet/host/sqlite";

declare const driver: TwsSqliteDriver;
declare const transaction: TwsSqliteTransaction;
declare const bindings: TwsSqliteBindings;
declare const row: TwsSqliteRow;
declare const value: TwsSqliteValue;

const store = createSqliteTwsHostStore({
  driver,
  namespace: "wallet-a",
  now: () => Date.parse("2026-09-02T00:00:00Z"),
});

store satisfies TwsHostStore;
void transaction;
void bindings;
void row;
void value;
TWS_HOST_SQLITE_MAX_CANONICAL_JSON_BYTES satisfies number;
