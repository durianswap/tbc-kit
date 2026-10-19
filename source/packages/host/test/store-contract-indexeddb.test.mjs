import { indexedDB } from "fake-indexeddb";
import { createIndexedDbTwsHostStore } from "../dist/esm/indexeddb.js";
import { defineTwsHostStoreContract } from "./store-contract.mjs";

let databaseOrdinal = 0;

defineTwsHostStoreContract({
  name: "IndexedDbTwsHostStore",
  createStore: ({ now }) => {
    databaseOrdinal += 1;
    return createIndexedDbTwsHostStore({
      factory: indexedDB,
      databaseName: `tws-host-contract-${String(databaseOrdinal)}`,
      now,
    });
  },
});
