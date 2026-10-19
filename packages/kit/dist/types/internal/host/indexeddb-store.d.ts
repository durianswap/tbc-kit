import type { TwsHostStore } from "./store.js";
export declare const TWS_HOST_INDEXEDDB_STORES: readonly ["operations", "calls", "sessionCommits", "deliveries", "leases"];
export interface TwsIndexedDbHostStoreOptions {
    readonly factory: IDBFactory;
    readonly databaseName: string;
    readonly now?: () => number;
}
export declare function createIndexedDbTwsHostStore(options: TwsIndexedDbHostStoreOptions): TwsHostStore;
