import type { TbcOfficialApiClient } from "./official-api.js";
import { type ImmutableTransactionCache } from "./chain-data-tools.js";
type Point = Readonly<{
    txid: string;
    vout: number;
}>;
export interface ListTimelockDepositsInput {
    readonly address: string;
    /** Optional exact selection. Missing selections fail, never fall back to all deposits. */
    readonly inputOutpoints?: readonly Point[];
}
export interface TimelockDeposit extends Point {
    readonly amountAtomic: string;
    readonly lockHeight: string;
    /** Height condition only, not a promise of spendability or successful submission. */
    readonly maturity: "locked" | "mature";
    readonly confirmations?: string;
    readonly scriptPubKey: string;
}
export interface TimelockDepositObservation {
    readonly address: string;
    readonly tip: Readonly<{
        height: string;
        hash: string;
    }>;
    readonly selection: "all-indexed" | "selected";
    readonly availability: "indexed-unspent";
    readonly deposits: readonly TimelockDeposit[];
}
export interface TimelockReader {
    readonly listDeposits: (input: ListTimelockDepositsInput) => Promise<TimelockDepositObservation>;
}
export interface CreateTimelockReaderOptions {
    /** Uses this already configured network/source; never switches API domains. */
    readonly api: Pick<TbcOfficialApiClient, "nodeInfo" | "timelockUtxosByAddress" | "rawTransaction">;
    readonly cache?: ImmutableTransactionCache;
    /** Bounds parent reads; a larger account must supply an exact bounded selection. */
    readonly maxDeposits?: number;
}
/** Read-only height-profile deposits. Local parent hash/output/template checks
 * supplement the trusted index; they do not independently prove unspent state.
 * Creation is lazy, and mutable index/tip observations are never retained. */
export declare function createTimelockReader(options: CreateTimelockReaderOptions): TimelockReader;
export {};
//# sourceMappingURL=timelock-query.d.ts.map