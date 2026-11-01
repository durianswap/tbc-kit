type Point = Readonly<{
    txid: string;
    vout: number;
}>;
/** A caller-selected zero token output is not permission to replace its input. */
export declare class SelectedZeroBalanceInputError extends Error {
    readonly reason = "SELECTED_ZERO_BALANCE_INPUT";
    constructor();
}
/** Holder selection only, never Pool reserve/state selection. Validate index
 * amounts and duplicates before skipping zero balances; do not download their
 * parents or count them against a spend/confirmation-discovery budget. Exact
 * selections fail explicitly instead of silently dropping a requested input.
 */
export declare function positiveHolderCandidates<T extends Point>(rows: readonly T[], amountOf: (row: T) => unknown, requested?: readonly Point[]): readonly T[];
export {};
