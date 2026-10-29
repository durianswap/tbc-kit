import type { TwsSqliteTransaction } from "./sqlite-types.js";
export declare const TWS_HOST_SQLITE_SCHEMA_VERSION = 1;
export declare const TWS_HOST_SQLITE_TABLES: readonly ["tws_host_metadata", "tws_host_operations", "tws_host_calls", "tws_host_session_commits", "tws_host_deliveries", "tws_host_leases"];
export declare function initializeSqliteSchema(transaction: TwsSqliteTransaction, namespace: string): Promise<void>;
//# sourceMappingURL=sqlite-schema.d.ts.map