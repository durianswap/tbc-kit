import { createSqliteTwsHostStore } from "@tbc-wallet/host/sqlite";

const nonTransactionalDriver = {
  dialect: "sqlite" as const,
  async run(_sql: string): Promise<void> {},
};

createSqliteTwsHostStore({
  // @ts-expect-error SQLite drivers must expose the transactional callback boundary.
  driver: nonTransactionalDriver,
  namespace: "wallet-a",
});
