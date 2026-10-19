export { createRequestLedger, type KitRequestCategory, type KitRequestLedger, type KitRequestLedgerEntry, type KitRequestLedgerSnapshot } from "./request-ledger.js";
export {
  createImmutableTransactionCache,
  loadIndependentGroups,
  selectThenLoadAncestry,
  type ImmutableTransactionBytes,
  type ImmutableTransactionCache,
  type SelectedAncestryResult,
} from "./chain-data-tools.js";
export { createLegacyKitFacade } from "./legacy-mapper.js";
export { createOptimizedChainDataResolver } from "./optimized-chain-data.js";

export interface RequestBudgetExpectation {
  readonly maximumByCategory: Readonly<Partial<Record<import("./request-ledger.js").KitRequestCategory, number>>>;
  readonly requireConcurrentGroups?: readonly string[];
}

export function assertRequestBudget(
  snapshot: import("./request-ledger.js").KitRequestLedgerSnapshot,
  expectation: RequestBudgetExpectation,
): void {
  for (const [category, maximum] of Object.entries(expectation.maximumByCategory)) {
    const actual = snapshot.counts[category as import("./request-ledger.js").KitRequestCategory];
    if (maximum !== undefined && actual > maximum) {
      throw new Error(`Request budget exceeded for ${category}: ${actual} > ${maximum}`);
    }
  }
  for (const group of expectation.requireConcurrentGroups ?? []) {
    const entries = snapshot.requests.filter((entry) => entry.concurrencyGroup === group && entry.status !== "deduplicated");
    if (entries.length < 2) throw new Error(`Concurrent request group is missing: ${group}`);
    const latestStart = Math.max(...entries.map((entry) => entry.startedAt));
    const earliestFinish = Math.min(...entries.map((entry) => entry.finishedAt ?? Number.POSITIVE_INFINITY));
    if (latestStart > earliestFinish) throw new Error(`Request group became serial: ${group}`);
  }
}
