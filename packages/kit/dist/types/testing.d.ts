export { createRequestLedger, type KitRequestCategory, type KitRequestLedger, type KitRequestLedgerEntry, type KitRequestLedgerSnapshot } from "./request-ledger.js";
export { createImmutableTransactionCache, loadIndependentGroups, selectThenLoadAncestry, type ImmutableTransactionBytes, type ImmutableTransactionCache, type SelectedAncestryResult, } from "./chain-data-tools.js";
export { createLegacyKitFacade } from "./legacy-mapper.js";
export { createOptimizedChainDataResolver } from "./optimized-chain-data.js";
export interface RequestBudgetExpectation {
    readonly maximumByCategory: Readonly<Partial<Record<import("./request-ledger.js").KitRequestCategory, number>>>;
    readonly requireConcurrentGroups?: readonly string[];
}
export declare function assertRequestBudget(snapshot: import("./request-ledger.js").KitRequestLedgerSnapshot, expectation: RequestBudgetExpectation): void;
