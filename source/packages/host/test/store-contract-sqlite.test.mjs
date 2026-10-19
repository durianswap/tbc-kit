import { defineTwsHostStoreContract } from "./store-contract.mjs";
import { createSqliteTestStore } from "./fixtures/sqlite-node-driver.mjs";

defineTwsHostStoreContract({
  name: "SqliteTwsHostStore",
  createStore: ({ now }) => createSqliteTestStore({ now }).store,
});
