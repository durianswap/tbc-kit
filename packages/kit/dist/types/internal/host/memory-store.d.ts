import type { TwsHostStore } from "./store.js";
export interface TwsMemoryHostStoreOptions {
    readonly now?: () => number;
}
export declare function createMemoryTwsHostStore(options?: TwsMemoryHostStoreOptions): TwsHostStore;
//# sourceMappingURL=memory-store.d.ts.map